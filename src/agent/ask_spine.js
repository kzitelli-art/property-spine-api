// ════════════════════════════════════════════════════════════════════
//  ask_spine.js — THE ASK SPINE DOOR (read-only)
//
//  GET  /operator/ask-spine/attention    slice 1 — the one fixed question
//  POST /operator/ask-spine/ask          slice 2 — a question the operator typed
//
//  Same authority seam as the staff agent and every maintenance door —
//  property is server-derived and never accepted from the browser. It is
//  a READ-ONLY SIBLING of staff_agent.js, not an extension of it: no
//  proposal, no confirmation, no canonical mutation, and the operator's
//  question is NOT recorded as a staff-agent message.
//
//  Slice 1's header said "there is deliberately no POST here", which was
//  true of a door that answered exactly one question. Slice 2 adds one,
//  and the reasoning it was standing on has NOT changed: the POST carries
//  a question in a body and still writes nothing. The verb reflects a
//  request payload, not a mutation.
//
//  What would make that sentence true again is Ask Spine being able to DO
//  something. That is a different slice with its own authority rules, and
//  it does not arrive by adding a route to this file.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function askSpine(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const askSpineService = require("./ask_spine_service");
  const askSpineAnswer = require("./ask_spine_answer");

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

  // ── SLICE 2 · a typed question ────────────────────────────────────
  //  POST, because the operator sends something. It still writes nothing:
  //  the verb reflects a request body, not a mutation. The question is
  //  NOT recorded — this door has no conversation history and does not
  //  pretend to. If we later want Spine to remember, that is a durable
  //  object with a retention decision behind it, not a side effect of
  //  answering.
  //
  //  Same gate as the read above. Property is server-derived; a
  //  client-supplied property_id is refused, not ignored.
  router.post("/operator/ask-spine/ask", ...gate, async (req, res) => {
    try {
      const out = await askSpineAnswer.answer(pool, deps.anthropic, {
        property_id: req.operator.property_id,
        allowed_modules: req.operator.allowed_modules,
        question: (req.body && req.body.question) || "",
      });

      //  200 for every OUTCOME, including `unavailable`. The request was
      //  handled correctly; the assistant being unreachable is an answer
      //  about the assistant, and the caller distinguishes it by
      //  `outcome` rather than by having to parse an error shape. A 5xx
      //  here would make a working door look broken.
      return res.json({
        property_id: req.operator.property_id,   // echoed from the session
        asked_at: new Date().toISOString(),
        outcome: out.outcome,
        answer: out.answer,
        grounded_on: out.grounded_on,
        //  Openable records the answer is about, resolved by the service
        //  rather than parsed out of the model's sentence. Absent on any
        //  outcome that is not `answered`, because there is nothing the
        //  operator was told about to go and look at.
        references: out.references || [],
      });
    } catch (e) {
      //  A genuine server failure. Never shaped like an empty answer.
      console.error("ask-spine/ask error", e);
      return res.status(500).json({ error: "Could not answer that." });
    }
  });

  return router;
};
