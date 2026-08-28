// ════════════════════════════════════════════════════════════════════
//  migration_ledger_inverse_gate.db.js — REAL POSTGRES.
//
//  Runs the ACTUAL deploy path — `node migrations/migrate.js`, unmodified,
//  as a child process — against a real database, through a connection that
//  CANNOT WRITE. Not a stubbed `pg`, not the classifier in isolation: the
//  thing prestart runs.
//
//  WHY THIS HARNESS EXISTS. Three safety checks shipped on this project
//  having never executed — a production smoke whose read-only probe aborted
//  its own transaction, a closure gate blind since a directory move, and a
//  permission probe testing the wrong permission. All three READ as
//  protection. A guard you have not run is a claim, not a control. This one
//  refuses production deploys, so it gets run.
//
//  WHY READ-ONLY IS PART OF THE PROOF. Until this change the verify path
//  issued `create table if not exists schema_migrations` on EVERY run,
//  including verify. That is DDL, and Postgres checks write permission
//  BEFORE existence — so on 16.13 it fails inside `begin transaction read
//  only` even when the table is already there. Verification could therefore
//  never be run against a read-only connection, which is the only way to
//  inspect production's schema with no possibility of altering it. The
//  fix is proven here by running verify as a role that is structurally
//  incapable of writing.
//
//  ISOLATION. Everything happens inside a scratch database this harness
//  creates and drops. It never touches the harness database's own ledger,
//  and per docs/DB_HARNESS_ISOLATION.md it reaches production never —
//  HARNESS_DATABASE_URL only, no fallback.
//
//  Requires CREATEDB and CREATEROLE on the harness connection. If they are
//  absent it refuses and says so, rather than degrading to a weaker check.
// ════════════════════════════════════════════════════════════════════
"use strict";
const { execFileSync } = require("child_process");
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");
const receipt = require("../_run_receipt");

const HARNESS = __filename;
const EXPECTED = 22;
let passed = 0, failed = 0, ran = 0;

function ok(label, cond, detail) {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
}

const ADMIN_URL = receipt.harnessConnectionString();
const MIGRATE = path.join(__dirname, "..", "..", "migrations", "migrate.js");
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

const REAL_FILES = fs.readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_")).sort();
const REAL_ROWS = REAL_FILES.map((f) => ({ version: f.slice(0, 3), name: f.slice(4, -4) }));
const NEWEST = REAL_FILES[REAL_FILES.length - 1];

const SUFFIX = String(process.pid);
const SCRATCH_DB = `ps_inverse_gate_${SUFFIX}`;
const RO_ROLE = `ps_ro_${SUFFIX}`;
const RO_PASSWORD = `probe_${SUFFIX}_pw`;

//  Build the read-only connection string from the harness one: same server,
//  different user and database. The password is a local throwaway; the
//  receipt never prints either string.
function roUrlFrom(adminUrl) {
  const u = new URL(adminUrl);
  u.username = RO_ROLE;
  u.password = RO_PASSWORD;
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
}

