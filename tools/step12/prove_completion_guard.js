#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   MIGRATION 140 — THE FORBIDDEN COMMITTED STATE

   The claim: after the cutover, no non-inventoried work order can COMMIT
   in the state the canonical reader calls `missing_evaluation_defect`.

   ── EVERY NEGATIVE CASE IS DIRECT SQL ───────────────────────────────

   Proving this through the application services would prove something
   about the services. The threat is the path that does not go through
   them: a repair script, a psql session, a route nobody has written yet.
   So every bypass below is raw SQL on its own pooled connection, and §Z
   re-checks the forbidden population directly rather than trusting any
   assertion above it.

     W   the exact terminal-writer inventory, frozen
     I   inert before activation
     D   DEFERRED — statement order is irrelevant, only the commit
     C   the canonical writer passes, unchanged
     B   direct-SQL bypasses are refused, and write nothing
     E   the two escape paths that SHOULD work still work
     K   concurrency
     V   what can still defeat it, measured
     X   drop the guard and the bypass works — it is load-bearing
     Z   independent census: zero forbidden rows exist

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
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const grounded = require("./grounded_evaluation.js");
const MIGRATION = path.join(ROOT, "migrations/140_post_activation_completion_guard.sql");
const URL = process.env.STEP12_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(68)}\n  ${t}\n${"═".repeat(68)}`);

const ID = (n) => crypto.createHash("md5").update("s12:" + n).digest("hex")
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
    console.error("REFUSED: activation history is not empty — §I cannot be proven.");
    process.exit(3);
  }

  console.log("MIGRATION 140 — THE FORBIDDEN COMMITTED STATE\n");
  await c.query(fs.readFileSync(MIGRATION, "utf8"));

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
    return a;
  };
  const statusOf = async (wo) => {
    const r = (await c.query(`select status from work_orders where id=$1`, [wo])).rows[0];
    return r ? r.status : null;
  };

  /*  REVISION 3 — `satisfied` IS NO LONGER A WORD YOU CAN JUST WRITE.
   *  The guard requires the head to CITE qualifying preserved evidence
   *  (R0004), so every "record a satisfied evaluation" step below has to
   *  produce the evidence AND the link. Returned as SQL strings because
   *  these sections deliberately go through raw `direct()` transactions
   *  rather than any service. */
  const groundedSql = async (wo) => {
    const att = await photo(wo);
    const ev = ID("ev-" + wo.slice(0, 8));
    return [
      `insert into work_order_proof_evaluations
         (id,work_order_id,property_id,state,evaluated_by_service,rule_version)
       values ('${ev}','${wo}','${PROP}','satisfied','s12','x')`,
      `insert into work_order_proof_evaluation_attachments
         (evaluation_id,attachment_id,work_order_id,property_id)
       values ('${ev}','${att}','${wo}','${PROP}')`,
    ];
  };

  /*  DIRECT SQL, on its own pooled connection — the shape a repair script
   *  or a psql session has. `sqls` runs as ONE transaction so a deferred
   *  refusal surfaces where it really would: at COMMIT. */
  const direct = async (sqls, vals) => {
    const o = await pool.connect();
    try {
      await o.query("begin");
      for (const s of [].concat(sqls)) await o.query(s, vals);
      await o.query("commit");
      return null;
    } catch (e) { await o.query("rollback").catch(() => {}); return e; }
    finally { o.release(); }
  };

  // ══ W — THE EXACT WRITER INVENTORY ═════════════════════════════════
  //  "67 write-capable scripts" is a capability warning, not the writer
  //  count. This is the set that can actually put a terminal status on a
  //  work order, and it is much smaller.
  sec("W · THE FROZEN TERMINAL-WRITER INVENTORY");
  {
    const inv = require("./terminal_writers.js");
    const found = inv.scan(ROOT);
    const shipped = found.filter((h) => h.shipped && h.terminalCapable);
    ok("W1  the scan found the shipped terminal-capable writers", shipped.length >= 1,
       "the scanner matched nothing — it has gone blind");
    for (const h of shipped) console.log(`        ${h.op}  ${String(h.value).padEnd(14)} ${h.rel}:${h.line}`);
    ok("W2  the shipped inventory is EXACTLY the frozen set",
       JSON.stringify(shipped.map((h) => h.rel).sort()) === JSON.stringify(inv.FROZEN_SHIPPED),
       "found " + JSON.stringify(shipped.map((h) => h.rel).sort()) +
       "\n          frozen " + JSON.stringify(inv.FROZEN_SHIPPED) +
       "\n          A NEW shipped path can write a terminal status. Read it, decide " +
       "whether it is legitimate, then update the frozen list deliberately.");
    ok("W3  no production utility or repair script writes a terminal status",
       found.filter((h) => h.terminalCapable && h.utility).length === 0,
       JSON.stringify(found.filter((h) => h.terminalCapable && h.utility).map((h) => h.rel)));
    console.log("        → the exposure is hand-run SQL and code not yet written,");
    console.log("          which is precisely what a script audit cannot fix.");
  }

  // ══ I — INERT BEFORE ACTIVATION ════════════════════════════════════
  sec("I · BEFORE THE CUTOVER THERE IS NO FORBIDDEN STATE");
  const legacyWo = await mkWo("open");
  {
    const e = await direct([`update work_orders set status='closed' where id=$1`], [legacyWo]);
    ok("I1  a direct close SUCCEEDS before activation", e === null, e && e.message);
    ok("I2  …and the row is terminal", await statusOf(legacyWo) === "closed");
    console.log("        Required, not a hole: with no activation the reader reports");
    console.log("        `unavailable`, never `defect`, and these rows are what the");
    console.log("        census inventories.");
  }

  {
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "guard proof", expected: census });
    await c.query("commit");
    console.log(`\n  (activated; ${census.length} row(s) inventoried — THE GUARD IS ARMED)`);
  }

  // ══ D — DEFERRED: ONLY THE COMMITTED STATE IS JUDGED ═══════════════
  sec("D · STATEMENT ORDER IS IRRELEVANT — ONLY THE COMMIT IS JUDGED");
  {
    //  THE CASE AN IMMEDIATE TRIGGER WOULD REFUSE. Terminal first,
    //  evidence second. This must be legal, or the guard is coupled to
    //  the canonical writer's current statement order and an innocuous
    //  refactor breaks production.
    const wo = await mkWo("open");
    const e = await direct([
      `update work_orders set status='complete' where id='${wo}'`,
      ...(await groundedSql(wo)),
    ]);
    ok("D1  terminal FIRST, evaluation AFTER — commits", e === null, e && e.message +
       "  — the guard is coupled to statement order; a refactor of the writer " +
       "would break production");
    ok("D2  …and the row really is complete", await statusOf(wo) === "complete");

    //  A transaction may PASS THROUGH the forbidden state.
    const wo2 = await mkWo("open");
    const e2 = await direct([
      `update work_orders set status='complete' where id='${wo2}'`,
      `update work_orders set status='open' where id='${wo2}'`,
    ]);
    ok("D3  passing THROUGH the forbidden state and leaving it — commits",
       e2 === null, e2 && e2.message);
    ok("D4  …and ends non-terminal", await statusOf(wo2) === "open");

    //  And the refusal really does arrive at COMMIT, not at the statement.
    const wo3 = await mkWo("open");
    const o = await pool.connect();
    let stmtErr = null, commitErr = null;
    try {
      await o.query("begin");
      try { await o.query(`update work_orders set status='complete' where id=$1`, [wo3]); }
      catch (e3) { stmtErr = e3; }
      try { await o.query("commit"); } catch (e4) { commitErr = e4; }
    } finally { await o.query("rollback").catch(() => {}); o.release(); }
    ok("D5  the offending STATEMENT succeeds…", stmtErr === null, stmtErr && stmtErr.message);
    ok("D6  …and the COMMIT is what refuses", !!commitErr && commitErr.code === CODE,
       commitErr && (commitErr.code + " " + commitErr.message));
    ok("D7  …leaving nothing behind", await statusOf(wo3) === "open", await statusOf(wo3));
  }

  // ══ C — THE CANONICAL WRITER ═══════════════════════════════════════
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

    const bare = await mkWo("open");
    await c.query("begin");
    const refused = await lifecycle.claimCompletion(c, {
      work_order_id: bare, user_id: TECH, organization_id: ORG, idempotency_key: "s12-c2" });
    await c.query("commit");
    ok("C3  …and still refuses a completion with no preserved evidence",
       refused.closed === false && refused.missing === "repair_photo",
       JSON.stringify({ closed: refused.closed, missing: refused.missing }));
    ok("C4  …leaving the work order open", await statusOf(bare) === "open");
    global.__done = wo;
  }

  // ══ B — DIRECT-SQL BYPASSES ════════════════════════════════════════
  sec("B · DIRECT SQL — REFUSED, AND NOTHING WRITTEN");
  {
    const wo = await mkWo("open");
    const e1 = await direct([`update work_orders set status='complete' where id=$1`], [wo]);
    ok("B1  a direct UPDATE to 'complete' is refused", !!e1, "it committed");
    ok("B2  …with the guard's own errcode", e1 && e1.code === CODE, e1 && e1.code);
    ok("B3  …naming the state and what to do instead",
       e1 && /missing_evaluation_defect/.test(e1.detail || "") &&
       /claimCompletion/.test(e1.hint || "") && /COMMIT is judged/i.test(e1.hint || ""),
       e1 && JSON.stringify({ d: e1.detail, h: e1.hint }));
    ok("B4  …and the row is UNCHANGED", await statusOf(wo) === "open", await statusOf(wo));

    /*  REVISION 3 — `closed` is refused for a DIFFERENT and stronger
     *  reason now, so asserting the same errcode would hide the change.
     *  R0001 means "terminal without proof"; R0003 means "`closed` is
     *  historical vocabulary and this is after the cutover" — which
     *  applies even WITH perfect proof (falsify_proof_trust D1). */
    const b5 = await direct([`update work_orders set status='closed' where id=$1`], [wo]);
    ok("B5  'closed' is refused too — and as HISTORICAL VOCABULARY, not for want of proof",
       !!b5 && b5.code === "R0003",
       (b5 ? b5.code + " " + b5.message : "it committed") +
       " — R0003 is the frozen Step 6 ruling: future completion writes `complete`");

    //  The shape that worries me most: a set-based repair that never
    //  names an id.
    const many = [await mkWo("open"), await mkWo("open"), await mkWo("open")];
    const e6 = await direct(
      [`update work_orders set status='complete' where property_id=$1 and status='open'`], [PROP]);
    ok("B6  a set-based close over a whole property is refused",
       !!e6 && e6.code === CODE, e6 && e6.code);
    const after = [];
    for (const m of many) after.push(await statusOf(m));
    ok("B7  …and NOT ONE row moved", after.every((s) => s === "open"), JSON.stringify(after) +
       " — a partial close is worse than a refused one: some rows would be defects " +
       "and nobody would know which");

    const ins = ID("wo-direct-insert");
    const e8 = await direct([`insert into work_orders (id,property_id,title,status,source)
                              values ('${ins}','${PROP}','s12 direct','complete','s12')`]);
    ok("B8  a direct INSERT of a completed work order is refused",
       !!e8 && e8.code === CODE, e8 && (e8.code + " " + e8.message));
    ok("B9  …and no row was created",
       Number((await c.query(`select count(*) n from work_orders where id=$1`, [ins])).rows[0].n) === 0);

    const withPhoto = await mkWo("open");
    await photo(withPhoto);
    ok("B10  a preserved PHOTO without an evaluation does not satisfy it",
       (await direct([`update work_orders set status='complete' where id=$1`], [withPhoto]) || {})
         .code === CODE,
       "the evaluation is the governed judgement; the photo is only its input");

    //  Savepoint: the offending write rolled back INSIDE the transaction
    //  must not queue a refusal for a state that no longer exists.
    const sp = await mkWo("open");
    const e11 = await direct([
      `savepoint s`,
      `update work_orders set status='complete' where id='${sp}'`,
      `rollback to savepoint s`,
    ]);
    ok("B11  a terminal write rolled back to a SAVEPOINT commits cleanly",
       e11 === null, e11 && e11.message +
       "  — the event should die with the subtransaction");
    ok("B12  …and the row is untouched", await statusOf(sp) === "open");
  }

  // ══ E — THE ESCAPES THAT SHOULD WORK ═══════════════════════════════
  //  A guard with no legitimate resolution path is a trap. There are
  //  exactly two, and both are the governed ones.
  sec("E · THE TWO LEGITIMATE WAYS OUT OF A REFUSAL");
  {
    const wo = await mkWo("open");
    //  1. record the evaluation in the same transaction
    //  `complete`, not `closed`: post-cutover `closed` is refused outright
    //  now (R0003), so the legitimate way out is the canonical vocabulary.
    const e1 = await direct([
      ...(await groundedSql(wo)),
      `update work_orders set status='complete' where id='${wo}'`,
    ]);
    ok("E1  recording a GROUNDED SATISFIED evaluation makes the completion legal",
       e1 === null, e1 && e1.message);
    /*  REVISION 2. This asserted the opposite — that a `not_satisfied`
     *  head was enough, "a judgement that WAS made". True, and beside the
     *  point: Release 0 governs COMPLETION, not whether somebody made a
     *  judgement. A1 in falsify_containment.js broke that reasoning by
     *  showing the reader then reports a completed work order as
     *  not_satisfied — a completion the system cannot stand behind. */
    const woFail = await mkWo("open");
    const e2 = await direct([
      `insert into work_order_proof_evaluations
         (work_order_id,property_id,state,evaluated_by_service,rule_version)
       values ('${woFail}','${PROP}','not_satisfied','s12','x')`,
      `update work_orders set status='complete' where id='${woFail}'`,
    ]);
    ok("E2  …and a `not_satisfied` head is NOT enough",
       !!e2 && e2.code === CODE,
       "a failed proof evaluation is valid data and does not justify a terminal status");

    //  2. do not leave it terminal
    const wo2 = await mkWo("open");
    const e3 = await direct([`update work_orders set status='needs_followup' where id=$1`], [wo2]);
    ok("E3  a non-terminal status is untouched by the guard", e3 === null, e3 && e3.message);

    //  Ordinary writes cost nothing and are unaffected.
    ok("E4  an ordinary column update on an open row is unaffected",
       (await direct([`update work_orders set title='retitled' where id=$1`], [wo2])) === null);
    ok("E5  …and on an INVENTORIED legacy row",
       (await direct([`update work_orders set title='legacy retitled' where id=$1`],
         [legacyWo])) === null);
    ok("E6  …and on a properly completed row",
       (await direct([`update work_orders set title='done retitled' where id=$1`],
         [global.__done])) === null);
  }

  // ══ K — CONCURRENCY ════════════════════════════════════════════════
  sec("K · A SECOND TRANSACTION CANNOT OPEN A HOLE");
  {
    //  T2 sets terminal while T1 holds an UNCOMMITTED evaluation. T2 must
    //  not be able to borrow evidence that has not committed.
    const wo = await mkWo("open");
    const t1 = await pool.connect(), t2 = await pool.connect();
    let t2err = null;
    try {
      await t1.query("begin");
      await t1.query(`insert into work_order_proof_evaluations
        (work_order_id,property_id,state,evaluated_by_service,rule_version)
        values ($1,$2,'satisfied','s12','x')`, [wo, PROP]);
      await t2.query("begin");
      await t2.query(`update work_orders set status='complete' where id=$1`, [wo]);
      try { await t2.query("commit"); } catch (e) { t2err = e; await t2.query("rollback").catch(() => {}); }
      await t1.query("rollback");
    } finally { t1.release(); t2.release(); }
    ok("K1  a transaction cannot borrow an UNCOMMITTED evaluation",
       !!t2err && t2err.code === CODE, t2err ? t2err.code : "it committed");
    ok("K2  …and the work order stayed open", await statusOf(wo) === "open");

    //  And the ordinary interleave: evaluation committed first, then a
    //  separate transaction closes it. Legal.
    const wo2 = await mkWo("open");
    await grounded.groundedSatisfied(c, {
      work_order_id: wo2, property_id: PROP, uploaded_by_user_id: TECH,
      evaluated_by_service: "s12" });
    ok("K3  a COMMITTED grounded evaluation makes a later separate close legal",
       (await direct([`update work_orders set status='complete' where id=$1`], [wo2])) === null);
  }

  // ══ V — WHAT CAN STILL DEFEAT IT ═══════════════════════════════════
  sec("V · THE BYPASS SURFACE, MEASURED RATHER THAN ASSUMED");
  {
    const wo = await mkWo("open");
    //  SET CONSTRAINTS ALL IMMEDIATE moves the check EARLIER. It is not
    //  a skip, and a reader of this trigger might reasonably fear it is.
    const e1 = await direct([
      `set constraints all immediate`,
      `update work_orders set status='complete' where id='${wo}'`,
    ]);
    ok("V1  SET CONSTRAINTS ALL IMMEDIATE does NOT bypass it",
       !!e1 && e1.code === CODE, e1 ? e1.code : "IT COMMITTED — the guard is optional");

    //  session_replication_role='replica' DOES disable constraint
    //  triggers. It is superuser-only, and the harness runs as superuser,
    //  so this measures the real bypass AND its privilege requirement.
    const su = (await c.query(
      `select rolsuper from pg_roles where rolname = current_user`)).rows[0].rolsuper;
    console.log("        (this harness connects as a "
      + (su ? "SUPERUSER — production does not" : "non-superuser") + ")");

    //  `drop role` alone fails while grants still depend on it, so the
    //  privileges go first. Cleaning up after itself matters: a probe role
    //  left behind is a login this harness created and nobody removed.
    await c.query(`drop owned by r0_guard_probe`).catch(() => {});
    await c.query(`drop role if exists r0_guard_probe`);
    await c.query(`create role r0_guard_probe login password 'probe'`);
    await c.query(`grant all on work_orders, work_order_proof_evaluations,
                     release_0_legacy_cutover_inventory to r0_guard_probe`);
    await c.query(`grant select on release_0_activation_current,
                     work_order_proof_evaluation_head to r0_guard_probe`);
    const appPool = new Pool({ connectionString:
      URL.replace("postgres@", "r0_guard_probe:probe@") });
    let denied = null;
    try {
      const a = await appPool.connect();
      try {
        await a.query("begin");
        await a.query(`set local session_replication_role = 'replica'`);
        await a.query("commit");
      } catch (e) { denied = e; await a.query("rollback").catch(() => {}); }
      finally { a.release(); }
    } finally { await appPool.end(); }
    ok("V2  a NON-SUPERUSER role cannot set session_replication_role",
       !!denied && /permission denied/i.test(denied.message),
       denied ? denied.message : "IT SUCCEEDED — the guard is bypassable by anything " +
       "holding DATABASE_URL, and the containment is not real");
    console.log("        → the documented bypass requires SUPERUSER. Every script,");
    console.log("          route and psql session using DATABASE_URL is covered.");
    await c.query(`drop owned by r0_guard_probe`).catch(() => {});
    await c.query(`drop role if exists r0_guard_probe`);
    ok("V3  …and the probe role was cleaned up",
       Number((await c.query(`select count(*) n from pg_roles where rolname='r0_guard_probe'`))
         .rows[0].n) === 0,
       "a login this harness created is still present");
  }

  // ══ X — THE GUARD IS LOAD-BEARING ══════════════════════════════════
  sec("X · DROP IT AND THE BYPASS WORKS");
  {
    const wo = await mkWo("open");
    ok("X1  with the guard installed, the bypass is refused",
       (await direct([`update work_orders set status='complete' where id=$1`], [wo]) || {})
         .code === CODE);

    await c.query(`drop trigger assert_completion_truth_upd on work_orders`);
    const during = await direct([`update work_orders set status='complete' where id=$1`], [wo]);
    ok("X2  with the guard DROPPED, the identical bypass SUCCEEDS", during === null,
       during && during.message + " — something OTHER than this trigger was refusing, " +
       "so everything above is about that other thing");

    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: wo });
    ok("X3  …and the READER classifies it exactly as the forbidden state",
       s.proof.state === "missing_evaluation_defect", JSON.stringify(s.proof.state) +
       " — this is the state the guard exists to make impossible, confirmed by the " +
       "canonical reader rather than by this file's own opinion");

    await c.query(fs.readFileSync(MIGRATION, "utf8"));
    await c.query(`update work_orders set status='open' where id=$1`, [wo]);
    ok("X4  restored, and refusing again",
       (await direct([`update work_orders set status='complete' where id=$1`], [wo]) || {})
         .code === CODE);
    ok("X5  …re-applying the migration was idempotent", await statusOf(wo) === "open");
  }

  // ══ Z — INDEPENDENT CENSUS ═════════════════════════════════════════
  //  Not "every assertion passed". The forbidden population itself,
  //  counted directly, plus the reader's own verdict on every row.
  sec("Z · ZERO FORBIDDEN ROWS EXIST");
  {
    const forbidden = Number((await c.query(
      `select count(*) n from work_orders w
        where w.property_id = $1 and w.status in ('complete','closed')
          and not exists (select 1 from work_order_proof_evaluation_head h
                           where h.work_order_id = w.id and h.property_id = w.property_id)
          and not exists (select 1 from release_0_legacy_cutover_inventory i
                           where i.work_order_id = w.id and i.property_id = w.property_id)`,
      [PROP])).rows[0].n);
    ok("Z1  the SQL census finds no forbidden committed state", forbidden === 0,
       forbidden + " row(s) — each would raise an obligation against a named role");

    const rows = (await c.query(
      `select id from work_orders where property_id=$1 order by id`, [PROP])).rows;
    const defects = [];
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: r.id });
      if (s && s.proof.state === "missing_evaluation_defect") defects.push(r.id);
    }
    ok("Z2  and the CANONICAL READER agrees, row by row", defects.length === 0,
       defects.join(", ") + " — the guard and the reader disagree about what exists");
    console.log(`        ${rows.length} work orders read through the reader; 0 defects.`);
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
