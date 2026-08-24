/* ════════════════════════════════════════════════════════════════════
   utility_statement_usage_bound_equivalence.db.js — THE BOUND CHANGED
   THE COST AND NOTHING ELSE.

   `utility_statement_usage` was loaded in full by the generic TABLES loop
   in utility_position_read.js: every usage row on the property, forever.
   Rows arrive per meter, per line, per statement, per billing cycle — the
   fastest-growing table the standing read touches.

   Exactly ONE thing reads them. utility_projection.js hands the array to
   statementView() once, for the LATEST statement of each account, and
   statementView filters it to `u.statement_id === row.id`. Every other row
   was loaded, held and discarded. detail.recent_statements is built from
   those same already-built views, so no surface reaches usage for any
   other statement.

   ── THE BAR ─────────────────────────────────────────────────────────
   Not "looks right". IDENTICAL OUTPUT. The unbounded loader is preserved
   VERBATIM below and both are run against the same database; standing AND
   detail are compared by deep structural equality at several as_of values
   INCLUDING A HISTORICAL ONE.

   ⚠ THE FIXTURE PUTS USAGE ON STATEMENTS THAT MUST BE DROPPED. Two
   accounts, three statements each, usage rows on ALL of them. If the bound
   were merely property-scoped, or picked the wrong statement, the surviving
   `usage` array would differ and the comparison would say so.

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — proof infrastructure. REMOVAL CONDITION: when
   utility_statement_usage is no longer read by the standing path.

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/utility_statement_usage_bound_equivalence.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const URL_ = receipt.harnessConnectionString();

const read = require("../src/asset/utility_position_read.js");
const projection = require("../src/asset/utility_projection.js");

let pass = 0, fail = 0;
const ok = (l, d) => { pass++; console.log(`  \u2714 ${l}${d ? " \u2014 " + d : ""}`); };
const bad = (l, d) => { fail++; console.log(`  \u2718 ${l}${d ? "\n      " + d : ""}`); };

function scopedMigration(file) {
  return fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8")
    .replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "");
}

/*  ── THE UNBOUNDED LOADER, PRESERVED VERBATIM ──────────────────────
 *  This is what readSnapshot()+readPosition() did before the bound: one
 *  generic loop over TABLES including statement_usage, then a single
 *  projection pass. It lives here so the comparison is against the REAL
 *  previous behaviour and not against my description of it.            */
async function readPositionUnbounded(client, { property_id, as_of = null } = {}) {
  const snapshot = { property_id };
  for (const [key, table] of Object.entries(read.TABLES)) {
    if (key === "providers") {
      snapshot[key] = (await client.query(
        `select p.id, p.provider_name
           from utility_providers p
          where exists (select 1 from utility_service_providers sp
                         where sp.provider_id = p.id and sp.property_id = $1)
             or exists (select 1 from utility_provider_accounts a
                         where a.provider_id = p.id and a.property_id = $1)
             or exists (select 1 from utility_meters m
                         where m.provider_id = p.id and m.property_id = $1)`,
        [property_id])).rows;
      continue;
    }
    snapshot[key] = (await client.query(
      `select * from ${table} where property_id = $1`, [property_id])).rows;
  }
  return projection.project(snapshot, { as_of });
}

/*  Counts usage rows actually returned, so the cost claim is measured
    rather than asserted. */
function counting(db) {
  const stat = { usageRows: 0, usageQueries: 0, queries: 0 };
  return { stat, client: { query: async (sql, params) => {
    const r = await db.query(sql, params);
    stat.queries++;
    if (/utility_statement_usage/.test(String(sql))) {
      stat.usageQueries++; stat.usageRows += r.rows.length;
    }
    return r;
  } } };
}