//  Run the real deploy path. Returns exit code + combined output.
function runMigrate(dbUrl, extraEnv = {}, args = []) {
  const env = { ...process.env, DATABASE_URL: dbUrl, ...extraEnv };
  delete env.MIGRATION_RELEASE;
  delete env.RENDER_GIT_COMMIT;
  Object.assign(env, extraEnv);
  try {
    const out = execFileSync(process.execPath, [MIGRATE, ...args],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

async function setLedger(client, rows) {
  await client.query("truncate schema_migrations");
  for (const r of rows) {
    await client.query("insert into schema_migrations (version, name) values ($1,$2)", [r.version, r.name]);
  }
}

async function snapshot(client) {
  const tables = await client.query(
    "select table_name from information_schema.tables where table_schema='public' order by 1");
  const count = await client.query("select count(*)::int as n from schema_migrations");
  return { tables: tables.rows.map((r) => r.table_name).join(","), rows: count.rows[0].n };
}

(async () => {
  let admin = null, scratch = null, code = 1;
  try {
    admin = new Client({ connectionString: ADMIN_URL, ssl: { rejectUnauthorized: false } });
    await admin.connect();

    // ── Setup: scratch database + a role that cannot write ───────────
    await admin.query(`drop database if exists ${SCRATCH_DB}`);
    await admin.query(`drop role if exists ${RO_ROLE}`);
    await admin.query(`create database ${SCRATCH_DB}`);
    await admin.query(`create role ${RO_ROLE} login password '${RO_PASSWORD}'`);
    //  Belt AND braces: every transaction this role opens is read-only, and
    //  it holds no write grant on anything either way.
    await admin.query(`alter role ${RO_ROLE} set default_transaction_read_only = on`);
    await admin.query(`grant connect on database ${SCRATCH_DB} to ${RO_ROLE}`);

    const RO_URL = roUrlFrom(ADMIN_URL);
    const scratchAdminUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = "/" + SCRATCH_DB; return u.toString(); })();
    scratch = new Client({ connectionString: scratchAdminUrl, ssl: { rejectUnauthorized: false } });
    await scratch.connect();

    await scratch.query(`
      create table schema_migrations (
        version text primary key, name text not null,
        applied_at timestamptz not null default now());`);
    await scratch.query(`grant usage on schema public to ${RO_ROLE}`);
    await scratch.query(`grant select on schema_migrations to ${RO_ROLE}`);

    receipt.begin(HARNESS, { url: scratchAdminUrl, expected: EXPECTED });
    console.log(`  SCRATCH   ${SCRATCH_DB}  ·  verify role ${RO_ROLE} (default_transaction_read_only=on)`);
    console.log(`  FILES     ${REAL_FILES.length} real migrations, newest ${NEWEST}\n`);

    // ── 0. The read-only role really cannot write ────────────────────
    {
      const probe = new Client({ connectionString: RO_URL, ssl: { rejectUnauthorized: false } });
      await probe.connect();
      let wroteTable = false, wroteRow = false;
      try { await probe.query("create table ro_probe_should_fail (x int)"); wroteTable = true; } catch { /* expected */ }
      try { await probe.query("insert into schema_migrations values ('999','nope')"); wroteRow = true; } catch { /* expected */ }
      const sel = await probe.query("select count(*)::int as n from schema_migrations");
      await probe.end();
      ok("read-only role: cannot CREATE TABLE", wroteTable === false);
      ok("read-only role: cannot INSERT", wroteRow === false);
      ok("read-only role: CAN read the ledger", Number.isInteger(sel.rows[0].n));
    }

    const before = await snapshot(scratch);

    // ── 1. Ledger agrees with the repo → verifies, read-only ─────────
    {
      await setLedger(scratch, REAL_ROWS);
      const r = runMigrate(RO_URL);
      ok("verify (read-only conn): exit 0", r.code === 0, `exit=${r.code}\n${r.out}`);
      ok("verify (read-only conn): says SCHEMA VERIFIED", /SCHEMA VERIFIED/.test(r.out));
      ok("verify (read-only conn): states both directions were checked",
        /both directions checked/.test(r.out), r.out);
      ok("verify (read-only conn): applied nothing", !/applying\.\.\./.test(r.out));
      //  THE POINT: this is the run that used to be impossible.
      ok("PROPERTY: verify runs to completion on a connection that cannot write",
        r.code === 0 && !/read-only transaction/.test(r.out), r.out);
    }

    // ── 2. INVERSE — a ledger version with no file here ──────────────
    //  The 125 shape: a migration staged outside migrations/ but recorded
    //  as applied.
    {
      await setLedger(scratch, [...REAL_ROWS, { version: "125", name: "application_lifecycle_enforcement" }]);
      const r = runMigrate(RO_URL);
      ok("INVERSE (real DB): refuses to start", r.code === 1, `exit=${r.code}`);
      ok("INVERSE (real DB): names the condition",
        /LEDGER VERSION MISSING FROM THIS REPOSITORY/.test(r.out), r.out);
      ok("INVERSE (real DB): names the version", /\b125\b/.test(r.out));
      ok("INVERSE (real DB): names what the ledger calls it",
        /application_lifecycle_enforcement/.test(r.out));
      ok("INVERSE (real DB): does NOT claim the schema is verified",
        !/SCHEMA VERIFIED/.test(r.out));
      ok("INVERSE (real DB): offers resolution, not silencing",
        /merge it|commit the file|documented entry/.test(r.out));
    }

    // ── 3. FORWARD — unchanged by this work ──────────────────────────
    {
      await setLedger(scratch, REAL_ROWS.slice(0, -1));
      const r = runMigrate(RO_URL);
      ok("forward (real DB): still refuses on a pending migration", r.code === 1, `exit=${r.code}`);
      ok("forward (real DB): still says REFUSING TO START", /REFUSING TO START/.test(r.out));
      ok("forward (real DB): still names the pending file", new RegExp(NEWEST).test(r.out));
    }

    // ── 4. Both directions wrong at once ─────────────────────────────
    {
      await setLedger(scratch, [...REAL_ROWS.slice(0, -1), { version: "125", name: "application_lifecycle_enforcement" }]);
      const r = runMigrate(RO_URL);
      ok("both directions (real DB): refuses", r.code === 1);
      //  Ordering is deliberate: the structural defect is reported before the
      //  release decision, because a ledger you cannot describe makes the
      //  pending-file question unanswerable.
      ok("both directions (real DB): reports the structural defect first",
        /LEDGER VERSION MISSING/.test(r.out) && !/REFUSING TO START/.test(r.out), r.out);
    }

    // ── 5. No ledger at all is its own answer ────────────────────────
    {
      await scratch.query("drop table schema_migrations");
      const r = runMigrate(RO_URL);
      ok("no ledger (real DB): refuses to start", r.code === 1, `exit=${r.code}`);
      ok("no ledger (real DB): says so plainly", /NO MIGRATION LEDGER/.test(r.out), r.out);
      ok("no ledger (real DB): did NOT create the ledger to paper over it",
        !/SCHEMA VERIFIED/.test(r.out));
      const still = await scratch.query(
        "select to_regclass('public.schema_migrations') is null as absent");
      ok("PROPERTY: verify never creates the ledger — it reports its absence",
        still.rows[0].absent === true);
      await scratch.query(`
        create table schema_migrations (
          version text primary key, name text not null,
          applied_at timestamptz not null default now());`);
      await scratch.query(`grant select on schema_migrations to ${RO_ROLE}`);
    }

    // ── 6. Nothing in this database changed ──────────────────────────
    {
      await setLedger(scratch, REAL_ROWS);
      const after = await snapshot(scratch);
      ok("PROPERTY: no verify run added a table",
        after.tables === before.tables, `before=[${before.tables}] after=[${after.tables}]`);
    }

    code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
  } catch (e) {
    code = receipt.died(HARNESS, e, ran);
  } finally {
    try { if (scratch) await scratch.end(); } catch { /* closing */ }
    try {
      if (admin) {
        await admin.query(`drop database if exists ${SCRATCH_DB}`);
        await admin.query(`drop role if exists ${RO_ROLE}`);
        await admin.end();
      }
    } catch (e) { console.error("  ! cleanup incomplete: " + e.message); }
  }
  process.exit(code);
})();
