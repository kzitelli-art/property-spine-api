// ════════════════════════════════════════════════════════════════════
//  TURNOVERS MODULE — turnovers.js
//
//  Brings the `turnovers` table to life. A TURNOVER is the operating record
//  of a unit changing hands: a tenant moves out, the unit needs work, then
//  it's ready to lease again. This module owns that lifecycle.
//
//  THE SPLIT (locked principle): the OBLIGATION is the proof gate; the
//  TURNOVER is the operating record. Move-out spawns ONE obligation with two
//  required inputs — moveout_photos and deposit_review — and the turnover row
//  carries the same two as booleans. Satisfying a gate updates BOTH in one
//  transaction, so they never drift.
//
//  Uses the SHARED obligation lifecycle from server.js — spawn, satisfy,
//  complete — injected the same way money.js gets them. This module does NOT
//  re-implement obligation logic (unlike the older down_units.js).
//
//  Mount in server.js (two lines):
//    const turnoversModule = require("./turnovers");
//    app.use("/", turnoversModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));
// ════════════════════════════════════════════════════════════════════

module.exports = function turnovers(deps) {
  const express = require("express");
  const { rankTurnPriority } = require("./turn_priority"); // ONE ranking source (shared w/ operator route)
  const router = express.Router();

  const { pool, satisfyObligation, completeObligation, turnoverService } = deps;
  if (!pool) throw new Error("turnovers module requires a pool");
  if (!turnoverService || typeof turnoverService.openTurnover !== "function") {
    throw new Error("turnovers module requires the canonical turnoverService");
  }
  const GATES = turnoverService.GATES;

  // ════════════════════════════════════════════════════════════════
  //  MOVE-OUT  —  POST /units/:id/move-out
  //
  //  Creates the turnover (operating record) + spawns ONE move-out obligation
  //  (proof gate, required inputs = the two gates) + flips unit occupancy to
  //  vacant. All in one transaction.
  //
  //  Body (all optional):
  //    outgoing_lease_id   — the lease that's ending
  //    needs               — array of what the turn requires (e.g. ['paint','clean'])
  //    expected_ready_date — date the turn is targeted to be done
  // ════════════════════════════════════════════════════════════════
  router.post("/units/:id/move-out", async (req, res) => {
    const { outgoing_lease_id = null, needs = [], expected_ready_date = null } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await turnoverService.openTurnover(client, {
        unit_id: req.params.id,
        outgoing_lease_id,
        needs,
        expected_ready_date,
        actor_user_id: null,
      });
      await client.query("commit");
      res.status(201).json(out);
    } catch (e) {
      await client.query("rollback");
      console.error("move-out error", e);
      res.status(e.httpStatus || 500).json({
        error: e.message,
        code: e.code || null,
        turnover_id: e.turnover_id || null,
      });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  SATISFY A GATE  —  POST /turnovers/:id/satisfy
  //
  //  Body: { gate, proof?, satisfied_by? }   gate ∈ moveout_photos|deposit_review
  //
  //  Satisfies the obligation's required input via the SHARED helper AND flips
  //  the matching boolean on the turnover row — in ONE transaction, so the
  //  proof gate and the operating record never drift.
  // ════════════════════════════════════════════════════════════════
  router.post("/turnovers/:id/satisfy", async (req, res) => {
    const turnover_id = req.params.id;
    const { gate, proof = null } = req.body || {};
    if (!GATES.includes(gate)) {
      return res.status(400).json({ error: "gate must be one of", allowed: GATES });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const tQ = await client.query("select * from turnovers where id=$1 for update", [turnover_id]);
      if (tQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "turnover not found" }); }
      const turnover = tQ.rows[0];

      // find the open move-out obligation for this turnover (related_id link)
      const oQ = await client.query(
        `select id, required_inputs from obligations
          where module='turnover' and type='move_out' and related_id=$1
            and status in ('open','in_progress')
          order by created_at desc limit 1`,
        [turnover_id]
      );

      // satisfy the obligation input through the SHARED helper (idempotent)
      let obligationNote = null;
      if (oQ.rows.length && typeof satisfyObligation === "function") {
        try {
          await satisfyObligation(client, { obligation_id: oQ.rows[0].id, input: gate, proof });
          obligationNote = `Obligation input "${gate}" satisfied.`;
        } catch (e) {
          if (e.code === "NOT_OUTSTANDING") obligationNote = `"${gate}" was already satisfied.`;
          else throw e;
        }
      }

      // flip the matching boolean on the turnover (operating record)
      const col = gate; // moveout_photos | deposit_review — column names match the gates
      await client.query(
        `update turnovers set ${col}=true, updated_at=now() where id=$1`,
        [turnover_id]
      );

      await client.query("commit");
      const updated = await pool.query("select * from turnovers where id=$1", [turnover_id]);
      res.json({
        turnover: updated.rows[0],
        satisfied_gate: gate,
        obligation_note: obligationNote,
        both_gates_done: updated.rows[0].moveout_photos && updated.rows[0].deposit_review,
        note: "Gate satisfied on both the obligation and the turnover record. When both gates are done, POST /turnovers/:id/ready to complete the turn.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("turnover satisfy error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  MARK READY  —  POST /turnovers/:id/ready
  //
  //  Body: { ready_date?, completed_by? }
  //
  //  Completes the move-out obligation via the SHARED helper (which enforces
  //  the proof gate — refuses if a required input is still outstanding), then
  //  sets turnover status='ready' + ready_date. The unit returns to rentable.
  // ════════════════════════════════════════════════════════════════
  router.post("/turnovers/:id/ready", async (req, res) => {
    const turnover_id = req.params.id;
    const { ready_date = null, completed_by = null } = req.body || {};

    const client = await pool.connect();
    try {
      await client.query("begin");

      const tQ = await client.query("select * from turnovers where id=$1 for update", [turnover_id]);
      if (tQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "turnover not found" }); }
      const turnover = tQ.rows[0];

      if (turnover.status === "ready") {
        await client.query("rollback");
        return res.status(409).json({ error: "turnover is already ready" });
      }

      // find + complete the obligation through the SHARED helper. The helper
      // enforces the proof gate: if moveout_photos/deposit_review are still
      // outstanding, it throws INPUTS_OUTSTANDING and we refuse — you can't
      // mark a turn ready with proof still owed.
      const oQ = await client.query(
        `select id from obligations
          where module='turnover' and type='move_out' and related_id=$1
            and status in ('open','in_progress')
          order by created_at desc limit 1`,
        [turnover_id]
      );
      let obligationNote = null;
      if (oQ.rows.length && typeof completeObligation === "function") {
        try {
          await completeObligation(client, { obligation_id: oQ.rows[0].id, completed_by });
          obligationNote = "Move-out obligation completed.";
        } catch (e) {
          if (e.code === "INPUTS_OUTSTANDING") {
            await client.query("rollback");
            return res.status(409).json({
              error: "cannot mark ready — move-out proof still outstanding",
              outstanding: e.outstanding_inputs,
              hint: "satisfy both gates first: POST /turnovers/:id/satisfy with moveout_photos and deposit_review",
            });
          }
          if (e.code !== "ALREADY_COMPLETE") throw e;
          obligationNote = "Obligation was already complete.";
        }
      }

      // set the turnover ready + ready_date
      const finalReady = ready_date || new Date().toISOString().slice(0, 10);
      const upd = await client.query(
        `update turnovers set status='ready', ready_date=$2, updated_at=now() where id=$1 returning *`,
        [turnover_id, finalReady]
      );

      // unit is rentable again: occupancy stays vacant (no one's moved in yet),
      // but if it was flagged down for turn work, that's resolved separately via
      // the down-units flow — we do NOT auto-clear is_down here (different axis).
      // Occupancy remains 'vacant' and ready to lease.
      let unitNote = "Unit remains vacant and is now turn-ready to lease.";
      if (turnover.unit_id) {
        const u = await client.query("select is_down from units where id=$1", [turnover.unit_id]);
        if (u.rows.length && u.rows[0].is_down) {
          unitNote = "Turn marked ready, but unit is still flagged DOWN — resolve the down-unit obligation separately before it's truly rentable.";
        }
      }

      await client.query("commit");
      res.json({
        turnover: upd.rows[0],
        obligation_note: obligationNote,
        unit_note: unitNote,
        note: "Turn complete. Operating record marked ready; the move-out obligation is closed via the shared proof gate.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("turnover ready error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  DASHBOARD  —  GET /turnovers   (?property_id=  ?status=)
  //  The turn board: what's in progress, what's ready, with the obligation
  //  + gate state folded in.
  // ════════════════════════════════════════════════════════════════
  router.get("/turnovers", async (req, res) => {
    const { property_id, status } = req.query;
    try {
      const vals = [];
      const where = [];
      if (property_id) { vals.push(property_id); where.push(`t.property_id = $${vals.length}`); }
      if (status)      { vals.push(status);      where.push(`t.status = $${vals.length}`); }
      const whereSql = where.length ? "where " + where.join(" and ") : "";

      const r = await pool.query(
        `select
            t.*,
            p.name as property_name,
            u.unit_number as unit_label,
            o.id as obligation_id,
            o.status as obligation_status,
            o.assigned_role,
            o.required_inputs as obligation_outstanding
         from turnovers t
         join properties p on p.id = t.property_id
         left join units u on u.id = t.unit_id
         left join lateral (
            select ob.* from obligations ob
             where ob.module='turnover' and ob.type='move_out' and ob.related_id = t.id
             order by ob.created_at desc limit 1
         ) o on true
         ${whereSql}
         order by t.created_at desc`,
        vals
      );

      const turnovers = r.rows.map(t => ({
        turnover_id: t.id,
        property_id: t.property_id,
        property_name: t.property_name,
        unit_id: t.unit_id,
        unit_label: t.unit_label,
        status: t.status,
        ready_date: t.ready_date,
        needs: t.needs,
        gates: { moveout_photos: t.moveout_photos, deposit_review: t.deposit_review },
        both_gates_done: t.moveout_photos && t.deposit_review,
        obligation_id: t.obligation_id,
        obligation_status: t.obligation_status,
        assigned_role: t.assigned_role,
        obligation_outstanding: t.obligation_outstanding,
        outgoing_lease_id: t.outgoing_lease_id,
      }));

      res.json({
        count: turnovers.length,
        in_progress: turnovers.filter(t => t.status === "in_progress").length,
        ready: turnovers.filter(t => t.status === "ready").length,
        turnovers,
      });
    } catch (e) {
      console.error("turnovers list error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  TURN-PRIORITY  —  GET /turnovers/priority?property_id=<uuid>
  //  (Slice D, the leasing-aware turnover ranking. A READ — no writes.)
  //
  //  Ranks in_progress turnovers by WHY each one matters, so a maintenance
  //  tech sees which turn to do next and the reason in plain language —
  //  NEVER a score. The rank is a server-authored demand tier:
  //
  //    tier 3  hard_delivery   an open move_in_delivery obligation exists on a
  //                            PENDING lease whose space is in this unit — a
  //                            resident with a signed lease is waiting on this turn.
  //                            (secondary sort: soonest delivery due_at first)
  //    tier 2  applicant_demand an OPEN application references this unit — demand
  //                            exists but no committed lease yet.
  //    tier 1  raw_vacancy     neither — the turn frees supply with no demand attached.
  //
  //  Every input is a live fact (turnover, pending lease + its delivery
  //  obligation, open application). The reason is a plain sentence the board
  //  shows verbatim. This does not re-derive anything the delivery obligation
  //  already decided; it reads it.
  // ════════════════════════════════════════════════════════════════
  router.get("/turnovers/priority", async (req, res) => {
    const { property_id } = req.query;
    if (!property_id) return res.status(400).json({ error: "property_id is required" });
    try {
      // ONE ranking source: the shared helper (same code the session-scoped
      // operator route /operator/leasing/turn-priority uses). No second copy.
      const out = await rankTurnPriority(pool, property_id);
      res.json(out);
    } catch (e) {
      console.error("turn-priority error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
