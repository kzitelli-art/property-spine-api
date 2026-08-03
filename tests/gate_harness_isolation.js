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
/*  FROZEN DEBT REGISTER — measured 2026-08-03 on this tree.
 *
 *  This is a TEMPORARY DEBT REGISTER, NOT AN APPROVAL LIST. Presence here
 *  means "known, measured, unrepaired" — never "reviewed and accepted".
 *
 *  Every entry carries: path · read-only or write-capable · provisional use
 *  · why it remains · the condition that removes it.
 *
 *  ⚠ `use` IS PROVISIONAL AND DERIVED FROM NAMING. `write` is MEASURED from
 *  the source. The distinction matters: this file exists because filenames
 *  are not evidence of safety. They are a starting point for triage and
 *  nothing more — each `use` must be confirmed by reading the script during
 *  remediation.
 *
 *  Entries are REMOVED as each script is repaired and proven. The gate fails
 *  if an entry no longer qualifies, so this register cannot silently rot. */
const FROZEN_INVENTORY = [
  { path: "tests/agent_booking_xturn_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/application_submission.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/billback_decision_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/birth_guard.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/capability_contract.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/capture_chase_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/comms_boundary_phase_a_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/consent_and_scope_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/demo_book_route_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/demo_enrollment_dry_run.js",
    write: false, use: "analysis",
    reason: "pre-existing analysis/backfill tool at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/executed_lease_overlap_concurrency.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/fact_write_resilience_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/full_lifecycle_arc.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/inbound_prospect_resolution_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/intake_source_fallback_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/lead_source_attribution_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/lease_void_contract.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/legacy_agent_routes_removed_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/movein_arc.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/movein_beat.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/never_delete_guard_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/night_harness.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/owner_eligibility_contract.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/ownership_reachability_check.js",
    write: false, use: "unknown",
    reason: "pre-existing at the measured SHA; use not yet determined by reading it",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/person_facts_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/presence_wall_lease_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/proof_proposed_terms.js",
    write: true, use: "unknown",
    reason: "pre-existing at the measured SHA; use not yet determined by reading it",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/property_capability_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/prove_escalate_move.js",
    write: true, use: "unknown",
    reason: "pre-existing at the measured SHA; use not yet determined by reading it",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/prove_one_in_one_out.js",
    write: true, use: "unknown",
    reason: "pre-existing at the measured SHA; use not yet determined by reading it",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/prove_persona_v6.js",
    write: true, use: "unknown",
    reason: "pre-existing at the measured SHA; use not yet determined by reading it",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/qa_lifecycle_arc.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/readiness_certification_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/relationship_stage_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/renewals_slice6_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/send_action_basis_contract.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/shadow_import.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice8_governed_economics_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_appointment_journey_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_attribution_backfill_proof.js",
    write: true, use: "analysis",
    reason: "pre-existing analysis/backfill tool at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_attribution_writer_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_evidence_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_inbound_decision_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_lifecycle_authority_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_lifecycle_concurrency_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_metric_contract_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_operating_timezone_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_opportunity_funnel_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_opportunity_lifecycle_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_path_a_birth_cutover_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_paths_bcde_cutover_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_status_read_correction_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/slice9_timezone_command_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/smoke_proposed_terms_route.js",
    write: true, use: "unknown",
    reason: "pre-existing at the measured SHA; use not yet determined by reading it",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/staff_agent_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/standing_context_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/tour_booking_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/tour_chips_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/tour_outcome_capture_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/tour_scheduled_for.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/tours_conveyor.test.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/unit_triage_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/unit_turn_scope_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/walk_in_tour_proof.js",
    write: true, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/work_acceptance_proof.js",
    write: false, use: "proof",
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tests/work_order_authority_proof.js",
    write: true, use: "proof",
    sliceABlocker: true,
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "repaired and proven BEFORE Slice A merges — directly and through the suite runner (owner ruling 2026-08-03)" },
  { path: "tests/work_order_canonical_path_proof.js",
    write: true, use: "proof",
    sliceABlocker: true,
    reason: "pre-existing proof harness at the measured SHA; not yet triaged",
    until: "repaired and proven BEFORE Slice A merges — directly and through the suite runner (owner ruling 2026-08-03)" },
  { path: "tools/accept_brick_one.js",
    write: true, use: "repair",
    reason: "pre-existing data-repair tool at the measured SHA; HIGHEST RISK — mutates operating rows",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/application_milestone_baseline.js",
    write: false, use: "analysis",
    reason: "pre-existing analysis/backfill tool at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/apply_unit_type_mapping.js",
    write: true, use: "repair",
    reason: "pre-existing data-repair tool at the measured SHA; HIGHEST RISK — mutates operating rows",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/appointment_attribution_analyzer.js",
    write: false, use: "analysis",
    reason: "pre-existing analysis/backfill tool at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/appointment_attribution_backfill.js",
    write: true, use: "analysis",
    reason: "pre-existing analysis/backfill tool at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/enroll_demo_participants.js",
    write: false, use: "operational",
    reason: "pre-existing operational tool at the measured SHA; may be intended to run against production",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/enroll_internal_qa.js",
    write: false, use: "operational",
    reason: "pre-existing operational tool at the measured SHA; may be intended to run against production",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/followup_dry_run.js",
    write: false, use: "analysis",
    reason: "pre-existing analysis/backfill tool at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/issue_operator_invite.js",
    write: true, use: "operational",
    reason: "pre-existing operational tool at the measured SHA; may be intended to run against production",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/lifecycle_event_attribution_backfill.js",
    write: true, use: "analysis",
    reason: "pre-existing analysis/backfill tool at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/proof_lease_packet_operator_service.js",
    write: true, use: "unknown",
    reason: "pre-existing at the measured SHA; use not yet determined by reading it",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/qa_provision.js",
    write: true, use: "operational",
    reason: "pre-existing operational tool at the measured SHA; may be intended to run against production",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/remove_duplicate_walkins.js",
    write: true, use: "repair",
    reason: "pre-existing data-repair tool at the measured SHA; HIGHEST RISK — mutates operating rows",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/repair_invalid_task_owners.js",
    write: true, use: "repair",
    reason: "pre-existing data-repair tool at the measured SHA; HIGHEST RISK — mutates operating rows",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/retire_hollow_leases.js",
    write: true, use: "repair",
    reason: "pre-existing data-repair tool at the measured SHA; HIGHEST RISK — mutates operating rows",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/run_followups.js",
    write: false, use: "operational",
    reason: "pre-existing operational tool at the measured SHA; may be intended to run against production",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/seed_demo_agent_facts.js",
    write: true, use: "seed",
    reason: "pre-existing seed tool at the measured SHA; writes demo/QA fixtures",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/seed_demo_inventory.js",
    write: true, use: "seed",
    reason: "pre-existing seed tool at the measured SHA; writes demo/QA fixtures",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/seed_solo_facts.js",
    write: true, use: "seed",
    reason: "pre-existing seed tool at the measured SHA; writes demo/QA fixtures",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
  { path: "tools/validate_ai_leasing_strategy_replay.js",
    write: true, use: "analysis",
    reason: "pre-existing analysis/backfill tool at the measured SHA; not yet triaged",
    until: "converted to harnessConnectionString() and executed against an isolated database, or deleted as dead, in the remediation slice" },
];
const FROZEN_UNGUARDED = new Set(FROZEN_INVENTORY.map((e) => e.path));

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
const EXPECTED = 6;
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
console.log(`     scanned                         ${results.length}`);

const useCount = {};
FROZEN_INVENTORY.forEach((e) => { useCount[e.use] = (useCount[e.use] || 0) + 1; });
console.log("\n  ── frozen debt register, by PROVISIONAL use (derived from naming) ──");
Object.keys(useCount).sort().forEach((u) => {
  const w = FROZEN_INVENTORY.filter((e) => e.use === u && e.write).length;
  console.log(`     ${u.padEnd(14)} ${String(useCount[u]).padStart(3)}   (${w} write-capable)`);
});
console.log("     `use` is provisional; `write` is measured. Confirm use by reading,");
console.log("     during remediation — a filename is not evidence.\n");

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

// ── 3. THE DEBT REGISTER IS COMPLETE ───────────────────────────────
//  A register missing fields is a list, and a list is what let this defect
//  hide for months.
const USES = ["proof", "analysis", "repair", "seed", "operational", "deployment", "unknown"];
const malformed = FROZEN_INVENTORY.filter((e) =>
  !e.path || typeof e.write !== "boolean" || !USES.includes(e.use) ||
  !e.reason || e.reason.length < 20 || !e.until || e.until.length < 20);
ok("every debt-register entry carries path, write-class, use, reason and removal condition",
  malformed.length === 0,
  malformed.length ? malformed.map((e) => `incomplete: ${e.path}`).join("\n        ") : null);

// ── 3b. THE REGISTER MATCHES WHAT IS MEASURED ──────────────────────
//  `write` is measured from source, not asserted by the register. If the
//  two disagree the register is describing a repository that no longer
//  exists.
const misclassified = FROZEN_INVENTORY.filter((e) => {
  const r = results.find((x) => x.rel === e.path);
  if (!r) return false;              // staleness is assertion 2's job
  return e.write !== (r.kind === "unguarded_write_capable");
});
ok("register write-classification matches the measured source",
  misclassified.length === 0,
  misclassified.length ? misclassified.map((e) => `register says write=${e.write}: ${e.path}`).join("\n        ") : null);

// ── 4. EVERY ALLOWLIST ENTRY CARRIES A REASON ──────────────────────
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
