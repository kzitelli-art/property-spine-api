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
  { file: "tools/identity/count_keyless_properties.js",
    reason: "Build 1A-2 pre-deploy read: migration 150 stamps every keyless property with an " +
            "absence reason, and that population must be LOOKED AT before it is stamped. " +
            "Production is the subject, so no harness target can answer it. Structurally " +
            "read-only: it issues `set session characteristics as transaction read only` " +
            "before any query, so the SERVER refuses a write regardless of this file's contents" },
  { file: "tests/smoke_release2.deployed.js",
    reason: "deployment smoke — targets the DEPLOYED service by design" },
  { file: "tests/smoke_release3.deployed.js",
    reason: "deployment smoke — targets the DEPLOYED service by design" },
  { file: "tools/activation/verify_deployment.js",
    reason: "Release 0 deployment binding — must read the PRODUCTION checkout and ledger by design, since its whole purpose is proving the running bytes are the reviewed bytes; proves it cannot write before any read" },
  { file: "tools/activation/rotation_proof.js",
    reason: "Release 0 credential-rotation proof — must read the PRODUCTION comm_events row the provider attributed, since a rotation cannot be proven anywhere else; proves it cannot write before any read" },
  /*  ── THE INSTRUMENTATION DEPLOY, 2026-08-09 ────────────────────────
   *  These three shipped to production in the two tooling deploys and
   *  are production-facing BY DESIGN: the whole reason they exist is
   *  that the questions they answer cannot be answered anywhere else.
   *  Registered late — this gate went red on the Boundary 7 candidate
   *  because `npm run verify` was never run on the instrumentation
   *  candidates themselves, only on the branch they were cut from. The
   *  gate was right and the process was wrong. */
  { file: "tools/release0/where_are_we.js",
    reason: "Release 0 boundary instrument — must read the PRODUCTION database and running checkout, since 'where are we' has no other source; runs inside a proven read-only transaction before it reads" },
  { file: "tools/step4/preflight.js",
    reason: "Step 4 handset preflight — must read PRODUCTION to choose a safe target work order and print T0; a target chosen anywhere else would prove nothing about the completion that happens; proven read-only via _ro.js" },
  { file: "tools/step4/prove_completion.js",
    reason: "Step 4 completion receipt — must read the PRODUCTION rows a real handset produced, which is the only place that completion exists; proven read-only via _ro.js and rolled back" },
  { file: "tools/activation/signature_controls.js",
    reason: "Release 0 webhook signature controls — its own connection is read-only and proves it before any read, but the run DELIBERATELY causes production writes by posting one signed text-only message THROUGH the governed route; that is the control, not a side effect, and it sends no completion language and no media" },
  { file: "tools/activation/technician_fixture_proof.js",
    reason: "Release 0 Gate 4 — verifies the tester identity and work order 1006 in PRODUCTION via the production resolver (resolveStaffSenderForOrganization), because the fixture being verified only exists there; proves it cannot write before any read; never prints the phone" },
  { file: "tools/activation/evidence_ingress_proof.js",
    reason: "Release 0 Gate 8/10 — verifies the real-handset evidence row and completion safety in PRODUCTION, bound to a T0-plus-tester-plus-line window; proves it cannot write before any read; prints receipt fields, never the phone, media URL, or image bytes" },
  { file: "tools/steps23/verify_137_applied.js",
    reason: "Release 0 Step 2 post-migration invariant read — must read the PRODUCTION ledger and catalog to prove migration 137 landed and wrote no rows, which is the whole point of a post-deploy check; proves it cannot write before any read; one short command, committed rather than pasted" },
  { file: "tools/steps23/verify_step3_preconditions.js",
    reason: "Release 0 Step 3 precondition read — must count PRODUCTION attachment rows to answer whether any OPEN work order could complete today and could not after the strict evidence gate ships; a constraint proves what can be written from now on, only a count proves what is already there; proves it cannot write before any read; prints counts and work-order references only, never a phone, media URL or attachment bytes" },
  { file: "tools/activation/find_collision_free_tester.js",
    reason: "Release 0 tester search — must read PRODUCTION staff, leases and leads to find an alternate tester whose phone carries no reachable resident/prospect identity, since routing around an identity collision is what avoids mutating unrelated leasing data; uses the production predicates (eligibleTechnicians, resolveStaffSenderForOrganization, the two inbound reachability tiers) rather than an FK inventory; proves it cannot write before any read; phones appear only as ****last4" },
  { file: "tools/activation/release0_final_receipt.js",
    reason: "Release 0 Gate 10 — generates the final evidence-ingress receipt by RE-DERIVING every database fact live in PRODUCTION with the same bindings the gate tools use (pasted output is never trusted); proves it cannot write before any read; refuses unless every NAMED fact is present — no green-count verdicts; never prints phone, e164, media URL, image bytes, or credentials; falsified 15 refusal cases in gate_tools_falsify.sh" },
  /*  ── BOUNDARY 8a, 2026-08-10 ───────────────────────────────────────
   *  The cutover census. It must read PRODUCTION because the set it
   *  produces IS the thing the activation transaction is asked to match,
   *  taken minutes before activation — §6.2 forbids reusing an older
   *  audit as the expected set, because production moves.
   *  Registered with the tool, not after the gate caught it. (It did
   *  catch it, which is the gate working.)  */
  /*  The cutover runner. The ONLY thing in this repository that can
   *  perform the activation against production — deliberately, because
   *  the alternative is a hand-run one-liner, which is the exact shape of
   *  failure this release exists to make impossible. Its default does
   *  nothing: writing requires --activate AND an authorization naming who
   *  permitted it, and the dry run runs inside a proven read-only
   *  transaction. */
  { file: "tools/step7/activate.js",
    reason: "Release 0 Boundary 8b cutover runner — WRITE-CAPABLE BY DESIGN and production-targeted by design: recordActivation had no caller that could run outside an isolated baseline, so the cutover had no command at all. --dry-run opens a PROVEN read-only transaction, reports POPULATION_NOT_EXPLAINABLE, the legacy set and digest, guard state and census freshness, and stops. Writing requires BOTH --activate and R0_ACTIVATION_AUTHORIZATION naming who authorized it; it refuses a stale census, a census whose digest does not match its own set, any drift from the live population, an unexplainable population, and an already-active guard. Every refusal is ALSO enforced inside recordActivation in the same transaction as the write — these exist so the owner reads a sentence rather than a stack trace. Proven 27/0 by tools/step7/prove_activate_runner.js",
  },
  { file: "tools/step7/census.js",
    reason: "Release 0 Step 7 cutover census — must read the PRODUCTION terminal-without-evaluation set, because that exact set (not a count, and not a months-old audit) is what the activation transaction is asked to match; §6.2 requires it taken fresh minutes before activation. Proven read-only via activation/_readonly.js before its first read, and it additionally REFUSES without R0_CENSUS_AUTHORIZATION naming who authorized the run, which it prints into the receipt — a tool that authorizes itself by existing is what that rule forbids. Prints work-order and property identifiers and status only: never a phone, media URL, attachment bytes, or note content" },
  /*  ── GATE 1, 2026-08-10 ────────────────────────────────────────────
   *  Main moved to 90ab03d and brought migrations 150/151/152 with it.
   *  Because prestart VERIFIES rather than applies, a code-only Release 0
   *  deploy now refuses to start if those are not in the target ledger —
   *  and refuses equally if the ledger holds Release 0's own 138/139/140
   *  from some earlier branch deploy, which is precisely how 121 and 126
   *  got into production. Neither direction has ever been measured.
   *  Registered WITH the tool this time, not after a gate caught it. */
  { file: "tools/release0/gate1_production_census.js",
    reason: "Release 0 Gate 1 — must read the PRODUCTION ledger to answer whether the deployed schema can boot this build at all; the question is about production's schema, so no harness target can answer it. Reuses migrations/ledger_verdict.js, the same classifier prestart runs, so it cannot hold a second opinion the deploy disagrees with. Proven read-only via _readonly.js before any read; connection errors are sanitised because the output is meant to be pasted" },
  { file: "tools/activation/supersede_operations_line.js",
    reason: "Release 0 Gate 9 rollback — WRITE-CAPABLE BY DESIGN: it is the prepared status-supersession command that retires the operations line (status='retired' + superseded_at, the schema's vocabulary for the spec's 'superseded') and proves via resolveInboundLine, pre-commit, that the rail stopped resolving; targets one row by primary key, requires LINE_ID and CONFIRM_SUPERSEDE=yes, --dry-run always rolls back; falsified 23/23 by tools/activation/gate_tools_falsify.sh on the isolated baseline" },
  /*  ── THE SECOND WRITE-CAPABLE ENTRY, AND THE BROADEST SO FAR ───────
   *  supersede_operations_line.js above is the precedent: write-capable
   *  by design, tightly bounded. This one is the same KIND of exception
   *  and a wider one — it CREATES rows across seven tables rather than
   *  updating one row by primary key. Saying that plainly here is the
   *  point of the register; the next entry should have to argue against
   *  a scope that is stated, not one that was quietly normalised. */
  { file: "tools/debt/establish_instrument.js",
    reason: "The controlled Debt establishment step — WRITE-CAPABLE BY DESIGN, and broader " +
            "than supersede_operations_line.js: it inserts across debt_instruments, parties, " +
            "collateral, terms, reserve requirements and both observation tables. Approved " +
            "because production is the subject — a loan established anywhere else establishes " +
            "nothing — and because the write is tightly governed: dry-run by default with " +
            "--apply required, ONE transaction so no partial establishment can survive to be " +
            "re-run into, the existing canonical Debt writers only and no SQL of its own, and " +
            "EVERY canonical row refused unless the declaration cites a retained source " +
            "artifact by sha256 plus a locator inside it — so a fact cannot enter production " +
            "as an unexplained literal. A second run refuses rather than appending a duplicate " +
            "history. It is generic: the instrument is a reviewed declaration file handed in as " +
            "input, so there is no per-loan code path. CLASS 4 — deleted when governed document " +
            "establishment produces these same proposals from the same retained artifacts and a " +
            "human confirms them through the product. Proven by tests/debt_establishment_tool.db.js, " +
            "which spawns it as a real process and asserts every refusal above",
    until: "governed document establishment owns the Debt write workflow" },
  /*  ── THE TURN-READINESS CENSUS, 2026-08-16 ─────────────────────────
   *  Registered WITH the tool, before the gate was run against it. */
  { file: "tools/turn_readiness_census.js",
    reason: "Turn-readiness census — must read PRODUCTION because the question is what " +
            "production's `turnovers.ready_date` values MEAN, and a local database " +
            "contains none of them. READ-ONLY: every statement is a SELECT and the whole " +
            "run is wrapped in `begin read only` / `rollback`, so the SERVER refuses a " +
            "write regardless of this file's contents. It INFERS NOTHING — it reports " +
            "evidence pairs (obligation due_at agreement, matching readiness " +
            "certification) and counts the rows matching neither as honest unknowns, " +
            "because `status='ready' ⇒ achievement` is a guess about what a human meant. " +
            "Prints statuses and counts only: no resident, phone, note or media data. " +
            "CLASS 3 — migration-preparation tooling",
    until: "`turnovers.ready_date` is retired (docs/TURN_READINESS_SEMANTICS_TRACE.md §4)" },
  { file: "tools/leasing_basis_discovery.js",
    reason: "Leasing cycle basis discovery — must read the database holding the FRESH " +
            "activation import, which for the acceptance run is PRODUCTION, because the " +
            "whole question is which dated-lease-right rule reproduces the beds a real " +
            "operator is counting on a real property today; a rehearsal export already " +
            "produced a wrong answer (docs/LEASING_CYCLE_AND_PACE_TRACE.md §4). READ-ONLY: " +
            "every statement is a SELECT inside `begin read only` / `rollback`, so the " +
            "SERVER refuses a write regardless of this file's contents. It CHOOSES NOTHING " +
            "— it reports each candidate basis with its edge sensitivity and, given a " +
            "tracker export, the exact set difference, and it refuses rather than guessing " +
            "on an ambiguous property, an unresolvable tracker bed, or a non-ISO lease " +
            "date. Prints unit/room labels and counts only: no resident, phone, rent, " +
            "note or media data. CLASS 3 — activation-acceptance tooling",
    until: "property_leasing_cycles.commitment_basis is established for the property and " +
           "the external tracker is retired" },
  { file: "tools/equity/establish_position.js",
    reason: "The controlled Equity establishment step — WRITE-CAPABLE BY DESIGN and the " +
            "capital-stack counterpart to tools/debt/establish_instrument.js. Production is " +
            "the subject because a position established elsewhere establishes nothing. The " +
            "tool is dry-run by default, requires --apply for a write, wraps every position " +
            "and dependent row in ONE transaction, refuses a second establishment for the " +
            "property, and calls only the canonical Equity writers. Every proposed row must " +
            "cite a retained source artifact by sha256 plus a locator; Minimum Dividend " +
            "relationships additionally refuse any source short of a governed read. CLASS 4 " +
            "scaffolding documented by the Equity 174 run card and deleted when governed " +
            "document establishment owns the same confirmation workflow",
    until: "governed document establishment owns the Equity write workflow" },
];

