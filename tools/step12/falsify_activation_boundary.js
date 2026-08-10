#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   CAN ACTIVATION ACTUALLY DIVIDE "BEFORE" FROM "AFTER"?

   Migration 140 is inert until an activation row exists, and everything
   the guard does hangs off that one question. A4 already showed one way
   to get the wrong answer — a transaction holding a `work_orders` lock
   across the activation — and it was closed by taking SHARE ROW EXCLUSIVE
   in the activation transaction.

   ── THAT FIX ONLY COVERS A WRITER THAT ALREADY CONFLICTS ────────────

   This file attacks the harder case, which the lock does NOT obviously
   cover:

       Tx A  BEGIN REPEATABLE READ
             SELECT something UNRELATED        ← snapshot is now fixed
             …does not touch work_orders at all…
       Tx B  the real activation, start to finish, COMMIT
             …its table lock is released here…
       Tx A  NOW insert/update a terminal work order
             COMMIT                            ← deferred trigger fires

   At A's commit the guard asks "is there an activation?" through A's
   snapshot, which predates B. If the answer is "no", the guard returns
   immediately and the row commits UNJUDGED. The table lock cannot help:
   A never wanted it while B held it.

   ── B1 · A REPEATABLE READ TRANSACTION IS NOT EXOTIC ────────────────

   `pg`'s pool does not reset isolation level between checkouts, and a
   report, an export or a long analytical read is a perfectly ordinary
   reason to open one. This is not an attacker-only shape.

   ── WHAT THIS FILE IS FOR ───────────────────────────────────────────

   It records a PREDICTION before each result, and it is written to run
   against a guard that has NOT yet been fixed, so the first run is
   expected to demonstrate the bypass. Sections marked EXPECT-BYPASS
   change meaning once the fix lands: they become the regression that
   proves it stayed fixed.

   ⚠ ISOLATED POSTGRES ONLY. Ledger 137, virgin activation history.

   usage:
     BOUNDARY_DATABASE_URL='postgresql://…' node tools/step12/falsify_activation_boundary.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const guardWindow = require("./guard_window.js");
const grounded = require("./grounded_evaluation.js");
const URL = process.env.BOUNDARY_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const predict = (t) => console.log("  PREDICTION:  " + t + "\n");

