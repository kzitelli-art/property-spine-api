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

/*  Lanes are read BY NAME. The sentences used to take `lane_a_total` /
 *  `lane_b_total`, which meant the renderer and the executor had to agree
 *  about which lane was "A" — an agreement nothing enforced. */
const laneOf = (totals, name) =>
  ((totals && totals.lanes) || []).find((l) => l.lane === name) ||
  { total_matching: 0, selected_count: 0 };
const currentTotal = (t) => laneOf(t, "current").total_matching;
const historyTotal = (t) => laneOf(t, "pre_cutover_history").total_matching;

/*  Facet counts, read by name. They describe the FULL population, which
 *  is why a sentence may say "51 assigned and accepted" while the record
 *  list shows 20 — and why the two never have to agree. */
const firstLane = (t) => ((t && t.lanes) || [])[0] || { total_matching: 0 };
const laneTotal = (t) => firstLane(t).total_matching;
const ownState = (t, k) => (((firstLane(t).facets || {}).ownership_state || {})[k] || 0);

/*  Every supported conclusion, and nothing else. The keys are the
 *  executor's conclusion codes; the contract's `supported_conclusions`
 *  must agree with this table, and a gate asserts that it does. */
const SENTENCES = Object.freeze({
  current_none_legacy_none: () =>
    "No completed work orders lack valid proof.",

  current_none_legacy_present: (t) =>
    "No current completions lack valid proof. " +
    `${plural(historyTotal(t), "pre-cutover completion remains", "pre-cutover completions remain")} unverified.`,

  current_present_legacy_none: (t) =>
    `${plural(currentTotal(t), "completed work order does", "completed work orders do")} not have valid proof.`,

  current_present_legacy_present: (t) =>
    `${plural(currentTotal(t), "completed work order does", "completed work orders do")} not have valid proof. ` +
    `${plural(historyTotal(t), "older pre-cutover completion remains", "older pre-cutover completions remain")} unverified.`,

  /*  ── maintenance.ownership_and_acceptance ────────────────────────
   *
   *  ASSIGNED and ACCEPTED, never OWNS or ACCOUNTABLE. "Alice owns WO
   *  1042" and "Bob is accountable for maintenance" are stronger claims
   *  than the source supports — the organization/accountability resolver
   *  does not exist yet, and loose wording here would pre-empt it.
   *
   *  Counts come from the facet over the FULL population, so they stay
   *  true when the record list is capped. */
  ownership_none_current: () =>
    "There are no current maintenance obligations on work orders here.",

  ownership_all_accepted: (t) =>
    `All ${plural(ownState(t, "assigned_accepted"), "current maintenance obligation is",
                  "current maintenance obligations are")} assigned and accepted.`,

  ownership_mixed: (t) => {
    const parts = [];
    const un = ownState(t, "unassigned");
    const na = ownState(t, "assigned_not_accepted");
    const ac = ownState(t, "assigned_accepted");
    if (un) parts.push(`${un} unassigned`);
    if (na) parts.push(`${na} assigned but not yet accepted`);
    if (ac) parts.push(`${ac} assigned and accepted`);
    return `${laneTotal(t)} current maintenance obligations: ${parts.join(", ")}.`;
  },

  /*  INTENT-NEUTRAL, and the browser is what caught it: asked "who is
   *  assigned?" with the obligations source broken, this sentence said
   *  "I can't determine completion PROOF right now" — naming a different
   *  question than the one asked. The conclusion code is shared by every
   *  intent, so its words must not belong to one of them. Phase 12
   *  freezes the contract, not the English. */
  unavailable_source_cannot_answer: () =>
    "I can't answer that from governed truth right now.",

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
const LANE_WORD = { current: "current", pre_cutover_history: "pre-cutover" };

function boundednessNote(totals) {
  if (!totals || !Array.isArray(totals.lanes)) return null;
  const parts = totals.lanes
    .filter((l) => l.total_matching > l.selected_count)
    .map((l) => `${l.selected_count} of ${l.total_matching} ${LANE_WORD[l.lane] || l.lane}`);
  if (!parts.length) return null;
  return `Showing ${parts.join(", ")} ` +
         `(result cap ${totals.result_cap_per_lane} per group).`;
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
  const totals = execution.totals || { lanes: [] };
  return {
    answer: make(totals),
    boundedness_note: boundednessNote(execution.totals),
    //  Named so a consumer can prove where the words came from.
    sentence_source: "frozen_renderer_table",
  };
}

module.exports = { render, SENTENCES, SUPPORTED_CODES: Object.keys(SENTENCES) };
