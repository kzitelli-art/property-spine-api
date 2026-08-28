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
         EXPECTED_SHA=<sha of the code being released> node migrate.js --apply

   THE SHA CONTRACT, stated exactly, because it used to be stated loosely:
     · On a Render instance, EXPECTED_SHA is REQUIRED and is compared to
       RENDER_GIT_COMMIT.
     · Anywhere else, it is OPTIONAL — but if you give it, it is CHECKED,
       against this repository's git HEAD, and the release also refuses if
       tracked files are modified, because then the sha is not the code.
     · It further refuses if any migrations/NNN_*.sql file on disk is absent
       from the pinned commit. This runner executes the FILESYSTEM, not the
       commit, so an untracked migration would otherwise be applied under a
       sha that does not contain it. Other untracked files are ignored.
     · Omit it off-Render and nothing is pinned. The release banner says so
       in those words rather than printing a reassuring blank.

   It prints exactly what it did. If a migration fails, that migration's
   transaction is rolled back (nothing half-applied) and the script stops
   so you can fix the file and re-run.

   This script has NO dependencies beyond 'pg', which the API already uses.
   It does shell out to `git` to establish which build it is; a missing git
   is handled as UNKNOWN, never as agreement.
   ════════════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");
const { classifyLedger } = require("./ledger_verdict");
//  SSL is decided by the one module that owns the answer — NOT here. This
//  file hardcoded `ssl: { rejectUnauthorized: false }`, which is correct for
//  Neon and fatal against a local Postgres that does not speak SSL (a fresh
//  docker-compose volume is exactly that). Recorded as CURRENT_STATE defect
//  #28; the fix is the one the header of src/shared/database_ssl.js exists for.
const { databaseSsl } = require("../src/shared/database_ssl");

/*  WHICH BUILD IS THIS, REALLY.
 *
 *  EXPECTED_SHA used to be compared only against RENDER_GIT_COMMIT, so
 *  releasing from anywhere that is not a Render instance — a laptop, a
 *  container, another agent's environment — read the variable, compared it
 *  to nothing, and printed no error. The runbook said "pin the exact code
 *  being released" while the executable gate pinned it only by accident of
 *  where the command ran. A guard that is satisfied by a value it never
 *  checks is worse than no guard, because it launders the gap into evidence.
 *
 *  So: resolve the build's identity from the strongest source available,
 *  and SAY which source it was. A Render instance knows its own commit. A
 *  git checkout knows its HEAD — and also knows whether its tracked files
 *  still match that HEAD, which matters, because a sha over a modified
 *  worktree describes code that is not the code about to run.
 *
 *  MOST untracked files are deliberately ignored: .env, scratch output and
 *  node_modules noise are not the release. Tracked modifications are.
 *
 *  ⚠ BUT "UNTRACKED" AND "NOT PART OF THE RELEASE" ARE NOT THE SAME SET,
 *  AND THE FIRST VERSION OF THIS GUARD ASSUMED THEY WERE.
 *
 *  This runner does not execute a commit. It executes whatever
 *  `migrations/NNN_*.sql` files it finds ON DISK. So an UNTRACKED migration
 *  is both invisible to `--untracked-files=no` and fully executable, which
 *  produced exactly the state the sha pin exists to make impossible:
 *
 *      git HEAD           471f2e0…
 *      EXPECTED_SHA       471f2e0…        → "VERIFIED against git HEAD"
 *      tracked files      clean
 *      untracked          migrations/180_something.sql
 *      applied            180_something.sql — schema NOT in that commit
 *
 *  The fix is not to ban untracked files; that would strand a release on a
 *  stray screenshot. It is to scope the check to files that can PARTICIPATE
 *  in a release. Every migration-shaped file in this directory must be
 *  present in the pinned commit, and the set is discovered with the SAME
 *  predicate the runner executes with — one implementation, so the guard
 *  cannot drift into scanning less than it asserts.
 */
//  The shape of a migration file. One definition: the guard scans exactly
//  the file class the runner runs.
const MIGRATION_FILE_RE = /^\d{3}_.*\.sql$/;

