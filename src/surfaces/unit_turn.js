// ════════════════════════════════════════════════════════════════════
//  unit_turn.js — THE UNIT TURN DOOR (BUILD 6A)
//
//  TWO READ-ONLY ROUTES. No writes at all — every write action on the Unit
//  Turn page posts to the Build 1-5 canonical door that owns it.
//
//    GET /operator/units/:unitId/turn   the one page's data
//    GET /operator/turns                the turn list, and the management filter
//
//  Management exceptions are a FILTER over the same list, not a separate
//  workflow. Selecting one opens the same Unit Turn page the operator uses.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function unitTurn(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");

  const { pool, unitTurnRead, rankTurnPriority } = deps || {};
  if (!pool) throw new Error("unit_turn module requires a pool");
  if (!unitTurnRead || typeof unitTurnRead.readUnitTurn !== "function") {
    throw new Error("unit_turn module requires unitTurnRead (build it with makeUnitTurnRead)");
  }
  if (typeof rankTurnPriority !== "function") {
    throw new Error("unit_turn module requires the shared rankTurnPriority read");
  }

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op; next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }
  function requireModuleAccess(req, res, next) {
    const mods = (req.operator && req.operator.allowed_modules) || [];
    if (!mods.includes("maintenance") && !mods.includes("management")) {
      return res.status(403).json({ error: "maintenance or management module access required at this property." });
    }
    return next();
  }
  const gate = [requireOperator, requireModuleAccess];

  // ── THE ONE PAGE ──────────────────────────────────────────────────
  router.get("/operator/units/:unitId/turn", ...gate, async (req, res) => {
    try {
      const ranked = await rankTurnPriority(pool, req.operator.property_id);
      const turnPriority = (ranked.turns || [])
        .find((t) => String(t.unit_id) === String(req.params.unitId)) || null;
      const out = await unitTurnRead.readUnitTurn(pool, {
        property_id: req.operator.property_id,
        unit_id: req.params.unitId,
        user_id: req.operator.id,
        // SERVER-DERIVED. From the session's active assignment, never the body.
        allowed_modules: req.operator.allowed_modules || [],
        turn_priority: turnPriority,
      });
      res.json(out);
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // ── TURN LIST + MANAGEMENT FILTER ─────────────────────────────────
  //
  //  ONE list. `?attention=true` filters it to turns needing judgment. That is
  //  deliberately a filter and not a second endpoint: a management view built
  //  as its own surface becomes its own workflow, and then the manager and the
  //  operator are looking at two different pictures of one unit.
  router.get("/operator/turns", ...gate, async (req, res) => {
    const attention = req.query.attention === "true";
    try {
      // The active population and its order come from ONE canonical read:
      // physical turnovers currently in progress, ranked by the lease
      // commitment waiting on each. Historical triage/scope rows cannot keep
      // a completed turn alive, and a new move-out is visible before its first
      // walk has happened.
      const priority = await rankTurnPriority(pool, req.operator.property_id);
      const rows = [];
      const seenUnits = new Set();
      const countsByUnit = new Map();
      for (const p of priority.turns || []) {
        const k = String(p.unit_id || "");
        countsByUnit.set(k, (countsByUnit.get(k) || 0) + 1);
      }

      let unpositionedCount = 0;
      for (const p of priority.turns || []) {
        if (!p.unit_id) { unpositionedCount++; continue; }
        const unitKey = String(p.unit_id);
        if (seenUnits.has(unitKey)) continue;
        seenUnits.add(unitKey);

        const t = await unitTurnRead.readUnitTurn(pool, {
          property_id: req.operator.property_id, unit_id: p.unit_id, user_id: req.operator.id,
          allowed_modules: req.operator.allowed_modules || [],
          turn_priority: p,
        });

        // Exception reasons, FORWARDED from the layers that decide them.
        const reasons = [];
        if (t.work.some((w) => w.status === "required" && w.owner === "UNASSIGNED")) reasons.push("UNASSIGNED work");
        if (t.work.some((w) => w.latest_outcome === "completed" && w.proof_satisfied === false)) reasons.push("questioned proof");
        if (t.work.some((w) => w.latest_outcome === "unable_to_complete")) reasons.push("unable to complete");
        if (t.work.some((w) => w.reopened_count > 0 && w.status === "required")) reasons.push("reopened work");
        if (p.demand_tier_key === "conflicted_commitment") reasons.push("lease commitment conflict");
        if (p.demand_tier_key === "committed_start" && !t.status.certified) reasons.push("committed move-in at risk");
        if (p.demand_tier_key === "pending_commitment" && !t.status.certified) reasons.push("pending lease attached");
        if (t.scope && t.scope.inspection_completeness === "partial") reasons.push("consequential unknown");
        if (!t.triage_confirmation) reasons.push("initial walk outstanding");
        const activeTurnoverCount = countsByUnit.get(unitKey) || 1;
        if (activeTurnoverCount > 1) reasons.push(`${activeTurnoverCount} active turnover records`);

        const row = {
          turnover_id: p.turnover_id,
          unit_id: p.unit_id, unit_number: p.unit_label,
          readiness_label: t.status.readiness_label,
          marketability: t.status.marketability,
          next_action: t.controlling_next_action ? t.controlling_next_action.action : null,
          open_work: t.work.filter((w) => w.status === "required").length,
          next_move_in: t.status.next_move_in,
          status: p.status,
          ready_date: p.ready_date,
          needs: p.needs,
          demand_tier: p.demand_tier,
          demand_tier_key: p.demand_tier_key,
          priority_label: p.priority_label,
          priority_reason: p.reason,
          commitment_start_date: p.commitment_start_date,
          deadline_known: p.deadline_known,
          commitment_conflict: p.commitment_conflict,
          contributing_commitments: p.contributing_commitments || [],
          active_turnover_count: activeTurnoverCount,
          needs_attention: reasons.length > 0,
          attention_reasons: reasons,
          // The management view opens the SAME page.
          opens: `/operator/units/${p.unit_id}/turn`,
        };
        if (!attention || row.needs_attention) rows.push(row);
      }

      res.json({
        property_id: req.operator.property_id,
        filter: attention ? "needs_attention" : "all",
        count: rows.length,
        turns: rows,
        unpositioned_turnovers: unpositionedCount,
        note: attention && rows.length === 0
          ? "Nothing needs judgment right now. Routine turn work is deliberately not listed."
          : null,
        // Stated so no client builds a second management workflow.
        ordering: priority.note,
        management_is_a_filter: "Management exceptions are a filter over operating truth. Selecting one opens the same Unit Turn page the operator uses.",
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
