#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   §4.2 — PROVE THE DEFECT OBLIGATION'S FULL LIFECYCLE

   The sweep proof covered creation. This covers the rest:

     C   closure, and the refusal to close over a defect that persists
     A   caller (a) — the canonical writer noticing a terminal row it did
         not evaluate
     M   there is NO manual closure path
     R   the resolution vocabulary, including the one 139 had to add

   ── THE ASSERTION THAT MATTERS MOST ─────────────────────────────────

   `resolveProofEvaluationDefect` takes NO resolution code. It derives one
   from the database and REFUSES when neither §4.2 condition holds. A
   service that accepted a code from its caller would make "closes only on
   genuine resolution" a comment: any caller could say 'satisfied' and the
   obligation would close over a defect still sitting there.

   ⚠ ISOLATED POSTGRES ONLY. Needs 137 + 138 + 139.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP9_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step9/prove_defect_lifecycle.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const defect = require(path.join(ROOT, "src/maintenance/proof_defect_service.js"));
const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
//  migration 140 REFUSES to let recordActivation run without it, so a
//  harness that activates must install it. States the guard forbids are
//  then built inside an explicit withGuardOff() window.
const guardWindow = require("../step12/guard_window.js");
const grounded = require("../step12/grounded_evaluation.js");
const URL = process.env.STEP9_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const ID = (n) => crypto.createHash("md5").update("s9life:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const STEP6_INSTANT = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: STEP9_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL });
  const c = await pool.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty — rebuild the baseline.");
    process.exit(3);
  }

  console.log("§4.2 — DEFECT OBLIGATION LIFECYCLE — isolated postgres\n");
  for (const m of ["138_proof_evaluation_defect_obligation.sql",
                   "139_no_longer_applicable_resolution.sql"]) {
    await c.query(fs.readFileSync(path.join(ROOT, "migrations", m), "utf8"));
  }
  /*  Every defect this file raises and then resolves starts from a state
   *  migration 140 refuses to let commit. Installed before the activation
   *  below (it is inert until then) so each of those starting states has
   *  to be built in a named window. */
  await guardWindow.installGuard(c);
  const forbidden = (why, fn) => guardWindow.withGuardOff(c, why, fn);

  await c.query(`insert into organizations (id,name) values ($1,'L9 Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'L9 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Lee Life','+15415559701','maintenance',true) on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments (user_id,property_id,role_title,active)
                 values ($1,$2,'Maintenance Tech',true)`, [TECH, PROP]).catch(() => {});

  let seq = 0;
  const mkWo = async (status = "closed") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'s9life',$3,'s9lifeproof')`, [wo, PROP, status]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    return wo;
  };
  const photo = async (wo) => {
    const att = ID("att" + wo.slice(0, 8)), b = Buffer.from([4, 4, 4, 4]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), b, b.length,
       crypto.createHash("sha256").update(b).digest("hex")]);
  };
  const openDefects = async (wo) => Number((await c.query(
    `select count(*) n from obligations where type='proof_evaluation_missing'
      and related_id=$1 and status <> 'complete'`, [wo])).rows[0].n);
  const closedDefect = async (wo) => (await c.query(
    `select status, resolution_code, completed_at from obligations
      where type='proof_evaluation_missing' and related_id=$1`, [wo])).rows[0];

  //  Activate with an empty legacy set, so every terminal row from here on
  //  is a genuine post-cutover defect.
  const census = await activation.readLegacyTerminalSet(c);
  await c.query("begin");
  await activation.recordActivation(c, {
    activated_at: STEP6_INSTANT, captured_by: "lifecycle proof", expected: census });
  await c.query("commit");

  // ══ R — THE RESOLUTION VOCABULARY ══════════════════════════════════
  sec("R · MIGRATION 139 — THE CODE §4.2 NEEDS THAT 084 DID NOT ALLOW");
  {
    /*  `complete`, not `closed`. Both are post-cutover defects, but a
     *  `closed` row cannot be repaired by recording proof — R0003 refuses
     *  post-cutover `closed` outright, so its only resolution is to leave
     *  that status. Section C's story is "the evaluation arrives and the
     *  obligation closes as satisfied", which needs a row where that is
     *  actually the repair. */
    const wo = await forbidden(
      "R/C need a real defect to raise and then resolve; the guard forbids creating one",
      () => mkWo("complete"));
    await c.query("begin");
    await defect.raiseProofEvaluationDefect(c, { work_order_id: wo, property_id: PROP });
    await c.query("commit");

    //  Before 139 this exact update was refused by ck_oblig_resolution_code.
    let allowed = true;
    try {
      await c.query("begin");
      await c.query(`update obligations set status='complete', completed_at=now(),
                       resolution_code='no_longer_applicable'
                      where type='proof_evaluation_missing' and related_id=$1`, [wo]);
      await c.query("rollback");
    } catch (e) { allowed = false; await c.query("rollback").catch(() => {}); }
    ok("R1  'no_longer_applicable' is now a permitted resolution_code", allowed,
       "migration 139 did not apply, or the constraint still refuses it");

    let bogus = false;
    try {
      await c.query("begin");
      await c.query(`update obligations set status='complete', completed_at=now(),
                       resolution_code='dismissed_by_operator'
                      where type='proof_evaluation_missing' and related_id=$1`, [wo]);
      await c.query("rollback");
    } catch (e) { bogus = true; await c.query("rollback").catch(() => {}); }
    ok("R2  …and the vocabulary is STILL closed — an invented code is refused",
       bogus, "139 widened the vocabulary into a free-text field");
    global.__persistWo = wo;
  }

  // ══ C — CLOSURE, AND THE REFUSAL ═══════════════════════════════════
  sec("C · IT CLOSES ONLY ON GENUINE RESOLUTION");
  {
    //  1. The defect PERSISTS: terminal, still no evaluation.
    const persistWo = global.__persistWo;
    await c.query("begin");
    const refused = await defect.resolveProofEvaluationDefect(c, {
      work_order_id: persistWo, property_id: PROP });
    await c.query("commit");
    ok("C1  a still-terminal, still-unevaluated work order REFUSES to close",
       refused.outcome === "refused" && refused.refusal === "defect_persists",
       JSON.stringify(refused));
    ok("C2  …and the obligation is untouched", await openDefects(persistWo) === 1);
    console.log("        → " + refused.detail);

    //  2. THE EVALUATION ARRIVES → 'satisfied'.
    await grounded.groundedSatisfied(c, {
      work_order_id: persistWo, property_id: PROP, uploaded_by_user_id: TECH,
      evaluated_by_service: "s9lifeproof" });
    await c.query("begin");
    const sat = await defect.resolveProofEvaluationDefect(c, {
      work_order_id: persistWo, property_id: PROP });
    await c.query("commit");
    ok("C3  once an evaluation head exists it closes as 'satisfied'",
       sat.outcome === "closed" && sat.resolution_code === "satisfied", JSON.stringify(sat));
    const row = await closedDefect(persistWo);
    ok("C4  …with status complete, a completed_at and the resolution recorded",
       row.status === "complete" && !!row.completed_at && row.resolution_code === "satisfied",
       JSON.stringify(row));

    //  3. NO LONGER TERMINAL → 'no_longer_applicable'.
    const reopened = await forbidden(
      "C5 needs a defect that later leaves the terminal state",
      () => mkWo("closed"));
    await c.query("begin");
    await defect.raiseProofEvaluationDefect(c, { work_order_id: reopened, property_id: PROP });
    await c.query("commit");
    await c.query(`update work_orders set status='open' where id=$1`, [reopened]);
    await c.query("begin");
    const nla = await defect.resolveProofEvaluationDefect(c, {
      work_order_id: reopened, property_id: PROP });
    await c.query("commit");
    ok("C5  a work order that leaves the terminal state closes as 'no_longer_applicable'",
       nla.outcome === "closed" && nla.resolution_code === "no_longer_applicable",
       JSON.stringify(nla));

    //  4. Nothing open → not an error.
    await c.query("begin");
    const none = await defect.resolveProofEvaluationDefect(c, {
      work_order_id: reopened, property_id: PROP });
    await c.query("commit");
    ok("C6  closing again is a no-op, not a failure", none.outcome === "nothing_open",
       JSON.stringify(none));

    //  5. Every closure is explained by an immutable event.
    const evs = Number((await c.query(
      `select count(*) n from events where type='proof_evaluation_defect_resolved'`)).rows[0].n);
    ok("C7  every closure wrote an event recording WHY", evs === 2, String(evs));
    const ev = (await c.query(
      `select note from events where type='proof_evaluation_defect_resolved'
        order by occurred_at desc limit 1`)).rows[0];
    ok("C8  …naming the basis in words, not just a code",
       ev.note.includes("no longer in a terminal status"), ev.note);
  }

  // ══ M — NO MANUAL CLOSURE ══════════════════════════════════════════
  sec("M · THERE IS NO OPERATOR-FACING DISMISS");
  {
    const src = fs.readFileSync(
      path.join(ROOT, "src/maintenance/proof_defect_service.js"), "utf8");
    ok("M1  the closure service accepts NO resolution_code argument",
       !/resolveProofEvaluationDefect[\s\S]{0,300}?resolution_code\s*[,=}]/.test(
         src.slice(src.indexOf("async function resolveProofEvaluationDefect"),
                   src.indexOf("async function resolveProofEvaluationDefect") + 300)),
       "a caller can name its own resolution — 'closes only on genuine resolution' " +
       "becomes a comment rather than a rule");
    ok("M2  it derives the resolution from the database instead",
       /work_order_proof_evaluation_head/.test(src) && /isTerminal\(/.test(src));

    //  And the required input cannot be typed away.
    ok("M3  the obligation's required input is proof_evaluation, not free text",
       defect.DEFECT_SPEC.required_inputs.length === 1 &&
       defect.DEFECT_SPEC.required_inputs[0] === "proof_evaluation",
       JSON.stringify(defect.DEFECT_SPEC.required_inputs));
  }

  // ══ A — CALLER (a) ═════════════════════════════════════════════════
  sec("A · THE CANONICAL WRITER NOTICES A TERMINAL ROW IT DID NOT EVALUATE");
  {
    //  Terminal, no evaluation, post-cutover — the row this whole section
    //  is about, and the row migration 140 refuses to let commit.
    const rogue = await forbidden(
      "A needs the terminal row the canonical writer did not evaluate",
      () => mkWo("complete"));
    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: rogue });
    ok("A1  the reader calls it missing_evaluation_defect",
       s.proof.state === "missing_evaluation_defect", JSON.stringify(s.proof.state));

    await c.query("begin");
    const out = await lifecycle.claimCompletion(c, {
      work_order_id: rogue, user_id: TECH, organization_id: ORG, idempotency_key: "life-a" });
    await c.query("commit");

    ok("A2  claimCompletion still REFUSES the field fact",
       out.outcome === "refused" && out.refusal === "work_order_already_complete",
       JSON.stringify({ o: out.outcome, r: out.refusal }));
    ok("A3  …and raised the defect obligation while refusing",
       await openDefects(rogue) === 1, String(await openDefects(rogue)) +
       " — the writer saw a terminal row with no evaluation and said nothing");
    ok("A4  …reporting it on the refusal rather than hiding it",
       out.proofDefect && out.proofDefect.outcome === "raised",
       JSON.stringify(out.proofDefect));
    ok("A5  …attributed to claimCompletion, not to the sweep",
       (await c.query(`select note from events
                        where type='proof_evaluation_missing_detected'
                          and note like '%'||$1||'%'`, [rogue])).rows[0]
         .note.includes("claimCompletion"));
    console.log("        → reported, not repaired: the refusal stands. A refusal that");
    console.log("          quietly fixed things would be a second completion path.");

    //  It must not raise for a LEGACY row, and must not raise twice.
    await c.query("begin");
    await lifecycle.claimCompletion(c, {
      work_order_id: rogue, user_id: TECH, organization_id: ORG, idempotency_key: "life-a2" });
    await c.query("commit");
    ok("A6  a second observation does not raise a second obligation",
       await openDefects(rogue) === 1, String(await openDefects(rogue)));
  }

  // ══ E — THE END-TO-END LOOP ════════════════════════════════════════
  sec("E · RAISE → RESOLVE, THROUGH THE REAL COMPLETION PATH");
  {
    /*  The whole point: a work order that was wrongly terminal, then gets
     *  a real governed completion, ends with the obligation CLOSED by the
     *  same transaction that resolved it — never left open against work
     *  that is now proven. */
    const wo = await forbidden(
      "E starts from a wrongly-terminal row and drives it to a governed completion",
      () => mkWo("closed"));
    await c.query("begin");
    await defect.raiseProofEvaluationDefect(c, { work_order_id: wo, property_id: PROP });
    await c.query("commit");
    ok("E1  the defect obligation is open", await openDefects(wo) === 1);

    //  Make it completable again and run the real writer.
    await c.query(`update work_orders set status='open' where id=$1`, [wo]);
    await photo(wo);
    await c.query("begin");
    const done = await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "life-e" });
    await c.query("commit");

    ok("E2  claimCompletion completes it", done.closed === true, JSON.stringify(done.outcome));
    ok("E3  …and CLOSED the defect obligation in the same transaction",
       await openDefects(wo) === 0, String(await openDefects(wo)) +
       " — an accountability item left open against proven work");
    ok("E4  …as 'satisfied', because an evaluation now exists",
       (await closedDefect(wo)).resolution_code === "satisfied",
       JSON.stringify(await closedDefect(wo)));
    ok("E5  …and the writer reports the closure rather than doing it silently",
       done.proofDefectClosure && done.proofDefectClosure.outcome === "closed",
       JSON.stringify(done.proofDefectClosure));

    //  The ordinary case: no defect, so closure is a no-op.
    const clean = await mkWo("open");
    await photo(clean);
    await c.query("begin");
    const ok2 = await lifecycle.claimCompletion(c, {
      work_order_id: clean, user_id: TECH, organization_id: ORG, idempotency_key: "life-e2" });
    await c.query("commit");
    ok("E6  a normal completion with no defect reports nothing_open, not an error",
       ok2.closed === true && ok2.proofDefectClosure.outcome === "nothing_open",
       JSON.stringify(ok2.proofDefectClosure));
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
