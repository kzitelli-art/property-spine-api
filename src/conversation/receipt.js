/* ════════════════════════════════════════════════════════════════════
   conversation/receipt.js — RECEIPT COMPOSITION.

   The third shared conversational seam, extracted from the resident SMS
   path in src/comms/tenantlink.js. See docs/AGENT_CAPABILITY_SEAMS.md.

   ── THE LOAD-BEARING DISTINCTION ───────────────────────────────────
   A successful operating action does not prove that a text was
   delivered. A provider SID does not prove that the operating action
   occurred. These are TWO facts about TWO systems and this module never
   collapses them:

     operating receipt   what the canonical service actually committed
     delivery receipt    what the transport actually did with a message

   `composeReceipt` returns exactly those two, side by side. It publishes
   no merged verdict — no `ok`, no `sent`, no `success`. A caller that
   wants to know "did it work" must say which of the two it means, and
   the answer it gets is about that one only.

   ── PURITY ─────────────────────────────────────────────────────────
   `operatingReceipt` is pure over the COMMITTED canonical result. It may
   not infer from the original message that the write succeeded — so it
   never receives the message. Its input keys are whitelisted and an
   unrecognised key is refused, which is what makes that structural
   rather than aspirational: the resident's text cannot be smuggled in
   under any name.

   Where the committed row carries the fact (urgency, category, service
   outcome), the receipt reads it BACK from the row rather than repeating
   what was requested. Requested-vs-committed can differ — an idempotent
   create returns the pre-existing row — and the receipt describes what
   is there, not what was asked for.

   ── HONEST BLANK (§5) ──────────────────────────────────────────────
   An outcome that claims a durable object requires that object's id. If
   it is absent the receipt is a REFUSAL: `text` is null and nothing is
   said. A refused canonical write therefore produces no success receipt,
   by construction — the composer has nothing to say and says nothing.

   ── MOVE, NOT REDESIGN ─────────────────────────────────────────────
   Every string below is the tenantlink original, character for
   character, including the two holds that differ only in their opening
   word ("Got it —" vs "Thanks —"). Resident wording is unchanged, and
   tests/conversation_receipt_composition.test.js proves it against the
   pre-extraction source rather than trusting this note.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const OPERATING_OUTCOMES = [
  "work_order_opened",       // a canonical work order was created
  "clarification_appended",  // history was added to an existing work order
  "held_for_human",          // nothing was written; a person owns it now
  "balance_read",            // a live lease figure was read; nothing written
];

/*  Outcomes that ASSERT a durable object exists. Without its id the
 *  receipt refuses — the sentence would be a claim we cannot support. */
const OUTCOMES_REQUIRING_OBJECT = ["work_order_opened", "clarification_appended"];

/*  Why a message is held. These are the clarification module's terminal
 *  states plus the ordinary "not something we can act on" queue. The two
 *  wordings differ; the mapping is data, so neither can drift. */
const HOLD_TEXT = {
  ambiguous_open_set:
    "Thanks — you have more than one open request with us, so I'm passing this to the team to make sure it lands on the right one.",
  unrecognized_answer:       "Got it — your manager will follow up with you right here.",
  unusable_question_context: "Got it — your manager will follow up with you right here.",
  answer_to_resolved:        "Thanks — your manager will follow up with you right here.",
  not_actionable:            "Got it — your manager will follow up with you right here.",
};

const DELIVERY_STATES = ["not_attempted", "delivered", "failed"];

class ReceiptShapeError extends Error {
  constructor(message, code) { super(message); this.name = "ReceiptShapeError"; this.code = code; }
}

/*  A whitelist, not a validation convenience. The point is that there is
 *  no key under which the inbound message could arrive. */
function assertKeys(obj, allowed, label) {
  if (obj == null) return;
  if (typeof obj !== "object") throw new ReceiptShapeError(`${label} must be an object`, "not_an_object");
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new ReceiptShapeError(
        `${label}.${k} is not a recognised key — the receipt composer accepts only committed canonical facts (${allowed.join(", ")})`,
        "unknown_key");
    }
  }
}

