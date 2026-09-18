// ════════════════════════════════════════════════════════════════════
//  rent_roll_source_totals.test.js — DID SPINE READ THE FILE CORRECTLY?
//
//  WHAT THIS PROTECTS
//  ------------------
//  Every Yardi rent roll ends with its own stated totals. The adapter
//  found that footer only in order to STOP at it, and discarded the
//  numbers — so nothing downstream could ever compare what was extracted
//  against what the file says about itself.
//
//  Without that comparison, "all 104 rows parsed cleanly" was the whole
//  of the evidence that a 105-bed building had been read. Individual rows
//  looking valid is not evidence that the SET is complete; it is exactly
//  the trap where green is a claim about what was measured.
//
//  TWO RECONCILIATIONS, NEVER CONFLATED
//  ------------------------------------
//    1. source extraction   did we reproduce what this file says?
//    2. canonical position  do its claims attach to established positions?
//
//  This is only (1). The footer comes out of the same Yardi report as the
//  detail rows, so agreement proves EXTRACTION FIDELITY and never truth
//  about the building — a stale lease is stated identically in both. What
//  makes it worth having is that a layout read wrongly does not land on
//  the source's own totals by accident.
//
//  THE FIXTURE IS A REAL BUILDING
//  ------------------------------
//  tests/fixtures/rent_roll/greenery_1325_2026-08-31.csv carries all 105
//  rows of The Greenery's August 2026 rent roll and that report's own
//  footer. The totals asserted below are the ones in the document the
//  lender received.
// ════════════════════════════════════════════════════════════════════
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseRentRollSource } = require("../../src/onboarding/rent_roll_source_adapter.js");
const { mapRows } = require("../../src/onboarding/rent_roll_field_map.js");
const {
  reconcileToSourceTotals, describeTotalsMismatch, TOTALS_MISMATCH,
} = require("../../src/onboarding/rent_roll_source_reconciliation.js");

const FIXTURE = path.join(__dirname, "..", "fixtures", "rent_roll",
  "greenery_1325_2026-08-31.csv");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1; }
}

function check(csv) {
  const parsed = parseRentRollSource({ buffer: Buffer.from(csv, "utf8"), filename: "rr.csv" });
  const { mapped } = mapRows(parsed.rows);
  return {
    parsed,
    result: reconcileToSourceTotals({ mapped, declared: parsed.source_declared_totals }),
  };
}

const greenery = () => fs.readFileSync(FIXTURE, "utf8");

test("the footer's stated totals are retained, not discarded at the break", () => {
  const { parsed } = check(greenery());
  assert.deepEqual(parsed.source_declared_totals, {
    bed_count: 105, sqft: 0, market_rent: 113500, actual_rent: 101200,
    deposit: 107146, other: 0, balance: -3096.72,
  });
  assert.match(parsed.source_declared_totals_label, /^Total: 1325 - The Greenery/);
});

test("The Greenery's real August rent roll reconciles on every stated figure", () => {
  const { parsed, result } = check(greenery());
  assert.equal(parsed.rows.length, 105);
  assert.equal(result.checked, true);
  assert.equal(result.mismatches.length, 0, describeTotalsMismatch(result) || "");
  //  Named one by one: a count of passing checks would not notice a field
  //  silently dropping out of the comparison.
  const byField = Object.fromEntries(result.checks.map((c) => [c.field, c]));
  for (const f of ["bed_count", "market_rent", "actual_rent", "deposit", "other", "balance"]) {
    assert.ok(byField[f], `${f} was not checked at all`);
    assert.equal(byField[f].agrees, true, `${f} disagrees`);
  }
  assert.equal(byField.bed_count.parsed, 105);
  assert.equal(byField.market_rent.parsed, 113500);
  assert.equal(byField.actual_rent.parsed, 101200);
});

test("ONE dropped row is caught — the 105-versus-104 case", () => {
  const lines = greenery().split("\n");
  const without = lines.filter((_, i) => i !== 40).join("\n");
  const { parsed, result } = check(without);
  assert.equal(parsed.rows.length, 104);
  assert.ok(result.mismatches.length >= 4, "a dropped resident must fail several checks");
  const bed = result.checks.find((c) => c.field === "bed_count");
  assert.equal(bed.declared, 105);
  assert.equal(bed.parsed, 104);
  assert.match(describeTotalsMismatch(result), /states 105 but Spine read 104/);
  assert.match(describeTotalsMismatch(result), /Nothing was established/);
});

