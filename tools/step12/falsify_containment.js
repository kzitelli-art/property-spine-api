#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   ATTACK THE RELATIONAL INVARIANT, NOT THE STATUS-ONLY BYPASS

   `prove_completion_guard.js` answers "can old code write `closed`?".
   That is no longer the question. This one is:

     Can any sequence of INDIVIDUALLY LEGAL writes leave a
     post-activation work order terminal while the system cannot
     truthfully stand behind the completion?

   Six adversarial cases, each an owner-specified attack on the
   containment claim rather than on a rogue writer.

     A1  terminal + a current `not_satisfied` evaluation
     A2  the proof head changes AFTER completion (cross-table)
     A3  legacy exemption laundering: closed → open → closed
     A4  a transaction that STRADDLES activation
     A5  the DDL escape: who can actually drop the guard
     A6  unknown status vocabulary — where does the work go?

   ── PREDICTIONS ARE RECORDED BEFORE THE RESULT ──────────────────────

   Each case prints what I expect BEFORE it runs. A falsification whose
   author only writes down the outcome cannot be caught predicting
   wrongly, and being caught is the point.

   ── THIS FILE ASSERTS THE INVARIANT, NOT THE IMPLEMENTATION ─────────

   Every verdict is the CANONICAL READER's, or a direct SQL census of
   the forbidden population. It never asks the trigger whether the
   trigger is happy.

   ⚠ ISOLATED POSTGRES ONLY. Needs 137 + 140.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP12_DATABASE_URL='...' node tools/step12/falsify_containment.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const MIGRATION = path.join(ROOT, "migrations/140_post_activation_completion_guard.sql");
const URL = process.env.STEP12_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const predict = (t) => console.log("  predicted: " + t);

