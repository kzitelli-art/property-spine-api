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

  // Work actions, work-list questions, field findings and all media stay on
  // the technician path. The read path can never intercept a proven action.
  if (technician.intent !== "unclear" || technicianIntent.hasAttachments(attachments)) {
    return Object.freeze({ destination: "technician", technician, subject: null });
  }

  const subject = askSpineAnswer.questionSubject(text);
  if (ACTION_REQUEST_RX.test(String(text || ""))
      || !technicianIntent.looksLikeQuestion(text) || subject === "work") {
    return Object.freeze({ destination: "technician", technician, subject: null });
  }

  return Object.freeze({ destination: "ask_spine", technician, subject });
}

module.exports = { routeStaffSmsTurn, ACTION_REQUEST_RX };
