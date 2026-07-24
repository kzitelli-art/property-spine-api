"use strict";

// PROPERTY SPINE — Leasing Desk LOADER (the client-aware composition slice).
//
// This is the ONE read that backs GET /operator/leasing/desk. It composes three
// live sources INSIDE a single repeatable-read, read-only snapshot and hands the
// already-interpreted rows to the pure composer (leasing_desk.js). It writes
// nothing and grants no authority — every button's POST enforces its own write
// perimeter downstream.
//
// LOADER BRIEF compliance (see DELIVERY_LEASING_DESK.md):
//   A. read-only route, NO dormantWriteGuard        (enforced at the route)
//   B. property scope from the session               (propertyId arg, never client body)
//   C. ONE snapshot; every helper gets `client`      (this file)
//   D. both suppression identities on both sides     (dealKeysFor + shadow tagging)
//   E. COMMUNICATION_MOVE_CODES verified vs the rail  (the rail's own vocabulary is reused)
//   F. failure → one honest unavailable contract      (thrown up to the route)
//
// The loader depends ONLY on:
//   - application_review.buildReviewList  (extended here to carry next_action)
//   - applicationsService {outstanding, applicationNext}  (the ONE resolver)
//   - the follow-up rail SQL (shared with /operator/leasing/task-queue)
//   - conversionService.assessReopenability(client, ...)   (already client-aware)
//   - staffIdentity.resolveStaffIdentity(client, ...)      (called with CLIENT, not pool)
//   - composeLeasingDesk (pure placement)

const { composeLeasingDesk } = require("./leasing_desk");

// The rail's own next-move label map — kept identical to the live task-queue so
// the desk and the queue never disagree on wording. (Mirror of operator.js.)


// ── APPLICATION ROWS ───────────────────────────────────────────────────────
// buildReviewList returns main_blocker per row, NOT next_action. The composer
// places on next_action.code. So the loader runs the ONE canonical resolver per
// application in-snapshot (the queue-#2 seam), reusing the exact resolver bridge
// application-review detail already uses: { loadGate: outstanding, resolveNext:
// applicationNext }. No second lifecycle authority is created.
async function loadApplicationRows(client, propertyId, deps) {
  const { applicationReview, applicationsService } = deps;
  const list = await applicationReview.buildReviewList(client, propertyId);
  const apps = (list && list.applications) || [];

  // Resolver bridge, identical to operator.js application-review detail.
  const canResolve = !!(applicationsService &&
    typeof applicationsService.applicationNext === "function");

  const rows = [];
  for (const summary of apps) {
    // buildReviewList already loaded scoped facts, but next_action needs the app
    // row + gate + review facts. Re-load the ONE detail through the same review
    // reader so the resolver sees the same current packet/confirmation the detail
    // screen would. This is a per-app read on the SAME client (in-snapshot).
    let next_action = null;
    let unit_label = summary.unit_label || null;
    let applicant_name = summary.applicant_name || null;
    let person_id = null;
    let conversion_id = null;

    if (canResolve && applicationReview.buildReviewDetail) {
      const detail = await applicationReview.buildReviewDetail(
        client, summary.application_id, propertyId,
        { loadGate: applicationsService.outstanding, resolveNext: applicationsService.applicationNext }
      );
      if (detail && !detail.notInScope) {
        next_action = detail.next_action || null;
        const execution = detail.execution_primary_action || null;
        if (next_action && next_action.code === "executed_lease_required" && execution && execution.action) {
          next_action = {
            ...next_action,
            code: execution.action,
            label: execution.label || next_action.label,
            state: execution.action === "term_confirmed"
              ? "complete"
              : execution.action === "review_conflict"
                ? "blocked"
                : "available",
            blocker_code: execution.action === "review_conflict" ? "executed_lease_conflict" : null,
          };
        }
        // ── IDENTITY SHAPE ────────────────────────────────────────────
        // buildReviewDetail returns identity NESTED — applicant.{name,person_id}
        // and unit.{unit_id,unit_label} — not flat. Reading it flat yields
        // undefined silently. applicant_name and unit_label survived only
        // because the summary supplies a fallback; person_id has none, so every
        // application row carried person_id: null and no application name could
        // open the Person Card. The door was right to render plain text — there
        // was no identity to link to.
        //
        // Nested first, flat second: if the detail contract is ever flattened
        // this keeps working instead of silently going null again.
        const applicantDetail = detail.applicant || {};
        const unitDetail = detail.unit || {};
        unit_label = (unitDetail.unit_label != null ? unitDetail.unit_label
          : (detail.unit_label != null ? detail.unit_label : unit_label));
        applicant_name = (applicantDetail.name != null ? applicantDetail.name
          : (detail.applicant_name != null ? detail.applicant_name : applicant_name));
        person_id = (applicantDetail.person_id != null ? applicantDetail.person_id
          : (detail.person_id != null ? detail.person_id : null));
        // conversion_id is NOT part of the review-detail contract today. Left as
        // an honest null rather than guessed at; a row without a conversion is
        // already handled downstream (send_application degrades to Unavailable).
        conversion_id = detail.conversion_id != null ? detail.conversion_id : null;
      }
    }

    rows.push({
      application_id: summary.application_id,
      conversion_id,
      person_id,
      applicant_name,
      person_name: applicant_name,
      unit_label,
      next_action,        // composer omits rows whose next_action is null
      // ownership/due come from the follow-up rail's obligation, not the app row;
      // an application-lifecycle row has no independent due in this slice.
      owner_name: null,
      owner_basis: null,
      due_at: null,
      due_state: null,
      created_at: summary.created_at || null,
    });
  }
  return rows;
}

