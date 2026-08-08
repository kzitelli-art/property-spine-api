#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_completion_guard_terminal_set.js — ONE TERMINAL SET, NOT THREE.

   Three things now decide what "terminal" means:

     release0/proof_state.js      the READER  — is this a defect?
     maintenance/proof_defect_sweep.js  the SWEEP — raise an obligation?
     migrations/140_...sql        the GUARD   — refuse the write?

   §3.2.0 already required the first two to agree, "so neither can
   consider a row a defect that the other treats as not-yet-due". Adding
   a database guard makes the same requirement sharper, and inverts the
   consequence of drift:

     guard NARROWER than reader   a status the reader calls terminal can
                                  still be written → the guard has a hole
                                  and the sweep raises the obligation
     guard WIDER than reader      a legitimate write is refused for a
                                  status nothing considers a completion

   Neither is discoverable at runtime — the first shows up as an
   obligation against a named role, the second as an outage. So it is
   checked here, in source, on the standard path.

   DB-free. It compares the executable SQL to the exported constant.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MIGRATION = path.join(ROOT, "migrations/140_post_activation_completion_guard.sql");
const SWEEP = path.join(ROOT, "src/maintenance/proof_defect_sweep.js");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  THE GUARD, THE READER AND THE SWEEP AGREE ON `TERMINAL`");
console.log("══════════════════════════════════════════════════════════════════\n");

//  Comments stripped: all three files DISCUSS the terminal set on purpose,
//  and a gate that reads an explanation of the rule as the rule itself is
//  the vacuity trap this release has hit twice.
const codeOf = (p) => fs.readFileSync(p, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*(--|\/\/).*$/gm, " ");

const { TERMINAL_STATUSES } = require("../src/release0/proof_state.js");
const reader = [...TERMINAL_STATUSES].sort();

ok("G0  the reader still exports a terminal set", reader.length >= 1, JSON.stringify(reader));

//  Pull the literal set out of the migration's executable SQL rather than
//  asserting a hardcoded pair — a gate that restates the answer cannot
//  detect the answer changing.
const sql = codeOf(MIGRATION);
const guardSets = [...sql.matchAll(/status\s+(?:not\s+)?in\s*\(([^)]*)\)/gi)]
  .map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort());

ok("G1  the guard's SQL declares a terminal set at all", guardSets.length >= 1,
   "no `status in (...)` found in the executable SQL — the trigger may have been " +
   "rewritten, and G2 would then be comparing nothing");

const disagreeing = guardSets.filter((s) => JSON.stringify(s) !== JSON.stringify(reader));
ok("G2  every terminal set in the guard equals the reader's",
   disagreeing.length === 0,
   "reader " + JSON.stringify(reader) + " vs guard " + JSON.stringify(disagreeing) +
   " — a guard NARROWER than the reader has a hole the sweep will bill to a human; " +
   "a guard WIDER than the reader refuses legitimate writes");

const sweep = codeOf(SWEEP);
const sweepSets = [...sweep.matchAll(/status\s+in\s*\(([^)]*)\)/gi)]
  .map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort());
ok("G3  the sweep's prefilter declares one too", sweepSets.length >= 1, "none found");
ok("G4  …and it equals the reader's as well",
   sweepSets.every((s) => JSON.stringify(s) === JSON.stringify(reader)),
   "reader " + JSON.stringify(reader) + " vs sweep " + JSON.stringify(sweepSets));

//  The guard must stay INERT before activation, or it breaks the census
//  that the whole cutover depends on.
ok("G5  the guard is still gated on an activation existing",
   /release_0_activation_current/.test(sql),
   "the trigger no longer checks for an activation — it would now block the " +
   "pre-cutover terminal rows the census exists to inventory");
ok("G6  …and still exempts the cutover inventory",
   /release_0_legacy_cutover_inventory/.test(sql),
   "legitimate legacy history would be refused on any later update");
ok("G7  …and still admits a governed completion via the evaluation head",
   /work_order_proof_evaluation_head/.test(sql),
   "the canonical writer itself would be refused");

//  NO BYPASS. A session flag a utility script can set is not a guarantee.
ok("G8  the guard has no session-variable escape hatch",
   !/current_setting\s*\(/i.test(sql),
   "a bypass a caller can set turns the guarantee into a comment");

console.log(`\n  passed ${pass}   failed ${fail}`);
console.log(fail === 0
  ? "\n  ✓ PASS — one terminal set, enforced in three places that cannot drift.\n"
  : "\n  ✗ FAIL — see above.\n");
process.exit(fail === 0 ? 0 : 1);
