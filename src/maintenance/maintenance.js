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
  const NOT_DONE_REASONS = {
    need_part: {
      label: "Waiting on a part",
      follow_type: "supply_followup",
      follow_role: "maintenance",
      escalates_to: "property_manager",
      follow_label: (wo) => `Part needed to finish: ${wo.title || "work order"} — order / track the part`,
    },
    need_vendor: {
      label: "Needs an outside vendor",
      follow_type: "vendor_quote",
      follow_role: "property_manager",
      escalates_to: "owner",
      follow_label: (wo) => `Outside vendor needed for: ${wo.title || "work order"} — get quote / schedule`,
    },
    no_access: {
      label: "Couldn't get access to the unit",
      follow_type: "reschedule_access",
      follow_role: "maintenance",
      escalates_to: "property_manager",
      follow_label: (wo) => `No access — reschedule a return visit for: ${wo.title || "work order"}`,
    },
    needs_approval: {
      label: "Needs PM approval to proceed",
      follow_type: "approval_followup",
      follow_role: "property_manager",
      escalates_to: "owner",
      follow_label: (wo) => `Approval needed before finishing: ${wo.title || "work order"}`,
    },
    bigger_job: {
      label: "Bigger job than expected",
      follow_type: "scope_review",
      follow_role: "property_manager",
      escalates_to: "owner",
      follow_label: (wo) => `Re-scope — larger than expected: ${wo.title || "work order"}`,
    },
    second_visit: {
      label: "Partly done — needs a second visit",
      follow_type: "return_visit",
      follow_role: "maintenance",
      escalates_to: "property_manager",
      follow_label: (wo) => `Return visit to finish: ${wo.title || "work order"}`,
    },
    other: {
      label: "Other (PM to review)",
      follow_type: "not_done_followup",
      follow_role: "property_manager",
      escalates_to: "owner",
      follow_label: (wo) => `Stalled — PM to review: ${wo.title || "work order"}`,
    },
  };

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
    res.json(
      Object.entries(NOT_DONE_REASONS).map(([key, v]) => ({ key, label: v.label }))
    );
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
        // Reason must be one we know. Default to 'other' only if none given,
        // so an old/blank caller still routes somewhere real (PM review) rather
        // than vanishing. A WRONG reason is rejected — never silently coerced.
        const reasonKey = not_done_reason || "other";
        const route = NOT_DONE_REASONS[reasonKey];
        if (!route) {
          await client.query("rollback");
          return res.status(400).json({
            error: "invalid not_done_reason",
            allowed: Object.keys(NOT_DONE_REASONS),
          });
        }

        // 1) Durable event — the obligation is born only from an event.
        const followNote = {
          work_order_id: wo.id,
          kind: "not_done",
          reason: reasonKey,
          reason_label: route.label,
          routes_to: route.follow_type,
          owner_role: route.follow_role,
          note: completion_note || null,   // optional tech context, kept separate
        };
        const ev = await client.query(
          `insert into events (property_id, person_id, unit_id, type, note)
           values ($1,$2,$3,'maintenance_followup',$4) returning *`,
          [wo.property_id, wo.affected_person_id ?? wo.reported_by_person_id ?? null, wo.unit_id ?? null, JSON.stringify(followNote)]
        );

        // 2) The WO stays OPEN, flagged for review, with the structured reason
        //    in its OWN column. completion_note now means only "completion note"
        //    — we no longer overwrite it with the stall reason.
        await client.query(
          `update work_orders
             set status='needs_followup', needs_pm_review=true,
                 not_done_reason=$2, updated_at=now()
           where id=$1`,
          [wo.id, reasonKey]
        );

        // 3) The ROUTED follow-up obligation — through the shared engine, in
        //    THIS transaction. related_id/related_type link it back to the WO
        //    so the next owner inherits full context. This is the named next
        //    step: who owns it, where it escalates, what it's for.
        const followup = await spawnObligationFromEvent(client, {
          property_id: wo.property_id,
          person_id: wo.affected_person_id ?? wo.reported_by_person_id ?? null,
          unit_id: wo.unit_id ?? null,
          source_event_id: ev.rows[0].id,
          module: "maintenance",
          type: route.follow_type,
          label: route.follow_label(wo),
          owner_type: "human",
          assigned_role: route.follow_role,
          escalates_to_role: route.escalates_to,
          status: "open",
          priority: "normal",
          severity: "normal",
          related_id: wo.id,
          related_type: "work_order",
        });

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

  router.get("/operator/work-orders/:id/status", ...operatorGate, async (req, res) => {
    try {
      const status = await workOrderStatusRead.readWorkOrderStatus(pool, {
        propertyId: req.operator.property_id, workOrderId: req.params.id,
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