const refusal = (outcome, code) => Object.freeze({
  kind: "operating_receipt",
  outcome,
  committed: false,
  object: null,
  text: null,                 // honest blank: nothing may be said
  isClarificationQuestion: false,
  serviceOutcome: null,
  requiresHuman: null,
  divergedFromDecision: false,
  refusal: code,
});

/*  ── OPERATING RECEIPT ──────────────────────────────────────────────
 *  outcome  which canonical step ran
 *  result   what that step RETURNED — never what it was asked to do
 *  context  server-derived naming only (the unit label comes from the
 *           resident's own lease row, not from anything they typed)
 */
function operatingReceipt({ outcome, result = null, context = null } = {}) {
  assertKeys(arguments[0], ["outcome", "result", "context"], "operatingReceipt input");
  assertKeys(context, ["unitLabel"], "context");
  if (!OPERATING_OUTCOMES.includes(outcome)) {
    throw new ReceiptShapeError(`unknown operating outcome ${JSON.stringify(outcome)}`, "unknown_outcome");
  }

  const unitLabel = (context && context.unitLabel) || "your unit";

  if (outcome === "held_for_human") {
    assertKeys(result, ["reasonCode"], "result");
    const reasonCode = result && result.reasonCode;
    const text = HOLD_TEXT[reasonCode];
    if (!text) return refusal(outcome, "unknown_hold_reason");
    return Object.freeze({
      kind: "operating_receipt", outcome,
      committed: false,           // a hold writes no durable object, and says so
      object: null, text,
      isClarificationQuestion: false,
      serviceOutcome: reasonCode,
      requiresHuman: true,
      divergedFromDecision: false,
      refusal: null,
    });
  }

  if (outcome === "balance_read") {
    assertKeys(result, ["balance", "rent"], "result");
    if (!result) return refusal(outcome, "no_balance_read");
    // Verbatim from the original, including the raw-`rent` truthiness test:
    // a numeric column arrives from pg as a string, so "0.00" is truthy and
    // the line is shown. Converting first would silently change the message.
    const bal = result.balance == null ? null : Number(result.balance);
    const rentSuffix = result.rent ? ` Rent is $${Number(result.rent).toFixed(2)}/month.` : "";
    const text = bal == null
      ? "Your balance isn't loaded in the system yet — your manager will confirm it here."
      : bal <= 0
        ? `You're all paid up — current balance $${bal.toFixed(2)}.${rentSuffix}`
        : `Your current balance is $${bal.toFixed(2)}.${rentSuffix}`;
    return Object.freeze({
      kind: "operating_receipt", outcome,
      committed: false,           // a read commits nothing
      object: null, text,
      isClarificationQuestion: false,
      serviceOutcome: null,
      requiresHuman: null,
      divergedFromDecision: false,
      refusal: null,
    });
  }

  if (outcome === "clarification_appended") {
    assertKeys(result, ["workOrder", "outcome", "escalated", "obligation_id"], "result");
    const wo = result && result.workOrder;
    if (!wo || !wo.id) return refusal(outcome, "no_committed_object");
    const serviceOutcome = result.outcome || null;
    const text =
      serviceOutcome === "escalated_emergency"
        ? "Thank you — I've marked this as an emergency and management has been notified in the system. If there is immediate danger to anyone, call 911 first."
        : serviceOutcome === "resolved_regular"
          ? `Thanks — that helps. Your ${unitLabel} request is recorded as a routine repair and stays open with the team.`
          : "Thanks — I've added that to your request. Your manager will follow up here.";
    return Object.freeze({
      kind: "operating_receipt", outcome,
      committed: true,
      object: Object.freeze({ type: "work_order", id: wo.id }),
      text,
      isClarificationQuestion: false,
      serviceOutcome,
      // The service positively determined this, both directions.
      requiresHuman: serviceOutcome === "unresolved",
      divergedFromDecision: false,
      refusal: null,
    });
  }

  // outcome === "work_order_opened"
  assertKeys(result, ["workOrder", "decision", "deduped"], "result");
  const wo = result && result.workOrder;
  if (!wo || !wo.id) return refusal(outcome, "no_committed_object");
  const decision = result.decision || null;
  if (!decision) return refusal(outcome, "no_governing_decision");

  // Read BACK from the committed row. Requested and committed can differ.
  const urgency = wo.urgency_status;
  const diverged = urgency !== decision.urgency_status;
  if (diverged) {
    console.error(
      `operatingReceipt: committed work order ${wo.id} is ${JSON.stringify(urgency)} but the governing decision was ` +
      `${JSON.stringify(decision.urgency_status)} — describing the committed row and flagging for a human.`);
  }

  let text;
  if (urgency === "emergency") {
    text = "Emergency received — management has been notified in the system. If there is immediate danger to anyone, call 911 first.";
  } else if (urgency === "needs_confirmation") {
    // The question is the governed decision's, not the row's — the row does
    // not carry it. Without one there is nothing to ask, and a confirmation
    // request that asks nothing is a silent default.
    if (!decision.clarifying_question) return refusal(outcome, "confirmation_without_question");
    text = `Got it — I've opened a request for ${unitLabel}. ${decision.clarifying_question}`;
  } else {
    text = `Got it — ${String(wo.field_category || "maintenance").replace("_", "/")} request opened for ${unitLabel}. We'll keep you updated right here.`;
  }

  return Object.freeze({
    kind: "operating_receipt", outcome,
    committed: true,
    object: Object.freeze({ type: "work_order", id: wo.id }),
    text,
    // A needs_confirmation open IS a question to the resident. Nothing else
    // is — an appended clarification can leave a work order in
    // needs_confirmation without our having asked anything new.
    isClarificationQuestion: urgency === "needs_confirmation",
    serviceOutcome: result.deduped ? "deduped" : "created",
    requiresHuman: diverged ? true : null,
    divergedFromDecision: diverged,
    refusal: null,
  });
}

