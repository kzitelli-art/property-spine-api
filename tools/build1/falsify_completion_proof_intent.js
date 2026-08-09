#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   BUILD 1 — FALSIFICATION

   Not the happy answer. The attempts to kill it.

     K  answerability   — every way a source can fail to answer
     L  proof semantics — every state, in the right lane, none hidden
     M  boundedness     — the cap must live in SQL, not the renderer
     N  the freeze      — four contract mutations, each must turn a gate red
     P  the model       — truth survives with no model at all
     Q  history         — the answer changes, the receipt does not

   Each section records its PREDICTION before its result, so a wrong
   model shows up as a wrong prediction rather than being edited away.

   ⚠ ISOLATED POSTGRES ONLY.

   usage:
     FALSIFYB1_DATABASE_URL='...' node tools/build1/falsify_completion_proof_intent.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const executor = require(path.join(ROOT, "src/askspine/intent_executor.js"));
const renderer = require(path.join(ROOT, "src/askspine/renderer.js"));
const receipts = require(path.join(ROOT, "src/askspine/receipt_service.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const guardWindow = require(path.join(ROOT, "tools/step12/guard_window.js"));
const grounded = require(path.join(ROOT, "tools/step12/grounded_evaluation.js"));

const URL = process.env.FALSIFYB1_DATABASE_URL;
const SLUG = "maintenance.completion_without_valid_proof";
const CONTRACT = path.join(ROOT, "src/askspine/contracts", `${SLUG}.json`);

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const predict = (t) => console.log(`  predicts: ${t}\n`);

const ID = (n) => crypto.createHash("md5").update("falsb1:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), EMPTY = ID("empty"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: FALSIFYB1_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL, max: 6 });
  const c = await pool.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  await c.query(fs.readFileSync(path.join(ROOT, "migrations/141_ask_spine_read_receipts.sql"), "utf8"));
  await c.query(`insert into organizations (id,name) values ($1,'FB1') on conflict do nothing`, [ORG]);
  for (const [id, nm] of [[PROP, "FB1 Prop"], [EMPTY, "FB1 Empty Prop"]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [id, nm, ORG]);
  }
  await c.query(`insert into users (id,name,phone,role)
                 values ($1,'FB1 Tech','+15005550777','maintenance')
                 on conflict (id) do nothing`, [TECH]);

  let seq = 0;
  const mkWo = async (status, prop = PROP) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'falsify b1',$3,'falsb1')`, [wo, prop, status]);
    return wo;
  };
  const runFor = (prop) => executor.execute(pool, {
    intent_slug: SLUG, property_id: prop, allowed_modules: ["maintenance"] });
  const run = () => runFor(PROP);

  console.log("BUILD 1 FALSIFICATION\n");

  /* ═══ K · ANSWERABILITY ═════════════════════════════════════════ */
  sec("K · every way a source can fail to answer");
  predict("no activation, a broken source and an empty population must produce " +
          "THREE different answers. Collapsing any two is the false-empty failure.");
  {
    const k1 = await run();
    ok("K1  no activation → UNAVAILABLE", k1.coverage_state === "unavailable", k1.coverage_state);

    //  A BROKEN SOURCE, not an absent one. The view is dropped out from
    //  under a live activation, so answerability passes and the
    //  population read is the thing that fails.
    //  The pre-cutover row is created BEFORE the activation and
    //  inventoried BY THE CANONICAL CENSUS — this harness never writes
    //  release_0_legacy_cutover_inventory itself. A hand-written insert
    //  would make the falsification a second writer for the very table
    //  whose single-writer discipline it is standing on (and the table's
    //  own NOT NULL columns refused it, which is the invariant saying so).
    await guardWindow.installGuard(c);
    await guardWindow.withGuardOff(c, "one pre-cutover legacy row, before the cutover",
      async () => mkWo("closed"));
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "falsify b1", expected: census });
    await c.query("commit");

    await c.query(`alter view release_0_completion_invariant_violations rename to _hidden_v`);
    const k2 = await run();
    await c.query(`alter view _hidden_v rename to release_0_completion_invariant_violations`);
    ok("K2  a BROKEN population read → UNAVAILABLE, not zero",
       k2.coverage_state === "unavailable" && k2.totals === null,
       JSON.stringify({ cov: k2.coverage_state, totals: k2.totals }));
    ok("K3  …and the failing source is named in the outcomes",
       k2.source_outcomes.some((o) => o.id === "release_0_invariant_audit" && o.status === "failed"),
       JSON.stringify(k2.source_outcomes));
    ok("K4  …while the authority source is recorded as ANSWERED",
       k2.source_outcomes.some((o) => o.id === "release_0_activation_authority" && o.status === "answered"),
       "a failure in one source must not erase the fact that another answered");

    //  A GENUINELY EMPTY, FULLY-READ POPULATION. Same activation, same
    //  code, a property with nothing in it — so VALID_EMPTY is reached by
    //  the population genuinely being empty rather than by the source
    //  failing to speak.
    const k5 = await runFor(EMPTY);
    ok("K5  a fully-read EMPTY population → VALID_EMPTY", k5.coverage_state === "valid_empty",
       JSON.stringify({ cov: k5.coverage_state, totals: k5.totals }));
    ok("K6  …which is a DIFFERENT answer from unavailable",
       k5.coverage_state !== k1.coverage_state && k5.coverage_state !== k2.coverage_state);
    ok("K7  …and its sentence is a finding, not an apology",
       renderer.render(k5).answer === "No completed work orders lack valid proof.",
       renderer.render(k5).answer);
  }

  /* ═══ L · PROOF SEMANTICS ═══════════════════════════════════════ */
  sec("L · every proof state, in the right lane, none hidden");
  predict("satisfied is excluded; missing_evaluation_defect and a terminal " +
          "not_satisfied are CURRENT; legacy_indeterminate is HISTORY and never current.");
  {
    //  A properly proven completion.
    const good = await mkWo("open");
    await grounded.preserveQualifyingEvidence(c,
      { work_order_id: good, property_id: PROP, uploaded_by_user_id: TECH, seed: "L" });
    await grounded.completeGoverned(c,
      { work_order_id: good, property_id: PROP, uploaded_by_user_id: TECH, seed: "L" });
    let e = await run();
    ok("L1  a satisfied terminal work order is EXCLUDED",
       !e.supporting_records.some((r) => r.work_order_id === good), JSON.stringify(e.totals));

    //  Terminal with a not_satisfied head. Migration 140 refuses this
    //  through governed operation (R0001), so it must be manufactured —
    //  and the intent must still surface it (ruling 9).
    const bad = await guardWindow.withGuardOff(c,
      "ruling 9 — a terminal not_satisfied row is unreachable through governed " +
      "operation, and the intent must surface it honestly if it ever exists",
      async () => {
        const wo = await mkWo("complete");
        await c.query(
          `insert into work_order_proof_evaluations
             (work_order_id, property_id, state, evaluated_at, evaluated_by_service, rule_version)
           values ($1,$2,'not_satisfied', now(), 'falsify_b1', 'r0')`, [wo, PROP]);
        return wo;
      });
    e = await run();
    const badRec = e.supporting_records.find((r) => r.work_order_id === bad);
    ok("L2  a terminal not_satisfied row is SURFACED, not hidden", !!badRec,
       "migration 140 should make this unreachable; that is not a licence to conceal it");
    ok("L3  …in the CURRENT lane", badRec && badRec.lane === "current", badRec && badRec.lane);
    ok("L4  …carrying the canonical state verbatim",
       badRec && badRec.canonical_proof_state === "not_satisfied", badRec && badRec.canonical_proof_state);
    ok("L5  …and the canonical DB proof status alongside it",
       badRec && badRec.canonical_db_proof_status === "not_satisfied",
       badRec && badRec.canonical_db_proof_status);

    //  The pre-cutover row inventoried by the canonical census in K.
    const legacy = (await c.query(
      `select work_order_id from release_0_legacy_cutover_inventory
        where property_id=$1 limit 1`, [PROP])).rows[0].work_order_id;
    e = await run();
    const legRec = e.supporting_records.find((r) => r.work_order_id === legacy);
    ok("L6  a pre-cutover row is in the HISTORY lane",
       legRec && legRec.lane === "pre_cutover_history", legRec && legRec.lane);
    ok("L7  …and NEVER in the current lane",
       !e.supporting_records.some((r) => r.work_order_id === legacy && r.lane === "current"));
    ok("L8  the two lanes are counted separately",
       e.totals.lane_a_total >= 1 && e.totals.lane_b_total === 1, JSON.stringify(e.totals));
    const sentence = renderer.render(e).answer;
    ok("L9  and the sentence never sums them into one failure",
       !new RegExp(`^${e.totals.total_matching} completed work orders do not`).test(sentence),
       sentence + ` — total_matching is ${e.totals.total_matching}, and saying that ` +
       "many 'failed proof' would rewrite history");
    console.log(`        → "${sentence}"`);

    //  DELIBERATELY NOT CLEANED UP. The first version of this section
    //  tried to delete the manufactured evaluation and was refused —
    //  evaluations are append-only, which is the whole point of Release 0
    //  and is not something a harness gets to step around. The row stays,
    //  the later sections account for it, and the population is more
    //  realistic for it.
  }

  /* ═══ M · BOUNDEDNESS ═══════════════════════════════════════════ */
  sec("M · the cap must live in SQL and the service, not the renderer");
  predict("the SQL itself must LIMIT. A renderer-only cap would mean the " +
          "service loaded the whole population and only the sentence was bounded.");
  {
    const src = fs.readFileSync(path.join(ROOT, "src/askspine/intent_executor.js"), "utf8");
    ok("M1  the population SQL carries a LIMIT", /limit \$2/.test(src));
    ok("M2  …parameterised from the CONTRACT's cap",
       /const cap = contract\.result_cap/.test(src));
    ok("M3  the service re-enforces it after the query",
       /\.slice\(0, cap\)/.test(src),
       "delegating the guarantee downward is how a cap quietly stops holding " +
       "when a query is later edited");
    const rend = fs.readFileSync(path.join(ROOT, "src/askspine/renderer.js"), "utf8");
    ok("M4  the renderer does NOT slice the records",
       !/supporting_records[\s\S]{0,40}slice/.test(rend),
       "if the renderer were the only cap, the service would have loaded everything");
  }

  /* ═══ N · THE FREEZE ════════════════════════════════════════════ */
  sec("N · four contract mutations, each must turn the gate red");
  predict("changing the predicate, the conclusions, the evidence rule or the cap " +
          "without moving the digest must be caught. If any passes, the freeze is decoration.");
  {
    const original = fs.readFileSync(CONTRACT, "utf8");
    const gateRed = () => spawnSync(process.execPath,
      [path.join(ROOT, "tests/gate_ask_spine_contract_frozen.js")],
      { encoding: "utf8" }).status !== 0;

    ok("N0  the gate is GREEN before any mutation", !gateRed(),
       "a gate that is already red proves nothing about what follows");

    const MUTATIONS = [
      ["candidate predicate", (s) => s.replace('"version": "1.0.0"', '"version": "9.9.9"')],
      ["supported conclusions", (s) => s.replace('"current_none_legacy_none",', "")],
      ["evidence-time rule", (s) => s.replace(
        '"forbidden": "substituting now() for a missing evidence timestamp"',
        '"forbidden": "nothing"')],
      ["result cap", (s) => s.replace('"result_cap": 20,', '"result_cap": 5000,')],
    ];
    for (const [what, mutate] of MUTATIONS) {
      const drifted = mutate(original);
      if (drifted === original) { ok(`N·${what}: the mutation applied`, false, "anchor not found"); continue; }
      fs.writeFileSync(CONTRACT, drifted);
      const red = gateRed();
      fs.writeFileSync(CONTRACT, original);
      ok(`N   mutating the ${what} without the digest → GATE RED`, red,
         "the freeze did not notice, so every receipt naming this version " +
         "describes bytes that no longer exist");
    }
    ok("N5  the contract is byte-restored after the attacks",
       fs.readFileSync(CONTRACT, "utf8") === original);
    ok("N6  …and the gate is green again", !gateRed());
  }

  /* ═══ P · THE MODEL BOUNDARY ════════════════════════════════════ */
  sec("P · operating truth with no model at all");
  predict("a resolved intent executes and renders with every model endpoint " +
          "unreachable, and no free text can become an operating claim.");
  {
    //  Poison every model credential and endpoint in this process. If any
    //  part of the path needed one, this is where it breaks.
    const saved = {};
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL"]) {
      saved[k] = process.env[k]; delete process.env[k];
    }
    const e = await run();
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;

    ok("P1  the intent still executes", e.coverage_state !== "unsupported", e.coverage_state);
    const r = renderer.render(e);
    ok("P2  …and still renders a deterministic sentence", typeof r.answer === "string" && r.answer.length > 0);
    ok("P3  the sentence is attributed to the frozen table",
       r.sentence_source === "frozen_renderer_table", r.sentence_source);
    ok("P4  an invented conclusion code cannot become a sentence", (() => {
      try { renderer.render({ conclusion_code: "everything_is_fine", totals: null }); return false; }
      catch (err) { return true; }
    })());
    ok("P5  no sentence in the frozen table carries markup",
       !Object.values(renderer.SENTENCES).some((f) => {
         try { return /[<>]/.test(f({ lane_a_total: 1, lane_b_total: 1 })); } catch (x) { return false; }
       }));
  }

  /* ═══ Q · HISTORY ═══════════════════════════════════════════════ */
  sec("Q · the answer recomputes; the receipt does not");
  predict("after governed truth legitimately changes, the CURRENT answer moves " +
          "and the earlier receipt does not — each naming the contract that made it.");
  {
    const t1e = await run();
    const t1r = renderer.render(t1e);
    const t1 = await receipts.writeReceipt(pool, {
      execution: t1e, rendered: t1r, property_id: PROP,
      actor: { user_id: TECH, session_id: null } });

    //  A LEGITIMATE change in governed truth: one more properly proven
    //  completion, through the canonical writer.
    const wo = await mkWo("open");
    await grounded.preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH, seed: "Q" });
    await grounded.completeGoverned(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH, seed: "Q" });
    //  …and one more CURRENT-lane row. Post-140 lane A can only grow
    //  through a bypass — which is exactly why the intent must surface it
    //  (ruling 9). What this section is testing is receipt immutability,
    //  not the legitimacy of the change that moved the answer.
    await guardWindow.withGuardOff(c,
      "post-140 the current lane can only grow through a bypass; the answer has to " +
      "move for this section to test anything",
      async () => mkWo("complete"));

    const t2e = await run();
    const t2r = renderer.render(t2e);
    const t2 = await receipts.writeReceipt(pool, {
      execution: t2e, rendered: t2r, property_id: PROP,
      actor: { user_id: TECH, session_id: null } });

    ok("Q1  the CURRENT answer changed", t1e.totals.lane_a_total !== t2e.totals.lane_a_total,
       `${t1e.totals.lane_a_total} → ${t2e.totals.lane_a_total}`);

    const r1 = (await c.query(`select * from ask_spine_read_receipts where id=$1`, [t1.id])).rows[0];
    const r2 = (await c.query(`select * from ask_spine_read_receipts where id=$1`, [t2.id])).rows[0];
    ok("Q2  the T1 receipt did NOT change", r1.rendered_answer === t1r.answer, r1.rendered_answer);
    ok("Q3  …and still reports T1's counts",
       Number(r1.total_matching) === t1e.totals.total_matching);
    ok("Q4  the two receipts disagree, which is the point",
       r1.rendered_answer !== r2.rendered_answer,
       `both say "${r1.rendered_answer}" — then the history is not history`);
    ok("Q5  each names the contract version that produced it",
       r1.intent_contract_version && r2.intent_contract_version);
    ok("Q6  …and the digest",
       r1.intent_contract_digest === executor.loadContract(SLUG).digest);

    //  NOW MOVE THE CONTRACT. The old receipt must still say which
    //  definition produced the old answer.
    const original = fs.readFileSync(CONTRACT, "utf8");
    try {
      fs.writeFileSync(CONTRACT, original.replace('"version": "1.1.0"', '"version": "2.0.0"'));
      const bytes = fs.readFileSync(CONTRACT);
      const newDigest = crypto.createHash("sha256").update(bytes).digest("hex");
      const r1After = (await c.query(
        `select * from ask_spine_read_receipts where id=$1`, [t1.id])).rows[0];
      ok("Q7  after the contract moves to 2.0.0, the OLD receipt still says 1.1.0",
         r1After.intent_contract_version === "1.1.0", r1After.intent_contract_version);
      ok("Q8  …and still carries the OLD digest, not the new one",
         r1After.intent_contract_digest !== newDigest,
         "otherwise 'what did Spine say in March' silently becomes 'what would it " +
         "say now', and the receipt is worthless");
    } finally {
      fs.writeFileSync(CONTRACT, original);
    }
    ok("Q9  the contract is byte-restored", fs.readFileSync(CONTRACT, "utf8") === original);
  }

  /* ═══ R · RECEIPT PERSISTENCE FAILURE ═══════════════════════════ */
  sec("R · a decision-grade answer whose receipt did not persist");
  predict("the truth read succeeds and the receipt write fails. This must NOT " +
          "become a normal DECISIVE answer with no audit history, and must not " +
          "invent a sixth answer state either.");
  {
    const express = require("express");
    const http = require("http");
    const app = express();
    app.use("/", require(path.join(ROOT, "src/agent/ask_spine.js"))({ pool }));
    const server = await new Promise((res) => { const sv = app.listen(0, () => res(sv)); });
    const port = server.address().port;

    const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
    await c.query(
      `insert into property_team_assignments (user_id, property_id, role_title, allowed_modules, active)
       values ($1,$2,'Manager',array['maintenance'],true) on conflict do nothing`, [TECH, PROP]);
    const issued = await staffSessions.issueStaffSession(pool, {
      userId: TECH, propertyId: PROP, purpose: "bootstrap_invite" });

    const get = () => new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/operator/ask-spine/completion-proof-gaps`,
        { headers: { "x-staff-session": issued.session_token } }, (r) => {
          let b = ""; r.on("data", (d) => { b += d; });
          r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (x) { /* */ }
            resolve({ status: r.statusCode, json: j }); });
        }).on("error", () => resolve({ status: 0, json: null }));
    });

    const healthy = await get();
    ok("R0  with the receipt table present the answer is decision-grade",
       healthy.json && healthy.json.coverage_state === "decisive" && !!healthy.json.receipt_id,
       JSON.stringify(healthy.json && healthy.json.coverage_state));

    //  Break ONLY the receipt write. The truth read still succeeds.
    await c.query(`alter table ask_spine_read_receipts rename to _hidden_asrr`);
    const broken = await get();
    await c.query(`alter table _hidden_asrr rename to ask_spine_read_receipts`);

    ok("R1  the answer does NOT come back decisive", 
       broken.json && broken.json.coverage_state !== "decisive",
       JSON.stringify(broken.json && broken.json.coverage_state) +
       " — a decision-grade answer with no audit history is exactly what ruling 17 forbids");
    ok("R2  it degrades to UNAVAILABLE", broken.json.coverage_state === "unavailable",
       broken.json.coverage_state);
    ok("R3  …using the EXISTING vocabulary, not a sixth state",
       ["decisive", "valid_empty", "partial", "unavailable", "unsupported"]
         .includes(broken.json.coverage_state));
    ok("R4  no receipt id is claimed", broken.json.receipt_id === null,
       String(broken.json.receipt_id));
    ok("R5  no totals are asserted either", broken.json.totals === null,
       JSON.stringify(broken.json.totals) +
       " — reporting counts alongside `I could not complete the check` would be " +
       "two answers in one response");
    ok("R6  the operator sentence does not leak the internal reason",
       /can't determine completion proof/.test(broken.json.answer) &&
       !/receipt/i.test(broken.json.answer), broken.json.answer);

    const after = await get();
    ok("R7  and it recovers once the table is back",
       after.json && after.json.coverage_state === "decisive" && !!after.json.receipt_id);
    server.close();
  }

  /* ═══ S · THE ARCHITECTURAL GATE CAN FIRE ═══════════════════════ */
  sec("S · the `no second proof predicate` gate is not decoration");
  predict("adding a hand-written evidence-validity predicate to the executor " +
          "must turn the gate red. If it does not, that check proves nothing.");
  {
    const EXEC = path.join(ROOT, "src/askspine/intent_executor.js");
    const original = fs.readFileSync(EXEC, "utf8");
    const gateRed = () => spawnSync(process.execPath,
      [path.join(ROOT, "tests/gate_ask_spine_contract_frozen.js")],
      { encoding: "utf8" }).status !== 0;
    ok("S0  green before the mutation", !gateRed());
    try {
      //  The exact wrong architecture: Ask Spine deciding for itself what
      //  counts as valid evidence.
      fs.writeFileSync(EXEC, original.replace(
        "const listContracts = () =>",
        "const evidenceIsValid = (a) => a.storage_state = 'stored' && a.byte_size > 0;\n" +
        "const listContracts = () =>"));
      ok("S1  a hand-written evidence predicate turns the gate RED", gateRed(),
         "then a second definition of proof validity could enter Ask Spine unnoticed");
    } finally {
      fs.writeFileSync(EXEC, original);
    }
    ok("S2  the executor is byte-restored", fs.readFileSync(EXEC, "utf8") === original);
    ok("S3  …and the gate is green again", !gateRed());
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}\n`);
  c.release();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
