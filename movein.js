// ════════════════════════════════════════════════════════════════════
//  MOVE-IN READINESS MODULE — movein.js
//
//  The operating truth this captures: a tenant is scheduled to move in —
//  PROVE the unit is ready before they take possession. Not "move-in admin."
//  The big failure this prevents: tenant arrives, unit isn't ready.
//
//  THE FLOW:
//    1. POST /units/:id/schedule-move-in  → writes a unit_events row
//       (move_in_scheduled + date). NO obligation yet — a move-in 60 days out
//       should not clutter the obligation queue.
//    2. POST /unit-events/process-due     → finds scheduled move-ins inside the
//       readiness window (default 7 days) and spawns ONE obligation each.
//       Idempotent: flips the event to 'actioned' + records spawned_obligation_id
//       so it can never double-spawn. (No cron in this system — this is the
//       read-time trigger, same pattern as the delinquency check.)
//    3. The obligation is MAINTENANCE-owned (they do the readiness work),
//       escalates to property_manager. Required inputs:
//         readiness_checklist, appliances_checked, unit_condition_photos,
//         keys_access_ready   (the operational gates — maintenance proves them)
//         rent_ready_approval (the FINAL gate — the accountable PM approves)
//    4. POST /movein/:obligationId/satisfy  → maintenance clears an operational
//       gate via the SHARED satisfyObligation helper.
//    5. POST /movein/:obligationId/approve  → the accountable PM (or PM fallback)
//       gives rent_ready_approval. HARD RULE: refused until all 4 operational
//       gates are satisfied. You cannot approve a unit nobody prepared.
//    6. Completing the obligation flips unit occupancy → occupied (possession).
//
//  Maintenance prepares. Manager approves. That's the whole feature.
//
//  Mount in server.js (two lines):
//    const moveinModule = require("./movein");
//    app.use("/", moveinModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));
// ════════════════════════════════════════════════════════════════════

