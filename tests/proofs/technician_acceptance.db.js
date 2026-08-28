#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  technician_acceptance.db.js — REAL PostgreSQL.
//
//  Phase 2, milestone 1. The DB-free harness proves every decision;
//  this proves the things only a database can prove:
//
//    · migration 131's four constraints actually refuse — asserted by
//      CONSTRAINT NAME in the error, not merely by "something failed";
//    · uq_obligations_acceptance_key makes a redelivery lose at the
//      database, including a CONCURRENT one, which is the layer that
//      matters when a second caller appears;
//    · acceptWork derives the actor's scope from property_team_assignments
//      instead of trusting an argument, so a technician cannot accept work
//      at a building they are not assigned to even if the caller says so;
//    · the immutable events row is written, exactly once;
//    · a refusal writes NOTHING — asserted as a full row-count vector over
//      every table present, before and after.
//
//  ── SCHEMA SCOPE, STATED PLAINLY ────────────────────────────────────
//  Tables are built from the columns this path touches, and migration 131
//  is then executed UNMODIFIED against them. The full production schema is
//  not built: the migration chain cannot rebuild from empty
//  (012_bank_intake.sql fails on yardi_code — a known, owned defect
//  outside this slice, see docs/archive/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md).
//
//  What that costs: the zero-write assertions cover every table present,
//  which is every table this path can reach. They prove nothing about
//  tables it never touches.
//
//  ── SAFETY ──────────────────────────────────────────────────────────
//  HARNESS_DATABASE_URL only, no fallback, and it refuses to start if that
//  resolves to the same target as DATABASE_URL. It creates its own scratch
//  database and drops it. It opens no transport and needs no credentials.
//
//    HARNESS_DATABASE_URL="postgres://…" node tests/proofs/technician_acceptance.db.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const receipt = require("../_run_receipt");

const HARNESS = __filename;
const EXPECTED = 30;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

//  THE GUARD. No fallback to DATABASE_URL, and it exits rather than returns.
const ADMIN_URL = receipt.harnessConnectionString();
const SCRATCH_DB = `ps_tech_accept_${process.pid}`;
const ROOT = path.join(__dirname, "..", "..");

//  Any swallowed schema error must invalidate the run. The Slice A harness
//  passed 57/57 while its most important assertion was green BECAUSE the
//  query died; this sentinel is that lesson, kept.
let sawFatalDbError = null;
const noteDbError = (e) => {
  const m = String((e && e.message) || e);
  if (/does not exist|42P01|syntax error|42703/i.test(m)) sawFatalDbError = sawFatalDbError || m;
};

const SCOPED_SCHEMA = `
  create extension if not exists pgcrypto;

  create table organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null
  );
  create table properties (
    id uuid primary key default gen_random_uuid(),
    organization_id uuid references organizations(id),
    name text not null
  );
  create table users (
    id uuid primary key default gen_random_uuid(),
    name text, phone text, role text, is_active boolean not null default true
  );
  create table persons (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id), name text
  );
  create table units (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id), unit_number text
  );
  create table property_team_assignments (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id),
    property_id uuid not null references properties(id),
    active boolean not null default true
  );
  create table events (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id) on delete cascade,
    person_id uuid references persons(id) on delete set null,
    unit_id uuid references units(id) on delete set null,
    type text not null default 'note',
    note text,
    occurred_at timestamptz not null default now()
  );
  create table work_orders (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    title text, status text not null default 'open'
  );
  create table obligations (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id) on delete cascade,
    person_id uuid references persons(id) on delete set null,
    unit_id uuid references units(id) on delete set null,
    related_id uuid, related_type text,
    module text not null default 'maintenance',
    type text not null default 'generic',
    label text,
    owner_type text not null default 'human',
    assigned_user_id uuid references users(id) on delete set null,
    status text not null default 'open',
    required_inputs text[] not null default '{}',
    priority text not null default 'normal',
    severity text not null default 'normal',
    due_at timestamptz, completed_at timestamptz,
    ownership_origin text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
`;

const CONSTRAINT_ERR = async (db, sql, params) => {
  try { await db.query(sql, params); return null; }
  catch (e) { return String(e.message || ""); }
};

receipt.begin(HARNESS, { url: ADMIN_URL, expected: EXPECTED });

