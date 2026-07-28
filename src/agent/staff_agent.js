// ════════════════════════════════════════════════════════════════════
//  staff_agent.js — THE STAFF AGENT DOOR (BUILD 5)
//
//  Same authority seam as every maintenance door. Property is server-derived
//  and never accepted from a message body.
//
//  Four routes: read the thread, send a message (proposes only), confirm a
//  proposal (the ONLY path that reaches a canonical service), cancel one.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function staffAgent(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");

  const { pool, staffAgentService } = deps || {};
  if (!pool) throw new Error("staff_agent module requires a pool");
  if (!staffAgentService || typeof staffAgentService.confirmProposal !== "function") {
    throw new Error(
      "staff_agent module requires staffAgentService (build it with " +
      "makeStaffAgentService({ unitTriageService, unitTurnScopeService, workAcceptanceService, readinessService }))"
    );
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
  const gate = [requireOperator, requireModuleAccess, refuseClientProperty];

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
        ...(e.clarification ? { clarification: e.clarification } : {}),
        ...(e.use_instead ? { use_instead: e.use_instead } : {}),
        ...(e.blocked_by ? { blocked_by: e.blocked_by } : {}),
        ...(e.allowed ? { allowed: e.allowed } : {}),
      });
      return null;
    } finally { client.release(); }
  };

  // ── READ THE THREAD ───────────────────────────────────────────────
  router.get("/operator/staff-agent/thread", ...gate, async (req, res) => {
    try {
      const out = await staffAgentService.readThread(pool, {
        property_id: req.operator.property_id, user_id: req.operator.id,
      });
      res.json({ ...out, property_id: req.operator.property_id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── SEND A MESSAGE — PROPOSES, WRITES NO OPERATING TRUTH ──────────
  router.post("/operator/staff-agent/message", ...gate, async (req, res) => {
    const b = req.body || {};
    const out = await tx(res, (client) => staffAgentService.captureMessage(client, {
      property_id: req.operator.property_id,
      actor_user_id: req.operator.id,
      text: b.text,
      photos: Array.isArray(b.photos) ? b.photos : [],
      context_unit_id: b.context_unit_id || null,
    }));
    if (!out) return;

    const p = out.proposal;
    res.status(201).json({
      message: out.message,
      proposal: p,
      unit: out.unit,
      unit_basis: out.unit_basis,
      // The agent's reply, composed server-side.
      agent_reply: p.status === "clarification_required"
        ? p.clarification
        : `I read this as: ${p.intent.replace(/_/g, " ")}. Confirm to record it.`,
      would_call: out.would_call,
      nothing_recorded: out.nothing_recorded,
      needs_clarification: p.status === "clarification_required",
    });
  });

  // ── CONFIRM — the ONLY path to a canonical service ────────────────
  router.post("/operator/staff-agent/proposals/:id/confirm", ...gate, async (req, res) => {
    const out = await tx(res, (client) => staffAgentService.confirmProposal(client, {
      proposal_id: req.params.id,
      property_id: req.operator.property_id,
      actor_user_id: req.operator.id,
      overrides: (req.body || {}).overrides || {},
    }));
    if (!out) return;

    if (out.already_confirmed) {
      return res.status(200).json({
        recorded: true, duplicate: true,
        receipt: { headline: "Already recorded", note: out.note },
        proposal: out.proposal,
      });
    }

    const s = out.summary || {};
    const lines = [];
    if (s.findings) lines.push(...s.findings.map((f) => "- " + f));
    if (s.required_work) lines.push(...s.required_work.map((w) => "- " + w));
    if (s.readiness) lines.push(s.readiness);
    if (s.due) lines.push("Due: " + s.due);
    if (s.proof_required) lines.push("Proof required: " + s.proof_required);
    if (s.closed === false && s.shortfall) lines.push("Not closed — " + s.shortfall);
    if (s.unlocked && s.unlocked.length) lines.push("Now actionable: " + s.unlocked.join(", "));
    if (s.next_action) lines.push("Next: " + s.next_action);
    if (s.owner) lines.push("Owner: " + s.owner);
    if (s.next_move_in) lines.push("Next committed move-in: " + s.next_move_in);
    if (s.manager_decision) lines.push("Manager decision required.");

    res.status(201).json({
      recorded: true,
      receipt: { headline: "Recorded", lines, recorded_via: out.resulting_kind },
      agent_reply: "Recorded.\n\n" + lines.join("\n"),
      proposal: out.proposal,
      resulting_kind: out.resulting_kind,
      resulting_id: out.resulting_id,
      summary: s,
      // Said on every write. The agent is a door, not a second system.
      canonical_note: "Recorded through the same canonical service the structured door uses. It appears identically in the normal unit and work surfaces.",
    });
  });

  // ── CANCEL ────────────────────────────────────────────────────────
  router.post("/operator/staff-agent/proposals/:id/cancel", ...gate, async (req, res) => {
    const out = await tx(res, (client) => staffAgentService.cancelProposal(client, {
      proposal_id: req.params.id,
      property_id: req.operator.property_id,
      actor_user_id: req.operator.id,
      reason: (req.body || {}).reason || null,
    }));
    if (!out) return;
    res.json({ cancelled: true, proposal: out.proposal, agent_reply: out.note });
  });

  return router;
};
