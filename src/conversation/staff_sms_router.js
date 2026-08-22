/* ====================================================================
   conversation/staff_sms_router.js - ONE SAFE FORK IN THE STAFF LINE.

   Work messages keep the proven technician path. Only a clear question
   about an already-supported Ask Spine subject may take the read-only path.
   Pure: no database, model, write, or transport.
   ==================================================================== */
"use strict";

const technicianIntent = require("./technician_intent");
const askSpineAnswer = require("../agent/ask_spine_answer");

const ACTION_VERBS = "send|text|notify|create|change|update|waive|approve|offer|schedule|book|cancel|assign|reassign|invite";
const ACTION_REQUEST_RX = new RegExp(
  `^\\s*(?:please\\s+)?(?:(?:${ACTION_VERBS})\\b|` +
  `(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:${ACTION_VERBS})\\b|` +
  `(?:can|could|should|may)\\s+(?:i|we)\\s+(?:${ACTION_VERBS})\\b)`,
  "i"
);

function routeStaffSmsTurn({ text, attachments = [] } = {}) {
  const technician = technicianIntent.readTurn({ text, attachments });
  const personalAttention = askSpineAnswer.isPersonalAttentionQuestion(text);

  // Media and action requests always remain technician turns. A personal work
  // question is checked before the technician's legacy list_work shorthand so
  // dashboard and SMS can share the same person-scoped Ask Spine read.
  if (technicianIntent.hasAttachments(attachments) || ACTION_REQUEST_RX.test(String(text || ""))) {
    return Object.freeze({ destination: "technician", technician, subject: null });
  }

  if (personalAttention) {
    return Object.freeze({ destination: "ask_spine", technician, subject: "work" });
  }

  // Other work actions, work-list questions and field findings stay on the
  // technician path. The read path can never intercept a proven action.
  if (technician.intent !== "unclear") {
    return Object.freeze({ destination: "technician", technician, subject: null });
  }

  const subject = askSpineAnswer.questionSubject(text);
  if (!technicianIntent.looksLikeQuestion(text) || subject === "work") {
    return Object.freeze({ destination: "technician", technician, subject: null });
  }

  return Object.freeze({ destination: "ask_spine", technician, subject });
}

module.exports = { routeStaffSmsTurn, ACTION_REQUEST_RX };
