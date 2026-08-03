#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_harness_isolation.js — REPOSITORY AUDIT GATE. DB-free.

   Classifies every script under tests/ and tools/ that opens a database,
   BY BEHAVIOUR — never by filename.

   ── WHY IT EXISTS ───────────────────────────────────────────────────

   The isolation guard in DB_HARNESS_ISOLATION.md keys on a NAMING
   convention: "*.db.js harnesses require HARNESS_DATABASE_URL". Nothing
   enforced the naming, so an audit by CONNECTION rather than by filename
   found, on 2026-08-03, 87 scripts across tests/ and tools/ building a
   connection from process.env.DATABASE_URL with no guard — 67 of them
   write-capable — against 8 covered *.db.js files.

   THE NUMBER MOVED TWICE BEFORE IT SETTLED, both times for the same reason:
   the search was SCOPED rather than exhaustive.

     8  — "are the .db.js harnesses guarded?"   true, and incomplete
     69 — "which tests/ scripts read DATABASE_URL?"  tools/ never scanned
     87 — walk BOTH roots, classify by behaviour

   tools/ is where the repair and seed scripts live: retire_hollow_leases,
   repair_invalid_task_owners, remove_duplicate_walkins, seed_*. Missing that
   directory understated exactly the most dangerous set.

   A measurement you scoped by assumption is a measurement of your
   assumption. That is why this gate walks the roots itself.

   ── WHAT THIS GATE DOES AND DOES NOT CLAIM ──────────────────────────

   It does NOT make the existing inventory safe. It freezes it and fails on
   GROWTH: a NEW unapproved direct DATABASE_URL consumer breaks the build.

   It also fails when a frozen entry has been REPAIRED but not removed from
   the list, so the inventory shrinks honestly instead of rotting.

   ── WHAT THE FINDING IS, STATED PRECISELY ───────────────────────────

   These scripts are CAPABLE of writing to whichever database DATABASE_URL
   names when run directly. In a production Render shell that may be the
   production database. That is evidence of an unsafe CAPABILITY. It is NOT
   evidence that every script has executed against production, nor that
   every one has caused pollution. Do not overstate it in either direction.

   USAGE / EXIT
     node tests/gate_harness_isolation.js
     0  no new unapproved consumer, inventory accurate
     1  a new consumer appeared, or the frozen list is stale
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const receipt = require("./_run_receipt");

const ROOTS = ["tests", "tools"];
const REPO = path.join(__dirname, "..");

/*  APPROVED PRODUCTION-FACING TOOLS. Every entry needs a reason. These are
 *  allowed to read DATABASE_URL because pointing at production is their
 *  purpose — and each is separately constrained. */
const PRODUCTION_APPROVED = [
  { file: "tests/prod_smoke_missed_readonly.js",
    reason: "the documented structurally read-only production smoke; runs inside BEGIN TRANSACTION READ ONLY and proves it cannot write before reading" },
  { file: "tools/ledger_reconcile.js",
    reason: "read-only whole-ledger reconciliation; proves it cannot write before any read" },
  { file: "tools/property_line_preflight.js",
    reason: "read-only property-line preflight; proves it cannot write before any read" },
  { file: "tests/smoke_release2.deployed.js",
    reason: "deployment smoke — targets the DEPLOYED service by design" },
  { file: "tests/smoke_release3.deployed.js",
    reason: "deployment smoke — targets the DEPLOYED service by design" },
];

/*  DEAD — retained but not to be run. Not safe, not active. */
const DEAD = [
  { file: "src/shared/no076_failclosed_check.js",
    reason: "one-off migration-076 matrix check, invoked nowhere; its direct properties.sms_number insert is now refused by the 130 write guard" },
];

/*  FROZEN INVENTORY — measured 2026-08-03 at main a792b9f + branch work.
 *
 *  This is KNOWN DEBT, deliberately not repaired here: 67 write-capable
 *  scripts cannot be converted blindly, most cannot execute without a
 *  provisioned full-schema database, and a mass textual replacement would
 *  create 55 unexecuted safety claims. Remediation is its own governed
 *  slice AFTER Slice A (owner ruling 2026-08-03).
 *
 *  Entries are REMOVED as each script is repaired and proven. The gate
 *  fails if an entry no longer qualifies, so this list cannot silently rot. */
