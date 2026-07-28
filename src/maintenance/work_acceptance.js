// ════════════════════════════════════════════════════════════════════
//  work_acceptance.js — ACCEPTANCE, PROOF AND PROGRESSION: THE OPERATOR DOOR
//
//  BUILD 3. Same authority seam as unit_triage.js and unit_turn_scope.js:
//    authenticated staff session → server-derived property → maintenance
//    module entitlement → canonical service.
//
//  ONE door, no ungated twin. /propose-commitment writes nothing.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function workAcceptance(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const { UNABLE_REASONS, OUTCOME_VALUES, UNABLE_REASON_VALUES } = require("./work_proof");

  const { pool, workAcceptanceService, unitTriageService } = deps || {};
  if (!pool) throw new Error("work_acceptance module requires a pool");
  if (!workAcceptanceService || typeof workAcceptanceService.acceptWork !== "function") {
    throw new Error(
      "work_acceptance module requires workAcceptanceService (build it with " +
      "makeWorkAcceptanceService({ spawnObligationFromEvent }) and inject it)"
    );
  }

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op; next();
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

  const tx = async (res, fn) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      res.status(e.httpStatus || 500).json({
        error: e.message,
        ...(e.allowed ? { allowed: e.allowed } : {}),
        ...(e.blocked_by ? { blocked_by: e.blocked_by } : {}),
      });
      return null;
    } finally { client.release(); }
  };

  // ════════════════════════════════════════════════════════════════
  //  PROPOSE A COMMITMENT — POST /operator/turn-work/:workId/propose-commitment
  //  "I'll handle it tomorrow" → a PROPOSAL. Writes nothing, accepts nothing.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/turn-work/:workId/propose-commitment", ...operatorGate, async (req, res) => {
    try {
      const state = await workAcceptanceService.readWorkState(pool, { work_id: req.params.workId });
      if (!state) return res.status(404).json({ error: "required-work item not found" });
      if (String(state.work.property_id) !== String(req.operator.property_id)) {
        return res.status(403).json({ error: "that work item is not at the property you are operating" });
      }
      const proposal = workAcceptanceService.proposeCommitment({
        text: (req.body || {}).text || "",
        actor_user_id: req.operator.id,
        now: new Date().toISOString(),
      });
      res.json({
        work: { id: state.work.id, work_text: state.work.work_text, stage: state.work.stage },
        proposal,
        proof_requirement: state.requirement,
      });
    } catch (e) { res.status(e.httpStatus || 500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  ACCEPT — POST /operator/turn-work/:workId/accept
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/turn-work/:workId/accept", ...operatorGate, async (req, res) => {
    const b = req.body || {};
    const out = await tx(res, (client) => workAcceptanceService.acceptWork(client, {
      work_id: req.params.workId,
      property_id: req.operator.property_id,
      actor_user_id: req.operator.id,
      owner_user_id: b.owner_user_id || null,
      due_at: b.due_at || null,
      commitment_source: b.commitment_source || null,
      note: b.note || null,
      supersedes_id: b.supersedes_id || null,
      supersede_reason: b.supersede_reason || null,
    }));
    if (!out) return;
    res.status(201).json({
      accepted: true,
      receipt: {
        work: out.work.work_text,
        accountable_owner: out.acceptance.owner_user_id,
        accepted_by: out.acceptance.accepted_by_user_id,
        accepted_at: out.acceptance.accepted_at,
        due: out.acceptance.due_at
          ? String(out.acceptance.due_at)
          : "No date committed — this is accepted, not scheduled.",
        commitment_source: out.acceptance.commitment_source,
        proof_needed_to_close: out.proof_requirement.label,
        standing_caveat: "Accepting is not completing. This work is still outstanding and still blocks whatever follows it.",
      },
      acceptance: out.acceptance, obligation: out.obligation,
      proof_requirement: out.proof_requirement,
      acted_on: { property_id: req.operator.property_id, actor: req.operator.name || null },
    });
  });

  // ════════════════════════════════════════════════════════════════
  //  CLAIM COMPLETION — POST /operator/turn-work/:workId/claim
  //  A claim without its proof is RECORDED but does NOT close the work.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/turn-work/:workId/claim", ...operatorGate, async (req, res) => {
    const b = req.body || {};
    const out = await tx(res, (client) => workAcceptanceService.claimCompletion(client, {
      work_id: req.params.workId,
      property_id: req.operator.property_id,
      actor_user_id: req.operator.id,
      outcome: b.outcome,
      unable_reason: b.unable_reason || null,
      note: b.note || null,
      proof_photos: Array.isArray(b.proof_photos) ? b.proof_photos : [],
      functional_confirmation: b.functional_confirmation || null,
    }));
    if (!out) return;

    const c = out.flow.controlling_next_action;
    res.status(201).json({
      recorded: true,
      closed: out.closed,
      receipt: {
        work: out.work.work_text,
        outcome: out.claim.outcome,
        // The distinction that matters most on this surface.
        result: out.closed
          ? "Closed. Proof was attached."
          : out.claim.outcome === "completed"
            ? `NOT closed — ${out.claim.proof_shortfall} The claim is recorded and the work is still open.`
            : "Recorded. The work stays open.",
        proof_shortfall: out.claim.proof_shortfall,
        unlocked: out.unlocked_stages,
        next_action: c ? c.action : null,
        next_action_why: c ? c.why : null,
        proposed_next: out.next_action_proposal ? out.next_action_proposal.proposed_next : null,
        nothing_dispatched: out.next_action_proposal ? out.next_action_proposal.nothing_dispatched : null,
        readiness_note: out.readiness_note,
      },
      claim: out.claim, proof: out.proof, flow: out.flow,
      unlocked_stages: out.unlocked_stages,
      next_action_proposal: out.next_action_proposal,
    });
  });

  // ════════════════════════════════════════════════════════════════
  //  REOPEN — POST /operator/turn-work/:workId/reopen
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/turn-work/:workId/reopen", ...operatorGate, async (req, res) => {
    const b = req.body || {};
    const out = await tx(res, (client) => workAcceptanceService.reopenWork(client, {
      work_id: req.params.workId,
      property_id: req.operator.property_id,
      actor_user_id: req.operator.id,
      reason: b.reason,
      cascade: b.cascade !== false,
    }));
    if (!out) return;
    const c = out.flow.controlling_next_action;
    res.status(201).json({
      reopened: true,
      receipt: {
        work: out.work.work_text,
        reason: out.reopening.reason,
        original_claim_preserved: !!out.preserved_claim_id,
        also_reopened: out.cascaded_reopenings.map((x) => x.work_text),
        cascade_note: out.cascaded_reopenings.length
          ? "Final cleaning was reopened because upstream work was reopened. That is not a failure of the cleaning."
          : null,
        next_action: c ? c.action : null,
        history_note: out.note,
      },
      reopening: out.reopening, cascaded_reopenings: out.cascaded_reopenings, flow: out.flow,
    });
  });

  // ════════════════════════════════════════════════════════════════
  //  READ ONE ITEM — GET /operator/turn-work/:workId
  // ════════════════════════════════════════════════════════════════
  router.get("/operator/turn-work/:workId", ...operatorGate, async (req, res) => {
    try {
      const state = await workAcceptanceService.readWorkState(pool, { work_id: req.params.workId });
      if (!state) return res.status(404).json({ error: "required-work item not found" });
      if (String(state.work.property_id) !== String(req.operator.property_id)) {
        return res.status(403).json({ error: "that work item is not at the property you are operating" });
      }
      res.json({ ...state, unable_reasons: UNABLE_REASONS, outcomes: OUTCOME_VALUES });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════
  //  UNIT WORK FLOW — GET /operator/units/:id/work-flow
  //  Ordered flow plus the six exceptions. Routine success is absent.
  // ════════════════════════════════════════════════════════════════
  router.get("/operator/units/:id/work-flow", ...operatorGate, async (req, res) => {
    try {
      const u = (await pool.query(
        "select id, unit_number, property_id from units where id=$1", [req.params.id])).rows[0];
      if (!u) return res.status(404).json({ error: "unit not found" });
      if (String(u.property_id) !== String(req.operator.property_id)) {
        return res.status(403).json({ error: "that unit is not at the property you are operating" });
      }

      const out = await workAcceptanceService.readUnitFlow(pool, { unit_id: u.id });
      const states = [];
      for (const w of out.work) {
        if (w.status === "withdrawn" || w.status === "superseded") continue;
        states.push(await workAcceptanceService.readWorkState(pool, { work_id: w.id }));
      }
      const nextMoveIn = unitTriageService
        ? await unitTriageService.nextCommittedMoveIn(pool, { unit_id: u.id }) : null;

      const exceptions = workAcceptanceService.workExceptions({
        flow: out.flow, workStates: states, nextMoveIn, now: new Date().toISOString(),
      });

      res.json({
        unit: { id: u.id, unit_number: u.unit_number },
        flow: out.flow,
        work: states.map((s) => ({
          work_id: s.work.id, work_text: s.work.work_text, stage: s.work.stage,
          status: s.status, accepted: s.accepted,
          owner_user_id: s.owner_user_id, accepted_by_user_id: s.accepted_by_user_id,
          due_at: s.due_at, commitment_source: s.commitment_source,
          latest_outcome: s.latest_claim ? s.latest_claim.outcome : null,
          proof_satisfied: s.latest_claim ? s.latest_claim.proof_satisfied : null,
          proof_shortfall: s.latest_claim ? s.latest_claim.proof_shortfall : null,
          reopened_count: s.reopened_count,
          proof_requirement: s.requirement,
        })),
        next_move_in: nextMoveIn,
        exceptions,
        exceptions_note: exceptions.length === 0
          ? "Nothing needs management attention. Routine successful work is deliberately not listed."
          : null,
        readiness_note: "This build cannot certify readiness. An unblocked readiness walk is permission to look, not a verdict.",
        unable_reasons: UNABLE_REASONS,
        unable_reason_values: UNABLE_REASON_VALUES,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
