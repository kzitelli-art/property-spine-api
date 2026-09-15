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
    confirmed_contractual_occupancy: { occupied: rows.length, of_leasable_resolved: rows.length },
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

  /*  ── SECTION B · THE BUCKET MUST NOT SWALLOW THE CONTRACT ─────────
   *  The formal schedule and the operating table must show the same
   *  bucket -- that is right, and section B pins the three cases where
   *  deferring to the bucket FIXED a real defect (pending activation,
   *  needs review, and no basis at all could each read "Occupied").
   *
   *  But `rentRollBucketOf` buckets BOTH a canonical lease AND an
   *  accepted opening claim with terms unknown as `occupied`, and its own
   *  comment says so: "Occupied" must never secretly mean "a canonical
   *  lease exists". Returning the bare bucket label therefore tells a
   *  lender that a bed with no rent, term or legal right on record is
   *  Occupied -- and names the total `confirmed_contractual_occupancy`
   *  while counting it. One bucket, two facts; the lender surface is the
   *  one place they may not be collapsed.                              */
  const bucketRows = [
    { space_id: "sp-lease", unit_id: "u-10", unit_number: "B-1", space_label: "Bed A",
      current_rent: 900, economics_state: "available", tenancy_state: "contractually_occupied",
      bucket: "occupied", bucket_label: "Occupied" },
    { space_id: "sp-terms-unknown", unit_id: "u-11", unit_number: "B-2", space_label: "Bed A",
      current_rent: null, economics_state: "not_applicable",
      tenancy_state: "occupied_terms_not_established",
      bucket: "occupied", bucket_label: "Occupied" },
    { space_id: "sp-pending", unit_id: "u-12", unit_number: "B-3", space_label: "Bed A",
      current_rent: null, economics_state: "not_applicable", tenancy_state: "activation_pending",
      bucket: "activation_pending", bucket_label: "Pending Activation" },
    { space_id: "sp-review", unit_id: "u-13", unit_number: "B-4", space_label: "Bed A",
      current_rent: null, economics_state: "not_applicable", tenancy_state: "contested",
      bucket: "needs_review", bucket_label: "Needs Review" },
    { space_id: "sp-nobasis", unit_id: "u-14", unit_number: "B-5", space_label: "Bed A",
      current_rent: null, economics_state: "not_applicable", tenancy_state: "unresolved",
      bucket: null, bucket_label: null },
  ];
  canonical.currentRentRoll = async () => ({
    rows: bucketRows,
    as_of: "2026-09-14",
    totals: {
      inventory: bucketRows.length,
      leasable: bucketRows.length,
      //  ONE canonical lease among the five. The bucket says two are occupied.
      confirmed_contractual_occupancy: { occupied: 1, of_leasable_resolved: 4 },
      contractual_rent_trusted: 900,
      positions_contributing_rent: 1,
      contractual_rent_excluded_contested: 0,
      occupied_without_known_rent: 1,
      down: 0,
    },
    exceptions: { evidence_disagrees: 0, contested: 1 },
    proof_summary: { native_verified: 1, confirmed_opening_import: 1 },
    contested_claims: [],
    opening_truth: {},
  });
  const b = await institutionalRentRoll({
    query: async () => ({ rows: [{ name: "Bucket Fixture", display_name: null }] }),
  }, { property_id: "property-2", as_of: "2026-09-14" });
  const bRow = (id) => b.rows.find((item) => item.space_id === id);

  //  The three the bucket deferral correctly fixed. These must not regress.
  check("B1 pending activation keeps the bucket wording", bRow("sp-pending").status, "Pending Activation");
  check("B2 needs review keeps the bucket wording", bRow("sp-review").status, "Needs Review");
  check("B3 no basis reads Occupancy Unconfirmed", bRow("sp-nobasis").status, "Occupancy Unconfirmed");

  //  The distinction the bucket cannot carry.
  check("B4 a canonical lease reads Occupied", bRow("sp-lease").status, "Occupied");
  check("B5 accepted occupancy with terms unknown is NOT plain Occupied",
    bRow("sp-terms-unknown").status, "Occupied \u2014 terms not established");

  //  The total that names itself contractual must count only contracts.
  check("B6 confirmed_contractual_occupancy counts the contract, not the bucket",
    b.totals.confirmed_contractual_occupancy, 1);
  check("B7 the occupied bucket is still reported, under its own name",
    b.totals.occupied_all_bases, 2);
  const bCsv = institutionalCsv(b);
  check("B8 the CSV states confirmed contractual occupancy as the contract count",
    bCsv.split("\n").some((l) => l.startsWith("Confirmed contractual occupancy,1 of ")), true);
  check("B9 the CSV also states the occupied bucket separately",
    bCsv.split("\n").some((l) => l.startsWith("Occupied (all bases),2 of ")), true);

  console.log(`\n  institutional rent projection: ${passed} passed, ${failed} failed`);
  canonical.currentRentRoll = originalCurrentRentRoll;
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  canonical.currentRentRoll = originalCurrentRentRoll;
  console.error(error.stack || error);
  process.exit(1);
});
