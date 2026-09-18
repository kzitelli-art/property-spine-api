// ════════════════════════════════════════════════════════════════════
//  leasing_grain.js — HOW THIS BUILDING LEASES, OR THE HONEST REFUSAL
//
//  PURE. No database, no I/O, no clock.
//
//  ── WHAT WENT WRONG ─────────────────────────────────────────────────
//  Migration 026 gave `properties.leasing_basis` THREE values and said
//  what the third one is for:
//
//      'unknown' is the honest default. ... Declared basis also lets the
//      system flag declared-vs-observed mismatches instead of silently
//      guessing from row patterns.
//
//  Six places then wrote a TWO-way branch over that three-value column:
//
//      leasing_basis === "bed" ? "bed" : "unit"
//      coalesce(leasing_basis,'unit')
//
//  Every one of them answers "I do not know how this building leases"
//  with "by the unit" — confidently, silently, and at the exact moment a
//  rent roll is about to establish the building's canonical positions.
//
//  ── WHY IT IS NOT A SMALL ERROR ─────────────────────────────────────
//  On a by-the-bed property the grain decides what a source row IS.
//  Under grain 'unit' every row collapses to one '(whole unit)' position
//  per unit, and the guard that catches an unidentifiable position
//  (snapshot_loader's `label === "(bed)"` discrepancy) never fires,
//  because the label is never "(bed)".
//
//  NUMERATOR AND DENOMINATOR COLLAPSE TOGETHER. A three-bed unit holding
//  two residents and one empty bed does not become "2 of 3 occupied" —
//  it becomes ONE unit, occupied. The vacant bed is not miscounted; it
//  stops existing. Skyline is 160 beds in 72 units and Greenery is 105
//  beds in 64 units, so the error is not a rounding difference: it is
//  vacancy, vacancy loss, availability, prelease coverage and forward
//  rent, all wrong, with nothing anywhere saying so.
//
//  ── THE RULE ────────────────────────────────────────────────────────
//  A source that can establish tenancy may not run against a property
//  whose grain is not established. Not defaulted — REFUSED, and named:
//
//      "This property has not been established as leasing by bed or by
//       unit. Choose the property grain before establishing this rent
//       roll."
//
//  An explicit caller basis still establishes it (the Deal Setup wizard
//  asks "by unit or by bed?" before the building is confirmed). What is
//  gone is the silent fallback when NOBODY has answered.
//
//  A report parameter is NOT an answer. "Summarize By = Unit" is how
//  Yardi arranged one export; a by-the-bed building emits it happily.
//  Nothing here may be derived from source layout.
// ════════════════════════════════════════════════════════════════════

"use strict";

//  The two values that are an answer. 'unknown' is deliberately absent:
//  it is the ABSENCE of an answer, which is why it may not be resolved.
const ESTABLISHED_GRAINS = Object.freeze(["unit", "bed"]);

const GRAIN_NOT_ESTABLISHED = "leasing_basis_not_established";

//  Product copy, not a machine token. A refusal a person reads must name
//  the next step, and this one is a decision only a human can make.
const GRAIN_REFUSAL_MESSAGE =
  "This property has not been established as leasing by bed or by unit. " +
  "Choose the property grain before establishing this rent roll.";

/*  The ONE reading of the column. Returns 'unit' | 'bed', or null for
 *  'unknown', null, '' and anything else. Null is the answer that means
 *  "not established" — callers turn it into their own refusal. */
function leasingGrain(value) {
  const g = String(value == null ? "" : value).trim().toLowerCase();
  return ESTABLISHED_GRAINS.includes(g) ? g : null;
}

/*  Grain for a load: an explicitly supplied basis establishes it, else the
 *  property's own established basis, else NOT ESTABLISHED (null). Order
 *  matters — a caller may answer the question, but may not overrule an
 *  answer already on the property with a blank. */
function resolveLeasingGrain({ supplied = null, property = null } = {}) {
  return leasingGrain(supplied) || leasingGrain(property) || null;
}

/*  What a COUNT of positions is called, in the operator's words. Three
 *  answers, because the column has three states and a count over an
 *  unestablished grain is a count of spaces and nothing more. 'spaces' is
 *  not a softer 'units' — it is the honest noun for "we have rows but
 *  nobody has said what a leasable position IS here", which is exactly
 *  what migration 026 refused to let the system guess from row patterns.
 *
 *  This exists because /management-read inferred the noun instead:
 *      const basis = maxSpaces > 1 ? "bed" : "unit";
 *  A by-the-bed building whose beds are not materialized yet reads
 *  maxSpaces === 1 and gets labelled "units", contradicting its own
 *  properties.leasing_basis with nothing anywhere saying so. */
function grainCountLabel(grain) {
  const g = leasingGrain(grain);
  if (g === "bed") return "beds";
  if (g === "unit") return "units";
  return "spaces";
}

module.exports = {
  ESTABLISHED_GRAINS,
  GRAIN_NOT_ESTABLISHED,
  GRAIN_REFUSAL_MESSAGE,
  leasingGrain,
  resolveLeasingGrain,
  grainCountLabel,
};
