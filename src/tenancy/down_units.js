// ════════════════════════════════════════════════════════════════════
//  DOWN UNITS MODULE  —  down_units.js
//
//  A TURN is normal make-ready (clean/paint/trash-out/touch-up/lock/punch).
//  A DOWN UNIT is blocked by a specific unresolved issue that prevents
//  leasing, showing, move-in, occupancy, or rent-ready delivery.
//  Clean/paint/punch alone is NOT down. Down is a deliberate human flag.
//
//  Same pattern as maintenance.js: server.js owns the pool and the single
//  obligation-creation path; this module receives them by injection and
//  never duplicates that core logic.
//
//  Mount in server.js:
//      const downUnits = require("./down_units");
//      app.use("/", downUnits({ pool, spawnObligationFromEvent }));
// ════════════════════════════════════════════════════════════════════

module.exports = function downUnits(deps) {
  const express = require("express");
  const router = express.Router();

  const { pool, spawnObligationFromEvent } = deps;
  if (!pool) throw new Error("down_units module requires a pool");
  // spawnObligationFromEvent is OPTIONAL — if absent, we still mark the unit
  // down (the flag is the source of truth); we just skip the obligation.
  const canSpawnObligation = typeof spawnObligationFromEvent === "function";

  // Fixed allowed down reasons for v1.
  const DOWN_REASONS = [
    "hvac",
    "plumbing",
    "electrical",
    "window_door_security",
    "appliance",
    "water_fire_damage",
    "pest_mold_environmental",
    "inspection_co_legal",
    "access_possession",
    "vendor_parts_delay",
    "capital_repair",
    "other_needs_review",
  ];

  // Human labels for clean UI display (computed server-side).
  const DOWN_REASON_LABELS = {
    hvac: "HVAC",
    plumbing: "Plumbing",
    electrical: "Electrical",
    window_door_security: "Window / Door / Security",
    appliance: "Appliance",
    water_fire_damage: "Water / Fire Damage",
    pest_mold_environmental: "Pest / Mold / Environmental",
    inspection_co_legal: "Inspection / CO / Legal",
    access_possession: "Access / Possession",
    vendor_parts_delay: "Vendor / Parts Delay",
    capital_repair: "Capital Repair",
    other_needs_review: "Other / Needs Review",
  };

  router.get("/down-units/reasons", (_req, res) => res.json(DOWN_REASONS));

  // ════════════════════════════════════════════════════════════════
  //  MARK A UNIT DOWN  —  POST /units/:id/down
  //
  //  Required: down_reason, down_blocker
  //  Optional: down_target_resolution_at, down_related_work_order_id
  //  property_id is resolved from the unit (the unit knows its property).
  //
  //  Writes a unit_marked_down EVENT, then spawns a down_unit_resolution
  //  OBLIGATION from it through the shared path (if available).
  // ════════════════════════════════════════════════════════════════
  router.post("/units/:id/down", async (req, res) => {
    const unit_id = req.params.id;
    const { down_reason, down_blocker, down_target_resolution_at, down_related_work_order_id } = req.body || {};

    if (!down_reason)  return res.status(400).json({ error: "down_reason is required", allowed: DOWN_REASONS });
    if (!down_blocker) return res.status(400).json({ error: "down_blocker is required" });
    if (!DOWN_REASONS.includes(down_reason)) {
      return res.status(400).json({ error: "invalid down_reason", allowed: DOWN_REASONS });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const uQ = await client.query("select id, property_id, unit_number, is_down from units where id=$1 for update", [unit_id]);
      if (uQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "unit not found" }); }
      const unit = uQ.rows[0];

      if (down_related_work_order_id) {
        const w = await client.query("select id from work_orders where id=$1", [down_related_work_order_id]);
        if (w.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "related work order not found" }); }
      }

      // Set the down flag. down_started_at only set if not already down.
      await client.query(
        `update units
           set is_down = true,
               down_reason = $2,
               down_blocker = $3,
               down_started_at = coalesce(down_started_at, now()),
               down_target_resolution_at = $4,
               down_related_work_order_id = $5,
               down_resolved_at = null,
               updated_at = now()
         where id = $1`,
        [unit_id, down_reason, down_blocker, down_target_resolution_at ?? null, down_related_work_order_id ?? null]
      );

      // Event first (obligation born only from an event).
      const noteObj = { unit_id, down_reason, down_blocker, down_related_work_order_id: down_related_work_order_id ?? null };
      const ev = await client.query(
        `insert into events (property_id, unit_id, type, note)
         values ($1,$2,'unit_marked_down',$3) returning *`,
        [unit.property_id, unit_id, JSON.stringify(noteObj)]
      );
      const event = ev.rows[0];

      // Obligation through the shared path (if injected).
      let obligation = null;
      if (canSpawnObligation) {
        obligation = await spawnObligationFromEvent(client, {
          property_id: unit.property_id,
          unit_id,
          source_event_id: event.id,
          related_id: down_related_work_order_id ?? null,
          related_type: down_related_work_order_id ? "work_order" : null,
          module: "maintenance",
          type: "down_unit_resolution",
          label: `Down unit ${unit.unit_number || ""}: ${down_reason} — ${down_blocker}`.trim(),
          owner_type: "human",
          assigned_role: "maintenance",
          escalates_to_role: "property_manager",
          status: "open",
          due_at: down_target_resolution_at ?? null,
          priority: "high",
          severity: "normal",
          required_inputs: ["resolution_note"],
        });
      }

      await client.query("commit");
      const updated = await pool.query("select * from units where id=$1", [unit_id]);
      res.status(201).json({ unit: updated.rows[0], event, obligation });
    } catch (e) {
      await client.query("rollback");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  RESOLVE A DOWN UNIT  —  PATCH /units/:id/down/resolve
  //
  //  Required: resolution_note
  //  Clears is_down, stamps down_resolved_at, keeps history intact.
  //  Does NOT mark the unit rent-ready — that's a separate decision.
  // ════════════════════════════════════════════════════════════════
  router.patch("/units/:id/down/resolve", async (req, res) => {
    const unit_id = req.params.id;
    const { resolution_note } = req.body || {};
    if (!resolution_note) return res.status(400).json({ error: "resolution_note is required" });

    const client = await pool.connect();
    try {
      await client.query("begin");

      const uQ = await client.query("select id, property_id, unit_number, is_down from units where id=$1 for update", [unit_id]);
      if (uQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "unit not found" }); }
      const unit = uQ.rows[0];
      if (!unit.is_down) { await client.query("rollback"); return res.status(409).json({ error: "unit is not down" }); }

      // Clear the flag; keep reason/blocker/started_at as history.
      await client.query(
        `update units set is_down = false, down_resolved_at = now(), updated_at = now() where id=$1`,
        [unit_id]
      );

      // History event.
      await client.query(
        `insert into events (property_id, unit_id, type, note)
         values ($1,$2,'unit_down_resolved',$3)`,
        [unit.property_id, unit_id, JSON.stringify({ unit_id, resolution_note })]
      );

      // Close the active down-unit obligation, if one exists.
      // This keeps the spine consistent: resolved unit = completed obligation.
      const obQ = await client.query(
        `select id, required_inputs
           from obligations
          where unit_id = $1
            and module = 'maintenance'
            and type = 'down_unit_resolution'
            and status in ('open','in_progress')
          order by created_at desc
          limit 1
          for update`,
        [unit_id]
      );
      let obligation = null;
      if (obQ.rows.length) {
        const ob = obQ.rows[0];
        await client.query(
          `insert into events (property_id, unit_id, type, note)
           values ($1,$2,'input_satisfied:resolution_note',$3)`,
          [unit.property_id, unit_id, `resolution_note provided: ${resolution_note}`]
        );
        const done = await client.query(
          `update obligations
              set required_inputs = '{}'::text[],
                  status = 'complete',
                  completed_at = now(),
                  updated_at = now()
            where id = $1
            returning *`,
          [ob.id]
        );
        obligation = done.rows[0];
        await client.query(
          `insert into events (property_id, unit_id, type, note)
           values ($1,$2,'obligation_completed',$3)`,
          [unit.property_id, unit_id, 'down_unit_resolution obligation completed']
        );
      }

      await client.query("commit");
      const updated = await pool.query("select * from units where id=$1", [unit_id]);
      res.status(200).json({
        unit: updated.rows[0],
        obligation,
        resolved: true,
        note: "Down flag cleared. Unit is NOT automatically rent-ready — that's a separate step.",
      });
    } catch (e) {
      await client.query("rollback");
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  DASHBOARD  —  GET /maintenance/down-units
  //  ?property_id= (optional filter)
  //
  //  Enriched read: joins properties for the name, and left-joins the most
  //  recent open/in-progress down_unit_resolution obligation for the unit so
  //  the screen shows the full operating chain (owner, clock, escalation,
  //  priority, severity). Read-only — no write-path change.
  // ════════════════════════════════════════════════════════════════
  router.get("/maintenance/down-units", async (req, res) => {
    const { property_id } = req.query;
    try {
      const vals = [];
      let unitWhere = "u.is_down = true";
      if (property_id) { vals.push(property_id); unitWhere += ` and u.property_id = $${vals.length}`; }

      // The obligation join: lateral-pick the most recent still-active
      // down_unit_resolution obligation for each down unit.
      const r = await pool.query(
        `select
            u.id              as unit_id,
            u.property_id     as property_id,
            p.name            as property_name,
            u.unit_number     as unit_label,
            u.down_reason     as down_reason,
            u.down_blocker    as down_blocker,
            u.down_started_at as down_started_at,
            u.down_target_resolution_at as down_target_resolution_at,
            u.down_related_work_order_id as down_related_work_order_id,
            o.id              as obligation_id,
            o.status          as obligation_status,
            o.assigned_role   as assigned_role,
            o.escalates_to_role as escalates_to_role,
            o.assigned_user_id  as assigned_user_id,
            o.priority        as priority,
            o.severity        as severity
         from units u
         join properties p on p.id = u.property_id
         left join lateral (
            select ob.* from obligations ob
             where ob.unit_id = u.id
               and ob.type = 'down_unit_resolution'
               and ob.status in ('open','in_progress')
             order by ob.created_at desc
             limit 1
         ) o on true
         where ${unitWhere}
         order by u.down_started_at asc nulls last`,
        vals
      );

      const now = Date.now();
      const daysDown = (started) =>
        started ? Math.floor((now - new Date(started).getTime()) / (24 * 60 * 60 * 1000)) : null;

      const down_units = r.rows.map(u => {
        const days_down = daysDown(u.down_started_at);
        return {
          property_id: u.property_id,
          property_name: u.property_name,
          unit_id: u.unit_id,
          unit_label: u.unit_label,
          down_reason: u.down_reason,
          down_reason_label: DOWN_REASON_LABELS[u.down_reason] || "Needs Review",
          down_blocker: u.down_blocker,
          days_down,
          down_started_at: u.down_started_at,
          down_target_resolution_at: u.down_target_resolution_at,
          down_related_work_order_id: u.down_related_work_order_id,
          obligation_id: u.obligation_id,
          obligation_status: u.obligation_status,
          assigned_role: u.assigned_role,
          escalates_to_role: u.escalates_to_role,
          assigned_user_id: u.assigned_user_id,
          priority: u.priority,
          severity: u.severity,
          has_target_date: !!u.down_target_resolution_at,
          has_related_work_order: !!u.down_related_work_order_id,
        };
      });

      const oldest = down_units.reduce((m, u) => Math.max(m, u.days_down ?? 0), 0);

      res.json({
        down_units_count: down_units.length,
        oldest_down_unit_days: oldest,
        goal: 0,
        down_units,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
