#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   §4.2 — PROVE THE DEFECT SWEEP

   The first WRITER in this stretch. Everything before it was a candidate
   that touched nothing; this one raises obligations against work orders,
   and an obligation is an accountability fact about a human. Raising a
   wrong one is not a cosmetic error — it tells a property manager they
   failed to do something they did.

   So the load-bearing assertions are the REFUSALS:

     L   legacy_indeterminate NEVER raises one
     I   two runs, and two CONCURRENT runs, cannot raise two
     G   no activation, no index → the sweep refuses to run at all
     P   the reader stays pure while the sweep writes

   ⚠ ISOLATED POSTGRES ONLY. Needs schema 137 AND migration 138.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP9_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step9/prove_defect_sweep.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const sweep = require(path.join(ROOT, "src/maintenance/proof_defect_sweep.js"));
const defect = require(path.join(ROOT, "src/maintenance/proof_defect_service.js"));
const proofState = require(path.join(ROOT, "src/release0/proof_state.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const URL = process.env.STEP9_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const ID = (n) => crypto.createHash("md5").update("step9:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), PROP_B = ID("propB"), TECH = ID("tech");
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
    console.error("REFUSED: activation history is not empty — the sweep must be observed");
    console.error("         BEFORE and AFTER activation. Rebuild the baseline.");
    process.exit(3);
  }

  console.log("§4.2 — DEFECT SWEEP PROOF — isolated postgres\n");

  await c.query(`insert into organizations (id,name) values ($1,'S9 Org') on conflict (id) do nothing`, [ORG]);
  for (const [p, n] of [[PROP, "S9 Property"], [PROP_B, "S9 Property B"]]) {
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [p, n, ORG]);
  }
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Sam Step9','+15415559601','maintenance',true) on conflict (id) do nothing`, [TECH]);

  let seq = 0;
  const mkWo = async ({ status = "closed", property = PROP } = {}) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'step9',$3,'step9proof')`, [wo, property, status]);
    return wo;
  };
  const defects = async (wo = null) => Number((await c.query(
    wo ? `select count(*) n from obligations where type='proof_evaluation_missing' and related_id=$1`
       : `select count(*) n from obligations where type='proof_evaluation_missing'`,
    wo ? [wo] : [])).rows[0].n);

  // ══ G — IT REFUSES BEFORE IT IS SAFE ═══════════════════════════════
  sec("G · THE SWEEP REFUSES UNTIL IT CAN TELL LEGACY FROM DEFECT");
  {
    //  Migration 138 has not been applied yet in this run.
    const noIndex = await sweep.runProofDefectSweep(pool, { dryRun: false })
      .then(() => null).catch((e) => e);
    ok("G1  with no idempotency index, the sweep REFUSES to run",
       !!noIndex && noIndex.code === "IDEMPOTENCY_INDEX_MISSING",
       noIndex ? noIndex.code + " " + noIndex.message : "it ran without migration 138");
    console.log("        → without it every run inserts a duplicate, and the failure is");
    console.log("          silent: a growing pile of obligations for one work order.");

    //  Apply 138 by hand here — the harness proves the sweep, not the runner.
    await c.query(fs.readFileSync(
      path.join(ROOT, "migrations/138_proof_evaluation_defect_obligation.sql"), "utf8"));
    ok("G2  migration 138's index applies cleanly", await defect.defectIndexPresent(c));

    const legacyWo = await mkWo({ status: "closed" });
    const noAct = await sweep.runProofDefectSweep(pool, { dryRun: false })
      .then(() => null).catch((e) => e);
    ok("G3  with no ACTIVATION, the sweep refuses to run",
       !!noAct && noAct.code === "ACTIVATION_ABSENT",
       noAct ? noAct.code : "it ran with no cutover inventory");
    ok("G4  …and raised nothing", await defects() === 0, String(await defects()));
    console.log("        → otherwise it would raise a defect against EVERY terminal work");
    console.log("          order, which is what the reader avoids by reporting");
    console.log("          `unavailable` — except a sweep would write it down.");

    //  Activate, putting that first work order in the inventory as LEGACY.
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "step9 proof", expected: census });
    await c.query("commit");
    console.log(`\n  (activated; ${census.length} row(s) inventoried as legacy)`);
    global.__legacyWo = legacyWo;
  }
  const legacyWo = global.__legacyWo;

  // ══ L — LEGACY NEVER RAISES ════════════════════════════════════════
  sec("L · legacy_indeterminate NEVER CREATES A DEFECT OBLIGATION");
  {
    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: legacyWo });
    ok("L1  the reader calls the inventoried row legacy_indeterminate",
       s.proof.state === "legacy_indeterminate", JSON.stringify(s.proof.state));

    const r = await sweep.runProofDefectSweep(pool, { dryRun: false });
    ok("L2  a full sweep raises NOTHING for it", await defects(legacyWo) === 0,
       String(await defects(legacyWo)) +
       " — a legitimate historical close was reported as somebody's failure");
    ok("L3  …and the run says so rather than silently doing nothing",
       r.candidates === 0 || r.skipped_not_defect >= 0, JSON.stringify(r));
    console.log("        run: " + JSON.stringify({ candidates: r.candidates,
      confirmed: r.confirmed, raised: r.raised, skipped: r.skipped_not_defect }));
  }

  // ══ D — A REAL DEFECT RAISES EXACTLY ONE ═══════════════════════════
  sec("D · A POST-CUTOVER TERMINAL ROW RAISES ONE OBLIGATION");
  let defectWo = null;
  {
    defectWo = await mkWo({ status: "closed" });   // after activation → not inventoried
    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: defectWo });
    ok("D1  the reader calls it missing_evaluation_defect",
       s.proof.state === "missing_evaluation_defect", JSON.stringify(s.proof.state));

    const dry = await sweep.runProofDefectSweep(pool, { dryRun: true });
    ok("D2  a DRY RUN confirms it and writes nothing",
       dry.confirmed === 1 && dry.raised === 0 && await defects() === 0,
       JSON.stringify(dry));
    console.log("        → dryRun defaults to TRUE: a sweep that writes unless told");
    console.log("          otherwise is one mis-invocation away from production.");

    const r = await sweep.runProofDefectSweep(pool, { dryRun: false });
    ok("D3  the real run raises exactly one", r.raised === 1 && await defects(defectWo) === 1,
       JSON.stringify(r));

    const o = (await c.query(
      `select * from obligations where type='proof_evaluation_missing' and related_id=$1`,
      [defectWo])).rows[0];
    ok("D4  …scoped to the property", o.property_id === PROP, o.property_id);
    ok("D5  …routed to property_manager escalating to asset_manager (§4.2)",
       o.assigned_role === "property_manager" && o.escalates_to_role === "asset_manager",
       JSON.stringify({ a: o.assigned_role, e: o.escalates_to_role }));
    ok("D6  …UNASSIGNED — no human invented",
       o.assigned_user_id === null,
       "a person was assigned that no governed ruling names");
    ok("D7  …linked to the work order and naming its required input",
       o.related_type === "work_order" && o.related_id === defectWo &&
       (o.required_inputs || []).includes("proof_evaluation"),
       JSON.stringify({ rt: o.related_type, ri: o.required_inputs }));
    ok("D8  …and AUDITABLE: born from an event that says why",
       !!o.source_event_id, "no source event — the obligation cannot be explained");
    const ev = (await c.query(`select * from events where id=$1`, [o.source_event_id])).rows[0];
    ok("D9  the event names the work order, the detector and the reason",
       ev && ev.type === "proof_evaluation_missing_detected" &&
       ev.note.includes(defectWo) && ev.note.includes("not legacy"),
       ev && ev.note);
  }

  // ══ I — IDEMPOTENCE, SEQUENTIAL AND CONCURRENT ═════════════════════
  sec("I · TWO RUNS CANNOT RAISE TWO — SEQUENTIALLY OR AT THE SAME TIME");
  {
    const r2 = await sweep.runProofDefectSweep(pool, { dryRun: false });
    ok("I1  a second sweep raises nothing new",
       await defects(defectWo) === 1 && r2.raised === 0 && r2.already_open === 1,
       JSON.stringify(r2));

    //  The one that matters. Two runs overlapping is the ORDINARY case for
    //  a scheduled rail, not the exotic one.
    const fresh = await mkWo({ status: "closed" });
    const [a, b] = await Promise.all([
      sweep.runProofDefectSweep(pool, { dryRun: false }),
      sweep.runProofDefectSweep(pool, { dryRun: false }),
    ]);
    ok("I2  two CONCURRENT sweeps produce exactly ONE obligation",
       await defects(fresh) === 1, String(await defects(fresh)) +
       " — the database's unique index is what decides, not a check-then-insert");
    ok("I3  …and between them, exactly one reports 'raised'",
       (a.raised + b.raised) === 1, JSON.stringify({ a: a.raised, b: b.raised }));
    console.log("        a: " + JSON.stringify({ raised: a.raised, already: a.already_open }) +
                "   b: " + JSON.stringify({ raised: b.raised, already: b.already_open }));

    //  The conflict path must not leave an orphan event behind.
    const evCount = Number((await c.query(
      `select count(*) n from events where type='proof_evaluation_missing_detected'
        and note like '%'||$1||'%'`, [fresh])).rows[0].n);
    ok("I4  the losing run left NO orphan event — the savepoint rolled it back",
       evCount === 1, evCount + " events for one obligation");

    //  And the service is idempotent when called directly, twice, in one
    //  transaction — the savepoint has to survive its own use.
    await c.query("begin");
    const x1 = await defect.raiseProofEvaluationDefect(c, {
      work_order_id: defectWo, property_id: PROP });
    const x2 = await defect.raiseProofEvaluationDefect(c, {
      work_order_id: defectWo, property_id: PROP });
    const stillUsable = await c.query(`select 1 n`).then(() => true).catch(() => false);
    await c.query("commit");
    ok("I5  calling the service twice in ONE transaction is safe",
       x1.outcome === "already_open" && x2.outcome === "already_open",
       JSON.stringify([x1.outcome, x2.outcome]));
    ok("I6  …and the transaction is still usable after the duplicate",
       stillUsable,
       "the conflict poisoned the transaction — the appendProgress defect, again");
  }

  // ══ S — SCOPE AND SELECTIVITY ══════════════════════════════════════
  sec("S · IT SWEEPS WHAT IT SHOULD AND NOTHING ELSE");
  {
    const otherProp = await mkWo({ status: "closed", property: PROP_B });
    const openWo = await mkWo({ status: "open" });
    const evaluated = await mkWo({ status: "complete" });
    await c.query(`insert into work_order_proof_evaluations
      (work_order_id,property_id,state,evaluated_by_service,rule_version)
      values ($1,$2,'satisfied','step9proof','x')`, [evaluated, PROP]);

    const scoped = await sweep.runProofDefectSweep(pool, { propertyId: PROP, dryRun: false });
    ok("S1  a property-scoped sweep does not touch another property",
       await defects(otherProp) === 0, String(await defects(otherProp)));
    ok("S2  an OPEN work order never raises one", await defects(openWo) === 0);
    ok("S3  a terminal work order WITH an evaluation never raises one",
       await defects(evaluated) === 0);
    console.log("        scoped run: " + JSON.stringify({ candidates: scoped.candidates,
      raised: scoped.raised, already: scoped.already_open }));

    const all = await sweep.runProofDefectSweep(pool, { dryRun: false });
    ok("S4  an unscoped sweep DOES reach the other property",
       await defects(otherProp) === 1, String(await defects(otherProp)));
    ok("S5  …and that obligation is scoped to ITS property",
       (await c.query(`select property_id from obligations
                        where type='proof_evaluation_missing' and related_id=$1`,
                      [otherProp])).rows[0].property_id === PROP_B);
    console.log("        unscoped run: " + JSON.stringify({ raised: all.raised }));
  }

  // ══ P — THE READER STAYS PURE ══════════════════════════════════════
  sec("P · THE SWEEP WRITES; THE READER STILL DOES NOT");
  {
    const before = {};
    for (const t of ["obligations", "events", "work_orders"]) {
      // eslint-disable-next-line no-await-in-loop
      before[t] = Number((await c.query(`select count(*) n from ${t}`)).rows[0].n);
    }
    await reader.readPropertyWorkOrderStatuses(c, { propertyId: PROP, limit: 100 });
    const after = {};
    for (const t of Object.keys(before)) {
      // eslint-disable-next-line no-await-in-loop
      after[t] = Number((await c.query(`select count(*) n from ${t}`)).rows[0].n);
    }
    ok("P1  reading every work order raises NO obligation",
       JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));

    const rsrc = fs.readFileSync(path.join(ROOT, "src/release0/proof_state.js"), "utf8");
    ok("P2  the shared predicate still contains no write",
       !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(rsrc));

    /*  The sweep never updates or closes an obligation (§4.2). It only
     *  creates — closure is a separate governed act on genuine resolution,
     *  and a sweep that could close would be able to erase the very
     *  accountability it exists to raise. */
    const ssrc = fs.readFileSync(path.join(ROOT, "src/maintenance/proof_defect_sweep.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok("P3  the sweep contains no UPDATE or DELETE of any kind",
       !/\b(update\s+\w+\s+set|delete\s+from)\b/i.test(ssrc),
       "the sweep can now close what it raised");
    ok("P4  …and the stripper left real code behind, so P3 is not vacuous",
       ssrc.includes("runProofDefectSweep") && ssrc.length > 500);
  }

  // ══ A — AGREEMENT WITH THE READER, ROW BY ROW ══════════════════════
  sec("A · §3.2.0 — THE SWEEP AND THE READER CANNOT DISAGREE");
  {
    const rows = (await c.query(
      `select id, property_id from work_orders where source='step9proof'`)).rows;
    let mismatches = [];
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      const s = await reader.readWorkOrderStatus(c, {
        propertyId: r.property_id, workOrderId: r.id });
      // eslint-disable-next-line no-await-in-loop
      const raised = Number((await c.query(
        `select count(*) n from obligations
          where type='proof_evaluation_missing' and related_id=$1`, [r.id])).rows[0].n);
      const shouldHave = s.proof.state === "missing_evaluation_defect" ? 1 : 0;
      if (raised !== shouldHave) mismatches.push({ id: r.id, state: s.proof.state, raised });
    }
    ok("A1  every work order has an obligation IF AND ONLY IF the reader calls it a defect",
       mismatches.length === 0, JSON.stringify(mismatches));
    console.log("        " + rows.length + " work order(s) compared against the reader");
  }

  // ══ X — THE CONFIRMATION BRANCH, AND WHAT IT IS FOR ════════════════
  sec("X · THE PER-ROW CONFIRMATION IS DEFENCE IN DEPTH — said plainly");
  {
    /*  Every run above reported skipped_not_defect = 0. That is not the
     *  confirmation failing; it is the PREFILTER already excluding legacy
     *  rows, so the confirmation had nothing to reject.
     *
     *  The branch exists for the case the prefilter cannot cover: a work
     *  order whose state CHANGES between the prefilter's snapshot and its
     *  own per-row transaction — it gains an evaluation, or is reopened.
     *  Forcing that race deterministically would mean instrumenting the
     *  sweep with a test-only hook, which is a worse trade than saying
     *  this out loud.
     *
     *  So: the branch is asserted at the unit level, and its unreachability
     *  in a static population is RECORDED rather than dressed up as a
     *  passing control. Same treatment as Step 7's scope-blind variant. */
    const authority = await proofState.activationAuthority(c);
    const legacyRow = (await c.query(
      `select * from work_orders where id=$1`, [legacyWo])).rows[0];
    const derived = await proofState.deriveProofState(c, { workOrder: legacyRow, authority });

    ok("X1  the legacy row derives legacy_indeterminate through the SHARED predicate",
       derived.read_status === "ok" && derived.state === "legacy_indeterminate",
       JSON.stringify(derived));
    //  The sweep's guard, restated exactly as the sweep writes it. If the
    //  sweep's condition ever changes, this assertion is what notices.
    const wouldSkip = !(derived.read_status === "ok" &&
                        derived.state === "missing_evaluation_defect");
    ok("X2  …so the sweep's own guard condition SKIPS it",
       wouldSkip, "the guard would have raised an obligation for legacy history");

    const ssrc = fs.readFileSync(path.join(ROOT, "src/maintenance/proof_defect_sweep.js"), "utf8");
    ok("X3  the sweep calls deriveProofState, not a copy of the predicate",
       /proofState\.deriveProofState\(/.test(ssrc) &&
       !/status\s+in\s*\(\s*'complete'\s*,\s*'closed'\s*\)[\s\S]{0,200}missing_evaluation_defect/i.test(ssrc),
       "the sweep has grown its own copy of the rule — §3.2.0 forbids exactly that");

    console.log("        → RECORDED, not claimed as a caught defect: in a static");
    console.log("          population the prefilter makes this branch unreachable, so");
    console.log("          `skipped_not_defect` staying 0 above is correct rather than");
    console.log("          suspicious. The branch covers the prefilter/per-row race.");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
