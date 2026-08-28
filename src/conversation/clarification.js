/* ════════════════════════════════════════════════════════════════════
   conversation/clarification.js — CLARIFICATION & CONFIRMATION STATE.

   The second shared conversational seam, extracted from the resident SMS
   path in src/comms/tenant_link.js where the ladder lived inline inside
   processInboundClaim. See docs/AGENT_CAPABILITY_SEAMS.md.

   ── WHAT IT DECIDES (the whole of it) ──────────────────────────────
     1. what material fact is missing;
     2. whether the current message answers it;
     3. whether a consequential interpretation requires confirmation;
     4. what governed action may be PROPOSED next.

   It proposes. Canonical services decide, write, and own the outcome.

   ── WHAT IT MAY NEVER DO ───────────────────────────────────────────
     · invent property context. It holds no property list, opens no
       connection, and takes no candidate set. It verifies that the
       caller's rows agree with the caller's own scope and refuses when
       they do not — it never chooses.
     · infer staff authority from a message. No actor, role, assignment
       or entitlement crosses this boundary in either direction.
     · create a new work order when the clarification belongs to an
       existing one. `propose_new_action` is UNREACHABLE while an
       outstanding clarification exists, unless the answer verdict is
       explicitly `separate_problem`.
     · treat obligations.person_id as the reporter. No person identifier
       is an input here at all. (That column holds
       affected_person_id ?? reported_by_person_id — whose home it is,
       not who we texted.)
     · silently convert ambiguity into a default choice. Every ambiguous
       state terminates in `hold_for_human`, never in an action.

   ── THE TWO-STEP PROTOCOL, AND WHY ─────────────────────────────────
   Determining "does this reply answer that question" needs a model call;
   determining "was an earlier question already resolved" needs a query.
   Neither belongs in here. So step 1 returns the MISSING FACT and names
   exactly which determination the caller must perform; the caller
   performs it; step 2 turns the answer into a terminal decision.

   That shape is what makes duplicate answers safe by construction: with
   no outstanding clarification the only route to a terminal decision is
   `resolvePriorResolution`, and it requires an explicit boolean. A caller
   that forgets the check gets no decision at all — never a second work
   order.

   ── MOVE, NOT REDESIGN ─────────────────────────────────────────────
   Every branch below is the tenant_link original. One state is new and is
   declared rather than smuggled: `unusable_question_context` — an open
   clarification whose recorded question text is missing or blank. It
   terminates in `hold_for_human`. Previously that row reached the model
   as the literal string "null"; the honest reading of a question we
   cannot quote is that we cannot judge the answer.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  Terminal states. Every one names a real situation; none is a bucket. */
const CLARIFICATION_STATES = [
  "none",                       // nothing outstanding — the ordinary path
  "ambiguous_open_set",         // more than one outstanding clarification
  "unusable_question_context",  // outstanding, but we cannot quote what we asked
  "answered",                   // this reply answers the outstanding question
  "unrecognized_answer",        // we cannot tell whether it answers
  "separate_problem",           // it answers nothing; it reports something else
  "answer_to_resolved",         // an answer to a question already settled
];

/*  What the caller may PROPOSE next. Not what happens — the canonical
 *  service decides that, and may still refuse. */
const GOVERNED_ACTIONS = ["propose_new_action", "append_to_existing", "hold_for_human"];

/*  The determination the caller must perform before a terminal decision
 *  exists. Named, so "I forgot to check" cannot look like "nothing to check". */
const PENDING_DETERMINATIONS = ["answer_verdict", "prior_resolution_check"];

/*  The material fact that is missing, when one is. */
const MISSING_FACTS = [
  "which_open_request",                    // >1 outstanding: no column can hold the offered options
  "the_question_we_asked",                 // outstanding, but unquotable
  "whether_reply_answers_open_question",   // the reply is unreadable against the question
];

const DEFAULT_CONFIRMATION_QUESTION =
  "Just to be sure — is this an emergency that needs someone right away, or can it wait for normal hours?";

class ClarificationContextError extends Error {
  constructor(message, code) { super(message); this.name = "ClarificationContextError"; this.code = code; }
}

const terminal = (o) => Object.freeze({
  state: o.state,
  action: o.action,
  target: o.target || null,
  needs: null,
  question: null,
  missingFact: o.missingFact || null,
  // TRUE only where THIS module is the thing that decided a human is needed.
  // NULL means "not this module's call" — the canonical service decides, and
  // a null must never be read as false.
  requiresHuman: o.requiresHuman === true ? true : null,
  reason: o.reason,
});

/*  ── STEP 1 ─────────────────────────────────────────────────────────
 *  What is outstanding, and what must be determined before anything may
 *  be proposed.
 *
 *  `scope.property_id` is the caller's OWN scope — the property it was
 *  already operating within. It is a consistency check, never a source of
 *  context: a row that disagrees with it is a mismatched clarification
 *  context and fails loudly rather than being silently dropped (dropping
 *  it would turn "there is an open question" into "open a new request").
 */
