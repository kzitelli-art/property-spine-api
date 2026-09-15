// ════════════════════════════════════════════════════════════════════
//  ask_spine.js — THE ASK SPINE DOOR
//
//  GET  /operator/ask-spine/attention    slice 1 — the one fixed question
//  POST /operator/ask-spine/ask          slice 2 — read-only compatibility door
//  POST /operator/ask-spine/message      one conversational prose door
//
//  Same authority seam as the staff agent and every maintenance door —
//  property is server-derived and never accepted from the browser. Its
//  question endpoints remain read-only siblings of staff_agent.js. The
//  message door selects the one supported application action on the server;
//  all other prose delegates to the established Ask Spine answer owner. It is
//  not a generic conversational writer and records no dashboard transcript.
//
//  The fixed and compatibility question doors below still write nothing.
//  A message-selected proposal writes nothing; the separately named opaque
//  confirmation door delegates to the one canonical application-send command.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function askSpine(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const askSpineService = require("./ask_spine_service");
  const askSpineAnswer = require("./ask_spine_answer");
  const staffLeasingIntent = require("../leasing/staff_sms_intent");
  const { createComplianceReferenceService } =
    require("../asset/compliance_references");

  const options = deps || {};
  const { pool } = options;
  if (!pool) throw new Error("ask_spine module requires a pool");
  const complianceReferences = options.complianceReferenceService ||
    createComplianceReferenceService({
      secret: options.complianceReferenceSecret || process.env.COMPLIANCE_REFERENCE_SECRET,
    });

  function conversationalApplicationAction() {
    const action = typeof options.conversationalApplicationAction === "function"
      ? options.conversationalApplicationAction()
      : options.conversationalApplicationAction;
    if (!action || typeof action.run !== "function") {
      throw Object.assign(new Error("conversational application action is unavailable"), {
        httpStatus: 503,
      });
    }
    return action;
  }

  function exactBody(req, allowed) {
    const keys = Object.keys((req && req.body) || {}).sort();
    return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
  }

  function hasQueryClaims(req) {
    return !!(req && req.query && Object.keys(req.query).length);
  }

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

  const MESSAGE_ACTION_INTENTS = new Set([
    "capture_tour", "clarify_tour_standing", "send_application", "application_target",
  ]);

  async function answerForOperator(req, question) {
    return askSpineAnswer.answer(pool, options.anthropic, {
      property_id: req.operator.property_id,
      allowed_modules: req.operator.allowed_modules,
      operator_user_id: req.operator.id,
      primary_for_modules: req.operator.primary_for_modules,
      question,
      mintComplianceReference: complianceReferences.mintReference,
      // Late-bound because the applications module is composed below this one.
      applicationsService: options.applicationsService || null,
    });
  }

  function readEnvelope(operator, out, { discriminated = false } = {}) {
    return {
      ...(discriminated ? {
        kind: out.outcome === "answered" ? "answer" : "clarification_or_refusal",
      } : {}),
      property_id: operator.property_id,
      asked_at: new Date().toISOString(),
      outcome: out.outcome,
      answer: out.answer,
      grounded_on: out.grounded_on,
      references: out.references || [],
    };
  }

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
      const out = await answerForOperator(req, (req.body && req.body.question) || "");

      //  200 for every OUTCOME, including `unavailable`. The request was
      //  handled correctly; the assistant being unreachable is an answer
      //  about the assistant, and the caller distinguishes it by
      //  `outcome` rather than by having to parse an error shape. A 5xx
      //  here would make a working door look broken.
      return res.json(readEnvelope(req.operator, out));
    } catch (e) {
      //  A genuine server failure. Never shaped like an empty answer.
      console.error("ask-spine/ask error", e);
      return res.status(500).json({ error: "Could not answer that." });
    }
  });

  // ── ONE CONVERSATIONAL DOOR · reads + one application action ─────
  //  The browser supplies only prose. The server's canonical leasing intent
  //  classifier selects the sole supported action; every other message goes
  //  to the existing read-only Ask Spine owner. The parsed intent is passed
  //  into the SAME action instance used by staff SMS, so it is classified
  //  exactly once and no browser vocabulary selects the writer.
  router.post("/operator/ask-spine/message", ...gate, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!exactBody(req, ["message"]) || hasQueryClaims(req)) {
      return res.status(400).json({
        kind: "clarification_or_refusal",
        outcome: "invalid_request",
        answer: "Send only the conversational message. Scope and action authority are server-derived.",
      });
    }
    const message = String(req.body.message || "");
    const intent = staffLeasingIntent.readStaffLeasingIntent(message);
    try {
      if (!MESSAGE_ACTION_INTENTS.has(intent.intent)) {
        const out = await answerForOperator(req, message);
        return res.json(readEnvelope(req.operator, out, { discriminated: true }));
      }
      const out = await conversationalApplicationAction().run(pool, {
        transport: "dashboard",
        userId: req.operator.id,
        body: message,
        intent,
        propertyContext: {
          outcome: "one",
          propertyId: req.operator.property_id,
          allowedModules: req.operator.allowed_modules,
        },
      });
      const status = Number(out.http_status) || 200;
      delete out.http_status;
      return res.status(status).json({
        kind: out.confirmation_required && out.confirmation
          ? "application_send_proposal"
          : "clarification_or_refusal",
        ...out,
      });
    } catch (error) {
      console.error("ask-spine/message error", error);
      return res.status(error.httpStatus || 500).json({
        kind: "clarification_or_refusal",
        outcome: error.code || "unavailable",
        answer: error.publicMessage || "That message could not be handled. Nothing was sent.",
      });
    }
  });

  // ── OPAQUE CONFIRMATION · no prose classification ────────────────
  //  The browser may return only the token from an application_send_proposal.
  //  It never supplies property, module, Person, conversion, unit, space,
  //  actor, action code or idempotency identity.

  router.post("/operator/ask-spine/application-send/confirm", ...gate, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!exactBody(req, ["confirmation"]) || hasQueryClaims(req)) {
      return res.status(400).json({
        outcome: "invalid_request",
        receipt: "Send only the server-issued confirmation receipt. Nothing was sent.",
      });
    }
    try {
      const out = await conversationalApplicationAction().run(pool, {
        transport: "dashboard",
        userId: req.operator.id,
        body: "",
        intent: {
          intent: "confirm_application",
          confirmation: String(req.body.confirmation || ""),
          sendApplication: true,
        },
        propertyContext: {
          outcome: "one",
          propertyId: req.operator.property_id,
          allowedModules: req.operator.allowed_modules,
        },
      });
      const status = Number(out.http_status) || 200;
      delete out.http_status;
      return res.status(status).json(out);
    } catch (error) {
      console.error("ask-spine/application-send/confirm error", error);
      return res.status(error.httpStatus || 500).json({
        outcome: error.code || "unavailable",
        receipt: error.publicMessage || "The application confirmation could not be completed. Nothing was sent.",
      });
    }
  });

  return router;
};
