#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   WORK ORDERS — PRODUCTION SCHEMA READINESS GATE

   A READ-ONLY deployment gate. It answers exactly one question:

     Does the database we are deploying against satisfy the schema
     contract this Work Orders slice's RUNNING CODE requires?

   ── WHAT IT IS NOT ──────────────────────────────────────────────────
   It is NOT "can migrations replay from zero". That is a separate
   migration-integrity problem — migration 012 is not replayable from an
   empty database (001_baseline.sql:238 creates `vendors` without
   `yardi_code`, so 012_bank_intake.sql:33's `create table if not exists`
   is a no-op and its index then fails). Conflating the two questions is
   how a deployable release gets blocked by an unrelated defect, and how
   an undeployable one slips through because "the migrations look fine".

   This gate does not mutate anything. No DDL, no DML, no migrations, no
   repair. Every statement below is a catalog read.

   ── HOW THE REQUIREMENTS WERE DERIVED ───────────────────────────────
   From the SQL the slice's code paths actually execute, file by file —
   not from "which migrations look relevant". Each entry names the code
   that requires it, so a NOT READY verdict points at a caller rather
   than at a migration number.

   ── THE CONSTRAINTS ARE REQUIREMENTS TOO ────────────────────────────
   acceptWork writes assigned_user_id and accepted_by_user_id together
   and moves status off 'open'. If 131's four check constraints are
   absent the writes still succeed — and the database stops enforcing
   that an accepter is the owner. A column-only check would call that
   READY. It is not.

     DATABASE_URL="postgres://..." node tools/work_orders_schema_readiness.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Client } = require("pg");

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error("\n  DATABASE_URL is required — this gate reads the database you are");
  console.error("  deploying against. It is read-only and writes nothing.\n");
  process.exit(2);
}

//  ── WHAT THE RUNNING CODE REQUIRES ────────────────────────────────
//  table → columns, each attributed to the code path that reads or writes it.
const COLUMNS = {
  work_orders: {
    by: "surfaces/work_order_status_read.js · maintenance/not_done_service.js",
    cols: ["id", "property_id", "unit_id", "title", "status", "urgency_status",
           "work_order_ref", "not_done_reason", "needs_pm_review", "created_at",
           "updated_at", "affected_person_id", "reported_by_person_id"],
  },
  units: { by: "work_order_status_read — unit_number on every row",
           cols: ["id", "property_id", "unit_number"] },
  users: { by: "work_order_status_read · staff_session_service RESOLVER_SQL",
           cols: ["id", "name", "is_active", "status", "account_kind", "role"] },
  properties: { by: "operator accept route — organization_id is derived here, never sent",
                cols: ["id", "organization_id"] },
  property_team_assignments: {
    by: "staff_session_service · acceptance_service.actorScopeFor · viewer scope",
    cols: ["property_id", "user_id", "active", "allowed_modules", "role_title"],
  },
  staff_sessions: {
    by: "staff_session_service.resolveStaffSession — every operator request",
    cols: ["id", "user_id", "property_id", "token", "token_digest", "revoked",
           "expires_at", "created_at"],
  },
  obligations: {
    by: "accountability + routed follow-ups + acceptWork + obligation_engine (22 cols)",
    cols: ["id", "property_id", "person_id", "unit_id", "related_id", "related_type",
           "source_event_id", "module", "type", "label", "owner_type", "assigned_role",
           "assigned_user_id", "escalates_to_role", "escalates_to_user_id", "status",
           "required_inputs", "priority", "severity", "due_at", "completed_at",
           "ownership_origin", "accepted_by_user_id", "accepted_at", "acceptance_key",
           "owner_eligibility_state", "parent_obligation_id", "dedupe_key"],
  },
  events: { by: "not_done_service (maintenance_followup) · acceptWork (work_accepted)",
            cols: ["id", "property_id", "person_id", "unit_id", "type", "note", "occurred_at"] },
  work_order_progress: {
    by: "work_order_status_read — the physical lifecycle is derived from these",
    cols: ["id", "work_order_id", "property_id", "kind", "note", "occurred_at",
           "reported_by_user_id", "source_comm_event_id"],
  },
  work_order_proof_attachments: {
    by: "work_order_status_read — preserved_count and the proof state",
    //  `content` and `sha256` are NOT optional here. 140's
    //  release_0_evidence_qualifies reads both — it is the database's own
    //  definition of evidence a completion may rest on, and without the
    //  columns the guard function cannot even be created. Found by running
    //  this gate's own negative case: 140 failed to apply with
    //  `column a.content does not exist`, which is the gate discovering a
    //  hole in its own requirement list.
    cols: ["id", "work_order_id", "property_id", "storage_state", "proof_classification",
           "mime_type", "byte_size", "sha256", "content", "received_at", "stored_at",
           "provider"],
  },
  comm_events: {
    by: "work_order_status_read — resident_update, delivery, resident_exception",
    cols: ["id", "property_id", "body", "occurred_at", "sms_status", "sms_sid", "sms_error",
           "derived_from_progress_id", "classification", "channel",
           "created_object_type", "created_object_id"],
  },
  //  Migration 137. claimCompletion writes the proof EVALUATION before it
  //  touches the work order's status, so completion is impossible without
  //  these — and the read surface describes their result.
  work_order_proof_evaluations: {
    by: "technician/lifecycle_service.claimCompletion — governed completion",
    cols: ["id", "work_order_id", "property_id", "state"],
  },
  work_order_proof_evaluation_attachments: {
    by: "137 evidence chain — the citations under a completion",
    cols: ["evaluation_id", "attachment_id", "work_order_id", "property_id"],
  },
};

