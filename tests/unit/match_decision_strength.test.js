#!/usr/bin/env node
"use strict";
/*  ONE INTERPRETATION OF THE GATE RESULT.
 *
 *  Showing and offering are different decisions with different input
 *  requirements. matchProspectHomes inherits its refusal vocabulary from
 *  availableUnits(exact_spaces) (MB-7); treating every inherited
 *  qualification as fatal deleted the showing answer, because the
 *  composer always calls without a term.
 *
 *  This file proves the CONTRACT. Whether the caller honours it is proved
 *  by match_caller_reaches_predicate.test.js and, over real governed
 *  inventory, by prospect_match_basis.db.js — three revisions of this
 *  seam were correct here and wrong there.                             */
const assert = require("node:assert/strict");
const { STRENGTH, MISSING, interpretGate } =
  require("../../src/leasing/match_decision_strength.js");

let passed = 0, failed = 0;
function check(label, actual, expected) {
  try { assert.deepEqual(actual, expected); passed++; console.log(`  PASS  ${label}`); }
  catch (e) { failed++; console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}

//  ── SUCCESS IS AN ALLOWLIST ─────────────────────────────────────────
for (const okq of ["exact_space_matches_informational", "matching_incomplete_pricing_unresolved"]) {
  const r = interpretGate(okq);
  check(`${okq}: proceeds`, r.blocks, false);
  check(`${okq}: reaches offerable`, r.ceiling, STRENGTH.OFFERABLE);
  check(`${okq}: dates established`, r.dates_established, true);
  check(`${okq}: nothing missing`, r.missing, null);
}

//  ── NO DATES: bounded exploration, dates NOT established ────────────
const noDates = interpretGate("term_required");
check("term_required: still answers", noDates.blocks, false);
check("term_required: capped at likely_fit", noDates.ceiling, STRENGTH.LIKELY_FIT);
check("term_required: dates are NOT established", noDates.dates_established, false);
check("term_required: names the dates as the missing fact", noDates.missing, MISSING.REQUESTED_DATES);

//  ── DATES GIVEN, PRICING TERM UNRESOLVED — A DIFFERENT FACT ─────────
//  Collapsing this into "no term chosen" tells an operator their dates are
//  missing when they are not, and the homes WERE evaluated for the
//  interval they supplied. The db proof caught exactly this.
const noPricing = interpretGate("pricing_term_required");
check("pricing_term_required: still answers", noPricing.blocks, false);
check("pricing_term_required: capped at likely_fit", noPricing.ceiling, STRENGTH.LIKELY_FIT);
check("pricing_term_required: DATES ARE ESTABLISHED", noPricing.dates_established, true);
check("pricing_term_required: pricing term is not", noPricing.pricing_term_established, false);
check("pricing_term_required: names the pricing term, not the dates", noPricing.missing, MISSING.PRICING_TERM);
check("the two missing-input cases are not interchangeable",
  noDates.missing === noPricing.missing, false);

//  ── EVERYTHING ELSE BLOCKS, AND THE EMPTY CASES BLOCK TOO ───────────
//  Invalid caller input is a malformed question, not a weaker one. A read
//  failure is a fact about Spine, never about the property (§40.7).
//  null / undefined / "" were the remaining success hole: the caller used
//  to map anything unrecognised to null, and null meant "no refusal".
for (const bad of ["invalid_term", "invalid_pricing_term", "invalid_preferences",
                   "term_check_unavailable", "pricing_read_unavailable", "no_property",
                   "some_future_refusal", null, undefined, ""]) {
  const r = interpretGate(bad);
  check(`${JSON.stringify(bad)}: blocks every strength`, r.blocks, true);
  check(`${JSON.stringify(bad)}: has no ceiling`, r.ceiling, null);
}

console.log(`\n  match decision strength: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
