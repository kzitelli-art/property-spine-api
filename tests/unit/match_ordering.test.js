#!/usr/bin/env node
"use strict";
/*  THE ORDERING EXPRESSES THE OPERATOR'S CHOICE.
 *
 *  The conversational projection shows the TOP THREE, so ranking is not a
 *  presentation detail — it decides which homes Mike is told about. The
 *  previous rule led with all_recorded_constraints_satisfied, which
 *  requires zero unknowns; with no term chosen every home has an unknown,
 *  so that key separated nothing and ranking fell through to "fewest
 *  unknowns". A home KNOWN to be wrong then outranked a home nothing
 *  ruled out, because more of its facts had been resolved.
 *
 *  No score, no weighting, no recommendation engine: one deterministic
 *  tuple over recorded facts.                                          */
const assert = require("node:assert/strict");
const { compareMatchedHomes } = require("../../src/leasing/leasing_inventory.js");

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  PASS  ${label}`); }
  catch (e) { failed++; console.log(`  FAIL  ${label}\n        ${e && e.message}`); }
}
const home = (o) => ({
  unit_number: o.unit_number || "100", space_label: o.space_label || null,
  governed_ready_date: o.ready || null, governed_price: o.price == null ? null : o.price,
  constraint_counts: { satisfied: o.satisfied || 0, violated: o.violated || 0,
    not_established: o.unknown || 0 },
});

//  ── THE CONSTRUCTED CASE FROM THE REVIEW ────────────────────────────
//  A: over budget AND wrong unit type, readiness satisfied, term unknown.
//  B: within budget, nothing against it, three facts still unresolved.
const A = home({ unit_number: "A1", violated: 2, satisfied: 1, unknown: 1 });
const B = home({ unit_number: "B1", violated: 0, satisfied: 1, unknown: 3 });

check("a home with recorded conflicts does not outrank one with none", () => {
  assert.ok(compareMatchedHomes(A, B) > 0,
    "the conflicting home sorted first");
});
check("the nonconflicting home wins regardless of argument order", () => {
  assert.ok(compareMatchedHomes(B, A) < 0, "order-dependent comparator");
});
check("conflicting homes are still ordered, not discarded", () => {
  const sorted = [A, B].sort(compareMatchedHomes);
  assert.equal(sorted.length, 2, "a home disappeared from the ranking");
  assert.equal(sorted[0].unit_number, "B1");
  assert.equal(sorted[1].unit_number, "A1", "the conflicting home must remain available");
});

//  ── UNKNOWNS STILL BREAK TIES AMONG EQUALLY UNCONFLICTED HOMES ──────
check("among homes with no conflicts, fewer unknowns still ranks first", () => {
  const few = home({ unit_number: "C1", violated: 0, unknown: 1 });
  const many = home({ unit_number: "C2", violated: 0, unknown: 4 });
  assert.ok(compareMatchedHomes(few, many) < 0);
});

//  ── STABLE TO THE EXACT SPACE ───────────────────────────────────────
//  Two beds in one unit at one price must not depend on row arrival.
check("equal beds in the same unit order deterministically by space label", () => {
  const bedA = home({ unit_number: "302", space_label: "Bed A", price: 900, violated: 0, unknown: 1 });
  const bedB = home({ unit_number: "302", space_label: "Bed B", price: 900, violated: 0, unknown: 1 });
  assert.ok(compareMatchedHomes(bedA, bedB) < 0, "no exact-space tie-break");
  assert.ok(compareMatchedHomes(bedB, bedA) > 0, "tie-break is not symmetric");
  assert.equal([bedB, bedA].sort(compareMatchedHomes)[0].space_label, "Bed A",
    "arrival order decided the ranking");
});

//  ── THE EXISTING TIE-BREAKS SURVIVE ─────────────────────────────────
check("earlier governed ready date still ranks first", () => {
  const soon = home({ unit_number: "D1", ready: "2026-10-01", violated: 0, unknown: 1 });
  const later = home({ unit_number: "D2", ready: "2026-12-01", violated: 0, unknown: 1 });
  assert.ok(compareMatchedHomes(soon, later) < 0);
});
check("lower governed price still ranks first", () => {
  const cheap = home({ unit_number: "E1", price: 800, violated: 0, unknown: 1 });
  const dear = home({ unit_number: "E2", price: 1200, violated: 0, unknown: 1 });
  assert.ok(compareMatchedHomes(cheap, dear) < 0);
});

console.log(`\n  match ordering: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