const FROZEN_UNGUARDED = new Set([
  "tests/agent_booking_xturn_proof.js",
  "tests/application_submission.test.js",
  "tests/billback_decision_proof.js",
  "tests/birth_guard.test.js",
  "tests/capability_contract.test.js",
  "tests/capture_chase_proof.js",
  "tests/comms_boundary_phase_a_proof.js",
  "tests/consent_and_scope_proof.js",
  "tests/demo_book_route_proof.js",
  "tests/demo_enrollment_dry_run.js",
  "tests/executed_lease_overlap_concurrency.test.js",
  "tests/fact_write_resilience_proof.js",
  "tests/full_lifecycle_arc.js",
  "tests/inbound_prospect_resolution_proof.js",
  "tests/intake_source_fallback_proof.js",
  "tests/lead_source_attribution_proof.js",
  "tests/lease_void_contract.test.js",
  "tests/legacy_agent_routes_removed_proof.js",
  "tests/movein_arc.js",
  "tests/movein_beat.js",
  "tests/never_delete_guard_proof.js",
  "tests/night_harness.js",
  "tests/owner_eligibility_contract.test.js",
  "tests/ownership_reachability_check.js",
  "tests/person_facts_proof.js",
  "tests/presence_wall_lease_proof.js",
  "tests/proof_proposed_terms.js",
  "tests/property_capability_proof.js",
  "tests/prove_escalate_move.js",
  "tests/prove_one_in_one_out.js",
  "tests/prove_persona_v6.js",
  "tests/qa_lifecycle_arc.js",
  "tests/readiness_certification_proof.js",
  "tests/relationship_stage_proof.js",
  "tests/renewals_slice6_proof.js",
  "tests/send_action_basis_contract.test.js",
  "tests/shadow_import.test.js",
  "tests/slice8_governed_economics_proof.js",
  "tests/slice9_appointment_journey_proof.js",
  "tests/slice9_attribution_backfill_proof.js",
  "tests/slice9_attribution_writer_proof.js",
  "tests/slice9_evidence_proof.js",
  "tests/slice9_inbound_decision_proof.js",
  "tests/slice9_lifecycle_authority_proof.js",
  "tests/slice9_lifecycle_concurrency_proof.js",
  "tests/slice9_metric_contract_proof.js",
  "tests/slice9_operating_timezone_proof.js",
  "tests/slice9_opportunity_funnel_proof.js",
  "tests/slice9_opportunity_lifecycle_proof.js",
  "tests/slice9_path_a_birth_cutover_proof.js",
  "tests/slice9_paths_bcde_cutover_proof.js",
  "tests/slice9_status_read_correction_proof.js",
  "tests/slice9_timezone_command_proof.js",
  "tests/smoke_proposed_terms_route.js",
  "tests/staff_agent_proof.js",
  "tests/standing_context_proof.js",
  "tests/tour_booking_proof.js",
  "tests/tour_chips_proof.js",
  "tests/tour_outcome_capture_proof.js",
  "tests/tour_scheduled_for.test.js",
  "tests/tours_conveyor.test.js",
  "tests/unit_triage_proof.js",
  "tests/unit_turn_scope_proof.js",
  "tests/walk_in_tour_proof.js",
  "tests/work_acceptance_proof.js",
  /*  ⚠ MERGE BLOCKERS for Slice A — these two are in its required proof set
   *  and must be repaired and proven BEFORE it merges (owner ruling
   *  2026-08-03). Every other entry is remediated in the governed slice
   *  that follows Slice A. */
  "tests/work_order_authority_proof.js",
  "tests/work_order_canonical_path_proof.js",
  "tools/accept_brick_one.js",
  "tools/application_milestone_baseline.js",
  "tools/apply_unit_type_mapping.js",
  "tools/appointment_attribution_analyzer.js",
  "tools/appointment_attribution_backfill.js",
  "tools/enroll_demo_participants.js",
  "tools/enroll_internal_qa.js",
  "tools/followup_dry_run.js",
  "tools/issue_operator_invite.js",
  "tools/lifecycle_event_attribution_backfill.js",
  "tools/proof_lease_packet_operator_service.js",
  "tools/qa_provision.js",
  "tools/remove_duplicate_walkins.js",
  "tools/repair_invalid_task_owners.js",
  "tools/retire_hollow_leases.js",
  "tools/run_followups.js",
  "tools/seed_demo_agent_facts.js",
  "tools/seed_demo_inventory.js",
  "tools/seed_solo_facts.js",
  "tools/validate_ai_leasing_strategy_replay.js",
]);

const SLICE_A_BLOCKERS = [
  /*  ⚠ MERGE BLOCKERS for Slice A — these two are in its required proof set
   *  and must be repaired and proven BEFORE it merges (owner ruling
   *  2026-08-03). Every other entry is remediated in the governed slice
   *  that follows Slice A. */
  "tests/work_order_authority_proof.js",
  "tests/work_order_canonical_path_proof.js",
];

