#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   PROVE THE MIGRATION FAILS FAST UNDER LOCK CONTENTION

   migrate.js runs from `prestart`, which on Render means every deploy —
   while the previous instance is still serving live write traffic. With
   no lock_timeout, a migration that wants a lock that traffic holds waits
   forever: the deploy hangs, and because PostgreSQL queues lock waiters,
   every writer arriving behind it stalls too.

   This proves the guard by MEASUREMENT, both directions:

     with a writer holding the conflicting lock
       → migrate.js EXITS NON-ZERO, quickly, naming lock contention
       → the ledger does NOT advance
       → the migration's objects do NOT exist

     with no competing writer
       → migrate.js applies cleanly and the ledger advances

   The negative case is the one that matters. A guard never observed to
   fire is indistinguishable from no guard.

   ⚠ ISOLATED POSTGRES ONLY.

   usage:
     bash tools/steps23/baseline_136.sh
     LOCKPROVE_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/steps23/prove_migration_lock_timeout.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const URL = process.env.LOCKPROVE_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

const runMigrate = (env = {}) => spawnSync(process.execPath,
  [path.join(ROOT, "migrations/migrate.js"), "--apply"],
  { encoding: "utf8", env: { ...process.env, DATABASE_URL: URL,
    MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "136", ...env } });

(async function main() {
  if (!URL) { console.error("REFUSED: LOCKPROVE_DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  console.log("MIGRATION LOCK-TIMEOUT PROOF — isolated postgres\n");

  const ceiling0 = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  if (!ok("L0  baseline ledger is 136", ceiling0 === "136", String(ceiling0))) process.exit(1);

  // ── NEGATIVE: a live writer holds the conflicting lock ──────────────
  //  The ledger-136 baseline carries schema, not fixtures, so the writer
  //  that must hold the conflicting lock needs a real property to insert
  //  against. Created here rather than assumed — an earlier revision read
  //  `select id from properties limit 1` and aborted on an empty table,
  //  which looked like a broken proof rather than a missing fixture.
  const ORG = "0f0f0f0f-0000-0000-0000-00000000000f";
  const PROP = "0f0f0f0f-0000-0000-0000-0000000000f0";
  await c.query(`insert into organizations (id,name) values ($1,'Lock Proof Org')
                 on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'Lock Proof Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  const prop = { id: PROP };

  const writer = new Client({ connectionString: URL });
  await writer.connect();
  await writer.query("begin");
  await writer.query(`insert into work_orders (property_id,title,status,source)
                      values ($1,'lock proof','open','lockproof')`, [prop.id]);

  const t0 = Date.now();
  const blocked = runMigrate({ MIGRATION_LOCK_TIMEOUT: "2s" });
  const elapsed = Date.now() - t0;

  ok("L1  with a live writer holding the lock, migrate EXITS NON-ZERO",
     blocked.status !== 0, "exit " + blocked.status + " — it succeeded, so nothing was blocking");
  ok("L2  …and it fails FAST rather than hanging the deploy",
     elapsed < 30000, elapsed + " ms");
  console.log("        failed after " + elapsed + " ms (lock_timeout 2s)");
  ok("L3  …and the message names lock contention",
     /lock timeout|canceling statement due to lock/i.test(blocked.stdout + blocked.stderr),
     (blocked.stdout + blocked.stderr).split("\n").filter(Boolean).slice(-3).join(" | "));

  const ceilingAfterBlock = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  ok("L4  the ledger did NOT advance", ceilingAfterBlock === "136", String(ceilingAfterBlock));
  const objs = Number((await c.query(
    `select count(*) n from information_schema.tables where table_schema='public'
      and table_name='work_order_proof_evaluations'`)).rows[0].n);
  ok("L5  the migration's objects do NOT exist — nothing half-applied", objs === 0, String(objs));

  //  And the writer is unharmed: failing the deploy must not disturb live
  //  traffic. That is the whole point of failing fast instead of queueing.
  const writerAlive = await writer.query(`select 1`).then(() => true).catch(() => false);
  ok("L6  the live writer's transaction is UNHARMED by the refused migration", writerAlive);
  await writer.query("rollback").catch(() => {});
  await writer.end();

  // ── POSITIVE: no competing writer ───────────────────────────────────
  const t1 = Date.now();
  const clean = runMigrate();
  const cleanMs = Date.now() - t1;
  ok("L7  with no competing writer, migrate SUCCEEDS", clean.status === 0,
     (clean.stdout + clean.stderr).split("\n").filter(Boolean).slice(-4).join(" | "));
  const ceilingAfter = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  ok("L8  the ledger advances to 137", ceilingAfter === "137", String(ceilingAfter));
  console.log("        applied in " + cleanMs + " ms (process wall time, incl. node start)");

  //  ── NO BLIND RETRY ────────────────────────────────────────────────
  //  Retrying into active write traffic is how a fail-fast guard becomes
  //  a slow-motion outage. Asserted against the source, because the
  //  absence of a behaviour cannot be observed by running it once.
  const src = require("fs").readFileSync(path.join(ROOT, "migrations/migrate.js"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ok("L9  migrate.js contains NO retry loop around apply",
     !/retry|setTimeout|for\s*\(\s*let\s+attempt/i.test(src),
     "a retry would turn a refused deploy into a stalled database");
  ok("L10 the lock timeout is set per migration transaction (set local)",
     /set local lock_timeout/.test(src));

  console.log(`\n  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
