// ════════════════════════════════════════════════════════════════════
//  unit_turn_scope.js — NORMAL TURN SCOPE, THE OPERATOR DOOR (BUILD 2)
//
//  Same authority seam as unit_triage.js and for the same reason:
//    authenticated staff session → server-derived property → maintenance
//    module entitlement → canonical service.
//
//  ONE door. No ungated twin. The BUILD 1 source audit found the live app
//  calling the older ungated /work-orders path instead of the authority-scoped
//  one; that divergence cannot happen here because the other path does not
//  exist.
//
//  /propose writes nothing and calls the SAME interpreter /confirm uses, so a
//  proposal can never promise what the save will not do.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function unitTurnScope(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const {
    PAINT_LABEL, CLEANING_LABEL, KEYS_LABEL, APPLIANCE_LABEL, INSPECTION_LABEL,
  } = require("./turn_scope_interpreter");

  const { pool, unitTurnScopeService, unitTriageService } = deps || {};
  if (!pool) throw new Error("unit_turn_scope module requires a pool");
  if (!unitTurnScopeService || typeof unitTurnScopeService.confirmScope !== "function") {
    throw new Error(
      "unit_turn_scope module requires unitTurnScopeService (build it with " +
      "makeUnitTurnScopeService({ spawnObligationFromEvent }) and inject it)"
    );
  }

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op;
      next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }
  function requireMaintenanceModuleAccess(req, res, next) {
    const mods = (req.operator && req.operator.allowed_modules) || [];
    if (!mods.includes("maintenance")) {
      return res.status(403).json({
        error: "maintenance-module access required at this property (property_team_assignments.allowed_modules).",
      });
    }
    return next();
  }
  function refuseClientProperty(req, res, next) {
    const claimed = (req.body && req.body.property_id) || (req.query && req.query.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }
  const operatorGate = [requireOperator, requireMaintenanceModuleAccess, refuseClientProperty];

  async function unitInScope(req, res) {
    const u = (await pool.query(
      "select id, unit_number, property_id from units where id=$1", [req.params.id])).rows[0];
    if (!u) { res.status(404).json({ error: "unit not found" }); return null; }
    if (String(u.property_id) !== String(req.operator.property_id)) {
      res.status(403).json({ error: "that unit is not at the property you are operating" });
      return null;
    }
    return u;
  }

  const ownerLine = (o) => (o && o.assigned_user_id
    ? { user_id: o.assigned_user_id, display: "assigned" } : { user_id: null, display: "UNASSIGNED" });

  // ════════════════════════════════════════════════════════════════
  //  CONTEXT — GET /operator/units/:id/turn-scope/context
  //  Everything Spine already knows, so the operator re-enters nothing.
  // ════════════════════════════════════════════════════════════════
  router.get("/operator/units/:id/turn-scope/context", ...operatorGate, async (req, res) => {
    try {
      const u = await unitInScope(req, res); if (!u) return;

      // BUILD 2 starts from a BUILD 1 confirmed walk. Without one there is
      // nothing to extend, and saying so plainly beats an empty form.
      const triage = unitTriageService
        ? await unitTriageService.readUnitTriageState(pool, { unit_id: u.id })
        : null;
      if (!triage || !triage.confirmation) {
        return res.status(409).json({
          error: "no confirmed initial walk for this unit",
          detail: "A turn scope extends a confirmed BUILD 1 initial triage. Complete the initial walk first.",
          unit: { id: u.id, unit_number: u.unit_number },
        });
      }

      const appliances = await unitTurnScopeService.applianceCandidates(pool, { unit_id: u.id });
      const nextMoveIn = unitTriageService
        ? await unitTriageService.nextCommittedMoveIn(pool, { unit_id: u.id }) : null;
      const current = await unitTurnScopeService.readTurnFlow(pool, { unit_id: u.id });
      // What this scope will INHERIT. Served before confirmation because an
      // operator cannot place work they were never shown.
      const inherited = await unitTurnScopeService.inheritedWork(pool, { unit_id: u.id });

      res.json({
        unit: { id: u.id, unit_number: u.unit_number },
        triage_confirmation_id: triage.confirmation.id,
        triage_observed: triage.confirmation.original_text || null,
        appliance_candidates: appliances,
        next_move_in: nextMoveIn,
        existing_scope: current.scope,
        inherited_work: inherited,
        vocabularies: {
          paint: PAINT_LABEL, cleaning: CLEANING_LABEL,
          keys: KEYS_LABEL, appliance: APPLIANCE_LABEL, inspection: INSPECTION_LABEL,
        },
      });
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  PROPOSE — POST /operator/units/:id/turn-scope/propose   (no write)
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/units/:id/turn-scope/propose", ...operatorGate, async (req, res) => {
    try {
      const u = await unitInScope(req, res); if (!u) return;
      const b = req.body || {};
      const proposal = unitTurnScopeService.propose({
        repairs_text: b.repairs_text || "",
        paint_level: b.paint_level, paint_areas: b.paint_areas,
        cleaning_level: b.cleaning_level,
        appliances: Array.isArray(b.appliances) ? b.appliances : [],
        keys_status: b.keys_status, keys_note: b.keys_note,
        inspection_completeness: b.inspection_completeness,
      });
      const nextMoveIn = unitTriageService
        ? await unitTriageService.nextCommittedMoveIn(pool, { unit_id: u.id }) : null;
      res.json({
        unit: { id: u.id, unit_number: u.unit_number },
        you_reported: b.repairs_text || "",
        proposal,
        next_move_in: nextMoveIn,
        proposal_is_not_truth:
          "Nothing has been recorded. Correct, remove, or add anything before confirming.",
      });
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  CONFIRM — POST /operator/units/:id/turn-scope/confirm
  //  The one canonical write. Property and actor from the SESSION.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/units/:id/turn-scope/confirm", ...operatorGate, async (req, res) => {
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await unitTurnScopeService.confirmScope(client, {
        property_id: req.operator.property_id,
        actor_user_id: req.operator.id,   // session returns the user id as `id`
        unit_id: req.params.id,
        triage_confirmation_id: b.triage_confirmation_id,
        original_text: b.text || null,
        photos: Array.isArray(b.photos) ? b.photos : [],
        paint_level: b.paint_level, paint_areas: b.paint_areas || null,
        cleaning_level: b.cleaning_level,
        keys_status: b.keys_status, keys_note: b.keys_note || null,
        inspection_completeness: b.inspection_completeness,
        appliances: Array.isArray(b.appliances) ? b.appliances : [],
        findings: Array.isArray(b.findings) ? b.findings : [],
        required_work: Array.isArray(b.required_work) ? b.required_work : [],
        // [{ work_id, action: 'stage'|'unknown'|'withdraw', stage?, reason? }]
        inherited_work: Array.isArray(b.inherited_work) ? b.inherited_work : [],
        supersedes_id: b.supersedes_id || null,
        correction_reason: b.correction_reason || null,
      });
      await client.query("commit");

      const nextMoveIn = unitTriageService
        ? await unitTriageService.nextCommittedMoveIn(pool, { unit_id: req.params.id }) : null;
      const owner = ownerLine(out.scope_obligation);
      const c = out.flow.controlling_next_action;

      res.status(201).json({
        recorded: true,
        receipt: {
          unit: `Unit ${out.unit.unit_number || out.unit.id}`,
          you_reported: out.scope.original_text,
          paint: PAINT_LABEL[out.scope.paint_level] + (out.scope.paint_areas ? ` — ${out.scope.paint_areas}` : ""),
          cleaning: CLEANING_LABEL[out.scope.cleaning_level],
          keys: KEYS_LABEL[out.scope.keys_status],
          inspection: INSPECTION_LABEL[out.scope.inspection_completeness],
          appliance_findings: out.appliances
            .filter((a) => a.condition !== "working")
            .map((a) => `${a.label || a.appliance_key}: ${APPLIANCE_LABEL[a.condition]}`),
          findings_recorded: out.findings.map((f) => f.finding_text),
          required_work_created: out.required_work.map((w) => `${w.work_text} (${w.stage || "unstaged"})`),
          accountable_owner: owner.display,
          next_move_in: nextMoveIn ? `${nextMoveIn.move_in_date} — ${nextMoveIn.days_remaining} days remaining` : null,
          controlling_next_action: c ? c.action : null,
          why: c ? c.why : null,
          superseded_work: out.superseded_work.map((w) => w.work_text),
          inherited_placed: (out.inherited_handled || []).map((h) => `${h.work_text} → ${h.action}`),
          inherited_left_unplaced: (out.inherited_left_unplaced || []).map((w) => w.work_text),
          standing_caveat: out.scope.inspection_completeness === "partial"
            ? "This is a partial inspection. Areas not inspected remain unknown, and final readiness cannot be reached."
            : "Final readiness is established by the readiness walk, which this build does not perform or certify.",
        },
        scope: out.scope, appliances: out.appliances, findings: out.findings,
        required_work: out.required_work, superseded_work: out.superseded_work,
        inherited_handled: out.inherited_handled, inherited_left_unplaced: out.inherited_left_unplaced,
        flow: out.flow, scope_obligation: out.scope_obligation, scope_owner: out.scope_owner,
        acted_on: { property_id: req.operator.property_id, actor: req.operator.name || null },
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      res.status(e.httpStatus || 500).json({ error: e.message, ...(e.allowed ? { allowed: e.allowed } : {}) });
    } finally { client.release(); }
  });

  // ════════════════════════════════════════════════════════════════
  //  TURN FLOW — GET /operator/units/:id/turn-flow
  // ════════════════════════════════════════════════════════════════
  router.get("/operator/units/:id/turn-flow", ...operatorGate, async (req, res) => {
    try {
      const u = await unitInScope(req, res); if (!u) return;
      const out = await unitTurnScopeService.readTurnFlow(pool, { unit_id: u.id });
      const triage = unitTriageService
        ? await unitTriageService.readUnitTriageState(pool, { unit_id: u.id }) : null;
      const nextMoveIn = unitTriageService
        ? await unitTriageService.nextCommittedMoveIn(pool, { unit_id: u.id }) : null;

      const unknowns = [];
      if (out.scope) {
        if (out.scope.paint_level === "unknown") unknowns.push("Paint level is unknown.");
        if (out.scope.cleaning_level === "unknown") unknowns.push("Cleaning level is unknown.");
        if (out.scope.keys_status === "unknown") unknowns.push("Keys and access were not checked.");
        if (out.scope.inspection_completeness === "partial")
          unknowns.push("Inspection is partial — areas not inspected remain unknown.");
      }
      for (const a of out.appliances) {
        if (a.condition === "unknown") unknowns.push(`${a.label || a.appliance_key} was not checked.`);
      }

      res.json({
        unit: { id: u.id, unit_number: u.unit_number },
        ...out,
        next_move_in: nextMoveIn,
        unresolved_unknowns: unknowns,
        exceptions: unitTurnScopeService.turnExceptions({
          scope: out.scope, work: out.required_work, flow: out.flow,
          triage: triage && triage.confirmation
            ? { initial_condition: triage.confirmation.initial_condition, findings: triage.findings }
            : null,
          nextMoveIn,
        }),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  SEQUENCE EXCEPTION — POST /operator/turn-work/:workId/sequence-exception
  //  Per item, deliberate, attributed. Never a global override.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/turn-work/:workId/sequence-exception", ...operatorGate, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // The item must belong to the session's property.
      const w = (await client.query(
        "select id, property_id, unit_id from unit_triage_required_work where id=$1",
        [req.params.workId])).rows[0];
      if (!w) { await client.query("rollback"); return res.status(404).json({ error: "required-work item not found" }); }
      if (String(w.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback");
        return res.status(403).json({ error: "that work item is not at the property you are operating" });
      }
      const row = await unitTurnScopeService.recordSequenceException(client, {
        work_id: req.params.workId,
        actor_user_id: req.operator.id,
        reason: (req.body || {}).reason,
      });
      await client.query("commit");
      const out = await unitTurnScopeService.readTurnFlow(pool, { unit_id: w.unit_id });
      res.json({
        recorded: true, work: row, flow: out.flow,
        note: "This item is released from its prerequisite. The release is attributed and stays visible; no other item is affected.",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      res.status(e.httpStatus || 500).json({ error: e.message });
    } finally { client.release(); }
  });

  // ════════════════════════════════════════════════════════════════
  //  MANAGEMENT EXCEPTIONS — GET /operator/turn-scope/exceptions
  //  ONLY scopes needing judgment. Routine flow is deliberately absent.
  // ════════════════════════════════════════════════════════════════
  router.get("/operator/turn-scope/exceptions", ...operatorGate, async (req, res) => {
    const property_id = req.operator.property_id;
    try {
      const units = (await pool.query(
        `select distinct u.id, u.unit_number from units u
          where u.property_id = $1
            and exists (select 1 from unit_turn_scopes s where s.unit_id = u.id)
          order by u.unit_number asc`, [property_id])).rows;

      const rows = [];
      for (const u of units) {
        const out = await unitTurnScopeService.readTurnFlow(pool, { unit_id: u.id });
        const triage = unitTriageService
          ? await unitTriageService.readUnitTriageState(pool, { unit_id: u.id }) : null;
        const nextMoveIn = unitTriageService
          ? await unitTriageService.nextCommittedMoveIn(pool, { unit_id: u.id }) : null;
        const ex = unitTurnScopeService.turnExceptions({
          scope: out.scope, work: out.required_work, flow: out.flow,
          triage: triage && triage.confirmation
            ? { initial_condition: triage.confirmation.initial_condition, findings: triage.findings }
            : null,
          nextMoveIn,
        });
        // Quiet normal flow: a scope with no exception does not appear at all.
        if (ex.length === 0) continue;
        rows.push({
          unit_id: u.id, unit_number: u.unit_number,
          exceptions: ex,
          controlling_next_action: out.flow.controlling_next_action,
          open_count: out.flow.open_count,
          unassigned_count: out.flow.unassigned_count,
          next_move_in: nextMoveIn,
        });
      }

      res.json({
        property_id, count: rows.length, units: rows,
        note: rows.length === 0
          ? "No turn scopes need judgment right now. Routine turn work is deliberately not listed here."
          : null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
