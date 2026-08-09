#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   "EVERYTHING BEFORE BOUNDARY 8 IS REVERTIBLE" — DEMONSTRATED, PER STEP

   That sentence is in the runbook and it is inherited, not proven. It is
   also ambiguous in a way that matters:

       REVERTING THE CODE IS NOT REVERTING THE SEMANTICS.

   A boundary that only ships code can be reverted by redeploying. A
   boundary that WROTE ROWS leaves those rows behind, and they keep
   meaning what they meant. Both get called "reversible" in conversation,
   and only one of them is.

   ── FOUR QUESTIONS PER BOUNDARY, ANSWERED FROM THE DATABASE ─────────

     CHANGED     what the boundary actually alters — DDL, DML, or code
     ROLLBACK    can it be undone, by what mechanism, measured
     IN FLIGHT   what happens to a writer running DURING the rollback
     SEMANTICS   does the rollback restore the old MEANING, or only the
                 old CODE — and what is left behind either way

   ⚠ ISOLATED POSTGRES ONLY. Ledger 137, virgin activation history.

   usage:
     REVERSIBILITY_DATABASE_URL='…' node tools/step13/prove_boundary_reversibility.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const guardWindow = require("../step12/guard_window.js");
const grounded = require("../step12/grounded_evaluation.js");
const URL = process.env.REVERSIBILITY_DATABASE_URL;

let pass = 0, fail = 0;
const sheet = [];
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);
const verdict = (id, changed, rollback, inFlight, semantics) => {
  sheet.push({ id, changed, rollback, inFlight, semantics });
  console.log(`        CHANGED    ${changed}`);
  console.log(`        ROLLBACK   ${rollback}`);
  console.log(`        IN FLIGHT  ${inFlight}`);
  console.log(`        SEMANTICS  ${semantics}`);
};

