#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   §4.2 — FALSIFICATION OF THE DEFECT SWEEP

   This is the first writer in the release, and its failure modes are not
   symmetric. A missed defect is a gap. A WRONG defect is an obligation
   telling a named role they failed at something they did not fail at.

   So the variants are the two ways it hurts someone:

     raise-legacy      legacy history raised as somebody's defect
     no-index          idempotency by check-then-insert rather than by
                       the database — duplicates under concurrency

   One variant per invocation against a fresh baseline: the cutover record
   is append-only and the activation permits one genesis ever.

   ⚠ ISOLATED POSTGRES ONLY.

   usage:
     for V in raise-legacy no-index; do
       bash tools/steps23/baseline_136.sh
       PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
       FALSIFY9_DATABASE_URL='...' node tools/step9/falsify_defect_sweep.js --variant $V
     done
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const SWEEP = path.join(ROOT, "src/maintenance/proof_defect_sweep.js");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
/*  Migration 140 REFUSES to let recordActivation run without it: a
 *  guard detected missing AFTER an irreversible act is useless. So a
 *  harness that activates must install it first. It is inert until the
 *  activation lands, so it changes nothing about what is proven here. */
const guardWindow = require("../step12/guard_window.js");

const URL = process.env.FALSIFY9_DATABASE_URL;
const SWEEP_DIGEST = crypto.createHash("sha256").update(fs.readFileSync(SWEEP)).digest("hex");

const argIdx = process.argv.indexOf("--variant");
const VARIANT = argIdx > -1 ? process.argv[argIdx + 1] : null;

const VARIANTS = {
  //  Drop the per-row confirmation and trust the prefilter. The prefilter
  //  excludes inventoried rows, so to make the harm visible the mutation
  //  ALSO drops the inventory clause — which is exactly what a "simplify
  //  the query" refactor would do to it.
  "raise-legacy": {
    what: "the per-row confirmation is dropped and the prefilter ignores the inventory",
    breaks: "L1/L2 and A1 — legacy history must never raise a defect",
    edits: [
      { from: `     and not exists (select 1 from release_0_legacy_cutover_inventory i
                      where i.work_order_id = w.id and i.property_id = w.property_id)`,
        to: "     /* falsified: inventory ignored */" },
      { from: `      if (derived.read_status !== "ok" || derived.state !== "missing_evaluation_defect") {`,
        to: "      if (false) { /* falsified: confirmation dropped */" },
    ],
  },
  //  Replace the database's guarantee with a read-then-write check. It
  //  looks correct and passes every sequential test.
  "no-index": {
    what: "idempotency by check-then-insert instead of the unique index",
    breaks: "I2 — two concurrent sweeps must produce one obligation",
    edits: [
      { from: `    if (!await defectIndexPresent(probe)) {`,
        to: "    if (false) { /* falsified: index requirement dropped */" },
      { from: `      const out = await raiseProofEvaluationDefect(client, {`,
        to: `      const dupe = await client.query(
        \`select 1 from obligations where property_id=$1 and related_id=$2
           and related_type='work_order' and type='proof_evaluation_missing'
           and status <> 'complete'\`, [cand.property_id, cand.work_order_id]);
      if (dupe.rowCount > 0) { started.already_open++; await client.query("commit"); continue; }
      const out = await raiseProofEvaluationDefect(client, {` },
    ],
  },
};

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

function loadVariant(edits) {
  let src = fs.readFileSync(SWEEP, "utf8");
  for (const { from, to } of edits) {
    if (!src.includes(from)) {
      throw new Error("FALSIFICATION TARGET NOT FOUND — proves nothing: " + from.slice(0, 80));
    }
    src = src.split(from).join(to);
  }
  const m = new Module(SWEEP, null);
  m.filename = SWEEP;
  m.paths = Module._nodeModulePaths(path.dirname(SWEEP));
  m._compile(src, SWEEP);
  return m.exports;
}

