// ════════════════════════════════════════════════════════════════════
//  db_preflight.js — TEST-ONLY. READ ONLY. Writes nothing, ever.
//
//  Run this FIRST, before any harness, and keep its output as the receipt
//  proving which database the proof run targeted. It answers, on the record:
//
//    · database host, port, name, user
//    · Neon endpoint/branch identity
//    · current migration-ledger ceiling (so the branch is known to carry the
//      deployed schema, not a stale one)
//    · that HARNESS_DATABASE_URL is NOT the production DATABASE_URL
//
//  It also reports whether the target already contains rows — a fresh Neon
//  branch cut from production WILL, and that is expected; the point is that the
//  number is stated rather than assumed.
//
//  Run:  HARNESS_DATABASE_URL="postgres://..." node tests/scenarios/db_preflight.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");

// Fail-closed: refuses and exits non-zero if the variable is missing or points
// at the same target as DATABASE_URL.
const CONN = receipt.harnessConnectionString();
const id = receipt.dbIdentity(CONN);
const pool = new Pool({ connectionString: CONN });

(async () => {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  DB PREFLIGHT — read only, writes nothing");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  HOST       ${id.host}:${id.port}`);
  console.log(`  DATABASE   ${id.database}`);
  console.log(`  USER       ${id.user}`);
  console.log(`  ENDPOINT   ${id.endpoint}`);
  console.log(`  NOT PROD   ${process.env.DATABASE_URL
    ? "confirmed — differs from this shell's DATABASE_URL"
    : "DATABASE_URL is unset in this shell (nothing to compare against)"}`);

  const one = async (sql, fallback) => {
    try { return (await pool.query(sql)).rows; } catch (e) { return fallback(e); }
  };

  const server = await one("select current_database() db, version() v, inet_server_addr()::text addr",
    (e) => [{ db: "(query failed: " + e.message + ")", v: "", addr: "" }]);
  console.log(`  REPORTED   current_database() = ${server[0].db}`);

  // FAIL, DO NOT NARRATE. An unreachable database, or one with no migration
  // ledger, is not a proof target — and a preflight that prints a problem and
  // then says OK is the exact false-green this whole exercise is about.
  let fatal = null;
  const mig = await one("select version, name from schema_migrations order by version desc limit 5",
    (e) => null);
  if (!mig) {
    console.log("  MIGRATIONS ✗ schema_migrations not readable — this database may not carry the deployed schema.");
    fatal = "schema_migrations could not be read (database unreachable, or not a copy of the deployed schema)";
  } else if (mig.length === 0) {
    console.log("  MIGRATIONS ✗ schema_migrations is EMPTY — not a copy of the deployed schema.");
    fatal = "schema_migrations is empty — this is not a branch of the deployed database";
  } else {
    console.log(`  CEILING    ${mig[0].version}  ${mig[0].name}`);
    console.log("  RECENT     " + mig.slice(1).map((m) => m.version).join(", "));
  }

  // Row counts are context, not a verdict: a branch cut from production carries
  // production's rows by design. Stating the number keeps that a known fact
  // rather than a surprise discovered mid-run.
  const counts = await one(
    `select
       (select count(*)::int from properties)   as properties,
       (select count(*)::int from users)        as users,
       (select count(*)::int from persons)      as persons,
       (select count(*)::int from obligations)  as obligations`,
    (e) => null);
  if (counts) {
    const c = counts[0];
    console.log(`  CONTENTS   properties=${c.properties} users=${c.users} persons=${c.persons} obligations=${c.obligations}`);
    console.log("             (a branch cut from production carries its rows — expected, stated not assumed)");
  }

  console.log("════════════════════════════════════════════════════════════════");
  if (fatal) {
    console.error("  ✗ PREFLIGHT FAILED — " + fatal);
    console.error("    Do NOT run harnesses against this target.");
    console.error("  EXIT      1");
    console.error("════════════════════════════════════════════════════════════════\n");
    await pool.end();
    process.exitCode = 1;
    return;
  }
  console.log("  PREFLIGHT OK — this output is the isolation receipt. Keep it.");
  console.log("  EXIT      0");
  console.log("════════════════════════════════════════════════════════════════\n");
  await pool.end();
})().catch(async (e) => {
  console.error("\n  ✗ PREFLIGHT FAILED — " + (e && e.message ? e.message : e));
  console.error("  EXIT      1\n");
  try { await pool.end(); } catch (_) {}
  process.exitCode = 1;
});
