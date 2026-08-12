/* ════════════════════════════════════════════════════════════════════
   philadelphia_tax_clocks.test.js — THE JURISDICTION'S DATES, ASSERTED
   AGAINST THE CITY, WITH NO DATABASE AND NO CLOCK.

   `philadelphia_tax_rules.js` is a pure module, so it gets a pure test
   that runs on EVERY build rather than only when someone remembers to
   start Postgres. A tax clock is exactly the thing that must not be
   guarded by a suite people skip.

   ── IT EXISTS BECAUSE THE CLOCKS WERE WRONG TWICE ───────────────────
   1  U&O was modelled as "month M, due the 25th of M+1". It is the SAME
      MONTH. The first version reported the wrong month AND the wrong
      date, and every proof around it was green.
   2  NPT estimates were placed in the year the RETURN is filed. The
      estimates for tax year Y are due Apr 15 and Jun 15 OF Y — a full
      year before the return.

   Neither was caught by a passing test, because the tests asserted the
   implementation. So this file asserts the CITY: the published 2026 U&O
   schedule is written out date by date, and the derivation has to
   reproduce every one of them on its own.

   Run:  node tests/philadelphia_tax_clocks.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const rules = require("../src/asset/philadelphia_tax_rules.js");

const EXPECTED_ASSERTIONS = 44;
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
const due = (t, start, key, opts) =>
  (rules.milestonesFor(t, start, opts).find((m) => m.key === key) || {}).due || null;

console.log("════════════════════════════════════════════════════════");
console.log("  PHILADELPHIA TAX CLOCKS — pure, no database");
console.log("════════════════════════════════════════════════════════");

console.log("\n── 1. THE CITY'S PUBLISHED 2026 U&O SCHEDULE ─────────");

/*  Written out as the City publishes it. This table is the AUTHORITY;
 *  the module's weekend/holiday rule is a derivation that has to agree
 *  with it. Where they ever disagree, that is a finding about our rule.
 *
 *  The shifts are not decoration: Jan 25 is a Sunday, Apr 25 and Jul 25
 *  are Saturdays, and May 25 2026 is Memorial Day. */
const CITY_2026 = [
  ["2026-01", "2026-01-26", "the 25th is a Sunday"],
  ["2026-02", "2026-02-25", "a Wednesday — no shift"],
  ["2026-03", "2026-03-25", "a Wednesday — no shift"],
  ["2026-04", "2026-04-27", "the 25th is a Saturday"],
  ["2026-05", "2026-05-26", "the 25th is Memorial Day"],
  ["2026-06", "2026-06-25", "a Thursday — no shift"],
  ["2026-07", "2026-07-27", "the 25th is a Saturday"],
  ["2026-08", "2026-08-25", "a Tuesday — no shift"],
];

for (const [period, expected, why] of CITY_2026) {
  const start = period + "-01";
  ok(`U&O ${period} is due ${expected} — ${why}`,
     due("uo", start, "payment:monthly") === expected,
     String(due("uo", start, "payment:monthly")));
}

ok("⚠ the derivation reproduces EVERY published date with no help",
   rules.scheduleDisagreements().length === 0,
   JSON.stringify(rules.scheduleDisagreements()));

ok("a published date says so, so a surface never presents one as derived",
   rules.milestonesFor("uo", "2026-07-01").every((m) => m.date_source === "published"));
ok("a month the City has not published to us is marked DERIVED",
   rules.milestonesFor("uo", "2026-10-01").every((m) => m.date_source === "derived"));
ok("…and the derivation still shifts it — Oct 25 2026 is a Sunday",
   due("uo", "2026-10-01", "payment:monthly") === "2026-10-26",
   String(due("uo", "2026-10-01", "payment:monthly")));
ok("…and Christmas moves December off the 25th entirely",
   due("uo", "2026-12-01", "payment:monthly") === "2026-12-28",
   String(due("uo", "2026-12-01", "payment:monthly")));

//  ⚠ THE DEFECT, ASSERTED AS A DEFECT.
ok("⚠ U&O is SAME-MONTH — July is never due in August",
   due("uo", "2026-07-01", "payment:monthly").slice(0, 7) === "2026-07",
   String(due("uo", "2026-07-01", "payment:monthly")));
ok("…and filing and payment land on the same day, as separate requirements",
   due("uo", "2026-07-01", "filing:monthly") === due("uo", "2026-07-01", "payment:monthly")
   && rules.milestonesFor("uo", "2026-07-01").length === 2);

console.log("\n── 2. NPT: ESTIMATES IN YEAR Y, RETURN IN Y+1 ────────");

//  ⚠ THE SECOND DEFECT. All three used to sit in Y+1.
ok("⚠ the FIRST 2026 estimate is due Apr 15 2026, not 2027",
   due("npt", "2026-01-01", "payment:estimate_1") === "2026-04-15",
   String(due("npt", "2026-01-01", "payment:estimate_1")));
ok("⚠ the SECOND 2026 estimate is due Jun 15 2026, not 2027",
   due("npt", "2026-01-01", "payment:estimate_2") === "2026-06-15",
   String(due("npt", "2026-01-01", "payment:estimate_2")));
ok("the 2026 RETURN is due Apr 15 2027 — a year after its estimates",
   due("npt", "2026-01-01", "filing:return") === "2027-04-15",
   String(due("npt", "2026-01-01", "filing:return")));
ok("…and the 2026 balance rides with the return, not with the estimates",
   due("npt", "2026-01-01", "payment:balance") === "2027-04-15");
