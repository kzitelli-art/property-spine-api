// ════════════════════════════════════════════════════════════════════
//  ask_spine.js — THE ASK SPINE DOOR (SLICE 1, read-only)
//
//  ONE route: GET /operator/ask-spine/attention
//
//  Same authority seam as the staff agent and every maintenance door —
//  property is server-derived and never accepted from the browser. It is
//  a READ-ONLY SIBLING of staff_agent.js, not an extension of it: no
//  proposal, no confirmation, no canonical mutation, and the operator's
//  question is NOT recorded as a staff-agent message.
//
//  There is deliberately no POST here. Slice 1 answers exactly one
//  question and records nothing, so a GET is the honest verb.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function askSpine(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const askSpineService = require("./ask_spine_service");

  const { pool } = deps || {};
  if (!pool) throw new Error("ask_spine module requires a pool");

  //  Identical to the staff-agent gate. Copied rather than shared so this
  //  door carries no dependency on the proposal machinery next to it.
  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op; next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }

  //  §21: the browser may REQUEST; it may not determine authority. A
  //  client-supplied property_id never selects a different property — it
  //  is refused outright rather than quietly ignored, so a caller cannot
  //  believe it chose the scope.
  function refuseClientProperty(req, res, next) {
    const claimed = (req.query && req.query.property_id) || (req.body && req.body.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  const gate = [requireOperator, refuseClientProperty];

  // ── "What needs attention?" ───────────────────────────────────────
  //  Property and module entitlement both come from the resolved
  //  session. Nothing in the request influences either.
  router.get("/operator/ask-spine/attention", ...gate, async (req, res) => {
    try {
      const out = await askSpineService.attention(pool, {
        property_id: req.operator.property_id,
        allowed_modules: req.operator.allowed_modules,
      });

      return res.json({
        property_id: req.operator.property_id,   // echoed from the session, not the request
        asked_at: new Date().toISOString(),
        items: out.items,
        total_open: out.total_open,
        scope_note: out.scope_note,
      });
    } catch (e) {
      //  A failure is a failure. It must never reach the browser shaped
      //  like an empty result — that is the false-green this whole
      //  surface is built to avoid.
      console.error("ask-spine/attention error", e);
      return res.status(500).json({ error: "Could not read the work queue." });
    }
  });

  return router;
};
