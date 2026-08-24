/* ════════════════════════════════════════════════════════════════════
   utility_latest_statement_ordering.db.js — "LATEST STATEMENT" IS
   CHOSEN BY WEEKDAY NAME.

   utility_projection.js picks the statement an operator sees with:

       function newest(rows, fields) {
         const av = String(a[field] || "");
         if (av !== bv) return av < bv ? 1 : -1;
       }

   `bill_date` is a `date` column (migration 169). node-pg returns a
   `date` as a JS Date, and this repo sets no type parser — so
   String(row.bill_date) is "Sat Aug 01 2026 00:00:00 GMT+0000 (…)".

   Comparing THOSE as strings sorts by WEEKDAY NAME first:

       Fri < Mon < Sat < Sun < Thu < Tue < Wed

   The sort is descending, so ANY Wednesday beats ANY non-Wednesday
   whatever its year. A 2019 bill outranks a 2026 bill.

   ── WHY THIS IS NOT AN EDGE CASE ────────────────────────────────────
   The fixture below is three ordinary consecutive monthly bills —
   June, July and August 2026. July is a Wednesday. The read reports
   JULY as the latest statement, with July's amount, on a property whose
   August bill is recorded and readable.

   That figure reaches an operator through
   `standing.services[].latest_statement` and `standing.next_due_statement`.
   It is a confident wrong number, which §5 ranks below an honest blank.

   ── WHAT THIS FILE IS FOR ───────────────────────────────────────────
   It runs the REAL read against REAL Postgres built from the REAL
   migration, and asserts the CHRONOLOGICALLY latest statement is the one
   reported. Before the fix it fails; after the fix it passes. It is not
   a unit test of newest() — a pure test would have let the Date/String
   coupling escape, because the defect only exists once a driver hands
   back Dates.

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — proof infrastructure. REMOVAL CONDITION: none while
   utility_projection.js selects a latest statement. This is the file
   that makes "latest means latest" checkable.

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/utility_latest_statement_ordering.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const URL_ = receipt.harnessConnectionString();

const read = require("../src/asset/utility_position_read.js");

let pass = 0, fail = 0;
const ok = (label, detail) => { pass++; console.log(`  ✔ ${label}${detail ? " — " + detail : ""}`); };
const bad = (label, detail) => { fail++; console.log(`  ✘ ${label}${detail ? "\n      " + detail : ""}`); };

function scopedMigration(file) {
  let m = fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8");
  return m.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "");
}

/*  Three ORDINARY consecutive monthly bills. The weekday of each is what
    the defective comparison actually sorts on, so it is stated here. */