const ID = (n) => crypto.createHash("md5").update("bound:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: BOUNDARY_DATABASE_URL is not set."); process.exit(1); }
  const open = async () => { const x = new Client({ connectionString: URL }); await x.connect(); return x; };
  const c = await open();

  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty — this proof must observe");
    console.error("         the boundary being crossed. Rebuild the baseline.");
    process.exit(3);
  }

  console.log("THE ACTIVATION BOUNDARY UNDER MVCC — isolated postgres\n");
  await guardWindow.installGuard(c);

  await c.query(`insert into organizations (id,name) values ($1,'BD Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'BD Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Bo Bound','+15415559901','maintenance',true) on conflict (id) do nothing`, [TECH]);

  let seq = 0;
  const nextWo = () => ID("wo" + (++seq));
  const mkOpen = async (client, wo) => {
    await client.query(`insert into work_orders (id,property_id,title,status,source)
                        values ($1,$2,'bound','open','boundproof')`, [wo, PROP]);
    return wo;
  };

  //  One pre-cutover terminal row, so the inventory is not empty and the
  //  activation has something real to compare.
  const LEGACY = nextWo();
  await c.query(`insert into work_orders (id,property_id,title,status,source)
                 values ($1,$2,'bound legacy','closed','boundproof')`, [LEGACY, PROP]);

  const stateOf = async (wo) => {
    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: wo });
    return s && s.proof && (s.proof.state || s.proof.read_status);
  };
  const statusOf = async (wo) => (await c.query(
    `select status from work_orders where id=$1`, [wo])).rows[0]?.status ?? null;

  /* ═══ S · THE STALE SNAPSHOT ══════════════════════════════════════ */
  sec("S · A TRANSACTION THAT NEVER TOUCHED work_orders UNTIL AFTER ACTIVATION");
  predict("Tx A fixes a REPEATABLE READ snapshot on an UNRELATED table, waits out\n"
        + "             the whole activation, then writes a terminal work order. The SHARE ROW\n"
        + "             EXCLUSIVE barrier cannot see it — A wanted no lock while B held one.\n"
        + "             At A's COMMIT the deferred guard asks 'is there an activation?' through\n"
        + "             A's OLD snapshot. If that read is snapshot-bound the answer is NO, the\n"
        + "             guard returns immediately, and a terminal-without-proof row COMMITS.\n"
        + "             I expect the bypass to succeed.");

  /*  THREE SHAPES, ONE PER INVOCATION. A genuine stale-snapshot test needs
   *  a snapshot that predates THIS activation, and a database has exactly
   *  one activation, ever. So the shapes cannot share a baseline and are
   *  not faked into one run — the runner drives three.  */
  const SHAPE = (process.argv.find((a) => a.startsWith("--shape=")) || "").split("=")[1]
    || "update";
  if (!["update", "insert", "eval"].includes(SHAPE)) {
    console.error("REFUSED: --shape must be one of update | insert | eval");
    process.exit(2);
  }
  console.log(`  shape under attack: ${SHAPE}\n`);

  //  Subjects are created BEFORE any snapshot is taken, so the attack is
  //  purely about WHEN the terminal write happens — not about A being
  //  unable to see its own subject.
  const WO_UPD = await mkOpen(c, nextWo());
  const WO_EVAL = await mkOpen(c, nextWo());
  const WO_INS = nextWo();                 // never created; A will INSERT it

  /*  The `eval` shape needs an already-terminal, already-satisfied row so
   *  the attack is "flip the proof out from under a completion", not "make
   *  something terminal". Built before the snapshot, in one transaction so
   *  the deferred guard sees a legal end state. */
  if (SHAPE === "eval") {
    await c.query("begin");
    await c.query(`update work_orders set status='complete' where id=$1`, [WO_EVAL]);
    //  GROUNDED: revision 3 requires a satisfied head to cite qualifying
    //  evidence, and the activation refuses a population that does not.
    await grounded.groundedSatisfied(c, {
      work_order_id: WO_EVAL, property_id: PROP, uploaded_by_user_id: TECH,
      evaluated_by_service: "boundproof" });
    await c.query("commit");
  }

  const a = await open();
  await a.query("begin isolation level repeatable read");
  //  The snapshot is taken by the FIRST statement, and it is deliberately
  //  about something with no relationship to the release at all.
  const snapProbe = (await a.query(`select count(*) n from organizations`)).rows[0].n;
  ok("S0  Tx A holds a pre-activation REPEATABLE READ snapshot, taken on an unrelated read",
     Number(snapProbe) >= 1, "the probe read nothing, so no snapshot was established");

  //  A third connection: a terminal write attempted at the same moment,
  //  WITHOUT a stale snapshot. It is the control — if it is refused and A
  //  is not, the difference is the snapshot and nothing else.
  const activationErr = await (async () => {
    const b = await open();
    try {
      const census = await activation.readLegacyTerminalSet(b);
      await b.query("begin");
      await activation.recordActivation(b, {
        activated_at: CUTOVER, captured_by: "boundary proof", expected: census });
      await b.query("commit");
      await b.end();
      return null;
    } catch (e) { await b.query("rollback").catch(() => {}); await b.end(); return e; }
  })();
  ok("S1  the activation itself committed while Tx A sat idle",
     activationErr === null,
     activationErr && (activationErr.code + " " + activationErr.message));
  const inv = Number((await c.query(
    `select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n);
  console.log(`        (activated; ${inv} legacy row(s) inventoried; A's snapshot is now stale)`);

  /*  THE ATTACK, and the CONTROL that makes it mean something. The control
   *  is the identical write from a FRESH connection: if it is refused and
   *  the stale one is not, the difference is the snapshot and nothing
   *  else. A control row must not be the row under attack, so each shape
   *  brings its own. */
  const CONTROL_WO = await mkOpen(c, nextWo());
  const CONTROL_INS = nextWo();
  const attacks = {
    update: {
      what: "a terminal UPDATE",
      control: (x) => x.query(`update work_orders set status='complete' where id=$1`, [CONTROL_WO]),
      run: (x) => x.query(`update work_orders set status='complete' where id=$1`, [WO_UPD]),
      subject: WO_UPD,
      landed: async () => (await statusOf(WO_UPD)) === "complete",
    },
    insert: {
      what: "a terminal INSERT",
      control: (x) => x.query(`insert into work_orders (id,property_id,title,status,source)
                               values ($1,$2,'bound','complete','boundproof')`, [CONTROL_INS, PROP]),
      run: (x) => x.query(`insert into work_orders (id,property_id,title,status,source)
                           values ($1,$2,'bound','complete','boundproof')`, [WO_INS, PROP]),
      subject: WO_INS,
      landed: async () => (await statusOf(WO_INS)) === "complete",
    },
    /*  A second evaluation is a SUPERSEDE, not a genesis: `uq_wope_genesis`
     *  allows exactly one row with a null supersedes_id per work order. A
     *  first version omitted it, the insert was refused by that unique
     *  index, and the attack reported REFUSED without the guard ever being
     *  consulted — refused by the wrong thing, which is the failure mode
     *  this whole file exists to catch. */
    eval: {
      what: "a superseding not_satisfied evaluation on an already-terminal row",
      control: (x) => x.query(`insert into work_order_proof_evaluations
        (work_order_id,property_id,state,evaluated_by_service,rule_version,supersedes_id)
        values ($1,$2,'not_satisfied','boundproof','ctl',
                (select id from work_order_proof_evaluations
                  where work_order_id=$1 and property_id=$2
                    and id not in (select supersedes_id from work_order_proof_evaluations
                                    where supersedes_id is not null)))`, [CONTROL_WO, PROP]),
      run: (x) => x.query(`insert into work_order_proof_evaluations
        (work_order_id,property_id,state,evaluated_by_service,rule_version,supersedes_id)
        values ($1,$2,'not_satisfied','boundproof','atk',
                (select id from work_order_proof_evaluations
                  where work_order_id=$1 and property_id=$2
                    and id not in (select supersedes_id from work_order_proof_evaluations
                                    where supersedes_id is not null)))`, [WO_EVAL, PROP]),
      subject: WO_EVAL,
      landed: async () => (await stateOf(WO_EVAL)) === "not_satisfied",
    },
  };
  const A = attacks[SHAPE];

  //  The control needs a legal starting point for the `eval` shape too.
  if (SHAPE === "eval") {
    await c.query("begin");
    await c.query(`update work_orders set status='complete' where id=$1`, [CONTROL_WO]);
    await grounded.groundedSatisfied(c, {
      work_order_id: CONTROL_WO, property_id: PROP, uploaded_by_user_id: TECH,
      evaluated_by_service: "boundproof", seed: "ctl" });
    await c.query("commit");
  }

  const control = await (async () => {
    const x = await open();
    try {
      await x.query("begin"); await A.control(x); await x.query("commit");
      await x.end(); return null;
    } catch (e) { await x.query("rollback").catch(() => {}); await x.end(); return e; }
  })();
  ok(`S2  CONTROL — ${A.what} from a FRESH snapshot is refused`,
     !!control && ["R0001", "R0003"].includes(control.code),
     control ? control.code + " " + control.message
             : "it committed — then the guard is not working at all and S3 proves nothing");

  //  ── THE ATTACK. Same write, stale snapshot. ────────────────────────
  let atkErr = null;
  try { await A.run(a); await a.query("commit"); }
  catch (e) { atkErr = e; await a.query("rollback").catch(() => {}); }
  const landed = await A.landed();
  ok(`S3  ${A.what} from the STALE snapshot is REFUSED`,
     atkErr !== null && !landed,
     (atkErr ? atkErr.code + " " + atkErr.message : "IT COMMITTED") +
     `  · landed=${landed}` +
     "\n          → the guard was bypassed by a transaction that simply started earlier " +
     "and waited. The activation boundary is not a boundary under REPEATABLE READ.");
  console.log(`        result: ${atkErr ? atkErr.code : "COMMITTED"} · ` +
    `status=${await statusOf(A.subject)} · reader=${await stateOf(A.subject)}`);
  await a.end();


  /* ═══ E · WHAT THE TRIGGER ACTUALLY READS ═════════════════════════ */
  sec("E · WHAT DOES THE GUARD READ, AND IS IT SNAPSHOT-BOUND?");
  predict("`select 1 from release_0_activation_current` is an ordinary read. Inside a\n"
        + "             REPEATABLE READ transaction it uses the transaction snapshot, and an\n"
        + "             AFTER trigger at COMMIT is still inside that transaction. So the guard\n"
        + "             cannot see an activation committed after the snapshot — no SELECT\n"
        + "             escapes its own snapshot. I expect to be able to demonstrate that\n"
        + "             directly, which tells us the fix cannot be a different SELECT.");
  {
    const p = await open();
    await p.query("begin isolation level repeatable read");
    await p.query(`select count(*) n from organizations`);
    //  Nothing changes between the snapshot and here, so this simply
    //  confirms the mechanism the attack relies on, on a row we control.
    const seesActivation = Number((await p.query(
      `select count(*) n from release_0_activation_current`)).rows[0].n);
    ok("E1  a snapshot taken AFTER the activation does see it — the control",
       seesActivation === 1, String(seesActivation));
    await p.query("rollback"); await p.end();

    /*  ⚠ E2 USED TO ASSERT THE BROKEN SHAPE — that the guard decides the
     *  boundary with a plain `select 1 from release_0_activation_current`.
     *  That was TRUE and was the defect. Now that S3 refuses, E2 is the
     *  regression: it pins the two properties the fix depends on, either
     *  of which could be undone by a well-meaning edit that still looks
     *  correct. */
    const src = fs.readFileSync(guardWindow.MIGRATION, "utf8")
      .replace(/^\s*--.*$/gm, " ");
    ok("E2  the guard reads the boundary from the EPOCH, under a row lock",
       /release_0_activation_epoch[\s\S]{0,400}?for\s+share/i.test(src),
       "the boundary read is not a locking read. A plain SELECT answers from whatever " +
       "snapshot the caller happens to hold, and a transaction that started before the " +
       "activation is exempted rather than refused — measured, S3.");
    ok("E2a …and the epoch row is created by the MIGRATION, before any activation",
       /insert\s+into\s+public\.release_0_activation_epoch/i.test(src) &&
       /create\s+table\s+if\s+not\s+exists\s+public\.release_0_activation_epoch/i.test(src),
       "the epoch row must pre-exist the activation. If the activation INSERTED it, an " +
       "old snapshot would simply not see the row and there would be nothing to " +
       "serialize against — the bypass would be back.");
    ok("E2b …and the activation MOVES it by UPDATE, stamped by a trigger not a caller",
       /update\s+public\.release_0_activation_epoch/i.test(src) &&
       /after\s+insert\s+on\s+public\.release_0_activation_history/i.test(src),
       "if only activation_service.js stamped the epoch, hand-run SQL could activate " +
       "without moving it and the guard would stay inert forever");
    console.log("        → a row-locking read is the only kind that FAILS rather than");
    console.log("          silently answering from a stale snapshot (40001). It needs a row");
    console.log("          that EXISTS BEFORE the activation to conflict on: an INSERT is");
    console.log("          invisible to an old snapshot; an UPDATE of a pre-existing row is");
    console.log("          a serialization failure the stale writer cannot commit through.");
  }

  /* ═══ L · THE LOCK'S OWN BEHAVIOUR ════════════════════════════════ */
  sec("L · IS THE ACTIVATION'S LOCK FAIL-FAST, OR DOES IT QUEUE?");
  predict("`lock table … in share row exclusive mode` with lock_timeout=5s WAITS up to\n"
        + "             5s. A queued lock request is not harmless: PostgreSQL queues later\n"
        + "             requests behind it, so for those 5s ordinary work-order writes stall\n"
        + "             behind the activation's pending request even though it holds nothing.\n"
        + "             I expect to measure exactly that, which is the migration 137 lesson.");
  {
    /*  The holder must take ROW EXCLUSIVE, which is what INSERT/UPDATE
     *  take and what SHARE ROW EXCLUSIVE conflicts with. A first version
     *  used `SELECT … FOR UPDATE`, which takes ROW SHARE — that does NOT
     *  conflict, the activation acquired the lock instantly, and the test
     *  reported "not fail-fast" as a pass. A lock test with the wrong
     *  lock mode measures nothing. */
    const holder = await open();
    await holder.query("begin");
    await holder.query(`update work_orders set updated_at=now() where id=$1`, [LEGACY]);

    //  The activation's lock statement, read out of the shipped service.
    const svcSrc = fs.readFileSync(path.join(ROOT, "src/release0/activation_service.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const lockStmt = (svcSrc.match(
      /lock\s+table\s+public\.work_orders\s+in\s+[a-z ]*mode\s*(nowait)?/i) || [])[0] || "";
    ok("L0  the shipped lock statement was found", !!lockStmt, JSON.stringify(lockStmt));
    console.log("        " + lockStmt);

    const waiter = await open();
    await waiter.query("begin");
    await waiter.query("set local lock_timeout = '5s'");
    const t0 = Date.now();
    const lockErr = await waiter.query(lockStmt).then(() => null).catch((e) => e);
    const waited = Date.now() - t0;
    await waiter.query("rollback").catch(() => {}); await waiter.end();

    ok("L1  the activation's lock is refused when a writer holds the table",
       !!lockErr, "it acquired the lock while another transaction held FOR UPDATE");
    ok("L2  …and it is FAIL-FAST rather than a long queue",
       waited < 500,
       `it waited ${waited} ms before failing. While it waits, its PENDING request ` +
       "blocks every NEW work_orders writer behind it — the activation stalls production " +
       "without holding anything. NOWAIT makes the refusal immediate.");
    console.log(`        waited ${waited} ms · ${lockErr ? lockErr.code : "acquired"}`);

    /*  And the consequence, measured rather than argued. A LOCK request
     *  that is merely WAITING still sits in the lock queue, and PostgreSQL
     *  puts later conflicting requests behind it. So while the activation
     *  waits its 5 seconds — holding nothing — every new work-order writer
     *  waits too. That is the migration 137 lesson, and it is the argument
     *  for NOWAIT rather than a timeout. */
    const waiter2 = await open();
    await waiter2.query("begin");
    await waiter2.query("set local lock_timeout = '5s'");
    const pending = waiter2.query(lockStmt.replace(/\s+nowait$/i, "")).catch(() => null);
    await new Promise((r) => setTimeout(r, 300));   // let it enter the queue
    const ordinary = await open();
    const q0 = Date.now();
    let ordOk = false;
    try {
      await ordinary.query("begin");
      await ordinary.query("set local lock_timeout = '1s'");
      await ordinary.query(`update work_orders set updated_at=now() where id=$1`, [WO_EVAL]);
      await ordinary.query("commit"); ordOk = true;
    } catch (e) { await ordinary.query("rollback").catch(() => {}); }
    ok("L3  a merely-QUEUED activation lock request blocks ordinary writers behind it",
       !ordOk,
       "the ordinary write proceeded in " + (Date.now() - q0) + " ms — then a waiting " +
       "lock request is harmless here, and L2 is a smaller concern than stated");
    console.log(`        ordinary writer ${ordOk ? "proceeded" : "BLOCKED"} in ` +
      (Date.now() - q0) + " ms while the activation's request merely waited");
    await pending;
    await waiter2.query("rollback").catch(() => {}); await waiter2.end();
    await ordinary.end();
    await holder.query("rollback"); await holder.end();
    console.log("        → this is the migration 137 lesson restated: a lock you WAIT for");
    console.log("          is a lock everyone behind you waits for too.");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