/*  ── DELIVERY RECEIPT ───────────────────────────────────────────────
 *  What the transport did. Nothing about operating meaning.
 *
 *  `delivered` is derived from `state` and from nothing else. A provider
 *  reference may be present on a FAILED send — carriers hand out an id
 *  and then fail the message — and it still does not make it delivered.
 */
function deliveryReceipt({ state, providerRef = null, failureReason = null } = {}) {
  assertKeys(arguments[0], ["state", "providerRef", "failureReason"], "deliveryReceipt input");
  if (!DELIVERY_STATES.includes(state)) {
    throw new ReceiptShapeError(`unknown delivery state ${JSON.stringify(state)}`, "unknown_state");
  }
  if (state === "failed" && !failureReason) {
    throw new ReceiptShapeError(
      "a failed delivery requires a reason — an unexplained failure is a blank pretending to be a fact",
      "failure_without_reason");
  }
  if (state === "not_attempted" && (providerRef || failureReason)) {
    throw new ReceiptShapeError(
      "not_attempted carries no provider reference and no failure — nothing happened",
      "not_attempted_with_evidence");
  }
  return Object.freeze({
    kind: "delivery_receipt",
    state,
    attempted: state !== "not_attempted",
    delivered: state === "delivered",   // from `state` alone, never from providerRef
    providerRef: providerRef || null,
    failureReason: failureReason || null,
  });
}

/*  ── COMPOSITION ────────────────────────────────────────────────────
 *  Two facts, side by side, permanently distinguishable. Exactly two
 *  keys: there is deliberately no place to put a merged verdict, and the
 *  result is frozen so no caller can add one afterwards.
 */
function composeReceipt({ operating, delivery } = {}) {
  assertKeys(arguments[0], ["operating", "delivery"], "composeReceipt input");
  if (!operating || operating.kind !== "operating_receipt") {
    throw new ReceiptShapeError(
      "operating must be an operatingReceipt product — a hand-built object could describe delivery as operating truth",
      "not_an_operating_receipt");
  }
  if (!delivery || delivery.kind !== "delivery_receipt") {
    throw new ReceiptShapeError(
      "delivery must be a deliveryReceipt product — a hand-built object could describe operating success as delivery",
      "not_a_delivery_receipt");
  }
  return Object.freeze({ operating, delivery });
}

module.exports = {
  OPERATING_OUTCOMES,
  OUTCOMES_REQUIRING_OBJECT,
  DELIVERY_STATES,
  HOLD_TEXT,
  ReceiptShapeError,
  operatingReceipt,
  deliveryReceipt,
  composeReceipt,
};
