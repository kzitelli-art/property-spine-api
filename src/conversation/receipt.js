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
  //  ── technician / operations line (Phase 2) ──
  "work_accepted",           // a technician took ownership of assigned work
  "en_route_recorded",       // they are on the way
  "no_access_recorded",      // they could not get in
  "blocked_recorded",        // something else stops the work
  "finding_recorded",        // what they saw or did
  "evidence_recorded",       // a photo arrived
  "completion_blocked",      // they say finished; proof is missing
  "work_completed",          // governed completion closed it
  "work_list",               // what is on their plate
  "work_reference_needed",   // which work they meant is not established
  "authorization_refused",   // they asked for something that is not theirs
  "governed_read",           // Ask Spine read; no operating fact was written
  //  ── staff leasing / operations line ──
  "leasing_clarification",   // no write; a missing person/standing/target is named
  "tour_outcome_recorded",   // canonical tour completion + conversion rail committed
  "application_invitation_prepared", // canonical invitation state committed; dispatch is explicit
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
  //  A question we could not deliver. Found by the full-schema persistence
  //  case: the seam correctly held for a human, and then `held()` THREW on
  //  an unknown hold reason — so the claim was flagged and the resident was
  //  told NOTHING. A hold that cannot speak is the "captured, never
  //  acknowledged" state this vocabulary exists to prevent. Every reachable
  //  hold state must have text here, or the hold is silent.
  question_not_delivered:    "Got it — your manager will follow up with you right here.",
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

  if (outcome === "governed_read") {
    assertKeys(result, ["answer", "readOutcome", "isClarificationQuestion"], "result");
    const text = String(result && result.answer || "").trim();
    if (!text) return refusal(outcome, "no_governed_answer");
    return Object.freeze({
      kind: "operating_receipt", outcome,
      committed: false,
      object: null,
      text,
      isClarificationQuestion: !!result.isClarificationQuestion,
      serviceOutcome: result.readOutcome || null,
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

  if (LEASING_OUTCOMES.includes(outcome)) {
    return leasingReceipt({ outcome, result });
  }

  //  ── TECHNICIAN OUTCOMES ─────────────────────────────────────────
  //
  //  THE PRODUCT BAR. Every reply closes the loop:
  //      what was recorded → which work → what remains open → what next.
  //
  //  Never a status word, a uuid, a constraint name or a routing term. The
  //  work is named the way the technician would name it — "the Unit 302
  //  sink leak" — from the property's own title and unit, falling back to
  //  the sayable reference only when there is no descriptive label.
  //
  //  Same rules as everything above: text only from a committed result, and
  //  an outcome asserting a durable object needs that object's id.
  if (TECHNICIAN_OUTCOMES.includes(outcome)) {
    return technicianReceipt({ outcome, result });
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

const LEASING_OUTCOMES = [
  "leasing_clarification",
  "tour_outcome_recorded",
  "application_invitation_prepared",
];

function leasingReceipt({ outcome, result }) {
  const r = result || {};

  if (outcome === "leasing_clarification") {
    assertKeys(r, ["answer", "reasonCode", "isQuestion"], "result");
    const text = String(r.answer || "").trim();
    if (!text) return refusal(outcome, "no_clarification");
    return Object.freeze({
      kind: "operating_receipt",
      outcome,
      committed: false,
      object: null,
      text,
      isClarificationQuestion: r.isQuestion !== false,
      serviceOutcome: r.reasonCode || null,
      requiresHuman: null,
      divergedFromDecision: false,
      refusal: null,
    });
  }

  if (outcome === "tour_outcome_recorded") {
    assertKeys(r, ["tourId", "conversionId", "prospectName", "standingLabel", "nextPrompt"], "result");
    if (!r.tourId || !r.conversionId) return refusal(outcome, "no_committed_object");
    const name = String(r.prospectName || "the prospect").trim();
    const standing = String(r.standingLabel || "the recorded outcome").trim();
    const next = String(r.nextPrompt || "").trim();
    return Object.freeze({
      kind: "operating_receipt",
      outcome,
      committed: true,
      object: Object.freeze({ type: "leasing_conversion", id: r.conversionId }),
      text: `Recorded ${name}'s tour as ${standing}.${next ? ` ${next}` : ""}`,
      isClarificationQuestion: !!next,
      serviceOutcome: "recorded",
      requiresHuman: null,
      divergedFromDecision: false,
      refusal: null,
    });
  }

  assertKeys(r, ["invitationId", "prospectName", "targetLabel", "dispatched", "capture"], "result");
  if (!r.invitationId) return refusal(outcome, "no_committed_object");
  if (r.capture != null) {
    assertKeys(r.capture, ["tourId", "standingLabel"], "result.capture");
    if (!r.capture.tourId) return refusal(outcome, "capture_without_tour");
  }
  const name = String(r.prospectName || "the prospect").trim();
  const target = String(r.targetLabel || "the selected home").trim();
  const capturePrefix = r.capture
    ? `Recorded the tour as ${String(r.capture.standingLabel || "Ready to Apply").trim()}. `
    : "";
  const text = r.dispatched
    ? `${capturePrefix}Application sent to ${name} for ${target}.`
    : `${capturePrefix}Application prepared for ${name} at ${target}, but the tenant text did not send. The invitation is recorded for retry.`;
  return Object.freeze({
    kind: "operating_receipt",
    outcome,
    committed: true,
    object: Object.freeze({ type: "application_invitation", id: r.invitationId }),
    text,
    isClarificationQuestion: false,
    serviceOutcome: r.dispatched ? "provider_dispatched" : "prepared_not_dispatched",
    requiresHuman: r.dispatched ? null : true,
    divergedFromDecision: false,
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


/*  ── THE TECHNICIAN COMPOSER ────────────────────────────────────────
 *  Split out because its rules differ in ONE way from the resident side:
 *  it names the work. A resident already knows which request they made; a
 *  technician holds several at once and a reply that does not say which
 *  one it changed is a reply they have to go and check.
 */
const TECHNICIAN_OUTCOMES = [
  "work_accepted", "en_route_recorded", "no_access_recorded", "blocked_recorded",
  "finding_recorded", "evidence_recorded", "completion_blocked", "work_completed",
  "work_list", "work_reference_needed", "authorization_refused",
];

/*  How the work is named to a technician. Descriptive first, because that
 *  is how they think about it; the sayable number only when there is
 *  nothing better. Never a uuid, ever. */
function workLabelOf(work) {
  if (!work) return null;
  const title = String(work.title || "").replace(/^EMERGENCY:\s*/i, "").trim();
  const unit = work.unit_number ? `Unit ${work.unit_number}` : null;
  if (title && unit) return `${unit} ${title.toLowerCase()}`;
  if (title) return title.toLowerCase();
  if (unit) return `${unit} request`;
  if (work.work_order_ref != null) return `Work Order ${work.work_order_ref}`;
  return null;
}

function technicianReceipt({ outcome, result }) {
  assertKeys(result, ["work", "progress", "serviceOutcome", "question", "reason",
                      "verdict", "items", "missing", "evidenceAttempted", "storageState",
                      "residentUpdateQueued", "residentUpdateFailed"], "result");
  const r = result || {};
  const work = r.work || null;
  const label = workLabelOf(work);
  const named = label ? `the ${label}` : "that work";

  const say = (text, over = {}) => Object.freeze(Object.assign({
    kind: "operating_receipt", outcome,
    committed: false, object: null, text,
    isClarificationQuestion: false,
    serviceOutcome: r.serviceOutcome || null,
    requiresHuman: null, divergedFromDecision: false, refusal: null,
  }, over));

  //  Everything that claims a durable field fact needs that fact's id.
  const NEEDS_PROGRESS = ["en_route_recorded", "no_access_recorded", "blocked_recorded",
                          "finding_recorded", "work_completed", "completion_blocked"];
  if (NEEDS_PROGRESS.includes(outcome) && !(r.progress && r.progress.id)) {
    return refusal(outcome, "no_committed_object");
  }
  if (NEEDS_PROGRESS.includes(outcome) && !label) return refusal(outcome, "no_sayable_work");
  const committedOn = (extra) => say(extra, {
    committed: true, object: Object.freeze({ type: "work_order_progress", id: r.progress.id }),
  });

  switch (outcome) {
    case "work_accepted": {
      if (!(work && work.id)) return refusal(outcome, "no_committed_object");
      if (!label) return refusal(outcome, "no_sayable_work");
      return say(r.serviceOutcome === "replayed"
        ? `You already have ${named} — it's yours and in progress.`
        : `Accepted. ${cap(named)} is now yours and in progress.`,
        { committed: true, object: Object.freeze({ type: "work_order", id: work.id }) });
    }

    case "en_route_recorded":
      return committedOn(`Got it — you're on the way to ${named}. I'll keep it open until you tell me how it went.`);

    case "no_access_recorded":
      //  NOT "I've let the resident know" — that was a DELIVERY claim inside
      //  an operating receipt, the exact collapse these seams exist to
      //  prevent. The resident sentence appears only when the update intent
      //  was actually committed, and it describes what will happen rather
      //  than asserting a text arrived.
      return committedOn(`Recorded no access on ${named}. The work stays open, and access follow-up is now needed.`
        + residentClause(r, " The resident will be asked to coordinate entry."));

    case "blocked_recorded":
      return committedOn(`Noted — ${named} is blocked and stays open. Your manager will see what it's waiting on.`);

    case "finding_recorded":
      return committedOn(`Saved to ${named}: ${String(r.progress.note || "").trim()}`);

    case "evidence_recorded": {
      //  A photo we could not preserve is NOT proof, and saying "got it"
      //  would make a technician think the job is covered when it is not.
      if (r.storageState === "stored") {
        return say(`Photo saved to ${named}.`, { committed: true });
      }
      return say(`I got your photo on ${named} but couldn't save it. Please send it once more.`);
    }

    case "completion_blocked":
      return committedOn(r.evidenceAttempted
        ? `I recorded that you finished ${named}, but the photo didn't save, so I can't close it yet. One more photo of the repair will do it.`
        : `I recorded that you finished ${named}, but I still need a photo of the repair before I can close it.`);

    case "work_completed":
      return committedOn(`Done — ${named} is closed.`
        + residentClause(r, " The resident will be notified the repair is complete."));

    case "work_list": {
      const items = Array.isArray(r.items) ? r.items : [];
      if (!items.length) return say("Nothing else is assigned to you right now.");
      const lines = items.map((i) => `\u2022 ${workLabelOf(i) || "(unnamed)"}${i.accepted ? " (yours)" : ""}`);
      return say(`You have ${items.length === 1 ? "one thing" : `${items.length} things`} open:\n${lines.join("\n")}`);
    }

    case "work_reference_needed": {
      if (!r.question) return refusal(outcome, "clarification_without_question");
      return say(r.question, { isClarificationQuestion: true, serviceOutcome: r.reason || null });
    }

    case "authorization_refused":
      //  Deliberately uninformative about what exists. Naming the work
      //  would confirm a record they have no authority over.
      return say("That isn't assigned to you, so I can't act on it. Your manager can reassign it.",
        { serviceOutcome: r.verdict || null });

    default:
      return refusal(outcome, "unknown_outcome");
  }
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/*  RULING 2026-08-04. A future-tense promise about the resident is allowed
 *  ONLY when a durable resident-update intent already exists. If preparing it
 *  FAILED, that is said out loud: the work action stands, and the technician
 *  learns the resident was not queued rather than being told they were.
 *  Delivery remains a separate, later fact in both cases. */
function residentClause(r, promise) {
  if (r.residentUpdateFailed) return " The work is recorded, but I couldn't prepare the resident update — your manager will see it.";
  return r.residentUpdateQueued ? promise : "";
}

module.exports = {
  OPERATING_OUTCOMES,
  TECHNICIAN_OUTCOMES,
  workLabelOf,
  OUTCOMES_REQUIRING_OBJECT,
  DELIVERY_STATES,
  HOLD_TEXT,
  ReceiptShapeError,
  operatingReceipt,
  deliveryReceipt,
  composeReceipt,
};