const ID = (n) => crypto.createHash("md5").update("rev:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: REVERSIBILITY_DATABASE_URL is not set."); process.exit(1); }
  const open = async () => { const x = new Client({ connectionString: URL }); await x.connect(); return x; };
  const c = await open();
  if (Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) !== 1) {
    console.error("REFUSED: not the isolated baseline."); process.exit(2);
  }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty. Rebuild the baseline."); process.exit(3);
  }

  console.log("BOUNDARY REVERSIBILITY — measured, not inherited\n");

  await c.query(`insert into organizations (id,name) values ($1,'RV') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'RV Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Rev Tech','+15415559991','maintenance',true,'active')
                 on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments
                   (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Maintenance Tech',array['maintenance'],true)`, [TECH, PROP]);

  let seq = 0;
  const mkWo = async (status = "open") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'rev',$3,'revproof')`, [wo, PROP, status]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    return wo;
  };
  const complete = async (wo, key) => {
    await grounded.preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH, seed: key });
    await c.query("begin");
    const out = await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: key });
    await c.query("commit");
    return out;
  };
  const ddlCount = async () => Number((await c.query(
    `select count(*) n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname like 'release_0_%'`)).rows[0].n);

  /* ═══ B3 · THE CANONICAL WRITER ═══════════════════════════════════ */
  sec("B3 · Step 3 — the canonical writer");
  {
    const before = Number((await c.query(
      `select count(*) n from work_order_proof_evaluations`)).rows[0].n);
    const wo = await mkWo("open");
    await complete(wo, "b3");
    const after = Number((await c.query(
      `select count(*) n from work_order_proof_evaluations`)).rows[0].n);
    ok("B3.1 the boundary writes DURABLE ROWS, not just behaviour",
       after > before, `${before} → ${after} proof evaluations`);

    //  Could a revert remove them? The chain is append-only by trigger.
    let delErr = null;
    try {
      await c.query("begin");
      await c.query(`delete from work_order_proof_evaluations where work_order_id=$1`, [wo]);
      await c.query("rollback");
    } catch (e) { delErr = e; await c.query("rollback").catch(() => {}); }
    ok("B3.2 …and those rows CANNOT be removed by reverting anything",
       !!delErr && /append-only|forbid/i.test(delErr.message),
       delErr ? delErr.message.slice(0, 120) : "the evaluation chain is deletable");

    verdict("B3",
      "CODE + ROWS. No DDL. Every completion writes a proof evaluation, its " +
      "attachment links, two progress rows and an event.",
      "THE CODE, YES — redeploy the previous build and claimCompletion stops " +
      "recording evaluations. THE ROWS, NO.",
      "Nothing. A redeploy does not touch open transactions; in-flight completions " +
      "finish under whichever build served them.",
      "⚠ CODE ONLY. The evaluations already written are permanent — append-only by " +
      "trigger, refused on DELETE. That is CORRECT and is the point of the release, " +
      "but it means 'revert Step 3' returns the WRITER, never the DATA. Any work " +
      "completed while it was live stays proven.");
  }

  /* ═══ B7 · THE LEGACY DONE-PATH ══════════════════════════════════ */
  sec("B7 · Step 6 — the legacy done-path fails closed");
  {
    const maint = fs.readFileSync(path.join(ROOT, "src/maintenance/maintenance.js"), "utf8");
    ok("B7.1 the boundary is PURE CODE — no migration rides with it",
       !/create\s+table|alter\s+table/i.test(maint),
       "a schema change hidden in the route module would make this irreversible " +
       "in a way the runbook does not say");
    verdict("B7",
      "CODE ONLY. One unconditional 409 ahead of the legacy write. The closing " +
      "UPDATE is still in the file, deliberately (§1.1.2 — containment, not a " +
      "permanent ruling that operator completion authority is abolished).",
      "FULLY. Redeploy the previous build and the path works again.",
      "Nothing in flight is harmed; the route is stateless and opens no transaction " +
      "before refusing.",
      "RESTORED COMPLETELY — BEFORE the activation. AFTER it, reverting the code " +
      "restores the ROUTE but not its EFFECT: migration 140 refuses post-cutover " +
      "`closed` with R0003 regardless of which build is serving. So this boundary is " +
      "reversible in isolation and NOT reversible in sequence, which is exactly the " +
      "distinction the word 'reversible' hides.");
  }

  /* ═══ B7b · MIGRATION 140 ════════════════════════════════════════ */
  sec("B7b · migration 140 — the containment guard");
  {
    const fnBefore = await ddlCount();
    await guardWindow.installGuard(c);
    const fnAfter = await ddlCount();
    ok("B7b.1 the boundary is DDL: functions, triggers and one table",
       fnAfter > fnBefore, `${fnBefore} → ${fnAfter} release_0_* functions`);
    const epochRows = Number((await c.query(
      `select count(*) n from release_0_activation_epoch`)).rows[0].n);
    ok("B7b.2 …and exactly one epoch row, unstamped", epochRows === 1, String(epochRows));

    //  Roll it back the way an operator would, and measure what survives.
    for (const [n, t] of guardWindow.TRIGGERS) {
      // eslint-disable-next-line no-await-in-loop
      await c.query(`drop trigger if exists ${n} on public.${t}`);
    }
    ok("B7b.3 dropping the triggers is possible and immediate",
       !(await guardWindow.guardInstalled(c)));
    const wo = await mkWo("open");
    const out = await complete(wo, "b7b");
    ok("B7b.4 …and with them gone, ordinary work still completes",
       out.closed === true, JSON.stringify(out.outcome));
    await guardWindow.installGuard(c);
    ok("B7b.5 re-applying the migration restores it exactly",
       await guardWindow.guardInstalled(c));

    /*  These counts were once prose, and prose drifts: they still said
     *  "four functions, five triggers" three revisions after the migration
     *  had grown past both. A receipt that states a number it did not
     *  measure is the same defect as a proof against a re-implementation. */
    verdict("B7b",
      `DDL. One table (release_0_activation_epoch, one row), ` +
      `${fnAfter - fnBefore} functions, ${guardWindow.TRIGGERS.length} guard ` +
      `triggers plus the epoch stamp trigger, one view — all counted from this ` +
      `database, not asserted. NO existing row is modified.`,
      `FULLY, and measured both ways: dropping the ${guardWindow.TRIGGERS.length} ` +
      "triggers disarms it; re-applying the migration restores it byte-for-byte.",
      "A concurrent writer is unaffected — CREATE TRIGGER takes a lock on the table " +
      "briefly but the deferred checks apply only to transactions that COMMIT after " +
      "it. Nothing in flight is retroactively judged.",
      "RESTORED COMPLETELY while inert. The epoch table and the functions remain " +
      "after a trigger drop, which is harmless: they are inert reads. The important " +
      "asymmetry is that dropping the triggers does NOT silence the invariant audit " +
      "view — it derives from a function, so a bypass stays visible after the guard " +
      "is gone.");
  }

  /* ═══ B8 · THE ACTIVATION ════════════════════════════════════════ */
  sec("B8 · Step 7 — census, inventory, activation   ⚠ THE IRREVERSIBLE ONE");
  {
    const legacy = await guardWindow.withGuardOff(c,
      "one pre-cutover legacy row, so the inventory is real",
      () => mkWo("closed"));
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "reversibility proof", expected: census });
    await c.query("commit");

    //  Every mechanism an operator might reach for, measured.
    const attempts = [
      { what: "DELETE the activation row",
        run: () => c.query(`delete from release_0_activation_history`) },
      { what: "UPDATE the activation instant",
        run: () => c.query(`update release_0_activation_history set activated_at=now()`) },
      { what: "DELETE the inventory",
        run: () => c.query(`delete from release_0_legacy_cutover_inventory`) },
      { what: "UPDATE the inventory's recorded status",
        run: () => c.query(
          `update release_0_legacy_cutover_inventory set status_at_cutover='complete'`) },
      { what: "INSERT a second genesis activation",
        run: () => c.query(`insert into release_0_activation_history
          (activated_at,captured_at_step,captured_by) values (now(),'step_6','undo')`) },
      /*  E1 — THIS ONE SUCCEEDED, and it was the worst shape available:
       *  the guard went inert while release_0_activation_current still
       *  reported an activation, so the surface classified every terminal
       *  row and the database judged none. Two meanings of truth from one
       *  UPDATE. Migration 140 revision 5 gave the epoch the append-only
       *  discipline the other two truth tables already had. */
      { what: "reset the epoch by hand (E1)",
        run: () => c.query(`update release_0_activation_epoch set activation_id=null`) },
      { what: "repoint the epoch at another activation",
        run: () => c.query(`update release_0_activation_epoch set activation_id=gen_random_uuid()`) },
      { what: "DELETE the epoch row",
        run: () => c.query(`delete from release_0_activation_epoch`) },
    ];
    for (const a of attempts) {
      // eslint-disable-next-line no-await-in-loop
      const err = await (async () => {
        try { await c.query("begin"); await a.run(); await c.query("commit"); return null; }
        catch (e) { await c.query("rollback").catch(() => {}); return e; }
      })();
      ok(`B8·${a.what.padEnd(38)} REFUSED`, !!err,
         err ? "" : "IT SUCCEEDED — the activation is not irreversible after all");
      if (err) console.log(`          by: ${(err.message || "").slice(0, 100)}`);
    }

    ok("B8.x the activation still stands after every attempt",
       Number((await c.query(
         `select count(*) n from release_0_activation_history`)).rows[0].n) === 1);
    ok("B8.y …and the legacy row is still inventoried as it was",
       (await c.query(`select status_at_cutover s from release_0_legacy_cutover_inventory
                        where work_order_id=$1`, [legacy])).rows[0].s === "closed");

    verdict("B8",
      "ROWS in two append-only tables, plus the epoch stamped in the SAME " +
      "transaction by trigger. No DDL.",
      "❌ NOT POSSIBLE. Every mechanism measured above is refused: UPDATE and DELETE " +
      "by forbid_mutation triggers, a second genesis by uq_r0ah_genesis, the epoch by " +
      "the same append-only discipline. There is no supported undo and no unsupported " +
      "one that works through ordinary DML.",
      "The activation itself refuses to run while a writer holds work_orders " +
      "(WRITERS_IN_FLIGHT, NOWAIT). Once it commits, in-flight transactions that " +
      "predate it are refused at THEIR commit (40001) by the epoch's locking read.",
      "❌ IRREVERSIBLE IN BOTH SENSES. There is no old code to go back to and no old " +
      "meaning to restore: from this instant every terminal work order is judged " +
      "against the invariant. THIS IS THE LINE. Everything above it can be redeployed " +
      "away; nothing below it can.");
  }

  /* ═══ B9+ · THE SURFACE BOUNDARIES, AFTER THE LINE ═══════════════ */
  sec("B9–B13 · the reader, the rail, the contract — all AFTER the irreversible line");
  {
    const wo = await mkWo("open");
    await complete(wo, "b9");
    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: wo });
    ok("B9.1 the reader DERIVES its verdict — it stores nothing",
       s.proof.state === "satisfied", JSON.stringify(s.proof.state));
    const src = fs.readFileSync(path.join(ROOT, "src/release0/proof_state.js"), "utf8");
    ok("B9.2 …and contains no write of any kind",
       !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(src),
       "the reader writes, so reverting it would leave rows behind");

    verdict("B9–B13",
      "CODE ONLY for the reader, the HTTP contract and the app. migrations 138+139 " +
      "add DDL (an index and a widened check constraint) but write no rows.",
      "FULLY for the code. 138/139's DDL is additive and droppable; nothing depends " +
      "on it being present except the sweep, which REFUSES rather than misbehaves.",
      "Nothing. These are read paths and a manually-run rail.",
      "RESTORED — with one honest caveat: reverting the READER after the activation " +
      "returns the OLD RENDERING over a database that has already crossed the line. " +
      "Operators would see pre-Release-0 surfaces describing post-cutover truth. That " +
      "is the T4 state: degraded, not damaged, and the recovery is to roll FORWARD.");
  }

  // ── THE SHEET ─────────────────────────────────────────────────────
  sec("THE LINE, IN ONE PLACE");
  for (const r of sheet) {
    console.log(`\n  ${r.id}`);
    console.log(`     rollback:  ${r.rollback.split(".")[0]}.`);
    console.log(`     semantics: ${r.semantics.split(".")[0]}.`);
  }
  console.log("\n  ⚠ B8 IS THE LINE. Above it, a redeploy undoes the boundary but never");
  console.log("    the rows it wrote. Below it, nothing undoes anything.");

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
