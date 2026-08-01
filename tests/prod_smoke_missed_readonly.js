// ════════════════════════════════════════════════════════════════════
//  prod_smoke_missed_readonly.js — PRODUCTION-SAFE. WRITES NOTHING, EVER.
//
//  Every other .db.js harness in this repo COMMITS fixtures and is therefore
//  forbidden from production by the HARNESS_DATABASE_URL guard. This one is the
//  opposite: it exists to be run AGAINST production, and it may never write.
//
//  THE NO-WRITE GUARANTEE IS STRUCTURAL, NOT A PROMISE. Everything runs inside
//  `begin transaction read only`, which Postgres itself enforces — an INSERT,
//  UPDATE, DELETE or DDL in this session is refused by the server with SQLSTATE
//  25006, not by our own discipline. §0 below PROVES the session is read-only by
//  attempting a write and requiring it to fail. If that self-test does not fail,
//  the smoke aborts before checking anything else, because a read-only claim
//  that has not been demonstrated is exactly the kind of unverified safety this
//  codebase keeps getting bitten by.
//
//  It deliberately uses its OWN variable. It must not read HARNESS_DATABASE_URL
//  (whose guard refuses production by design) and must not silently fall back to
//  DATABASE_URL, so that pointing it at production is always a deliberate act.
//
//  Run:  SMOKE_DATABASE_URL="postgres://..." node tests/prod_smoke_missed_readonly.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const CONN = process.env.SMOKE_DATABASE_URL;
if (!CONN) {
  console.error("\n  ✗ SMOKE_DATABASE_URL is not set.");
  console.error("    This smoke is read-only and is the ONLY harness permitted against production.");
  console.error("    It deliberately does not fall back to DATABASE_URL or HARNESS_DATABASE_URL.\n");
  process.exit(1);
}

let pass = 0, fail = 0;
const ok  = (l) => { console.log("  ok    " + l); pass++; };
const bad = (l, d) => { console.log("  FAIL  " + l + (d ? "  →  " + d : "")); fail++; };
function check(label, cond, detail) { cond ? ok(label) : bad(label, detail); }

const pool = new Pool({ connectionString: CONN });

