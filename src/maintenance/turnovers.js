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
  // Shared effective-possession writer (space_position.js). Records the effective
  // move_out that ENDS possession, space_id-anchored. Optional for soft partial deploy.
  const recordEffectivePossession = deps && deps.recordEffectivePossession;
  // BUILD 1 — post-move-out initial triage. Injected and OPTIONAL, the same
  // soft-deploy shape as recordEffectivePossession above: if it is not wired,
  // move-out behaves exactly as before rather than failing to boot.
  const unitTriageService = deps && deps.unitTriageService;
  const express = require("express");
  const { rankTurnPriority } = require("./turn_priority"); // ONE ranking source (shared w/ operator route)
  const router = express.Router();

  const { pool, spawnObligationFromEvent, satisfyObligation, completeObligation } = deps;
  if (!pool) throw new Error("turnovers module requires a pool");

  // The two proof gates a move-out must clear before the turn is done.
  // These are BOTH the obligation's required_inputs AND boolean columns on
  // the turnover row — kept in lockstep.
  const GATES = ["moveout_photos", "deposit_review"];

  // ── routing: who owns this property's move-out, via the org chart ──────
  // Same pattern money uses: route to the property's accountable assignment's
  // role; fall back to property_manager if there's no accountable owner.
  // Returns { assigned_role, escalates_to_role } as role strings (role_name enum).
  async function routeMoveOut(client, property_id) {
    const prop = await client.query(
      "select accountable_assignment_id from properties where id = $1",
      [property_id]
    );
    const accId = prop.rows[0] ? prop.rows[0].accountable_assignment_id : null;

    let assigned_role = "property_manager";   // sensible default owner
    let escalates_to_role = "owner";          // PM escalates to owner

    if (accId) {
      const acc = await client.query(
        "select role, escalates_to_assignment_id from assignments where id = $1 and is_active = true",
        [accId]
      );
      if (acc.rows.length) {
        // map org-chart role → obligation role_name enum. The org chart uses
        // 'leasing'/'bookkeeper'; the obligation enum uses 'leasing_agent'/
        // 'accountant'. property_manager/maintenance/asset_manager/owner match.
        assigned_role = mapRole(acc.rows[0].role);
        // escalation: resolve the escalation assignment's role if present
        if (acc.rows[0].escalates_to_assignment_id) {
          const esc = await client.query(
            "select role from assignments where id = $1",
            [acc.rows[0].escalates_to_assignment_id]
          );
          if (esc.rows.length) escalates_to_role = mapRole(esc.rows[0].role);
        }
      }
    }
    return { assigned_role, escalates_to_role };
  }

  // org-chart role vocabulary → obligations.role_name enum vocabulary.
  // (Logged drift: the two vocabularies don't fully line up. This bridges them
  // so a move-out obligation always gets a VALID role_name enum value.)
  function mapRole(orgRole) {
    const map = {
      property_manager: "property_manager",
      maintenance: "maintenance",
      leasing: "leasing_agent",
      bookkeeper: "accountant",
      asset_manager: "asset_manager",
      owner: "owner",
    };
    return map[orgRole] || "property_manager";
  }

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
    const unit_id = req.params.id;
    const { outgoing_lease_id = null, needs = [], expected_ready_date = null } = req.body || {};

    const client = await pool.connect();
    try {
      await client.query("begin");

      // unit must exist; get its property
      const uQ = await client.query(
        "select id, property_id, unit_number, occupancy_status from units where id=$1 for update",
        [unit_id]
      );
      if (uQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "unit not found" }); }
      const unit = uQ.rows[0];

      // if a lease was named, confirm it exists
      if (outgoing_lease_id) {
        const l = await client.query("select id from leases where id=$1", [outgoing_lease_id]);
        if (l.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "outgoing_lease_id not found" }); }
      }

      // guard: don't open a second active turnover for the same unit
      const existing = await client.query(
        `select id from turnovers where unit_id=$1 and status in ('in_progress') order by created_at desc limit 1`,
        [unit_id]
      );
      if (existing.rows.length) {
        await client.query("rollback");
        return res.status(409).json({ error: "this unit already has an in-progress turnover", turnover_id: existing.rows[0].id });
      }

      // 1) the turnover row — the operating record. defaults handle
      //    status='in_progress', moveout_photos=false, deposit_review=false.
      const needsArr = Array.isArray(needs) ? needs : [];
      const tIns = await client.query(
        `insert into turnovers (property_id, unit_id, outgoing_lease_id, needs, ready_date)
         values ($1,$2,$3,$4,$5) returning *`,
        [unit.property_id, unit_id, outgoing_lease_id, needsArr, expected_ready_date]
      );
      const turnover = tIns.rows[0];

      // 2) the source event — obligation must be born from an event
      const ev = await client.query(
        `insert into events (property_id, unit_id, type, note)
         values ($1,$2,'move_out',$3) returning *`,
        [unit.property_id, unit_id,
         JSON.stringify({ unit_id, turnover_id: turnover.id, outgoing_lease_id, needs: needsArr })]
      );
      const event = ev.rows[0];

      // 3) route via org chart, then spawn ONE obligation with both gates
      const route = await routeMoveOut(client, unit.property_id);
      let obligation = null;
      if (typeof spawnObligationFromEvent === "function") {
        obligation = await spawnObligationFromEvent(client, {
          property_id: unit.property_id,
          unit_id,
          source_event_id: event.id,
          related_id: turnover.id,
          related_type: "turnover",
          module: "turnover",
          type: "move_out",
          label: `Move-out turn — unit ${unit.unit_number || ""}`.trim(),
          owner_type: "human",
          assigned_role: route.assigned_role,
          escalates_to_role: route.escalates_to_role,
          status: "open",
          priority: "high",
          severity: "high",
          due_at: expected_ready_date ? new Date(expected_ready_date) : null,
          required_inputs: GATES,
        });
        // link the obligation onto the turnover (reuse outgoing_lease_id? no —
        // we don't have an obligation_id column on turnovers; the link lives on
        // the obligation via related_id=turnover.id, and on the event note).
      }

      // ── 3b) THE INITIAL WALK (BUILD 1) ────────────────────────────────
      //  Move-out confirmed is the operating trigger: somebody must now go
      //  look at the unit. Born from the SAME move_out event, in the SAME
      //  transaction, through the SAME shared engine — an obligation is never
      //  born from anything but an event.
      //
      //  Born HIGH and due today because the operating expectation is
      //  same-day inspection. If staffing prevents that it stays visibly
      //  overdue; it never lapses, and the unit never becomes ready because
      //  nobody walked it.
      //
      //  NOT excluding a preceding actor here: this route carries no operator
      //  session (it is the older ungated door), so there is no confirmed-by
      //  identity to exclude. The service supports the exclusion and it takes
      //  effect wherever a session-scoped move-out door exists.
      let initialWalk = null;
      if (unitTriageService && typeof unitTriageService.spawnInitialWalk === "function") {
        initialWalk = await unitTriageService.spawnInitialWalk(client, {
          property_id: unit.property_id,
          unit_id,
          source_event_id: event.id,
          unit_number: unit.unit_number,
          exclude_user_id: null,
        });
      }

      // 4) occupancy flips to vacant (tenant leaving). The unit is NOT yet
      //    rentable — that's what the turn resolves. Occupancy and rentable
      //    readiness are separate axes (the four-axis model).
      // ── POSSESSION END — recorded ONLY on a genuine resident surrender ──────
      // A turnover beginning is NOT automatically possession ending. This route
      // records an effective move_out unit_event ONLY when the named lease was
      // actually in possession (a live effective move_in exists for its space).
      // A turn with no lease, or for a unit nobody currently possesses, records
      // NO move_out — and that is CORRECT, not a failure. The possession writer
      // refuses to encode a false surrender (NO_POSSESSION_TO_END). This route
      // is the move-out TRANSACTION; it is not the sole authority that a
      // possession ended — it only asserts it when it is true.
      let moveOutNote = null;
      if (recordEffectivePossession && outgoing_lease_id) {
        // ── MOVE_OUT EVENT IS MANDATORY WHEN IT APPLIES ──────────────────
        // unit_events is the possession source of truth. Two distinct outcomes:
        //   · NO_POSSESSION_TO_END — the guard fired: this lease/space had no
        //     live move_in, so this turn is NOT a resident surrender. That is
        //     EXPECTED, not an error; the turn proceeds with no possession event.
        //   · any OTHER error (schema/constraint) — a real failure. It is NOT
        //     swallowed: it propagates and rolls back the whole move-out, so we
        //     never vacate the cache + open a turn while the canonical move_out
        //     event failed to write. (Symmetric with move-in's mandatory rule.)
        // A savepoint isolates ONLY the expected NO_POSSESSION_TO_END refusal.
        await client.query("savepoint sp_moveout");
        let possessionEndApplies = true;
        try {
          const pr = await recordEffectivePossession(client, {
            kind: "move_out",
            lease_id: outgoing_lease_id,
            unit_id,
            property_id: unit.property_id,
            effective_date: new Date().toISOString().slice(0, 10),
            actor: null,
            source: "move_out",
          });
          await client.query("release savepoint sp_moveout");
          moveOutNote = pr.created ? "Effective move_out recorded (verified prior possession)." : "Move_out already recorded — idempotent no-op.";
        } catch (e) {
          if (e.code === "NO_POSSESSION_TO_END") {
            // EXPECTED refusal — roll back only this event, proceed with the turn.
            await client.query("rollback to savepoint sp_moveout");
            possessionEndApplies = false;
            moveOutNote = "Turn recorded; no possession-end event (this lease/space had no live move_in — not a resident surrender).";
          } else {
            // REAL failure — do NOT swallow. Let it propagate and roll back the
            // whole move-out. (Release the savepoint name first is unnecessary;
            // the throw aborts the outer transaction.)
            throw e;
          }
        }
      } else if (!outgoing_lease_id) {
        moveOutNote = "No outgoing_lease_id — turn only; no possession-end event.";
      }

      // compatibility cache (downstream of the event, not the source of truth)
      await client.query(
        "update units set occupancy_status='vacant', updated_at=now() where id=$1",
        [unit_id]
      );

      await client.query("commit");
      const updatedUnit = await pool.query("select id, unit_number, occupancy_status, operating_use, is_down from units where id=$1", [unit_id]);
      res.status(201).json({
        turnover,
        event,
        move_out_note: moveOutNote,
        obligation,
        initial_walk_obligation: initialWalk,
        unit: updatedUnit.rows[0],
        routed_role: route.assigned_role,
        note: "Move-out logged. Turnover opened (operating record); one obligation spawned with two proof gates (moveout_photos, deposit_review). Unit occupancy → vacant; rentable readiness pending turn.",
        initial_walk_note: initialWalk
          ? (initialWalk.assigned_user_id
              ? "Initial walk assigned — same-day inspection expected."
              : "Initial walk created but UNASSIGNED — no eligible onsite staff at this property. It stays visibly unresolved.")
          : "Initial-walk capture is not wired in this deployment; no walk obligation created.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("move-out error", e);
      res.status(500).json({ error: e.message });
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
