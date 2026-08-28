// ════════════════════════════════════════════════════════════════════
//  tenancy_anchor_service.js — THE ONE CANONICAL COUNTERSIGN + CONFIRM-TERM
//
//  Fable ruling (tenancy-anchor operator seam): there is exactly ONE
//  countersign implementation and ONE confirm-term implementation, ONE
//  authority decision, ONE write path — with authorized entry adapters
//  only where necessary. This module IS that one implementation. It was
//  extracted verbatim from the two inline handlers that used to live in
//  applications.js; it is NOT a second implementation and MUST NOT be
//  forked.
//
//  ── DEPENDENCY DIRECTION (ruling Decision A) ──────────────────────────
//        applications.js ───────┐
//                               ├── tenancy_anchor_service.js
//        operator.js ───────────┘
//    The route modules depend on this service. This service depends on
//    NEITHER route module. It never becomes a route file and never
//    imports one.
//
//  ── WHAT THIS MODULE IS / IS NOT (ruling Decision B) ──────────────────
//    IS:  transaction-focused canonical writes. Each service receives an
//         already-authorized, server-derived set of inputs AND an OPEN
//         database client, then performs the single canonical write.
//    NOT: an authority boundary. There is NO request-header parsing, NO
//         session resolution, NO perimeter, and NO connection lifecycle
//         here. The ROUTE mounts dormantWriteGuard + activationPerimeter,
//         opens the transaction, calls the service, and commits/rolls
//         back. The perimeter's server-derived actor is passed IN.
//
//  ── ERROR CONTRACT (house pattern — mirrors leasing_leads.completeTourService) ─
//    Every controlled early-exit throws svcErr(status, body): an Error
//    carrying { svc:true, http:<status>, body:<json> } — the EXACT
//    response the route should send. The route translates with the same
//    one line both existing service callers already use:
//        if (e.svc) return res.status(e.http).json(e.body);
//    The service performs NO res.*; it does NOT rollback (the route owns
//    the transaction) — it throws, and the route's catch rolls back.
//
//  Construction (in server.js, from the obligation engine it already owns):
//    const { countersignService, confirmTermService } =
//      require("./tenancy_anchor_service")({
//        spawnObligationFromEvent, satisfyObligation, completeObligation,
//        ledgerService,   // optional (J1 commitment lock); absent = prior behavior
//      });
//  Then inject BOTH into applications.js AND operator.js as deps.
// ════════════════════════════════════════════════════════════════════

// The canonical lifecycle authority — status and its milestones are authored
// only here (Path E).
const lifecycle = require("../applications/application_lifecycle");