function resolveBuildIdentity() {
  const render = (process.env.RENDER_GIT_COMMIT || "").trim();
  if (render) {
    //  A Render instance's tree IS a checkout the platform made from that
    //  commit; there is no working copy for anyone to drop a file into, and
    //  no git to ask. Stated rather than silently skipped.
    return { sha: render, source: "RENDER_GIT_COMMIT", modified: null, unpinnedMigrations: null };
  }

  const repo = path.join(__dirname, "..");
  const git = (args, cwd) => execFileSync("git", args,
    { cwd: cwd || repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const sha = git(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { sha: null, source: null, modified: null, unpinnedMigrations: null };
    }
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]);

    //  Which migration files does the PINNED COMMIT contain? Non-recursive,
    //  so a tracked `sub/180_x.sql` cannot vouch for an untracked
    //  `180_x.sql` sitting beside the runner.
    const inCommit = new Set(
      git(["ls-tree", "--name-only", "HEAD", "."], MIGRATIONS_DIR)
        .split("\n").map((l) => path.basename(l.trim())).filter(Boolean));

    //  And which does the runner actually see on disk? Same predicate.
    const onDisk = fs.readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_FILE_RE.test(f)).sort();

    return {
      sha, source: "git HEAD",
      modified: dirty ? dirty.split("\n") : [],
      unpinnedMigrations: onDisk.filter((f) => !inCommit.has(f)),
    };
  } catch {
    //  No git, no repository, or a git that refused. Unknown is a valid
    //  answer here and is handled by the caller as unknown — never as OK.
    return { sha: null, source: null, modified: null, unpinnedMigrations: null };
  }
}

//  A pin short enough to match anything is not a pin. `EXPECTED_SHA=3`
//  prefix-matches roughly one commit in sixteen.
const MIN_PIN = 7;

/*  How long a migration may WAIT to acquire a lock before giving up.
 *  Raise it deliberately for a planned maintenance window
 *  (MIGRATION_LOCK_TIMEOUT='60s'); never raise it to make a hanging
 *  deploy "work". A migration that cannot get its lock in ten seconds is
 *  competing with live traffic, and that is a scheduling decision, not a
 *  timeout to widen. */
