#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   bootstrap_schema.js — build a HARNESS database from the migration files.

   CLASS 3 — harness infrastructure. Never runs against production: it
   requires HARNESS_DATABASE_URL and refuses if that resolves to the same
   host/port/database as DATABASE_URL, exactly like every .db.js proof.

   WHY IT EXISTS AND WHY IT TOLERATES FAILURES
   The migration chain cannot rebuild from empty — a known, previously
   documented defect (PR #33). Some early files assume objects a later
   file creates, or reference a state the ledger no longer describes.
   `migrate.js --apply` correctly refuses to continue past a failure,
   which is right for production and useless for building a scratch
   database to prove against.

   So this applies each file in its own transaction and RECORDS what
   failed rather than stopping. That is only honest if the report is
   loud: it prints exactly which files did not apply, and any proof
   written against this database must state that its schema is a
   BOOTSTRAP, not a replica of production.

   It is not a migration runner. It never writes schema_migrations for a
   file that failed, and it is not a substitute for a real release.
   ════════════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
//  ONE refusal, not a second copy of it. `harnessConnectionString()`
//  requires HARNESS_DATABASE_URL *and* refuses when it resolves to the
//  same host/port/database as DATABASE_URL. An earlier version of this
//  file reimplemented that check, which gate_harness_isolation correctly
//  rejected: requiring the variable is not the same as refusing the wrong
//  value, and two implementations of a safety rule means the weaker one
//  is the one somebody eventually calls.
const { harnessConnectionString } = require("../../tests/_run_receipt.js");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

async function main() {
  const url = harnessConnectionString();

  const client = new Client({ connectionString: url });
  await client.connect();

  await client.query(`
    create table if not exists schema_migrations (
      version text primary key, name text not null,
      applied_at timestamptz not null default now())`);
  await client.query("create extension if not exists pgcrypto");

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .filter(f => !f.startsWith("000_"))
    .sort();

  const applied = new Set(
    (await client.query("select version from schema_migrations")).rows.map(r => r.version));

  const ok = [], failed = [];
  for (const file of files) {
    const version = file.slice(0, 3);
    if (applied.has(version)) { ok.push(file); continue; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (version, name) values ($1,$2)",
        [version, file.slice(4, -4)]);
      await client.query("commit");
      ok.push(file);
    } catch (e) {
      await client.query("rollback");
      failed.push({ file, message: String(e.message).split("\n")[0] });
    }
  }

  console.log(`\n  BOOTSTRAP COMPLETE — ${ok.length}/${files.length} applied.`);
  if (failed.length) {
    console.log(`\n  ${failed.length} file(s) did NOT apply. Any proof run against this database`);
    console.log("  is proving against a schema that is missing these:\n");
    for (const f of failed) console.log(`    · ${f.file}\n        ${f.message}`);
  }
  console.log("");
  await client.end();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
