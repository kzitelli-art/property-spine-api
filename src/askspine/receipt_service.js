// ════════════════════════════════════════════════════════════════════
//  receipt_service.js — BUILD 1, THE DURABLE READ RECEIPT
//
//  Every decision-grade Ask Spine answer leaves one row. Append-only,
//  enforced by trigger (migration 141).
//
//  ── A DECISIVE ANSWER WITHOUT ITS RECEIPT IS NOT A DECISIVE ANSWER ─
//
//  Ruling 17. If the truth read succeeds and the required receipt write
//  fails, the execution did NOT complete: it degrades to `unavailable`
//  and says so. It does not quietly become a normal answer with no audit
//  history, and there is no sixth answer state invented for it — the
//  operator only needs to know Spine could not complete the governed
//  check. The internal reason distinguishes a source read failure from a
//  receipt persistence failure; the operator-facing sentence does not.
//
//  ── IT RECORDS THE DEFINITION, NOT JUST THE NUMBER ─────────────────
//
//  intent_contract_version, intent_contract_digest and
//  candidate_predicate_version are the reason this table is worth
//  having. "What is true now?" recomputes. "What did Spine say on
//  March 3?" is this row — and it stays readable after the contract
//  changes because it names the contract that produced it.
//
//  ── A RELEASE 0 DIVIDEND ───────────────────────────────────────────
//
//  Cited evidence is frozen the moment an evaluation cites it (R0005),
//  so the evidence chain behind a preserved receipt cannot be rewritten
//  later. That is what makes a months-old receipt meaningful rather than
//  merely old. No other domain in this codebase has that property yet.
//
//  Writing a receipt is AUDIT HISTORY, not an operational consequence:
//  nothing here touches work orders, obligations, assignments,
//  evaluations or evidence.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

/**
 * Persist one receipt. Returns the row id.
 * Throws on failure — the caller decides what a failure means, and for
 * a required receipt the answer is "the execution did not complete."
 */
async function writeReceipt(db, { execution, rendered, property_id, actor }) {
  const t = execution.totals || { total_matching: 0, selected_count: 0 };
  const c = execution.contract || {};
  const ev = execution.evidence || { evidence_as_of: null, basis: "not_read" };

  const { rows } = await db.query(
    `insert into public.ask_spine_read_receipts (
       intent_slug, intent_contract_version, intent_contract_digest,
       candidate_predicate_version,
       property_id, actor_user_id, staff_session_id,
       evidence_as_of, evidence_as_of_basis,
       total_matching, selected_count, result_cap_per_lane, result_cap_scope,
       lane_breakdown, coverage_state, conclusion_code,
       source_outcomes, supporting_records, rendered_answer)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     returning id, executed_at`,
    [
      execution.intent_slug,
      c.version || "unknown",
      c.digest || "unknown",
      c.candidate_predicate_version || "unknown",
      property_id,
      (actor && actor.user_id) || null,
      (actor && actor.session_id) || null,
      ev.evidence_as_of,
      ev.basis,
      Number(t.total_matching || 0),
      Number(t.selected_count || 0),
      Number(c.result_cap_per_lane || t.result_cap_per_lane || 1),
      t.result_cap_scope || "per_lane",
      JSON.stringify(t.lanes || []),
      execution.coverage_state,
      execution.conclusion_code,
      JSON.stringify(execution.source_outcomes || []),
      JSON.stringify(execution.supporting_records || []),
      rendered.answer,
    ]);
  return rows[0];
}

/*  Which coverage states REQUIRE a durable receipt.
 *
 *  A decision-grade answer must be auditable. `unsupported` and the
 *  authority refusals are not decision-grade — Spine did not inspect
 *  governed truth — so requiring a row for them would fill the audit
 *  history with non-answers and make the real ones harder to find. */
const RECEIPT_REQUIRED_FOR = Object.freeze(["decisive", "valid_empty", "partial"]);

const receiptRequired = (execution) =>
  RECEIPT_REQUIRED_FOR.includes(execution.coverage_state);

module.exports = { writeReceipt, receiptRequired, RECEIPT_REQUIRED_FOR };
