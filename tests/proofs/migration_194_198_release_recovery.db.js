#!/usr/bin/env node
/*
  Owned PostgreSQL release/recovery witness for migrations 195-198.

  Input is a nonce-owned, loopback database at exact 194. The witness clones
  it, never touches the input, drives the real predeploy wrapper and canonical
  migration runner, and drops every clone. Set:

    HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/spine_proof_<nonce>
    HARNESS_NONCE=<same nonce>

  The exact-194 fixture may be built with tests/e2e/apply_migrations.sh from a
  source tree whose migration ceiling is 194. That historical fresh-chain
  accommodation is fixture construction only; 195-198 always run through the
  canonical migrations/migrate.js owner.
*/
"use strict";

const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const WRAPPER = path.join(ROOT, "tools", "release", "migration_194_198_predeploy.js");
const url = new URL(String(process.env.HARNESS_DATABASE_URL || ""));
const nonce = String(process.env.HARNESS_NONCE || "");
if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error("HARNESS_NONCE must be 32 lowercase hex characters");
if (!["127.0.0.1", "[::1]"].includes(url.hostname) || url.username !== "postgres" ||
    url.pathname !== `/spine_proof_${nonce}` || url.search || url.hash) {
  throw new Error("HARNESS_DATABASE_URL must name the exact nonce-owned loopback database");
}
const sourceDatabase = url.pathname.slice(1);
const adminUrl = new URL(url.href);
adminUrl.pathname = "/postgres";
const pin = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
assert.match(pin, /^[a-f0-9]{40}$/);

let passed = 0;
const owned = new Set();
function ok(label, condition, detail = "") {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ""}`);
  passed++;
  console.log(`  ok    ${label}`);
}
function quoteIdentifier(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function dbUrl(database) { const copy = new URL(url.href); copy.pathname = `/${database}`; return copy.href; }

async function connect(connectionString) {
  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  return client;
}

async function cloneDatabase(admin, from, suffix) {
  const name = `spine_proof_${nonce.slice(0, 20)}_${suffix}`;
  await admin.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
  await admin.query(`create database ${quoteIdentifier(name)} template ${quoteIdentifier(from)}`);
  owned.add(name);
  return name;
}

function wrapper(database, args = [], environment = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: dbUrl(database),
      EXPECTED_SHA: pin,
      MIGRATION_PREFLIGHT_LOCK_TIMEOUT: "2s",
      MIGRATION_PREFLIGHT_STATEMENT_TIMEOUT: "5s",
      MIGRATION_APPLY_LOCK_TIMEOUT: "500ms",
      MIGRATION_APPLY_STATEMENT_TIMEOUT: "5s",
      ...environment,
    },
  });
  return { status: result.status, out: `${result.stdout || ""}\n${result.stderr || ""}`, elapsed: Date.now() - started };
}

function succeeds(label, result, pattern) {
  ok(label, result.status === 0 && (!pattern || pattern.test(result.out)),
    `exit=${result.status}\n${result.out.slice(-1600)}`);
}
function refuses(label, result, pattern) {
  ok(label, result.status !== 0 && (!pattern || pattern.test(result.out)),
    `exit=${result.status}\n${result.out.slice(-1600)}`);
}

async function ceiling(database) {
  const client = await connect(dbUrl(database));
  try {
    const result = await client.query("select count(*)::int as entries, max(version)::int as ceiling from schema_migrations");
    return result.rows[0];
  } finally { await client.end(); }
}

async function physicalSummary(database) {
  const client = await connect(dbUrl(database));
  try {
    const query = await client.query(`
      select
        to_regclass('public.inventory_correction_commands') is not null as commands,
        to_regprocedure('public.refuse_operative_attachment_to_retired_inventory()') is not null as policy_function,
        exists(select 1 from information_schema.columns where table_schema='public' and table_name='proposed_records' and column_name='selected_unit_id') as selected_unit,
        exists(select 1 from pg_constraint where conrelid='public.application_proposed_terms_confirmations'::regclass and conname='aptc_derived_names_offer_ck') as derived_check,
        (select pg_get_indexdef(indexrelid) from pg_index where indexrelid=to_regclass('public.uq_proposed_natural')) as natural_index
    `);
    return query.rows[0];
  } finally { await client.end(); }
}

async function tableCounts(database) {
  const client = await connect(dbUrl(database));
  try {
    const tables = (await client.query(`
      select tablename from pg_tables where schemaname='public'
        and tablename not in ('schema_migrations','inventory_correction_commands') order by tablename
    `)).rows.map((row) => row.tablename);
    const counts = {};
    for (const table of tables) counts[table] = Number((await client.query(`select count(*) as count from ${quoteIdentifier(table)}`)).rows[0].count);
    return counts;
  } finally { await client.end(); }
}

async function heldFailure(database, table, mode, args, expectedFile) {
  const blocker = await connect(dbUrl(database));
  try {
    await blocker.query("begin");
    await blocker.query(`lock table ${quoteIdentifier(table)} in ${mode} mode`);
    const result = wrapper(database, args);
    refuses(`${expectedFile} actual held lock fails the canonical migration`, result,
      new RegExp(`${expectedFile}.*FAILED|FAILED[\\s\\S]*${expectedFile}`, "i"));
    ok(`${expectedFile} reports PostgreSQL's real lock timeout`,
      /canceling statement due to lock timeout/i.test(result.out), result.out.slice(-1200));
    // Total process time includes the unchanged runner enumerating and printing
    // every prior migration before it reaches the pending file. The database
    // wait itself is the 500ms lock_timeout asserted by the error above.
    ok(`${expectedFile} release process is bounded`, result.elapsed < 15000, `${result.elapsed}ms`);
    return result;
  } finally {
    await blocker.query("rollback");
    await blocker.end();
  }
}

