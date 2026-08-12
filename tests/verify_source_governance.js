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
  //  A field-name typo is silent where a function-name typo is loud.
  //  `req.operator.user_id` did not exist and made every governed
  //  maintenance action anonymous for as long as it was there.
  { file: "gate_operator_session_fields.js",
    what: "no req.operator read of a field the staff session does not define" },
  //  Steps 2–3 candidates. Both are source-only and DB-free, so they
  //  belong on the standard path rather than in a harness nobody runs.
  { file: "gate_migration_137_promotion.js",
    what: "migration 137 DDL is the proven scale payload, unchanged" },
  { file: "gate_completion_writers.js",
    what: "exactly the expected work-order completion writers; no third writer" },
  //  Boundary 8a lands the activation service and 8b turns the guard on.
  //  Between them the code must be present and unreachable — an activation
  //  wired to a route could fire without the census, without the frozen
  //  legacy set, and without anyone reading POPULATION_NOT_EXPLAINABLE.
  { file: "gate_activation_dormant.js",
    what: "the activation service is present and reachable from nothing" },
  //  Build 0 (client registration & property activation). Creating a property
  //  is the highest-authority write in the product and was the least governed:
  //  four routes do it, they disagree on identity/hierarchy/authority, and none
  //  is exercised anywhere. This pins that measured state so Build 1 has to
  //  change it deliberately. See docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md.
  { file: "gate_property_creation_paths.js",
    what: "exactly the known client/property creation paths; no fifth door" },
  //  The wall between insurance economics and premium financing. The June
  //  2026 workpaper reconstructs a property's annual insurance cost from
  //  the IPFS stream, which makes the payment instrument the source of the
  //  economic fact. This gate is what stops that seam growing back once
  //  premium financing is built beside it.
  { file: "gate_insurance_economic_independence.js",
    what: "insurance economics answerable without financing, escrow or payment" },
  //  The same wall, asserted STRUCTURALLY and in BOTH directions. The gate
  //  above reads vocabulary in the economic chain; this one reads the
  //  dependency graph. Vocabulary cannot catch an economic file requiring a
  //  funding module whose name is innocent, nor a funding module writing an
  //  economic table — and once funding exists, that is exactly how the seam
  //  would rot while the vocabulary gate kept passing.
  { file: "gate_funding_boundary.js",
    what: "economics cannot reach funding; funding cannot author economics (insurance + tax)" },
  //  The jurisdiction's dates. A PURE module, so it belongs on the standard
  //  path rather than behind a database nobody starts — and it earned its
  //  place: the clocks shipped wrong twice (U&O a month late, NPT estimates
  //  a YEAR late) with every surrounding proof green, because those proofs
  //  asserted the implementation. This one asserts the City's published
  //  schedule, date by date, and requires the derivation to reproduce it.
  { file: "philadelphia_tax_clocks.test.js",
    what: "Philadelphia tax clocks agree with the City's published schedule" },
  //  The tax proposal adapter, against the extracted text of REAL City
  //  documents held in tests/fixtures/tax. Pure, so it runs here. A reader
  //  proven against an invented format is proven against nothing.
  { file: "tax_document_read.test.js",
    what: "tax document reader: reads real City bills and returns, refuses to guess" },
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
  //  Ask Spine slice 2. A chat box is the easiest place to ship a
  //  confident lie, so the honesty properties are on the standard path.
  { file: "ask_spine_answer.test.js",
    what: "Ask Spine: answers only from reads, names them, and an outage never reads as good news" },
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