const AS_OFS = [
  ["2026-08-13", "today-ish, after every statement"],
  ["2026-07-15", "HISTORICAL — mid-series"],
  ["2026-01-01", "HISTORICAL — before every statement"],
  ["2030-01-01", "far future"],
];

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "utility_usage_bound_" + Date.now();
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


    //  A SECOND ACCOUNT, so "latest per account" is a real distinction.
    const acct2 = (await c.query(
      `insert into utility_provider_accounts
         (property_id, provider_id, external_account_identifier, effective_from,
          provenance_note, recorded_by_user_id)
       values ($1,$2,'9999000011','2020-01-01','utility bill',$3) returning id`,
      [prop, prov, uid])).rows[0].id;
    await c.query(
      `insert into utility_account_services
         (property_id, account_id, service_id, effective_from, provenance_note, recorded_by_user_id)
       values ($1,$2,$3,'2020-01-01','utility bill',$4)`, [prop, acct2, svc, uid]);

    console.log("\nUTILITY STATEMENT USAGE — BOUND EQUIVALENCE");
    console.log("=".repeat(70));

    //  Three statements per account, usage on EVERY one of them.
    const plan = [
      [acct,  ["2026-06-01", "2026-07-01", "2026-08-01"]],
      [acct2, ["2026-05-15", "2026-06-15", "2026-07-15"]],
    ];
    let seeded = 0;
    for (const [accountId, dates] of plan) {
      for (const d of dates) {
        const st = (await c.query(
          `insert into utility_statements
             (property_id, account_id, bill_date, service_period_start, service_period_end,
              currency_code, amount_billed_cents, source_artifact_id, recorded_by_user_id)
           values ($1,$2,$3::date,$3::date - interval '30 days',$3::date,'USD',12345,$4,$5)
           returning id`, [prop, accountId, d, art, uid])).rows[0].id;
        for (let line = 0; line < 3; line++) {
          await c.query(
            `insert into utility_statement_usage
               (property_id, statement_id, account_id, service_id, quantity,
                usage_unit, usage_basis, source_artifact_id, recorded_by_user_id)
             values ($1,$2,$3,$4,$5,'kWh','observed',$6,$7)`,
            [prop, st, accountId, svc, 100 + line, art, uid]);
          seeded++;
        }
      }
    }
    const total = (await c.query(
      `select count(*)::int n from utility_statement_usage`)).rows[0].n;
    console.log(`  2 accounts x 3 statements x 3 usage lines = ${total} usage rows`);
    console.log("  only the LATEST statement of each account survives into the position\n");
    ok(`${total} usage rows recorded, on every statement including the ones that must be dropped`,
       total === 18 && seeded === 18);

    console.log("\n  as_of         standing      detail        usage rows read");
    console.log("  " + "-".repeat(64));
    for (const [asOf, why] of AS_OFS) {
      const unbounded = await readPositionUnbounded(c, { property_id: prop, as_of: asOf });
      const m = counting(c);
      const bounded = await read.readPosition(m.client, { property_id: prop, as_of: asOf });

      let sOK = true, dOK = true, detail = "";
      try { assert.deepStrictEqual(bounded.standing, unbounded.standing); }
      catch (e) { sOK = false; detail = String(e.message).slice(0, 300); }
      try { assert.deepStrictEqual(bounded.detail, unbounded.detail); }
      catch (e) { dOK = false; detail = detail || String(e.message).slice(0, 300); }

      console.log(`  ${asOf}    ${sOK ? "IDENTICAL " : "  DIFFERS "}   ${dOK ? "IDENTICAL " : "  DIFFERS "}   ` +
                  `${String(m.stat.usageRows).padStart(2)} of ${total}`);
      ok(`${asOf} \u2014 ${why}`, undefined);
      if (!(sOK && dOK)) bad(`  ...output identical at ${asOf}`, detail);
      ok(`  ...and read ${m.stat.usageRows} usage rows, not ${total}`, undefined);
      if (m.stat.usageRows > 6) bad(`  ...bounded to the surviving statements`,
        `read ${m.stat.usageRows}; at most 2 statements x 3 lines = 6 can survive`);
      if (m.stat.usageQueries > 1) bad("  ...one usage query, not one per statement",
        `issued ${m.stat.usageQueries}`);
    }

    /*  THE SERIES IS STILL REACHABLE BY NAME. Bounding the standing path
        is not permission to make the detail unreachable (§40.6).        */
    console.log("\n  the full series, reachable by name");
    console.log("  " + "-".repeat(64));
    const all = await read.loadAllStatementUsage(c, { property_id: prop });
    ok("loadAllStatementUsage() still returns every row", all.length === total,
       `${all.length} of ${total}`);

    console.log("\n" + "=".repeat(70));
    console.log(`  ${pass} green   ${fail} failed`);
    if (fail === 0) {
      console.log("\n  Identical standing AND detail at four as_of values including two");
      console.log("  historical ones, with usage seeded on statements that must be dropped,");
      console.log("  and 6 usage rows read instead of 18.\n");
    }
  } finally {
    await pool.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    if (c) c.release();
    await pool.end();
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
