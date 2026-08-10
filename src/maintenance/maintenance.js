// ════════════════════════════════════════════════════════════════════
//  MAINTENANCE MODULE  —  routes/maintenance.js
//
//  Restored fresh after the June 6 paste-loss, rebuilt as an ISOLATED
//  module so it can never be silently dropped again. server.js owns the
//  database pool and the obligation-creation path; this module receives
//  them by injection and never duplicates that core logic.
//
//  Mount in server.js with exactly one line:
//      const maintenance = require("./maintenance");
//      app.use("/", maintenance({ pool, spawnObligationFromEvent }));
//
//  WHAT A WORK ORDER RECORDS  (migration 098)
//    field_category        what kind of work        (plumbing, paint…)
//    cause                 what caused it           (closed vocabulary)
//    tenant_caused         OBSERVED resident-caused (the one field a tech is asked)
//    work_nature           repair or replacement    (half the capital question)
//    extends_useful_life   does it extend asset life(the other half)
//    reported_by_person_id who raised it
//    affected_person_id    whose home it affects
//
//  It records OBSERVATIONS, not determinations. It does NOT store a GL
//  category, an operating category, an is_capex flag, a billback flag, or a
//  copy of the unit's state — see migration 098 for why each of those left.
//  Money meaning is resolved at READ by the reporting layer (migration 019:
//  "resolution order, applied at read time, never stored").
//
//  The previous header described a three-layer category engine ending in a
//  stored gl_category. That is gone. This comment is kept accurate on purpose:
//  a rule that lives only in a comment is how the code drifted from its own
//  design four times over.
// ════════════════════════════════════════════════════════════════════