function assessOpenClarification({ scope, open, undelivered = [] } = {}) {
  if (!scope || !scope.property_id) {
    throw new ClarificationContextError(
      "scope.property_id is required — clarification state is never evaluated outside an explicit property scope",
      "scope_missing");
  }
  if (!Array.isArray(open)) {
    throw new ClarificationContextError(
      "open must be an array of outstanding clarifications — an unreadable set is not an empty set",
      "open_not_an_array");
  }
  if (!Array.isArray(undelivered)) {
    throw new ClarificationContextError(
      "undelivered must be an array — an unreadable set of failed questions is not an empty set",
      "undelivered_not_an_array");
  }

  open.forEach((row, i) => {
    if (!row || typeof row !== "object") {
      throw new ClarificationContextError(`open[${i}] is not a clarification row`, "row_malformed");
    }
    if (!row.work_order_id) {
      throw new ClarificationContextError(
        `open[${i}] has no work_order_id — an outstanding clarification with nothing to append to cannot be resolved by proposing new work`,
        "row_without_target");
    }
    if (row.property_id !== scope.property_id) {
      throw new ClarificationContextError(
        `open[${i}] belongs to a different property than the scope being evaluated`,
        "row_out_of_scope");
    }
  });

  // §7.1.4 — never guess between them, and never ask the resident to choose:
  // no column can durably hold the offered options.
  if (open.length > 1) {
    return terminal({
      state: "ambiguous_open_set", action: "hold_for_human",
      missingFact: "which_open_request", requiresHuman: true,
      reason: `${open.length} outstanding clarifications; choosing between them would be a guess`,
    });
  }

  if (open.length === 1) {
    const row = open[0];
    const question = typeof row.question_body === "string" ? row.question_body.trim() : "";
    if (!question) {
      return terminal({
        state: "unusable_question_context", action: "hold_for_human",
        missingFact: "the_question_we_asked", requiresHuman: true,
        reason: "an outstanding clarification whose question text cannot be quoted cannot be judged against a reply",
      });
    }
    return Object.freeze({
      state: null, action: null,
      target: row,                       // the caller's own row, by identity
      needs: "answer_verdict",
      question,
      missingFact: "whether_reply_answers_open_question",
      requiresHuman: null,
      reason: "one outstanding clarification — the reply must be read against the exact question asked",
    });
  }

  //  ── WE FAILED TO ASK. NOT "NOTHING OUTSTANDING." ─────────────────
  //  Found by Gate A on a production-derived schema, and it is a
  //  PRE-EXISTING DEFECT ON `main`, not one this branch introduced.
  //
  //  A clarification question whose delivery failed is deliberately absent
  //  from `open` — a reply cannot be read as an answer to a question the
  //  resident never received, and treating it as one would be its own
  //  confident wrong. But falling through to "nothing outstanding" is
  //  worse: it made an undelivered question look like a settled one, so an
  //  ambiguous reply became a NEW WORK ORDER with `needs_human` unset. The
  //  ambiguity verdict was never even consulted.
  //
  //  FAILURE TO DELIVER A CLARIFICATION CANNOT TURN AMBIGUITY INTO
  //  OPERATING TRUTH. Neither wrong answer is available here: we cannot
  //  read the reply as an answer, and we cannot treat the ambiguity as
  //  fresh work. It stops, and a human sees it.
  //
  //  Once the question is successfully sent, it appears in `open` and only
  //  a reply AFTER that is evaluated against it.
  if (undelivered.length > 0) {
    return terminal({
      state: "question_not_delivered", action: "hold_for_human",
      missingFact: "a_question_the_resident_actually_received", requiresHuman: true,
      reason: `${undelivered.length} clarification question(s) could not be delivered; nothing here establishes what this reply is about`,
    });
  }

  // §7.6 — nothing outstanding has TWO meanings, and they are not the same
  // product decision. Resolve it explicitly.
  return Object.freeze({
    state: null, action: null, target: null,
    needs: "prior_resolution_check",
    question: null,
    missingFact: null,
    requiresHuman: null,
    reason: "nothing outstanding — an answer to a question someone else already settled is not a new problem",
  });
}

/*  ── STEP 2a ────────────────────────────────────────────────────────
 *  The reply, read against the exact question asked. Identity plus one
 *  open question is NOT evidence that a message answers it.
 *  Anything other than the two recognised verdicts holds for a human:
 *  an uncertain reading must never enrich a record or open a second one.
 */
