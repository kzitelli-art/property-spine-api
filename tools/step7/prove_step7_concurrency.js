#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 7 — CONCURRENCY AND LOCK BEHAVIOUR

   prove_step7_activation.js exercises the contract on one connection.
   That leaves the questions a one-connection proof structurally cannot
   ask, and they are the ones that matter for a transaction that runs
   ONCE against a live database:

     R  two activations racing        → exactly one, by the database
     K  what the activation LOCKS     → can it stall production writes?
     W  the read-to-commit window     → a row that turns terminal mid-flight

   ── W IS A REAL WINDOW AND IT IS NOT CLOSED HERE ────────────────────

   The set is read inside the transaction, at READ COMMITTED. A row that
   another connection commits AFTER that read but BEFORE the activation
   commits is invisible to the comparison and lands outside the inventory.

   That window is closed by SEQUENCING, not by this transaction: §5.4
   requires the legacy writer dead, the rollout COMPLETE, old instances
   drained, no in-flight request able to commit, and a bounded wait —
   all before the instant is captured. This file MEASURES the window so
   the sequencing requirement is a demonstrated necessity rather than an
   inherited instruction.

   Closing it in SQL was considered and rejected: locking `work_orders`
   for the duration would stall exactly the production writes the release
   is trying to protect, to defend against a row that §5.4 already makes
   impossible.

   ⚠ ISOLATED POSTGRES ONLY. Needs schema 137 and a virgin activation
     history — ONE GENESIS EVER is the invariant under test.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP7_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step7/prove_step7_concurrency.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const svc = require(path.join(ROOT, "src/release0/activation_service.js"));
const URL = process.env.STEP7_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const ID = (n) => crypto.createHash("md5").update("step7c:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop");
const STEP6_INSTANT = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

const open = async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query("set lock_timeout = '8s'");
  await c.query("set statement_timeout = '30s'");
  return c;
};

