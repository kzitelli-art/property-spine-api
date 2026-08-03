#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   migrate.js — the apply script.

   WHAT IT DOES (in plain terms):
   1. Connects to whatever database DATABASE_URL points at.
   2. Reads the schema_migrations ledger and this folder's .sql files, and
      checks that they describe the same database IN BOTH DIRECTIONS:
        · every file here must be recorded in the ledger, and
        · every ledger version must still have its file here.
   3. By DEFAULT it stops there. It verifies and applies nothing — running
      it is not a migration. If anything disagrees it REFUSES TO START and
      names what, rather than booting against a schema it does not match.
   4. With --apply (a deliberate release) it runs each unapplied file in a
      transaction and records it. That path, and only that path, writes.

   HOW TO RUN IT:
     Verify a database (safe; works on a read-only connection):
       DATABASE_URL="<connection string>" node migrate.js
     Release schema — deliberate, and it will make you prove you looked:
       MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<what the ledger says> \
         [EXPECTED_SHA=<sha>] node migrate.js --apply

   It prints exactly what it did. If a migration fails, that migration's
   transaction is rolled back (nothing half-applied) and the script stops
   so you can fix the file and re-run.

   This script has NO dependencies beyond 'pg', which the API already uses.
   ════════════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { classifyLedger } = require("./ledger_verdict");