const BILLS = [
  { date: "2026-06-01", weekday: "Mon", amount: 11000 },
  { date: "2026-07-01", weekday: "Wed", amount: 12000 },
  { date: "2026-08-01", weekday: "Sat", amount: 13000 },   // ← chronologically latest
];
const TRUE_LATEST = "2026-08-01";

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "utility_ordering_" + Date.now();
  let c;
  try {
    await pool.query(`create schema ${schema}`);
    c = await pool.connect();
    await c.query(`set search_path to ${schema}`);
    await c.query(`
      create extension if not exists pgcrypto;
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      --  scope_type/scope_id are required by 169's utility_artifact_scope_guard:
      --  utility evidence must be retained for the SAME property. The stub
      --  carries them so that guard runs for real rather than being dodged.
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(),
        original_filename text not null, artifact_kind text not null default 'other',
        scope_type text, scope_id uuid);
      --  Migration 169 FKs service points to units/spaces. This proof never
      --  attaches a service point, but the schema must still build, so the
      --  two tables exist as minimal stubs. Nothing here reads them.
      create table units (
        id uuid primary key default gen_random_uuid(),
        property_id uuid not null references properties(id));
      create table spaces (
        id uuid primary key default gen_random_uuid(),
        unit_id uuid not null references units(id));
    `);
    await c.query(scopedMigration("169_utilities_canonical_truth.sql"));

    const uid = (await c.query(`insert into users (name) values ('Asset Ops') returning id`)).rows[0].id;
    const prop = (await c.query(`insert into properties (name) values ('4125 Chestnut') returning id`)).rows[0].id;
    const art = (await c.query(
      `insert into source_artifacts (original_filename, artifact_kind, scope_type, scope_id)
       values ('peco bill.pdf','utility_statement','property',$1) returning id`, [prop])).rows[0].id;

    const svc = (await c.query(
      `insert into utility_services (property_id, service_class, created_by_user_id)
       values ($1,'electricity',$2) returning id`, [prop, uid])).rows[0].id;
    await c.query(
      `insert into utility_service_declarations
         (property_id, service_id, applicability, effective_from, provenance_note, recorded_by_user_id)
       values ($1,$2,'present','2020-01-01','asset manager review',$3)`, [prop, svc, uid]);
    const prov = (await c.query(
      `insert into utility_providers (provider_name, provenance_note, recorded_by_user_id)
       values ('PECO','utility bill',$1) returning id`, [uid])).rows[0].id;
    await c.query(
      `insert into utility_service_providers
         (property_id, service_id, provider_id, effective_from, provenance_note, recorded_by_user_id)
       values ($1,$2,$3,'2020-01-01','utility bill',$4)`, [prop, svc, prov, uid]);
    const acct = (await c.query(
      `insert into utility_provider_accounts
         (property_id, provider_id, external_account_identifier, effective_from,
          provenance_note, recorded_by_user_id)
       values ($1,$2,'1234567890','2020-01-01','utility bill',$3) returning id`,
      [prop, prov, uid])).rows[0].id;
    await c.query(
      `insert into utility_account_services
         (property_id, account_id, service_id, effective_from, provenance_note, recorded_by_user_id)
       values ($1,$2,$3,'2020-01-01','utility bill',$4)`, [prop, acct, svc, uid]);

    console.log("\nUTILITY — WHICH STATEMENT IS 'LATEST'?");
    console.log("=".repeat(68));
    console.log("  three ordinary consecutive monthly bills\n");
    for (const b of BILLS) {
      await c.query(
        `insert into utility_statements
           (property_id, account_id, bill_date, service_period_start, service_period_end,
            currency_code, amount_billed_cents, source_artifact_id, recorded_by_user_id)
         values ($1,$2,$3::date,$3::date - interval '30 days',$3::date,
                 'USD',$4,$5,$6)`,
        [prop, acct, b.date, b.amount, art, uid]);
      console.log(`    ${b.date}  (${b.weekday})   $${(b.amount / 100).toFixed(2)}`);
    }
    console.log("");

    /*  ⚠ INSERTED IN CHRONOLOGICAL ORDER ON PURPOSE. If the read happened
        to be right only because rows came back in insertion order, that
        would be luck, not correctness — so the fixture gives the naive
        answer every chance to look correct.                              */
    ok("all three statements are recorded and readable",
       (await c.query(`select count(*)::int n from utility_statements`)).rows[0].n === 3);

    const standing = await read.readStanding(c, { property_id: prop });
    const svcRow = (standing.services || [])[0] || {};
    const latest = svcRow.latest_statement;

    console.log("  THE READ'S ANSWER");
    console.log("  " + "-".repeat(64));
    console.log(`    latest_statement.bill_date   ${latest ? latest.bill_date : "(none)"}`);
    console.log(`    latest_statement.amount      ${latest ? "$" + (Number(latest.amount_billed_cents) / 100).toFixed(2) : "(none)"}`);
    console.log(`    chronologically latest       ${TRUE_LATEST}  ($130.00)`);
    console.log("");

    ok("the read reports SOME latest statement", !!latest);
    if (latest && latest.bill_date === TRUE_LATEST) {
      ok("latest_statement is the CHRONOLOGICALLY latest bill", latest.bill_date);
    } else {
      bad("latest_statement is the CHRONOLOGICALLY latest bill",
          `reported ${latest && latest.bill_date} — the August bill is recorded and readable, `
          + `and the operator is shown ${latest && latest.bill_date}. `
          + `String(Date) sorts on weekday name: Fri < Mon < Sat < Sun < Thu < Tue < Wed, `
          + `descending — so Wednesday's bill outranks every other day.`);
    }
    if (latest && Number(latest.amount_billed_cents) === 13000) {
      ok("…and therefore carries the August amount", "$130.00");
    } else {
      bad("…and therefore carries the August amount",
          `reported $${latest ? (Number(latest.amount_billed_cents) / 100).toFixed(2) : "?"} — a real figure from a real bill, presented as current`);
    }

    /*  THE YEAR CASE. Weekday dominates the comparison completely, so the
        defect is not a near-miss between adjacent months — a bill from a
        different YEAR can win. */
    console.log("  AND IT IS NOT A NEAR-MISS — a 2019 bill against a 2026 bill");
    console.log("  " + "-".repeat(64));
    await c.query(`delete from utility_statements where property_id = $1`, [prop]);
    for (const [d, wd, amt] of [["2019-01-02", "Wed", 9900], ["2026-08-21", "Fri", 14500]]) {
      await c.query(
        `insert into utility_statements
           (property_id, account_id, bill_date, service_period_start, service_period_end,
            currency_code, amount_billed_cents, source_artifact_id, recorded_by_user_id)
         values ($1,$2,$3::date,$3::date - interval '30 days',$3::date,'USD',$4,$5,$6)`,
        [prop, acct, d, amt, art, uid]);
      console.log(`    ${d}  (${wd})   $${(amt / 100).toFixed(2)}`);
    }
    const standing2 = await read.readStanding(c, { property_id: prop });
    const latest2 = ((standing2.services || [])[0] || {}).latest_statement;
    console.log(`    read reports                 ${latest2 ? latest2.bill_date : "(none)"}`);
    console.log("");
    if (latest2 && latest2.bill_date === "2026-08-21") {
      ok("a 2026 bill outranks a 2019 bill", latest2.bill_date);
    } else {
      bad("a 2026 bill outranks a 2019 bill",
          `reported ${latest2 && latest2.bill_date} — seven years stale, because 2019-01-02 was a Wednesday`);
    }

    console.log("=".repeat(68));
    console.log(`  ${pass} green   ${fail} failed`);
    if (fail === 0) {
      console.log("\n  'Latest' means chronologically latest, proved against real Postgres");
      console.log("  with real date columns — which is where the defect lives. A pure test");
      console.log("  of newest() would pass on ISO strings and never see it.\n");
    }
  } finally {
    await pool.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    if (c) c.release();
    await pool.end();
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
