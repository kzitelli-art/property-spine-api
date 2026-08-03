// ════════════════════════════════════════════════════════════════════
//  property_line_hardening.db.js — REAL POSTGRES + REAL HTTP.
//
//  Proves that a resident's message can never bind to the wrong property.
//
//  Two independent guarantees, proven separately because they protect
//  against different failures:
//
//    PHASE 1 — THE CODE fails closed even on a database that permits the
//              ambiguity. The real inbound route is mounted exactly as
//              server.js mounts it and driven over real HTTP.
//    PHASE 2 — THE DATABASE makes the ambiguity unreachable. Migration 129
//              is executed verbatim against real Postgres.
//
//  Phase 1 deliberately runs WITHOUT 129 applied. If it ran after, the
//  ambiguous case could not be constructed at all, and "the code fails
//  closed" would be an untested claim resting on the constraint. Defence in
//  depth is only depth if each layer is proven alone.
//
//  ── SCHEMA SCOPE, STATED PLAINLY ────────────────────────────────────
//  This harness builds `properties` and `comm_events` from the VERBATIM
//  definitions in migrations 001 and 030, plus row-count sentinels for
//  work_orders and obligations. It does NOT build the full production
//  schema, because the migration chain CANNOT rebuild from an empty
//  database — 012_bank_intake.sql fails on `yardi_code` (PR #33, reproduced
//  on real Postgres 16.13). That is a known, owned defect outside this
//  slice.
//
//  What that costs, honestly: the zero-write assertions below cover every
//  table this code path can reach before it returns, and are enforced as a
//  full row-count vector over the whole schema — not a named-table spot
//  check. They do not prove anything about tables the path never touches.
//
//  ── SAFETY ──────────────────────────────────────────────────────────
//   · HARNESS_DATABASE_URL only, no fallback. Everything happens inside a
//     scratch database this harness creates and drops.
//   · Every phone number is harness-minted in a documented test range and
//     every provider id carries an unmistakable harness prefix. Asserted,
//     not just intended.
//   · The SMS transport double records attempted sends and never imports
//     the Twilio client, so a real wire is unreachable by construction.
//     Asserted: zero sends attempted across the whole run.
// ════════════════════════════════════════════════════════════════════
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Client } = require("pg");
const receipt = require("./_run_receipt");
const {
  normalizePropertyLine,
  isCanonicalPropertyLine,
  resolvePropertyByLine,
} = require("../src/comms/property_line");

