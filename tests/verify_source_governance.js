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
  { file: "unit/release0_audit_forbidden_fields.test.js",
    what: "Release 0 audit queries keep forbidden message, identity and work contents out of receipts" },
  //  Twice now a file has decided SSL for itself: server.js, which never
  //  became healthy in CI, and tools/apply_unit_type_mapping.js, which took
  //  CI red for four runs while the suite passed on every developer machine.
  //  A local Postgres has ssl = on and CI's container does not, so this is
  //  invisible everywhere except the one place it matters.
  { file: "gate_ci_path_ssl.js",
    what: "nothing on the CI path hardcodes SSL; the one rule still answers correctly" },
  { file: "gate_closure_boundary.js",
    what: "closure boundary" },
  { file: "gate_no_raw_bridge_joins.js",
    what: "no raw bridge joins" },
  //  A field-name typo is silent where a function-name typo is loud.
  //  `req.operator.user_id` did not exist and made every governed
  //  maintenance action anonymous for as long as it was there.
  { file: "gate_operator_session_fields.js",
    what: "no req.operator read of a field the staff session does not define" },
  { file: "gate_native_tour_scheduler.js",
    what: "one Spine-owned tour-slot command; staff scope and attribution stay server-derived" },
  { file: "unit/us_federal_holidays.test.js",
    what: "federal holiday closures match the legal and OPM-observed calendar rules" },
  { file: "unit/tour_schedule_ask_spine.test.js",
    what: "dashboard and staff SMS Ask Spine read the same native tour schedule standing" },
  { file: "unit/team_access_session_boundary.test.js",
    what: "Team roster, invite and access changes use the signed-in staff boundary without a browser operator key" },
  //  Steps 2–3 candidates. Both are source-only and DB-free, so they
  //  belong on the standard path rather than in a harness nobody runs.
  { file: "gate_migration_137_promotion.js",
    what: "migration 137 DDL is the proven scale payload, unchanged" },
  { file: "unit/migration_ledger_verdict.test.js",
    what: "migration ledger agreement is checked in both directions, including duplicate and naming conflicts" },
  //  The release guard stops production migrations, and until now the only
  //  thing that ran its proof was somebody remembering to. It is DB-free
  //  (it stubs `pg`) and builds its own scratch git repository, so it
  //  belongs on the standard path. A safety check nobody runs is the exact
  //  failure this harness was written for; it does not get to be the third.
  { file: "unit/migration_release_gate.test.js",
    what: "EXPECTED_LEDGER_CEILING and EXPECTED_SHA are enforced, on Render and off it" },
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
  //  change it deliberately. See docs/archive/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md.
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
  { file: "unit/philadelphia_tax_clocks.test.js",
    what: "Philadelphia tax clocks agree with the City's published schedule" },
  //  The tax proposal adapter, against the extracted text of REAL City
  //  documents held in tests/fixtures/tax. Pure, so it runs here. A reader
  //  proven against an invented format is proven against nothing.
  { file: "unit/tax_document_read.test.js",
    what: "tax document reader: reads real City bills and returns, refuses to guess" },
  //  The conversational seams. DB-free, so they belong on the standard path:
  //  they check that the extracted logic has ONE implementation, that resident
  //  wording did not drift, and that an operating receipt and a delivery
  //  receipt cannot be collapsed into one claim.
  { file: "unit/conversation_intent_extraction.test.js",
    what: "intent seam: one implementation, transport-independent, behaviour pinned" },
  { file: "unit/conversation_clarification_and_receipt.test.js",
    what: "clarification + receipt seams: wording unchanged, operating ≠ delivery" },
  //  The technician work-selection decisions. Every one of them is a refusal,
  //  and a refusal that only fires against a provisioned database is a refusal
  //  nobody has seen fire. These run with no credentials.
  { file: "unit/technician_work_selection.test.js",
    what: "technician: identity, scope, eligibility, replay, cross-property refusal" },
  //  Ask Spine slice 2. A chat box is the easiest place to ship a
  //  confident lie, so the honesty properties are on the standard path.
  { file: "unit/ask_spine_answer.test.js",
    what: "Ask Spine: answers only from reads, names them, and an outage never reads as good news" },
  { file: "unit/debt_ask_spine.test.js",
    what: "Debt Ask Spine: governed reader, failure silence, identifier firewall and entitlement" },
  { file: "unit/equity_ask_spine.test.js",
    what: "Equity Ask Spine: governed reader, failure silence, identifier firewall and entitlement" },
  { file: "unit/skyline_ask_spine_sms_matrix.test.js",
    what: "Skyline Ask Spine: dashboard and SMS share routing, entitlement, signer, and identifier-firewall behavior" },
  { file: "proofs/ask_spine_contract_proof.js",
    what: "Ask Spine attention: one canonical obligations reader, scoped ranking, no conversational SQL copy" },
  { file: "unit/staff_sms_router.test.js",
    what: "staff SMS: governed reads converge on Ask Spine while actions and one-work-order turns remain operational" },
  { file: "unit/staff_sms_leasing_action.test.js",
    what: "staff SMS leasing: explicit standing, exact target, canonical capture/send services, honest receipts" },
  { file: "unit/operations_line_transfer.test.js",
    what: "staff line transfer: one atomic owner change, preserved history, fixed posture, server-derived authority" },
  { file: "unit/personal_attention_convergence.test.js",
    what: "personal attention: dashboard and SMS share one person-scoped read using recorded accountability only" },
  { file: "gate_ask_spine_readers.js",
    what: "Ask Spine: every canonical standing domain is registered, pending, or explicitly waived" },
  //  ── docs/CURRENT_STATE.md CANNOT SILENTLY LOSE COVERAGE ────────────
  //  That file exists because threads kept rebuilding what already existed.
  //  Until 2026-08-20 the only thing keeping it true was people remembering
  //  to update it — which is exactly what docs/CODEBASE_STATE.md relied on
  //  before it was silently wrong two weeks later. Coverage only: this gate
  //  does not and cannot verify that any row is TRUE.
  { file: "gate_current_state.js",
    what: "CURRENT_STATE.md: every src/ domain is named, rungs use the controlled vocabulary, defect numbering has not collided" },
  { file: "gate_person_ingress.js",
    what: "person creation authority stays in the ingress boundary and every remaining writer is declared truthfully" },
  //  The gate above is the §40.2 enforcement, so it is the one gate whose
  //  own failure modes must be demonstrated rather than trusted. It ran
  //  green for months while scanning one directory and missing Tenancy
  //  entirely; a green gate that has never been seen to go red is a claim.
  //  This mutates the registration chain six ways and requires exit 1 each
  //  time, then requires green again on restore.
  { file: "scenarios/ask_spine_reader_gate_falsification.js",
    what: "the reader gate itself goes RED when registration, discovery or the gather is broken" },
  { file: "unit/tenancy_ask_spine.test.js",
    what: "Tenancy Ask Spine: routing, entitlement before any read, the four silences, the truth walls" },
  { file: "unit/economics_ask_spine.test.js",
    what: "Economics Ask Spine: one canonical picture, lease-term menu preserved, entitlement before read" },
  //  Slice 2's primitive is PURE, which is why its whole edge-case surface
  //  runs here in milliseconds instead of behind a Postgres. The DB rung
  //  (interval_positions.db.js) proves the same states on 160 real beds.
  { file: "unit/application_space_grain.test.js",
    what: "Application space grain (182): the bed is durable from the aim, whole-unit behaviour is unchanged, a bed is never guessed, and the refusal prose stays out of the deployed app's false branch" },
  { file: "unit/application_future_target.test.js",
    what: "Future applications: the governed turn-ready date survives invitation, tenant submission, and application birth" },
  { file: "unit/application_send_command.test.js",
    what: "application send delegates exact unit and bed targets through the canonical prepare and dispatch command" },
  { file: "unit/executed_lease_evidence.test.js",
    what: "executed lease evidence: immutable record, canonical lifecycle admission, blockers and replay" },
  { file: "unit/interval_position_hostile.test.js",
    what: "Interval tenancy: closed-interval arithmetic, which rights count, honest refusals, and the line it does not cross" },
  { file: "unit/meeting_evidence_ingress.test.js",
    what: "Meeting Evidence: Read AI raw-byte ingress, immutable inbox shape, and no Ask Spine/transcript fan-out" },
  { file: "unit/meeting_receipt_v0.test.js",
    what: "Meeting Receipt v0: doctrine decomposition, transcript segments, validation, deterministic receipt, review ledger" },
  { file: "unit/meeting_receipt_extractor_v0.test.js",
    what: "Meeting Receipt Extractor v0: release readiness, reject-not-repair runner, Aug 10 real-path distinctions, feedback routing" },
  { file: "unit/meeting_receipt_runtime_v0.test.js",
    what: "Meeting Receipt runtime v0: official Read shape, model protocol, exact identity resolution, scoped API and review lineage" },
  { file: "unit/equity_writer_guards.test.js",
    what: "Equity: provenance, class, transfer, attribution, and ownership reconciliation guards" },
  { file: "unit/equity_routes_contract.test.js",
    what: "Equity HTTP: ownership reconciliation survives the canonical standing route" },
  { file: "unit/contracted_service_source_artifact.test.js",
    what: "Contracted Services evidence: accepted shapes and product-specific refusals" },
  { file: "unit/contracted_service_ask_spine.test.js",
    what: "Contracted Services Ask Spine: entitlement, question-bound facts, failures, and references" },
  { file: "unit/technician_language.test.js",
    what: "technician language: plain phrases read correctly, nothing guessed into an action" },
  { file: "unit/compliance_document_read.test.js",
    what: "Compliance reader: real City license, explicit unknowns, hostile classification refusals" },
  { file: "unit/compliance_evidence_intake.test.js",
    what: "Compliance intake: generic PDF retention, dedupe, retain-before-recognition failure" },
  { file: "unit/compliance_contracts.test.js",
    what: "Compliance contracts: exact proposal and frozen future writer/read/reference wires" },
  { file: "unit/asset_reader_capabilities.test.js",
    what: "Insurance + Tax readers: retrieval declared; comparison and cause not claimed" },
  { file: "unit/compliance_user_journey.test.js",
    what: "Compliance user journey: six natural questions, honest attention, server-minted openers" },
];

const bar = "════════════════════════════════════════════════════════════════";

console.log("\n" + bar);
console.log("  PARENT VALIDATION STARTED — source governance");
console.log(`  ${GATES.length} gates · first failure stops the run and sets the exit code`);
console.log("  Each gate prints its OWN evidence below, unmodified.");
console.log(bar);

const results = [];
for (const g of GATES) {
  //  Entries with a slash are resolved from tests/ root; bare names live in gates/.
  const target = g.file.includes("/")
    ? path.join(__dirname, g.file)
    : path.join(__dirname, "gates", g.file);
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