//  Validated, not merely sanitised. A stripped-to-empty or malformed value
//  would produce `set local lock_timeout = ''`, which errors mid-migration
//  and would read as a broken migration rather than a bad setting.
const LOCK_TIMEOUT = (() => {
  const raw = (process.env.MIGRATION_LOCK_TIMEOUT || "").trim();
  if (!raw) return "10s";
  if (/^\d+(ms|s|min)?$/i.test(raw)) return raw.toLowerCase();
  console.error(`\n  ✗ MIGRATION_LOCK_TIMEOUT is malformed: ${JSON.stringify(raw)}`);
  console.error("    Use a PostgreSQL interval like '10s', '500ms' or '2min'.\n");
  process.exit(1);
})();

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

  const client = new Client({ connectionString: url, ssl: databaseSsl(url) });
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
  //  MIGRATION_FILE_RE is shared with resolveBuildIdentity() on purpose. The
  //  release guard must scan the same file class this loop executes, or it
  //  asserts over a set the runner does not use.
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => MIGRATION_FILE_RE.test(f))
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
  const build = resolveBuildIdentity();
  const expectedSha = (process.env.EXPECTED_SHA || "").trim();

  //  A Render deploy must be pinned. Unchanged rule, unchanged wording.
  if (build.source === "RENDER_GIT_COMMIT" && !expectedSha) {
    console.error("\n  ✗ RELEASE REFUSED — EXPECTED_SHA is required when releasing a deployed build.\n");
    console.error(`    This instance is running ${build.sha.slice(0, 12)}. Pin it deliberately.\n`);
    await client.end();
    process.exit(1);
  }

  //  And wherever it IS pinned, the pin is checked — that is the whole
  //  point of the variable, and it used to be true only on Render.
  if (expectedSha) {
    if (expectedSha.length < MIN_PIN || !/^[0-9a-f]+$/i.test(expectedSha)) {
      console.error("\n  ✗ RELEASE REFUSED — EXPECTED_SHA is not a usable pin.\n");
      console.error(`    got ${JSON.stringify(expectedSha)} — need at least ${MIN_PIN} hex characters.`);
      console.error("    A short prefix matches many commits, so it pins nothing.\n");
      await client.end();
      process.exit(1);
    }
    if (!build.sha) {
      console.error("\n  ✗ RELEASE REFUSED — EXPECTED_SHA was given and CANNOT be verified here.\n");
      console.error("    Neither RENDER_GIT_COMMIT nor a git HEAD could be resolved, so there");
      console.error("    is nothing to compare your pin against. Accepting it would report a");
      console.error("    verified release that was never verified.");
      console.error("\n    Release from the git checkout of the code being released, or set");
      console.error("    RENDER_GIT_COMMIT to the sha this build actually is.\n");
      await client.end();
      process.exit(1);
    }
    if (!build.sha.startsWith(expectedSha) && !expectedSha.startsWith(build.sha)) {
      console.error("\n  ✗ RELEASE REFUSED — this is not the build you authorised.\n");
      console.error(`    expected ${expectedSha}`);
      console.error(`    running  ${build.sha}   (from ${build.source})\n`);
      await client.end();
      process.exit(1);
    }
    //  The sha matched, and the files no longer match the sha.
    if (build.modified && build.modified.length) {
      console.error("\n  ✗ RELEASE REFUSED — the pinned sha does not describe this working tree.\n");
      console.error(`    ${build.sha.slice(0, 12)} matches your pin, but ${build.modified.length} tracked file(s)`);
      console.error("    are modified, so the code about to migrate is not the code you pinned:");
      for (const line of build.modified.slice(0, 12)) console.error(`      · ${line}`);
      if (build.modified.length > 12) console.error(`      … and ${build.modified.length - 12} more`);
      console.error("\n    Commit or stash them, then re-read the ledger and release again.\n");
      await client.end();
      process.exit(1);
    }
    //  THE PIN IS ONLY TRUE IF IT COVERS EVERY FILE THIS RUNNER CAN EXECUTE.
    //  An untracked migration passes the tracked-file check above and is
    //  still discovered and applied by the loop below, so a "VERIFIED"
    //  release would execute schema the pinned commit does not contain.
    if (build.unpinnedMigrations && build.unpinnedMigrations.length) {
      console.error("\n  ✗ RELEASE REFUSED — a migration on disk is NOT in the pinned commit.\n");
      console.error(`    ${build.sha.slice(0, 12)} matches your pin, and this runner executes migration`);
      console.error("    files from the FILESYSTEM, not from the commit. These are present here");
      console.error("    and absent from that commit, so the pin would not describe them:");
      for (const f of build.unpinnedMigrations) console.error(`      · migrations/${f}`);
      console.error("\n    Commit them and re-pin, or move them out of migrations/. A release");
      console.error("    that prints VERIFIED must have verified everything it is about to run.\n");
      await client.end();
      process.exit(1);
    }
  }

  console.log("\n  ── MIGRATION RELEASE ──────────────────────────────────");
  console.log(`     ledger ceiling (verified): ${ceiling}`);
  //  Say what was actually established. "(not a Render deploy)" told the
  //  releaser nothing about whether their pin had been checked.
  console.log(`     build:                     ${build.sha ? build.sha.slice(0, 12) : "UNKNOWN"}` +
    `${build.source ? `  (${build.source})` : ""}`);
  //  Say what VERIFIED covers. On a git checkout it covers the tracked tree
  //  AND every migration file on disk; on Render there is no working copy to
  //  check, and that difference is printed rather than implied.
  console.log(`     sha pin:                   ${expectedSha
    ? `VERIFIED against ${build.source}${build.unpinnedMigrations
      ? " — tree clean, all migrations in the commit"
      : " — no working copy to check"}`
    : "NOT PINNED — EXPECTED_SHA was not set, so no build was authorised"}`);
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
      //  ── FAIL FAST ON LOCK CONTENTION ────────────────────────────────
      //  This runs from `prestart`, which on Render means EVERY DEPLOY —
      //  while the OLD instance is still serving live write traffic. A
      //  migration that takes a lock the live traffic holds would, with no
      //  timeout, wait forever: the deploy hangs, and because PostgreSQL
      //  queues lock waiters, every writer that arrives behind it stalls
      //  too. One slow migration becomes an outage.
      //
      //  Measured, not hypothetical: migration 137 creates foreign keys
      //  referencing work_orders, which needs SHARE ROW EXCLUSIVE and
      //  conflicts with an ordinary INSERT.
      //
      //  lock_timeout bounds only ACQUISITION, never execution — a long
      //  migration that already holds its locks is unaffected. Timing out
      //  fails THIS DEPLOY and leaves the previous instance serving, which
      //  is the correct failure: a refused deploy, not a stalled database.
      //
      //  Deliberately NOT retried. Retrying into active write traffic is
      //  how a fail-fast guard becomes a slow-motion outage; the operator
      //  re-runs it in a quiet window, on purpose.
      await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
      await client.query(sql);
      //  Some migrations self-record their ledger row (083/084 do, with
      //  "on conflict do nothing so both paths are safe" in their own
      //  words). The runner is the other path — and it was not safe: on a
      //  FRESH sequential build (the docker-compose local volume is the
      //  first thing to ever run 001→187 through this runner) the file's
      //  own insert collides with this one and the whole migration rolls
      //  back. Defer to a row the file already recorded; the file's own
      //  name normalizes to the same label the next verify expects.
      const recorded = await client.query(
        `insert into schema_migrations (version, name) values ($1, $2)
         on conflict (version) do nothing`,
        [version, name]
      );
      if (recorded.rowCount === 0) {
        console.log(`    ! ledger row ${version} was self-recorded by the file itself; kept the file's own name.`);
      }
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