//  ── BEHAVIOURAL SCHEMA, NOT STRUCTURAL ────────────────────────────
//  An earlier cut of this gate checked that 137's two tables EXISTED and
//  reported 140 as advisory. It would therefore have said READY on a
//  database where evaluations could be updated, the chain could fork, and
//  a work order could reach 'complete' with nothing grounded under it.
//
//  Its own text said 140's absence "changes what a completion means"
//  while permitting READY. Those two statements cannot coexist in a
//  production-readiness gate. Tables are where evidence is WRITABLE; the
//  machinery below is what makes it TRUSTWORTHY, and the runtime treats
//  the second as a given.

//  Constraints behaviour depends on, each against the invariant it protects.
const CONSTRAINTS = [
  ["ck_oblig_acceptance_paired",
   "131 — an acceptance with no time, or a time with no accepter, is half a fact"],
  ["ck_oblig_accepter_is_owner",
   "131 — THE accepter IS the owner; without it acceptWork can seat a non-owner"],
  ["ck_oblig_accepted_not_open",
   "131 — accepted work is never open work"],
  ["ck_oblig_acceptance_key_requires_acceptance",
   "131 — a key without an acceptance is a claim about a write that did not happen"],
  ["uq_wopa_id_scope",
   "137 — attachments are addressable only WITH their property; the scoped FKs need it"],
  ["uq_wope_id_scope",
   "137 — the same for evaluations"],
  ["fk_wope_work_scope",
   "137 — an evaluation cannot cite a work order at another property"],
  ["fk_wope_supersedes_scope",
   "137 — a supersession cannot cross a property boundary"],
  ["fk_wopea_eval_scope",
   "137 — a citation cannot point at another property's evaluation"],
  ["fk_wopea_attach_scope",
   "137 — cited evidence is on-delete-restrict; this is what makes it indestructible"],
];

const INDEXES = [
  ["uq_obligations_acceptance_key",
   "131 — ONE acceptance per inbound message, enforced by the database"],
  ["uq_work_orders_id_property",
   "134:47 — work_order_progress's composite FK depends on it"],
  ["uq_wope_genesis",
   "137 — exactly one genesis evaluation per work order; without it the chain has no root"],
  ["uq_wope_one_successor",
   "137 — an evaluation may be superseded ONCE; without it the chain can fork and " +
   "two heads can disagree about whether the same completion is proven"],
  ["idx_wope_scope", "137 — the head lookup the completion writer performs"],
];

//  Functions the runtime calls, or that triggers below execute.
const FUNCTIONS = [
  ["wope_chain_guard", "137 — refuses a forked or mis-scoped evaluation chain"],
  ["forbid_mutation", "137 — the append-only enforcement itself"],
  ["release_0_evidence_qualifies", "140 — what counts as grounded evidence"],
  ["release_0_completion_proof_status", "140 — the database's own definition of proven"],
  ["release_0_assert_completion_truth", "140 — the assertion the guards run"],
  ["release_0_guard_work_order", "140 — terminal work-order state must be grounded"],
  ["release_0_guard_evaluation", "140 — appending an evaluation can move the head under a terminal row"],
  ["release_0_guard_attachment", "140 — and mutating evidence can invalidate one"],
  ["release_0_stamp_activation_epoch", "140 — the epoch is derived, not hand-written"],
  ["release_0_freeze_activation_epoch",
   "140 — E1: the epoch could be reset BY HAND, silently disarming the guard " +
   "while the surface still reported an activation"],
  ["release_0_freeze_cited_evidence", "140 — evidence under a completion cannot be replaced"],
];

const VIEWS = [
  ["work_order_proof_evaluation_head", "137 — the current evaluation per work order"],
  ["release_0_activation_current", "137 — the activation the guard reads"],
  ["release_0_completion_invariant_violations", "140 — the standing audit of terminal rows"],
];