function resolveAnswerVerdict({ pending, answerVerdict } = {}) {
  if (!pending || pending.needs !== "answer_verdict") {
    throw new ClarificationContextError(
      "resolveAnswerVerdict requires the step-1 result that asked for an answer verdict",
      "out_of_order");
  }
  if (answerVerdict === "answers_question") {
    return terminal({
      state: "answered", action: "append_to_existing", target: pending.target,
      // Deliberately NULL: whether a human is needed depends on what the
      // canonical append actually resolved, which has not happened yet.
      reason: "the reply answers the outstanding question about this work order",
    });
  }
  if (answerVerdict === "separate_problem") {
    return terminal({
      state: "separate_problem", action: "propose_new_action",
      reason: "the reply reports a different problem and answers nothing outstanding",
    });
  }
  return terminal({
    state: "unrecognized_answer", action: "hold_for_human",
    missingFact: "whether_reply_answers_open_question", requiresHuman: true,
    reason: `verdict ${JSON.stringify(answerVerdict)} does not establish that this reply answers the outstanding question`,
  });
}

/*  ── STEP 2b ────────────────────────────────────────────────────────
 *  Nothing outstanding. Did we ask this person something that someone
 *  else has since resolved? A strict boolean is required: `undefined`
 *  is the caller forgetting to look, and that must not read as "no".
 */
function resolvePriorResolution({ pending, priorAnsweredResolved } = {}) {
  if (!pending || pending.needs !== "prior_resolution_check") {
    throw new ClarificationContextError(
      "resolvePriorResolution requires the step-1 result that asked for a prior-resolution check",
      "out_of_order");
  }
  if (priorAnsweredResolved !== true && priorAnsweredResolved !== false) {
    throw new ClarificationContextError(
      "priorAnsweredResolved must be exactly true or false — an unperformed check is not a negative result",
      "check_not_performed");
  }
  if (priorAnsweredResolved) {
    return terminal({
      state: "answer_to_resolved", action: "hold_for_human", requiresHuman: true,
      reason: "an answer to a question already settled is not a new problem",
    });
  }
  return terminal({
    state: "none", action: "propose_new_action",
    reason: "nothing outstanding and nothing recently settled",
  });
}

/*  ── CONSEQUENTIAL INTERPRETATION (§7.4) ────────────────────────────
 *  A reading with consequences may only be acted on as read when the
 *  facts it needs are actually present. The interpreter called it an
 *  emergency; the narrow classifier produced no valid emergency type.
 *  NEVER invent one to satisfy the service — open at needs_confirmation
 *  and ask ONE question.
 *
 *  `basis` passes through untouched: the classifier's finding is what it
 *  found, and confirmation is a decision ABOUT that finding, not a
 *  revision of it.
 */
function assessConsequentialInterpretation({ classification, urgency } = {}) {
  if (!urgency || typeof urgency !== "object") {
    throw new ClarificationContextError(
      "urgency must be the narrow classifier's result", "urgency_missing");
  }

  let urgency_status = urgency.urgency;
  let emergency_type = urgency.emergency_type || null;
  let clarifying_question = urgency.clarifying_question || null;
  let requiresConfirmation = urgency_status === "needs_confirmation";

  if (classification === "emergency" && !emergency_type && urgency_status !== "needs_confirmation") {
    urgency_status = "needs_confirmation";
    emergency_type = null;
    clarifying_question = clarifying_question || DEFAULT_CONFIRMATION_QUESTION;
    requiresConfirmation = true;
  }

  // Returned invariants, checked rather than assumed. An emergency with no
  // type is what createWorkOrder refuses; failing here names the reason.
  if (urgency_status === "emergency" && !emergency_type) {
    throw new ClarificationContextError(
      "emergency without an emergency_type — a consequential reading may not be acted on with the fact that makes it actionable missing",
      "emergency_without_type");
  }
  if (urgency_status === "needs_confirmation" && !clarifying_question) {
    throw new ClarificationContextError(
      "needs_confirmation without a question — asking for confirmation without asking anything is a silent default",
      "confirmation_without_question");
  }
  if (urgency_status === "needs_confirmation" && emergency_type) {
    throw new ClarificationContextError(
      "needs_confirmation carrying an emergency_type — the type is exactly what is unconfirmed",
      "unconfirmed_type_asserted");
  }

  return Object.freeze({
    urgency_status,
    emergency_type,
    clarifying_question,
    requiresConfirmation,
    basis: urgency.basis || null,
    reason: requiresConfirmation
      ? "the reading is consequential and the fact that would make it actionable is not established"
      : "the reading stands on the classifier's own finding",
  });
}

module.exports = {
  CLARIFICATION_STATES,
  GOVERNED_ACTIONS,
  PENDING_DETERMINATIONS,
  MISSING_FACTS,
  DEFAULT_CONFIRMATION_QUESTION,
  ClarificationContextError,
  assessOpenClarification,
  resolveAnswerVerdict,
  resolvePriorResolution,
  assessConsequentialInterpretation,
};