// ── classification, by behaviour ────────────────────────────────────
const CONNECTS = /connectionString:\s*process\.env\.DATABASE_URL|new\s+(Pool|Client)\s*\(\s*\{[^}]*process\.env\.DATABASE_URL/;
const WRITES = /insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from|create\s+table|\bcommit\b/i;

function walk(dir, out = []) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

function classify(rel) {
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");
  const approved = PRODUCTION_APPROVED.find((a) => a.file === rel);
  if (approved) return { rel, kind: "approved_production_tool", reason: approved.reason };
  if (DEAD.find((d) => d.file === rel)) return { rel, kind: "dead" };
  if (/harnessConnectionString/.test(src)) return { rel, kind: "guarded_harness" };
  if (!CONNECTS.test(src)) return { rel, kind: "no_direct_connection" };
  return { rel, kind: WRITES.test(src) ? "unguarded_write_capable" : "unguarded_read_only" };
}

const HARNESS = __filename;
const EXPECTED = 4;
let passed = 0, failed = 0, ran = 0;
const ok = (label, cond, detail) => {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};

receipt.begin(HARNESS, { expected: EXPECTED });

const files = ROOTS.flatMap((r) => walk(r));
const results = files.map(classify);
const byKind = (k) => results.filter((r) => r.kind === k);

const unguarded = [...byKind("unguarded_write_capable"), ...byKind("unguarded_read_only")];

console.log("\n  ── inventory, classified by behaviour ──");
console.log(`     guarded harness                 ${byKind("guarded_harness").length}`);
console.log(`     approved production tool        ${byKind("approved_production_tool").length}`);
console.log(`     unguarded WRITE-CAPABLE         ${byKind("unguarded_write_capable").length}`);
console.log(`     unguarded read-only             ${byKind("unguarded_read_only").length}`);
console.log(`     dead / obsolete                 ${byKind("dead").length}`);
console.log(`     no direct connection            ${byKind("no_direct_connection").length}`);
console.log(`     scanned                         ${results.length}\n`);

// ── 1. NO NEW UNAPPROVED CONSUMER ──────────────────────────────────
const appeared = unguarded.filter((r) => !FROZEN_UNGUARDED.has(r.rel));
ok("no NEW unapproved direct DATABASE_URL consumer",
  appeared.length === 0,
  appeared.length
    ? appeared.map((r) => `NEW: ${r.rel}  (${r.kind})`).join("\n        ") +
      "\n        Use harnessConnectionString() from tests/_run_receipt.js, or add an" +
      "\n        entry to PRODUCTION_APPROVED with a reason if it is legitimately" +
      "\n        production-facing. Do NOT add it to FROZEN_UNGUARDED — that list is" +
      "\n        a frozen historical inventory, not a place to park new debt."
    : null);

// ── 2. THE FROZEN LIST MUST NOT ROT ────────────────────────────────
const stale = [...FROZEN_UNGUARDED].filter((f) => {
  const r = results.find((x) => x.rel === f);
  return !r || (r.kind !== "unguarded_write_capable" && r.kind !== "unguarded_read_only");
});
ok("the frozen inventory is still accurate (repaired entries removed)",
  stale.length === 0,
  stale.length
    ? stale.map((f) => `no longer qualifies: ${f}`).join("\n        ") +
      "\n        Repaired or deleted. Remove it from FROZEN_UNGUARDED so the" +
      "\n        inventory shrinks honestly instead of overstating the debt."
    : null);

// ── 3. EVERY ALLOWLIST ENTRY CARRIES A REASON ──────────────────────
ok("every PRODUCTION_APPROVED entry states why it may see production",
  PRODUCTION_APPROVED.every((a) => a.reason && a.reason.length > 20));

// ── 4. THE SLICE A MERGE BLOCKERS ARE STILL FLAGGED ────────────────
const blockersOutstanding = SLICE_A_BLOCKERS.filter((f) => FROZEN_UNGUARDED.has(f));
console.log(`\n  ── Slice A merge blockers: ${blockersOutstanding.length} of ${SLICE_A_BLOCKERS.length} outstanding ──`);
blockersOutstanding.forEach((f) => console.log(`     ⚠ ${f} — repair and prove before Slice A merges`));
ok("Slice A merge blockers are tracked, not lost",
  SLICE_A_BLOCKERS.every((f) => FROZEN_UNGUARDED.has(f) || !results.find((r) =>
    r.rel === f && (r.kind === "unguarded_write_capable" || r.kind === "unguarded_read_only"))));

console.log("");
console.log("  This gate does NOT claim the frozen inventory is safe. It prevents");
console.log("  growth and keeps the debt measurable. Those scripts are CAPABLE of");
console.log("  writing to whichever database DATABASE_URL names when run directly —");
console.log("  that is an unsafe capability, not evidence any of them has run against");
console.log("  production. Remediation is its own governed slice after Slice A.");

process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
