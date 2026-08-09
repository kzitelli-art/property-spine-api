// ════════════════════════════════════════════════════════════════════
//  ask_service.js — ONE OPERATOR TURN, END TO END
//
//      question
//        → what Spine understood        (intent_resolver, deterministic)
//        → the governed answer          (intent_executor, canonical truth)
//        → controlled language          (renderer, frozen sentences)
//        → durable read receipt         (receipt_service)
//        → and a record of the reading  (interpretations)
//
//  Nothing more. No conversation state, no cards, no actions, no memory.
//
//  ── THE FOUR OUTCOMES OF A TURN ────────────────────────────────────
//
//    answered        a supported intent resolved and executed
//    clarification   two supported intents matched; ask, do not guess
//    unsupported     the question is outside the governed set
//    (and the executor's own five coverage states live INSIDE `answered`)
//
//  A clarification is a PRE-ANSWER state. It records an interpretation
//  and earns NO read receipt, because nothing was read.
//
//  ── ORDER MATTERS: THE ANSWER, THEN ITS RECORD ─────────────────────
//
//  The read receipt is written by the executor path first and the
//  interpretation names it afterwards. A decision-grade answer whose
//  receipt did not persist is not decision-grade (ruling 17), and that
//  degradation happens before an interpretation ever claims an answer
//  exists.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

const resolver = require("./intent_resolver");
const executor = require("./intent_executor");
const renderer = require("./renderer");
const receipts = require("./receipt_service");

async function recordInterpretation(db, row) {
  const { rows } = await db.query(
    `insert into public.ask_spine_interpretations
       (property_id, actor_user_id, staff_session_id, question_text,
        resolution, intent_slug, resolution_reason, corrects_id, read_receipt_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id, created_at`,
    [row.property_id, row.actor_user_id || null, row.staff_session_id || null,
     row.question_text, row.resolution, row.intent_slug || null,
     row.resolution_reason || null, row.corrects_id || null, row.read_receipt_id || null]);
  return rows[0];
}

/**
 * Answer one operator turn.
 *
 * @param question   free text the operator typed
 * @param preferred_intent  a slug the operator picked from a clarification.
 *                   Honoured only if it is a SUPPORTED slug — a client
 *                   cannot introduce an intent by naming one.
 * @param corrects_interpretation_id  the reading this turn corrects.
 * @param property_id / allowed_modules / actor  ALL server-derived.
 */
async function ask(db, {
  question, preferred_intent = null, corrects_interpretation_id = null,
  property_id, allowed_modules, actor = {},
}) {
  if (!property_id) throw new Error("ask_service.ask requires a server-derived property_id");

  const reading = resolver.resolve(question, { preferred: preferred_intent });
  const base = {
    property_id, question_text: String(question || ""),
    actor_user_id: actor.user_id || null, staff_session_id: actor.session_id || null,
    corrects_id: corrects_interpretation_id || null,
  };

  //  ── NOT A DECISION-GRADE ANSWER ──────────────────────────────────
  if (reading.resolution !== "resolved") {
    const interp = await recordInterpretation(db, {
      ...base, resolution: reading.resolution, intent_slug: null,
      resolution_reason: reading.reason || reading.topic || null,
      read_receipt_id: null,
    });
    return {
      outcome: reading.resolution,
      understood: reading,
      //  Said plainly. "I don't understand" and "that question is not
      //  currently supported" are different things to hear.
      answer: reading.resolution === "clarification_required"
        ? "I can answer either of these — which did you mean?"
        : `I can't answer that yet: ${reading.why}.`,
      candidates: reading.candidates || null,
      supporting_records: [],
      totals: null,
      receipt_id: null,
      interpretation_id: interp.id,
    };
  }

  //  ── A GOVERNED ANSWER ────────────────────────────────────────────
  const execution = await executor.execute(db, {
    intent_slug: reading.intent_slug, property_id, allowed_modules });
  let rendered = renderer.render(execution);

  let receipt = null;
  let degraded = execution;
  if (receipts.receiptRequired(execution)) {
    try {
      receipt = await receipts.writeReceipt(db, {
        execution, rendered, property_id, actor });
    } catch (e) {
      //  Ruling 17. The truth read succeeded and its audit history did
      //  not, so the execution did not complete. No sixth answer state.
      degraded = { ...execution,
        coverage_state: executor.COVERAGE_STATES.UNAVAILABLE,
        conclusion_code: "unavailable_source_cannot_answer",
        internal_reason: "receipt_persistence_failure",
        supporting_records: [], totals: null };
      rendered = renderer.render(degraded);
    }
  }

  const interp = await recordInterpretation(db, {
    ...base, resolution: "resolved", intent_slug: reading.intent_slug,
    resolution_reason: reading.via, read_receipt_id: receipt ? receipt.id : null,
  });

  return {
    outcome: "answered",
    understood: { resolution: "resolved", intent_slug: reading.intent_slug, via: reading.via },
    coverage_state: degraded.coverage_state,
    conclusion_code: degraded.conclusion_code,
    answer: rendered.answer,
    boundedness_note: rendered.boundedness_note,
    supporting_records: degraded.supporting_records,
    totals: degraded.totals,
    source_outcomes: execution.source_outcomes,
    evidence: execution.evidence,
    contract: execution.contract,
    receipt_id: receipt ? receipt.id : null,
    interpretation_id: interp.id,
  };
}

/*  Rebuild a completed answer from its DURABLE RECEIPT, not from a
 *  transcript. A reload must not depend on anything a model said. */
async function replayReceipt(db, { receipt_id, property_id }) {
  const r = (await db.query(
    `select * from public.ask_spine_read_receipts where id = $1 and property_id = $2`,
    [receipt_id, property_id])).rows[0];
  if (!r) return null;
  return {
    outcome: "answered",
    replayed_from: "read_receipt",
    intent_slug: r.intent_slug,
    coverage_state: r.coverage_state,
    conclusion_code: r.conclusion_code,
    //  The sentence AS SHOWN at the time, not re-rendered from today's
    //  data. "What did Spine say?" is a different question from "what is
    //  true now", and this function answers the first one.
    answer: r.rendered_answer,
    supporting_records: r.supporting_records,
    totals: { result_cap_per_lane: r.result_cap_per_lane,
              result_cap_scope: r.result_cap_scope,
              lanes: r.lane_breakdown,
              total_matching: r.total_matching, selected_count: r.selected_count },
    source_outcomes: r.source_outcomes,
    evidence: { evidence_as_of: r.evidence_as_of, basis: r.evidence_as_of_basis },
    contract: { version: r.intent_contract_version, digest: r.intent_contract_digest,
                candidate_predicate_version: r.candidate_predicate_version },
    executed_at: r.executed_at,
    receipt_id: r.id,
  };
}

module.exports = { ask, replayReceipt, recordInterpretation };
