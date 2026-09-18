#!/usr/bin/env node
// Pure projection coverage for the institutional rent column. The DB proof
// exercises the same projection over a real canonical row; this small test
// keeps the authority/finite-value rule runnable without a database.
"use strict";

const assert = require("node:assert/strict");
const canonical = require("../../src/surfaces/rent_roll_canonical.js");
const originalCurrentRentRoll = canonical.currentRentRoll;

const rows = [
  { space_id: "sp-unavailable", unit_id: "u-1", unit_number: "N-1", space_label: "Room 1",
    current_rent: -375, economics_state: "unavailable", tenancy_state: "contractually_occupied",
    lease: { start_date: "2026-01-01", end_date: "2026-12-31" } },
  { space_id: "sp-zero", unit_id: "u-2", unit_number: "N-2", space_label: "Room 1",
    current_rent: 0, economics_state: "available", tenancy_state: "contractually_occupied" },
  { space_id: "sp-negative", unit_id: "u-3", unit_number: "N-3", space_label: "Room 1",
    current_rent: -10, economics_state: "available", tenancy_state: "contractually_occupied" },
  { space_id: "sp-nan", unit_id: "u-4", unit_number: "N-4", space_label: "Room 1",
    current_rent: Number.NaN, economics_state: "available", tenancy_state: "contractually_occupied" },
  { space_id: "sp-null", unit_id: "u-5", unit_number: "N-5", space_label: "Room 1",
    current_rent: null, economics_state: "available", tenancy_state: "contractually_occupied" },
];

canonical.currentRentRoll = async () => ({
  rows,
  as_of: "2026-09-13",
  totals: {
    inventory: rows.length,
    leasable: rows.length,
    //  THE FULL SHAPE THE REAL READER PRODUCES. This fake carried only the
    //  two scalars, so it asserted a contract narrower than the one
    //  currentRentRoll actually returns — and the first consumer to read
    //  the rest got a TypeError from a test, not from reality. A fake that
    //  is missing fields the real thing always has is a fake that will
    //  eventually be wrong about something that matters.
    confirmed_contractual_occupancy: {
      occupied: rows.length, of_leasable_resolved: rows.length, pct: 100,
      excluded_from_denominator: { down: 0, contested: 0 },
      reported_beside: { occupied_terms_not_established: 0, unresolved_positions: 0,
        evidence_disagrees: 0, evidence_inconclusive: 0 },
    },
    contractual_rent_trusted: 0,
    positions_contributing_rent: 1,
    contractual_rent_excluded_contested: 0,
    occupied_without_known_rent: 4,
    down: 0,
  },
  exceptions: { evidence_disagrees: 0, contested: 0 },
  proof_summary: { native_verified: 0, confirmed_opening_import: 0 },
  contested_claims: [],
  opening_truth: {},
});

const { institutionalRentRoll, institutionalCsv } = require("../../src/surfaces/rent_roll_institutional.js");
let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}

(async () => {
  const report = await institutionalRentRoll({
    query: async () => ({ rows: [{ name: "Projection Fixture", display_name: null }] }),
  }, { property_id: "property-1", as_of: "2026-09-13" });
  const csv = institutionalCsv(report);
  const row = (id) => report.rows.find((item) => item.space_id === id);
  check("unavailable economics blanks a negative contractual amount", row("sp-unavailable").monthly_rent, "");
  check("available zero remains a recorded contractual amount", row("sp-zero").monthly_rent, 0);
  check("available negative remains recorded without a positivity heuristic", row("sp-negative").monthly_rent, -10);
  check("available nonfinite amount is blank", row("sp-nan").monthly_rent, "");
  check("available null amount is blank", row("sp-null").monthly_rent, "");
  const csvRow = csv.split("\n").find((line) => line.startsWith("N-1 · Room 1,"));
  check("CSV uses the same blank for unavailable contractual rent", csvRow && csvRow.split(",")[6], "");
  console.log(`\n  institutional rent projection: ${passed} passed, ${failed} failed`);
  canonical.currentRentRoll = originalCurrentRentRoll;
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  canonical.currentRentRoll = originalCurrentRentRoll;
  console.error(error.stack || error);
  process.exit(1);
});