module.exports = function movein(deps) {
  const express = require("express");
  const router = express.Router();
  // Shared effective-possession writer (space_position.js). Effective, space_id-
  // anchored, idempotent. Optional so a partial deploy fails soft, not at boot.
  const recordEffectivePossession = deps && deps.recordEffectivePossession;

  const { pool, spawnObligationFromEvent, satisfyObligation, completeObligation, deliveryHelper = null } = deps;
  if (!pool) throw new Error("movein module requires a pool");

  // operational gates maintenance must prove, in order of a natural walk
  const OPERATIONAL_GATES = ["readiness_checklist", "appliances_checked", "unit_condition_photos", "keys_access_ready"];
  // the final human sign-off (accountable PM). Gated behind the operational ones.
  const APPROVAL_GATE = "rent_ready_approval";
  const ALL_INPUTS = [...OPERATIONAL_GATES, APPROVAL_GATE];

  // default: spawn the readiness obligation when a move-in is within N days.
  // 7 gives maintenance time to discover + fix issues. Tunable per call.
  const DEFAULT_WINDOW_DAYS = 7;

  // org-chart role → obligations role_name enum (same bridge turnover uses)
  function mapRole(orgRole) {
    const map = { property_manager:"property_manager", maintenance:"maintenance",
      leasing:"leasing_agent", bookkeeper:"accountant", asset_manager:"asset_manager", owner:"owner" };
    return map[orgRole] || "property_manager";
  }

  // resolve the accountable PM (for escalation + who may approve). Falls back
  // to property_manager role string if no accountable owner is set.
  async function resolveApprover(client, property_id) {
    const prop = await client.query("select accountable_assignment_id from properties where id=$1", [property_id]);
    const accId = prop.rows[0] ? prop.rows[0].accountable_assignment_id : null;
    if (accId) {
      const acc = await client.query("select role from assignments where id=$1 and is_active=true", [accId]);
      if (acc.rows.length) return mapRole(acc.rows[0].role);
    }
    return "property_manager";
  }

  // ════════════════════════════════════════════════════════════════
  //  SCHEDULE A MOVE-IN  —  POST /units/:id/schedule-move-in
  //  Body: { move_in_date (required), tenant_name?, lease_id?, rent? }
  //  Writes a unit_events row. NO obligation — that waits for the window.
  // ════════════════════════════════════════════════════════════════
  router.post("/units/:id/schedule-move-in", async (req, res) => {
    const unit_id = req.params.id;
    const { move_in_date, tenant_name = null, lease_id = null, rent = null } = req.body || {};
    if (!move_in_date) return res.status(400).json({ error: "move_in_date is required (YYYY-MM-DD)" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const uQ = await client.query("select id, property_id, unit_number from units where id=$1", [unit_id]);
      if (uQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "unit not found" }); }
      const unit = uQ.rows[0];

      // guard: don't stack two scheduled move-ins on the same unit
      const dup = await client.query(
        `select id from unit_events where unit_id=$1 and event_type='move_in_scheduled' and status='scheduled' limit 1`,
        [unit_id]
      );
      if (dup.rows.length) {
        await client.query("rollback");
        return res.status(409).json({ error: "this unit already has a scheduled move-in", unit_event_id: dup.rows[0].id });
      }

      const payload = {};
      if (tenant_name) payload.tenant_name = tenant_name;
      if (lease_id) payload.lease_id = lease_id;
      if (rent != null) payload.rent = rent;

      const ins = await client.query(
        `insert into unit_events (unit_id, property_id, event_type, effective_date, payload, source, status)
         values ($1,$2,'move_in_scheduled',$3,$4,'manual','scheduled') returning *`,
        [unit_id, unit.property_id, move_in_date, JSON.stringify(payload)]
      );

      await client.query("commit");
      res.status(201).json({
        unit_event: ins.rows[0],
        note: "Move-in scheduled. No obligation yet — it spawns when the date enters the readiness window (default 7 days). Run POST /unit-events/process-due to spawn due ones.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("schedule-move-in error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  PROCESS DUE EVENTS  —  POST /unit-events/process-due
  //  Body: { window_days?, property_id? }
  //  Finds scheduled move_in_scheduled events whose date is within window_days
  //  from now, spawns a maintenance-owned readiness obligation for each, flips
  //  the event to 'actioned' + records spawned_obligation_id. IDEMPOTENT:
  //  only 'scheduled' events are picked up; once actioned they're skipped.
  // ════════════════════════════════════════════════════════════════
  router.post("/unit-events/process-due", async (req, res) => {
    const window_days = Number.isFinite(Number(req.body?.window_days)) ? Number(req.body.window_days) : DEFAULT_WINDOW_DAYS;
    const property_id = req.body?.property_id || null;

    const client = await pool.connect();
    try {
      await client.query("begin");

      // due = scheduled move-ins whose effective_date is on/before (today + window)
      const vals = [window_days];
      let scope = "";
      if (property_id) { vals.push(property_id); scope = ` and ue.property_id = $${vals.length}`; }

      const due = await client.query(
        `select ue.*, u.unit_number, u.property_id as unit_property_id
           from unit_events ue
           join units u on u.id = ue.unit_id
          where ue.event_type='move_in_scheduled'
            and ue.status='scheduled'
            and ue.effective_date <= (current_date + ($1 || ' days')::interval)
            ${scope}
          for update of ue`,
        vals
      );

      const spawned = [];
      for (const ev of due.rows) {
        const approver = await resolveApprover(client, ev.property_id);

        const obligation = await spawnObligationFromEvent(client, {
          property_id: ev.property_id,
          unit_id: ev.unit_id,
          source_event_id: null,            // unit_events isn't the events table; link via related_id
          related_id: ev.id,
          related_type: "unit_event",
          module: "movein",
          type: "readiness",
          label: `Prepare unit for move-in${ev.unit_number ? " — " + ev.unit_number : ""}`,
          owner_type: "human",
          assigned_role: "maintenance",     // maintenance owns the physical readiness work
          escalates_to_role: approver,      // accountable PM (or PM fallback)
          status: "open",
          priority: "normal",               // planned work — not an emergency
          severity: "normal",
          due_at: ev.effective_date ? new Date(ev.effective_date) : null,
          required_inputs: ALL_INPUTS,
        });

        // flip the event to actioned + record the link (idempotency anchor)
        await client.query(
          `update unit_events set status='actioned', spawned_obligation_id=$1, updated_at=now() where id=$2`,
          [obligation.id, ev.id]
        );

        spawned.push({ unit_event_id: ev.id, unit_id: ev.unit_id, unit_number: ev.unit_number,
          move_in_date: ev.effective_date, obligation_id: obligation.id, assigned_role: "maintenance", approver_role: approver });
      }

      await client.query("commit");
      res.json({
        window_days,
        processed: spawned.length,
        spawned,
        note: spawned.length
          ? "Spawned move-in readiness obligations for due move-ins. Maintenance proves the operational gates; the accountable PM gives rent_ready_approval (gated behind them)."
          : "No move-ins due within the window. Far-future move-ins stay out of the obligation queue.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("process-due error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  SATISFY AN OPERATIONAL GATE  —  POST /movein/:obligationId/satisfy
  //  Body: { gate, proof? }   gate ∈ the 4 operational gates (NOT the approval)
  //  Maintenance clears readiness work via the SHARED satisfyObligation helper.
  // ════════════════════════════════════════════════════════════════
  router.post("/movein/:obligationId/satisfy", async (req, res) => {
    const obligation_id = req.params.obligationId;
    const { gate, proof = null } = req.body || {};
    if (!OPERATIONAL_GATES.includes(gate)) {
      return res.status(400).json({ error: "gate must be one of the operational gates", allowed: OPERATIONAL_GATES,
        note: "rent_ready_approval is given via POST /movein/:obligationId/approve, not here." });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      let note = null;
      try {
        await satisfyObligation(client, { obligation_id, input: gate, proof });
        note = `Operational gate "${gate}" satisfied.`;
      } catch (e) {
        if (e.code === "NOT_FOUND") { await client.query("rollback"); return res.status(404).json({ error: "obligation not found" }); }
        if (e.code === "NOT_OUTSTANDING") note = `"${gate}" was already satisfied.`;
        else throw e;
      }
      await client.query("commit");

      const o = await pool.query("select required_inputs from obligations where id=$1", [obligation_id]);
      const outstanding = o.rows[0] ? o.rows[0].required_inputs : [];
      const opsLeft = OPERATIONAL_GATES.filter(g => outstanding.includes(g));
      res.json({
        satisfied_gate: gate,
        note,
        operational_gates_outstanding: opsLeft,
        ready_for_approval: opsLeft.length === 0,
        approval_note: opsLeft.length === 0
          ? "All operational gates done. The accountable PM can now give rent_ready_approval."
          : `${opsLeft.length} operational gate(s) still outstanding before approval can be given.`,
      });
    } catch (e) {
      await client.query("rollback");
      console.error("movein satisfy error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  RENT-READY APPROVAL  —  POST /movein/:obligationId/approve
  //  Body: { approved_by_person_id (required), note? }
  //  The accountable PM's final sign-off. HARD RULE: refused (409) until all
  //  4 operational gates are satisfied — you cannot approve a unit nobody
  //  prepared. On approval: satisfies rent_ready_approval, completes the
  //  obligation (shared helper), flips unit occupancy → occupied.
  // ════════════════════════════════════════════════════════════════
  router.post("/movein/:obligationId/approve", async (req, res) => {
    const obligation_id = req.params.obligationId;
    const { approved_by_person_id, note: approvalNote = null } = req.body || {};
    if (!approved_by_person_id) {
      return res.status(400).json({ error: "approved_by_person_id required — a human must approve rent-ready" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const oQ = await client.query("select * from obligations where id=$1 for update", [obligation_id]);
      if (oQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "obligation not found" }); }
      const obligation = oQ.rows[0];
      const outstanding = obligation.required_inputs || [];

      // HARD GATE: every operational gate must be done before approval.
      const opsLeft = OPERATIONAL_GATES.filter(g => outstanding.includes(g));
      if (opsLeft.length > 0) {
        await client.query("rollback");
        return res.status(409).json({
          error: "cannot give rent-ready approval — operational readiness not complete",
          operational_gates_outstanding: opsLeft,
          hint: "maintenance must satisfy these first via POST /movein/:obligationId/satisfy",
        });
      }

      // satisfy the approval gate (shared helper), then complete
      try {
        await satisfyObligation(client, {
          obligation_id, input: APPROVAL_GATE,
          proof: { approved_by_person_id, note: approvalNote },
        });
      } catch (e) {
        if (e.code !== "NOT_OUTSTANDING") throw e; // already approved → fine, fall through to complete
      }

      let completedNote = null;
      try {
        await completeObligation(client, { obligation_id, completed_by: approved_by_person_id });
        completedNote = "Move-in readiness obligation COMPLETE — verified record that the unit was ready before possession.";
      } catch (e) {
        if (e.code === "ALREADY_COMPLETE") completedNote = "Obligation was already complete.";
        else if (e.code === "INPUTS_OUTSTANDING") {
          // shouldn't happen — we just satisfied the last input — but surface honestly
          await client.query("rollback");
          return res.status(409).json({ error: "unexpected outstanding inputs after approval", outstanding: e.outstanding_inputs });
        } else throw e;
      }

      // ── POSSESSION (locked order: effective event → compatibility cache) ──
      // 1) Record the EFFECTIVE move_in as a durable, space_id-anchored unit_event
      //    (the possession primitive). Resolve the lease from the scheduling event
      //    that spawned this obligation — the same link the delivery hook uses.
      //    No lease link (legacy/manual move-in) → no space-anchored possession
      //    event; we DO NOT guess a space. Honest-nothing beats a fabricated bed.
      // 2) units.occupancy_status is written ONLY as a COMPATIBILITY CACHE
      //    downstream of the event, so availability.js's verbatim read is
      //    unbroken during the migration. The event is the truth; the column
      //    is the cache. Idempotent: recordEffectivePossession no-ops if a live
      //    effective move_in already exists for (lease, space); the DB partial-
      //    unique index is the hard backstop for repeat/concurrent approval.
      let unitNote = null;
      let possessionNote = null;
      if (obligation.unit_id) {
        // resolve the committing lease from the spawning move_in_scheduled event
        let leaseForPossession = null;
        try {
          const lp = await client.query(
            `select coalesce(lease_id, (payload->>'lease_id')::uuid) as lease_id
               from unit_events
              where spawned_obligation_id = $1 and event_type = 'move_in_scheduled'
                and (lease_id is not null or (payload->>'lease_id') is not null)
              limit 1`, [obligation_id]);
          leaseForPossession = lp.rows[0] ? lp.rows[0].lease_id : null;
        } catch (e) { /* fall through to cache-only below */ }

        if (recordEffectivePossession && leaseForPossession) {
          // SAVEPOINT: the possession write must NEVER poison the approve
          // transaction. If it errors (schema/constraint/ambiguity), we roll
          // back to the savepoint, surface the reason, and let the approve
          // (obligation completion + compatibility cache) proceed. Honest-blank
          // on possession beats aborting a valid rent-ready approval.
          await client.query("savepoint sp_possession");
          try {
            const pr = await recordEffectivePossession(client, {
              kind: "move_in",
              lease_id: leaseForPossession,
              unit_id: obligation.unit_id,
              property_id: obligation.property_id || null,
              effective_date: new Date().toISOString().slice(0, 10),
              actor: approved_by_person_id,
              source: "rent_ready_approval",
            });
            await client.query("release savepoint sp_possession");
            possessionNote = pr.created
              ? "Effective move_in recorded (space-anchored possession)."
              : "Move_in already recorded — idempotent no-op.";
          } catch (e) {
            await client.query("rollback to savepoint sp_possession");
            possessionNote = "Possession event NOT recorded: " + e.message;
            console.error("possession event (surfaced, non-fatal):", e.message);
          }
        } else if (!leaseForPossession) {
          possessionNote = "No lease linked to this move-in — legacy/manual path; no space-anchored possession event.";
        }

        // compatibility cache (downstream of the event, not the source of truth)
        await client.query("update units set occupancy_status='occupied', updated_at=now() where id=$1", [obligation.unit_id]);
        unitNote = "Unit occupancy → occupied (compatibility cache; possession truth is the unit_event).";
      }

      // ── SLICE D — the ONE thin delivery hook (ruling #2, #3) ─────────
      // Resolve the lease through the move_in_scheduled event THAT SPAWNED
      // this readiness obligation (movein.js records spawned_obligation_id),
      // then feed unit_ready into the PM-owned move_in_delivery obligation via
      // the shared helper. NO-OP for legacy/manual move-ins with no lease link.
      // Does NOT mutate occupancy (that happened above, legacy, unchanged).
      let deliveryNote = null;
      if (deliveryHelper && typeof deliveryHelper.satisfyDeliveryInput === "function") {
        try {
          const linkQ = await client.query(
            `select coalesce(lease_id, (payload->>'lease_id')::uuid) as lease_id
               from unit_events
              where spawned_obligation_id = $1 and event_type = 'move_in_scheduled'
                and (lease_id is not null or (payload->>'lease_id') is not null)
              limit 1`, [obligation_id]);
          const leaseId = linkQ.rows[0] ? linkQ.rows[0].lease_id : null;
          if (leaseId) {
            const r = await deliveryHelper.satisfyDeliveryInput(client, {
              lease_id: leaseId, input_key: "unit_ready", source: "rent_ready_approval",
              source_obligation_id: obligation_id, actor: approved_by_person_id, timestamp: new Date().toISOString(),
            });
            if (r && r.satisfied) deliveryNote = "Delivery input unit_ready satisfied from readiness approval.";
            // if not satisfied (legacy / already satisfied / no delivery obligation) → silent, non-fatal
          }
        } catch (e) {
          // the delivery feed must NEVER break the readiness approval flow.
          console.error("delivery hook (non-fatal):", e.message);
        }
      }

      await client.query("commit");
      res.json({
        approved: true,
        approved_by_person_id,
        obligation_note: completedNote,
        unit_note: unitNote,
        possession_note: possessionNote,
        note: "Maintenance prepared, manager approved. The completed obligation is the verified record the unit was rent-ready before move-in.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("movein approve error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  BOARD  —  GET /move-ins   (?property_id=  ?window_days=)
  //  Upcoming scheduled move-ins + their readiness obligation state.
  // ════════════════════════════════════════════════════════════════
  router.get("/move-ins", async (req, res) => {
    const { property_id } = req.query;
    try {
      const vals = [];
      const where = ["ue.event_type='move_in_scheduled'"];
      if (property_id) { vals.push(property_id); where.push(`ue.property_id = $${vals.length}`); }

      const r = await pool.query(
        `select ue.*, u.unit_number,
                o.id as obligation_id, o.status as obligation_status,
                o.required_inputs as obligation_outstanding, o.assigned_role, o.escalates_to_role
           from unit_events ue
           join units u on u.id = ue.unit_id
           left join obligations o on o.id = ue.spawned_obligation_id
          where ${where.join(" and ")}
          order by ue.effective_date asc`,
        vals
      );

      const move_ins = r.rows.map(ue => {
        const outstanding = ue.obligation_outstanding || [];
        const opsLeft = OPERATIONAL_GATES.filter(g => outstanding.includes(g));
        return {
          unit_event_id: ue.id, unit_id: ue.unit_id, unit_number: ue.unit_number,
          property_id: ue.property_id, move_in_date: ue.effective_date,
          payload: ue.payload, event_status: ue.status,
          obligation_id: ue.obligation_id, obligation_status: ue.obligation_status,
          assigned_role: ue.assigned_role, escalates_to_role: ue.escalates_to_role,
          operational_gates_outstanding: opsLeft,
          awaiting_approval: ue.obligation_id && opsLeft.length === 0 && outstanding.includes(APPROVAL_GATE),
        };
      });

      res.json({
        count: move_ins.length,
        scheduled: move_ins.filter(m => m.event_status === "scheduled").length,
        in_readiness: move_ins.filter(m => m.event_status === "actioned" && m.obligation_status !== "complete").length,
        ready_complete: move_ins.filter(m => m.obligation_status === "complete").length,
        move_ins,
      });
    } catch (e) {
      console.error("move-ins board error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
