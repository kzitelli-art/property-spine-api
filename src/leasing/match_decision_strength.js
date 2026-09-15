// ════════════════════════════════════════════════════════════════════
//  match_decision_strength.js — WHICH DECISION IS THIS CALLER MAKING,
//  AND WHAT DOES THAT DECISION ACTUALLY REQUIRE?
//
//  "What can I show this person?" and "what can I contractually offer
//  them, on these dates, at this rent?" are different questions with
//  different consequences. They were answered by one predicate with one
//  input list, so the stricter question's requirements silently governed
//  the looser one: with no lease term selected, matchProspectHomes
//  inherited `term_required` from availableUnits(exact_spaces) (MB-7) and
//  returned NOTHING — to an operator standing in a hallway who only
//  wanted to know which homes were worth walking to.
//
//  The claims, weakest to strongest:
//
//      showable      worth walking to; nothing known contradicts it
//      likely_fit    the recorded needs Spine holds are satisfied
//      offerable     can be contractually offered for stated dates/term
//      committed     a signed lease exists
//
//  ⚠ THIS PREDICATE NEVER RAISES A CEILING. `committed` is not reachable
//  here at all: it is established by execution, not by matching, and a
//  matcher that could claim it would be manufacturing a contract. The
//  highest a match may claim is `offerable`.
//
//  ⚠ IT DOES NOT WEAKEN THE OFFER DECISION. Every qualification that
//  blocked a contractual offer before blocks one now. What changed is
//  that two of them stop deleting the showing answer as well.
// ════════════════════════════════════════════════════════════════════
"use strict";

const STRENGTH = Object.freeze({
  SHOWABLE: "showable",
  LIKELY_FIT: "likely_fit",
  OFFERABLE: "offerable",
  COMMITTED: "committed",
});

/*  THE CALLER HAS NOT CHOSEN A TERM YET.
 *  A term is what prices a lease and fixes its dates. Without one Spine
 *  cannot state a contractual offer — and that is the ONLY thing it
 *  cannot state. Which homes exist, which are governed inventory, and
 *  which satisfy the prospect's recorded needs are all still answerable,
 *  because none of them depends on the term being chosen.
 *
 *  The ceiling is likely_fit rather than showable: the recorded-needs
 *  comparison below the gate (price, unit type, readiness) runs fine
 *  without a term, so the answer is allowed to be that strong. It just
 *  may not claim to be an offer.  */
const TERM_NOT_CHOSEN = Object.freeze(["term_required", "pricing_term_required"]);

/*  THE CALLER SUPPLIED SOMETHING INVALID.
 *  Not a weaker question — a malformed one. Degrading it to a showing
 *  answer would answer a question nobody asked, using input Spine just
 *  refused to accept. Refused at every strength.  */
const CALLER_INPUT_INVALID = Object.freeze(["invalid_term", "invalid_pricing_term", "invalid_preferences"]);

/*  SPINE COULD NOT READ (§40.7).
 *  A fact about SPINE, never about the property. "Pricing could not be
 *  read" rendered as a showing list would tell an operator these are the
 *  homes, when Spine does not know what the homes are. The four silences
 *  do not collapse, and a read failure is not a smaller answer.  */
const READ_FAILED = Object.freeze(["term_check_unavailable", "pricing_read_unavailable"]);

/*  No property named. Nothing is answerable about a property Spine was
 *  not told to look at.  */
const NO_SUBJECT = Object.freeze(["no_property"]);

const FATAL = Object.freeze([...CALLER_INPUT_INVALID, ...READ_FAILED, ...NO_SUBJECT]);

/*  ── THE ONLY QUALIFICATIONS THAT MEAN "PROCEED" ────────────────────
 *  availableUnits(exact_spaces) succeeds with exactly these. Everything
 *  else it can return is a refusal of some kind, INCLUDING refusals that
 *  bubble up from reads nested inside it.
 *
 *  ⚠ THIS IS AN ALLOWLIST OF SUCCESS, NOT A DENYLIST OF REFUSALS, AND
 *  THE POLARITY IS THE WHOLE POINT. The first version of this file
 *  denylisted refusals and called itself fail-closed. It was not: the
 *  caller filtered the qualification against its own fixed refusal list
 *  first and passed `null` for anything it did not recognise, so an
 *  unknown qualification arrived here as "no refusal at all" and was
 *  waved through. The helper was correct in isolation and the
 *  integration defeated it — which is worse than no guarantee, because
 *  it reads as one.
 *
 *  Classified by what PROCEEDS, an unknown value cannot be mistaken for
 *  success by either layer.  */
const PROCEEDS = Object.freeze([
  "exact_space_matches_informational",
  "matching_incomplete_pricing_unresolved",
]);

/*  Does this qualification make EVERY claim unsafe?
 *  Takes the RAW qualification. Callers must not pre-filter it.  */
function blocksEverything(qualification) {
  if (qualification == null) return false;
  if (PROCEEDS.includes(qualification)) return false;
  if (TERM_NOT_CHOSEN.includes(qualification)) return false;
  return true;
}

/*  The strongest claim still available given this qualification.
 *  null when no claim is safe at all — which is not the same as
 *  `showable`, and callers must not treat it as an empty home list.  */
function ceilingFor(qualification) {
  if (qualification == null || PROCEEDS.includes(qualification)) return STRENGTH.OFFERABLE;
  if (TERM_NOT_CHOSEN.includes(qualification)) return STRENGTH.LIKELY_FIT;
  return null;
}

module.exports = {
  STRENGTH, ceilingFor, blocksEverything,
  _classes: { PROCEEDS, TERM_NOT_CHOSEN, CALLER_INPUT_INVALID, READ_FAILED, NO_SUBJECT, FATAL },
};
