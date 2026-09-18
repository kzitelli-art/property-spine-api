#!/usr/bin/env node
"use strict";
/*  THE CALLER IS EXERCISED, NOT THE HELPER.
 *
 *  match_decision_strength.test.js calls the predicate directly and passed
 *  25/25 while leasing_inventory.js had NO REQUIRE FOR IT AT ALL. Every
 *  other local signal was blind too: `node --check` sees syntax, `require()`
 *  loads the module without running the function, and the gates never call
 *  matchProspectHomes. Only the db-backed proof executes that line, and it
 *  said ReferenceError: decisionStrength is not defined.
 *
 *  Two defects in this lane were of that exact shape — a helper correct in
 *  isolation whose caller was wrong. This test exists so that class fails
 *  HERE, in a second, with no database.
 *
 *  It deliberately does NOT assert matching behaviour. It asserts that the
 *  real call path REACHES the predicate and the predicate's results are
 *  consumed without a reference or type error. Behaviour belongs to the
 *  db-backed proof over real governed inventory.                          */
const assert = require("node:assert/strict");
const leasingInventory = require("../../src/leasing/leasing_inventory.js");

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  PASS  ${label}`); }
  catch (e) { failed++; console.log(`  FAIL  ${label}\n        ${e && e.message}`); }
}

//  A pool that answers every query with no rows. Enough for the gate and the
//  target/shape reads to complete and return SOMETHING, which is all this
//  test needs: the code path must run far enough to consult the predicate.
const emptyPool = { query: async () => ({ rows: [] }) };

(async () => {
  const inv = leasingInventory({ pool: emptyPool });
  let thrown = null, out = null;
  try {
    out = await inv.matchProspectHomes({ property_id: "11111111-1111-1111-1111-111111111111" }, emptyPool);
  } catch (e) { thrown = e; }

  check("the caller reaches the predicate without a ReferenceError", () => {
    assert.ok(!(thrown instanceof ReferenceError),
      `ReferenceError from the real call path: ${thrown && thrown.message}`);
  });
  check("the caller does not TypeError on the predicate's result", () => {
    assert.ok(!(thrown instanceof TypeError),
      `TypeError from the real call path: ${thrown && thrown.message}`);
  });
  check("a decision was produced, or a refusal was returned — not a crash", () => {
    assert.ok(thrown === null && out && typeof out === "object",
      `no usable result; threw: ${thrown && thrown.message}`);
  });
  //  The ceiling is the value termChosen is derived from, so a caller that
  //  cannot see it produces the coverage/needs_for_offer regression this
  //  lane already shipped once.
  check("the answer carries a decision strength ceiling the caller can derive from", () => {
    assert.ok(out && (out.matched === false || "decision_strength_ceiling" in out),
      `matched answer without a ceiling: ${JSON.stringify(out && Object.keys(out))}`);
  });

  console.log(`\n  match caller reaches predicate: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