ok("the two estimates are DIFFERENT requirements, so one cannot pay the other",
   due("npt", "2026-01-01", "payment:estimate_1")
     !== due("npt", "2026-01-01", "payment:estimate_2"));
ok("NPT carries four requirements, spanning two calendar years",
   rules.milestonesFor("npt", "2026-01-01").length === 4);

console.log("\n── 3. BIRT: THE ESTIMATE RIDES ON THE RETURN ─────────");

/*  From a real 2023 BIRT return in the portfolio:
 *      5. Tax Due 2023
 *      6. MANDATORY 2024 BIRT Estimated Payment
 *      7. Total Due by 4/15/2024 (Line 5 plus Line 6)
 *  Two payment requirements, one date. */
ok("the 2025 return is due Apr 15 2026",
   due("birt", "2025-01-01", "filing:return") === "2026-04-15");
ok("the 2025 balance is due the same day, as its own requirement",
   due("birt", "2025-01-01", "payment:balance") === "2026-04-15");
ok("⚠ with NO filer profile the mandatory estimate is NOT invented",
   due("birt", "2025-01-01", "payment:estimate_next_year") === null);
ok("…and the module SAYS the requirement is unknown rather than absent",
   rules.unknownRequirements("birt", {}).length === 1
   && rules.unknownRequirements("birt", {})[0].requirement === "payment:estimate_next_year");
ok("…and names what would resolve it",
   /first-year, second-year or established/.test(
     rules.unknownRequirements("birt", {})[0].resolves));
ok("an ESTABLISHED filer owes the 2026 estimate, due with the 2025 return",
   due("birt", "2025-01-01", "payment:estimate_next_year",
       { birt_filer_profile: "established" }) === "2026-04-15");
ok("…and nothing is unknown once the profile is recorded",
   rules.unknownRequirements("birt", { birt_filer_profile: "established" }).length === 0);
ok("⚠ a FIRST-YEAR filer owes no estimate at all — the City's relief",
   due("birt", "2025-01-01", "payment:estimate_next_year",
       { birt_filer_profile: "first_year" }) === null
   && rules.unknownRequirements("birt", { birt_filer_profile: "first_year" }).length === 0);
ok("a SECOND-YEAR filer owes it, and the row can say installments are electable",
   rules.milestonesFor("birt", "2025-01-01", { birt_filer_profile: "second_year" })
     .find((m) => m.key === "payment:estimate_next_year").installments_electable === true);
ok("⚠ balance and estimate are SEPARATE keys, so paying one cannot pay the other",
   rules.milestonesFor("birt", "2025-01-01", { birt_filer_profile: "established" })
     .filter((m) => m.kind === "payment").map((m) => m.key).join(",")
     === "payment:balance,payment:estimate_next_year");

console.log("\n── 4. REAL ESTATE TAX ────────────────────────────────");

ok("the 2026 bill is due Mar 31 2026 — within its own year",
   due("real_estate", "2026-01-01", "payment:annual") === "2026-03-31");
ok("it has ONE requirement and nothing is filed",
   rules.milestonesFor("real_estate", "2026-01-01").length === 1
   && rules.REQUIRES_FILING.real_estate === false);
ok("…and its amount is governed, so a part payment can be recognised as part",
   rules.milestonesFor("real_estate", "2026-01-01")[0].amount_basis === "annual_liability");
ok("2027's Mar 31 is a Wednesday, so nothing shifts",
   due("real_estate", "2027-01-01", "payment:annual") === "2027-03-31");

console.log("\n── 5. WHICH PERIODS ARE LIVE ON 2026-08-12 ───────────");

const req = (t) => rules.activePeriods(t, "2026-08-12")
  .filter((p) => p.required).map((p) => p.label).join(",");
const opt = (t) => rules.activePeriods(t, "2026-08-12")
  .filter((p) => !p.required).map((p) => p.label).join(",");

ok("U&O requires THIS month", req("uo") === "2026-08", req("uo"));
ok("…and shows last month only if it is established", opt("uo") === "2026-07", opt("uo"));
ok("Real Estate requires the current tax year", req("real_estate") === "2026");
ok("BIRT requires the prior tax year — the one filed this April",
   req("birt") === "2025", req("birt"));
ok("⚠ NPT requires BOTH — last year's return and this year's estimates",
   req("npt") === "2025,2026", req("npt"));
ok("an optional period is never a finding when nothing is established",
   rules.activePeriods("real_estate", "2026-08-12")
     .find((p) => p.label === "2025").required === false);

console.log("\n── 6. U&O IS LIVE; ONLY THE EXEMPTION ENDED ──────────");

ok("on 2026-08-12 the annual exemption is gone",
   rules.uoExemptionStatus("2026-08-12").annual_exemption_available === false);
ok("…and the note says the TAX remains active and monthly",
   /remains active/.test(rules.uoExemptionStatus("2026-08-12").note)
   && /25th of the same month/.test(rules.uoExemptionStatus("2026-08-12").note));
ok("before 2026 the exemption was available",
   rules.uoExemptionStatus("2025-12-31").annual_exemption_available === true);

console.log("\n════════════════════════════════════════════════════════");
console.log(`  ${pass + fail} assertions · ${pass} passed · ${fail} failed`);
if (pass + fail !== EXPECTED_ASSERTIONS) {
  console.log(`  ✗ RUN INVALID — expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}.`);
  process.exit(1);
}
if (fail) { console.log("  ✗ FAIL"); process.exit(1); }
console.log("  ✓ PASS — the clocks agree with the City.");
console.log("════════════════════════════════════════════════════════");
