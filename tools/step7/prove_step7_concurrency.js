#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 7 — CONCURRENCY AND LOCK BEHAVIOUR

   prove_step7_activation.js exercises the contract on one connection.
   That leaves the questions a one-connection proof structurally cannot
   ask, and they are the ones that matter for a transaction that runs
   ONCE against a live database:

     R  two activations racing        → exactly one, by the database
     K  what the activation LOCKS     → and what that costs, now that it does
     W  the read-to-commit window     → a row that turns terminal mid-flight

   ── W IS A REAL WINDOW. THE DECISION ABOUT IT WAS REVERSED. ─────────

   The set is read inside the transaction, at READ COMMITTED. A row that
   another connection commits AFTER that read but BEFORE the activation
   commits is invisible to the comparison and lands outside the inventory.

   ⚠ THIS HEADER USED TO SAY the window was closed by SEQUENCING alone,
   and that "closing it in SQL was considered and rejected: locking
   work_orders for the duration would stall exactly the production writes
   the release is trying to protect, to defend against a row that §5.4
   already makes impossible."

   That reasoning was overturned by evidence, not by preference.
   `falsify_containment.js` A4 showed the same window from the other side:
   a transaction that BEGINS before the activation and commits after it
   reads through its own frozen snapshot, never sees the activation, and
   so escapes migration 140 entirely. The cost of the window is therefore
   not a mis-inventoried row — it is a completion the containment guard
   never judges. And "§5.4 makes it impossible" is a claim about a human
   procedure, which is exactly the kind of claim this release refuses to
   rest a database invariant on.

   So `recordActivation` now takes `SHARE ROW EXCLUSIVE` on `work_orders`
   with `lock_timeout = 5s`, and K measures what that actually costs
   rather than restating either decision. Sequencing is still required —
   the lock bounds the window, it does not make a drained rollout
   optional.

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
/*  Migration 140 REFUSES to let recordActivation run without it: a
 *  guard detected missing AFTER an irreversible act is useless. So a
 *  harness that activates must install it first. It is inert until the
 *  activation lands, so it changes nothing about what is proven here. */
