// ════════════════════════════════════════════════════════════════════
// AI LEASING STRATEGY RUNTIME — thin adapter over the canonical strategy core
//
// Capture-first rule:
//   A broken or absent strategy deployment must never lose a real lead or
//   inbound message. Assignment runs inside a savepoint and may fail soft to
//   an honestly unassigned, generic AI path.
//
// Evidence-integrity rule:
//   Once a strategy directive actually shaped a model response, the outbound
//   message and its exact attribution commit together. There is no fail-soft
//   path that sends strategy-shaped copy and drops the evidence.
// ════════════════════════════════════════════════════════════════════
"use strict";

const strategy = require("./ai_leasing_strategy");

let savepointCounter = 0;
function nextSavepointName() {
  savepointCounter = (savepointCounter + 1) % 1000000;
  return `ai_leasing_strategy_${savepointCounter}`;
}

async function assignForConversationWithoutBlockingCapture(client, args, { log = console.error } = {}) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("assignForConversationWithoutBlockingCapture requires a database client");
  }
  const savepoint = nextSavepointName();
  await client.query(`savepoint ${savepoint}`);
  try {
    const out = await strategy.assignConversationStrategy(client, args);
    await client.query(`release savepoint ${savepoint}`);
    return out;
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
    if (typeof log === "function") {
      log("[ai-leasing-strategy] assignment failed; conversation remains honestly unassigned", {
        code: error && error.code ? error.code : "assignment_failed",
        conversation_id: args && args.conversationId,
        property_id: args && args.propertyId,
      });
    }
    return {
      assigned: false,
      created: false,
      reason: "assignment_failed",
      error_code: error && error.code ? error.code : "assignment_failed",
    };
  }
}

function validatedEnvelopeForRuntime(envelope, identity) {
  return strategy.validatedEnvelopeForRuntime(envelope, identity);
}

function appendStrategyDirective(system, envelope) {
  const base = String(system || "");
  if (!envelope) return base;
  return `${base}\n\n${strategy.buildStrategyDirective(envelope)}`;
}

function modelGenerationUsedStrategy({ envelope, modelReturnedText, finalBodyOrigin = "model" }) {
  return !!(
    envelope &&
    modelReturnedText === true &&
    finalBodyOrigin === "model"
  );
}

const DETERMINISTIC_REPLACEMENT_CODES = Object.freeze(new Set([
  "local_law_redirected",
  "esa_fee_redirected",
  "fairhousing_redirected",
  "inventory_regrounded",
  "general_recovered",
  "empty_recovered",
]));

function finalBodyRetainsStrategyCredit({ strategyApplied, policyCode, generationError = null }) {
  if (!strategyApplied || generationError) return false;
  return !DETERMINISTIC_REPLACEMENT_CODES.has(String(policyCode || ""));
}

module.exports = {
  assignForConversationWithoutBlockingCapture,
  validatedEnvelopeForRuntime,
  appendStrategyDirective,
  modelGenerationUsedStrategy,
  DETERMINISTIC_REPLACEMENT_CODES,
  finalBodyRetainsStrategyCredit,
};
