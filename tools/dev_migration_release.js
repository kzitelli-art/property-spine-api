#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   dev_migration_release.js — LOCAL DOCKER DEV ONLY. NOT A DEPLOY PATH.

   Why this exists: `docker-compose up` promises a working local stack,
   but the API's prestart is verify-only by design — a deploy does not
   migrate, and a fresh volume has no ledger, so the API would refuse to
   start forever. The governed release path (migrations/migrate.js
   --apply) requires EXPECTED_LEDGER_CEILING, which exists so a release
   cannot be run by someone who has not read the ledger.

   This script is the "read the ledger" step, automated for a throwaway
   local volume: it reads the current ceiling from the database and
   releases with exactly that value. The human governance of the
   production path is untouched — Render deploys still verify-only,
   and real releases still require a human who read the ledger first.

   DATA-DEPENDENT MIGRATIONS. A few migrations refuse unless specific
   rows already exist (087 internal-QA assignment; 110 governed fee
   charges) — correct behaviour for a backfill, and the reason a schema
   built from EMPTY stops where production sails past. The canonical
   fix is not invented here: tests/e2e/preconditions/ holds one fixture
   per version, applied immediately before that migration, exactly as
   tests/e2e/apply_migrations.sh does for CI. This script applies the
   named fixture and resumes the governed runner; it never edits a
   migration and never invents seed data.

   GUARD: refuses to run against anything that is not a local-dev
   connection shape — a loopback host, or a URL carrying an explicit
   `sslmode=disable`. Neon and any other remote host are refused, so
   this cannot quietly become an auto-migrate for production, and the
   precondition fixtures (which must never touch a real database)
   cannot reach one through it.

   CLASS 2 (temporary scaffolding). Removal condition: the day local
   dev stops building its database through docker-compose — e.g. the app
   repo ships its own dev stack or a snapshot/restore flow replaces
   fresh-volume builds — delete this file and the compose `migrate`
   service with it.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { databaseSsl, LOCAL_HOSTS } = require("../src/shared/database_ssl");

const ROOT = path.join(__dirname, "..");
const MAX_ATTEMPTS = 12;   // bounded: two data-dependent migrations exist today; 12 is generous

function assertLocalDevShape(url) {
  let host = "", sslmode = "";
  try {
    const parsed = new URL(String(url || ""));
    host = parsed.hostname.replace(/^\[|\]$/g, "");
    sslmode = (parsed.searchParams.get("sslmode") || "").toLowerCase();
  } catch (_) { /* fall through to refusal */ }
  const local = LOCAL_HOSTS.includes(host);
  const declaredNoSsl = sslmode === "disable";
  if (!local && !declaredNoSsl) {
    console.error("\n  ✗ dev_migration_release refused — this does not look like a local-dev database.");
    console.error(`    host: ${JSON.stringify(host)}  sslmode: ${JSON.stringify(sslmode)}`);
    console.error("    Allowed: a loopback host, or an explicit sslmode=disable in the URL.");
    console.error("    Real releases are run by hand against the target, with the ledger read first:");
    console.error("      MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<n> node migrations/migrate.js --apply\n");
    process.exit(1);
  }
}

async function readLedgerCeiling(url) {
  const client = new Client({ connectionString: url, ssl: databaseSsl(url) });
  await client.connect();
  try {
    // Same definition as migrations/ledger_verdict.js: the highest ledger
    // version, or "000" when the ledger does not exist yet (fresh volume).
    const rows = await client.query("select max(version) as v from schema_migrations");
    return rows.rows[0].v || "000";
  } catch (err) {
    if (err && err.code === "42P01") return "000";   // undefined_table — fresh database
    throw err;
  } finally {
    await client.end();
  }
}

//  The precondition fixture for a version, or null when none is wired.
//  The version number in the filename is the only wiring — same as CI.
function preconditionFile(version) {
  const p = path.join(ROOT, "tests", "e2e", "preconditions", `${version}.sql`);
  return fs.existsSync(p) ? p : null;
}

async function applyPrecondition(url, version) {
  const file = preconditionFile(version);
  if (!file) return false;
  const sql = fs.readFileSync(file, "utf8");
  const client = new Client({ connectionString: url, ssl: databaseSsl(url) });
  await client.connect();
  try {
    await client.query(sql);
    return true;
  } finally {
    await client.end();
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\n  ✗ DATABASE_URL is not set.\n");
    process.exit(1);
  }
  assertLocalDevShape(url);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    //  Read the ledger immediately before each release attempt — the
    //  ceiling moves as earlier attempts apply their files.
    const ceiling = await readLedgerCeiling(url);
    if (attempt > 1) console.log(`\n  [dev-migrate] resuming — local ledger ceiling is now ${ceiling}.`);

    const run = spawnSync("node", ["migrations/migrate.js", "--apply"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, EXPECTED_LEDGER_CEILING: ceiling },
    });
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);

    if (run.status === 0) {
      console.log("\n  [dev-migrate] local schema release complete — the volume now matches this build.");
      return;
    }

    //  migrate.js names the file it stopped on: "Stopped. Fix NNN_... and run again."
    const stopped = ((run.stdout || "") + (run.stderr || "")).match(/Stopped\. Fix (\d{3})_/);
    if (!stopped) {
      console.error("\n  ✗ [dev-migrate] the release failed for a reason precondition fixtures cannot fix — see the runner output above.\n");
      process.exit(run.status == null ? 1 : run.status);
    }
    const version = stopped[1];
    const seeded = await applyPrecondition(url, version);
    if (!seeded) {
      console.error(`\n  ✗ [dev-migrate] migration ${version} is data-dependent and no precondition fixture is wired for it.`);
      console.error("    See tests/e2e/preconditions/README.md — add the fixture there, wired by version number.\n");
      process.exit(1);
    }
    console.log(`\n  [dev-migrate] ${version} is data-dependent — applied its precondition fixture; resuming.`);
  }

  console.error(`\n  ✗ [dev-migrate] gave up after ${MAX_ATTEMPTS} attempts — the chain keeps stopping; fix by hand.\n`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n  ✗ dev-migrate failed: ${err.message}\n`);
  process.exit(1);
});
