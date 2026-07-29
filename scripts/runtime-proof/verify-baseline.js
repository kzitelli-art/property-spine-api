#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  verify-baseline.js — DOES THE RESTORED DATABASE AGREE WITH ITSELF?
//
//    TARGET_DATABASE_URL="<disposable db>" node scripts/runtime-proof/verify-baseline.js
//    …[--json report.json] [--quiet]
//
//  Reads the restored database's catalog and reports four things:
//
//      1. the migration ledger — identifiers, highest, gaps, duplicates
//      2. the foundations migrations 112-118 depend on
//      3. ledger-to-object agreement for 112-118, one verdict each
//      4. number collisions between the ledger and the migrations folder
//
//  ── IT READS. IT NEVER WRITES. ──────────────────────────────────────
//  There is no CREATE, ALTER, INSERT, UPDATE or DELETE in this file. It opens
//  a read-only transaction and closes it. A verifier that could repair what it
//  found would be a migration runner with an innocent name, and the mismatches
//  it looks for are exactly the ones a human has to adjudicate.
//
//  Exit codes:
//      0  everything agreed
//      1  a disagreement a human must resolve
//      2  could not run (no target, connection failure, bad arguments)
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const path = require("path");
const A = require("./baseline_analysis");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

function die(msg, code) {
  process.stderr.write(`\n  ✗ ${msg}\n\n`);
  process.exit(code === undefined ? 2 : code);
}

// ── arguments ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = { json: null, quiet: false, target: process.env.TARGET_DATABASE_URL || "" };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--json") { opt.json = args[++i]; if (!opt.json) die("--json needs a path"); }
  else if (a === "--quiet") opt.quiet = true;
  else if (a === "--target-url") { opt.target = args[++i]; if (!opt.target) die("--target-url needs a url"); }
  else if (a === "-h" || a === "--help") {
    process.stdout.write(
      "\n  TARGET_DATABASE_URL=\"<disposable db>\" node scripts/runtime-proof/verify-baseline.js" +
      " [--json FILE] [--quiet]\n\n");
    process.exit(0);
  } else die(`unknown argument: ${a}`);
}
if (!opt.target) {
  die("No target database.\n    Set TARGET_DATABASE_URL to the DISPOSABLE database you restored into.\n" +
      "    This tool only reads, but it still refuses to guess where to look.");
}

//  Never let a connection string reach output, including through an error
//  object thrown by the driver.
function redact(s) {
  return String(s == null ? "" : s)
    .split(opt.target).join("<target url redacted>")
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']*/g, "<connection string redacted>");
}