async function partialRefusal(database, expectedCeiling) {
  const state = await ceiling(database);
  ok(`failure leaves exact ledger ${expectedCeiling}`, state.ceiling === expectedCeiling,
    JSON.stringify(state));
  const verify = wrapper(database);
  refuses(`normal verify-only startup refuses partial ${expectedCeiling}`, verify,
    new RegExp(`exact ${expectedCeiling} accepted[\\s\\S]*verify-only accepts exact 198`, "i"));
}

async function sql(database, statement) {
  const client = await connect(dbUrl(database));
  try { await client.query(statement); } finally { await client.end(); }
}

async function falsify(admin, exact198, suffix, statement, pattern) {
  const database = await cloneDatabase(admin, exact198, suffix);
  await sql(database, statement);
  refuses(`same-name ${suffix} physical drift refuses`, wrapper(database), pattern);
}

(async () => {
  console.log(`\nCOMBINED MIGRATION 194-198 RELEASE/RECOVERY — owned ${sourceDatabase}\n`);
  const admin = await connect(adminUrl.href);
  try {
    const sourceState = await ceiling(sourceDatabase);
    ok("input fixture is exact 194", sourceState.ceiling === 194 && sourceState.entries === 182,
      JSON.stringify(sourceState));
    const sourcePhysical = await physicalSummary(sourceDatabase);
    ok("input carries the old source-claim index and no 195-197 objects",
      !sourcePhysical.derived_check && !sourcePhysical.selected_unit && !sourcePhysical.commands &&
      /natural_key IS NOT NULL/.test(sourcePhysical.natural_index) && !/import_source_row_id/.test(sourcePhysical.natural_index),
      JSON.stringify(sourcePhysical));

    // Prove node-postgres honors the same PGOPTIONS mechanism the wrapper gives
    // its canonical child, rather than merely asserting the environment text.
    const settingProbe = spawnSync(process.execPath, ["-e",
      "const{Client}=require('pg');(async()=>{let c=new Client({connectionString:process.env.DATABASE_URL,ssl:false});await c.connect();console.log((await c.query('show statement_timeout')).rows[0].statement_timeout);await c.end()})()"], {
      cwd: ROOT, encoding: "utf8",
      env: { ...process.env, DATABASE_URL: dbUrl(sourceDatabase), PGOPTIONS: "-c statement_timeout=750ms" },
    });
    ok("canonical child connection mechanism installs a positive statement_timeout",
      settingProbe.status === 0 && settingProbe.stdout.trim() === "750ms", settingProbe.stderr);

    const baselineCounts = await tableCounts(sourceDatabase);

    const fail195 = await cloneDatabase(admin, sourceDatabase, "fail195");
    await heldFailure(fail195, "application_proposed_terms_confirmations", "ACCESS SHARE", ["--apply"], "195_two_step_leasing_authored_offer_basis.sql");
    await partialRefusal(fail195, 194);
    succeeds("195 rollback uses ordinary --apply retry through exact 198", wrapper(fail195, ["--apply"]), /RELEASE VERIFIED/);

    const fail196 = await cloneDatabase(admin, sourceDatabase, "fail196");
    await heldFailure(fail196, "proposed_records", "ACCESS SHARE", ["--apply"], "196_source_home_identity_review.sql");
    await partialRefusal(fail196, 195);
    refuses("wrong --resume196 refuses exact 195", wrapper(fail196, ["--resume196"]), /requires exact 196, observed exact 195/i);
    const exact195 = await cloneDatabase(admin, fail196, "exact195");
    succeeds("exact 195 resumes explicitly through 198", wrapper(fail196, ["--resume195"]), /RELEASE VERIFIED/);

    const fail197 = await cloneDatabase(admin, exact195, "fail197");
    await heldFailure(fail197, "spaces", "ACCESS SHARE", ["--resume195"], "197_inventory_correction_hardening.sql");
    await partialRefusal(fail197, 196);
    refuses("wrong --resume197 refuses exact 196", wrapper(fail197, ["--resume197"]), /requires exact 197, observed exact 196/i);
    const exact196 = await cloneDatabase(admin, fail197, "exact196");
    succeeds("exact 196 resumes explicitly through 198", wrapper(fail197, ["--resume196"]), /RELEASE VERIFIED/);

    const fail198 = await cloneDatabase(admin, exact196, "fail198");
    await heldFailure(fail198, "proposed_records", "ROW EXCLUSIVE", ["--resume196"], "198_proposed_source_claim_identity.sql");
    await partialRefusal(fail198, 197);
    refuses("wrong --resume196 refuses exact 197", wrapper(fail198, ["--resume196"]), /requires exact 196, observed exact 197/i);
    succeeds("exact 197 resumes explicitly through 198", wrapper(fail198, ["--resume197"]), /RELEASE VERIFIED/);

    const clean = await cloneDatabase(admin, sourceDatabase, "clean");
    succeeds("clean exact 194 applies the reviewed 195-198 suffix", wrapper(clean, ["--apply"]), /RELEASE VERIFIED/);
    const cleanState = await ceiling(clean);
    ok("clean apply ends at 186 entries and ceiling 198", cleanState.entries === 186 && cleanState.ceiling === 198,
      JSON.stringify(cleanState));
    const afterCounts = await tableCounts(clean);
    ok("195-198 create no business rows", JSON.stringify(afterCounts) === JSON.stringify(baselineCounts));
    succeeds("repeat verify-only is a no-write exact-198 check", wrapper(clean), /VERIFY-ONLY: exact 198 verified/);
    const restart = spawnSync(process.execPath, [path.join(ROOT, "migrations", "migrate.js")], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: dbUrl(clean) },
    });
    succeeds("restart uses ordinary verify-only migrate.js at exact 198", {
      status: restart.status, out: `${restart.stdout || ""}\n${restart.stderr || ""}`,
    }, /SCHEMA VERIFIED/);

    refuses("wrong 40-SHA pin refuses before database mutation", wrapper(clean, [], {
      EXPECTED_SHA: "0".repeat(40),
    }), /differs from the executing checkout/i);
    const drift = await cloneDatabase(admin, clean, "ledgerdrift");
    await sql(drift, "update schema_migrations set name='wrong_197' where version='197'");
    refuses("ledger name drift refuses", wrapper(drift), /ledger is malformed|disagrees with this build/i);

    await falsify(admin, clean, "constraint", `
      alter table application_proposed_terms_confirmations drop constraint aptc_source_ck;
      alter table application_proposed_terms_confirmations add constraint aptc_source_ck check (source is not null)
    `, /aptc_source_ck differs/i);
    await falsify(admin, clean, "index196", `
      drop index ix_proposed_selected_unit;
      create index ix_proposed_selected_unit on proposed_records(selected_space_id)
    `, /ix_proposed_selected_unit definition differs/i);
    await falsify(admin, clean, "function197", `
      create or replace function refuse_operative_attachment_to_retired_inventory() returns trigger
      language plpgsql as $$ begin return new; end $$
    `, /policy function body differs/i);
    await falsify(admin, clean, "trigger197", `
      drop trigger trg_retired_inventory_spaces on spaces;
      create trigger trg_retired_inventory_spaces after insert or update on spaces
      for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative')
    `, /trg_retired_inventory_spaces relation, timing/i);
    await falsify(admin, clean, "index198", `
      drop index uq_proposed_natural;
      create unique index uq_proposed_natural on proposed_records(activation_id,target_type,natural_key)
      where natural_key is not null
    `, /uq_proposed_natural definition differs/i);

    const hostile196 = await cloneDatabase(admin, sourceDatabase, "hostile196");
    await sql(hostile196, `
      insert into properties(name) values ('Owned migration 196 hostile fixture');
      insert into activations(property_id,source_label) select id,'owned hostile' from properties where name='Owned migration 196 hostile fixture';
      insert into proposed_records(activation_id,property_id,target_type,natural_key)
        select a.id,a.property_id,'inventory_identity','hostile-identity' from activations a where a.source_label='owned hostile'
    `);
    refuses("preflight refuses an incompatible pre-196 identity row", wrapper(hostile196, ["--apply"]), /incompatible pre-196 inventory_identity/i);
    ok("hostile 196 preflight leaves exact 194", (await ceiling(hostile196)).ceiling === 194);

    console.log(`\n  ${passed} passed, 0 failed`);
  } finally {
    for (const database of [...owned].reverse()) {
      await admin.query(`drop database if exists ${quoteIdentifier(database)} with (force)`);
    }
    await admin.end();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