module.exports = function tenancyAnchorService(deps) {
  const {
    spawnObligationFromEvent,
    satisfyObligation,
    completeObligation,
    ledgerService = null,
    // v3 EXECUTION SEAM (§8-C/§10): the ONLY door for "a governing lease was
    // actually executed." Injected from server.js; NEVER a body-suppliable
    // argument. v3's implementation always returns null → countersign fails
    // closed with 409 executed_lease_required. Path B replaces the resolver
    // body, never its position in the chain.
    executionEvidence = null,
    // migration 088: the canonical executed-lease service. confirm-term calls
    // computeAdmissionBlockers + recordAdmissionEvaluation to RECOMPUTE from
    // live sources inside its own transaction — a stored verdict is a
    // projection, never authorization.
    executedLease = null,
  } = deps || {};

  if (typeof spawnObligationFromEvent !== "function" ||
      typeof satisfyObligation !== "function" ||
      typeof completeObligation !== "function") {
    throw new Error("tenancy_anchor_service requires { spawnObligationFromEvent, satisfyObligation, completeObligation }");
  }

  // ── service-error: carries the EXACT http status + json body the route
  //    should send. Identical shape to leasing_leads.svcErr so the two
  //    existing service callers' translation line works unchanged. ──
  function svcErr(status, body) {
    const e = new Error((body && (body.receipt || body.error)) || ("HTTP " + status));
    e.svc = true; e.http = status; e.body = body; return e;
  }

  // ── constants + helpers (lifted from applications.js) ──
  // COUNTERSIGN survives: when Path B produces real execution evidence, a
  // LEGACY blended gate (pre-v3 row) is closed by satisfying this input.
  // The signature vocabulary (tenantInputs) is GONE from this contract —
  // v3: a terms acknowledgment is not a signature, and this service no
  // longer reads, requires, or trusts applicant/guarantor signature inputs.
  const COUNTERSIGN = "manager_countersign";

  async function recordEvent(client, { property_id, person_id = null, unit_id = null, type, note }) {
    const r = await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,$4,$5) returning id`,
      [property_id, person_id, unit_id, type, note]
    );
    return r.rows[0].id;
  }

  const getApp = async (q, id) =>
    (await q.query("select * from lease_applications where id=$1", [id])).rows[0];

  // outstanding required inputs on the activation obligation (the live gate)
  async function outstanding(q, app) {
    if (!app.activation_obligation_id) return null;
    const o = (await q.query("select required_inputs, status from obligations where id=$1",
      [app.activation_obligation_id])).rows[0];
    return o ? { remaining: o.required_inputs || [], obligation_status: o.status } : null;
  }

  function nextAction(app) {
    switch (app.status) {
      case "submitted": return "Approve the application (clears it to a lease packet).";
      case "lease_ready": return "Awaiting applicant" + (app.guarantor_name ? " / guarantor" : "") + " signature.";
      case "tenant_signed": return "Tenant signed — manager must COUNTERSIGN to activate. Not active yet.";
      case "active": return "Lease active. Tenant file open.";
      case "declined": return "Declined.";
      case "withdrawn": return "Withdrawn.";
      default: return "Submit the application.";
    }
  }

  const shape = (app, gate) => ({
    id: app.id,
    property_id: app.property_id,
    unit_id: app.unit_id,
    person_id: app.person_id,
    status: app.status,
    applicant_name: app.applicant_name,
    unit_label: app.unit_label,
    rent: app.rent == null ? null : Number(app.rent),
    deposit: app.deposit == null ? null : Number(app.deposit),
    guarantor_name: app.guarantor_name,
    applicant_signed_at: app.applicant_signed_at,
    guarantor_signed_at: app.guarantor_signed_at,
    countersigned_at: app.countersigned_at,
    activated_at: app.activated_at,
    activation_obligation_id: app.activation_obligation_id,
    outstanding_inputs: gate ? gate.remaining : null,
    next_action: nextAction(app),
  });

  // ══════════════════════════════════════════════════════════════════
  //  COUNTERSIGN — Phase 1 (acceptance only; creates NO lease). THE WALL.
  //
  //  Faithful lift of the applications.js POST /applications/:id/countersign
  //  handler body. Preconditions the ROUTE has already enforced before
  //  calling this: dormantWriteGuard (mode enabled), activationPerimeter
  //  (authenticated session, property-activated, module entitlement,
  //  session-property == app-property, current internal_qa, eligible
  //  status in {lease_ready, tenant_signed}). This service is the FINAL
  //  authority under FOR UPDATE, exactly as before.
  //
  //  inputs: { applicationId, countersigned_by, note, countersigned_by_person_id }
  //    · countersigned_by            — required attestation (name/string)
  //    · note                        — optional
  //    · countersigned_by_person_id  — required ONLY when an eligible lease
  //                                    offer is bound (J1 economics lock)
  //  returns the success JSON body (the route wraps it in res.json()).
  // ══════════════════════════════════════════════════════════════════
  // ── countersignService: RETIRED (migration 088) ─────────────────────
  //  It required an executed lease and then performed a second "acceptance"
  //  — an internal architecture step leaking into the operator workflow as a
  //  ceremony that does not exist in the real world. Its legitimate work
  //  (open term confirmation) moved into executed_lease_service's admission
  //  phase; its illegitimate work ("locked economics win") was removed.
  //  The operator flow is now: Verify Executed Lease → Confirm Term.
  //  No alias is kept: an unlabelled compatibility shim with no removal
  //  condition is the exact stop-sign pattern the doctrine names.


  //  GOVERNING VALUES COME FROM THE VERIFIED EXECUTED LEASE — NOT THE BODY.
  //  rent, dates, deposit and premises are read from the executed_lease_records
  //  row. The browser supplies the command and the confirming human, nothing
  //  that governs. It therefore cannot assert a term, a premises, or a match.
  async function confirmTermService(client, { applicationId, confirmed_by = null,
    confirmed_by_user_id = null }) {

    if (!confirmed_by) throw svcErr(400, { receipt: "confirmed_by required — a human confirms the lease term." });
    if (!executedLease || typeof executedLease.computeAdmissionBlockers !== "function") {
      throw svcErr(503, { receipt: "Executed-lease service not wired on this deploy. Deploy executed_lease_service.js + the updated server.js together." });
    }

    const app = (await client.query("select * from lease_applications where id=$1 for update", [applicationId])).rows[0];
    if (!app) throw svcErr(404, { receipt: "No application with that id." });

    // must be in the accepted-term-required state (Phase 1 output)
    if (app.status !== "accepted_term_required") {
      throw svcErr(409, {
        receipt: `Cannot confirm term — this application is not yet at term confirmation (status '${app.status}'). Verify the executed lease first.`,
      });
    }

    // there must be an OPEN term_required obligation
    const oQ = await client.query(
      `select * from obligations
        where related_id=$1 and related_type='lease_application'
          and type='term_required' and status in ('open','in_progress')
        order by created_at desc limit 1 for update`, [app.id]);
    if (oQ.rows.length === 0) {
      throw svcErr(409, { receipt: "Cannot confirm term — no open term_required obligation for this application." });
    }
    const termObligation = oQ.rows[0];

    // ── IDEMPOTENCY GUARD (gate C): one lease anchor per application, PERIOD ──
    // The invariant is one lease per application REGARDLESS of status —
    // application_id is the provenance of one tenancy decision; a re-lease
    // comes from a new application or a governed renewal, never from reusing
    // this application. So this pre-check matches the unique index
    // `leases_one_anchor_per_application` (any lease on the application), NOT
    // just live states — otherwise an expired lease would pass and the insert
    // would hit the index with a raw 23505. Combined with the FOR UPDATE on
    // the application row above, two concurrent calls serialize and the second
    // returns this controlled 409 rather than ever throwing.
    const existing = await client.query(
      `select id, lease_status from leases
        where application_id=$1
        order by created_at asc limit 1`, [app.id]);
    if (existing.rows.length > 0) {
      // Convergence contract: both callers receive the SAME durable anchor.
      // The replay response names the winning lease id explicitly and marks
      // itself idempotent — the status code is secondary to the shared lease_id.
      throw svcErr(409, {
        error: "term_already_confirmed",
        lease_id: existing.rows[0].id,
        lease_status: existing.rows[0].lease_status,
        idempotent: true,
        receipt: "Term already confirmed for this application — converging on the existing lease anchor. One application creates exactly one lease; renewal, correction, and replacement are separate governed paths.",
        existing_lease_id: existing.rows[0].id,     // back-compat alias
      });
    }

    // ── RECOMPUTE ADMISSION FROM LIVE SOURCES (never the stored verdict) ──
    // A stored 'admitted' can go stale: an offer may lock, a confirmation may
    // supersede, the record may be voided or superseded between verification
    // and confirmation. Recompute inside THIS transaction, then write the
    // evaluation to the append-only history under the confirm_term context.
    const adm = await executedLease.computeAdmissionBlockers(client, { application_id: app.id });
    await executedLease.recordAdmissionEvaluation(client, {
      record: adm.record, application_id: app.id, blockers: adm.blockers, sources: adm.sources,
      evaluation_context: "confirm_term", evaluated_by_user_id: confirmed_by_user_id || null,
    });
    if (adm.blockers.length > 0) {
      throw svcErr(409, {
        error: "activation_blocked",
        blockers: adm.blockers,
        sources_compared: adm.sources,
        receipt: "Cannot confirm term — the verified executed lease conflicts with a governed source (" +
                 adm.blockers.map(b => b.code).join(", ") + "). The executed lease stands; " +
                 "resolve the conflict with a correction, amendment, or superseding verified record.",
      });
    }
    const executed = adm.record;

    // ── PREMISES: the EXACT space the executed lease names ──
    // Previously this resolved the application's unit to its first space by
    // creation date — correct for whole-unit leases, arbitrary for by-bed.
    // The executed document names the premises; we no longer guess.
    const spaceId = executed.space_id;

    // ── GOVERNING TERMS: from the executed lease. GATE B IS RETIRED. ──
    // "Locked economics win" is gone. A locked offer that disagrees with the
    // executed document is a BLOCKER (recomputed above), never an override:
    // an internal offer record cannot silently rewrite what was signed.
    const rent = Number(executed.rent);
    const security_deposit = Number(executed.security_deposit);
    const start_date = executed.lease_start_date;
    const end_date = executed.lease_end_date;
    const rent_source = "verified_executed_lease";
    const economics_conflict = null;   // a conflict never reaches this line
    const schedQ = await client.query(
      `select id from lease_economic_schedules where application_id=$1 and status='locked' order by created_at desc limit 1`,
      [app.id]);
    const schedule = schedQ.rows[0] || null;

    // ── create the PENDING lease — the tenancy anchor ──
    const tenantIds = app.person_id ? [app.person_id] : [];
    const lease = (await client.query(
      `insert into leases
         (property_id, space_id, tenant_ids, rent, start_date, end_date,
          security_deposit, lease_status, application_id)
       values ($1,$2,$3,$4,$5,$6,$7,'pending',$8) returning *`,
      [app.property_id, spaceId, tenantIds, rent, start_date, end_date, security_deposit, app.id]
    )).rows[0];

    // ── BACK-FILL THE EVIDENCE → LEASE LINK ──────────────────────────
    // The post-confirmation boundary depends on this: voidExecutedLease and
    // supersession refuse with lease_amendment_required only when the record
    // carries a lease_id. Without this write, the basis of a standing lease
    // could be voided out from under it.
    await client.query(
      `update executed_lease_records set lease_id=$1 where id=$2`,
      [lease.id, executed.id]);

    // ── link economics → the lease (fills the 071 handle) ──
    let economics_linked = false;
    if (schedule) {
      await client.query(`update lease_economic_schedules set lease_id=$1 where id=$2`, [lease.id, schedule.id]);
      economics_linked = true;
    }

    // ── complete the term_required obligation ──
    try {
      if (typeof satisfyObligation === "function") {
        await satisfyObligation(client, { obligation_id: termObligation.id, input: "lease_term_confirmation",
          proof: { confirmed_by, start_date, end_date } });
      }
    } catch (e) { if (e.code !== "NOT_OUTSTANDING") throw e; }
    try {
      await completeObligation(client, { obligation_id: termObligation.id, completed_by: confirmed_by });
    } catch (e) { if (e.code !== "ALREADY_COMPLETE") throw e; }

    // ── NOW promote: application → active, person → tenant ──
    // PATH E — through the canonical authority. It verifies the lease anchor
    // belongs to THIS application and that the term_required obligation is
    // genuinely complete (completed immediately above), so 'active' can never
    // be asserted without the work that justifies it.
    //
    // It also preserves the FIRST activation instant instead of overwriting
    // it: the raw write set activated_at=now() unconditionally, so any re-run
    // silently moved the tenancy's start of life to the re-run's clock.
    const activated = await lifecycle.markActiveFromConfirmedTerm(client, {
      applicationId: app.id, leaseId: lease.id, termRequiredObligationId: termObligation.id,
    });
    const updApp = activated.application;
    if (app.person_id) {
      await client.query("update persons set lifecycle_status='tenant' where id=$1", [app.person_id]).catch(() => {});
    }

    // ── SLICE D 2A — lease-linked move-in event (inline, atomic) ──────
    // The pending lease is a committed move-in. Create the move_in_scheduled
    // event linked to the lease by a REAL column (migration 074), effective on
    // the lease start_date (delivery-due default; no separate possession field
    // this slice). The partial unique index guarantees one move-in per lease —
    // a concurrent/retry insert fails on the constraint, caught below.
    if (app.unit_id) {
      try {
        await client.query(
          `insert into unit_events (unit_id, property_id, event_type, effective_date, payload, source, status, lease_id)
           values ($1,$2,'move_in_scheduled',$3,$4,'confirm_term','scheduled',$5)`,
          [app.unit_id, app.property_id, start_date,
           JSON.stringify({ applicant_name: app.applicant_name, lease_id: lease.id }), lease.id]);
      } catch (e) {
        // 23505 = the one-move-in-per-lease guard already fired (idempotent replay). Not fatal.
        if (e.code !== "23505") throw e;
      }

      // ── SLICE D 2B — PM-owned move_in_delivery obligation ───────────
      // Severity DERIVES from due_at proximity (not blanket high). Read the
      // property's delivery window; a move-in far out is planned, not urgent.
      let windowDays = 14;
      try {
        const cal = await client.query(
          `select delivery_window_days from property_leasing_calendar where property_id=$1 and active=true`,
          [app.property_id]);
        if (cal.rows[0] && cal.rows[0].delivery_window_days != null) windowDays = cal.rows[0].delivery_window_days;
      } catch (e) { /* calendar optional; default window */ }
      const msPerDay = 86400000;
      const daysUntil = Math.round((new Date(start_date).getTime() - Date.now()) / msPerDay);
      let dPriority = "low", dSeverity = "low";        // outside window → planned
      if (daysUntil <= windowDays) { dPriority = "high"; dSeverity = "normal"; }  // inside window
      if (daysUntil <= Math.ceil(windowDays / 2)) { dSeverity = "high"; }         // due soon → exception

      // guard: don't spawn a second delivery obligation for the same lease.
      const existingDelivery = await client.query(
        `select id from obligations where related_id=$1 and related_type='lease'
           and type='move_in_delivery' and status in ('open','in_progress') limit 1`, [lease.id]);
      if (existingDelivery.rows.length === 0) {
        const dEv = await recordEvent(client, {
          property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
          type: "move_in_delivery_opened",
          note: `Delivery promise opened — deliver unit for move-in ${start_date} (${app.applicant_name})`,
        });
        await spawnObligationFromEvent(client, {
          property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
          source_event_id: dEv,
          related_id: lease.id, related_type: "lease",
          module: "leasing", type: "move_in_delivery",
          label: `Deliver unit for move-in — ${app.applicant_name}${app.unit_label ? " · " + app.unit_label : ""}`,
          owner_type: "human", assigned_role: "property_manager",
          escalates_to_role: "asset_manager",   // 'regional_manager' is NOT in the role_name enum; asset_manager is the tier above property_manager
          status: "open", due_at: start_date,
          priority: dPriority, severity: dSeverity,
          // HARD gates only; resident_instructions_sent + move_in_logistics_considered are
          // tracked as soft prompts (payload), never required_inputs.
          required_inputs: ["unit_ready", "keys_access_ready"],
        });
      }
    }

    await recordEvent(client, {
      property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
      type: "lease_term_confirmed",
      note: `Lease term confirmed (${start_date} → ${end_date}) — pending lease created, tenancy activated (${app.applicant_name})`,
    });

    return {
      receipt: `Lease term confirmed — ${app.applicant_name}. Pending lease created (${start_date} → ${end_date}); the application is active and the person is a tenant.`,
      phase: "active",
      lease_id: lease.id,
      lease_status: lease.lease_status,
      lease_application_id: app.id,
      economics_linked,
      rent_source,
      economics_conflict,   // non-null only when locked economics disagreed with the seed
      term_required_obligation_id: termObligation.id,
      application: shape(updApp, { remaining: [], obligation_status: "complete" }),
    };
  }

  return { confirmTermService, _internal: { svcErr, shape, getApp, outstanding } };
};
