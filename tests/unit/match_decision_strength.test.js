#!/usr/bin/env node
"use strict";
/*  SHOWING AND OFFERING ARE DIFFERENT DECISIONS, SO THEY HAVE DIFFERENT
 *  INPUT REQUIREMENTS.
 *
 *  "What can I show this person?" was blocked by a refusal that belongs to
 *  the contractual-offer decision. matchProspectHomes inherits its refusal
 *  vocabulary from availableUnits(exact_spaces) (MB-7) and treated EVERY
 *  inherited qualification as fatal — so a missing lease term, which only
 *  prevents a priced contractual offer, also suppressed the showing answer
 *  the operator actually asked for.
 *
 *  This predicate says which refusals bound which decision strength. It does
 *  NOT weaken the offer decision: everything that blocked an offer before
 *  still blocks one.
 *
 *      showable  →  likely_fit  →  offerable  →  committed
 *
 *  Progressively stronger claims. A refusal caps the ceiling; it does not
 *  empty the answer, unless it is a refusal that makes every claim unsafe.  */
const assert = require("node:assert/strict");
const { STRENGTH, ceilingFor, blocksEverything } =
  require("../../src/leasing/match_decision_strength.js");

let passed = 0, failed = 0;
function check(label, actual, expected) {
  try { assert.deepEqual(actual, expected); passed++; console.log(`  PASS  ${label}`); }
  catch (e) { failed++; console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}

//  ── A MISSING TERM BOUNDS THE ANSWER; IT DOES NOT EMPTY IT ──────────
check("term_required still allows a showing answer",
  ceilingFor("term_required"), STRENGTH.LIKELY_FIT);
check("pricing_term_required still allows a showing answer",
  ceilingFor("pricing_term_required"), STRENGTH.LIKELY_FIT);
check("term_required does not empty the answer",
  blocksEverything("term_required"), false);

//  ── BAD CALLER INPUT IS NOT A LOWER-STRENGTH ANSWER ─────────────────
//  Garbage in is refused at every strength. Degrading it to "showable"
//  would answer a question nobody asked with data nobody validated.
for (const q of ["invalid_term", "invalid_pricing_term", "invalid_preferences"]) {
  check(`${q} blocks every strength`, blocksEverything(q), true);
  check(`${q} has no ceiling`, ceilingFor(q), null);
}

//  ── A READ THAT FAILED IS NOT AN EMPTY INVENTORY (§40.7) ────────────
//  These are facts about SPINE, never about the property. Rendering them
//  as "nothing to show" is the composite-silence-reads-as-health defect.
for (const q of ["term_check_unavailable", "pricing_read_unavailable"]) {
  check(`${q} blocks every strength`, blocksEverything(q), true);
  check(`${q} has no ceiling`, ceilingFor(q), null);
}
check("no_property blocks every strength", blocksEverything("no_property"), true);

//  ── AN UNRECOGNISED QUALIFICATION FAILS CLOSED ──────────────────────
//  A qualification this predicate has never seen must not silently become
//  a showing answer. New refusals are classified deliberately or not at all.
check("an unknown qualification fails closed", blocksEverything("some_new_refusal"), true);
check("an unknown qualification has no ceiling", ceilingFor("some_new_refusal"), null);

//  ── NO REFUSAL AT ALL REACHES THE FULL OFFER DECISION ───────────────
check("no refusal reaches offerable", ceilingFor(null), STRENGTH.OFFERABLE);
check("no refusal blocks nothing", blocksEverything(null), false);

//  ── SUCCESS IS AN ALLOWLIST, WHICH IS WHAT MAKES FAIL-CLOSED REAL ───
//  The first version denylisted refusals, and the caller filtered the
//  qualification against its own list and passed null for anything it did
//  not recognise — so an unknown refusal arrived as "no refusal" and was
//  waved through. The helper passed its own examples while the integrated
//  behaviour had no guarantee at all. Classifying by what PROCEEDS means
//  neither layer can mistake an unknown value for success.
for (const okq of ["exact_space_matches_informational", "matching_incomplete_pricing_unresolved"]) {
  check(`${okq} proceeds to offerable`, ceilingFor(okq), STRENGTH.OFFERABLE);
  check(`${okq} blocks nothing`, blocksEverything(okq), false);
}
//  The regression that defeated it: a refusal the predicate has never seen.
check("an unseen REFUSAL is not treated as success", blocksEverything("some_future_refusal"), true);
check("an unseen refusal yields no ceiling", ceilingFor("some_future_refusal"), null);
//  And the shape the caller used to send: a real refusal must never arrive
//  as null. This asserts the CONTRACT, not the caller — the caller is
//  proved by the db-backed matcher proof.
check("a known refusal is not null-equivalent",
  blocksEverything("term_check_unavailable") === blocksEverything(null), false);

console.log(`\n  match decision strength: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
