#!/usr/bin/env node
"use strict";

const { federalHolidayClosure, federalHolidayClosures } = require("../../src/shared/us_federal_holidays");
let passed = 0;
let failed = 0;
function ok(label, condition) {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label); }
}

const closures2026 = federalHolidayClosures(2026);
const opm2026 = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12",
  "2026-11-11", "2026-11-26", "2026-12-25",
];

ok("all eleven OPM 2026 observed dates are closures", opm2026.every(date => closures2026.has(date)));
ok("the legal Saturday Independence Day also closes Skyline tours", closures2026.has("2026-07-04"));
ok("the day before the observed Independence Day remains open", !closures2026.has("2026-07-02"));
ok("a Sunday legal holiday closes its following observed Monday", federalHolidayClosure("2027-07-05") === "Independence Day (observed)");
ok("New Year's observed date can fall in the prior calendar year", federalHolidayClosure("2021-12-31") === "New Year's Day (observed)");
ok("a normal working date has no holiday closure", federalHolidayClosure("2026-08-21") === null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
