"use strict";

const TOUR_RX = /\b(tour|showing|showed|walk[- ]?through)\b/i;
const SEND_APPLICATION_RX = /\b(send|text|share|give)\b[^.!?]{0,48}\bapplication\b|\bapplication\b[^.!?]{0,48}\b(send|text|share)\b/i;
const TARGET_REPLY_RX = /\b(unit|bed|space|room)\s*[#-]?\s*[a-z0-9][a-z0-9-]*\b/i;
const QUESTION_RX = /\?\s*$|^\s*(who|what|where|when|why|how|is|are|do|does|did|can|could|would|should)\b/i;

const STANDING_PATTERNS = Object.freeze([
  ["ready_to_apply", /\bready\s+to\s+apply\b|\bwants?\s+to\s+apply\b|\bstart\s+(the\s+)?application\b/i],
  ["hot_lead", /\bhot\s+lead\b|\bvery\s+interested\b|\bstrong\s+(lead|prospect)\b/i],
  ["possible", /\bpossible\b|\bmaybe\b|\bneeds?\s+something\s+to\s+change\b/i],
  ["not_moving_forward", /\bnot\s+moving\s+forward\b|\bnot\s+interested\b|\bdoesn'?t\s+want\s+it\b/i],
]);

function standingFrom(text) {
  const found = STANDING_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([standing]) => standing);
  return found.length === 1 ? found[0] : null;
}

function isBareStandingReply(text, standing) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const allowed = {
    ready_to_apply: ["ready to apply", "wants to apply", "want to apply"],
    hot_lead: ["hot lead", "very interested"],
    possible: ["possible", "maybe"],
    not_moving_forward: ["not moving forward", "not interested"],
  };
  return !!standing && (allowed[standing] || []).includes(normalized);
}

function readStaffLeasingIntent(text) {
  const raw = String(text || "").trim();
  const hasTour = TOUR_RX.test(raw);
  const sendApplication = SEND_APPLICATION_RX.test(raw);
  const standing = standingFrom(raw);
  const hasTarget = TARGET_REPLY_RX.test(raw);
  const isQuestion = QUESTION_RX.test(raw);

  if (standing && !isQuestion && (hasTour || isBareStandingReply(raw, standing))) {
    return Object.freeze({
      intent: "capture_tour",
      standing,
      sendApplication,
      hasTarget,
      text: raw,
    });
  }

  if (hasTour && /\b(went|was|finished|completed|done)\b/i.test(raw)) {
    return Object.freeze({
      intent: "clarify_tour_standing",
      standing: null,
      sendApplication,
      hasTarget,
      text: raw,
    });
  }

  if (sendApplication) {
    return Object.freeze({
      intent: "send_application",
      standing: null,
      sendApplication: true,
      hasTarget,
      text: raw,
    });
  }

  if (hasTarget && /\b(application|apply)\b/i.test(raw) && !isQuestion) {
    return Object.freeze({
      intent: "application_target",
      standing: null,
      sendApplication: true,
      hasTarget: true,
      text: raw,
    });
  }

  return Object.freeze({
    intent: "unclear",
    standing: null,
    sendApplication: false,
    hasTarget: false,
    text: raw,
  });
}

module.exports = {
  readStaffLeasingIntent,
  _private: {
    standingFrom,
    isBareStandingReply,
    TOUR_RX,
    SEND_APPLICATION_RX,
    TARGET_REPLY_RX,
    QUESTION_RX,
  },
};