test("a hierarchical by-unit export cannot pass itself off as read", () => {
  //  Skyline's Summarize By = Unit shape: a unit subtotal row, room rows
  //  and bed rows describing the SAME physical beds. Summing them triple
  //  counts market rent and produces nothing like the stated 160 beds.
  const { result } = check([
    "Rent Roll,,,,,,,,,,,,,,,,",
    "1417 - Skyline Apartments (crm1417),,,,,,,,,,,,,,,,",
    "As Of = 08/31/2026,,,,,,,,,,,,,,,,",
    "Unit,Room,Bed,Unit/Room Type,Resident,Total Rooms,Total Beds,Sq Ft,Market Rent," +
      "Actual Rent,Resident Deposit,Other Deposit,Move In,Lease From,Lease To,Move Out,Balance",
    "Current/Notice/Vacant Residents,,,,,,,,,,,,,,,,",
    "1417-101,,,STU00015,VACANT,3.00,3.00,,2450.00,,,,,,,,0.00",
    "1417-101,Room1,,STU00015,VACANT,,1.00,,875.00,,,,,,,,0.00",
    "1417-101,Room1,bed1,STU00015,VACANT,,,,866.67,,,,,,,,0.00",
    "Total: 1417 - Skyline Apartments (crm1417),,,,,160.00,160,0.00,136000.00," +
      "115953.66,128480.67,0.00,,,,,-2909.61",
  ].join("\n"));
  assert.ok(result.mismatches.length > 0, "the by-unit shape must not reconcile");
  const bed = result.checks.find((c) => c.field === "bed_count");
  assert.equal(bed.declared, 160);
  assert.notEqual(bed.parsed, 160);
});

test("future applicants hold no bed, so they are outside the bed-count check", () => {
  //  Greenery's August roll carries 14 future residents with no unit
  //  assigned. The footer's 105 is the building's inventory, not a row
  //  count, so counting them would manufacture a mismatch out of a
  //  correctly read file.
  const lines = greenery().split("\n");
  const footer = lines.pop() || lines.pop();
  const withFuture = [
    ...lines.filter((l) => l.trim() !== ""),
    "Future Residents/Applicants,,,,,,,,,,,,,,",
    ",,STU00011,Gianna Barile (s0005974),,0.00,0.00,0.00,0.00,0.00,08/01/2026,08/01/2026,07/26/2027,,0.00",
    ",,STU00011,Analla Moore (s0005976),,0.00,0.00,0.00,0.00,0.00,08/01/2026,08/01/2026,07/26/2027,,0.00",
    footer,
  ].join("\n");
  const { result } = check(withFuture);
  const bed = result.checks.find((c) => c.field === "bed_count");
  assert.equal(bed.parsed, 105, "future rows must not inflate the bed count");
  assert.equal(bed.agrees, true);
  assert.equal(result.mismatches.length, 0, describeTotalsMismatch(result) || "");
});

test("a layout stating no totals is unchecked, not failed", () => {
  //  Absence of a check is not a failed check. Refusing every source that
  //  happens not to print a footer would be a gate punishing correct files.
  const r = reconcileToSourceTotals({ mapped: [{ market_rent: 950 }], declared: null });
  assert.equal(r.checked, false);
  assert.deepEqual(r.mismatches, []);
});

test("money compares in cents, so summing 105 doubles cannot invent a mismatch", () => {
  //  0.1 + 0.2 !== 0.3 in IEEE-754. Three rows of 1/3 of a dollar sum to
  //  exactly one dollar here or the checksum fails honest files.
  const r = reconcileToSourceTotals({
    mapped: [{ actual_rent: 0.1 }, { actual_rent: 0.2 }],
    declared: { actual_rent: 0.3 },
  });
  assert.equal(r.mismatches.length, 0, "float drift must not read as a mismatch");
});

test("the refusal code and copy name the next step", () => {
  assert.equal(TOTALS_MISMATCH, "source_totals_mismatch");
  const r = reconcileToSourceTotals({
    mapped: [{ market_rent: 100 }], declared: { market_rent: 200 },
  });
  const said = describeTotalsMismatch(r);
  assert.match(said, /the report states \$200\.00/);
  assert.match(said, /total \$100\.00/);
  assert.match(said, /review how this rent-roll layout was interpreted/);
});

process.on("exit", () => {
  if (!process.exitCode) console.log(`${passed} source-totals reconciliation tests passed`);
});
