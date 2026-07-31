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
    let unit_id = null;
    let lease_id = null;

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
        // S4 passthroughs of the SAME canonical detail read: the application's
        // governed unit, and the direct leases.application_id lookup (089)
        // Application Review already serves. Null preserved when absent.
        unit_id = (unitDetail.unit_id != null ? unitDetail.unit_id
          : (detail.unit_id != null ? detail.unit_id : null));
        lease_id = detail.lease_id != null ? detail.lease_id : null;
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
      unit_id,
      unit_label,
      lease_id,
      next_action,        // composer omits rows whose next_action is null
      // ownership/due come from the follow-up rail's obligation, not the app row;
      // an application-lifecycle row has no independent due in this slice.
      owner_user_id: null,
      owner_name: null,
      owner_basis: null,
      due_at: null,
      due_state: null,
      created_at: summary.created_at || null,
      // S5: the review list's own facts travel with the row so Application
      // Records can mirror Applications Review without a second read.
      status: summary.status || null,
      completeness: summary.completeness || null,
      missing_count: summary.missing_count == null ? null : summary.missing_count,
      packet_status: summary.packet_status || null,
      concession_status: summary.concession_status || null,
      main_blocker: summary.main_blocker || null,
    });
  }

  // ── S4 batched enrichment (both in-snapshot, one query each) ─────────
  // Semantic application timestamps for latest-activity (never updated_at),
  // and the deterministic conversation correlation — conversations are
  // unique(property_id, person_id), so person_id resolves at most one.
  const appIds = rows.map((r) => r.application_id).filter(Boolean);
  const tsById = new Map();
  if (appIds.length) {
    const tq = await client.query(
      `select id, applicant_signed_at, countersigned_at, activated_at
         from lease_applications where id = any($1::uuid[])`, [appIds]);
    for (const t of tq.rows) tsById.set(String(t.id), t);
  }
  const personIds = [...new Set(rows.map((r) => r.person_id).filter(Boolean).map(String))];
  const convByPerson = new Map();
  if (personIds.length) {
    const cq = await client.query(
      `select person_id, id, last_message_at from conversations
        where property_id = $1 and person_id = any($2::uuid[])`, [propertyId, personIds]);
    for (const c of cq.rows) convByPerson.set(String(c.person_id), c);
  }
  for (const row of rows) {
    const ts = tsById.get(String(row.application_id)) || {};
    const conv = row.person_id ? (convByPerson.get(String(row.person_id)) || null) : null;
    row.conversation_id = conv ? conv.id : null;
    row.activity_candidates = [
      { at: conv ? conv.last_message_at : null, label: "conversation_message" },
      { at: ts.applicant_signed_at, label: "application_signed" },
      { at: ts.countersigned_at, label: "application_countersigned" },
      { at: ts.activated_at, label: "application_activated" },
    ];
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
         cv.id as conversation_id, cv.last_message_at as conversation_last_message_at,
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
    -- S4: deterministic correlation — conversations are unique(property_id,
    -- person_id), so this join can never multiply rows.
    left join conversations cv on cv.property_id = c.property_id and cv.person_id = c.person_id
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
    const capability = require("../identity/capability");
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
    unit_id: r.unit_id || null,
    unit_number: r.unit_number || null,
    conversation_id: r.conversation_id || null,
    rung: r.rung,
    label: r.label,
    applicant_substatus: r.applicant_substatus || null,
    owner_user_id: r.owner_user_id || null,
    owner_name: r.owner_name,
    owner_basis: r.owner_user_id ? basisByOwner[r.owner_user_id] : "unassigned",
    due_at: r.due_at,
    due_state: r.due_state,
    next_move_code: r.next_move_code,
    created_at: r.created_at,
    // S4: latest MEANINGFUL activity candidates — semantic timestamps only.
    // The obligation's authoring moment is explicit activity; the generic
    // updated_at is deliberately not a candidate.
    activity_candidates: [
      { at: r.conversation_last_message_at, label: "conversation_message" },
      { at: r.created_at, label: "obligation_activity" },
    ],
    // D: explicit shadow flag the composer honors (never suppresses on
    // conversion-share alone). Both id keys travel on the row already.
    display_shadow_of_application: SHADOW_RUNGS.has(r.rung),
  }));
}