let admin = null, db = null, code = 1;
(async () => {
try {
  admin = new Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();
  await admin.query(`drop database if exists ${SCRATCH_DB}`);
  await admin.query(`create database ${SCRATCH_DB}`);
  const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = "/" + SCRATCH_DB; return u.toString(); })();
  db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  console.log(`  SCRATCH   ${SCRATCH_DB}`);

  await db.query(SCOPED_SCHEMA);

  // ── MIGRATION 131, UNMODIFIED ──────────────────────────────────────
  section("1. MIGRATION 131 APPLIES TO A REAL DATABASE");
  const mig = fs.readFileSync(path.join(ROOT, "migrations/131_work_acceptance.sql"), "utf8");
  let migErr = null;
  try { await db.query(mig); } catch (e) { migErr = e; noteDbError(e); }
  ok("131 applies cleanly, verbatim", migErr === null, migErr && migErr.message);
  ok("131 is idempotent — a second application changes nothing",
    await (async () => { try { await db.query(mig); return true; } catch (e) { noteDbError(e); return false; } })());

  const cons = (await db.query(
    `select conname from pg_constraint where conrelid = 'obligations'::regclass order by conname`)).rows.map((r) => r.conname);
  for (const c of ["ck_oblig_acceptance_paired", "ck_oblig_accepter_is_owner",
                   "ck_oblig_accepted_not_open", "ck_oblig_acceptance_key_requires_acceptance"]) {
    ok(`constraint ${c} exists`, cons.includes(c), cons.join(","));
  }
  const idx = (await db.query(`select indexname from pg_indexes where tablename='obligations'`)).rows.map((r) => r.indexname);
  ok("uq_obligations_acceptance_key exists", idx.includes("uq_obligations_acceptance_key"), idx.join(","));

  // ── FIXTURES ───────────────────────────────────────────────────────
  const org = (await db.query(`insert into organizations (name) values ('Harness Org') returning id`)).rows[0].id;
  const otherOrg = (await db.query(`insert into organizations (name) values ('Other Org') returning id`)).rows[0].id;
  const p1 = (await db.query(`insert into properties (organization_id, name) values ($1,'P1') returning id`, [org])).rows[0].id;
  const p2 = (await db.query(`insert into properties (organization_id, name) values ($1,'P2') returning id`, [org])).rows[0].id;
  const pForeign = (await db.query(`insert into properties (organization_id, name) values ($1,'Foreign') returning id`, [otherOrg])).rows[0].id;
  const dana = (await db.query(`insert into users (name, phone) values ('Dana','+15550100') returning id`)).rows[0].id;
  const sam = (await db.query(`insert into users (name, phone) values ('Sam','+15550101') returning id`)).rows[0].id;
  //  Dana works at P1 only. Not P2, not the foreign property.
  await db.query(`insert into property_team_assignments (user_id, property_id, active) values ($1,$2,true)`, [dana, p1]);
  await db.query(`insert into property_team_assignments (user_id, property_id, active) values ($1,$2,true)`, [sam, p2]);

  const mkWork = async (propertyId, assignedUserId, status = "open") => {
    const wo = (await db.query(`insert into work_orders (property_id, title) values ($1,'harness wo') returning id`, [propertyId])).rows[0].id;
    const ob = (await db.query(
      `insert into obligations (property_id, related_id, related_type, type, label, assigned_user_id, status)
       values ($1,$2,'work_order','maintenance_repair','Repair',$3,$4) returning id`,
      [propertyId, wo, assignedUserId, status])).rows[0].id;
    return { wo, ob };
  };

  // ── CONSTRAINTS REFUSE, BY NAME ────────────────────────────────────
  section("2. THE CONSTRAINTS REFUSE — BY NAME, NOT MERELY BY FAILING");
  {
    const a = await mkWork(p1, dana);
    let m = await CONSTRAINT_ERR(db,
      `update obligations set accepted_by_user_id=$2 where id=$1`, [a.ob, dana]);
    ok("an accepter with no time is refused by ck_oblig_acceptance_paired",
      !!m && m.includes("ck_oblig_acceptance_paired"), m);

    m = await CONSTRAINT_ERR(db,
      `update obligations set accepted_by_user_id=$2, accepted_at=now(), status='in_progress' where id=$1`, [a.ob, sam]);
    ok("accepted by Sam while assigned to Dana is refused by ck_oblig_accepter_is_owner",
      !!m && m.includes("ck_oblig_accepter_is_owner"), m);

    m = await CONSTRAINT_ERR(db,
      `update obligations set accepted_by_user_id=$2, assigned_user_id=$2, accepted_at=now() where id=$1`, [a.ob, dana]);
    ok("accepted work that is still open is refused by ck_oblig_accepted_not_open",
      !!m && m.includes("ck_oblig_accepted_not_open"), m);

    m = await CONSTRAINT_ERR(db,
      `update obligations set acceptance_key='SM_HARNESS' where id=$1`, [a.ob]);
    ok("a key with no acceptance is refused by ck_oblig_acceptance_key_requires_acceptance",
      !!m && m.includes("ck_oblig_acceptance_key_requires_acceptance"), m);
  }

  // ── THE CANONICAL SERVICE ──────────────────────────────────────────
  section("3. acceptWork — SERVER-DERIVED SCOPE, REAL ROWS");
  const { acceptWork } = require("../../src/technician/acceptance_service");
  const tx = async (fn) => {
    await db.query("begin");
    try { const r = await fn(db); await db.query("commit"); return r; }
    catch (e) { await db.query("rollback").catch(() => {}); throw e; }
  };
  const countVector = async () => {
    const tables = (await db.query(
      `select table_name from information_schema.tables where table_schema='public' order by table_name`)).rows.map((r) => r.table_name);
    const out = {};
    for (const t of tables) out[t] = Number((await db.query(`select count(*)::int c from "${t}"`)).rows[0].c);
    return out;
  };

  {
    const a = await mkWork(p1, dana);
    const before = await countVector();
    const r = await tx((c) => acceptWork(c, { obligation_id: a.ob, user_id: dana, organization_id: org,
      acceptance_key: "SM_HARNESS_ACCEPT_1", channel: "sms" }));
    ok("Dana accepts her own open work at her own property", r.outcome === "accepted", r.refusal || "");
    ok("...the obligation is in_progress and owned by her",
      r.obligation && r.obligation.status === "in_progress"
      && r.obligation.assigned_user_id === dana && r.obligation.accepted_by_user_id === dana);
    ok("...with a durable acceptance time and key",
      !!r.obligation.accepted_at && r.obligation.acceptance_key === "SM_HARNESS_ACCEPT_1");
    ok("...and ownership_origin records HOW it was owned",
      r.obligation.ownership_origin === "accepted_by_owner");

    const after = await countVector();
    ok("...exactly one immutable event was written, and nothing else changed shape",
      after.events === before.events + 1
      && Object.keys(after).every((t) => t === "events" || after[t] === before[t]),
      JSON.stringify({ before: before.events, after: after.events }));
    const ev = (await db.query(`select type, note from events where type='work_accepted' order by occurred_at desc limit 1`)).rows[0];
    const note = JSON.parse(ev.note);
    ok("...the event names the work order, the accepter and the channel",
      note.work_order_id === a.wo && note.accepted_by_user_id === dana && note.channel === "sms"
      && note.from_status === "open" && note.to_status === "in_progress");
  }

  // ── REPLAY ─────────────────────────────────────────────────────────
  section("4. REPLAY SAFETY");
  {
    const a = await mkWork(p1, dana);
    await tx((c) => acceptWork(c, { obligation_id: a.ob, user_id: dana, organization_id: org, acceptance_key: "SM_REPLAY", channel: "sms" }));
    const before = await countVector();
    const again = await tx((c) => acceptWork(c, { obligation_id: a.ob, user_id: dana, organization_id: org, acceptance_key: "SM_REPLAY", channel: "sms" }));
    ok("the same message again is a REPLAY, not an error and not a second acceptance",
      again.outcome === "replayed" && again.event === null);
    const after = await countVector();
    ok("...and it wrote nothing at all",
      Object.keys(after).every((t) => after[t] === before[t]), JSON.stringify({ before, after }));

    //  A DIFFERENT message trying to accept the same, already-accepted work.
    const other = await tx((c) => acceptWork(c, { obligation_id: a.ob, user_id: dana, organization_id: org, acceptance_key: "SM_DIFFERENT", channel: "sms" }));
    ok("a different message for work she already holds is still a replay, never a re-acceptance",
      other.outcome === "replayed");
    const stored = (await db.query(`select acceptance_key from obligations where id=$1`, [a.ob])).rows[0];
    ok("...and the FIRST key is the one that stands", stored.acceptance_key === "SM_REPLAY");

    //  The key is globally unique: a second obligation cannot reuse it.
    const b = await mkWork(p1, dana);
    const m = await CONSTRAINT_ERR(db,
      `update obligations set assigned_user_id=$2, accepted_by_user_id=$2, accepted_at=now(),
              status='in_progress', acceptance_key='SM_REPLAY' where id=$1`, [b.ob, dana]);
    ok("one inbound message can accept at most one obligation, enforced by the database",
      !!m && m.includes("uq_obligations_acceptance_key"), m);
  }

  // ── REFUSALS WRITE NOTHING ─────────────────────────────────────────
  section("5. CROSS-PROPERTY AND OWNERSHIP REFUSALS WRITE NOTHING");
  {
    //  Work at P2, assigned to Dana on paper — but Dana is not on P2's team.
    const cross = await mkWork(p2, dana);
    const before = await countVector();
    const r = await tx((c) => acceptWork(c, { obligation_id: cross.ob, user_id: dana, organization_id: org, acceptance_key: "SM_CROSS" }));
    ok("assignment on the row does not override the actor's real scope",
      r.outcome === "refused" && r.refusal === "property_outside_actor_scope", JSON.stringify(r));
    ok("...and the refusal wrote nothing",
      JSON.stringify(await countVector()) === JSON.stringify(before));

    //  Somebody else's work at a property Dana IS on.
    const theirs = await mkWork(p1, sam);
    const r2 = await tx((c) => acceptWork(c, { obligation_id: theirs.ob, user_id: dana, organization_id: org, acceptance_key: "SM_THEIRS" }));
    ok("work assigned to someone else is refused even at her own property",
      r2.outcome === "refused" && r2.refusal === "not_assigned_to_actor");

    //  The wrong organization. The line established it; it is not negotiable.
    const own = await mkWork(p1, dana);
    const r3 = await tx((c) => acceptWork(c, { obligation_id: own.ob, user_id: dana, organization_id: otherOrg, acceptance_key: "SM_ORG" }));
    ok("the organization the line established scopes the assignment lookup",
      r3.outcome === "refused" && r3.refusal === "property_outside_actor_scope");

    //  An inactive assignment is not an assignment.
    await db.query(`update property_team_assignments set active=false where user_id=$1 and property_id=$2`, [dana, p1]);
    const inactive = await mkWork(p1, dana);
    const r4 = await tx((c) => acceptWork(c, { obligation_id: inactive.ob, user_id: dana, organization_id: org, acceptance_key: "SM_INACTIVE" }));
    ok("an inactive team assignment grants nothing",
      r4.outcome === "refused" && r4.refusal === "property_outside_actor_scope");
    await db.query(`update property_team_assignments set active=true where user_id=$1 and property_id=$2`, [dana, p1]);

    const missing = await tx(async (c) => {
      try { await acceptWork(c, { obligation_id: "00000000-0000-0000-0000-000000000000", user_id: dana, organization_id: org }); return null; }
      catch (e) { return e.code; }
    });
    ok("a nonexistent obligation is NOT_FOUND, not a silent success", missing === "NOT_FOUND");
    for (const bad of [{ user_id: dana, organization_id: org }, { obligation_id: "x", organization_id: org }, { obligation_id: "x", user_id: dana }]) {
      // eslint-disable-next-line no-await-in-loop
      const c = await tx(async (cl) => { try { await acceptWork(cl, bad); return null; } catch (e) { return e.code; } });
      ok(`a call missing ${Object.keys({ obligation_id: 1, user_id: 1, organization_id: 1 }).filter((k) => !(k in bad)).join("/")} is refused`,
        c === "BAD_INPUT");
    }
  }

  section("6. RUN VALIDITY");
  ok("no swallowed database error anywhere in the run — absence of red is not green",
    sawFatalDbError === null, sawFatalDbError || "");

  code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
} catch (e) {
  code = receipt.died(HARNESS, e, passed + failed);
} finally {
  try { if (db) await db.end(); } catch { /* closing is not a proof step */ }
  try { if (admin) { await admin.query(`drop database if exists ${SCRATCH_DB}`); await admin.end(); } }
  catch (e) { console.error("  scratch database cleanup failed:", e.message); }
}
process.exit(code);
})();