const ID = (n) => crypto.createHash("md5").update("fals9:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop");
const STEP6_INSTANT = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: FALSIFY9_DATABASE_URL is not set."); process.exit(1); }
  if (!VARIANT || !VARIANTS[VARIANT]) {
    console.error("REFUSED: --variant is required. One of:");
    for (const [k, v] of Object.entries(VARIANTS)) console.error(`  ${k.padEnd(14)} ${v.what}`);
    process.exit(2);
  }
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

  const V = VARIANTS[VARIANT];
  console.log(`§4.2 FALSIFICATION — variant "${VARIANT}"\n`);

  /*  The guard the ACTIVATION now requires. Without it every activation
   *  in this file refuses with GUARD_ABSENT, and a falsification harness
   *  whose variant is stopped by the WRONG thing proves nothing about
   *  the variant. It is inert until an activation exists. */
  await guardWindow.installGuard(c);
  console.log("  breaks:  " + V.what);
  console.log("  targets: " + V.breaks + "\n");

  await c.query(`insert into organizations (id,name) values ($1,'F9 Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'F9 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);

  let seq = 0;
  const mkWo = async (status = "closed") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'fals9',$3,'fals9proof')`, [wo, PROP, status]);
    return wo;
  };
  const defects = async (wo) => Number((await c.query(
    `select count(*) n from obligations where type='proof_evaluation_missing' and related_id=$1`,
    [wo])).rows[0].n);

  const real = require(SWEEP);
  const broken = loadVariant(V.edits);

  if (VARIANT === "raise-legacy") {
    const legacyWo = await mkWo("closed");
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "falsify9", expected: census });
    await c.query("commit");
    await c.query(fs.readFileSync(
      path.join(ROOT, "migrations/138_proof_evaluation_defect_obligation.sql"), "utf8"));

    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: legacyWo });
    ok("F0  the row IS legacy_indeterminate to the reader",
       s.proof.state === "legacy_indeterminate", JSON.stringify(s.proof.state));

    await broken.runProofDefectSweep(pool, { dryRun: false });
    ok("F1  with the confirmation dropped, LEGACY HISTORY raises a defect obligation",
       await defects(legacyWo) === 1, String(await defects(legacyWo)) +
       " — then L1/L2 are not what prevents this, and the proof is weaker than it reads");
    const o = (await c.query(
      `select assigned_role, label from obligations
        where type='proof_evaluation_missing' and related_id=$1`, [legacyWo])).rows[0];
    console.log("        → an obligation on " + (o && o.assigned_role) + " for a work order");
    console.log("          that was closed legitimately before the proof rail existed.");
    console.log("          The release would be manufacturing accountability failures");
    console.log("          out of its own history.");

    //  Clear it and prove the real sweep leaves it alone.
    await c.query(`delete from obligations where type='proof_evaluation_missing'`);
    await real.runProofDefectSweep(pool, { dryRun: false });
    ok("F2  the REAL sweep raises nothing for it", await defects(legacyWo) === 0,
       String(await defects(legacyWo)));
  }

  if (VARIANT === "no-index") {
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "falsify9", expected: census });
    await c.query("commit");
    //  NOTE: migration 138 is deliberately NOT applied for this variant.
    //  Post-activation and unevaluated is the state migration 140 refuses;
    //  the defect population this variant mishandles has to be built for it.
    const defectWo = await guardWindow.withGuardOff(c,
      "the no-index variant needs a real defect to raise twice",
      () => mkWo("closed"));

    //  Sequentially, the check-then-insert looks perfectly correct.
    await broken.runProofDefectSweep(pool, { dryRun: false });
    await broken.runProofDefectSweep(pool, { dryRun: false });
    ok("F1  SEQUENTIALLY, check-then-insert looks right — one obligation",
       await defects(defectWo) === 1, String(await defects(defectWo)) +
       " — the variant is broken in some other way, so F2 would prove nothing");

    /*  Concurrently, it is not — and the demonstration is DETERMINISTIC.
     *
     *  A first version ran two sweeps through Promise.all and asserted a
     *  duplicate appeared. It is a race, so it did not land, and the
     *  assertion went red for a reason that had nothing to do with the
     *  design under test. A control that only fails sometimes is worse
     *  than no control: it teaches people to re-run until it passes.
     *
     *  So the interleave is written out explicitly, which is what a race
     *  IS — two transactions that both read before either writes. This
     *  cannot flake in either direction. */
    const w2 = await guardWindow.withGuardOff(c,
      "…and a second one for the deterministic interleave",
      () => mkWo("closed"));
    const a = await pool.connect(), b = await pool.connect();
    const CHECK = `select 1 from obligations where property_id=$1 and related_id=$2
                     and related_type='work_order' and type='proof_evaluation_missing'
                     and status <> 'complete'`;
    await a.query("begin"); await b.query("begin");
    const seenA = (await a.query(CHECK, [PROP, w2])).rowCount;
    const seenB = (await b.query(CHECK, [PROP, w2])).rowCount;
    ok("F2a both transactions check FIRST, and both see no existing obligation",
       seenA === 0 && seenB === 0, JSON.stringify({ seenA, seenB }));

    const svc = require(path.join(ROOT, "src/maintenance/proof_defect_service.js"));
    await svc.raiseProofEvaluationDefect(a, { work_order_id: w2, property_id: PROP });
    await svc.raiseProofEvaluationDefect(b, { work_order_id: w2, property_id: PROP });
    await a.query("commit"); await b.query("commit");
    a.release(); b.release();

    const n = await defects(w2);
    ok("F2  …then BOTH insert, and without the index there are TWO obligations",
       n > 1, n + " obligation(s) — if this is 1, something other than the index is " +
       "deduplicating, and I2 is not proving what it claims");
    console.log("        → " + n + " obligations for one work order. Two property managers");
    console.log("          told about the same failure, or one told twice — and neither");
    console.log("          transaction did anything wrong. That is why the guarantee");
    console.log("          has to be the database's, not the service's.");

    //  And the real sweep would not even have started without the index.
    const refused = await real.runProofDefectSweep(pool, { dryRun: false })
      .then(() => null).catch((e) => e);
    ok("F3  the REAL sweep REFUSES to run at all without migration 138",
       !!refused && refused.code === "IDEMPOTENCY_INDEX_MISSING",
       refused ? refused.code : "it ran without the index");
  }

  ok("Z1  proof_defect_sweep.js is byte-identical to before this run",
     crypto.createHash("sha256").update(fs.readFileSync(SWEEP)).digest("hex") === SWEEP_DIGEST);

  console.log(`\n  passed ${pass}   failed ${fail}`);
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