module.exports = function maintenance(deps) {
  const express = require("express");
  const router = express.Router();

  // ── the closed operational vocabularies + the surviving supply-request
  //    derivation, all owned by the canonical service ──
  const { deriveCategories, CAUSES, WORK_NATURES } = require("./work_order_service");
  //  THE READ. No second status layer — it derives everything from canonical
  //  rows that already exist. See src/surfaces/work_order_status_read.js.
  const workOrderStatusRead = require("../surfaces/work_order_status_read");
  //  THE FOUR OPERATOR WRITES. One service per rendered verb; a control
  //  without one is a promise the product does not keep.
  const operatorActions = require("../technician/operator_actions");

  //  Every action runs in ONE transaction, commits, and only then attempts
  //  transport — so a carrier failure can never roll back the operating fact.
  //  The receipt names what happened and what is now responsible; delivery is
  //  reported separately or not at all.
  const runAction = async (req, res, fn) => {
    const client = await pool.connect();
    let out;
    try {
      await client.query("begin");
      //  `.id`, NOT `.user_id`. The resolved staff session has no `user_id`
      //  field — staff_session_service returns the user id as `id`, and says
      //  so: "user id (kept as `id` for drop-in compatibility with
      //  req.operator)". This line read `.user_id` and therefore passed
      //  undefined to EVERY governed maintenance action: assignWork,
      //  askForPhoto, coordinateEntry and prepareRetry each recorded no human
      //  author. JSON.stringify drops undefined keys outright, so the
      //  assignment receipt did not even carry a null — the field was simply
      //  absent, which reads as "never captured" rather than "unknown".
      //  Found by the Release 0 Gate 4 read-back, which asserts the governed
      //  assignment names its assigning actor. gate_operator_session_fields.js
      //  now fails on any read of a field the session does not define.
      out = await fn(client, { propertyId: req.operator.property_id, operatorUserId: req.operator.id });
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.error("operator action:", e.message);
      return res.status(e.code === "NOT_FOUND" ? 404 : e.code === "BAD_INPUT" ? 400 : 500)
        .json({ error: e.code || "action_failed", detail: e.message });
    } finally { client.release(); }

    if (out.outcome === "refused") {
      return res.status(409).json({ outcome: "refused", refusal: out.refusal,
        receipt: { text: "That can't be done right now.", reason: out.refusal } });
    }
    //  TRANSPORT, AFTER THE COMMIT, from the spec the service derived.
    let delivery = null;
    if (out.sendSpec && out.commEventId) {
      const sp = out.sendSpec;
      let wire;
      try {
        wire = sp.kind === "operations_reply"
          ? await commBoundary.sendOperationsReply({
              organization_id: sp.organization_id, recipient: sp.recipient, body: sp.body,
              replyToCommEventId: sp.replyToCommEventId, eventId: out.commEventId })
          : await commBoundary.sendPropertySms({
              property_id: sp.property_id, recipient: sp.recipient, body: sp.body,
              purpose: "work_order_update", person_id: sp.person_id, eventId: out.commEventId });
      } catch (e) { wire = { sent: false, reason: `transport_threw: ${e.message}`, sid: null }; }
      //  A retry's attempt row records the wire result and moves the current
      //  projection with it. Prior attempts are never overwritten.
      if (out.attemptNo) {
        await operatorActions.recordAttemptResult(pool, {
          commEventId: out.commEventId, attemptNo: out.attemptNo,
          sent: wire.sent, providerRef: wire.sid || null, failureReason: wire.reason });
      }
      delivery = { state: wire.sent ? "sent" : "failed", provider_ref: wire.sid || null,
                   reason: wire.sent ? null : wire.reason };
    }
    res.json({ outcome: out.outcome, receipt: out.receipt, delivery });
  };
  // BRICK ONE: the ONE session resolver. Required directly, exactly as
  // operator.js:35 does — not injected, so this adds no new boot-fatal
  // dependency to the module's wire-up.
  const staffSessions = require("../identity/staff_session_service");

  // ── injected core services (option 1: dependency injection) ──
  const { pool, spawnObligationFromEvent, workOrderService } = deps;
  if (!pool) throw new Error("maintenance module requires a pool");
  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("maintenance module requires spawnObligationFromEvent()");
  }
  // POST /work-orders delegates every create to the canonical service. Assert
  // it at CONSTRUCTION, not at first request: this module previously booted
  // clean without it and then threw TypeError on undefined inside the route,
  // which its own catch turned into a bare 500. Every work-order create was
  // dead for weeks behind a green boot. Fail at wire-up, loudly, instead.
  if (!workOrderService || typeof workOrderService.createWorkOrder !== "function") {
    throw new Error(
      "maintenance module requires workOrderService (build it with " +
      "makeWorkOrderService({ spawnObligationFromEvent }) and inject it)"
    );
  }

  // ════════════════════════════════════════════════════════════════
  //  THE AUTHORITY SEAM  (§21 server-derived identity and authority)
  //
  //    authenticated staff session
  //      → server-derived property
  //        → maintenance module entitlement
  //          → canonical work-order service
  //
  //  The browser may REQUEST work. It may not decide which building it acts
  //  on. Every /operator/work-orders route below takes property_id from the
  //  SESSION (staff_sessions → property_team_assignments, re-read live on
  //  every request), never from the body or the query string.
  //
  //  This is the seam the older /work-orders routes do not have: those sit
  //  behind the shared x-operator-key server-to-server gate and accept
  //  property_id as a parameter, so a single key reads any building. They are
  //  left in place for dev tooling and the existing callers; this is the path
  //  a signed-in human uses, and it cannot cross a property boundary.
  // ════════════════════════════════════════════════════════════════

  //  Session validity + active user + active assignment for the session's
  //  property are all re-checked here on EVERY request. No cached scope.
  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op;
      next();
    } catch (e) {
      return res.status(500).json({ error: "session resolution failed" });
    }
  }

  //  allowed_modules is LIVE from the resolver above — no second assignment
  //  query, so entitlement cannot drift from identity within one request.
  function requireMaintenanceModuleAccess(req, res, next) {
    const mods = (req.operator && req.operator.allowed_modules) || [];
    if (!mods.includes("maintenance")) {
      return res.status(403).json({
        error: "maintenance-module access required at this property (property_team_assignments.allowed_modules).",
      });
    }
    return next();
  }

  //  A client-supplied property_id is never authority (§21). If one is sent
  //  and it does not match the session's property, REFUSE — do not silently
  //  substitute the session value. Silently writing to a different building
  //  than the caller named is a confident wrong: the caller believes it acted
  //  on property A while the record landed on property B, and nothing says so.
  function refuseClientProperty(req, res, next) {
    const claimed =
      (req.body && req.body.property_id) || (req.query && req.query.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  const operatorGate = [requireOperator, requireMaintenanceModuleAccess, refuseClientProperty];

  // ════════════════════════════════════════════════════════════════
  //  THE EMERGENCY LIST (fixed for v1) + manager override
  // ════════════════════════════════════════════════════════════════
  // Each entry: due-time urgency tier drives priority + due_at.
  //   immediate  → due now (0 min)
  //   same_day   → due in 8h (legally/operationally urgent)
  //   high       → due in 24h
  const EMERGENCY_TYPES = {
    active_leak:        { label: "Active leak / flood",        urgency: "immediate" },
    flood:              { label: "Flood",                       urgency: "immediate" },
    no_heat:            { label: "No heat",                     urgency: "same_day"  },
    no_hot_water:       { label: "No hot water (urgent)",       urgency: "same_day"  },
    electrical_hazard:  { label: "Electrical hazard",           urgency: "immediate" },
    fire_life_safety:   { label: "Fire alarm / life safety",    urgency: "immediate" },
    lockout:            { label: "Lockout",                     urgency: "immediate" },
    security_issue:     { label: "Broken exterior door / security", urgency: "same_day" },
    sewer_backup:       { label: "Sewer backup",                urgency: "high"      },
    roof_leak:          { label: "Roof leak",                   urgency: "high"      },
    major_appliance:    { label: "Major appliance failure (urgent)", urgency: "high" },
    manager_override:   { label: "Marked emergency by manager", urgency: "immediate" },
  };

  // Escalation chain for emergency work (stored on the event + work order
  // context; the obligation itself carries the existing two-role field set
  // so we DON'T change the obligations schema in this step).
  const EMERGENCY_CHAIN = [
    "on_call_maintenance",
    "maintenance_supervisor",
    "property_manager",
    "owner",
  ];

  const urgencyToDueAt = (urgency) => {
    const mins = { immediate: 0, same_day: 8 * 60, high: 24 * 60 }[urgency] ?? 24 * 60;
    return new Date(Date.now() + mins * 60 * 1000);
  };
  const urgencyToPriority = (urgency) =>
    // obligations.priority allows only low|normal|high (ck_obl_priority).
    // All emergency tiers are high priority; the finer urgency (immediate vs
    // same_day) lives on the work order + event and drives due_at below.
    "high";

  // ════════════════════════════════════════════════════════════════
  //  THE NOT-DONE REASONS  (the continuity engine's input)
  //
  //  When a tech closes a work order as NOT 100% done, they pick a reason
  //  from THIS fixed list — never free text (same discipline as the down-unit
  //  DOWN_REASONS and the EMERGENCY_TYPES above). The reason is what lets the
  //  chain stay alive: each reason routes to a specific follow-up obligation
  //  through the shared engine, so a stalled job always has a named next step
  //  and a named owner. "Nothing is done until the next step is visible."
  //
  //  Each entry declares how it routes:
  //    follow_type      — the obligation type spawned for the next step
  //    follow_role      — who owns that next step (an org-chart role)
  //    escalates_to     — where it escalates if that owner doesn't move
  //    follow_label(wo) — the human sentence the owner sees
  // ════════════════════════════════════════════════════════════════
  //  ── EXTRACTED TO maintenance/not_done_reasons.js ─────────────────
  //  The Work Orders read surface has to name the reason a job stalled on
  //  a board row, and it cannot see this closure. Exported rather than
  //  restated there, because a second copy of a routing table is how a
  //  reader and a writer come to disagree about where a stall went.
  const { NOT_DONE_REASONS, reasonChoices, FOLLOW_UP_TYPES } = require("./not_done_reasons");
  const { recordNotDone } = require("./not_done_service");
  const { acceptWork } = require("../technician/acceptance_service");

  //  ── A REFUSAL A HUMAN CAN SEE IS PRODUCT COPY ─────────────────────
  //  The acceptance predicate answers in engineering vocabulary, which is
  //  right for a verdict and wrong for a person holding a phone. Each one
  //  is said plainly and names what to do instead — a refusal with no next
  //  step reads as a broken button.
  const REFUSAL_COPY = (verdict) => ({
    not_assigned_to_actor:
      "This job is assigned to someone else, so it is not yours to take. "
      + "Assign it first if it should be yours.",
    property_outside_actor_scope:
      "You are not on the team for this property, so you cannot take work here.",
    already_accepted_by_another:
      "Somebody else has already taken this job.",
    already_accepted_by_actor:
      "You already have this job.",
    not_open:
      "This job is no longer open, so there is nothing to take.",
    not_actionable_status:
      "This job is not in a state that can be taken.",
    not_work_order_related:
      "That record is not a work order.",
    state_changed_before_write:
      "Somebody changed this job while you were taking it. Reload and try again.",
    acceptance_key_already_used:
      "That request was already recorded. Nothing changed.",
  })[verdict] || "This job cannot be taken right now.";

  // ════════════════════════════════════════════════════════════════
  //  THE CATEGORY ENGINE  (field + context → operating → gl)
  // ════════════════════════════════════════════════════════════════
  //  Imported, never redefined. The canonical service owns this derivation
  //  (see work_order_service.js) because createWorkOrder must categorize a
  //  saved row exactly as GET /maintenance/preview-category promised. A
  //  second local copy here is what let the preview and the write disagree.
  //  One definition, three callers: preview, create, supply requests.
  // ════════════════════════════════════════════════════════════════
  //  PREVIEW CATEGORY  —  REMOVED (migration 098)
  //
  //  This previewed a derivation the write no longer performs. A preview that
  //  promises what the save will not do is precisely the defect this module was
  //  just repaired for: an operator previewed "tenant billback", pressed save,
  //  and got an ordinary resident repair. Now that the work order records
  //  observations instead of deriving categories, there is nothing to preview —
  //  so the door is gone rather than left answering about a vanished field.
  //
  //  The operator surface asks for observations directly. What it needs is the
  //  ALLOWED VALUES, not a prediction, and those are served below.
  // ════════════════════════════════════════════════════════════════
  router.get("/maintenance/observation-vocabulary", (_req, res) => {
    res.json({
      cause: CAUSES,
      work_nature: WORK_NATURES,
      // Named so a UI builder knows which single question is the one worth
      // asking a field tech (DOCTRINE §5: one question per event, maximum).
      primary_question: {
        field: "tenant_caused",
        prompt: "Was this tenant-caused?",
        note: "Leave unanswered if not observed. Unanswered stays unknown; it never becomes 'no'.",
      },
    });
  });

  // List the fixed emergency types (for the UI dropdown).
  router.get("/maintenance/emergency-types", (_req, res) => {
    res.json(
      Object.entries(EMERGENCY_TYPES).map(([key, v]) => ({ key, ...v }))
    );
  });

  // List the fixed not-done reasons (for the closeout "not done" dropdown).
  // Returns key + label only — the routing internals (follow_type/role) stay
  // server-side. The UI shows labels; the server decides where each one goes.
  router.get("/maintenance/not-done-reasons", (_req, res) => {
    res.json(reasonChoices());
  });

  //  THE SAME VOCABULARY, INSIDE THE STAFF-SESSION PERIMETER.
  //  The route above is reachable only with the shared operator key, so the
  //  signed-in app could not read it and shipped a hardcoded copy of these
  //  labels as a "fallback" — which, because index.html's getJSON is
  //  offline-locked, was the ONLY thing it ever rendered. A live operator
  //  surface was populating a governed picker from a literal in the page.
  //
  //  §19–20: one vocabulary, read live, no fallback. If this read fails the
  //  door says so and offers nothing, because a reason we cannot route is a
  //  stall with no next step.
  router.get("/operator/work-orders/not-done-reasons", ...operatorGate, (_req, res) => {
    res.json({ reasons: reasonChoices() });
  });

  // ════════════════════════════════════════════════════════════════
  //  CREATE WORK ORDER  —  POST /work-orders
  //
  //  Body: {
  //    property_id (required),
  //    unit_id?                 (null = common area / property-level),
  //    reported_by_person_id?   who raised it   (null = staff-originated),
  //    affected_person_id?      whose home it affects (null = unknown/common),
  //    title, description?,
  //    field_category?, cause?  (closed vocabulary — see CAUSES), est_cost?,
  //    tenant_caused?           OBSERVED resident-caused; null = not observed,
  //    work_nature?             'repair' | 'replacement',
  //    extends_useful_life?     bool; null = not assessed,
  //    assigned_to?,
  //    is_emergency? (bool), emergency_type? (key from EMERGENCY_TYPES)
  //  }
  //
  //  Every observation is OPTIONAL and an omitted one stays NULL. It does not
  //  become false to keep a form looking complete. GET
  //  /maintenance/observation-vocabulary serves the allowed values.
  //
  //  A normal work order just records. An EMERGENCY work order writes a
  //  maintenance EVENT and spawns an OBLIGATION from it (same atomic path
  //  the rest of the engine uses) — obligation born only from an event.
  // ════════════════════════════════════════════════════════════════
  router.post("/work-orders", async (req, res) => {
    // Thin wrapper: business behavior (WO + urgency truth + universal obligation +
    // event, all in ONE transaction) is owned by the canonical service. This route
    // owns request shaping, the operator→urgency mapping, and the response contract.
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { workOrder, event, obligation } = await workOrderService.createWorkOrder(client, {
        property_id: b.property_id, unit_id: b.unit_id,
        reported_by_person_id: b.reported_by_person_id, affected_person_id: b.affected_person_id,
        title: b.title, description: b.description,
        field_category: b.field_category, cause: b.cause, est_cost: b.est_cost,
        tenant_caused: b.tenant_caused, work_nature: b.work_nature,
        extends_useful_life: b.extends_useful_life,
        assigned_to: b.assigned_to, source: "maintenance_module",
        urgency_status: b.is_emergency ? "emergency" : "regular",
        urgency_basis: b.is_emergency ? "operator marked emergency" : "operator entry",
        urgency_decided_by: "operator", emergency_type: b.emergency_type,
        idempotency_key: b.idempotency_key,
      });
      await client.query("commit");
      res.status(201).json({ work_order: workOrder, event, obligation });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      res.status(e.httpStatus || 500).json({ error: e.message, ...(e.allowed ? { allowed: e.allowed } : {}) });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  LIST WORK ORDERS  —  GET /work-orders
  //  ?property_id=  ?unit_id=  ?status=  ?is_emergency=true  ?needs_pm_review=true
  // ════════════════════════════════════════════════════════════════
  router.get("/work-orders", async (req, res) => {
    const { property_id, unit_id, status, is_emergency, needs_pm_review } = req.query;
    try {
      const where = [];
      const vals = [];
      if (property_id)    { vals.push(property_id);     where.push(`property_id = $${vals.length}`); }
      if (unit_id)        { vals.push(unit_id);         where.push(`unit_id = $${vals.length}`); }
      if (status)         { vals.push(status);          where.push(`status = $${vals.length}`); }
      if (is_emergency)   { vals.push(is_emergency === "true"); where.push(`is_emergency = $${vals.length}`); }
      if (needs_pm_review){ vals.push(needs_pm_review === "true"); where.push(`needs_pm_review = $${vals.length}`); }
      const sql = "select * from work_orders" +
        (where.length ? " where " + where.join(" and ") : "") +
        " order by is_emergency desc, created_at desc";
      const r = await pool.query(sql, vals);
      res.json(r.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── single work order detail ──
  router.get("/work-orders/:id", async (req, res) => {
    try {
      const r = await pool.query("select * from work_orders where id=$1", [req.params.id]);
      if (r.rows.length === 0) return res.status(404).json({ error: "work order not found" });
      res.json(r.rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  CLOSEOUT  —  PATCH /work-orders/:id/closeout
  //
  //  THE PROOF GATE. A work order cannot close without BOTH:
  //    completion_photo (photo proof)  AND  completion_note (closeout notes)
  //
  //  Body: { completion_photo?, completion_note?, done? (default true) }
  //
  //  If done=false (work NOT done): the WO is NOT closed and a follow-up
  //  review item is created for the property manager / supervisor — it does
  //  not silently disappear. needs_pm_review stays true.
  // ════════════════════════════════════════════════════════════════
  router.patch("/work-orders/:id/closeout", async (req, res) => {
    const { completion_photo, completion_note, done = true, not_done_reason } = req.body || {};

    /*  ══ STEP 6 — THE LEGACY DONE-PATH IS RETIRED ═══════════════════
     *
     *  This route could put a work order into a terminal state while
     *  writing NO proof evaluation, NO completion progress event and NO
     *  attributable actor — and its `completion_photo` column holds a
     *  `stub://` string with no bytes behind it, so it can never be
     *  converted into proof after the fact (§4.1).
     *
     *  Release 0 establishes ONE governed meaning of completion, written
     *  by ONE canonical transaction. A second writer that can reach the
     *  same terminal state is not a redundancy, it is a contradiction:
     *  a `closed` row with nothing behind it is indistinguishable, later,
     *  from a completion that was never proven.
     *
     *  ── WHY THE REFUSAL IS HERE, BEFORE THE CONNECTION ──────────────
     *  "Writes nothing" is a claim. Refusing before `pool.connect()`
     *  makes it a property of the code path: no transaction is opened, no
     *  row is locked, and there is no ordering in which a write could
     *  precede the refusal. A guard placed after the lock would have to
     *  be trusted; this one cannot be wrong.
     *
     *  ── WHAT IS NOT RETIRED ─────────────────────────────────────────
     *  The NOT-DONE path below is untouched and still works. That is the
     *  paired control: it is what proves this 409 is a governed refusal
     *  of one verb rather than a dead route or a broken service.
     *
     *  §1.1.2 — this is a CONTAINMENT decision, not a permanent ruling
     *  that operator completion authority is abolished. A governed
     *  operator/manager acceptance surface may well be right later, for
     *  vendor work, SMS outages or supervisory clearance. It is not
     *  invented inside Release 0.  */
    if (done !== false) {
      return res.status(409).json({
        error: "legacy_completion_retired",
        message:
          "This path can no longer complete a work order. Completion is recorded " +
          "by the technician in the field, through the operations text line, which " +
          "writes the proof evaluation and the completion event in one transaction.",
        canonical_path: "technician/lifecycle_service.claimCompletion",
        //  Named so an operator reading a failed request learns what DOES
        //  work here, rather than only what does not.
        still_available: "PATCH /work-orders/:id/closeout with done=false — log a " +
                         "reason and route the follow-up. That path is unchanged.",
        wrote: null,
      });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const woQ = await client.query("select * from work_orders where id=$1 for update", [req.params.id]);
      if (woQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "work order not found" }); }
      const wo = woQ.rows[0];

      // ── NOT DONE PATH: route the stall, leave WO open ──
      //
      //  THE CONTINUITY ENGINE. A not-done close is not a dead end — it is a
      //  fork that MUST produce a named next step with a named owner. The tech
      //  picks a structured reason; that reason both (a) gets stored on the WO
      //  in its own column (not jammed into completion_note) and (b) spawns the
      //  RIGHT follow-up obligation through the SAME shared engine every other
      //  obligation is born from. The chain cannot break.
      if (done === false) {
        //  ── THE BEHAVIOR MOVED; THE CONTRACT DID NOT ──────────────────
        //  Every step this used to perform inline now lives in
        //  not_done_service.recordNotDone, because the signed-in operator
        //  surface needs the same fact recorded and must not reach this
        //  route to get it (shared key, no property scope). One writer,
        //  two doors. `defaultWhenMissing` preserves THIS caller's promise
        //  that a blank reason routes to PM review rather than vanishing —
        //  the operator door passes false, since its picker is populated
        //  from the same vocabulary and a blank there is a surface defect.
        let outcome;
        try {
          outcome = await recordNotDone(client, {
            workOrder: wo,
            reasonKey: not_done_reason,
            note: completion_note,
            spawnObligationFromEvent,
            defaultWhenMissing: true,
          });
        } catch (e) {
          if (e.code === "INVALID_REASON") {
            await client.query("rollback");
            return res.status(400).json({ error: "invalid not_done_reason", allowed: e.allowed });
          }
          throw e;
        }
        const { reasonKey, route, followup } = outcome;

        await client.query("commit");
        const updated = await pool.query("select * from work_orders where id=$1", [wo.id]);
        return res.status(200).json({
          work_order: updated.rows[0],
          followup_created: true,
          not_done_reason: reasonKey,
          followup_obligation: followup,
          message: `Work marked not done (${route.label}) — ${route.follow_type} follow-up created for ${route.follow_role}.`,
        });
      }

      // ── DONE PATH: enforce the proof gate ──
      const missing = [];
      if (!completion_photo) missing.push("completion_photo");
      if (!completion_note)  missing.push("completion_note");
      if (missing.length > 0) {
        await client.query("rollback");
        return res.status(409).json({
          error: "cannot close without proof",
          required_inputs: missing,
        });
      }

      await client.query(
        `update work_orders
           set status='closed', completion_photo=$2, completion_note=$3,
               updated_at=now()
         where id=$1`,
        [wo.id, completion_photo, completion_note]
      );
      await client.query(
        `insert into events (property_id, person_id, unit_id, type, note)
         values ($1,$2,$3,'work_order_closed',$4)`,
        [wo.property_id, wo.affected_person_id ?? wo.reported_by_person_id ?? null, wo.unit_id ?? null,
         JSON.stringify({ work_order_id: wo.id })]
      );

      await client.query("commit");
      const updated = await pool.query("select * from work_orders where id=$1", [wo.id]);
      res.status(200).json({ work_order: updated.rows[0], closed: true });
    } catch (e) {
      await client.query("rollback");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  OPERATOR WORK ORDERS — the authority-scoped path
  //
  //  POST /operator/work-orders   create at the SESSION's property
  //  GET  /operator/work-orders   read ONLY the session's property
  //
  //  Identical business meaning to POST /work-orders — the same canonical
  //  service, the same category derivation, the same obligation and event.
  //  The only difference is where property authority comes from. There is no
  //  second work-order path, only a second door into the one that exists.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/work-orders", ...operatorGate, async (req, res) => {
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { workOrder, event, obligation, deduped } = await workOrderService.createWorkOrder(client, {
        // ── authority: from the session, never the request ──
        property_id: req.operator.property_id,
        // ── everything else is a request, not a claim of authority ──
        unit_id: b.unit_id,
        reported_by_person_id: b.reported_by_person_id, affected_person_id: b.affected_person_id,
        title: b.title, description: b.description,
        field_category: b.field_category, cause: b.cause,
        tenant_caused: b.tenant_caused, work_nature: b.work_nature,
        extends_useful_life: b.extends_useful_life,
        est_cost: b.est_cost, assigned_to: b.assigned_to,
        source: "operator",
        urgency_status: b.is_emergency ? "emergency" : "regular",
        urgency_basis: b.is_emergency ? "operator marked emergency" : "operator entry",
        urgency_decided_by: "operator",
        emergency_type: b.emergency_type,
        idempotency_key: b.idempotency_key,
      });
      await client.query("commit");
      res.status(201).json({
        work_order: workOrder, event, obligation, deduped: !!deduped,
        // The receipt names the building the operator actually acted on, so
        // server-derived scope is visible rather than merely enforced.
        acted_on: { property_id: req.operator.property_id, actor: req.operator.name || null },
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      res.status(e.httpStatus || 500).json({ error: e.message, ...(e.allowed ? { allowed: e.allowed } : {}) });
    } finally {
      client.release();
    }
  });

  router.get("/operator/work-orders", ...operatorGate, async (req, res) => {
    const { status, unit_id, is_emergency, needs_pm_review } = req.query;
    try {
      // property_id is NOT a filter here — it is the scope, and it is the
      // session's. A caller cannot widen it, and there is no "all properties".
      const vals = [req.operator.property_id];
      const where = ["property_id = $1"];
      if (status)          { vals.push(status);                    where.push(`status = $${vals.length}`); }
      if (unit_id)         { vals.push(unit_id);                   where.push(`unit_id = $${vals.length}`); }
      if (is_emergency)    { vals.push(is_emergency === "true");    where.push(`is_emergency = $${vals.length}`); }
      if (needs_pm_review) { vals.push(needs_pm_review === "true"); where.push(`needs_pm_review = $${vals.length}`); }
      const r = await pool.query(
        "select * from work_orders where " + where.join(" and ") +
        " order by is_emergency desc, created_at desc", vals);
      res.json({ property_id: req.operator.property_id, work_orders: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── LIFECYCLE VISIBILITY ───────────────────────────────────────────
  //  A READ over canonical rows. It creates no status, keeps no timeline,
  //  and writes nothing. Property scope is the SESSION'S, never the
  //  caller's — refuseClientProperty is in the gate and the scope is passed
  //  into every query rather than checked afterwards, so a work order at
  //  another property returns 404 instead of leaking a row.
  router.get("/operator/work-orders/status", ...operatorGate, async (req, res) => {
    try {
      const rows = await workOrderStatusRead.readPropertyWorkOrderStatuses(pool, {
        propertyId: req.operator.property_id,
        limit: Math.min(Number(req.query.limit) || 100, 200),
        //  WHO IS LOOKING, from the resolved session and nowhere else. It
        //  answers "may I take this" per row; it never widens the scope,
        //  which stays property_id.
        viewerUserId: req.operator.id,
      });
      //  HONEST EMPTY. An empty list is a fact, and it is returned as one —
      //  never as sample work, and never as an error.
      res.json({ property_id: req.operator.property_id, count: rows.length, work_orders: rows });
    } catch (e) {
      //  UNAVAILABLE, never fixtures. The surface says the live read failed.
      console.error("operator work-order status list:", e.message);
      res.status(503).json({ error: "unavailable", detail: "The live work-order read is unavailable. Retry." });
    }
  });

  //  Candidates for Assign — derived, so the picker cannot offer somebody
  //  the write would refuse.
  router.get("/operator/work-orders/technicians", ...operatorGate, async (req, res) => {
    try {
      res.json({ technicians: await operatorActions.eligibleTechnicians(pool,
        { propertyId: req.operator.property_id }) });
    } catch (e) { res.status(503).json({ error: "unavailable" }); }
  });

  router.post("/operator/work-orders/:id/assign", ...operatorGate, (req, res) =>
    runAction(req, res, (c, ctx) => operatorActions.assignWork(c, Object.assign({
      workOrderId: req.params.id,
      technicianUserId: (req.body || {}).technician_user_id,
      idempotencyKey: (req.body || {}).idempotency_key || null }, ctx))));

  router.post("/operator/work-orders/:id/ask-photo", ...operatorGate, (req, res) =>
    runAction(req, res, (c, ctx) => operatorActions.askForPhoto(c, Object.assign({
      workOrderId: req.params.id, idempotencyKey: (req.body || {}).idempotency_key || null }, ctx))));

  router.post("/operator/work-orders/:id/coordinate-entry", ...operatorGate, (req, res) =>
    runAction(req, res, (c, ctx) => operatorActions.coordinateEntry(c, Object.assign({
      workOrderId: req.params.id, idempotencyKey: (req.body || {}).idempotency_key || null }, ctx))));

  //  RETRY — a new attempt at an EXISTING intent. It creates no work order,
  //  no completion event and no new message.
  router.post("/operator/work-orders/:id/retry-resident", ...operatorGate, (req, res) =>
    runAction(req, res, (c, ctx) => operatorActions.prepareRetry(c, Object.assign({
      commEventId: (req.body || {}).comm_event_id,
      idempotencyKey: (req.body || {}).idempotency_key || null }, ctx))));

  // ════════════════════════════════════════════════════════════════
  //  STILL NEEDS WORK  —  POST /operator/work-orders/:id/not-done
  //
  //  The same fact the legacy `PATCH /work-orders/:id/closeout done=false`
  //  records, reached the way a signed-in human reaches it. That route is
  //  gated by the SHARED operator key and carries no property scope, so the
  //  operator app could not call it without shipping a shared credential to
  //  the browser and could not be stopped from stalling a work order at
  //  another building. Both are §21 failures, and neither is fixed by
  //  authenticating harder — authentication answers WHO may call, never
  //  WHERE the output may land.
  //
  //  ONE WRITER: not_done_service.recordNotDone. This route contributes
  //  authority and a receipt, not behavior.
  //
  //  The reporter states a FACT — what is stopping completion. Spine decides
  //  the consequence: which obligation type, which role owns it, where it
  //  escalates. None of that travels in the request.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/work-orders/:id/not-done", ...operatorGate, async (req, res) => {
    const { not_done_reason, note } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      //  SCOPED IN THE QUERY, not checked after it. A work order at another
      //  property is not found, rather than found and then refused.
      const woQ = await client.query(
        "select * from work_orders where id=$1 and property_id=$2 for update",
        [req.params.id, req.operator.property_id]);
      if (woQ.rows.length === 0) {
        await client.query("rollback");
        return res.status(404).json({ error: "not_found",
          receipt: { text: "That work order is not at the property you are operating." } });
      }
      const wo = woQ.rows[0];

      //  ALREADY CLOSED WORK CANNOT STALL. Completion is the technician's,
      //  in the field; re-opening it is not this control's job and inventing
      //  one here would be a second completion authority by the back door.
      if (wo.status === "complete") {
        await client.query("rollback");
        return res.status(409).json({ error: "already_complete",
          receipt: { text: "This work order is already complete. A finished job cannot be reported as stalled." } });
      }

      let out;
      try {
        out = await recordNotDone(client, {
          workOrder: wo,
          reasonKey: not_done_reason,
          note: note || null,
          actorUserId: req.operator.id,
          spawnObligationFromEvent,
          //  FALSE, unlike the legacy caller. This surface populates its
          //  picker from the same vocabulary, so a missing reason is a defect
          //  in the surface — not an old client to be generous with.
          defaultWhenMissing: false,
        });
      } catch (e) {
        if (e.code === "INVALID_REASON") {
          await client.query("rollback");
          return res.status(400).json({ error: "invalid_not_done_reason", allowed: e.allowed,
            receipt: { text: "Pick a reason from the list so the next step has an owner." } });
        }
        throw e;
      }
      await client.query("commit");

      //  §28 — a plain-language receipt: what happened, the durable record,
      //  and what happens next with who owns it.
      return res.status(200).json({
        work_order_id: wo.id,
        not_done_reason: out.reasonKey,
        event_id: out.event.id,
        followup_obligation: out.followup,
        receipt: {
          text: `Logged: ${out.route.label}. The work order stays open, and `
              + `${out.route.follow_role.replace(/_/g, " ")} now owns the next step.`,
        },
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.error("operator work-order not-done:", e.message);
      return res.status(503).json({ error: "unavailable",
        receipt: { text: "That could not be recorded. Nothing was changed. Retry." } });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  TAKE JOB  —  POST /operator/work-orders/:id/accept
  //
  //  ONE ACCEPTANCE FACT, TWO AUTHENTICATION RAILS. A technician accepting
  //  by text and the same technician accepting in the app are the same
  //  business event; only how they proved who they are differs. SMS
  //  establishes the organization through the messaging line, the signed-in
  //  app establishes it through the authenticated property context. So this
  //  route resolves context and then calls the SAME canonical service the
  //  SMS rail calls — it does not fork acceptance semantics, and it is NOT
  //  the unit-turn acceptance rail, which operates on
  //  `unit_triage_required_work` and is a different object entirely.
  //
  //  THE BROWSER SENDS NOTHING AUTHORITATIVE. It knows "I am looking at this
  //  work order and I want to take it." The server resolves actor, property,
  //  the work order's owning obligation, and the organization behind that
  //  property. An `obligation_id` from a client would be a caller supplying
  //  the fact that authorises it.
  //
  //  TAKING IS NOT ASSIGNING. The canonical predicate refuses an obligation
  //  assigned to somebody else (`not_assigned_to_actor`), so this cannot
  //  accept on another person's behalf. Assignment stays its own action.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/work-orders/:id/accept", ...operatorGate, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const woQ = await client.query(
        "select id, property_id, status, title from work_orders where id=$1 and property_id=$2",
        [req.params.id, req.operator.property_id]);
      if (woQ.rows.length === 0) {
        await client.query("rollback");
        return res.status(404).json({ error: "not_found",
          receipt: { text: "That work order is not at the property you are operating." } });
      }
      const wo = woQ.rows[0];

      //  THE ORGANIZATION IS DERIVED FROM THE PROPERTY, server-side. The
      //  acceptance service requires it and must never be handed it by a
      //  browser; the property is already server-derived from the session,
      //  so the organization behind it is too.
      const orgQ = await client.query("select organization_id from properties where id=$1", [wo.property_id]);
      const organizationId = orgQ.rows[0] && orgQ.rows[0].organization_id;
      if (!organizationId) {
        await client.query("rollback");
        //  §5 — an honest refusal. A property with no organization cannot
        //  scope an acceptance, and guessing one would invent the boundary
        //  the whole check exists to enforce.
        return res.status(409).json({ error: "property_has_no_organization",
          receipt: { text: "This property is not attached to an organization, so work cannot be accepted here yet." } });
      }

      //  THE WORK ORDER'S OWN ACCOUNTABILITY OBLIGATION — never a routed
      //  follow-up, which is a different job with a different owner.
      const obQ = await client.query(
        `select id from obligations
          where related_type='work_order' and related_id=$1 and property_id=$2
            and not (type = any($3))
          order by created_at asc limit 1`,
        [wo.id, wo.property_id, FOLLOW_UP_TYPES]);
      if (obQ.rows.length === 0) {
        await client.query("rollback");
        return res.status(409).json({ error: "no_accountability_obligation",
          receipt: { text: "This work order has no accountability record yet, so there is nothing to take." } });
      }

      const out = await acceptWork(client, {
        obligation_id: obQ.rows[0].id,
        user_id: req.operator.id,
        organization_id: organizationId,
        channel: "operator_app",
      });

      if (out.outcome === "refused") {
        await client.query("rollback");
        return res.status(409).json({ error: out.refusal, receipt: { text: REFUSAL_COPY(out.refusal) } });
      }
      await client.query("commit");
      return res.status(out.outcome === "replayed" ? 200 : 201).json({
        work_order_id: wo.id,
        outcome: out.outcome,
        obligation: out.obligation,
        receipt: {
          text: out.outcome === "replayed"
            ? "You already have this job. Nothing changed."
            : "You have taken this job. Accepting is not completing — the work is still outstanding.",
        },
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      if (e.code === "BAD_INPUT" || e.code === "NOT_FOUND") {
        return res.status(400).json({ error: e.code, receipt: { text: e.message } });
      }
      console.error("operator work-order accept:", e.message);
      return res.status(503).json({ error: "unavailable",
        receipt: { text: "That could not be recorded. Nothing was changed. Retry." } });
    } finally {
      client.release();
    }
  });

  router.get("/operator/work-orders/:id/status", ...operatorGate, async (req, res) => {
    try {
      const status = await workOrderStatusRead.readWorkOrderStatus(pool, {
        propertyId: req.operator.property_id, workOrderId: req.params.id,
        viewerUserId: req.operator.id,
      });
      if (!status) return res.status(404).json({ error: "not_found" });
      res.json(status);
    } catch (e) {
      console.error("operator work-order status:", e.message);
      res.status(503).json({ error: "unavailable", detail: "The live work-order read is unavailable. Retry." });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  SUPPLY REQUESTS
  //  POST /supply-requests        — tech requests; category captured now
  //  GET  /supply-requests        — list (PM approval queue)
  //  PATCH /supply-requests/:id/status  — PM approves/orders/denies
  // ════════════════════════════════════════════════════════════════
  router.post("/supply-requests", async (req, res) => {
    const {
      property_id, unit_id, work_order_id, requested_by,
      item, quantity, reason,
      field_category, unit_state, cause, est_cost,
    } = req.body || {};
    if (!property_id) return res.status(400).json({ error: "property_id is required" });
    if (!item)        return res.status(400).json({ error: "item is required" });

    try {
      const prop = await pool.query("select id from properties where id=$1", [property_id]);
      if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });

      // Accounting category born at the moment of request.
      const derived = deriveCategories({ field_category, unit_state, cause });

      const r = await pool.query(
        `insert into supply_requests
           (property_id, unit_id, work_order_id, requested_by,
            item, quantity, reason,
            field_category, operating_category,
            est_cost, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested')
         returning *`,
        // gl_category is no longer derived or written here either — a supply
        // request authors money meaning no more than a work order does. Same
        // ruling (019: resolution at read, never stored); same column left in
        // place, unwritten, for step 5's single migration.
        [property_id, unit_id ?? null, work_order_id ?? null, requested_by ?? null,
         item, quantity ?? null, reason ?? null,
         field_category ?? null, derived.operating_category,
         est_cost ?? null]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/supply-requests", async (req, res) => {
    const { property_id, status } = req.query;
    try {
      const where = [];
      const vals = [];
      if (property_id) { vals.push(property_id); where.push(`property_id = $${vals.length}`); }
      if (status)      { vals.push(status);      where.push(`status = $${vals.length}`); }
      const sql = "select * from supply_requests" +
        (where.length ? " where " + where.join(" and ") : "") +
        " order by created_at desc";
      const r = await pool.query(sql, vals);
      res.json(r.rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manager approval. status ∈ requested | approved | ordered | received | denied
  const SUPPLY_STATUSES = ["requested", "approved", "ordered", "received", "denied"];
  router.patch("/supply-requests/:id/status", async (req, res) => {
    const { status, approved_by } = req.body || {};
    if (!SUPPLY_STATUSES.includes(status)) {
      return res.status(400).json({ error: "invalid status", allowed: SUPPLY_STATUSES });
    }
    try {
      const r = await pool.query(
        `update supply_requests
           set status=$2, approved_by=$3, updated_at=now()
         where id=$1 returning *`,
        [req.params.id, status, approved_by ?? null]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "supply request not found" });
      res.json(r.rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