/*  DEAD — retained but not to be run. Not safe, not active. */
const DEAD = [
  { file: "src/shared/no076_failclosed_check.js",
    reason: "one-off migration-076 matrix check, invoked nowhere; its direct properties.sms_number insert is now refused by the 130 write guard" },
];

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

/*  SECOND CATEGORY — reads HARNESS_DATABASE_URL directly, skipping
 *  harnessConnectionString().
 *
 *  NOT the same risk as the DATABASE_URL group. These REQUIRE the harness
 *  variable, so they cannot silently pick up production from an ambient
 *  DATABASE_URL. But they never call harnessConnectionString(), so they never
 *  perform its SAME-TARGET REFUSAL: point HARNESS_DATABASE_URL at production
 *  and they run against it without complaint.
 *
 *  "Safe only if you configure it correctly" is the same shape as "safe only
 *  if you launch it the right way". Narrower, still not structural.
 *
 *  Frozen for the same reason as the register above — converting a harness
 *  that cannot be executed here would be an unexecuted safety claim. Growth
 *  fails the gate. */
const FROZEN_HARNESS_VAR_DIRECT = [
  { path: "tests/hotfix_future_rent_roll_guards_proof.js", write: true,
    reason: "landed 2026-08-03 with PR #36; requires the harness var, performs no same-target refusal",
    until: "converted to harnessConnectionString() and executed against an isolated database" },
  { path: "tests/slice9_evidence_http_proof.js", write: true,
    reason: "pre-existing Slice 9 harness; requires the harness var, performs no same-target refusal",
    until: "converted to harnessConnectionString() and executed against an isolated database" },
  { path: "tests/slice9_inbound_decision_http_proof.js", write: true,
    reason: "pre-existing Slice 9 harness; requires the harness var, performs no same-target refusal",
    until: "converted to harnessConnectionString() and executed against an isolated database" },
  { path: "tests/slice9_scale_proof.js", write: true,
    reason: "pre-existing Slice 9 harness; requires the harness var, performs no same-target refusal",
    until: "converted to harnessConnectionString() and executed against an isolated database" },
  { path: "tools/ask_spine_e2e_seed.js", write: true,
    reason: "pre-existing seed tool; requires the harness var, performs no same-target refusal",
    until: "converted to harnessConnectionString() and executed against an isolated database" },
];
const FROZEN_HARNESS_VAR = new Set(FROZEN_HARNESS_VAR_DIRECT.map((e) => e.path));

