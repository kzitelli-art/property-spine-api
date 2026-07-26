#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   migrate.js — the apply script.

   WHAT IT DOES (in plain terms):
   1. Connects to whatever database DATABASE_URL points at.
   2. Makes sure the schema_migrations ledger table exists.
   3. Looks in this folder for files named like 001_something.sql,
      002_something.sql, and so on — in numeric order.
   4. For each one NOT already recorded in the ledger, it runs the whole
      file inside a transaction, then records it as applied.
   5. Files already in the ledger are skipped. So running this twice is
      safe — it never re-runs a migration.

   HOW TO RUN IT:
     Against production (be careful):
       DATABASE_URL="<your neon connection string>" node migrate.js
     Against the test database (the normal case):
       DATABASE_URL="$TEST_DATABASE_URL" node migrate.js

   It prints exactly what it did. If a migration fails, that migration's
   transaction is rolled back (nothing half-applied) and the script stops
   so you can fix the file and re-run.

   This script has NO dependencies beyond 'pg', which the API already uses.
   ════════════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const MIGRATIONS_DIR = __dirname;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\n  ✗ DATABASE_URL is not set.");
    console.error("    Run like:  DATABASE_URL=\"<connection string>\" node migrate.js\n");
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("\n  Connected to the database.");

  // 1. Ensure the ledger exists (idempotent).
  await client.query(`
    create table if not exists schema_migrations (
      version     text primary key,
      name        text not null,
      applied_at  timestamptz not null default now()
    );
  `);

  // 2. Which migrations are already applied?
  const { rows } = await client.query("select version from schema_migrations");
  const applied = new Set(rows.map(r => r.version));

  // 3. Find migration files: NNN_label.sql, numerically ordered.
  //    The ledger file (000_schema_migrations.sql) is skipped — the ledger
  //    is created above, not as a tracked migration.
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .filter(f => !f.startsWith("000_"))
    .sort();

  if (files.length === 0) {
    console.log("  No migration files found. Nothing to do.\n");
    await client.end();
    return;
  }

  // ── DUPLICATE PREFIX = HARD STOP ─────────────────────────────────────
  //  The ledger is keyed on the three-digit prefix alone, so two files
  //  sharing a number means the second one is silently skipped FOREVER —
  //  it prints "already applied" and moves on, and its tables never exist.
  //
  //  That happened on 2026-07-26: two 094s were merged from parallel
  //  threads, and a live feature shipped expecting tables the deploy had
  //  quietly declined to create. Nothing failed. Nothing warned.
  //
  //  A migration that never runs and never complains is the worst failure
  //  shape available, so this refuses to run at all until it is resolved.
  //  Stopping the whole deploy is the point: half-applied schema on a
  //  system with no staging is not a thing to be clever about.
  const seen = new Map();
  const clashes = [];
  for (const f of files) {
    const v = f.slice(0, 3);
    if (seen.has(v)) clashes.push([v, seen.get(v), f]);
    else seen.set(v, f);
  }
  if (clashes.length) {
    console.error("\n  ✗ DUPLICATE MIGRATION NUMBER(S) — refusing to run.\n");
    for (const [v, a, b] of clashes) {
      console.error(`      ${v}  ${a}`);
      console.error(`      ${v}  ${b}   <-- this one would be SILENTLY SKIPPED`);
    }
    console.error("\n    The ledger is keyed on the number alone, so the second file");
    console.error("    would never run and never say so. Renumber it to the next free");
    console.error("    slot and deploy again. Nothing was applied.\n");
    await client.end();
    process.exit(1);
  }

  let ranAny = false;
  for (const file of files) {
    const version = file.slice(0, 3);            // '001'
    const name = file.slice(4, -4);              // 'baseline'
    if (applied.has(version)) {
      console.log(`  • ${file}  — already applied, skipping.`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    console.log(`  → ${file}  — applying...`);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into schema_migrations (version, name) values ($1, $2)",
        [version, name]
      );
      await client.query("commit");
      console.log(`    ✓ applied and recorded.`);
      ranAny = true;
    } catch (err) {
      await client.query("rollback");
      console.error(`    ✗ FAILED — rolled back. Nothing from this file was applied.`);
      console.error(`      ${err.message}`);
      console.error(`\n  Stopped. Fix ${file} and run again.\n`);
      await client.end();
      process.exit(1);
    }
  }

  if (!ranAny) console.log("\n  Everything was already up to date.");
  console.log("\n  Done.\n");
  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
