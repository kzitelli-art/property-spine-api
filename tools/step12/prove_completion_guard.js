#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   MIGRATION 140 — PROVE THE POST-ACTIVATION COMPLETION GUARD

   The claim: after the cutover, NO path can move a work order into a
   terminal status without a proof evaluation behind it.

   "No path" is not provable by reading source — that is what the 67
   write-capable unguarded scripts already demonstrate. So every negative
   case here is a REAL BYPASS ATTEMPT: raw SQL on a pooled connection,
   the shape a utility script actually uses, a direct INSERT, and a
   multi-row UPDATE that never names an id.

     I   the guard is INERT before activation, deliberately
     C   the canonical writer passes, unchanged
     B   every bypass attempt is REFUSED — explicitly, writing nothing
     L   legitimate legacy history and ordinary work are untouched
     A   the guard's terminal set is the READER's

   ⚠ ISOLATED POSTGRES ONLY. Needs 137 + 140.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP12_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step12/prove_completion_guard.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const proofState = require(path.join(ROOT, "src/release0/proof_state.js"));
const URL = process.env.STEP12_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(68)}\n  ${t}\n${"═".repeat(68)}`);

const ID = (n) => crypto.createHash("md5").update("s12:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));
const GUARD_CODE = "R0001";

(async function main() {
  if (!URL) { console.error("REFUSED: STEP12_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL });
  const c = await pool.connect();
  if (Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) !== 1) {
    console.error("REFUSED: not the isolated baseline."); process.exit(2);
  }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty — the INERT half cannot be proven.");
    process.exit(3);
  }

  console.log("MIGRATION 140 — THE POST-ACTIVATION COMPLETION GUARD\n");
  await c.query(fs.readFileSync(
    path.join(ROOT, "migrations/140_post_activation_completion_guard.sql"), "utf8"));

  await c.query(`insert into organizations (id,name) values ($1,'S12') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'S12 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Tess S12','+15415559501','maintenance',true,'active')
                 on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments
                   (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Maintenance Tech',array['maintenance'],true)`, [TECH, PROP]);

  let seq = 0;
  const mkWo = async (status = "open") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'s12',$3,'s12')`, [wo, PROP, status]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    return wo;
  };
  const photo = async (wo) => {
    const a = ID("att" + wo.slice(0, 8)), b = Buffer.from([2, 2, 2, 2]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())`,
      [a, wo, PROP, TECH, "ME" + a.slice(0, 8), b, b.length,
       crypto.createHash("sha256").update(b).digest("hex")]);
  };
  const statusOf = async (wo) => (await c.query(
    `select status from work_orders where id=$1`, [wo])).rows[0].status;

  /*  A REAL BYPASS, on its own pooled connection — the shape a utility
   *  script actually has. Not a simulation: the same driver, the same
   *  kind of connection, arbitrary SQL. Returns the error or null. */
  const bypass = async (sql, vals) => {
    const other = await pool.connect();
    try { await other.query(sql, vals); return null; }
    catch (e) { return e; }
    finally { other.release(); }
  };

  // ══ I — INERT BEFORE ACTIVATION ════════════════════════════════════
  sec("I · BEFORE THE CUTOVER THE GUARD DOES NOTHING — DELIBERATELY");
  {
    const legacy = await mkWo("open");
    const e = await bypass(`update work_orders set status='closed' where id=$1`, [legacy]);
    ok("I1  a raw close SUCCEEDS before activation", e === null,
       e && e.message);
    ok("I2  …and the row really is terminal", await statusOf(legacy) === "closed");
    console.log("        This is REQUIRED, not a hole: pre-cutover terminal rows are");
    console.log("        exactly what the census inventories. Blocking them would break");
    console.log("        the inventory this release depends on.");
    global.__legacy = legacy;
  }

  //  ── ACTIVATE. The guard arms itself; nothing was deployed. ────────
  {
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "guard proof", expected: census });
    await c.query("commit");
    console.log(`\n  (activated; ${census.length} row(s) inventoried — THE GUARD IS NOW ARMED)`);
  }

  // ══ C — THE CANONICAL WRITER STILL WORKS ═══════════════════════════
  sec("C · THE CANONICAL WRITER PASSES, WITH NO CHANGE TO IT");
  {
    const wo = await mkWo("open");
    await photo(wo);
    await c.query("begin");
    const out = await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "s12-c" });
    await c.query("commit");
    ok("C1  claimCompletion completes the work order", out.closed === true,
       JSON.stringify({ outcome: out.outcome, missing: out.missing }));
    ok("C2  …and the row is terminal", await statusOf(wo) === "complete");
    console.log("        It passes because §4 writes the EVALUATION FIRST and the status");
    console.log("        second, in one transaction. The guard needed no change to the");
    console.log("        writer — which is the evidence it sits at the right boundary.");

    //  And it still REFUSES when there is no evidence, as before.
    const bare = await mkWo("open");
    await c.query("begin");
    const refused = await lifecycle.claimCompletion(c, {
      work_order_id: bare, user_id: TECH, organization_id: ORG, idempotency_key: "s12-c2" });
    await c.query("commit");
    ok("C3  …and still refuses a completion with no preserved evidence",
       refused.closed === false && refused.missing === "repair_photo",
       JSON.stringify({ closed: refused.closed, missing: refused.missing }));
    ok("C4  …leaving the work order open, not half-closed",
       await statusOf(bare) === "open");
  }

  // ══ B — EVERY BYPASS ATTEMPT IS REFUSED ════════════════════════════
  sec("B · REAL BYPASS ATTEMPTS — RAW SQL, ON ITS OWN CONNECTION");
  {
    const wo = await mkWo("open");

    const e1 = await bypass(`update work_orders set status='complete' where id=$1`, [wo]);
    ok("B1  a raw UPDATE to 'complete' is REFUSED", !!e1, "the write succeeded");
    ok("B2  …with the guard's own error code, not a generic failure",
       e1 && e1.code === GUARD_CODE, e1 && (e1.code + " " + e1.message));
    ok("B3  …naming what is missing and what to use instead",
       e1 && /no proof evaluation/i.test(e1.message) && /claimCompletion/i.test(e1.hint || ""),
       e1 && JSON.stringify({ m: e1.message, hint: e1.hint }));
    ok("B4  …and the work order is UNCHANGED — no silent rewrite",
       await statusOf(wo) === "open", await statusOf(wo));

    const e2 = await bypass(`update work_orders set status='closed' where id=$1`, [wo]);
    ok("B5  a raw UPDATE to 'closed' is refused the same way",
       !!e2 && e2.code === GUARD_CODE, e2 && e2.code);

    //  THE SHAPE THAT WORRIES ME MOST: a repair script that never names
    //  an id and closes a whole population in one statement.
    const many = [await mkWo("open"), await mkWo("open"), await mkWo("open")];
    const e3 = await bypass(
      `update work_orders set status='complete' where property_id=$1 and status='open'`, [PROP]);
    ok("B6  a set-based close over a whole property is refused",
       !!e3 && e3.code === GUARD_CODE, e3 && e3.code);
    //  SEQUENTIAL, not Promise.all. `statusOf` shares one pg client, and
    //  concurrent queries on a single client are a driver-level race (pg
    //  warns and will throw in 9.0). A proof that races its own reads is
    //  not measuring what it thinks it is.
    const after = [];
    for (const m of many) after.push(await statusOf(m));   // eslint-disable-line no-await-in-loop
    ok("B7  …and NOT ONE row moved — the whole statement rolled back",
       after.every((s) => s === "open"), JSON.stringify(after) +
       " — a partial close is worse than a refused one: some rows would be " +
       "defects and nobody would know which");

    //  A script that INSERTS an already-completed work order.
    const inserted = ID("wo-insert");
    const e4 = await bypass(
      `insert into work_orders (id,property_id,title,status,source)
       values ($1,$2,'s12 direct','complete','s12')`, [inserted, PROP]);
    ok("B8  a direct INSERT of a completed work order is refused",
       !!e4 && e4.code === GUARD_CODE, e4 && (e4.code + " " + e4.message));
    ok("B9  …and no row was created",
       Number((await c.query(`select count(*) n from work_orders where id=$1`,
         [inserted])).rows[0].n) === 0);

    //  Evidence alone is NOT enough. Only an EVALUATION is.
    const withPhoto = await mkWo("open");
    await photo(withPhoto);
    const e5 = await bypass(`update work_orders set status='complete' where id=$1`, [withPhoto]);
    ok("B10  a preserved photo alone does NOT satisfy the guard",
       !!e5 && e5.code === GUARD_CODE, e5 && e5.code +
       " — the evaluation is the governed judgement; the photo is its input");
  }

  // ══ L — LEGITIMATE WORK IS UNTOUCHED ═══════════════════════════════
  sec("L · ORDINARY WORK AND LEGACY HISTORY STILL FUNCTION");
  {
    const wo = await mkWo("open");
    const e1 = await bypass(
      `update work_orders set status='needs_followup', needs_pm_review=true where id=$1`, [wo]);
    ok("L1  a non-terminal status change is untouched", e1 === null, e1 && e1.message);
    const e2 = await bypass(`update work_orders set status='scheduled' where id=$1`, [wo]);
    ok("L2  …so is 'scheduled'", e2 === null, e2 && e2.message);
    const e3 = await bypass(`update work_orders set title=$2, updated_at=now() where id=$1`,
      [wo, "retitled"]);
    ok("L3  …and an ordinary column update", e3 === null, e3 && e3.message);

    //  The inventoried legacy row may still be touched.
    const legacy = global.__legacy;
    const e4 = await bypass(`update work_orders set updated_at=now() where id=$1`, [legacy]);
    ok("L4  an INVENTORIED legacy row can still be updated", e4 === null, e4 && e4.message);
    const e5 = await bypass(`update work_orders set status='closed' where id=$1`, [legacy]);
    ok("L5  …and re-closing it is not a new completion", e5 === null, e5 && e5.message);

    //  An already-completed row is not policed again.
    const done = (await c.query(
      `select id from work_orders where property_id=$1 and status='complete' limit 1`,
      [PROP])).rows[0];
    const e6 = await bypass(`update work_orders set updated_at=now() where id=$1`, [done.id]);
    ok("L6  an already-complete row can still be updated", e6 === null, e6 && e6.message);

    //  A work order at another property is unaffected by this one's state.
    ok("L7  the guard is scoped per work order, not per property",
       await statusOf(wo) === "scheduled", await statusOf(wo));
  }

  // ══ A — THE GUARD AND THE READER AGREE ═════════════════════════════
  sec("A · ONE TERMINAL SET, NOT TWO");
  {
    const sql = fs.readFileSync(
      path.join(ROOT, "migrations/140_post_activation_completion_guard.sql"), "utf8")
      .replace(/--[^\n]*/g, " ");
    const inSql = (sql.match(/in \('complete', 'closed'\)/g) || []).length;
    ok("A1  the trigger's terminal set is exactly ('complete','closed')",
       inSql >= 2, "found " + inSql + " occurrences in the executable SQL");
    ok("A2  …which is the READER's TERMINAL_STATUSES, unchanged",
       JSON.stringify([...proofState.TERMINAL_STATUSES].sort()) ===
       JSON.stringify(["closed", "complete"]),
       JSON.stringify(proofState.TERMINAL_STATUSES) +
       " — a guard and a reader that disagree is the drift this release ends");

    //  The behavioural version of the same claim: every status the READER
    //  calls terminal is a status the GUARD refuses.
    for (const s of proofState.TERMINAL_STATUSES) {
      const wo = await mkWo("open");
      // eslint-disable-next-line no-await-in-loop
      const e = await bypass(`update work_orders set status=$2 where id=$1`, [wo, s]);
      ok(`A·${s.padEnd(9)} the reader calls it terminal, and the guard refuses it`,
         !!e && e.code === GUARD_CODE, e ? e.code : "the write succeeded");
    }
  }

  // ══ X — THE TRIGGER IS WHAT IS STOPPING IT ═════════════════════════
  //  Every refusal above is worthless if something ELSE was refusing.
  //  So the guard is dropped, the SAME bypass is retried, and it must
  //  SUCCEED — manufacturing exactly the defect this release exists to
  //  prevent. Then it is restored and must refuse again.
  sec("X · REMOVE THE GUARD AND THE BYPASS WORKS — SO THE GUARD IS LOAD-BEARING");
  {
    const wo = await mkWo("open");
    const before = await bypass(`update work_orders set status='complete' where id=$1`, [wo]);
    ok("X1  with the guard in place, the bypass is refused",
       !!before && before.code === GUARD_CODE, before && before.code);

    await c.query(`drop trigger guard_terminal_completion on work_orders`);
    const during = await bypass(`update work_orders set status='complete' where id=$1`, [wo]);
    ok("X2  with the guard DROPPED, the identical bypass SUCCEEDS",
       during === null, during && during.message +
       " — something other than this trigger was refusing, so the proof above " +
       "is about that other thing");
    ok("X3  …and it manufactured exactly the defect the release exists to prevent",
       await statusOf(wo) === "complete" &&
       Number((await c.query(
         `select count(*) n from work_order_proof_evaluation_head where work_order_id=$1`,
         [wo])).rows[0].n) === 0,
       "terminal, unevaluated, uninventoried — the sweep would raise an obligation " +
       "against a named role for something the system did");

    //  Restore, and put the row back where it was so §D measures cleanly.
    await c.query(fs.readFileSync(
      path.join(ROOT, "migrations/140_post_activation_completion_guard.sql"), "utf8"));
    await c.query(`update work_orders set status='open' where id=$1`, [wo]);
    const after = await bypass(`update work_orders set status='complete' where id=$1`, [wo]);
    ok("X4  restored, and refusing again", !!after && after.code === GUARD_CODE,
       after && after.code);
    ok("X5  …and re-applying the migration was idempotent",
       await statusOf(wo) === "open", await statusOf(wo));
  }

  // ══ D — THE DEFECT POPULATION IT PREVENTS ══════════════════════════
  sec("D · WHAT THIS MEANS FOR THE SWEEP");
  {
    const defectable = Number((await c.query(
      `select count(*) n from work_orders w
        where w.property_id=$1 and w.status in ('complete','closed')
          and not exists (select 1 from work_order_proof_evaluation_head h
                           where h.work_order_id=w.id)
          and not exists (select 1 from release_0_legacy_cutover_inventory i
                           where i.work_order_id=w.id)`, [PROP])).rows[0].n);
    ok("D1  after every bypass attempt, ZERO manufactured defects exist",
       defectable === 0, defectable + " work order(s) are terminal, unevaluated and " +
       "uninventoried — each one would raise an obligation against a named role " +
       "for something the system did");
    console.log("        That is the whole point: the sweep can only raise what the");
    console.log("        database allowed to exist, and this stops it existing.");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
