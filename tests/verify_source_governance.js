#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   verify_source_governance.js — THE STANDARD VALIDATION PATH.

   Runs the repository's source-governance gates. DB-free by design: these
   check the SOURCE, not a database, so they run anywhere with no
   credentials and no isolation risk.

       npm run verify

   ── WHY THIS EXISTS ─────────────────────────────────────────────────

   Before 2026-08-03 this repository had three gates —
   gate_closure_boundary.js, gate_no_raw_bridge_joins.js, and the new
   gate_harness_isolation.js — and NOTHING INVOKED ANY OF THEM. There is no
   CI workflow, and `npm test` did not exist. Each gate was a file someone
   had to remember to run.

   That is not a hypothetical cost. THREAD_HANDOFF records
   gate_closure_boundary.js as having been BLIND since a directory move,
   which nothing detected — because nothing was running it.

   A gate nobody invokes is documentation. This file is the invocation, and
   deploy.sh calls it so a deploy cannot be triggered past a red gate.

   ── IT ORCHESTRATES. IT DOES NOT REINTERPRET. ───────────────────────

   Children run with stdio INHERITED, so each gate's own evidence reaches
   the terminal unmodified. The first non-zero child exit becomes this
   process's exit code, and remaining gates are reported as NOT RUN rather
   than silently skipped. There is no flag that turns a red gate green.

   ── NOT A RUNTIME DEPENDENCY ────────────────────────────────────────

   This is deliberately NOT wired into `prestart` or application startup.
   It governs the source; it is not something the service needs in order to
   run. Putting it in the boot path would make a source-quality failure look
   like an outage.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const GATES = [
  { file: "gate_harness_isolation.js",
    what: "no new unguarded DATABASE_URL consumer; debt register accurate" },
  { file: "gate_closure_boundary.js",
    what: "closure boundary" },
  { file: "gate_no_raw_bridge_joins.js",
    what: "no raw bridge joins" },
  //  The conversational seams. DB-free, so they belong on the standard path:
  //  they check that the extracted logic has ONE implementation, that resident
  //  wording did not drift, and that an operating receipt and a delivery
  //  receipt cannot be collapsed into one claim.
  { file: "conversation_intent_extraction.test.js",
    what: "intent seam: one implementation, transport-independent, behaviour pinned" },
  { file: "conversation_clarification_and_receipt.test.js",
    what: "clarification + receipt seams: wording unchanged, operating ≠ delivery" },
  //  The technician work-selection decisions. Every one of them is a refusal,
  //  and a refusal that only fires against a provisioned database is a refusal
  //  nobody has seen fire. These run with no credentials.
  { file: "technician_work_selection.test.js",
    what: "technician: identity, scope, eligibility, replay, cross-property refusal" },
  { file: "technician_language.test.js",
    what: "technician language: plain phrases read correctly, nothing guessed into an action" },
];

const bar = "════════════════════════════════════════════════════════════════";

console.log("\n" + bar);
console.log("  PARENT VALIDATION STARTED — source governance");
console.log(`  ${GATES.length} gates · first failure stops the run and sets the exit code`);
console.log("  Each gate prints its OWN evidence below, unmodified.");
console.log(bar);

const results = [];
for (const g of GATES) {
  const target = path.join(__dirname, g.file);
  if (!fs.existsSync(target)) {
    console.error(`\n  ✗ ${g.file} — NOT FOUND. A missing gate is a failure, not a skip.\n`);
    process.exit(2);
  }

  console.log(`\n  ▶ GATE INVOKED — ${g.file}`);
  console.log(`    checks: ${g.what}\n`);

  const r = spawnSync(process.execPath, [target], { stdio: "inherit" });

  if (r.error) {
    console.error(`\n  ✗ ${g.file} could not be executed: ${r.error.message}`);
    console.error("  PARENT EXIT  2\n");
    process.exit(2);
  }
  if (r.signal) {
    console.error(`\n  ✗ ${g.file} killed by signal ${r.signal}. Not a pass.`);
    console.error("  PARENT EXIT  2\n");
    process.exit(2);
  }

  results.push({ file: g.file, code: r.status });
  console.log(`\n  ◀ CHILD EXIT CODE PRESERVED — ${g.file} exited ${r.status}`);

  if (r.status !== 0) {
    const notRun = GATES.length - results.length;
    console.error("\n" + bar);
    console.error(`  ✗ PARENT VALIDATION FAILED — ${g.file} exited ${r.status}.`);
    console.error("    Its output above is the evidence; this runner does not reinterpret it.");
    results.forEach((x) => console.error(`      ${String(x.code).padStart(3)}  ${x.file}`));
    if (notRun > 0) console.error(`      ${notRun} gate(s) NOT RUN.`);
    console.error(`\n  PARENT EXIT  ${r.status}   (reflects the child failure)`);
    console.error(bar + "\n");
    process.exit(r.status);
  }
}

console.log("\n" + bar);
console.log("  PARENT VALIDATION COMPLETE");
results.forEach((x) => console.log(`      ${String(x.code).padStart(3)}  ${x.file}`));
console.log(`\n  ✓ PASS — all ${results.length} source-governance gates exited 0`);
console.log("  PARENT EXIT  0");
console.log(bar + "\n");
process.exit(0);
