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

/*  ── THE ONLY QUALIFICATIONS THAT MEAN "PROCEED" ────────────────────
 *  availableUnits(exact_spaces) succeeds with exactly these. Everything
 *  else it can return is a refusal of some kind, INCLUDING refusals that
 *  bubble up from reads nested inside it.
 *
 *  ⚠ AN ALLOWLIST OF SUCCESS, NOT A DENYLIST OF REFUSALS. The first
 *  version denylisted refusals and called itself fail-closed. It was not:
 *  the caller filtered the qualification against its own list and passed
 *  `null` for anything it did not recognise, so an unknown value arrived
 *  as "no refusal" and was waved through.                              */
const PROCEEDS = Object.freeze([
  "exact_space_matches_informational",
  "matching_incomplete_pricing_unresolved",
]);

/*  What the caller is missing, named so it can ask for exactly that and
 *  nothing else — never reopening a blank form for facts already held.  */
const MISSING = Object.freeze({
  REQUESTED_DATES: "requested_dates",
  PRICING_TERM: "pricing_term",
});

/*  WHY A BLOCKING RESULT BLOCKED. Carried so the standing projection can
 *  PROJECT the outcome instead of classifying it a second time.
 *  §40.7: a read that failed is a fact about SPINE. Rendering it as a
 *  successful NOT_ESTABLISHED tells an operator the property has nothing,
 *  when Spine could not look.                                          */
const REFUSAL = Object.freeze({
  READ_FAILED: "read_failed",
  INVALID_INPUT: "invalid_input",
  NO_SUBJECT: "no_subject",
  UNRECOGNISED: "unrecognised",
});
const READ_FAILURES = Object.freeze(["term_check_unavailable", "pricing_read_unavailable"]);
const INVALID_INPUT = Object.freeze(["invalid_term", "invalid_pricing_term", "invalid_preferences"]);

/*  ══ ONE INTERPRETATION OF THE GATE, CONSUMED DIRECTLY ═══════════════
 *  The same qualification used to be interpreted three times: whether it
 *  blocked, what strength it allowed, and whether a term had been chosen.
 *  Two of those lived here and the third was inferred in the caller, and
 *  a change that repaired the first two broke the third — the caller was
 *  deriving "a term was chosen" from `refusal == null`, which silently
 *  became false the moment success stopped being null.
 *
 *  ⚠ DATES AND A PRICING TERM ARE DIFFERENT FACTS. `term_required` means
 *  the caller named no interval. `pricing_term_required` means the caller
 *  DID supply dates and the pricing term is unresolved. Collapsing them
 *  tells an operator their dates are missing when they are not, and the
 *  homes were in fact evaluated for the interval they gave.
 *
 *  ⚠ FAILS CLOSED. null, undefined, "" and any unrecognised string are
 *  refusals here. Nothing outside PROCEEDS becomes success by omission.  */
function interpretGate(qualification) {
  const q = typeof qualification === "string" && qualification !== "" ? qualification : null;
  if (q !== null && PROCEEDS.includes(q)) {
    return { qualification: q, blocks: false, ceiling: STRENGTH.OFFERABLE,
      dates_established: true, pricing_term_established: true, missing: null };
  }
  if (q === "term_required") {
    return { qualification: q, blocks: false, ceiling: STRENGTH.LIKELY_FIT,
      dates_established: false, pricing_term_established: false, missing: MISSING.REQUESTED_DATES };
  }
  if (q === "pricing_term_required") {
    //  Dates ARE established here; only the priced term is unresolved.
    return { qualification: q, blocks: false, ceiling: STRENGTH.LIKELY_FIT,
      dates_established: true, pricing_term_established: false, missing: MISSING.PRICING_TERM };
  }
  const kind = q === null ? REFUSAL.UNRECOGNISED
    : READ_FAILURES.includes(q) ? REFUSAL.READ_FAILED
    : INVALID_INPUT.includes(q) ? REFUSAL.INVALID_INPUT
    : q === "no_property" ? REFUSAL.NO_SUBJECT
    : REFUSAL.UNRECOGNISED;
  return { qualification: q, blocks: true, ceiling: null,
    dates_established: false, pricing_term_established: false, missing: null,
    refusal_kind: kind };
}

module.exports = { STRENGTH, MISSING, REFUSAL, PROCEEDS, interpretGate };