// ── S4: TOUR-CAPTURE ROWS ───────────────────────────────────────────────────
// Tours that HAPPENED with no recorded outcome. Judged by the ONE canonical
// capture resolver (tour_outcome.resolveCaptureState) with the SAME inputs the
// Tours board feeds it — terminal flag, the slot's honest end time, the tour's
// own occurrence time (walk-ins), origin, and the board's existing grace — so
// the desk and the board cannot hold two opinions about the same tour.
//
// Only capture_state 'overdue' becomes a desk row: the tour ended and nothing
// was captured — that is capture OWED, provably. 'untrackable' (no honest end
// time, so no honest answer) is NOT shown as owed work here — claiming it is
// owed would fabricate a judgment the resolver refuses to make — but its count
// travels on the envelope so unknown never reads as calm. The Tours board
// remains where untrackable tours are repaired.
const TW = require("../shared/tour_window");

// Mirrors the Tours board's capture grace (operator.js). Class-2 adapter there
// and here: replace BOTH with property-level capture-grace config together.
const TOUR_CAPTURE_GRACE_MINUTES = 15;

const TOUR_CAPTURE_SQL = `
  select t.id as tour_id, t.unit_id, un.unit_number,
         t.leasing_agent_id, u.name as host_name,
         t.checked_in_at, t.completed_at, t.origin, t.created_at,
         av.ends_at as scheduled_end_at,
         l.person_id, p.name as person_name,
         cv.id as conversation_id, cv.last_message_at as conversation_last_message_at
    from leasing_tours t
    join leasing_leads l on l.id = t.lead_id
    join persons p       on p.id = l.person_id
    left join users u    on u.id = t.leasing_agent_id
    left join units un   on un.id = t.unit_id
    left join tour_availability av on av.id = t.slot_id
    left join conversations cv
           on cv.property_id = t.property_id and cv.person_id = l.person_id
   where t.property_id = $1
     and not (${TW.isTerminalExpr("t")})`;

