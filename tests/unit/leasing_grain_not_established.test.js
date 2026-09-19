// ════════════════════════════════════════════════════════════════════
//  leasing_grain_not_established.test.js — 'unknown' IS NOT 'unit'
//
//  WHAT THIS PROTECTS
//  ------------------
//  Migration 026 declared three leasing bases — 'unit', 'bed', 'unknown'
//  — and named the third the honest default. Six places then read that
//  column with a TWO-way branch:
//
//      leasing_basis === "bed" ? "bed" : "unit"
//      coalesce(leasing_basis,'unit')
//
//  so the column's own NOT NULL DEFAULT resolved, silently, to "this
//  building leases by the unit" — at the moment a rent roll establishes
//  the building's canonical positions.
//
//  WHY A COUNT TEST AND NOT A STORY
//  --------------------------------
//  On a by-the-bed property, grain 'unit' makes stableSpaceLabel() return
//  "(whole unit)" for every row. snapshot_loader's guard for an
//  unidentifiable position fires on `label === "(bed)"`, so under the
//  wrong grain it NEVER RUNS. Nothing is flagged. Numerator and
//  denominator collapse together: a 3-bed unit with two residents and one
//  empty bed becomes one occupied unit, and the vacant bed does not
//  become miscounted — it stops existing.
//
//  Skyline: 160 beds / 72 units. Greenery: 105 beds / 64 units. The
//  reachSCENARIO below is those buildings' real shape.
//
//  The last test is a source scan. The coercion was reintroduced in six
//  independent places over the project's life; a contract nobody can
//  re-break by hand is the only version that survives the next sweep.
// ════════════════════════════════════════════════════════════════════
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  leasingGrain, resolveLeasingGrain, GRAIN_NOT_ESTABLISHED, GRAIN_REFUSAL_MESSAGE,
} = require("../../src/tenancy/leasing_grain.js");

const root = path.join(__dirname, "..", "..");
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1; }
}

test("an established basis reads back as itself, case and padding ignored", () => {
  assert.equal(leasingGrain("bed"), "bed");
  assert.equal(leasingGrain("unit"), "unit");
  assert.equal(leasingGrain("BED"), "bed");
  assert.equal(leasingGrain("  Unit "), "unit");
});

test("'unknown' resolves to NOTHING — it is the absence of an answer", () => {
  //  The whole defect in one line. `=== "bed" ? "bed" : "unit"` returns
  //  "unit" here, which is a confident answer to a question nobody asked.
  assert.equal(leasingGrain("unknown"), null);
});

test("no other value is quietly admitted as a grain", () => {
  for (const v of [null, undefined, "", "   ", "whole unit", "room", "beds", "Unit-by-unit", 0, {}]) {
    assert.equal(leasingGrain(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test("a caller may establish the grain; a blank caller may not overrule the property", () => {
  assert.equal(resolveLeasingGrain({ supplied: "bed", property: "unknown" }), "bed");
  assert.equal(resolveLeasingGrain({ supplied: null, property: "bed" }), "bed");
  assert.equal(resolveLeasingGrain({ supplied: "unknown", property: "bed" }), "bed");
  assert.equal(resolveLeasingGrain({ supplied: null, property: "unit" }), "unit");
});

test("neither side established → null, so the caller must refuse", () => {
  assert.equal(resolveLeasingGrain({ supplied: null, property: "unknown" }), null);
  assert.equal(resolveLeasingGrain({ supplied: "unknown", property: "unknown" }), null);
  assert.equal(resolveLeasingGrain({}), null);
});

test("the refusal is sayable and names the next step", () => {
  //  A refusal a person can see is product copy (PHILOSOPHY §5). This one
  //  is shown to someone who just uploaded a rent roll, so it must say
  //  what THEY do next, not what the machinery lacks.
  assert.equal(GRAIN_NOT_ESTABLISHED, "leasing_basis_not_established");
  assert.match(GRAIN_REFUSAL_MESSAGE, /by bed or by unit/);
  assert.match(GRAIN_REFUSAL_MESSAGE, /Choose the property grain/);
});

test("the real building shapes: wrong grain destroys the vacancy, not just the count", () => {
  //  Skyline 1417-101 as the August 2026 rent roll states it: three rooms,
  //  two let, one empty. Bed grain sees the empty bed. Unit grain cannot.
  const unit = [
    { space_label: "Room1", vacant: false },
    { space_label: "Room2", vacant: false },
    { space_label: "Room3", vacant: true },
  ];
  const positionsAt = (grain) =>
    grain === "bed" ? unit.map(r => r.space_label) : ["(whole unit)"];

  assert.deepEqual(positionsAt("bed"), ["Room1", "Room2", "Room3"]);
  assert.equal(positionsAt("bed").length, 3);
  assert.equal(positionsAt("unit").length, 1);

  //  Vacancy is the number that disappears, and it is the one an owner,
  //  a lender and a leasing agent each act on.
  const vacantAt = (grain) => grain === "bed" ? unit.filter(r => r.vacant).length : 0;
  assert.equal(vacantAt("bed"), 1);
  assert.equal(vacantAt("unit"), 0);

  //  Which is why an unestablished grain may not silently pick one.
  assert.equal(resolveLeasingGrain({ property: "unknown" }), null);
});

test("the governed ingest seam never reads the RAW column two ways", () => {
  //  SCOPE, stated: these three files are every governed path that resolves
  //  a property's grain before source rows become canonical positions.
  //  space_position.js is absent because it never reads the column.
  //  deal_intake.js is absent deliberately — its `["unit","bed"].includes()`
  //  validates a human's explicit answer before storing it, which is correct.
  const governed = [
    "src/shared/snapshot_loader.js",
    "src/onboarding/activation_service.js",
    "src/onboarding/source_home_identity_review.js",
  ];
  //  The ban is narrow ON PURPOSE. Branching `basis === "bed" ? … : …` on an
  //  ALREADY-RESOLVED grain is right and appears throughout these files. What
  //  may never happen is reading the RAW three-value column, or the caller's
  //  unvalidated option, through a two-way branch. A broad pattern here would
  //  be a gate that fails on correct code, which teaches people to delete it.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const banned = [
    [/leasing_basis[^\n;]*===\s*["']bed["']\s*\?/, "raw leasing_basis in a two-way ternary"],
    [/leasingModel[^\n;]*===\s*["']bed["']\s*\?/, "raw caller leasingModel in a two-way ternary"],
    [/coalesce\(\s*leasing_basis\s*,\s*'(?:unit|bed)'/i, "SQL coalesce of leasing_basis to a grain"],
    [/leasing_basis[^\n;]*\|\|\s*["'](?:unit|bed)["']/, "|| fallback from leasing_basis to a grain"],
  ];
  for (const rel of governed) {
    const src = stripComments(fs.readFileSync(path.join(root, rel), "utf8"));
    for (const [pattern, why] of banned) {
      assert.ok(!pattern.test(src), `${rel} reintroduces ${why}`);
    }
    assert.ok(/leasing_grain/.test(src),
      `${rel} must resolve grain through tenancy/leasing_grain.js`);
  }
});

process.on("exit", () => {
  if (!process.exitCode) console.log(`${passed} leasing-grain contract tests passed`);
});