const ID = (n) => crypto.createHash("md5").update("s12f:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));
const CODE = "R0001";

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
    console.error("REFUSED: activation history is not empty — A4 needs the pre-activation world.");
    process.exit(3);
  }

  console.log("ATTACK THE RELATIONAL INVARIANT — migration 140\n");
  await c.query(fs.readFileSync(MIGRATION, "utf8"));

  await c.query(`insert into organizations (id,name) values ($1,'S12F') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'S12F Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Tess F','+15415559601','maintenance',true,'active')
                 on conflict (id) do nothing`, [TECH]);

  let seq = 0;
  const mkWo = async (status = "open") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'s12f',$3,'s12f')`, [wo, PROP, status]);
    return wo;
  };
  const statusOf = async (wo) => {
    const r = (await c.query(`select status from work_orders where id=$1`, [wo])).rows[0];
    return r ? r.status : null;
  };
  const readState = async (wo) => {
    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: wo });
    return s ? { life: s.current.state, proof: s.proof.state, rs: s.proof.read_status } : null;
  };
  const direct = async (sqls, opts) => {
    const o = await pool.connect();
    try {
      await o.query(`begin${opts && opts.iso ? " isolation level " + opts.iso : ""}`);
      for (const s of [].concat(sqls)) await o.query(s);
      await o.query("commit");
      return null;
    } catch (e) { await o.query("rollback").catch(() => {}); return e; }
    finally { o.release(); }
  };
  const evalSql = (wo, state, supersedes) =>
    `insert into work_order_proof_evaluations
       (work_order_id,property_id,state,evaluated_by_service,rule_version,supersedes_id)
     values ('${wo}','${PROP}','${state}','s12f','x',${supersedes ? `'${supersedes}'` : "null"})`;

  /*  REVISION 3 — a `satisfied` head must CITE qualifying evidence
   *  (R0004), so the CONTROL for a cross-table attack has to be a real
   *  completion, not a written word. `not_satisfied` still needs none: it
   *  is a refusal, and requiring proof of the thing being refused would
   *  be nonsense. Returns SQL because these attacks deliberately go
   *  through raw transactions rather than any service. */
  const groundedEvalSql = async (wo) => {
    const att = ID("att-" + wo.slice(0, 8));
    const b = Buffer.from([6, 6, 6, 6]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())
      on conflict (id) do nothing`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), b, b.length,
       crypto.createHash("sha256").update(b).digest("hex")]);
    const ev = ID("ev-" + wo.slice(0, 8));
    return [
      `insert into work_order_proof_evaluations
         (id,work_order_id,property_id,state,evaluated_by_service,rule_version)
       values ('${ev}','${wo}','${PROP}','satisfied','s12f','x')`,
      `insert into work_order_proof_evaluation_attachments
         (evaluation_id,attachment_id,work_order_id,property_id)
       values ('${ev}','${att}','${wo}','${PROP}')`,
    ];
  };

  //  A pre-activation legacy row for A3, and the census population.
  const legacyWo = await mkWo("closed");

  //  ══ A4 — THE STRADDLING TRANSACTION ══════════════════════════════
  sec("A4 · A TRANSACTION THAT STRADDLES ACTIVATION");
  predict("READ COMMITTED: the deferred check takes a fresh snapshot at COMMIT and\n"
        + "             refuses. REPEATABLE READ: the snapshot is frozen before the\n"
        + "             activation existed, so the trigger sees the pre-cutover world and\n"
        + "             COMMITS — MEASURED, and NOT fixable inside the trigger, because no\n"
        + "             SELECT escapes its own snapshot.\n"
        + "             So the fix is on the other side: recordActivation now takes SHARE\n"
        + "             ROW EXCLUSIVE on work_orders and should REFUSE to activate at all\n"
        + "             while any writer is in flight.");
  const straddleUpd = await mkWo("open");

  //  A writer that opened before the cutover and has not committed.
  const txUpd = await (async () => {
    const o = await pool.connect();
    await o.query("begin isolation level repeatable read");
    await o.query(`select count(*) from release_0_activation_current`);
    await o.query(`update work_orders set status='complete' where id='${straddleUpd}'`);
    return o;
  })();

  {
    //  THE FIX, EXERCISED AS THE RELEASE RUNS IT.
    const census = await activation.readLegacyTerminalSet(c);
    let blocked = null;
    await c.query("begin");
    try {
      await activation.recordActivation(c, {
        activated_at: CUTOVER, captured_by: "falsify containment", expected: census });
    } catch (e) { blocked = e; }
    await c.query("rollback");
    ok("A4.1  the activation REFUSES while a work_orders writer is in flight",
       !!blocked && blocked.code === "WRITERS_IN_FLIGHT",
       blocked ? blocked.code + " " + blocked.message
               : "IT ACTIVATED PAST AN OPEN WRITER — the straddle window is open, and " +
                 "the trigger cannot close it because the writer's snapshot predates " +
                 "the activation");
    console.log("        → not fixable in the trigger: no SELECT escapes its own snapshot.");
    console.log("          The activation is the one act we control, so it serializes.");

    //  Let the writer finish, then activate cleanly.
    await txUpd.query("rollback").catch(() => {});
    txUpd.release();
    const census2 = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "falsify containment", expected: census2 });
    await c.query("commit");
    console.log(`\n  (writer drained, then activated; ${census2.length} row(s) inventoried)`);
    ok("A4.2  …and once no writer is in flight, the activation succeeds",
       Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) === 1);
  }

  //  ══ A7 — THE ACTIVATION REFUSES WITHOUT THE GUARD ════════════════
  sec("A7 · THE ACTIVATION WILL NOT EXIST WITHOUT THE CONTAINMENT BOUNDARY");
  predict("detecting a missing guard AFTER activation is useless — activation is\n"
        + "             irreversible. recordActivation should refuse when the predicate is\n"
        + "             absent, and also when it is present with the WRONG BODY, since a\n"
        + "             stale function with the right name reads as protection.");
  {
    //  A second activation is refused for its own reasons, so this
    //  measures the PRECONDITION on a clean instance of the check.
    const probe = async () => {
      try { await activation.assertGuardForProof(c); return null; } catch (e) { return e; }
    };
    //  The service does not export the checker, so exercise it the way the
    //  activation does: through recordActivation on a rolled-back transaction.
    const attempt = async () => {
      await c.query("begin");
      let err = null;
      try {
        await activation.recordActivation(c, {
          activated_at: CUTOVER, captured_by: "probe", expected: [] });
      } catch (e) { err = e; }
      await c.query("rollback");
      return err;
    };

    await c.query(`drop trigger assert_completion_truth_ins on work_orders`);
    const e1 = await attempt();
    ok("A7.1  a MISSING containment trigger refuses the activation",
       !!e1 && e1.code === "GUARD_ABSENT", e1 && (e1.code + " " + e1.message));
    await c.query(fs.readFileSync(MIGRATION, "utf8"));

    //  A hollowed-out predicate with the RIGHT NAME.
    await c.query(`create or replace function public.release_0_assert_completion_truth(p_work_order uuid)
                   returns void as $$ begin return; end; $$ language plpgsql`);
    const e2 = await attempt();
    ok("A7.2  a hollowed-out predicate with the right NAME is refused",
       !!e2 && e2.code === "GUARD_STALE", e2 && (e2.code + " " + e2.message));
    console.log("        → a guard with the right name and the wrong body is worse than");
    console.log("          none, because it reads as protection.");
    await c.query(fs.readFileSync(MIGRATION, "utf8"));

    const e3 = await attempt();
    ok("A7.3  …and with the real guard restored, the precondition passes",
       !e3 || (e3.code !== "GUARD_ABSENT" && e3.code !== "GUARD_STALE"),
       e3 && (e3.code + " " + e3.message));
  }

  // ══ A1 — TERMINAL + A FAILED EVALUATION ════════════════════════════
  sec("A1 · TERMINAL WITH A CURRENT `not_satisfied` EVALUATION");
  predict("the guard ALLOWS it today (it accepts any head). The reader will then\n"
        + "             report status=complete with proof.state=not_satisfied — a completion\n"
        + "             the system cannot stand behind, reached without ever touching\n"
        + "             missing_evaluation_defect.");
  {
    const wo = await mkWo("open");
    const e = await direct([evalSql(wo, "not_satisfied"),
                            `update work_orders set status='complete' where id='${wo}'`]);
    const st = await readState(wo);
    console.log("  observed:  guard " + (e ? "REFUSED (" + e.code + ")" : "ALLOWED")
      + "   reader → " + JSON.stringify(st));
    ok("A1.1  a terminal work order cannot rest on a FAILED evaluation",
       !!e && e.code === CODE,
       "committed as " + JSON.stringify(st) + "\n          Release 0 governs COMPLETION, " +
       "not whether somebody made a judgement. A failed proof evaluation is valid data " +
       "and is NOT sufficient to justify status='complete'.");
    ok("A1.2  …and the reader does not report a completed work order as not_satisfied",
       !st || !(st.life === "completed" && st.proof === "not_satisfied"),
       JSON.stringify(st));
  }

  // ══ A2 — THE PROOF HEAD MOVES AFTER COMPLETION ═════════════════════
  sec("A2 · THE PROOF HEAD CHANGES AFTER COMPLETION (CROSS-TABLE)");
  predict("the trigger fires only on work_orders, so superseding a satisfied head\n"
        + "             with a not_satisfied one — touching NO work-order row — should slip\n"
        + "             straight past it. If so, the invariant is cross-table and a\n"
        + "             work-order trigger alone cannot hold it.");
  {
    const wo = await mkWo("open");
    const setup = await direct([...(await groundedEvalSql(wo)),
                                `update work_orders set status='complete' where id='${wo}'`]);
    ok("A2.0  the control starts legal: complete, satisfied", setup === null &&
       (await readState(wo)).proof === "satisfied", setup && setup.message);
    const head = (await c.query(
      `select id from work_order_proof_evaluation_head where work_order_id=$1`, [wo])).rows[0];

    const e = await direct([evalSql(wo, "not_satisfied", head.id)]);
    const st = await readState(wo);
    console.log("  observed:  supersede " + (e ? "REFUSED (" + e.code + ")" : "ALLOWED")
      + "   reader → " + JSON.stringify(st));
    ok("A2.1  the proof head cannot be flipped out from under a terminal work order",
       !!e && e.code === CODE,
       "committed as " + JSON.stringify(st) + "\n          The guard passed when the " +
       "work order was written and has no say afterwards. This is a CROSS-TABLE " +
       "invariant and a work_orders trigger alone does not hold it.");
    ok("A2.2  …so a completed work order still reads `satisfied`",
       (await readState(wo)).proof === "satisfied", JSON.stringify(await readState(wo)));
  }

  // ══ A3 — LEGACY EXEMPTION LAUNDERING ═══════════════════════════════
  sec("A3 · LEGACY EXEMPTION LAUNDERING — closed → open → closed");
  predict("the inventory row is immutable and the guard exempts by membership, so\n"
        + "             the exemption is PERMANENT. Reopening and re-closing an inventoried\n"
        + "             row post-activation should be allowed, laundering a NEW completion\n"
        + "             into `legacy_indeterminate` with no evaluation at all.");
  {
    const before = await readState(legacyWo);
    ok("A3.0  the control is an inventoried legacy row", before.proof === "legacy_indeterminate",
       JSON.stringify(before));

    const e1 = await direct([`update work_orders set status='open' where id='${legacyWo}'`]);
    console.log("  reopen:    " + (e1 ? "REFUSED (" + e1.code + ")" : "ALLOWED"));
    const e2 = e1 ? null : await direct([`update work_orders set status='closed' where id='${legacyWo}'`]);
    const st = await readState(legacyWo);
    console.log("  re-close:  " + (e1 ? "(not attempted)" : e2 ? "REFUSED (" + e2.code + ")" : "ALLOWED")
      + "   reader → " + JSON.stringify(st));

    ok("A3.1  an inventoried row cannot be re-terminalized without an evaluation",
       !!e1 || !!e2,
       "closed → open → closed succeeded with NO evaluation, and the reader still calls " +
       "it " + JSON.stringify(st && st.proof) + ".\n          Historical grandfathering " +
       "has become a permanent future bypass: any work order in the inventory is a " +
       "reusable licence to complete work without proof.");
    ok("A3.2  …and it did not end terminal-without-evidence",
       !(await statusOf(legacyWo) === "closed" &&
         Number((await c.query(`select count(*) n from work_order_proof_evaluation_head
                                 where work_order_id=$1`, [legacyWo])).rows[0].n) === 0 &&
         !!e1 === false && !!e2 === false),
       "laundered");
  }

  // ══ A5 — THE DDL ESCAPE, EXACTLY ═══════════════════════════════════
  sec("A5 · WHO CAN ACTUALLY DROP THE GUARD");
  predict("a non-superuser cannot set session_replication_role (already proven), but\n"
        + "             the TABLE OWNER can DROP TRIGGER without being a superuser. If the\n"
        + "             runtime DATABASE_URL role owns work_orders, the honest claim is\n"
        + "             'accidental DML bypass prevented; privileged DDL remains an\n"
        + "             auditable escape' — not 'everything holding DATABASE_URL is covered'.");
  {
    await c.query(`drop owned by r0_owner_probe`).catch(() => {});
    await c.query(`drop role if exists r0_owner_probe`);
    await c.query(`create role r0_owner_probe login password 'probe'`);
    await c.query(`grant all on work_orders to r0_owner_probe`);
    //  A role that OWNS the table — the shape a managed-Postgres app role
    //  usually has.
    await c.query(`alter table work_orders owner to r0_owner_probe`);
    const p = new Pool({ connectionString: URL.replace("postgres@", "r0_owner_probe:probe@") });
    let dropped = null;
    try {
      const o = await p.connect();
      //  THE CURRENT names. An earlier revision named a trigger that no
      //  longer exists, and the DROP failed with 42704 (undefined_object)
      //  — which this test then reported as "the owner CANNOT drop it".
      //  A false reassurance, caught only because A5.2 checks the guard is
      //  still installed afterwards.
      try { await o.query(`drop trigger assert_completion_truth_upd on work_orders`); }
      catch (e) { dropped = e; }
      finally { o.release(); }
    } finally { await p.end(); }
    console.log("  observed:  a non-superuser TABLE OWNER "
      + (dropped ? "CANNOT drop it (" + dropped.code + ")" : "CAN drop the trigger"));
    ok("A5.1  the DDL escape is recorded honestly, whichever way it went", true);
    global.__ownerCanDrop = !dropped;
    //  Restore whatever we changed.
    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    await c.query(`alter table work_orders owner to postgres`);
    await c.query(`drop owned by r0_owner_probe`).catch(() => {});
    await c.query(`drop role if exists r0_owner_probe`);
    ok("A5.2  …and the guard is reinstalled afterwards",
       Number((await c.query(`select count(*) n from pg_trigger t join pg_class k on k.oid=t.tgrelid
                               where k.relname='work_orders'
                                 and t.tgname in ('assert_completion_truth_ins',
                                                  'assert_completion_truth_upd')`)).rows[0].n) === 2,
       "the DROP probe left the guard off, or the trigger names in this test are stale " +
       "— a stale name makes the DROP fail with 42704 and this test then reports 'the " +
       "owner cannot drop it', which is a FALSE REASSURANCE");
  }

  // ══ A6 — UNKNOWN STATUS VOCABULARY ═════════════════════════════════
  sec("A6 · AN UNKNOWN STATUS — WHERE DOES THE WORK GO?");
  predict("'Complete' is neither terminal (so the guard and the sweep ignore it) nor\n"
        + "             open. If the operator list also drops it, the work order is INVISIBLE:\n"
        + "             not lost data, but lost WORK — worse than an untidy row.");
  {
    const wo = await mkWo("open");
    const e = await direct([`update work_orders set status='Complete' where id='${wo}'`]);
    ok("A6.1  the guard does not refuse an unknown status", e === null,
       "it refused: " + (e && e.code) + " — then the vocabulary is already closed");
    const st = await readState(wo);
    console.log("  reader →  " + JSON.stringify(st));

    //  Does it still appear in the operator's list read?
    const list = await reader.readPropertyWorkOrderStatuses(c, { propertyId: PROP, limit: 200 });
    const present = list.some((r) => r.work_order.id === wo);
    ok("A6.2  …and the work order is STILL VISIBLE on the operator list",
       present, "it vanished from the operator surface — this is lost WORK, not an " +
       "untidy row, and it is why the vocabulary question is not merely cosmetic");
    console.log("  lifecycle state the operator sees: "
      + JSON.stringify(st && st.life) + "   proof: " + JSON.stringify(st && st.proof));
    await c.query(`update work_orders set status='open' where id=$1`, [wo]);
  }

  // ══ Z — THE FORBIDDEN POPULATION, INDEPENDENTLY ════════════════════
  sec("Z · WHAT ACTUALLY EXISTS NOW");
  {
    const rows = (await c.query(
      `select id, status from work_orders where property_id=$1 order by id`, [PROP])).rows;
    const bad = [];
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      const s = await readState(r.id);
      if (s && s.life === "completed" && s.proof !== "satisfied") bad.push({ id: r.id, ...s });
      if (s && s.proof === "missing_evaluation_defect") bad.push({ id: r.id, ...s });
    }
    ok("Z1  no work order reads as completed without a satisfied proof",
       bad.length === 0, JSON.stringify(bad, null, 1));
    console.log(`        ${rows.length} work orders read through the canonical reader.`);
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  console.log(fail === 0
    ? "\n  the containment claim survived every attack.\n"
    : `\n  ${fail} attack(s) SUCCEEDED. The invariant is wrong, not the caller.\n`);
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
