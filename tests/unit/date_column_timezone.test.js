// ════════════════════════════════════════════════════════════════════
//  date_column_timezone.test.js — the off-by-one is MEASURED, in real
//  timezones, not reasoned about.
//
//  This runs the helper in child processes with TZ set, because TZ is
//  read when the process starts: setting process.env.TZ inside one test
//  run would prove nothing about how the service behaves on a host in
//  Berlin. Each case also runs the OLD expression beside the new one, so
//  the test carries its own falsification — if someone reverts the
//  helper to toISOString(), the "old" column and the "new" column stop
//  disagreeing and these assertions go red.
//
//  CLASS 1 — permanent. Registered in tests/verify_source_governance.js,
//  which is what runs the gates; it needs no database, so it belongs there
//  and not in the e2e chain.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("node:path");
const { execFileSync } = require("node:child_process");

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { if (c) { pass++; console.log("  ok    " + m); }
  else { fail++; console.log("  FAIL  " + m + (d ? "  →  " + d : "")); } };

const ROOT = path.resolve(__dirname, "..", "..");
//  node-pg builds a `date` column's Date at LOCAL midnight. new Date(y, m, d)
//  is the same construction, so this fixture IS the shape under test.
const PROBE = `
const { dateColumnToIso } = require(${JSON.stringify(path.join(ROOT, "src/shared/date_column.js"))});
const d = new Date(2026, 7, 1);
process.stdout.write(JSON.stringify({
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  helper: dateColumnToIso(d),
  old: d.toISOString().slice(0, 10),
  fromString: dateColumnToIso("2026-08-01"),
}));`;

const run = (tz) => JSON.parse(execFileSync(process.execPath, ["-e", PROBE],
  { env: { ...process.env, TZ: tz }, encoding: "utf8" }));

console.log("\n== a `date` column renders the recorded day in every timezone ==");

//  AHEAD of UTC is where the old expression loses a day. Behind it, the
//  old expression is accidentally right — which is why UTC-only CI never
//  saw this, and why both directions are asserted rather than one.
for (const tz of ["UTC", "Europe/Berlin", "Pacific/Auckland", "Asia/Kolkata", "America/Los_Angeles"]) {
  const r = run(tz);
  ok(r.helper === "2026-08-01",
    `${tz}: a date column recorded as 2026-08-01 renders as 2026-08-01`, JSON.stringify(r));
  ok(r.fromString === "2026-08-01",
    `${tz}: an already-ISO string is sliced, not round-tripped through a Date`, JSON.stringify(r));
}

console.log("\n== the falsification: the old expression really does lose a day ==");
for (const tz of ["Europe/Berlin", "Pacific/Auckland", "Asia/Kolkata"]) {
  const r = run(tz);
  ok(r.old === "2026-07-31" && r.helper !== r.old,
    `${tz} is AHEAD of UTC: toISOString() yields ${r.old}, the helper yields ${r.helper}`, JSON.stringify(r));
}
for (const tz of ["UTC", "America/Los_Angeles"]) {
  const r = run(tz);
  ok(r.old === r.helper,
    `${tz} is UTC or behind it: the old expression agrees, which is why this stayed invisible`, JSON.stringify(r));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
