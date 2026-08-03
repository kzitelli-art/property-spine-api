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

  // 2. Which migrations are already applied? Keep the NAME too — the guard
  //    below needs to know not just that a number was used, but by what.
  const { rows } = await client.query("select version, name from schema_migrations");
  const applied = new Map(rows.map(r => [r.version, r.name]));

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

  // ── NUMBER ALREADY CLAIMED IN THE LEDGER = HARD STOP ─────────────────
  //  The guard above catches two files in THIS folder sharing a number. It
  //  cannot catch the other half of the same failure: a brand-new file
  //  taking a number the LEDGER already spent on something else.
  //
  //  That is not hypothetical. On 2026-07-26 the live ledger recorded
  //  098 = work_order_operational_facts, applied from a parallel thread,
  //  while a different 098_work_order_people.sql was being written here.
  //  Committing it would have printed "already applied, skipping" and its
  //  table would never have existed. Same silent skip, opposite direction.
  //
  //  So the ledger name and the file name must agree. If they disagree,
  //  one of exactly two things is true, and both need a human:
  //    · a NEW file took a spent number  -> renumber it to the next free slot
  //    · an APPLIED file was RENAMED     -> rename it back
  //  Renaming a migration that has already run is not a cosmetic act; the
  //  ledger is how the system remembers what it did.
  //
  //  NORMALISED before comparing, because some historical rows were
  //  recorded by hand or from a file a browser had already renamed:
  //    062/063/064  ledger says 'pricing_authority (1)'  — a Windows
  //                 download duplicate; same migration, sloppier filename
  //    083/084      ledger says '084_application_intent_prepare_send.sql'
  //                 — the whole filename, not the stripped label
  //  Those are the SAME migration under a messier name, so normalising is
  //  telling the truth, not waving something through. A genuinely different
  //  migration still trips the guard.
  const norm = (s) => String(s || "")
    .replace(/\.sql$/i, "")        // full filename was recorded
    .replace(/^\d{3}_/, "")        //   ...prefix and all
    .replace(/\s*\(\d+\)$/, "")    // 'name (1)' — a duplicated download
    .trim().toLowerCase();

  const stolen = [];
  for (const f of files) {
    const v = f.slice(0, 3), name = f.slice(4, -4);
    if (applied.has(v) && norm(applied.get(v)) !== norm(name)) {
      // ── ONE DOCUMENTED EXCEPTION, verified 2026-07-26 ────────────────
      //  Ledger 012 = 'property_noi_goals'; the folder's 012 is
      //  'bank_intake'. property_noi_goals was renumbered to 029 and the
      //  012 row was never corrected. bank_intake DID run — checked
      //  against live: vendors 51 rows, vendor_aliases 121, bank_accounts
      //  2, bank_transactions 160, check_register_orphans 4. Nothing is
      //  missing, so blocking every deploy over a stale label would be the
      //  guard lying about a problem instead of the ledger lying about a
      //  name. Remove this once the 012 row is corrected to 'bank_intake'.
      if (v === "012" && norm(applied.get(v)) === "property_noi_goals") {
        console.log(`  ! ${f} — ledger 012 is mislabelled 'property_noi_goals' (known, verified applied).`);
        continue;
      }
      stolen.push([v, applied.get(v), name, f]);
    }
  }
  if (stolen.length) {
    console.error("\n  ✗ MIGRATION NUMBER ALREADY SPENT — refusing to run.\n");
    for (const [v, ledgerName, fileName, f] of stolen) {
      console.error(`      ${v}  the ledger says: ${ledgerName}  (already applied)`);
      console.error(`      ${v}  this folder has: ${fileName}`);
      console.error(`           -> ${f} would print "already applied" and NEVER RUN.\n`);
    }
    console.error("    If this is a new migration, renumber it to the next free slot.");
    console.error("    If you renamed a migration that already ran, rename it back.");
    console.error("    Nothing was applied.\n");
    await client.end();
    process.exit(1);
  }

  // ════════════════════════════════════════════════════════════════════
  //  VERIFY BY DEFAULT. APPLYING IS AN EXPLICIT, GOVERNED RELEASE.
  //
  //  This script used to APPLY on every run, and `prestart` runs it on every
  //  deploy against the service's own DATABASE_URL. On the production service
  //  that meant DEPLOYING A BRANCH TO TEST IT AND MIGRATING PRODUCTION WERE THE
  //  SAME OPERATION, with no confirmation and no distinction between them.
  //
  //  It happened at least twice. Migration 121 exists only on an unmerged
  //  branch yet is applied in production — it got there when that branch was
  //  deployed for testing. Migration 126 went the same way. Both were recorded
  //  as curiosities before anyone connected them to the mechanism.
  //
  //  The fix is NOT to skip migrations and boot anyway: that trades a silent
  //  schema CHANGE for a silent schema MISMATCH, and starts code against a
  //  database it does not understand. So:
  //
  //    default  → VERIFY. Every file must already be in the ledger. If any is
  //               pending, REFUSE TO START and name it. Nothing is applied and
  //               nothing boots against an unknown schema.
  //    --apply  → RELEASE. Requires the operator to prove they read the ledger
  //               first, and to pin the code being released.
  //
  //  A feature-branch deploy therefore cannot migrate production, and cannot
  //  quietly run against a schema that does not match its code either.
  // ════════════════════════════════════════════════════════════════════
  const APPLY = process.argv.includes("--apply") || process.env.MIGRATION_RELEASE === "1";
  const pending = files.filter((f) => !applied.has(f.slice(0, 3)));
  const ceiling = [...applied.keys()].sort().pop() || "000";

  if (!APPLY) {
    if (pending.length === 0) {
      console.log(`\n  ✓ SCHEMA VERIFIED — ${files.length} migrations, all applied. Ledger ceiling ${ceiling}.`);
      console.log("    (verify-only; applying requires an explicit release)\n");
      await client.end();
      return;
    }
    console.error("\n  ✗ REFUSING TO START — the schema does not match this code.\n");
    console.error(`    ${pending.length} migration(s) in this build are NOT applied to the target database:`);
    for (const f of pending) console.error(`      · ${f}`);
    console.error(`\n    Ledger ceiling is ${ceiling}. This code expects those migrations to exist.`);
    console.error("    Starting anyway would run new code against an older schema, so it stops here.");
    console.error("\n    A deploy does not migrate. Releasing schema is a separate, deliberate act:");
    console.error(`      MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=${ceiling} \\`);
    console.error("        [EXPECTED_SHA=<sha>] node migrations/migrate.js --apply");
    console.error("\n    Nothing was applied.\n");
    await client.end();
    process.exit(1);
  }

  // ── RELEASE MODE — prove the operator looked before they leapt ──────
  const expectedCeiling = process.env.EXPECTED_LEDGER_CEILING;
  if (!expectedCeiling) {
    console.error("\n  ✗ RELEASE REFUSED — EXPECTED_LEDGER_CEILING is required.\n");
    console.error(`    Read the ledger first, then state what you expect to find. It is ${ceiling}.`);
    console.error("    This exists so a release cannot be run by someone who has not looked.\n");
    await client.end();
    process.exit(1);
  }
  if (String(expectedCeiling) !== String(ceiling)) {
    console.error("\n  ✗ RELEASE REFUSED — the ledger is not in the expected state.\n");
    console.error(`    You expected ceiling ${expectedCeiling}; the database says ${ceiling}.`);
    console.error("    Something applied migrations since you looked. Re-inspect before releasing.\n");
    await client.end();
    process.exit(1);
  }
  const deployedSha = process.env.RENDER_GIT_COMMIT;
  if (deployedSha) {
    const expectedSha = process.env.EXPECTED_SHA;
    if (!expectedSha) {
      console.error("\n  ✗ RELEASE REFUSED — EXPECTED_SHA is required when releasing a deployed build.\n");
      console.error(`    This instance is running ${deployedSha.slice(0, 12)}. Pin it deliberately.\n`);
      await client.end();
      process.exit(1);
    }
    if (!deployedSha.startsWith(expectedSha) && !expectedSha.startsWith(deployedSha)) {
      console.error("\n  ✗ RELEASE REFUSED — this is not the build you authorised.\n");
      console.error(`    expected ${expectedSha}`);
      console.error(`    running  ${deployedSha}\n`);
      await client.end();
      process.exit(1);
    }
  }
  console.log("\n  ── MIGRATION RELEASE ──────────────────────────────────");
  console.log(`     ledger ceiling (verified): ${ceiling}`);
  console.log(`     build:                     ${deployedSha ? deployedSha.slice(0, 12) : "(not a Render deploy)"}`);
  console.log(`     to apply:                  ${pending.length ? pending.join(", ") : "nothing pending"}`);
  console.log("  ───────────────────────────────────────────────────────\n");

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