(async () => {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  PRODUCTION SMOKE — migration 126 / missed recognition");
  console.log("  READ ONLY — this session cannot write, and proves it below");
  console.log("════════════════════════════════════════════════════════════════\n");

  const c = await pool.connect();
  await c.query("begin transaction read only");

  // ── §0. PROVE the session cannot write, before trusting anything else ──
  //
  //  THE SAVEPOINT IS LOAD-BEARING. A failed statement puts the whole
  //  transaction into an aborted state, and catching the error in JavaScript
  //  does NOT restore it — every later query would fail with 25P02
  //  (in_failed_sql_transaction). The first version of this file omitted the
  //  savepoint, so it would have died at §1 on its very first real run. It never
  //  ran, so nothing said so: built-but-dormant code that reads as a safety
  //  check. ROLLBACK TO SAVEPOINT is the supported way to continue after a
  //  deliberate failure.
  let readOnlyProven = false;
  await c.query("savepoint ro_probe");
  try {
    await c.query("create temp table __smoke_should_never_exist (x int)");
    // reached only if the server ALLOWED the write — not read-only.
    await c.query("rollback to savepoint ro_probe");
  } catch (e) {
    readOnlyProven = (e.code === "25006");
    await c.query("rollback to savepoint ro_probe");
  }
  await c.query("release savepoint ro_probe");

  // Independent second signal: ask the server what it thinks it is, so the
  // proof does not rest on one error code alone.
  const mode = (await c.query("show transaction_read_only")).rows[0].transaction_read_only;

  if (!readOnlyProven || mode !== "on") {
    console.error("  ✗ ABORT — the session is NOT provably read-only. Nothing was checked.");
    console.error(`    write refused with 25006: ${readOnlyProven}   transaction_read_only: ${mode}`);
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
    process.exit(1);
  }
  ok(`§0  session is READ ONLY — write refused (25006) and transaction_read_only=${mode}`);

  // ── §1. the migration is recorded exactly once ──
  const mig = (await c.query(
    "select version, name, applied_at from schema_migrations where version = $1", ["126"])).rows;
  check("§1  migration 126 recorded exactly once", mig.length === 1,
    `found ${mig.length} row(s)`);
  if (mig.length === 1) console.log(`        ${mig[0].version}  ${mig[0].name}`);

  // ── §2. the three columns exist, nullable, correct types ──
  const cols = (await c.query(
    `select column_name, data_type, is_nullable
       from information_schema.columns
      where table_name = 'obligations'
        and column_name in ('missed_at','missed_threshold_at','missed_recognition_key')
      order by column_name`)).rows;
  check("§2  all three missed columns exist", cols.length === 3,
    `found: ${cols.map((x) => x.column_name).join(", ") || "none"}`);
  for (const col of cols) {
    check(`      ${col.column_name} is nullable (additive, breaks nothing)`,
      col.is_nullable === "YES", col.is_nullable);
  }

  // ── §3. both constraints exist ──
  const cons = (await c.query(
    `select conname, pg_get_constraintdef(oid) as def
       from pg_constraint
      where conrelid = 'obligations'::regclass and contype = 'c'
      order by conname`)).rows;
  const byName = Object.fromEntries(cons.map((r) => [r.conname, r.def]));
  check("§3  ck_oblig_missed_triple exists (all three columns move together)",
    !!byName.ck_oblig_missed_triple);
  check("§3  ck_oblig_missed_after_threshold exists (no recognition precedes its threshold)",
    !!byName.ck_oblig_missed_after_threshold);

  // ── §4. ck_obl_status is UNCHANGED — the heart of the ruling ──
  const status = byName.ck_obl_status || "";
  const hasMissed = /'missed'/.test(status);
  check("§4  ck_obl_status does NOT admit 'missed' (lifecycle enum untouched)", !hasMissed, status);
  for (const v of ["open", "in_progress", "complete", "escalated"]) {
    check(`      ck_obl_status still permits '${v}'`, status.includes(`'${v}'`));
  }

  // ── §5. the shared primitive loads, and never mutates lifecycle ──
  let mod = null;
  try { mod = require("../src/shared/obligation_missed.js"); } catch (e) { /* reported below */ }
  check("§5  shared primitive loads", !!mod);
  if (mod) {
    check("      exports recognizeObligationMissed", typeof mod.recognizeObligationMissed === "function");
    check("      exports timelinessOf", typeof mod.timelinessOf === "function");
    // the projection, verified without touching the database at all
    const past = new Date(Date.now() - 3600e3), future = new Date(Date.now() + 3600e3);
    check("      timelinessOf: crossed clock, NO recognition → 'overdue' (never 'missed')",
      mod.timelinessOf({ due_at: past }) === "overdue");
    check("      timelinessOf: recognition present → 'missed'",
      mod.timelinessOf({ due_at: past, missed_at: past }) === "missed");
    check("      timelinessOf: before threshold → 'due'",
      mod.timelinessOf({ due_at: future }) === "due");
  }

  // STATIC: the primitive must contain no lifecycle-status mutation.
  const src = fs.readFileSync(path.join(__dirname, "../src/shared/obligation_missed.js"), "utf8");
  check("§5  primitive contains NO 'update obligations set status' anywhere",
    !/update\s+obligations[\s\S]{0,200}set[\s\S]{0,120}\bstatus\s*=/i.test(src));

  // ── §6. production state: this migration created no rows, and no row is half-written ──
  // GATED ON THE COLUMNS EXISTING. Querying missed_at unconditionally would
  // make the "migration not applied" case die with a confusing 42703 instead of
  // reporting cleanly — the smoke must be able to say "not applied" as a
  // finding, not as a crash.
  const total = (await c.query("select count(*)::int n from obligations")).rows[0].n;
  if (cols.length === 3) {
    const counts = (await c.query(
      `select count(missed_at)::int recognised,
              count(*) filter (where (missed_at is null) <> (missed_threshold_at is null))::int incoherent_pair,
              count(*) filter (where (missed_at is null) <> (missed_recognition_key is null))::int incoherent_key
         from obligations`)).rows[0];
    console.log(`\n        obligations=${total}  recognised_missed=${counts.recognised}`);
    check("§6  no half-written recognition (timestamps agree)", counts.incoherent_pair === 0);
    check("§6  no half-written recognition (key agrees)", counts.incoherent_key === 0);
  } else {
    console.log(`\n        obligations=${total}  recognised_missed=SKIPPED — columns absent`);
    bad("§6  recognition coherence", "skipped: migration 126 is not fully present");
  }

  const statusMix = (await c.query(
    "select status, count(*)::int n from obligations group by status order by n desc")).rows;
  console.log("        lifecycle: " + statusMix.map((r) => `${r.status}=${r.n}`).join("  "));
  check("§6  no obligation holds a 'missed' lifecycle status",
    !statusMix.some((r) => r.status === "missed"));

  await c.query("rollback");
  c.release();
  await pool.end();

  const code = fail === 0 ? 0 : 1;
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  SMOKE COMPLETE · ${pass + fail} checks · ${pass} passed · ${fail} failed`);
  console.log("  WROTE NOTHING — read-only transaction, proven in §0, rolled back.");
  console.log(`  ${code === 0 ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`  EXIT      ${code}`);
  console.log("════════════════════════════════════════════════════════════════\n");
  process.exit(code);
})().catch(async (e) => {
  console.error("\n  ✗ SMOKE ABORTED — " + (e && e.message ? e.message : e));
  console.error("    Nothing was written: the session was read-only.");
  console.error("  EXIT      1\n");
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
