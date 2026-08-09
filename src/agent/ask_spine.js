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

  // ── BUILD 1 · a governed intent, over canonical work-order truth ──
  //
  //  Same door, same gate, no shared product semantics with `attention`
  //  above — that capability is `maintenance.attention`, deliberately
  //  unfrozen, and nothing here reads it or its obligations query.
  //
  //  GET because this changes nothing about the property. The receipt it
  //  writes is audit history, not an operational consequence.
  //
  //  There is NO composer, NO card, NO conversational state and NO
  //  action here. Build 1 answers a resolved intent; Build 2 makes that
  //  conversational.
  const intentExecutor = require("../askspine/intent_executor");
  const renderer = require("../askspine/renderer");
  const receipts = require("../askspine/receipt_service");

  const INTENT = "maintenance.completion_without_valid_proof";

  router.get("/operator/ask-spine/completion-proof-gaps", ...gate, async (req, res) => {
    let execution;
    try {
      execution = await intentExecutor.execute(pool, {
        intent_slug: INTENT,
        property_id: req.operator.property_id,
        allowed_modules: req.operator.allowed_modules,
      });
    } catch (e) {
      //  A failure is a failure. It must never reach the browser shaped
      //  like an empty result.
      console.error("ask-spine/completion-proof-gaps execute error", e);
      return res.status(500).json({ error: "Could not complete the governed check." });
    }

    let rendered;
    try {
      rendered = renderer.render(execution);
    } catch (e) {
      //  The renderer refused an unknown conclusion code rather than
      //  improvising. That is a defect in this build, not in the data,
      //  and it must not become a sentence.
      console.error("ask-spine/completion-proof-gaps render refused", e);
      return res.status(500).json({ error: "Could not complete the governed check." });
    }

    //  RULING 17 — a decision-grade answer whose required receipt did not
    //  persist is not a decision-grade answer.
    let receipt = null;
    if (receipts.receiptRequired(execution)) {
      try {
        receipt = await receipts.writeReceipt(pool, {
          execution, rendered,
          property_id: req.operator.property_id,
          //  `.id` IS the user id. `req.operator.user_id` does not exist and
          //  is undefined at runtime, silently — it once made every governed
          //  maintenance action anonymous, which is why there is a gate.
          actor: { user_id: req.operator.id, session_id: req.operator.session_id },
        });
      } catch (e) {
        console.error("ask-spine/completion-proof-gaps receipt persistence failed", e);
        const degraded = { ...execution,
          coverage_state: intentExecutor.COVERAGE_STATES.UNAVAILABLE,
          conclusion_code: "unavailable_source_cannot_answer",
          //  The internal reason distinguishes this from a source read
          //  failure; the operator-facing sentence deliberately does not.
          internal_reason: "receipt_persistence_failure",
          supporting_records: [], totals: null };
        return res.json({
          property_id: req.operator.property_id,
          intent_slug: INTENT,
          asked_at: new Date().toISOString(),
          coverage_state: degraded.coverage_state,
          conclusion_code: degraded.conclusion_code,
          answer: renderer.render(degraded).answer,
          boundedness_note: null,
          supporting_records: [],
          totals: null,
          source_outcomes: execution.source_outcomes,
          contract: execution.contract,
          receipt_id: null,
        });
      }
    }

    return res.json({
      //  Echoed from the SESSION, not the request.
      property_id: req.operator.property_id,
      intent_slug: INTENT,
      asked_at: new Date().toISOString(),
      coverage_state: execution.coverage_state,
      conclusion_code: execution.conclusion_code,
      answer: rendered.answer,
      boundedness_note: rendered.boundedness_note,
      supporting_records: execution.supporting_records,
      totals: execution.totals,
      source_outcomes: execution.source_outcomes,
      evidence: execution.evidence,
      contract: execution.contract,
      receipt_id: receipt ? receipt.id : null,
    });
  });

  return router;
};
