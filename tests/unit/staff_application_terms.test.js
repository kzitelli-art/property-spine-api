"use strict";

const assert = require("node:assert/strict");
const parser = require("../../src/leasing/staff_application_terms");

const full = parser.parseStaffApplicationTerms(
  "Terms for Jane: rent 1025; deposit 0; start 2026-10-01; end 2027-09-30; fees none; concessions none"
);
assert.equal(full.recognized, true);
assert.deepEqual(full.values, {
  rent: "1025.00",
  security_deposit: "0.00",
  lease_start_date: "2026-10-01",
  lease_end_date: "2027-09-30",
  fees: [],
  concessions: { status: "none" },
});
assert.deepEqual(full.missing, []);
assert.deepEqual(full.errors, []);

const partial = parser.parseStaffApplicationTerms("Terms: deposit 0; fees none", {
  rent: "1025.00",
});
assert.deepEqual(partial.values, { security_deposit: "0.00", fees: [] });
assert.deepEqual(partial.missing, ["lease_start_date", "lease_end_date", "concessions"]);

assert.equal(parser.parseStaffApplicationTerms("Jane wants the application").recognized, false);
assert.ok(parser.parseStaffApplicationTerms("Terms: rent 1025.005").errors.includes("invalid money for rent"));
assert.ok(parser.parseStaffApplicationTerms("Terms: start 2026-02-30").errors.includes("invalid date for lease_start_date"));
assert.ok(parser.parseStaffApplicationTerms("Terms: rent 1025; rent 1100").errors.includes("repeated terms field: rent"));
assert.ok(parser.parseStaffApplicationTerms("Terms: rent 1025?").errors.includes("questions are not terms assertions"));
assert.ok(parser.parseStaffApplicationTerms("Terms: rent not established").errors.includes("negated terms field: rent"));
assert.ok(parser.parseStaffApplicationTerms("Terms: fees $40 monthly").errors.some((e) => /structured fees/.test(e)));
assert.ok(parser.parseStaffApplicationTerms("Terms: concessions maybe").errors.some((e) => /structured concessions/.test(e)));

console.log("PASS staff application terms parser: explicit, partial, zero, invalid, ambiguous and structured cases");