const HARNESS = __filename;
const EXPECTED = 34;
let passed = 0, failed = 0, ran = 0;
function ok(label, cond, detail) {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`); }

const ADMIN_URL = receipt.harnessConnectionString();
const SUFFIX = String(process.pid);
const SCRATCH_DB = `ps_property_line_${SUFFIX}`;

//  HARNESS-CONTROLLED NUMBERS. +1 555 01xx xxxx is the reserved fictional
//  range; nothing here can reach a real handset even if a wire existed.
const LINE_A = "+15550101001";
const LINE_A_FORMATTED = "(555) 010-1001";
const LINE_A_DASHED = "555-010-1001";
const LINE_A_ELEVEN = "1 555 010 1001";
const LINE_B = "+15550101002";
const LINE_UNKNOWN = "+15550101999";
const SENDER = "+15550102001";
const SID_PREFIX = "HARNESSSID_";

const MIGRATION_129 = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "129_property_line_uniqueness.sql"), "utf8");

//  properties + comm_events, verbatim from migrations 001 and 030, minus
//  FKs to tables outside this scope.
const SCOPED_SCHEMA = `
  create extension if not exists pgcrypto;
  create table properties (
    id            uuid primary key default gen_random_uuid(),
    name          text not null,
    address       text,
    city          text, state text, zip text,
    property_type text,
    leasing_basis text,
    sms_number    text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
  );
  create table comm_events (
    id            uuid primary key default gen_random_uuid(),
    property_id   uuid references properties(id) on delete cascade,
    person_id     uuid,
    unit_id       uuid,
    work_order_id uuid,
    channel       text not null default 'chat',
    direction     text not null default 'inbound',
    body          text,
    transcript    text,
    ai_summary    text,
    sms_sid       text,
    needs_human   boolean not null default false,
    follow_up_required boolean not null default false,
    occurred_at   timestamptz not null default now()
  );
  create unique index idx_comm_sms_sid on comm_events(sms_sid) where sms_sid is not null;
  create table work_orders (id uuid primary key default gen_random_uuid(), property_id uuid);
  create table obligations (id uuid primary key default gen_random_uuid(), property_id uuid);
`;

(async () => {
  let admin = null, db = null, server = null, code = 1;
  const sendsAttempted = [];
  try {
    admin = new Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
    await admin.connect();
    await admin.query(`drop database if exists ${SCRATCH_DB}`);
    await admin.query(`create database ${SCRATCH_DB}`);

    const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = "/" + SCRATCH_DB; return u.toString(); })();
    db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await db.query(SCOPED_SCHEMA);

    receipt.begin(HARNESS, { url: dbUrl, expected: EXPECTED });
    console.log(`  SCRATCH   ${SCRATCH_DB}`);
    console.log(`  MIGRATION 129_property_line_uniqueness.sql (executed verbatim in phase 2)`);
    console.log(`  NUMBERS   harness-minted in the +1 555 01xx reserved range only\n`);

    const propA = (await db.query(
      `insert into properties (name, sms_number) values ('Harness A', $1) returning id`, [LINE_A])).rows[0];
    const propB = (await db.query(
      `insert into properties (name, sms_number) values ('Harness B', $1) returning id`, [LINE_B])).rows[0];

    // ══ PHASE 1 — THE CODE, on a database that still permits ambiguity ══
    section("PHASE 1 · resolver semantics (no constraint yet)");

    {
      const r = await resolvePropertyByLine(db, LINE_A);
      ok("canonical number resolves to exactly one property",
        r.outcome === "one" && r.property.id === propA.id, JSON.stringify(r.outcome));
      ok("and it is the CORRECT property, not merely a property",
        r.property.id === propA.id && r.property.id !== propB.id);
    }

    //  Formatting-equivalent inbound numbers must resolve identically. This
    //  is the defect where the write path normalized and the read path did
    //  not: before this change these three all failed to match at all.
    for (const [label, variant] of [
      ["parenthesised", LINE_A_FORMATTED],
      ["dashed", LINE_A_DASHED],
      ["11-digit with spaces", LINE_A_ELEVEN],
    ]) {
      const r = await resolvePropertyByLine(db, variant);
      ok(`formatting-equivalent inbound (${label}) resolves to the same property`,
        r.outcome === "one" && r.property.id === propA.id, `${variant} → ${r.outcome}`);
    }

    {
      const r = await resolvePropertyByLine(db, LINE_UNKNOWN);
      ok("a line no property holds → 'none', never a pick",
        r.outcome === "none" && r.property === null);
      const g = await resolvePropertyByLine(db, "not-a-phone-number");
      ok("an unnormalizable To → 'unresolvable', never a pick",
        g.outcome === "unresolvable" && g.property === null);
    }

    //  THE AMBIGUOUS STATE. Constructible only because 129 is not applied.
    await db.query(`update properties set sms_number = $1 where id = $2`, [LINE_A, propB.id]);
    {
      const r = await resolvePropertyByLine(db, LINE_A);
      ok("two properties on one line → 'many'", r.outcome === "many", r.outcome);
      ok("'many' returns NO property — the caller cannot accidentally bind",
        r.property === null);
      ok("'many' names every candidate so an operator can resolve it",
        r.candidates.length === 2 &&
        r.candidates.map((c) => c.id).sort().join() === [propA.id, propB.id].sort().join());
    }

    // ── real HTTP, real router ────────────────────────────────────────
    section("PHASE 1 · real HTTP through the mounted router");

    const express = require("express");
    const smsDouble = {
      enabled: () => true,
      validateWebhook: () => true,
      sendSms: async (args) => { sendsAttempted.push(args); return { sid: SID_PREFIX + "OUT" }; },
    };
    const commBoundary = require(path.join(__dirname, "../src/comms/communications_boundary.js"))({
      pool: db, sms: smsDouble,
    });
    const { makeWorkOrderService } = require(path.join(__dirname, "../src/maintenance/work_order_service.js"));
    const { spawnObligationFromEvent, satisfyObligation } = require(path.join(__dirname, "./_engine.js"));
    const { transitionObligation } = require(path.join(__dirname, "../src/shared/obligation_transitions.js"));
    const workOrderService = makeWorkOrderService({ spawnObligationFromEvent, satisfyObligation, transitionObligation });
    const tenantLinkModule = require(path.join(__dirname, "../src/comms/tenantlink.js"));

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use("/", tenantLinkModule({
      pool: db, anthropic: { messages: { create: async () => ({ content: [{ text: "{}" }] }) } },
      INGEST_MODEL: "harness", sms: smsDouble, commBoundary, workOrderService,
      getAgentService: () => null,
    }));
    server = app.listen(0);
    const port = server.address().port;

    const inbound = (to, sid) => new Promise((resolve, reject) => {
      const body = `MessageSid=${encodeURIComponent(sid)}&From=${encodeURIComponent(SENDER)}` +
                   `&To=${encodeURIComponent(to)}&Body=${encodeURIComponent("water leaking under the sink")}`;
      const req = http.request({ host: "127.0.0.1", port, path: "/communications/inbound-sms", method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } },
        (res) => { let d = ""; res.on("data", (x) => { d += x; }); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
      req.on("error", reject);
      req.write(body); req.end();
    });

    //  Full row-count vector across every table — stronger than naming the
    //  tables we expect to stay empty.
    const vector = async () => {
      const t = (await db.query(
        "select table_name from information_schema.tables where table_schema='public' order by 1")).rows;
      const out = {};
      for (const { table_name } of t) {
        out[table_name] = Number((await db.query(`select count(*)::int n from "${table_name}"`)).rows[0].n);
      }
      return out;
    };

    {
      const before = await vector();
      const res = await inbound(LINE_A, SID_PREFIX + "AMBIG_1");
      const after = await vector();
      ok("HTTP ambiguous line: route answers the provider (no retry storm)",
        res.status === 200, `status=${res.status}`);
      ok("HTTP ambiguous line: ZERO rows written anywhere in the schema",
        JSON.stringify(before) === JSON.stringify(after),
        `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
      ok("HTTP ambiguous line: no comm_event exists for that provider id",
        Number((await db.query("select count(*)::int n from comm_events where sms_sid=$1",
          [SID_PREFIX + "AMBIG_1"])).rows[0].n) === 0);
      ok("HTTP ambiguous line: no work order on EITHER candidate property",
        Number((await db.query("select count(*)::int n from work_orders")).rows[0].n) === 0);
      ok("HTTP ambiguous line: no obligation on either candidate property",
        Number((await db.query("select count(*)::int n from obligations")).rows[0].n) === 0);
      ok("HTTP ambiguous line: no outbound attempted",
        sendsAttempted.length === 0, JSON.stringify(sendsAttempted));
      ok("HTTP ambiguous line: response carries no property identity",
        !new RegExp(`${propA.id}|${propB.id}`).test(res.body));
    }

    {
      const before = await vector();
      const res = await inbound(LINE_UNKNOWN, SID_PREFIX + "UNKNOWN_1");
      const after = await vector();
      ok("HTTP unknown line: route answers the provider", res.status === 200);
      ok("HTTP unknown line: ZERO rows written anywhere in the schema",
        JSON.stringify(before) === JSON.stringify(after));
      ok("HTTP unknown line: no outbound attempted", sendsAttempted.length === 0);
    }

    //  PROPERTY: no cross-property binding. Restore B to its own line, then
    //  confirm A's line reaches only A and B's only B.
    await db.query(`update properties set sms_number=$1 where id=$2`, [LINE_B, propB.id]);
    {
      const a = await resolvePropertyByLine(db, LINE_A);
      const b = await resolvePropertyByLine(db, LINE_B);
      ok("PROPERTY: each line binds to its own property and no other",
        a.property.id === propA.id && b.property.id === propB.id && propA.id !== propB.id);
      const bFormatted = await resolvePropertyByLine(db, "(555) 010-1002");
      ok("PROPERTY: a formatting variant never crosses to the other property",
        bFormatted.property.id === propB.id);
    }

    // ══ PHASE 2 — THE DATABASE ══════════════════════════════════════
    section("PHASE 2 · migration 129 against real Postgres");

    //  2a. Refuses on a normalized duplicate, naming the exact ids, and
    //      mutates nothing.
    await db.query(`update properties set sms_number=$1 where id=$2`, [LINE_A_FORMATTED, propB.id]);
    {
      const snapshot = (await db.query("select id, sms_number from properties order by id")).rows;
      let raised = null;
      try { await db.query(MIGRATION_129); } catch (e) { raised = e; }
      ok("129 REFUSES when two properties normalize to one line", !!raised);
      ok("129 names both colliding property ids",
        !!raised && raised.message.includes(propA.id) && raised.message.includes(propB.id),
        raised && raised.message.slice(0, 300));
      ok("129 picks NO winner — it says a human decides",
        !!raised && /human decides which property owns/i.test(raised.message));
      const after = (await db.query("select id, sms_number from properties order by id")).rows;
      ok("129 mutated nothing on refusal",
        JSON.stringify(snapshot) === JSON.stringify(after));
      const idx = await db.query("select to_regclass('public.uq_properties_sms_number') is null as absent");
      ok("129 installed no index on refusal", idx.rows[0].absent === true);
    }

    //  2b. Refuses on a value it cannot normalize.
    await db.query(`update properties set sms_number='not a phone' where id=$1`, [propB.id]);
    {
      let raised = null;
      try { await db.query(MIGRATION_129); } catch (e) { raised = e; }
      ok("129 REFUSES on an unnormalizable stored line", !!raised);
      ok("129 names the offending property id",
        !!raised && raised.message.includes(propB.id));
    }

    //  2c. Clean, with one non-canonical value → backfills, then constrains.
    await db.query(`update properties set sms_number=$1 where id=$2`, ["(555) 010-1002", propB.id]);
    {
      await db.query(MIGRATION_129);
      const rows = (await db.query("select id, sms_number from properties order by id")).rows;
      const b = rows.find((r) => r.id === propB.id);
      ok("129 backfilled the non-canonical value to canonical form",
        b.sms_number === LINE_B, b.sms_number);
      ok("129 left the already-canonical value untouched",
        rows.find((r) => r.id === propA.id).sms_number === LINE_A);
      ok("every stored line is now canonical",
        rows.every((r) => isCanonicalPropertyLine(r.sms_number)));
    }

    //  2d. The constraints actually hold.
    {
      let dup = null;
      try {
        await db.query(`insert into properties (name, sms_number) values ('Dup', $1)`, [LINE_A]);
      } catch (e) { dup = e; }
      ok("UNIQUE: a second property cannot take a line already held", !!dup);
      ok("UNIQUE: refused by the index, not by application code",
        !!dup && /uq_properties_sms_number/.test(dup.message), dup && dup.message);

      //  THE BYPASS THIS SLICE CLOSES. Before the CHECK constraint, storing
      //  the same line in another format produced a different string, so the
      //  unique index saw no conflict — uniqueness defeated by formatting.
      let byp = null;
      try {
        await db.query(`insert into properties (name, sms_number) values ('Bypass', $1)`, [LINE_A_FORMATTED]);
      } catch (e) { byp = e; }
      ok("BYPASS BLOCKED: alternate formatting of a held line is refused", !!byp);
      ok("BYPASS BLOCKED: refused by the canonical-form CHECK",
        !!byp && /ck_properties_sms_number_canonical/.test(byp.message), byp && byp.message);

      let nulls = null;
      try {
        await db.query(`insert into properties (name, sms_number) values ('NoLine A', null)`);
        await db.query(`insert into properties (name, sms_number) values ('NoLine B', null)`);
      } catch (e) { nulls = e; }
      ok("UNIQUE: the predicate matches the resolver — many properties may hold NO line",
        nulls === null, nulls && nulls.message);
    }

    // ══ SAFETY ASSERTIONS ═══════════════════════════════════════════
    section("SAFETY");
    {
      ok("no real SMS: zero sends attempted across the entire run",
        sendsAttempted.length === 0, JSON.stringify(sendsAttempted));
      const lines = (await db.query(
        "select sms_number from properties where sms_number is not null")).rows.map((r) => r.sms_number);
      ok("every line used is in the harness-reserved +1 555 01xx range",
        lines.every((l) => /^\+1555010\d{4}$/.test(l)), JSON.stringify(lines));
      const sids = (await db.query(
        "select sms_sid from comm_events where sms_sid is not null")).rows.map((r) => r.sms_sid);
      ok("every provider id in the database is harness-minted",
        sids.every((s) => s.startsWith(SID_PREFIX)), JSON.stringify(sids));
      ok("normalizePropertyLine is the single normalizer used by the resolver",
        normalizePropertyLine(LINE_A_FORMATTED) === LINE_A);
    }

    code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
  } catch (e) {
    code = receipt.died(HARNESS, e, ran);
  } finally {
    try { if (server) server.close(); } catch { /* closing */ }
    try { if (db) await db.end(); } catch { /* closing */ }
    try {
      if (admin) { await admin.query(`drop database if exists ${SCRATCH_DB}`); await admin.end(); }
    } catch (e) { console.error("  ! cleanup incomplete: " + e.message); }
  }
  process.exit(code);
})();
