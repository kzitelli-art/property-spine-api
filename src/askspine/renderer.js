// ════════════════════════════════════════════════════════════════════
//  renderer.js — BUILD 1, THE CONTROLLED RENDERER
//
//  Structured conclusion code + counts → operator language. That is the
//  whole job.
//
//  ── WHY THIS FILE IS SO BORING, ON PURPOSE ─────────────────────────
//
//  §2.2: the model may determine what the operator MEANT. It does not
//  state operating truth. The safest way to honour that is structural
//  rather than instructional — the sentences live in a frozen table
//  here, keyed by a code the executor computed from governed facts. If
//  a sentence cannot be produced from a known code, this refuses rather
//  than improvising, so an unsupported claim has no path to a browser.
//
//  There is no template interpolation of free text. The only values that
//  enter a sentence are integers the executor counted.
//
//  ── OUTWARD LANGUAGE IS NOT OUR INTERNAL VOCABULARY ────────────────
//
//  `legacy_indeterminate` is an operator/internal truth state. It never
//  travels outward under that name — outward it is "pre-cutover" work
//  that "remains unverified". Exposing the enum would leak an
//  implementation vocabulary and invite a reader to interpret it.
//
//  ── AND IT NEVER ASSIGNS BLAME ─────────────────────────────────────
//
//  Not one sentence here names a person, a role, or a cause. An actor on
//  record is not a person at fault. Those conclusions are withheld by
//  the contract, and the renderer is where "withheld" has to actually
//  mean something.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/*  Every supported conclusion, and nothing else. The keys are the
 *  executor's conclusion codes; the contract's `supported_conclusions`
 *  must agree with this table, and a gate asserts that it does. */
const SENTENCES = Object.freeze({
  current_none_legacy_none: () =>
    "No completed work orders lack valid proof.",

  current_none_legacy_present: ({ lane_b_total }) =>
    "No current completions lack valid proof. " +
    `${plural(lane_b_total, "pre-cutover completion remains", "pre-cutover completions remain")} unverified.`,

  current_present_legacy_none: ({ lane_a_total }) =>
    `${plural(lane_a_total, "completed work order does", "completed work orders do")} not have valid proof.`,

  current_present_legacy_present: ({ lane_a_total, lane_b_total }) =>
    `${plural(lane_a_total, "completed work order does", "completed work orders do")} not have valid proof. ` +
    `${plural(lane_b_total, "older pre-cutover completion remains", "older pre-cutover completions remain")} unverified.`,

  unavailable_source_cannot_answer: () =>
    "I can't determine completion proof right now.",

  unauthorized_module: () =>
    "You do not have maintenance access for this property.",

  unsupported_question: () =>
    "I don't have a governed way to answer that question.",
});

/*  Boundedness is disclosed in the answer itself, not in a tooltip. A
 *  capped list rendered without its total reads as "that is all of
 *  them", which is the same defect as a confident wrong number.
 *
 *  PER LANE, and that is a real decision rather than a formatting one.
 *  The cap is applied to each lane separately so a large pre-cutover
 *  history cannot crowd current integrity failures off the page — the
 *  current lane is the urgent one, and a shared budget would let old
 *  history hide new problems. A combined "showing 21 of 131" also
 *  silently mixes two populations that the whole intent exists to keep
 *  apart. */
function boundednessNote(totals) {
  if (!totals) return null;
  const parts = [];
  if (totals.lane_a_total > totals.lane_a_selected) {
    parts.push(`${totals.lane_a_selected} of ${totals.lane_a_total} current`);
  }
  if (totals.lane_b_total > totals.lane_b_selected) {
    parts.push(`${totals.lane_b_selected} of ${totals.lane_b_total} pre-cutover`);
  }
  if (!parts.length) return null;
  return `Showing ${parts.join(", ")} (result cap ${totals.result_cap} per group).`;
}

/**
 * Render a completed execution.
 *
 * @param execution  the object returned by intent_executor.execute
 * @returns { answer, boundedness_note, sentence_source }
 * @throws  if the conclusion code has no frozen sentence — refusing is
 *          the point; improvising is the failure.
 */
function render(execution) {
  const make = SENTENCES[execution.conclusion_code];
  if (!make) {
    throw new Error(
      `renderer: no frozen sentence for conclusion code ` +
      `${JSON.stringify(execution.conclusion_code)} — the renderer refuses to ` +
      `improvise operator language for an unknown conclusion`);
  }
  const totals = execution.totals || { lane_a_total: 0, lane_b_total: 0 };
  return {
    answer: make(totals),
    boundedness_note: boundednessNote(execution.totals),
    //  Named so a consumer can prove where the words came from.
    sentence_source: "frozen_renderer_table",
  };
}

module.exports = { render, SENTENCES, SUPPORTED_CODES: Object.keys(SENTENCES) };
