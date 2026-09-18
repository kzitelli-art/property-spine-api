/* ====================================================================
   conversation/staff_sms_router.js - ONE SAFE FORK IN THE STAFF LINE.

   Work messages keep the proven technician path. Only a clear question
   about an already-supported Ask Spine subject may take the read-only path.
   Pure: no database, model, write, or transport.
   ==================================================================== */
"use strict";

//  NOTE: leasing_knowledge is deliberately NOT imported here. This file
//  used to import it and never call it, which reads as an oversight and
//  cost one wrong diagnosis — the registry IS consulted, through
//  askSpineAnswer.questionSubject, which calls isKnowledgeRead on its
//  first line. One consultation, one owner.
const technicianIntent = require("./technician_intent");
const askSpineAnswer = require("../agent/ask_spine_answer");
const staffLeasingIntent = require("../leasing/staff_sms_intent");

const ACTION_VERBS = "send|text|notify|create|change|update|waive|approve|offer|schedule|book|cancel|assign|reassign|invite";
const ACTION_REQUEST_RX = new RegExp(
  `^\\s*(?:please\\s+)?(?:(?:${ACTION_VERBS})\\b|` +
  `(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:${ACTION_VERBS})\\b|` +
  `(?:can|could|should|may)\\s+(?:i|we)\\s+(?:${ACTION_VERBS})\\b)`,
  "i"
);

// Ask Spine owns the subject. This router owns only whether the staff turn is
// shaped like a read rather than a report or action. Auxiliary-led questions
// and the terse tour-schedule wording people use in search boxes/texts are
// reads; a recognised domain alone is not enough ("pricing changed yesterday"
// remains a statement on the technician rail).
const GOVERNED_QUESTION_LEAD_RX = /^\s*(?:has|have|had)\b/i;
const TOUR_SCHEDULE_SHORTHAND_RX =
  /^\s*(?:(?:next|upcoming)\s+)?tours?\s+(?:availability|schedule|times?|openings?|slots?|hosts?|coverage)\s*[?!.]*\s*$/i;

function looksLikeGovernedRead(text, subject) {
  const value = String(text || "");
  return technicianIntent.looksLikeQuestion(value)
    || GOVERNED_QUESTION_LEAD_RX.test(value)
    || (subject === "tour_schedule" && TOUR_SCHEDULE_SHORTHAND_RX.test(value));
}

function routeStaffSmsTurn({ text, attachments = [] } = {}) {
  const technician = technicianIntent.readTurn({ text, attachments });
  const personalAttention = askSpineAnswer.isPersonalAttentionQuestion(text);
  const leasing = staffLeasingIntent.readStaffLeasingIntent(text);

  // Media always remains a technician turn. Leasing action language is checked
  // before the technician's broad action vocabulary so "send the application"
  // cannot be misread as a maintenance dispatch.
  if (technicianIntent.hasAttachments(attachments)) {
    return Object.freeze({ destination: "technician", technician, leasing, subject: null });
  }

  //  ── ONE PREDICATE, AND IT IS ALREADY REACHED FROM HERE ───────────
  //  "whats our pet policy" used to fall to the technician rail over SMS
  //  while the web answered it. The cause was NOT that this router failed to
  //  consult the knowledge registry — `questionSubject` consults it on its
  //  first line (ask_spine_answer.js:445). The cause was that the registry's
  //  own question-shape test put \b after bare interrogatives, so `what`
  //  matched and `whats` did not.
  //
  //  Fixing that ONE line in leasing_knowledge.isSelfRead fixed both rails
  //  at once. An earlier version of this commit ALSO added
  //  `|| leasingKnowledge.isKnowledgeRead(text)` here; removing it changes
  //  no destination for any input, because questionSubject already returns
  //  "leasing_knowledge" for exactly that set. It was dead code guarded by a
  //  test that asserted its presence rather than its effect.
  if (askSpineAnswer.questionSubject(text) === "leasing_knowledge") {
    return Object.freeze({ destination: "ask_spine", technician, leasing, subject: "leasing_knowledge" });
  }

  if (leasing.intent !== "unclear") {
    return Object.freeze({ destination: "leasing", technician, leasing, subject: null });
  }

  // Action requests remain technician turns. A personal work
  // question is checked before the technician's legacy list_work shorthand so
  // dashboard and SMS can share the same person-scoped Ask Spine read.
  if (ACTION_REQUEST_RX.test(String(text || ""))) {
    return Object.freeze({ destination: "technician", technician, leasing, subject: null });
  }

  if (personalAttention) {
    return Object.freeze({ destination: "ask_spine", technician, leasing, subject: "work" });
  }

  // Other work actions, work-list questions and field findings stay on the
  // technician path. The read path can never intercept a proven action.
  if (technician.intent !== "unclear") {
    return Object.freeze({ destination: "technician", technician, leasing, subject: null });
  }

  const subject = askSpineAnswer.questionSubject(text);
  if (!looksLikeGovernedRead(text, subject) || subject === "work") {
    return Object.freeze({ destination: "technician", technician, leasing, subject: null });
  }

  return Object.freeze({ destination: "ask_spine", technician, leasing, subject });
}

module.exports = { routeStaffSmsTurn, ACTION_REQUEST_RX };
