#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   ledger_reconcile.js — READ-ONLY full-ledger reconciliation.

   Compares the ENTIRE production ledger against this repository's
   migrations/ directory and reports all four conditions in one pass:

     · a repository file missing from the ledger
     · a ledger row missing from the repository
     · a genuine version/name conflict
     · a documented historical naming exception

   WHY THIS EXISTS RATHER THAN A HAND-WRITTEN QUERY. The obvious way to
   check is to paste a 128-element `where version not in (...)` list into a
   SQL console. That is a second implementation of the comparison the deploy
   gate makes, typed by hand, at the moment it matters most — and a typo in
   it produces a false clean. This tool imports classifyLedger from
   migrations/ledger_verdict.js: THE SAME MODULE migrate.js runs at boot.
   It cannot disagree with what the deploy will decide, because it is not a
   different reading of the rule.

   WHY IT IS NOT JUST `node migrations/migrate.js`. That IS the authority and
   it evaluates the same things — but it exits at the FIRST failing
   condition, because its job is to stop a bad boot. This one is an audit
   instrument: it reports every category, including the ones that are clean,
   so a receipt can state what was checked rather than only what failed.
   When they disagree, migrate.js wins; they share the decision module
   precisely so they cannot.

   STRUCTURALLY READ-ONLY, in the pattern of
   tests/prod_smoke_missed_readonly.js: everything runs inside
   `begin transaction read only`, and it PROVES it cannot write before it
   reads anything. That is why this may point at DATABASE_URL.

   USAGE
     DATABASE_URL="<connection string>" node tools/ledger_reconcile.js

   EXIT
     0  reconciled — no orphan rows, no conflicts, no duplicate numbers.
        Pending files are reported but do NOT fail: a migration awaiting a
        deliberate release is the normal pre-release state.
     1  NOT reconciled — at least one blocking condition. Details printed.
     2  could not run.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { classifyLedger } = require("../migrations/ledger_verdict");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\n  ✗ DATABASE_URL is not set.\n");
    process.exit(2);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_"))
    .sort();

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  LEDGER RECONCILIATION — read-only, whole ledger");
  try {
    const who = await client.query("select current_database() as db, current_user as usr");
    console.log(`  DATABASE  ${who.rows[0].db}  (user ${who.rows[0].usr})`);
  } catch { /* identity is a courtesy, not the proof */ }
  console.log(`  REPO      ${files.length} migration files`);

  // ── PROVE READ-ONLY BEFORE READING ANYTHING ───────────────────────
  await client.query("begin transaction read only");
  //  THE PROBE MUST NOT POISON THE TRANSACTION. A failed statement aborts the
  //  whole transaction block, so every read after it dies with "current
  //  transaction is aborted". That is verbatim the documented incident — a
  //  read-only smoke whose own safety probe aborted its own transaction and
  //  then reported nothing. The savepoint is what makes the probe survivable.
  let writable = false;
  await client.query("savepoint write_probe");
  try {
    await client.query("create temporary table __reconcile_write_probe (x int)");
    writable = true;
  } catch { /* expected */ }
  await client.query("rollback to savepoint write_probe");
  if (writable) {
    console.error("\n  ✗ REFUSED — this transaction accepted a write.");
    console.error("    A read-only tool that can write is not read-only. Nothing was read.\n");
    await client.query("rollback").catch(() => {});
    await client.end();
    process.exit(2);
  }
  console.log("  READ-ONLY proven — a write was attempted and refused before any read.");
  console.log("════════════════════════════════════════════════════════════════\n");

  let rows;
  try {
    ({ rows } = await client.query("select version, name from schema_migrations order by version"));
  } catch (err) {
    if (err && err.code === "42P01") {
      console.error("  ✗ This database has no schema_migrations table — nothing to reconcile.\n");
      await client.query("rollback").catch(() => {});
      await client.end();
      process.exit(2);
    }
    throw err;
  }

  const v = classifyLedger({ files, ledgerRows: rows });

  console.log(`  ledger rows                        ${rows.length}`);
  console.log(`  applied ceiling                    ${v.ceiling}`);
  console.log(`  repository ceiling                 ${files.length ? files[files.length - 1].slice(0, 3) : "(none)"}\n`);

  const line = (label, n, blocking) =>
    console.log(`  ${n === 0 ? "✓" : (blocking ? "✗" : "•")}  ${label.padEnd(46)} ${n}`);

  line("repository files missing from the ledger", v.fileMissingFromLedger.length, false);
  line("ledger rows missing from the repository", v.ledgerVersionMissingFromRepo.length, true);
  line("genuine version/name conflicts", v.versionNameConflicts.length, true);
  line("duplicate migration numbers in repo", v.duplicateFileNumbers.length, true);
  line("documented legacy naming exceptions", v.acceptedLegacyNames.length, false);
  line("documented ledger-only exceptions", v.acceptedLedgerOnly.length, false);
  console.log("");

  if (v.fileMissingFromLedger.length) {
    console.log("  ── pending: in this build, not yet applied ──");
    console.log("     (expected before a deliberate release; NOT a reconciliation failure)");
    for (const f of v.fileMissingFromLedger) console.log(`     · ${f}`);
    console.log("");
  }

  if (v.acceptedLegacyNames.length) {
    console.log("  ── documented legacy naming exceptions ──");
    for (const e of v.acceptedLegacyNames) {
      console.log(`     ${e.version}  ledger '${e.ledgerName}'  vs file '${e.file}'`);
      console.log(`        accepted because: ${e.reason}`);
      console.log(`        removed when:     ${e.removeWhen}`);
    }
    console.log("");
  }

  if (v.acceptedLedgerOnly.length) {
    console.log("  ── documented ledger-only exceptions ──");
    for (const e of v.acceptedLedgerOnly) {
      console.log(`     ${e.version}  '${e.ledgerName}'`);
      console.log(`        accepted because: ${e.reason}`);
      console.log(`        removed when:     ${e.removeWhen}`);
    }
    console.log("");
  }

  let blocked = false;

  if (v.ledgerVersionMissingFromRepo.length) {
    blocked = true;
    console.log("  ── ✗ LEDGER ROWS THIS REPOSITORY CANNOT ACCOUNT FOR ──");
    let anyMalformed = false;
    for (const e of v.ledgerVersionMissingFromRepo) {
      const malformed = !/^\d{3}$/.test(e.version);
      if (malformed) anyMalformed = true;
      console.log(`     ${JSON.stringify(e.version)}  the ledger says: ${e.ledgerName}`);
      if (malformed) {
        //  A DIFFERENT REPAIR. The gate keys on the three-digit prefix, so a
        //  row recorded as '12' or 'baseline' can never match a file even
        //  when that migration demonstrably ran. Reported separately because
        //  committing a file would be the WRONG fix — the row is mislabelled,
        //  not the migration missing.
        console.log(`          -> version is NOT a zero-padded 3-digit string.`);
        console.log(`             The ledger keys on that prefix, so this row cannot match`);
        console.log(`             any file. This is a MISLABELLED ROW, not a missing file.`);
      } else {
        console.log(`          -> migrations/${e.version}_*.sql does not exist in this build.`);
      }
    }
    console.log("");
    if (anyMalformed) {
      console.log("     For the mislabelled row(s): confirm which migration actually ran,");
      console.log("     then correct the ledger's version string to the padded form. Do NOT");
      console.log("     author a new migration file to satisfy the gate — that would apply a");
      console.log("     change the database already has.\n");
    }
    console.log("     THE NEXT DEPLOY OF THIS BUILD WILL REFUSE TO START until each is");
    console.log("     resolved. Render would keep serving the previous build, so");
    console.log("     production would look healthy while running older code.");
    console.log("");
    console.log("     Resolve, do not silence:");
    console.log("       · file exists on an unmerged branch -> merge it, as 121 was;");
    console.log("       · applied by hand                   -> commit the file that ran;");
    console.log("       · genuinely historical              -> add ONE documented entry to");
    console.log("         DOCUMENTED_LEDGER_ONLY in migrations/ledger_verdict.js, naming");
    console.log("         the reason and what removes it.\n");
  }

  if (v.versionNameConflicts.length) {
    blocked = true;
    console.log("  ── ✗ VERSION/NAME CONFLICTS ──");
    for (const e of v.versionNameConflicts) {
      console.log(`     ${e.version}  ledger: ${e.ledgerName}   file: ${e.fileLabel}`);
    }
    console.log("");
  }

  if (v.duplicateFileNumbers.length) {
    blocked = true;
    console.log("  ── ✗ DUPLICATE MIGRATION NUMBERS IN THIS BUILD ──");
    for (const e of v.duplicateFileNumbers) {
      console.log(`     ${e.version}  ${e.first}  /  ${e.second}`);
    }
    console.log("");
  }

  const code = blocked ? 1 : 0;
  console.log("════════════════════════════════════════════════════════════════");
  if (code === 0) {
    console.log("  ✓ RECONCILED — every ledger row has its file, and every file is");
    console.log("    accounted for. Both directions agree across the WHOLE ledger.");
    if (v.fileMissingFromLedger.length) {
      console.log(`    ${v.fileMissingFromLedger.length} migration(s) await a deliberate release.`);
    }
  } else {
    console.log("  ✗ NOT RECONCILED — resolve the above before releasing or deploying.");
  }
  console.log(`  EXIT  ${code}`);
  console.log("════════════════════════════════════════════════════════════════\n");

  await client.query("rollback");
  await client.end();
  process.exit(code);
}

main().catch((e) => {
  console.error("\n  ✗ reconciliation could not run: " + (e && e.message ? e.message : e) + "\n");
  process.exit(2);
});