// ── FOLLOW-UP RAIL ROWS ──────────────────────────────────────────────────────
// The SAME query the live /operator/leasing/task-queue uses, run on `client`.
// Ownership basis resolves through staffIdentity.resolveStaffIdentity(CLIENT, …)
// — NOT pool (the live queue passes pool; in-snapshot we must pass client or the
// basis read escapes the transaction). deal_keys carry BOTH identities so the
// composer can suppress a shadow rung against a conversion-less application.
const FOLLOWUP_SQL = `
  select o.id as obligation_id, lco.conversion_id, c.property_id,
         p.id as person_id, p.name as person_name,
         c.origin_tour_id, lco.rung,
         tu.unit_id, un.unit_number,
         subst.applicant_substatus,
         case when lco.rung = 'leasing_task' then 'sibling' else 'anchor' end as anchor_or_sibling,
         o.status, o.label, o.due_at, o.created_at,
         lco.owner_user_id, ou.name as owner_name,
         lco.next_move_code,
         la.id as application_id,
         case when o.due_at is null then 'none'
              when o.due_at < now() then 'overdue'
              when o.due_at < date_trunc('day', now()) + interval '1 day' then 'today'
              else 'upcoming' end as due_state
    from leasing_conversion_obligations lco
    join obligations o         on o.id = lco.obligation_id
    join leasing_conversions c on c.id = lco.conversion_id
    join persons p             on p.id = c.person_id
    left join users ou         on ou.id = lco.owner_user_id
    left join lateral (
      select t.unit_id from leasing_tours t where t.id = c.origin_tour_id limit 1
    ) tu on true
    left join units un on un.id = tu.unit_id
    left join lateral (
      select la.id from lease_applications la
       where la.conversion_id = lco.conversion_id
       order by la.created_at desc nulls last limit 1
    ) la on true
    left join lateral (
      select case
        when exists (select 1 from lease_applications la where la.conversion_id = lco.conversion_id
                     and la.status in ('approved','lease_ready','tenant_signed','countersigned','active'))
          then 'approved'
        when exists (select 1 from lease_applications la where la.conversion_id = lco.conversion_id
                     and la.status in ('denied','declined','withdrawn'))
          then 'declined'
        when exists (select 1 from lease_applications la where la.conversion_id = lco.conversion_id
                     and la.status = 'submitted')
          then 'submitted'
        when exists (select 1 from application_invitations ai where ai.conversion_id = lco.conversion_id
                     and ai.status in ('manually_sent','provider_dispatched'))
          then 'application_sent'
        else null end as applicant_substatus
    ) subst on true
   where c.property_id = $1 and lco.outcome is null
   order by coalesce(o.due_at,'infinity'::timestamptz), o.created_at, o.id`;

// A conversion obligation is a display-shadow of an application lifecycle row
// when its rung is one of these AND the same deal has an active application row.
// The composer makes the final call; the loader only tags the candidate rungs.
const SHADOW_RUNGS = new Set(["lease_signature_followup", "application_lifecycle_followup"]);

async function loadFollowupRows(client, propertyId, deps) {
  const { staffIdentity } = deps;
  const rows = (await client.query(FOLLOWUP_SQL, [propertyId])).rows;

  // ── CAPABILITY, EVALUATED ONCE PER PAGE ───────────────────────────
  // Ask the SAME evaluator the write route asks, so a Send button that the
  // server would refuse arrives already disabled with its reason instead of
  // being discovered by pressing it. One batched query for the whole board,
  // not one per row — the fetch shape differs from the route's, the decision
  // does not.
  //
  // Fail-soft on purpose: if capability cannot be evaluated the rows are
  // returned WITHOUT a verdict, and the normalizer leaves the action as it
  // was. A capability read that breaks must not blank the desk — an absent
  // verdict is honestly unknown, never a silent denial.
  let capabilityByPerson = null;
  try {
    const capability = require("./capability");
    capabilityByPerson = await capability.evaluateApplicationLinkBirthBatch(client, {
      property_id: propertyId,
      person_ids: rows.map((r) => r.person_id).filter(Boolean),
    });
  } catch (_) { capabilityByPerson = null; }

  // ONE resolver read per DISTINCT owner, on CLIENT (in-snapshot).
  const ownerIds = [...new Set(rows.map((r) => r.owner_user_id).filter(Boolean))];
  const basisByOwner = {};
  for (const uid of ownerIds) {
    try {
      const idn = await staffIdentity.resolveStaffIdentity(client, { user_id: uid, property_id: propertyId });
      basisByOwner[uid] = idn.state === "resolved" ? "eligible_assignment" : "eligibility_lapsed";
    } catch (_) { basisByOwner[uid] = "eligibility_lapsed"; }
  }

  return rows.map((r) => ({
    // The server-authored verdict for the one action this row can offer.
    // null = not evaluated (see fail-soft above), which the normalizer
    // treats as "no opinion", never as a denial.
    send_application_capability: capabilityByPerson
      ? (capabilityByPerson.get(r.person_id ? String(r.person_id) : null) || null)
      : null,
    obligation_id: r.obligation_id,
    conversion_id: r.conversion_id,
    origin_tour_id: r.origin_tour_id || null,
    application_id: r.application_id || null,
    person_id: r.person_id,
    person_name: r.person_name,
    unit_number: r.unit_number || null,
    rung: r.rung,
    label: r.label,
    applicant_substatus: r.applicant_substatus || null,
    owner_name: r.owner_name,
    owner_basis: r.owner_user_id ? basisByOwner[r.owner_user_id] : "unassigned",
    due_at: r.due_at,
    due_state: r.due_state,
    next_move_code: r.next_move_code,
    created_at: r.created_at,
    // D: explicit shadow flag the composer honors (never suppresses on
    // conversion-share alone). Both id keys travel on the row already.
    display_shadow_of_application: SHADOW_RUNGS.has(r.rung),
  }));
}