// ── catalog reads ───────────────────────────────────────────────────
async function readCatalog(client) {
  const tables = (await client.query(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`)).rows.map((r) => r.table_name);

  const cols = (await client.query(`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public'
     order by table_name, ordinal_position`)).rows;
  const columnsByTable = {};
  for (const c of cols) {
    (columnsByTable[c.table_name] = columnsByTable[c.table_name] || []).push(c.column_name);
  }

  const routines = (await client.query(`
    select p.proname as name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public','pg_catalog','extensions')`)).rows.map((r) => r.name);

  const enums = (await client.query(`
    select t.typname as name from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where t.typtype = 'e' and n.nspname = 'public'
     order by t.typname`)).rows.map((r) => r.name);

  let ledgerRows = [];
  let ledgerReadable = true;
  let ledgerError = null;
  if (tables.includes("schema_migrations")) {
    try {
      ledgerRows = (await client.query(
        "select version, name from public.schema_migrations order by version")).rows;
    } catch (e) { ledgerReadable = false; ledgerError = redact(e.message); }
  } else {
    ledgerReadable = false;
    ledgerError = "public.schema_migrations does not exist in the restored database";
  }

  return { tables, columnsByTable, routines, enums, ledgerRows, ledgerReadable, ledgerError };
}

function migrationFiles() {
  try {
    return fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  } catch (e) { return []; }
}

// ── main ────────────────────────────────────────────────────────────
(async function main() {
  let Client;
  try { ({ Client } = require("pg")); }
  catch (e) { die("The 'pg' package is not installed. Run `npm install` in the repository first."); }

  //  SSL only where it is asked for or where the target is not local. A unix
  //  socket or a localhost database is the normal disposable case and does not
  //  serve TLS; demanding it there fails the connection for no benefit.
  const t = opt.target;
  let ssl;
  if (/sslmode=disable/i.test(t)) ssl = false;
  else if (/sslmode=/i.test(t)) ssl = { rejectUnauthorized: false };
  else if (/host=(\/|%2F)/i.test(t) || /@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(t) ||
           /^postgres(ql)?:\/\/[^@/]*@?\//i.test(t)) ssl = false;
  else ssl = { rejectUnauthorized: false };

  const client = new Client({ connectionString: opt.target, ssl });

  try { await client.connect(); }
  catch (e) { die(`Could not connect to the target database.\n    ${redact(e.message)}`); }

  let cat;
  try {
    //  READ ONLY, and said so to the server rather than only in a comment.
    await client.query("begin transaction read only");
    cat = await readCatalog(client);
    await client.query("commit");
  } catch (e) {
    try { await client.query("rollback"); } catch (_) {}
    await client.end();
    die(`Could not read the database catalog.\n    ${redact(e.message)}`);
  }
  await client.end();

  const files = migrationFiles();

  const ledger = A.analyseLedger(cat.ledgerRows);
  const foundations = A.analyseFoundations(cat.columnsByTable, cat.routines);
  const builds = A.analyseBuildMigrations({
    ledgerRows: cat.ledgerRows, tables: cat.tables, columnsByTable: cat.columnsByTable,
  });
  const collisions = A.analyseCollisions({ ledgerRows: cat.ledgerRows, migrationFiles: files });
  const pending = A.analysePendingApplication({ ledgerRows: cat.ledgerRows, migrationFiles: files });

  const blocking = [];
  if (!cat.ledgerReadable) blocking.push(`ledger unreadable: ${cat.ledgerError}`);
  if (!foundations.satisfied) blocking.push("required foundations are missing or incomplete");
  if (!builds.agrees) blocking.push("the ledger and the objects disagree for one or more Build migrations");
  if (collisions.build_collisions.length) blocking.push("a migration number needed by Builds 1-5 is already spent");
  if (ledger.duplicates.length) blocking.push("the ledger contains duplicate migration identifiers");

  const report = {
    generated_at_utc: new Date().toISOString(),
    tool: "verify-baseline.js",
    read_only: true,
    database: { table_count: cat.tables.length, enum_count: cat.enums.length },
    ledger: {
      readable: cat.ledgerReadable, error: cat.ledgerError,
      count: ledger.count, highest: ledger.highest,
      versions: ledger.versions, duplicates: ledger.duplicates, gaps: ledger.gaps,
      build_versions_recorded: A.BUILD_MIGRATIONS
        .filter((m) => ledger.versions.includes(m.version)).map((m) => m.version),
    },
    foundations,
    build_migrations: builds,
    collisions,
    pending_application: pending,
    verdict: blocking.length === 0 ? "agrees" : "needs_human",
    blocking,
    //  Stated in the machine-readable report, not only in prose, so a script
    //  consuming this cannot mistake it for a runtime-proof result.
    scope_note:
      "This verifies that a restored baseline agrees with its own migration ledger. " +
      "It does not repair migrations 001-087, it does not apply anything, and it is " +
      "not runtime proof of any Build.",
  };

  if (opt.json) {
    fs.writeFileSync(opt.json, JSON.stringify(report, null, 2) + "\n");
  }

  if (!opt.quiet) printSummary(report, files.length);
  process.exit(blocking.length === 0 ? 0 : 1);
})().catch((e) => {
  process.stderr.write(`\n  ✗ verify-baseline failed: ${redact(e && e.stack ? e.stack : e)}\n\n`);
  process.exit(2);
});

// ── readable summary ────────────────────────────────────────────────
function printSummary(r, fileCount) {
  const say = (s) => process.stdout.write((s === undefined ? "" : s) + "\n");
  const head = (t) => { say(""); say("  ── " + t + " " + "─".repeat(Math.max(0, 56 - t.length))); };

  say("");
  say("  BASELINE VERIFICATION — read-only");

  head("MIGRATION LEDGER");
  if (!r.ledger.readable) {
    say(`     UNREADABLE: ${r.ledger.error}`);
  } else {
    say(`     recorded migrations : ${r.ledger.count}`);
    say(`     highest identifier  : ${r.ledger.highest || "none"}`);
    say(`     migration files here: ${fileCount}`);
    say(`     duplicates          : ${r.ledger.duplicates.length ? r.ledger.duplicates.join(", ") : "none"}`);
    say(`     gaps                : ${r.ledger.gaps.length ? r.ledger.gaps.join(", ") : "none"}`);
    if (r.ledger.gaps.length) {
      say("     (a gap is reported, not judged — a withdrawn migration leaves one legitimately)");
    }
    say(`     112-118 recorded    : ${r.ledger.build_versions_recorded.length
      ? r.ledger.build_versions_recorded.join(", ") : "none"}`);
  }

  head("REQUIRED FOUNDATIONS");
  if (r.foundations.satisfied) {
    say(`     all ${r.foundations.tables.length} required tables present with their expected columns`);
    say("     gen_random_uuid() available");
  } else {
    for (const t of r.foundations.tables) {
      if (!t.present) say(`     ✗ ${t.table} — MISSING`);
      else if (t.missing_columns.length) say(`     ✗ ${t.table} — missing column(s): ${t.missing_columns.join(", ")}`);
    }
    for (const fn of r.foundations.missing_routines) say(`     ✗ ${fn}() — MISSING`);
    say("");
    say("     The Build migrations reference these directly. Applying them against");
    say("     this baseline would fail partway, not cleanly.");
  }

  head("LEDGER vs OBJECTS — MIGRATIONS 112-118");
  const VERDICT = {
    applied_and_recorded: "✓ applied and recorded",
    pending: "· pending — not recorded, objects absent",
    recorded_without_objects: "✗ RECORDED but its objects are ABSENT",
    objects_without_ledger: "✗ OBJECTS EXIST but the ledger does not record it",
    partial_objects_without_ledger: "✗ SOME objects exist and the ledger does not record it",
  };
  for (const m of r.build_migrations.migrations) {
    say(`     ${m.version}  ${m.build.padEnd(8)} ${VERDICT[m.verdict]}`);
    if (m.missing_tables.length) say(`            missing tables : ${m.missing_tables.join(", ")}`);
    if (m.missing_columns.length) say(`            missing columns: ${m.missing_columns.join(", ")}`);
    if (m.recorded && !m.name_matches) {
      say(`            ledger label   : "${m.recorded_name}" (expected "${m.expected_label}")`);
    }
  }
  if (!r.build_migrations.agrees) {
    say("");
    say("     NOT REPAIRED. Both mismatch shapes are silent failures:");
    say("       · recorded but absent  → the runner skips it forever");
    say("       · present but absent from the ledger → the runner tries it again");
    say("     Which side is wrong is a fact about the source database, and a");
    say("     human decides it.");
  }

  head("MIGRATION NUMBER COLLISIONS");
  if (r.collisions.clean) {
    say("     none — every file's number is either free or recorded under the same name");
  } else {
    for (const d of r.collisions.duplicate_files) {
      say(`     ✗ ${d.version} — two files share this number: ${d.files.join(", ")}`);
    }
    for (const c of r.collisions.number_already_spent) {
      say(`     ✗ ${c.version} — ledger says "${c.ledger_says}", folder has ${c.folder_has}`);
      say(`            ${c.consequence}`);
    }
    if (r.collisions.build_collisions.length) {
      say("");
      say("     At least one collision touches 112-118. Renumbering is NOT done");
      say("     automatically — stop and resolve it.");
    }
  }

  head("WHAT WOULD BE APPLIED");
  say(`     pending: ${r.pending_application.pending.length}`);
  for (const f of r.pending_application.pending_build) say(`       → ${f}   (Build 1-5)`);
  for (const f of r.pending_application.pending_other) say(`       ! ${f}   (OUTSIDE Builds 1-5)`);
  say("");
  say(`     ${r.pending_application.reason}`);

  head("VERDICT");
  if (r.verdict === "agrees") {
    say("     The baseline agrees with its own ledger.");
    say("");
    say("     This is NOT runtime proof. It says the restored database is a");
    say("     coherent starting point — nothing has been applied and no Build is live.");
  } else {
    say("     NEEDS A HUMAN:");
    for (const b of r.blocking) say(`       · ${b}`);
    say("");
    say("     Nothing was changed. Nothing was applied.");
  }
  say("");
}