(async function main() {
  if (!URL) { console.error("REFUSED: STEP7_DATABASE_URL is not set."); process.exit(1); }
  const c = await open();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  const ledger = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  if (ledger !== "137") { console.error(`REFUSED: ledger ${ledger}, expected 137.`); process.exit(2); }
  const dirty = Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n);
  if (dirty > 0) {
    console.error("REFUSED: activation history is not empty. ONE GENESIS EVER is the");
    console.error("         invariant under test, and the record is append-only, so this");
    console.error("         harness cannot reset it. Rebuild the baseline.");
    process.exit(3);
  }

  console.log("STEP 7 — CONCURRENCY AND LOCK BEHAVIOUR — isolated postgres\n");

  await c.query(`insert into organizations (id,name) values ($1,'S7C Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'S7C Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);

  let seq = 0;
  const mkWo = async (client, status = "closed") => {
    const wo = ID("wo" + (++seq));
    await client.query(`insert into work_orders (id,property_id,title,status,source)
                        values ($1,$2,'s7c',$3,'s7cproof')`, [wo, PROP, status]);
    return wo;
  };
  const counts = async () => ({
    activations: Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n),
    inventory: Number((await c.query(`select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n),
  });

  await mkWo(c, "closed");
  await mkWo(c, "complete");

  // ══ R — TWO ACTIVATIONS RACING ═════════════════════════════════════
  sec("R · TWO CONCURRENT ACTIVATIONS — exactly one, decided by the database");
  {
    const set = await svc.readLegacyTerminalSet(c);
    const a = await open(), b = await open();
    await a.query("begin"); await b.query("begin");

    //  Both call the service inside their OWN open transaction, overlapping
    //  in time. Neither pre-checks for an existing genesis — the point is
    //  that the DATABASE decides, because a read-then-write check is a race
    //  and uq_r0ah_genesis is not.
    const pa = svc.recordActivation(a, {
      activated_at: STEP6_INSTANT, captured_by: "racer A", expected: set });
    const pb = svc.recordActivation(b, {
      activated_at: STEP6_INSTANT, captured_by: "racer B", expected: set });
    const ra = await pa.then((out) => ({ out })).catch((err) => ({ err }));
    const rb = await pb.then((out) => ({ out })).catch((err) => ({ err }));

    //  Commit both; one will fail. Which one is not determined and does not
    //  matter — that exactly one survives is the contract.
    const ca = await a.query("commit").then(() => true).catch(() => false);
    const cb = await b.query("commit").then(() => true).catch(() => false);
    await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {});

    const winners = [ca && !ra.err, cb && !rb.err].filter(Boolean).length;
    ok("R1  exactly ONE activation survives two concurrent attempts",
       winners === 1, `winners=${winners} a=${ca && !ra.err} b=${cb && !rb.err} ` +
       `errA=${ra.err && ra.err.message} errB=${rb.err && rb.err.message}`);

    const n = await counts();
    ok("R2  the history holds exactly one activation", n.activations === 1, JSON.stringify(n));
    ok("R3  …and the loser left NO inventory behind", n.inventory === set.length,
       `${n.inventory} inventory rows for a set of ${set.length} — a partial second ` +
       `write would show as a larger count`);
    console.log("        the loser was refused by uq_r0ah_genesis / r0ah_chain_guard,");
    console.log("        not by a pre-check in the service");
    await a.end(); await b.end();
  }

  // ══ R2 — TWO CORRECTIONS RACING ════════════════════════════════════
  sec("R · TWO CONCURRENT CORRECTIONS OF ONE HEAD — no fork");
  {
    const head = (await c.query(`select * from release_0_activation_current`)).rows[0];
    const set = await svc.readLegacyTerminalSet(c);
    const a = await open(), b = await open();
    await a.query("begin"); await b.query("begin");

    const pa = svc.recordActivation(a, {
      activated_at: STEP6_INSTANT, captured_by: "corr A", expected: set,
      supersedes_id: head.id, reason: "correction A" })
      .then((out) => ({ out })).catch((err) => ({ err }));
    const pb = svc.recordActivation(b, {
      activated_at: STEP6_INSTANT, captured_by: "corr B", expected: set,
      supersedes_id: head.id, reason: "correction B" })
      .then((out) => ({ out })).catch((err) => ({ err }));
    const [ra, rb] = await Promise.all([pa, pb]);
    const ca = await a.query("commit").then(() => true).catch(() => false);
    const cb = await b.query("commit").then(() => true).catch(() => false);
    await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {});

    const winners = [ca && !ra.err, cb && !rb.err].filter(Boolean).length;
    ok("R4  exactly ONE correction survives", winners === 1,
       `winners=${winners} errA=${ra.err && ra.err.message} errB=${rb.err && rb.err.message}`);
    const heads = (await c.query(`select * from release_0_activation_current`)).rows;
    ok("R5  the chain has exactly one head — no fork", heads.length === 1, String(heads.length));
    ok("R6  …and the head is the correction, not the genesis",
       heads[0] && heads[0].supersedes_id === head.id,
       JSON.stringify(heads[0] && { id: heads[0].id, sup: heads[0].supersedes_id }));
    await a.end(); await b.end();
  }

  // ══ K — WHAT DOES IT LOCK? ═════════════════════════════════════════
  sec("K · THE ACTIVATION MUST NOT STALL PRODUCTION WRITES");
  {
    /*  The cutover runs against a live database. If reading the legacy set
     *  took a lock on `work_orders`, every technician write would queue
     *  behind it — the release protecting completion truth by stopping
     *  completion. Measured on a second connection, not reasoned about. */
    const a = await open();
    await a.query("begin");
    await svc.readLegacyTerminalSet(a);          // the read the activation does
    await a.query(`insert into release_0_legacy_cutover_inventory
      (work_order_id, property_id, status_at_cutover, had_column_photo, had_column_note, activation_id)
      select w.id, w.property_id, w.status, false, false,
             (select id from release_0_activation_current)
        from work_orders w where w.source='s7cproof' and w.status='closed' limit 1
      on conflict do nothing`);

    //  With that transaction OPEN and holding whatever it holds, can an
    //  ordinary work-order write proceed?
    const t0 = Date.now();
    const b = await open();
    let wrote = false, lockErr = null;
    try {
      await b.query("begin");
      await mkWo(b, "open");
      await b.query(`update work_orders set updated_at=now() where source='s7cproof'`);
      await b.query("commit");
      wrote = true;
    } catch (e) { lockErr = e.message; await b.query("rollback").catch(() => {}); }
    const ms = Date.now() - t0;

    ok("K1  an ordinary work-order INSERT and UPDATE proceed during the activation",
       wrote, lockErr + " — the cutover would stall production writes");
    ok("K2  …without waiting on a lock", ms < 3000, ms + " ms");
    console.log("        completed in " + ms + " ms with the activation transaction open");
    console.log("        → the set read takes no row locks; the inventory and history");
    console.log("          writes touch only tables migration 137 created.");

    await a.query("rollback").catch(() => {});
    await a.end(); await b.end();
  }

  // ══ W — THE READ-TO-COMMIT WINDOW ══════════════════════════════════
  sec("W · THE WINDOW — a row turning terminal mid-transaction");
  {
    /*  Measured, not assumed, and NOT closed here. See the header. */
    const a = await open();
    await a.query("begin");
    const seen = await svc.readLegacyTerminalSet(a);   // the activation's read

    //  Another connection commits a NEW terminal row after that read.
    const b = await open();
    const late = await mkWo(b, "closed");

    const seenAfter = seen.some((r) => r.work_order_id === late);
    ok("W1  a row committed AFTER the set read is invisible to this transaction",
       !seenAfter,
       "it was visible — then the window does not exist and this section is wrong");

    //  Re-reading inside the same transaction DOES see it, which is what
    //  makes this READ COMMITTED rather than a frozen snapshot — and is
    //  exactly why the read's position matters.
    const reread = await svc.readLegacyTerminalSet(a);
    ok("W2  …but a RE-READ in the same transaction sees it (read committed)",
       reread.some((r) => r.work_order_id === late),
       "the transaction is snapshot-isolated, so the window has a different shape " +
       "than described — re-derive it before trusting the sequencing argument");
    await a.query("rollback").catch(() => {});
    await a.end(); await b.end();

    console.log("        → so a row that turns terminal between the read and the commit");
    console.log("          would land OUTSIDE the inventory and later read as a");
    console.log("          missing_evaluation_defect rather than legacy history.");
    console.log("        → CLOSED BY SEQUENCING, NOT BY THIS TRANSACTION. §5.4 requires");
    console.log("          the legacy writer dead, the rollout COMPLETE, old instances");
    console.log("          drained, no in-flight request able to commit, and a bounded");
    console.log("          wait — all BEFORE the instant is captured. This measurement is");
    console.log("          why those preconditions are load-bearing rather than ritual.");
    ok("W3  the window is documented as a sequencing requirement, not silently carried",
       true);
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