const MIGRATIONS_DIR = __dirname;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\n  ✗ DATABASE_URL is not set.");
    console.error("    Run like:  DATABASE_URL=\"<connection string>\" node migrate.js\n");
    process.exit(1);
  }

  //  Decided before we open the connection, because it decides whether this
  //  run is allowed to write to the database at all.
  const APPLY = process.argv.includes("--apply") || process.env.MIGRATION_RELEASE === "1";

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`\n  Connected to the database.  (${APPLY ? "RELEASE" : "verify-only"})`);

  // 1. Ensure the ledger exists — ONLY when releasing.
  //
  //    This used to run unconditionally, which quietly made the verify path
  //    a WRITING path: `create table if not exists` is DDL, and Postgres
  //    checks write permission BEFORE it checks existence. Confirmed on 16.13
  //    — inside `begin transaction read only` it fails with "cannot execute
  //    CREATE TABLE in a read-only transaction" even though the table is
  //    already there, and as a SELECT-only role it fails with "permission
  //    denied for schema public".
  //
  //    So a verify could not be run against a read-only connection, which is
  //    the one way to check production's schema with no possibility of
  //    changing it. Verification now reads and nothing else.
  if (APPLY) {
    await client.query(`
      create table if not exists schema_migrations (
        version     text primary key,
        name        text not null,
        applied_at  timestamptz not null default now()
      );
    `);
  }

  // 2. Which migrations are already applied? Keep the NAME too — the guards
  //    below need to know not just that a number was used, but by what.
  //
  //    In verify mode the ledger may legitimately not exist yet (a fresh
  //    database). That is its own answer, and a different one from "no
  //    migrations are applied" — so it is named rather than papered over by
  //    creating an empty ledger and reporting 127 pending files.
  let rows;
  try {
    ({ rows } = await client.query("select version, name from schema_migrations"));
  } catch (err) {
    if (err && err.code === "42P01") {   // undefined_table
      console.error("\n  ✗ NO MIGRATION LEDGER — refusing to start.\n");
      console.error("    This database has no schema_migrations table, so there is no record");
      console.error("    of what has been applied to it. This code cannot know what it is");
      console.error("    running against.");
      console.error("\n    If this database is meant to be built from scratch, that is a release:");
      console.error("      MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=000 node migrations/migrate.js --apply");
      console.error("\n    Nothing was applied.\n");
      await client.end();
      process.exit(1);
    }
    throw err;
  }
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
  //  The decision itself lives in ./ledger_verdict.js so it can be exercised
  //  directly, as the same code this deploy runs. Everything from here down
  //  is reporting and exiting.
  const verdict = classifyLedger({
    files,
    ledgerRows: [...applied].map(([version, name]) => ({ version, name })),
  });

  if (verdict.duplicateFileNumbers.length) {
    console.error("\n  ✗ DUPLICATE MIGRATION NUMBER(S) — refusing to run.\n");
    for (const { version, first, second } of verdict.duplicateFileNumbers) {
      console.error(`      ${version}  ${first}`);
      console.error(`      ${version}  ${second}   <-- this one would be SILENTLY SKIPPED`);
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
  //  Documented legacy naming exceptions are announced, never silent. A
  //  forgiven mismatch the operator cannot see is indistinguishable from a
  //  guard that is not running.
  for (const e of verdict.acceptedLegacyNames) {
    console.log(`  ! ${e.file} — ledger ${e.version} is mislabelled '${e.ledgerName}' (known, verified applied).`);
    console.log(`      accepted because: ${e.reason}`);
    console.log(`      stops being accepted when: ${e.removeWhen}`);
  }

  if (verdict.versionNameConflicts.length) {
    console.error("\n  ✗ MIGRATION NUMBER ALREADY SPENT — refusing to run.\n");
    for (const { version, ledgerName, fileLabel, file } of verdict.versionNameConflicts) {
      console.error(`      ${version}  the ledger says: ${ledgerName}  (already applied)`);
      console.error(`      ${version}  this folder has: ${fileLabel}`);
      console.error(`           -> ${file} would print "already applied" and NEVER RUN.\n`);
    }
    console.error("    If this is a new migration, renumber it to the next free slot.");
    console.error("    If you renamed a migration that already ran, rename it back.");
    console.error("    Nothing was applied.\n");
    await client.end();
    process.exit(1);
  }

  // ── A LEDGER VERSION THIS REPOSITORY CANNOT ACCOUNT FOR = HARD STOP ──
  //  The inverse of every check above. Those all ask whether a file in this
  //  folder is safe to run. This one asks the question nothing asked before
  //  2026-08-03: does the database contain a migration THIS REPOSITORY HAS
  //  NO FILE FOR?
  //
  //  It is not a runtime hazard the way a pending migration is — the schema
  //  is a superset of what this code expects, so the service would run. It
  //  is a TRUTH hazard, and a worse-shaped one:
  //
  //    · the schema cannot be rebuilt, because part of it exists in no file;
  //    · that part was never reviewed, because it is in no diff;
  //    · a contributor reading `ls migrations/` sees a free number that the
  //      ledger has already spent, and the collision guard above cannot warn
  //      them, because it only compares numbers to FILES.
  //
  //  This is precisely what "the migration GAP at 121" was: a migration
  //  applied in production whose file lived only on an unmerged branch. It
  //  sat in the handoff as a curiosity for weeks, and it was the visible
  //  symptom of a deploy silently migrating production — the failure ITEM 5
  //  now prevents at the source. This closes the reporting side of it: the
  //  same condition can never again be present without the deploy saying so.
  //
  //  Documented historical exceptions live in ledger_verdict.js, pinned to
  //  both version and ledger name, one entry per accepted orphan.
  for (const e of verdict.acceptedLedgerOnly) {
    console.log(`  ! ledger ${e.version} '${e.ledgerName}' has no file here (documented historical exception).`);
    console.log(`      accepted because: ${e.reason}`);
    console.log(`      stops being accepted when: ${e.removeWhen}`);
  }

  if (verdict.ledgerVersionMissingFromRepo.length) {
    console.error("\n  ✗ LEDGER VERSION MISSING FROM THIS REPOSITORY — refusing to start.\n");
    console.error(`    ${verdict.ledgerVersionMissingFromRepo.length} migration(s) are recorded as applied to this`);
    console.error("    database, but this build carries no file for them:\n");
    for (const { version, ledgerName } of verdict.ledgerVersionMissingFromRepo) {
      console.error(`      ${version}  the ledger says: ${ledgerName}`);
      console.error(`           -> migrations/${version}_*.sql does not exist in this build.\n`);
    }
    console.error("    The database contains changes this codebase cannot describe, so the");
    console.error("    schema cannot be rebuilt or reviewed, and the number is spent without");
    console.error("    being visible to anyone allocating the next one.");
    console.error("\n    Resolve it, do not silence it:");
    console.error("      · the file exists on an unmerged branch  -> merge it, as 121 was;");
    console.error("      · the migration was applied by hand      -> commit the file it ran;");
    console.error("      · it is genuinely historical             -> add a documented entry to");
    console.error("        DOCUMENTED_LEDGER_ONLY in migrations/ledger_verdict.js, naming the");
    console.error("        reason and what removes it.");
    console.error("\n    Nothing was applied.\n");
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
  //  APPLY was decided before the connection opened. `pending` and `ceiling`
  //  come from the same verdict as every gate above, so there is one reading
  //  of the ledger and not two.
  const pending = verdict.fileMissingFromLedger;
  const ceiling = verdict.ceiling;

  if (!APPLY) {
    if (pending.length === 0) {
      console.log(`\n  ✓ SCHEMA VERIFIED — ${files.length} migrations, all applied. Ledger ceiling ${ceiling}.`);
      console.log("    (verify-only; applying requires an explicit release)");
      console.log("    (both directions checked: every file is in the ledger, and every");
      console.log("     ledger version has its file)\n");
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