async function loadTourCaptureRows(client, propertyId) {
  const tourOutcome = require("./tour_outcome");
  const rows = (await client.query(TOUR_CAPTURE_SQL, [propertyId])).rows;
  const owed = [];
  let untrackable = 0;
  for (const r of rows) {
    const cs = tourOutcome.resolveCaptureState({
      isTerminal: false, // terminal rows are excluded in SQL by the same rule
      attendance: null,
      standing: null,
      tourEndedAt: r.scheduled_end_at || null,
      occurredAt: r.checked_in_at || r.completed_at || null,
      origin: r.origin || null,
      graceMinutes: TOUR_CAPTURE_GRACE_MINUTES,
    });
    if (cs.state === tourOutcome.CAPTURE_STATE.UNTRACKABLE) { untrackable++; continue; }
    if (cs.state !== tourOutcome.CAPTURE_STATE.OVERDUE) continue; // future/settled: nothing owed yet
    owed.push({
      tour_id: r.tour_id,
      unit_id: r.unit_id || null,
      unit_number: r.unit_number || null,
      leasing_agent_id: r.leasing_agent_id || null,
      host_name: r.host_name || null,
      person_id: r.person_id,
      person_name: r.person_name,
      conversation_id: r.conversation_id || null,
      capture_state: cs.state,
      capture_due_at: cs.capture_due_at || null,
      created_at: r.created_at,
      activity_candidates: [
        { at: r.conversation_last_message_at, label: "conversation_message" },
        // completed_at is a semantic completion moment when present; the
        // generic updated_at is deliberately never a candidate.
        { at: r.completed_at, label: "tour_completed" },
      ],
    });
  }
  return { owed, untrackable };
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
    const tourCapture = await loadTourCaptureRows(client, propertyId);
    const recentlyClosedRows = await loadRecentlyClosed(client, propertyId, windowHours, deps);

    // ── TEST RECORDS ARE NOT WORK ────────────────────────────────────
    //  `internal_qa` means the RECORD is a test context — Fable's ruling,
    //  and the same invariant the analytics exclusion already relies on
    //  (counting QA fixtures once produced a fake 88% tour cliff). The desk
    //  was the one surface that never applied it, so harness fixtures sat
    //  in the same list as real prospects with no way to tell them apart.
    //
    //  Read INSIDE the snapshot so classification cannot tear against the
    //  rows it filters.
    //
    //  CONSEQUENCE, stated because it is not obvious: a REAL person still
    //  classified internal_qa disappears from this desk. That is the
    //  classification meaning what it says. If they belong here, the fix is
    //  to classify them production — not to widen this filter.
    //
    //  CLASS 2 — the env escape hatch exists because this ships days before
    //  a live demo. Remove LEASING_DESK_SHOW_INTERNAL_QA once the demo runs
    //  on production-classified people; the exclusion itself is Class 1.
    const showQa = String(process.env.LEASING_DESK_SHOW_INTERNAL_QA || "").toLowerCase() === "true";
    let hidden = 0;
    let appRows = applicationRows, folRows = followupRows, closedRows = recentlyClosedRows;
    let tourRows = tourCapture.owed;
    if (!showQa) {
      const qa = new Set((await client.query(
        `select person_id from person_property_classifications
          where property_id = $1 and superseded_at is null and record_class = 'internal_qa'`,
        [propertyId])).rows.map((r) => String(r.person_id)));
      const keep = (rows) => rows.filter((r) => {
        const drop = r && r.person_id && qa.has(String(r.person_id));
        if (drop) hidden++;
        return !drop;
      });
      appRows = keep(applicationRows);
      folRows = keep(followupRows);
      closedRows = keep(recentlyClosedRows);
      tourRows = keep(tourCapture.owed);
    }

    // ── WHAT THE FILTER CANNOT JUDGE ─────────────────────────────────
    //  The filter above hides a KNOWN test context. It says nothing about a
    //  record carrying no classification at all, which sails past every
    //  class-based filter in the product — the codebase already names this
    //  trap: "Nothing is not neutral." An ungoverned record lands on the
    //  permissive side of every check, so it is shown as ordinary work.
    //
    //  These are NOT hidden, deliberately. Hiding a record because it cannot
    //  be judged is the same silent disappearance the filter was built to
    //  avoid, one category over — and some of them may be real people whose
    //  classification predates the intake birth guard. Honest blank beats
    //  confident wrong in both directions: show the row, and say plainly
    //  that nothing governs it.
    //
    //  A row with NO person at all is counted separately. That is not a
    //  classification gap, it is an integrity one — work on a board with
    //  nobody attached to it.
    const shown = [...appRows, ...folRows, ...tourRows, ...closedRows];
    const shownIds = [...new Set(shown.map((r) => r && r.person_id).filter(Boolean).map(String))];
    let ungoverned = 0;
    if (shownIds.length) {
      const governed = new Set((await client.query(
        `select person_id from person_property_classifications
          where property_id = $1 and superseded_at is null and person_id = any($2::uuid[])`,
        [propertyId, shownIds])).rows.map((r) => String(r.person_id)));
      ungoverned = shownIds.filter((id) => !governed.has(id)).length;
    }
    const personless = shown.filter((r) => r && !r.person_id).length;

    await client.query("commit");

    const desk = composeLeasingDesk({
      propertyId,
      applicationRows: appRows,
      // S5: Application Records is the EXACT Applications Review mirror, so it
      // is composed from the UNFILTERED application rows — the review list
      // itself applies no internal_qa filter, and record parity (every AR
      // record exactly once) outranks the rail's QA hygiene, which still
      // governs the ACTIVE stages above.
      applicationRecordRows: applicationRows,
      followupRows: folRows,
      tourCaptureRows: tourRows,
      tourCaptureUntrackable: tourCapture.untrackable,
      recentlyClosedRows: closedRows,
      recentlyClosedWindowHours: windowHours,
    });
    // Honest blank beats a quietly shortened list: say what was withheld,
    // and say what is shown that nothing vouches for.
    desk.internal_qa_hidden = showQa ? null : hidden;
    desk.ungoverned_shown = ungoverned;   // people on the board with no classification
    desk.personless_shown = personless;   // work on the board with nobody attached
    return desk;
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
  loadTourCaptureRows,
  loadRecentlyClosed,
  FOLLOWUP_SQL,
  TOUR_CAPTURE_SQL,
  CLOSED_SQL,
  SHADOW_RUNGS,
};