const SLICE_A_BLOCKERS = [
  /*  ⚠ MERGE BLOCKERS for Slice A — these two are in its required proof set
   *  and must be repaired and proven BEFORE it merges (owner ruling
   *  2026-08-03). Every other entry is remediated in the governed slice
   *  that follows Slice A. */
  "tests/work_order_authority_proof.js",
  "tests/work_order_canonical_path_proof.js",
];

// ── classification, by behaviour ────────────────────────────────────
//  Both must hold. See classify().
const GUARD_IMPORTED = /require\([^)]*_run_receipt[^)]*\)/;
const GUARD_CALLED = /harnessConnectionString\s*\(/;

/*  ⚠ THIS DETECTOR UNDER-DETECTS, AND THE AMOUNT IS MEASURED.
 *
 *  Both alternatives require `process.env.DATABASE_URL` to appear AT THE
 *  CONNECTION SITE. A file that reads the variable once into a local and
 *  passes the local to `new Pool` is byte-for-byte equivalent at runtime and
 *  matches NEITHER. One variable of indirection walks past this gate — found
 *  2026-08-16 while adding tools/turn_readiness_census.js, which was written
 *  that way by accident and was simply not seen.
 *
 *  MEASURED on this tree: widening to "reads process.env.DATABASE_URL
 *  ANYWHERE and constructs a Pool/Client ANYWHERE", after excluding the guard
 *  module, PRODUCTION_APPROVED/DEAD entries, guarded harnesses and
 *  harness-var files, changes the classification of 31 files — 24 under
 *  tests/ and 7 under tools/. See docs/build1/INTEGRITY_GAPS.md GAP 2 for the
 *  list and the decision.
 *
 *  NOT WIDENED HERE, deliberately. Widening reclassifies 31 files in a lane
 *  that is building Slice 2, and CLAUDE.md's rule is explicit: real, recorded,
 *  moved on. What was done instead is narrower and honest — the tool that
 *  found it was made visible to this detector AND registered above, so the
 *  finding is not paid for with the file that revealed it.
 *
 *  ⚠ Until it is widened, this gate's green means "no new consumer WRITTEN IN
 *  THE DETECTED SHAPE." It does not mean "no new consumer." A gate that scans
 *  less than it asserts launders the gap into evidence; saying so here is what
 *  keeps that from happening silently. */
const CONNECTS = /connectionString:\s*process\.env\.DATABASE_URL|new\s+(Pool|Client)\s*\(\s*\{[^}]*process\.env\.DATABASE_URL/;
const WRITES = /insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from|create\s+table|\bcommit\b/i;

function walk(dir, out = []) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

/*  The guard's own implementation. It DEFINES harnessConnectionString and
 *  therefore cannot import it, and it must read HARNESS_DATABASE_URL because
 *  reading it is the whole job. Exempt by exact path, with a reason — not by
 *  pattern. */
const GUARD_MODULE = "tests/_run_receipt.js";

function classify(rel) {
  if (rel === GUARD_MODULE) return { rel, kind: "guard_implementation" };
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");
  const approved = PRODUCTION_APPROVED.find((a) => a.file === rel);
  if (approved) return { rel, kind: "approved_production_tool", reason: approved.reason };
  if (DEAD.find((d) => d.file === rel)) return { rel, kind: "dead" };
  //  A MENTION IS NOT A GUARD. This was a bare /harnessConnectionString/
  //  test until 2026-08-03, and a file whose only reference was a COMMENT —
  //  while it connected straight to DATABASE_URL and wrote — was classified
  //  "guarded harness" and the gate passed clean. Proven by probe.
  //
  //  A gate that detects a guard by grepping for its name can be satisfied
  //  by a decorative mention. Require the module to be IMPORTED and the
  //  function to be CALLED: both together are hard to satisfy by accident
  //  and hard to satisfy dishonestly without meaning to.
  if (GUARD_IMPORTED.test(src) && GUARD_CALLED.test(src)) {
    return { rel, kind: "guarded_harness" };
  }
  //  Requires the harness variable but never performs its same-target
  //  refusal. Tracked separately because the risk differs in kind.
  if (/process\.env\.HARNESS_DATABASE_URL/.test(src)) {
    return { rel, kind: "harness_var_no_refusal", write: WRITES.test(src) };
  }
  if (!CONNECTS.test(src)) return { rel, kind: "no_direct_connection" };
  return { rel, kind: WRITES.test(src) ? "unguarded_write_capable" : "unguarded_read_only" };
}

const HARNESS = __filename;
const EXPECTED = 8;
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
console.log(`     harness-var, no same-target check ${byKind("harness_var_no_refusal").length}`);
console.log(`     guard implementation            ${byKind("guard_implementation").length}`);
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

// ── 3c. THE SECOND CATEGORY DOES NOT GROW EITHER ───────────────────
const hv = byKind("harness_var_no_refusal");
const hvNew = hv.filter((r) => !FROZEN_HARNESS_VAR.has(r.rel));
ok("no NEW script reading HARNESS_DATABASE_URL without a same-target refusal",
  hvNew.length === 0,
  hvNew.length
    ? hvNew.map((r) => `NEW: ${r.rel}`).join("\n        ") +
      "\n        Use harnessConnectionString() — it refuses when the harness target" +
      "\n        resolves to the same host/port/database as DATABASE_URL. Requiring" +
      "\n        the variable is not the same as refusing the wrong value."
    : null);

const hvStale = [...FROZEN_HARNESS_VAR].filter((f) =>
  !hv.find((r) => r.rel === f));
ok("the harness-var register is still accurate (repaired entries removed)",
  hvStale.length === 0,
  hvStale.length ? hvStale.map((f) => `no longer qualifies: ${f}`).join("\n        ") : null);

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
