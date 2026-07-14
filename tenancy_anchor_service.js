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
//  ── ERROR CONTRACT (house pattern — mirrors leasingleads.completeTourService) ─
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

module.exports = function tenancyAnchorService(deps) {
  const {
    spawnObligationFromEvent,
    satisfyObligation,
    completeObligation,
    ledgerService = null,
  } = deps || {};

  if (typeof spawnObligationFromEvent !== "function" ||
      typeof satisfyObligation !== "function" ||
      typeof completeObligation !== "function") {
    throw new Error("tenancy_anchor_service requires { spawnObligationFromEvent, satisfyObligation, completeObligation }");
  }

  // ── service-error: carries the EXACT http status + json body the route
  //    should send. Identical shape to leasingleads.svcErr so the two
  //    existing service callers' translation line works unchanged. ──
  function svcErr(status, body) {
    const e = new Error((body && (body.receipt || body.error)) || ("HTTP " + status));
    e.svc = true; e.http = status; e.body = body; return e;
  }

  // ── constants + helpers (lifted from applications.js, unchanged) ──
  const COUNTERSIGN = "manager_countersign";
  const tenantInputs = (hasGuarantor) =>
    ["applicant_signature", ...(hasGuarantor ? ["guarantor_signature"] : [])];

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
  async function countersignService(client, { applicationId, countersigned_by = null, note = null, countersigned_by_person_id = null }) {
    if (!countersigned_by) throw svcErr(400, { receipt: "countersigned_by required — a human must countersign." });

    const app = await getApp(client, applicationId);
    if (!app) throw svcErr(404, { receipt: "No application with that id." });
    if (!app.activation_obligation_id) {
      throw svcErr(409, { receipt: "Application is not approved — no activation gate to countersign." });
    }
    if (app.status === "active") {
      throw svcErr(409, { receipt: "Lease is already active." });
    }

    const oQ = await client.query("select * from obligations where id=$1 for update", [app.activation_obligation_id]);
    const obligation = oQ.rows[0];
    const remaining = obligation.required_inputs || [];

    // HARD GATE: tenant must have signed before the company countersigns.
    const tenantLeft = tenantInputs(!!app.guarantor_name).filter((i) => remaining.includes(i));
    if (tenantLeft.length > 0) {
      throw svcErr(409, {
        receipt: "Cannot countersign — the tenant side has not signed yet. Tenant signature is intent; the company is not bound until they sign first.",
        tenant_signatures_outstanding: tenantLeft,
      });
    }

    // satisfy the countersign, then complete (the engine refuses on any leftover input)
    try {
      await satisfyObligation(client, { obligation_id: obligation.id, input: COUNTERSIGN,
        proof: { countersigned_by, note } });
    } catch (e) { if (e.code !== "NOT_OUTSTANDING") throw e; }

    try {
      await completeObligation(client, { obligation_id: obligation.id, completed_by: countersigned_by });
    } catch (e) {
      if (e.code === "INPUTS_OUTSTANDING") {
        throw svcErr(409, { receipt: "Cannot activate — required inputs still outstanding.", outstanding: e.outstanding_inputs });
      }
      if (e.code !== "ALREADY_COMPLETE") throw e;
    }

    // ── J1: THE COUNTERSIGN LOCK (Commitment Ledger, 063) ─────────────
    // If an eligible lease offer is bound to this application, its dated
    // economic schedule locks HERE, in this same transaction — the lease
    // and its committed economics activate together or not at all.
    //   · no ledger service / no offer → exactly the prior behavior.
    //   · offer present but the calendar contract (month placement) is
    //     not filled yet → REFUSE the countersign honestly rather than
    //     activate a lease whose committed economics can't be recorded.
    if (ledgerService && ledgerService.findEligibleOfferForApplication) {
      const offers = await ledgerService.findEligibleOfferForApplication(client, app.id);
      if (offers && offers.length > 0) {
        const offer = offers[0];
        // D10: the lock is attributed to the COUNTERSIGNER, a real person
        // row — the free-text countersigned_by name is not enough when
        // committed economics are being locked. Fail-closed, never faked.
        if (!countersigned_by_person_id) {
          throw svcErr(409, {
            receipt: "Cannot countersign — this application carries a lease offer, so the lock needs countersigned_by_person_id (the actual countersigning person). Committed economics are never attributed to a name string.",
            offer_id: offer.id,
          });
        }
        let lines;
        // Scoped offer (an eligibility class, not a quoted slot): the
        // lease chooses the room. Resolve the application's unit to its
        // '(whole unit)' space; an application with NO unit cannot lock
        // a scoped offer — refuse honestly, never guess a room.
        let resolvedSpaceId = null;
        if (!offer.space_id) {
          if (!app.unit_id) {
            throw svcErr(409, {
              receipt: "Cannot countersign — the lease offer is scoped (no exact unit quoted) and this application has no unit selected. Select the unit first; an offer never holds a room, the lease chooses one.",
              offer_id: offer.id,
            });
          }
          const sp = await client.query(
            `select id from spaces where unit_id = $1 order by created_at limit 1`, [app.unit_id]);
          if (sp.rowCount === 0) {
            throw svcErr(409, { receipt: "Cannot countersign — the application's unit has no space record.", offer_id: offer.id });
          }
          resolvedSpaceId = sp.rows[0].id;
        }
        try {
          lines = ledgerService.computeScheduleLines(offer);
        } catch (e) {
          if (e.code === "CALENDAR_CONTRACT_MISSING") {
            throw svcErr(409, {
              receipt: "Cannot countersign yet — this application carries a lease offer, but the calendar contract (concession month placement) is not configured. The lease cannot activate with its committed economics unrecorded.",
              offer_id: offer.id,
            });
          }
          throw e;
        }
        const locked = await ledgerService.lockLeaseEconomics(client, {
          application_id: app.id, offer_id: offer.id, lines,
          locked_by_person_id: countersigned_by_person_id,
          resolved_space_id: resolvedSpaceId,
        });
        void locked;
      }
    }

    // ── TWO-PHASE COUNTERSIGN (COUNTERSIGN_TENANCY_ANCHOR.md §2-3) ────
    // Countersign RECORDS ACCEPTANCE. It does NOT create the tenancy.
    // There is no canonical lease term at this moment (the offer carries a
    // duration, not dated start/end; computeScheduleLines is a stub). An
    // active application / tenant person with no describable term is a
    // poisoned truth, so we STOP here:
    //   · status → accepted_term_required   (accepted, term not yet pinned)
    //   · spawn a term_required obligation pointing at the APPLICATION
    //     (no lease exists yet: related_type='lease_application')
    //   · NO activated_at, NO 'active', NO tenant promotion, NO leases row.
    // The economics lock above (J1) already ran if an offer existed — the
    // committed schedule is preserved, application-linked, and will gain its
    // lease_id in Phase 2. Phase 2 (confirm-term) is the ONLY path that
    // creates the pending lease and promotes application + person.
    const upd = await client.query(
      `update lease_applications
          set status='accepted_term_required', countersigned_at=now(), updated_at=now()
        where id=$1 returning *`,
      [app.id]
    );

    // spawn the term_required obligation — the owned work that unblocks the
    // tenancy. It is NOT an error state; it is the product surfacing the
    // missing decision. Assigned to the manager; completed by Phase 2.
    const trEvId = await recordEvent(client, {
      property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
      type: "countersign_accepted_term_required",
      note: `Countersign accepted — lease term required before activation (${app.applicant_name})`,
    });
    let termObligation = null;
    try {
      termObligation = await spawnObligationFromEvent(client, {
        property_id: app.property_id,
        person_id: app.person_id,
        unit_id: app.unit_id,
        source_event_id: trEvId,
        related_id: app.id,
        related_type: "lease_application",
        module: "applications",
        type: "term_required",
        label: `Confirm lease term — ${app.applicant_name}${app.unit_label ? " · " + app.unit_label : ""}`,
        owner_type: "human",
        assigned_role: "property_manager",
        status: "open",
        priority: "high",
        severity: "normal",
        required_inputs: ["lease_term_confirmation"],
      });
    } catch (e) {
      // idempotency belt: if a term_required obligation already exists for
      // this application (re-countersign), do not stack a second one.
      if (e.code === "23505") {
        const ex = await client.query(
          `select id from obligations
            where related_id=$1 and related_type='lease_application'
              and type='term_required' and status in ('open','in_progress')
            order by created_at desc limit 1`, [app.id]);
        termObligation = ex.rows[0] || null;
      } else { throw e; }
    }

    return {
      receipt: `Countersign accepted — ${app.applicant_name}. Acceptance is recorded; the lease is NOT active yet. Confirm the lease term (start and end dates) to activate the tenancy.`,
      phase: "accepted_term_required",
      term_required_obligation_id: termObligation ? termObligation.id : null,
      next_action: "POST /operator/leasing/applications/:applicationId/confirm-term",
      application: shape(upd.rows[0], { remaining: ["lease_term_confirmation"], obligation_status: "open" }),
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONFIRM-TERM — Phase 2 (the tenancy anchor). Creates the pending
  //  lease, promotes application → active + person → tenant, EXACTLY once.
  //
  //  Faithful lift of POST /applications/:id/confirm-term. Preconditions
  //  the ROUTE enforced: dormantWriteGuard + activationPerimeter with
  //  eligibleStatuses=['accepted_term_required']. Idempotency + concurrency
  //  are enforced HERE under FOR UPDATE (route-agnostic): one lease anchor
  //  per application, period; two concurrent callers serialize → one 200 /
  //  one lease / one controlled 409, never a raw 23505.
  //
  //  Date validation is business logic (a term with no duration is not a
  //  term), so it lives HERE — both route families get identical rules.
  //
  //  inputs: { applicationId, start_date, end_date, confirmed_by, rent, security_deposit }
  //  returns the success JSON body (route wraps in res.json()).
  // ══════════════════════════════════════════════════════════════════
  async function confirmTermService(client, { applicationId, start_date = null, end_date = null,
    confirmed_by = null, rent: rentIn = null, security_deposit: depositIn = null }) {

    if (!confirmed_by) throw svcErr(400, { receipt: "confirmed_by required — a human confirms the lease term." });
    // STRUCTURED dates only — never a fallback string.
    if (!start_date || !end_date) {
      throw svcErr(400, { receipt: "start_date and end_date are required (YYYY-MM-DD). Captured free-text dates may seed the form but cannot confirm the term." });
    }
    const sd = new Date(start_date), ed = new Date(end_date);
    if (isNaN(sd.getTime()) || isNaN(ed.getTime())) {
      throw svcErr(400, { receipt: "start_date / end_date must be valid dates (YYYY-MM-DD)." });
    }
    if (ed <= sd) {
      throw svcErr(400, { receipt: "end_date must be after start_date — a term with no duration is not a term." });
    }

    const app = (await client.query("select * from lease_applications where id=$1 for update", [applicationId])).rows[0];
    if (!app) throw svcErr(404, { receipt: "No application with that id." });

    // must be in the accepted-term-required state (Phase 1 output)
    if (app.status !== "accepted_term_required") {
      throw svcErr(409, {
        receipt: `Cannot confirm term — application status is '${app.status}', not accepted_term_required. Term confirmation follows countersign acceptance.`,
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

    // ── resolve space_id (server-side, never client-nominated) ──
    // the application's unit → its '(whole unit)' space (first by creation).
    if (!app.unit_id) {
      throw svcErr(409, { receipt: "Cannot confirm term — the application has no unit selected. A lease chooses a room; select the unit first." });
    }
    const sp = await client.query(
      `select id from spaces where unit_id=$1 order by created_at asc limit 1`, [app.unit_id]);
    if (sp.rows.length === 0) {
      throw svcErr(409, { receipt: "Cannot confirm term — the application's unit has no space record." });
    }
    const spaceId = sp.rows[0].id;

    // ── SOURCE-RANK rent/deposit (ruling gate B): locked economics win ──
    // If a locked economic schedule exists for this application, its base_rent
    // is authoritative; the application's rent/deposit only SEED. A conflict is
    // reported, never silently overwritten.
    let rent = rentIn != null ? Number(rentIn) : (app.rent != null ? Number(app.rent) : null);
    let security_deposit = depositIn != null ? Number(depositIn) : (app.deposit != null ? Number(app.deposit) : null);
    let rent_source = rentIn != null ? "caller_confirmed" : (app.rent != null ? "application_seed" : "unset");
    let economics_conflict = null;
    const schedQ = await client.query(
      `select id from lease_economic_schedules where application_id=$1 and status='locked' order by created_at desc limit 1`,
      [app.id]);
    const schedule = schedQ.rows[0] || null;
    if (schedule) {
      // authoritative base_rent = sum of base_rent lines' first month, best-effort:
      // read the base_rent line amount (recurring). If it disagrees with the
      // resolved rent, surface it rather than pick silently.
      const brQ = await client.query(
        `select amount from lease_economic_lines
          where schedule_id=$1 and line_type='base_rent'
          order by effective_month asc limit 1`, [schedule.id]);
      if (brQ.rows.length > 0) {
        const lockedRent = Number(brQ.rows[0].amount);
        if (rent != null && Math.abs(lockedRent - rent) > 0.001) {
          economics_conflict = { application_or_caller_rent: rent, locked_economics_rent: lockedRent, resolved: lockedRent };
        }
        rent = lockedRent;               // locked economics WIN
        rent_source = "locked_economics";
      }
    }

    // ── create the PENDING lease — the tenancy anchor ──
    const tenantIds = app.person_id ? [app.person_id] : [];
    const lease = (await client.query(
      `insert into leases
         (property_id, space_id, tenant_ids, rent, start_date, end_date,
          security_deposit, lease_status, application_id)
       values ($1,$2,$3,$4,$5,$6,$7,'pending',$8) returning *`,
      [app.property_id, spaceId, tenantIds, rent, start_date, end_date, security_deposit, app.id]
    )).rows[0];

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
    const updApp = (await client.query(
      `update lease_applications
          set status='active', activated_at=now(), updated_at=now()
        where id=$1 returning *`, [app.id])).rows[0];
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

  return { countersignService, confirmTermService, _internal: { svcErr, shape, getApp, outstanding } };
};