//  TRIGGERS MUST EXIST *AND* BE ENABLED. A disabled trigger is present in
//  every catalog listing and enforces nothing — `ALTER TABLE ... DISABLE
//  TRIGGER` is one statement, and a gate that only checks existence would
//  call that database READY.
const TRIGGERS = [
  ["work_order_proof_evaluations", "chain_guard_wope", false,
   "137 — the chain cannot fork"],
  ["work_order_proof_evaluations", "no_update_wope", false,
   "137 — evaluations are append-only"],
  ["work_order_proof_evaluations", "no_delete_wope", false,
   "137 — an evaluation cannot be erased"],
  ["work_order_proof_evaluation_attachments", "no_update_wopea", false,
   "137 — a citation cannot be rewritten"],
  ["work_order_proof_evaluation_attachments", "no_delete_wopea", false,
   "137 — a citation cannot be erased"],
  ["release_0_activation_history", "chain_guard_r0ah", false,
   "137 — the activation history cannot fork"],
  ["release_0_activation_history", "no_update_r0ah", false, "137 — append-only"],
  ["release_0_activation_history", "no_delete_r0ah", false, "137 — append-only"],
  ["release_0_activation_history", "stamp_activation_epoch", false,
   "140 — the epoch is stamped from history, never typed"],
  ["release_0_activation_epoch", "freeze_activation_epoch", false,
   "140 — the epoch cannot be reset by hand"],
  ["work_order_proof_attachments", "freeze_cited_evidence_upd", false,
   "140 — cited evidence is frozen"],
  ["work_order_proof_attachments", "freeze_cited_evidence_del", false,
   "140 — cited evidence cannot be deleted"],
  //  DEFERRED, and that is load-bearing: the completion writer inserts the
  //  evaluation and flips the status in ONE transaction, so an immediate
  //  trigger would fire against a half-written state and refuse a legitimate
  //  completion. `deferred: true` asserts the timing, not merely the presence.
  ["work_orders", "assert_completion_truth_ins", true,
   "140 — a terminal work order must be grounded at COMMIT"],
  ["work_orders", "assert_completion_truth_upd", true,
   "140 — and stay grounded when it moves"],
  ["work_order_proof_evaluations", "assert_completion_truth_eval", true,
   "140 — the cross-table half: a new evaluation can un-ground a terminal row"],
  ["work_order_proof_attachments", "assert_completion_truth_attach", true,
   "140 — and so can mutating the evidence underneath one"],
];

const TABLES_EXTRA = [
  ["release_0_activation_epoch", "140 — the epoch the guard reads"],
  ["release_0_activation_history", "137 — the append-only activation chain"],
];