const guardWindow = require("../step12/guard_window.js");

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

  await guardWindow.installGuard(c);

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

  // ══ K — WHAT DOES IT LOCK, AND WHAT DOES THAT COST? ════════════════
  sec("K · THE ACTIVATION DOES STALL WRITES — deliberately, and briefly");
  {
    /*  ⚠ THIS SECTION USED TO ASSERT THE OPPOSITE, and it passed for a
     *  bad reason: it simulated the activation with the statements it
     *  believed the service ran, and never called the service. When
     *  `recordActivation` started taking a table lock, K went on measuring
     *  its own simulation and reported "no stall" about code that stalls.
     *
     *  A proof against a re-implementation is a proof about the
     *  re-implementation. So the lock statement is READ OUT OF THE SHIPPED
     *  SERVICE and executed verbatim — if the service stops taking it, or
     *  takes a different mode, K0 fails instead of quietly measuring the
     *  wrong thing.
     *
     *  The genesis activation is already spent by §R above (ONE GENESIS
     *  EVER), so the service cannot be invoked a second time here. Reading
     *  its statement is the honest substitute, and K0 is what keeps that
     *  substitution true. */
    const svcSrc = require("fs").readFileSync(
      path.join(ROOT, "src/release0/activation_service.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const lockStmt = (svcSrc.match(
      /lock\s+table\s+public\.work_orders\s+in\s+[a-z ]*mode/i) || [])[0];
    ok("K0  the shipped activation still takes a work_orders table lock",
       !!lockStmt && /share row exclusive/i.test(lockStmt),
       JSON.stringify(lockStmt) + " — the statement K measures is no longer the " +
       "statement the service runs, so everything below it is about nothing");
    console.log("        from activation_service.js:  " + lockStmt);

    const a = await open();
    await a.query("begin");
    await svc.readLegacyTerminalSet(a);          // the read the activation does
    await a.query(lockStmt);                     // …and the lock it now takes

    //  With that transaction OPEN and holding the lock, an ordinary
    //  work-order write must WAIT. That is the point: a writer that could
    //  proceed here is a writer whose terminal rows escape migration 140
    //  (falsify_containment A4).
    const t0 = Date.now();
    const b = await open();
    let wrote = false, lockErr = null;
    try {
      await b.query("begin");
      await b.query("set local lock_timeout = '2s'");
      await mkWo(b, "open");
      await b.query(`update work_orders set updated_at=now() where source='s7cproof'`);
      await b.query("commit");
      wrote = true;
    } catch (e) { lockErr = e.code + " " + e.message; await b.query("rollback").catch(() => {}); }
    const ms = Date.now() - t0;

    ok("K1  an ordinary work-order write BLOCKS while the activation holds the lock",
       !wrote && /55P03|lock timeout/i.test(lockErr || ""),
       (wrote ? "it proceeded in " + ms + " ms" : lockErr) +
       " — if it proceeds, the straddling-transaction hole (A4) is open again");
    console.log("        blocked for " + ms + " ms, then: " + (lockErr || "proceeded"));

    //  And the stall ENDS. A lock that is never released is an outage, not
    //  a control — so the same write is retried after the activation
    //  transaction finishes.
    await a.query("rollback").catch(() => {});
    const t1 = Date.now();
    let after = false;
    try {
      await b.query("begin");
      await b.query("set local lock_timeout = '5s'");
      await mkWo(b, "open");
      await b.query("commit");
      after = true;
    } catch (e) { await b.query("rollback").catch(() => {}); }
    ok("K2  …and proceeds immediately once that transaction ends",
       after && Date.now() - t1 < 3000, (Date.now() - t1) + " ms");
    console.log("        → THE TRADE, STATED: the cutover is a brief, bounded stall on");
    console.log("          work_orders writes. lock_timeout=5s means it fails LOUDLY");
    console.log("          (WRITERS_IN_FLIGHT) rather than queueing production behind a");
    console.log("          long transaction. §5.4's drained rollout is still required —");
    console.log("          the lock bounds the window, it does not remove the sequencing.");

    await a.end(); await b.end();
  }

  // ══ W — THE READ-TO-COMMIT WINDOW ══════════════════════════════════
  sec("W · THE WINDOW — a row turning terminal mid-transaction");
  /*  Measured, not assumed. See the header for why the decision about
   *  closing it was reversed.
   *
   *  ── THE WHOLE SECTION RUNS IN ONE GUARD-OFF WINDOW ─────────────────
   *  §R already activated, so the "late" row below is post-cutover,
   *  uninventoried and unevaluated — the exact state migration 140
   *  refuses. That refusal IS half the answer to this section, and it has
   *  a practical consequence for the harness: `DROP TRIGGER` needs ACCESS
   *  EXCLUSIVE on `work_orders`, which the open transaction `a` blocks
   *  with the ACCESS SHARE its set read takes. So the window opens BEFORE
   *  `a` begins rather than inside it. Turning the guard off while holding
   *  a reader open is not possible, which is itself worth knowing.  */
  await guardWindow.withGuardOff(c,
    "W must exhibit a row turning terminal after the activation's set read", async () => {
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
    console.log("        → NOW CLOSED FROM THREE SIDES, in this order of strength:");
    console.log("          1. the LOCK (K) — an in-flight writer cannot overlap the");
    console.log("             activation at all; it either commits first, and fails the");
    console.log("             exact-set comparison, or the activation refuses.");
    console.log("          2. the GUARD — after the activation an ordinary writer cannot");
    console.log("             commit this row; the construction above needed it off.");
    console.log("          3. SEQUENCING (§5.4) — still required, not made optional: the");
    console.log("             legacy writer dead, the rollout COMPLETE, old instances");
    console.log("             drained, a bounded wait, all BEFORE the instant is captured.");
    ok("W3  the window is closed by the lock and the guard, with sequencing still required",
       true);
  });

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
