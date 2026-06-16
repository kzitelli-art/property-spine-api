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
//  THE THREE-LAYER CATEGORY ENGINE
//    Layer 1 field_category     — what the tech taps  (plumbing, paint…)
//    Layer 2 operating_category — what the PM sees     (repair/turn/billback/capex)
//    Layer 3 gl_category        — what accounting sees (derived)
//  Context (unit_state, cause) is what lets the SAME field action map
//  differently. Simple at the edge, precise at the center.
// ════════════════════════════════════════════════════════════════════

module.exports = function maintenance(deps) {
  const express = require("express");
  const router = express.Router();

  // ── injected core services (option 1: dependency injection) ──
  const { pool, spawnObligationFromEvent } = deps;
  if (!pool) throw new Error("maintenance module requires a pool");
  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("maintenance module requires spawnObligationFromEvent()");
  }

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
  // Pure function. Same input always gives same output. The tech sets
  // field_category + simple context; the server derives the rest. This is
  // captured at the moment work happens — accounting never reconstructs.
  function deriveCategories({ field_category, unit_state, cause, is_emergency }) {
    const fc = (field_category || "general").toLowerCase();

    // Operating category — what the PM sees.
    let operating_category;
    if (cause === "tenant_damage") {
      operating_category = "tenant_billback";
    } else if (unit_state === "renovation") {
      operating_category = "capital";
    } else if (unit_state === "vacant") {
      operating_category = "turn";
    } else {
      operating_category = "resident_repair";   // occupied / default
    }

    // GL category — what accounting sees. Field action + operating context.
    let gl_category;
    if (operating_category === "capital") {
      gl_category = `capex_${fc}`;
    } else if (operating_category === "tenant_billback") {
      gl_category = `tenant_billback_${fc}`;
    } else if (operating_category === "turn") {
      gl_category = `turn_${fc}`;
    } else {
      gl_category = `${fc}_repairs`;
    }

    const is_capex = operating_category === "capital";
    const billback = operating_category === "tenant_billback";

    return { operating_category, gl_category, is_capex, billback };
  }

  // ════════════════════════════════════════════════════════════════
  //  PREVIEW CATEGORY  —  GET /maintenance/preview-category
  //  Lets the UI show how a work item will be categorized before saving.
  // ════════════════════════════════════════════════════════════════
  router.get("/maintenance/preview-category", (req, res) => {
    const { field_category, unit_state, cause } = req.query;
    const derived = deriveCategories({ field_category, unit_state, cause });
    res.json({ input: { field_category, unit_state, cause }, derived });
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
  //    unit_id?      (optional — null = common area / property-level),
  //    person_id?    (optional — tenant/staff/anyone; null = unattributed),
  //    title, description?,
  //    field_category?, unit_state?, cause?, est_cost?,
  //    assigned_to?,
  //    is_emergency? (bool), emergency_type? (key from EMERGENCY_TYPES)
  //  }
  //
  //  A normal work order just records. An EMERGENCY work order writes a
  //  maintenance EVENT and spawns an OBLIGATION from it (same atomic path
  //  the rest of the engine uses) — obligation born only from an event.
  // ════════════════════════════════════════════════════════════════
  router.post("/work-orders", async (req, res) => {
    const {
      property_id, unit_id, person_id,
      title, description,
      field_category, unit_state, cause, est_cost,
      assigned_to,
      is_emergency, emergency_type,
    } = req.body || {};

    if (!property_id) return res.status(400).json({ error: "property_id is required" });
    if (!title)       return res.status(400).json({ error: "title is required" });

    // If flagged emergency, the type must be one we know (or manager_override).
    let emDef = null;
    if (is_emergency) {
      emDef = EMERGENCY_TYPES[emergency_type];
      if (!emDef) {
        return res.status(400).json({
          error: "emergency_type required for emergency work order",
          allowed: Object.keys(EMERGENCY_TYPES),
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      // Validate references (clear errors, same style as /events).
      const prop = await client.query("select id from properties where id=$1", [property_id]);
      if (prop.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "property not found" }); }
      if (unit_id) {
        const u = await client.query("select id from units where id=$1", [unit_id]);
        if (u.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "unit not found" }); }
      }
      if (person_id) {
        const p = await client.query("select id from persons where id=$1", [person_id]);
        if (p.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "person not found" }); }
      }

      // Derive the three-layer categories at the moment of capture.
      const derived = deriveCategories({ field_category, unit_state, cause, is_emergency });

      // Insert the work order against the REAL table shape.
      const wo = await client.query(
        `insert into work_orders
           (property_id, unit_id, person_id, title, description,
            status, assigned_to, source,
            field_category, operating_category, gl_category,
            unit_state, cause, is_emergency, is_capex, billback, est_cost,
            needs_pm_review)
         values ($1,$2,$3,$4,$5,
                 'open',$6,$7,
                 $8,$9,$10,
                 $11,$12,$13,$14,$15,$16,
                 $17)
         returning *`,
        [
          property_id, unit_id ?? null, person_id ?? null, title, description ?? null,
          assigned_to ?? null, "maintenance_module",
          field_category ?? null, derived.operating_category, derived.gl_category,
          unit_state ?? null, cause ?? null, !!is_emergency, derived.is_capex, derived.billback, est_cost ?? null,
          // emergency items default to needing next-morning PM review
          !!is_emergency,
        ]
      );
      const workOrder = wo.rows[0];

      // ── THE ENGINE LINK (emergency only) ──────────────────────────
      let obligation = null;
      let event = null;
      if (is_emergency) {
        const dueAt = urgencyToDueAt(emDef.urgency);
        const priority = urgencyToPriority(emDef.urgency);

        // 1) write the maintenance EVENT (the trigger surface).
        //    note carries the escalation chain + WO link so the manager's
        //    next-morning review has the full trail.
        const noteObj = {
          work_order_id: workOrder.id,
          emergency_type: emergency_type,
          emergency_label: emDef.label,
          urgency: emDef.urgency,
          escalation_chain: EMERGENCY_CHAIN,
          assigned_to: assigned_to ?? "on_call_maintenance",
        };
        const ev = await client.query(
          `insert into events (property_id, person_id, unit_id, type, note)
           values ($1,$2,$3,'emergency_work_order',$4) returning *`,
          [property_id, person_id ?? null, unit_id ?? null, JSON.stringify(noteObj)]
        );
        event = ev.rows[0];

        // 2) spawn the OBLIGATION from that event — using the SHARED helper
        //    injected from server.js. We do NOT write the insert ourselves.
        //    First owner = on-call maintenance; escalates_to = property_manager.
        //    required_inputs forces the closeout proof gate.
        obligation = await spawnObligationFromEvent(client, {
          property_id,
          person_id: person_id ?? null,
          unit_id: unit_id ?? null,
          source_event_id: event.id,
          module: "maintenance",
          type: "emergency_repair",
          label: `EMERGENCY: ${emDef.label} — needs on-call to own it`,
          owner_type: "human",
          assigned_role: "maintenance",
          escalates_to_role: "property_manager",
          status: "open",
          due_at: dueAt,
          priority,
          severity: "emergency",
          required_inputs: ["closeout_proof"],
        });
      }

      await client.query("commit");
      res.status(201).json({ work_order: workOrder, event, obligation });
    } catch (e) {
      await client.query("rollback");
      res.status(500).json({ error: e.message });
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
          [wo.property_id, wo.person_id ?? null, wo.unit_id ?? null, JSON.stringify(followNote)]
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
          person_id: wo.person_id ?? null,
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
        [wo.property_id, wo.person_id ?? null, wo.unit_id ?? null,
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
            field_category, operating_category, gl_category,
            est_cost, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested')
         returning *`,
        [property_id, unit_id ?? null, work_order_id ?? null, requested_by ?? null,
         item, quantity ?? null, reason ?? null,
         field_category ?? null, derived.operating_category, derived.gl_category,
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