// ── RECENTLY CLOSED ──────────────────────────────────────────────────────────
// Closed leasing obligations in the window, with reopenability resolved through
// the ALREADY-client-aware assessReopenability(client, …). Read-only.
const CLOSED_SQL = `
  select o.id as obligation_id,
         lco.conversion_id,
         c.property_id,
         p.id as person_id,
         p.name as person_name,
         o.label,
         lco.outcome,
         lco.resolution,
         lco.resolution_basis,
         lco.closed_at,
         ru.name as closed_by_name
    from leasing_conversion_obligations lco
    join obligations o         on o.id = lco.obligation_id
    join leasing_conversions c on c.id = lco.conversion_id
    join persons p             on p.id = c.person_id
    left join users ru         on ru.id = lco.closed_by_user_id
   where c.property_id = $1
     and lco.outcome is not null
     and lco.closed_at is not null
     and lco.closed_at >= now() - ($2 || ' hours')::interval
   order by lco.closed_at desc`;

async function loadRecentlyClosed(client, propertyId, windowHours, deps) {
  const { conversionService } = deps;
  const rows = (await client.query(CLOSED_SQL, [propertyId, String(windowHours)])).rows;
  const out = [];
  for (const r of rows) {
    let reopenable = false;
    let not_reopenable_reason = "UNKNOWN";
    if (conversionService && typeof conversionService.assessReopenability === "function") {
      try {
        const a = await conversionService.assessReopenability(client, { obligation_id: r.obligation_id });
        reopenable = a.reopenable === true;
        not_reopenable_reason = reopenable ? null : (a.reason_code || "UNKNOWN");
      } catch (_) { reopenable = false; not_reopenable_reason = "UNKNOWN"; }
    }
    out.push({
      obligation_id: r.obligation_id,
      conversion_id: r.conversion_id,
      person_id: r.person_id,
      person_name: r.person_name,
      label: r.label,
      resolution: r.resolution,
      resolution_basis: r.resolution_basis,
      closed_at: r.closed_at,
      closed_by_name: r.closed_by_name,
      reopenable,
      not_reopenable_reason,
    });
  }
  return out;
}

// ── THE COMPOSITION ──────────────────────────────────────────────────────────
// deps = { pool, applicationReview, applicationsService, conversionService,
//          staffIdentity }. propertyId is SERVER-DERIVED (route passes
//          req.operator.property_id). windowHours defaults to 72.
async function loadLeasingDesk(deps, propertyId, opts) {
  if (!deps || !deps.pool) throw new Error("leasing desk loader requires a pool.");
  if (!propertyId) throw new Error("leasing desk loader requires a server-derived propertyId.");
  const windowHours = (opts && opts.windowHours) || 72;

  const client = await deps.pool.connect();
  try {
    // C: ONE snapshot. Every read below runs on THIS client. read-only means a
    // mid-read concurrent write cannot tear the desk across sources.
    await client.query("begin transaction isolation level repeatable read read only");

    const applicationRows = await loadApplicationRows(client, propertyId, deps);
    const followupRows = await loadFollowupRows(client, propertyId, deps);
    const recentlyClosedRows = await loadRecentlyClosed(client, propertyId, windowHours, deps);

    await client.query("commit");

    return composeLeasingDesk({
      propertyId,
      applicationRows,
      followupRows,
      recentlyClosedRows,
      recentlyClosedWindowHours: windowHours,
    });
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    throw e; // F: the route turns this into ONE honest unavailable/retry contract.
  } finally {
    client.release();
  }
}

module.exports = {
  loadLeasingDesk,
  // exported for targeted proofs:
  loadApplicationRows,
  loadFollowupRows,
  loadRecentlyClosed,
  FOLLOWUP_SQL,
  CLOSED_SQL,
  SHADOW_RUNGS,
};