(async () => {
  const db = new Client({ connectionString: URL,
                          ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : { rejectUnauthorized: false } });
  await db.connect();

  const id = await db.query(
    "select current_database() d, inet_server_addr()::text h, version() v");
  console.log("\n" + "═".repeat(70));
  console.log("  WORK ORDERS — PRODUCTION SCHEMA READINESS  (read-only)");
  console.log("═".repeat(70));
  console.log(`  database : ${id.rows[0].d}`);
  console.log(`  host     : ${id.rows[0].h || "(local socket)"}`);
  console.log(`  server   : ${id.rows[0].v.split(" ").slice(0, 2).join(" ")}`);
  console.log("═".repeat(70));

  const missing = [];

  //  ── tables and columns ──────────────────────────────────────────
  const have = new Map();
  const rows = (await db.query(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public'`)).rows;
  for (const r of rows) {
    if (!have.has(r.table_name)) have.set(r.table_name, new Set());
    have.get(r.table_name).add(r.column_name);
  }

  console.log("\n── tables and columns ───────────────────────────────────────");
  for (const [t, spec] of Object.entries(COLUMNS)) {
    if (!have.has(t)) {
      missing.push({ kind: "table", name: t, by: spec.by });
      console.log(`  ✗ ${t.padEnd(42)} TABLE ABSENT`);
      continue;
    }
    const gone = spec.cols.filter((c) => !have.get(t).has(c));
    if (gone.length) {
      gone.forEach((c) => missing.push({ kind: "column", name: `${t}.${c}`, by: spec.by }));
      console.log(`  ✗ ${t.padEnd(42)} missing: ${gone.join(", ")}`);
    } else {
      console.log(`  ✓ ${t.padEnd(42)} ${spec.cols.length} columns`);
    }
  }

  //  ── extra tables ────────────────────────────────────────────────
  for (const [t, why] of TABLES_EXTRA) {
    if (have.has(t)) console.log(`  ✓ ${t.padEnd(42)} present`);
    else { missing.push({ kind: "table", name: t, by: why });
           console.log(`  ✗ ${t.padEnd(42)} TABLE ABSENT`); }
  }

  //  ── constraints ─────────────────────────────────────────────────
  console.log("\n── constraints behaviour depends on ─────────────────────────");
  const cons = new Set((await db.query(
    "select conname from pg_constraint")).rows.map((r) => r.conname));
  for (const [name, why] of CONSTRAINTS) {
    if (cons.has(name)) console.log(`  ✓ ${name}`);
    else { missing.push({ kind: "constraint", name, by: why });
           console.log(`  ✗ ${name.padEnd(46)} ABSENT`); }
  }

  //  ── indexes ─────────────────────────────────────────────────────
  console.log("\n── indexes behaviour depends on ─────────────────────────────");
  const idx = new Set((await db.query(
    "select indexname from pg_indexes where schemaname = 'public'")).rows.map((r) => r.indexname));
  for (const [name, why] of INDEXES) {
    if (idx.has(name)) console.log(`  ✓ ${name}`);
    else { missing.push({ kind: "index", name, by: why });
           console.log(`  ✗ ${name.padEnd(46)} ABSENT`); }
  }

  //  ── functions ───────────────────────────────────────────────────
  console.log("\n── functions the runtime and its triggers execute ───────────");
  const fns = new Set((await db.query(
    `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`)).rows.map((r) => r.proname));
  for (const [name, why] of FUNCTIONS) {
    if (fns.has(name)) console.log(`  ✓ ${name}`);
    else { missing.push({ kind: "function", name, by: why });
           console.log(`  ✗ ${name.padEnd(46)} ABSENT`); }
  }

  //  ── views ───────────────────────────────────────────────────────
  console.log("\n── views ────────────────────────────────────────────────────");
  const views = new Set((await db.query(
    "select table_name from information_schema.views where table_schema = 'public'"))
    .rows.map((r) => r.table_name));
  for (const [name, why] of VIEWS) {
    if (views.has(name)) console.log(`  ✓ ${name}`);
    else { missing.push({ kind: "view", name, by: why });
           console.log(`  ✗ ${name.padEnd(46)} ABSENT`); }
  }

  //  ── triggers: present AND enabled AND correctly timed ───────────
  console.log("\n── triggers (existence is not enforcement) ──────────────────");
  const trg = new Map();
  for (const r of (await db.query(
    `select c.relname tbl, t.tgname nm, t.tgenabled en,
            t.tgdeferrable defr, t.tginitdeferred initdefr
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal`)).rows) {
    trg.set(r.tbl + "." + r.nm, r);
  }
  for (const [tbl, name, mustDefer, why] of TRIGGERS) {
    const t = trg.get(tbl + "." + name);
    if (!t) {
      missing.push({ kind: "trigger", name: `${tbl}.${name}`, by: why });
      console.log(`  ✗ ${name.padEnd(34)} ABSENT on ${tbl}`);
    } else if (t.en === "D") {
      //  THE CASE A STRUCTURAL GATE CANNOT SEE. Present in every listing,
      //  enforcing nothing.
      missing.push({ kind: "trigger DISABLED", name: `${tbl}.${name}`, by: why });
      console.log(`  ✗ ${name.padEnd(34)} DISABLED on ${tbl} — present, enforcing nothing`);
    } else if (mustDefer && !(t.defr && t.initdefr)) {
      missing.push({ kind: "trigger NOT DEFERRED", name: `${tbl}.${name}`, by: why });
      console.log(`  ✗ ${name.padEnd(34)} not DEFERRABLE INITIALLY DEFERRED on ${tbl}`);
    } else {
      console.log(`  ✓ ${name.padEnd(34)}${mustDefer ? "deferred" : "enabled"} on ${tbl}`);
    }
  }

  await db.end();

  console.log("\n" + "═".repeat(70));
  if (missing.length === 0) {
    console.log("  READY — target database satisfies the Work Orders runtime contract.");
    console.log("═".repeat(70) + "\n");
    process.exit(0);
  }
  console.log(`  NOT READY — ${missing.length} required object(s) missing.\n`);
  for (const m of missing) {
    console.log(`   ${m.kind.toUpperCase().padEnd(11)} ${m.name}`);
    console.log(`               required by: ${m.by}`);
  }
  console.log("\n  SMALLEST DEPLOYMENT PREREQUISITE: apply the migrations that");
  console.log("  introduce the objects above to THIS database, as a deliberate");
  console.log("  release act. Do not repair migration 012 to achieve it — that");
  console.log("  is a separate migration-integrity problem and replaying from");
  console.log("  zero is not what this gate asked.");
  console.log("═".repeat(70) + "\n");
  process.exit(1);
})().catch((e) => {
  console.error("\n  GATE COULD NOT RUN — " + e.message);
  console.error("  A gate that cannot read the database has NOT said READY.\n");
  process.exit(2);
});
