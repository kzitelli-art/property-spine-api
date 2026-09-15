// ════════════════════════════════════════════════════════════════════
//  prospect_fact_reading.test.js — WHAT A PERSON SAID, AND WHETHER
//  SPINE MAY COMPARE IT.
//
//  These two readers decide whether a prospect hears "here are homes"
//  or "no priced home matched these criteria". Getting them wrong does
//  not produce a blank — it produces a confident NEGATIVE, which is the
//  worse half of §5.
//
//  The shapes tested are not invented. src/comms/prospect_capture.js
//  instructs the model to store a budget as "short verbatim-ish text
//  (e.g. '$1,400/mo', 'under $1,600', '$800 per person')" and validates
//  move_month to 'YYYY-MM' or 'flexible'. So this file asserts the
//  reader against the writer's OWN stated output, not against a tidy
//  format nobody produces.
//
//  Each refusal case carries its falsification inline: the expression
//  this reader replaced is run beside it, so the test shows the defect
//  rather than describing it.
//
//  CLASS 1 — permanent. Registered in tests/verify_source_governance.js.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("node:path");
const { budgetAmount, moveMonthEnd } =
  require(path.join(__dirname, "..", "..", "src/leasing/leasing_inventory.js"));

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { if (c) { pass++; console.log("  ok    " + m); }
  else { fail++; console.log("  FAIL  " + m + (d ? "  →  " + d : "")); } };

//  The expression this reader replaced — first number anywhere in the string.
const oldBudget = (v) => {
  const m = String(v).replace(/[,\s]/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

console.log("\n== the shapes prospect_capture.js actually writes ==");
for (const [text, amount] of [["$1,400/mo", 1400], ["under $1,600", 1600],
  ["$800 per person", 800], ["1200", 1200], ["$1,200", 1200]]) {
  const r = budgetAmount({ value: text });
  ok(r.amount === amount && r.why === null,
    `"${text}" reads as ${amount}`, JSON.stringify(r));
}

console.log("\n== shorthand is REFUSED, not silently divided by a thousand ==");
for (const text of ["up to $1.4k", "1.4k", "$1.4k/mo", "2k"]) {
  const r = budgetAmount({ value: text });
  ok(r.amount === null && r.why === "recorded_budget_uses_shorthand",
    `"${text}" is a recorded fact Spine cannot compare`, JSON.stringify(r));
  //  THE FALSIFICATION, INLINE. The old expression did not refuse — it
  //  returned a number three orders of magnitude too small, and every
  //  priced home then fell outside the budget.
  const was = oldBudget(text);
  ok(was !== null && was < 100,
    `…and the expression it replaces returned ${was} for "${text}" — a budget no home can meet`);
}

console.log("\n== a range is two facts, so neither end is invented ==");
for (const text of ["$1,200–$1,400", "1200-1400", "$1,200 to $1,400"]) {
  const r = budgetAmount({ value: text });
  ok(r.amount === null && r.why === "recorded_budget_is_a_range",
    `"${text}" refuses rather than choosing an end`, JSON.stringify(r));
}
ok(oldBudget("$1,200–$1,400") === 1200,
  "…and the expression it replaces took the LOW end, discarding the top the person stated");

console.log("\n== nothing numeric at all is still its own reason ==");
for (const [text, why] of [["ask me", "recorded_budget_not_numeric"],
  ["", "recorded_budget_not_numeric"]]) {
  ok(budgetAmount({ value: text }).why === why, `"${text}" → ${why}`);
}
ok(budgetAmount(null).why === "no_recorded_budget",
  "no recorded budget is NOT a budget of zero and NOT unreadable text — its own third reason");

console.log("\n== a month is a month; a named day is a deadline ==");
ok(moveMonthEnd({ value: "2026-10" }).end === "2026-10-31",
  "'2026-10' — the shape capture writes — allows the whole month");
for (const [text, end] of [["2026-10-01", "2026-10-01"], ["2026-10-15", "2026-10-15"],
  ["2026-10-31", "2026-10-31"]]) {
  ok(moveMonthEnd({ value: text }).end === end,
    `"${text}" is a deadline of ${end}, not the end of October`,
    JSON.stringify(moveMonthEnd({ value: text })));
}
//  The falsification: every one of those used to collapse to month-end,
//  so a home ready on the 25th passed a prospect who said the 1st.
ok(["2026-10-01", "2026-10-15"].every((v) => moveMonthEnd({ value: v }).end !== "2026-10-31"),
  "…and none of them still collapses to 2026-10-31, which promoted homes the prospect could not take");

console.log("\n== shapes that are not a month stay honestly uncomparable ==");
for (const text of ["2026-13", "2026-10-32", "2026-02-30", "October", "ASAP", "spring"]) {
  ok(moveMonthEnd({ value: text }).why === "recorded_move_month_not_a_month",
    `"${text}" is recorded and not comparable`, JSON.stringify(moveMonthEnd({ value: text })));
}

console.log("\n== a KNOWN GAP, asserted so it stays visible ==");
//  'flexible' is a value prospect_capture.js deliberately writes, and this
//  reader cannot use it. Treating it as "any date" would be an invented
//  latitude; treating it as missing loses that the person answered. Today it
//  reads as uncomparable, which is honest but not yet useful.
ok(moveMonthEnd({ value: "flexible" }).why === "recorded_move_month_not_a_month",
  "'flexible' — a value capture writes on purpose — is not yet usable by the matcher");

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
