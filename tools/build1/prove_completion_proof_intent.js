#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   BUILD 1 — `maintenance.completion_without_valid_proof`, PROVEN

   Real Postgres. Real HTTP over a real socket. The shipped route, the
   shipped executor, the shipped renderer, the shipped receipt service —
   nothing re-implemented here, because a proof against a
   re-implementation is a proof about the re-implementation.

   Sections:
     A  before activation — the source cannot answer
     B  after activation, clean population — VALID_EMPTY, and it is hard
        to earn
     C  lanes stay separate — current failure vs pre-cutover history
     D  boundedness — full population, real total, disclosed cap
     E  the durable receipt
     F  real HTTP, real session, server-derived authority
     G  scope — another property's matching row is absent
     H  the model boundary

   ⚠ ISOLATED POSTGRES ONLY.

   usage:
     BUILD1_DATABASE_URL='...' node tools/build1/prove_completion_proof_intent.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const executor = require(path.join(ROOT, "src/askspine/intent_executor.js"));
const renderer = require(path.join(ROOT, "src/askspine/renderer.js"));
const receipts = require(path.join(ROOT, "src/askspine/receipt_service.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const guardWindow = require(path.join(ROOT, "tools/step12/guard_window.js"));
const grounded = require(path.join(ROOT, "tools/step12/grounded_evaluation.js"));

const URL = process.env.BUILD1_DATABASE_URL;
const SLUG = "maintenance.completion_without_valid_proof";

const laneOf = (e, name) =>
  ((e.totals && e.totals.lanes) || []).find((l) => l.lane === name) ||
  { total_matching: 0, selected_count: 0 };
const laneTotal = (e, name) => laneOf(e, name).total_matching;
const laneSel = (e, name) => laneOf(e, name).selected_count;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);

const ID = (n) => crypto.createHash("md5").update("build1:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");

const ORG = ID("org"), PROP = ID("prop"), OTHER = ID("other"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: BUILD1_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL, max: 6 });
  const c = await pool.connect();

  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  //  Migration 141 — the receipt table. Applied the way the train applies
  //  the others: the SQL file itself, so this proves the shipped DDL.
  await c.query(fs.readFileSync(
    path.join(ROOT, "migrations/141_ask_spine_read_receipts.sql"), "utf8"));

  await c.query(`insert into organizations (id,name) values ($1,'B1 Org') on conflict do nothing`, [ORG]);
  for (const [id, nm] of [[PROP, "B1 Property"], [OTHER, "B1 Other Property"]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [id, nm, ORG]);
  }
  await c.query(
    `insert into users (id,name,phone,role) values ($1,'B1 Tech','+15005550101','maintenance')
     on conflict (id) do nothing`, [TECH]);

  let seq = 0;
  const mkWo = async (status, prop = PROP) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'build1 fixture',$3,'build1proof')`, [wo, prop, status]);
    return wo;
  };

  console.log("BUILD 1 — maintenance.completion_without_valid_proof\n");

  /* ═══ A · BEFORE ACTIVATION ══════════════════════════════════════ */
  sec("A · before activation — the source cannot answer");
  {
    const e = await executor.execute(pool, {
      intent_slug: SLUG, property_id: PROP, allowed_modules: ["maintenance"] });
    ok("A1  coverage_state is UNAVAILABLE", e.coverage_state === "unavailable", e.coverage_state);
    ok("A2  …and NOT valid_empty", e.coverage_state !== "valid_empty",
       "a source that cannot answer must never be rendered as zero — this is the " +
       "single failure the whole architecture exists to prevent");
    ok("A3  the conclusion names the source, not a count",
       e.conclusion_code === "unavailable_source_cannot_answer", e.conclusion_code);
    ok("A4  no totals are asserted", e.totals === null, JSON.stringify(e.totals));
    const r = renderer.render(e);
    //  INTENT-NEUTRAL wording. The conclusion code is shared by every
    //  intent, so its sentence may not name one of them — the browser
    //  proof caught it saying "can't determine completion PROOF" in
    //  answer to a question about assignment.
    ok("A5  the sentence admits it",
       /can't answer that from governed truth/.test(r.answer), r.answer);
    ok("A6  the authority source is marked FAILED with its reason",
       e.source_outcomes.some((o) => o.status === "failed" && o.detail === "activation_absent"),
       JSON.stringify(e.source_outcomes));
    //  And it short-circuited BEFORE the population read: the invariant
    //  view is empty pre-activation by construction, so a reader that
    //  looked first would have counted zero and called it an answer.
    ok("A7  it did not even read the population",
       !e.source_outcomes.some((o) => o.id === "release_0_invariant_audit"),
       JSON.stringify(e.source_outcomes.map((o) => o.id)));
  }

  /* ═══ ACTIVATE ══════════════════════════════════════════════════ */
  await guardWindow.installGuard(c);
  const legacyWo = await guardWindow.withGuardOff(c,
    "the proof needs one pre-cutover legacy row, and Step 6 has already closed the " +
    "path that used to create them",
    async () => mkWo("closed"));
  const census = await activation.readLegacyTerminalSet(c);
  await c.query("begin");
  await activation.recordActivation(c, {
    activated_at: CUTOVER, captured_by: "build1 proof", expected: census });
  await c.query("commit");

  /* ═══ B · CLEAN POPULATION ══════════════════════════════════════ */
  sec("B · after activation, a governed completion — VALID_EMPTY is earned");
  {
    const wo = await mkWo("open");
    await grounded.preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH, seed: "b1" });
    await grounded.completeGoverned(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH, seed: "b1" });

    const e = await executor.execute(pool, {
      intent_slug: SLUG, property_id: PROP, allowed_modules: ["maintenance"] });
    ok("B1  lane A (current integrity) is empty", laneTotal(e, "current") === 0,
       JSON.stringify(e.totals));
    ok("B2  a properly proven completion is NOT reported as a gap",
       !e.supporting_records.some((r) => r.work_order_id === wo && r.lane === "current"),
       JSON.stringify(e.supporting_records.map((r) => [r.work_order_id, r.lane])));
    ok("B3  lane B carries the one pre-cutover row", laneTotal(e, "pre_cutover_history") === 1,
       JSON.stringify(e.totals));
    ok("B4  so the conclusion is current-none / legacy-present",
       e.conclusion_code === "current_none_legacy_present", e.conclusion_code);
    ok("B5  coverage is DECISIVE — the sources answered and something matched",
       e.coverage_state === "decisive", e.coverage_state);
    const r = renderer.render(e);
    ok("B6  the sentence separates the two lanes",
       /No current completions lack valid proof/.test(r.answer) &&
       /pre-cutover/.test(r.answer), r.answer);
    console.log(`        → "${r.answer}"`);
  }

  /* ═══ C · THE LANES ═════════════════════════════════════════════ */
  sec("C · lanes stay separate — a current failure is not history");
  {
    //  A post-cutover terminal row with no evaluation. Migration 140
    //  refuses this through governed operation, which is exactly why it
    //  has to be created through the guard window: the intent must still
    //  surface it honestly if it ever exists (ruling 9).
    const defect = await guardWindow.withGuardOff(c,
      "ruling 9 — the intent must surface a state migration 140 makes unreachable " +
      "through governed operation, so the proof has to manufacture one",
      async () => mkWo("complete"));

    const e = await executor.execute(pool, {
      intent_slug: SLUG, property_id: PROP, allowed_modules: ["maintenance"] });
    const cur = e.supporting_records.filter((r) => r.lane === "current");
    const hist = e.supporting_records.filter((r) => r.lane === "pre_cutover_history");

    ok("C1  the manufactured defect appears in the CURRENT lane",
       cur.some((r) => r.work_order_id === defect), JSON.stringify(cur.map((r) => r.work_order_id)));
    ok("C2  its canonical state is missing_evaluation_defect",
       cur.find((r) => r.work_order_id === defect).canonical_proof_state === "missing_evaluation_defect",
       JSON.stringify(cur.find((r) => r.work_order_id === defect)));
    ok("C3  the legacy row is in the HISTORY lane, never the current one",
       hist.some((r) => r.work_order_id === legacyWo) &&
       !cur.some((r) => r.work_order_id === legacyWo),
       JSON.stringify({ cur: cur.map((r) => r.work_order_id), hist: hist.map((r) => r.work_order_id) }));
    ok("C4  …and its canonical state is legacy_indeterminate",
       hist.find((r) => r.work_order_id === legacyWo).canonical_proof_state === "legacy_indeterminate");
    ok("C5  the totals are counted separately, never summed into one failure",
       laneTotal(e, "current") === 1 && laneTotal(e, "pre_cutover_history") === 1, JSON.stringify(e.totals));

    const r = renderer.render(e);
    ok("C6  the sentence says one current and one historical",
       /1 completed work order does not have valid proof/.test(r.answer) &&
       /1 older pre-cutover completion remains unverified/.test(r.answer), r.answer);
    ok("C7  and it NEVER says `14 work orders failed proof`",
       !new RegExp(`${e.totals.total_matching} (work orders|completed)`).test(r.answer) ||
       laneTotal(e, "current") === e.totals.total_matching,
       r.answer + " — summing the lanes would rewrite history");
    ok("C8  the internal state name does not travel outward",
       !/legacy_indeterminate/.test(r.answer), r.answer);
    console.log(`        → "${r.answer}"`);

    //  Clean up so later sections start from a known population.
    await guardWindow.withGuardOff(c, "removing the manufactured defect",
      async () => { await c.query(`delete from work_orders where id=$1`, [defect]); });
  }

  /* ═══ D · BOUNDEDNESS ═══════════════════════════════════════════ */
  sec("D · the whole population, a real total, a disclosed cap");
  {
    const cap = executor.loadContract(SLUG).result_cap_per_lane;
    //  MORE than the cap, and more than 100 — the Work Orders UI's
    //  historical "latest 100" behaviour would miss the tail entirely,
    //  and the tail is where a real answer hides.
    const N = 130;
    const made = await guardWindow.withGuardOff(c,
      "building a population larger than both the cap and the legacy latest-100 window",
      async () => {
        const ids = [];
        for (let i = 0; i < N; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          ids.push(await mkWo("complete"));
        }
        return ids;
      });
    const beyond100 = made[N - 1];

    const e = await executor.execute(pool, {
      intent_slug: SLUG, property_id: PROP, allowed_modules: ["maintenance"] });
    ok("D1  total_matching counts the FULL population, not the page",
       laneTotal(e, "current") === N, `${laneTotal(e, "current")} vs ${N}`);
    ok("D2  selected_count is capped", e.totals.selected_count <= cap + 1,
       JSON.stringify(e.totals));
    ok("D3  the cap came from the contract", e.totals.result_cap_per_lane === cap, String(e.totals.result_cap_per_lane));

    //  THE ONE THAT MATTERS: a matching row past position 100 is still
    //  counted. Deterministic ordering means it may not be on the page —
    //  but it must never be invisible to the total.
    const found = Number((await c.query(
      `select count(*)::int n from release_0_completion_invariant_violations
        where property_id=$1 and work_order_id=$2`, [PROP, beyond100])).rows[0].n);
    ok("D4  a matching work order beyond position 100 is still found",
       found === 1 && laneTotal(e, "current") >= 130,
       `view sees it: ${found}, total: ${laneTotal(e, "current")}`);

    const r = renderer.render(e);
    ok("D5  the answer DISCLOSES that it is showing a subset, PER LANE",
       /Showing \d+ of \d+ current/.test(r.boundedness_note || ""),
       String(r.boundedness_note));
    ok("D5b …and each lane respects the cap independently",
       laneSel(e, "current") <= cap && laneSel(e, "pre_cutover_history") <= cap,
       JSON.stringify(e.totals) +
       " — a shared budget would let a large pre-cutover history crowd current " +
       "integrity failures off the page, and the current lane is the urgent one");
    ok("D6  …and never implies completeness",
       !/^Here are the \d+ work orders/.test(r.answer), r.answer);
    console.log(`        → "${r.answer}"  [${r.boundedness_note}]`);

    //  Deterministic: the same question twice returns the same page.
    const e2 = await executor.execute(pool, {
      intent_slug: SLUG, property_id: PROP, allowed_modules: ["maintenance"] });
    ok("D7  the same question twice returns the same page",
       JSON.stringify(e.supporting_records.map((x) => x.work_order_id)) ===
       JSON.stringify(e2.supporting_records.map((x) => x.work_order_id)),
       "an unstable order would make two receipts disagree about a population " +
       "that never changed");

    await guardWindow.withGuardOff(c, "restoring a clean population",
      async () => { await c.query(`delete from work_orders where id = any($1::uuid[])`, [made]); });
  }

  /* ═══ E · THE RECEIPT ═══════════════════════════════════════════ */
  sec("E · the durable read receipt");
  {
    const e = await executor.execute(pool, {
      intent_slug: SLUG, property_id: PROP, allowed_modules: ["maintenance"] });
    const r = renderer.render(e);
    ok("E1  this answer requires a receipt", receipts.receiptRequired(e), e.coverage_state);
    const row = await receipts.writeReceipt(pool, {
      execution: e, rendered: r, property_id: PROP,
      actor: { user_id: TECH, session_id: null } });
    ok("E2  it persisted", !!row.id);

    const got = (await c.query(
      `select * from ask_spine_read_receipts where id=$1`, [row.id])).rows[0];
    ok("E3  it names the contract VERSION that produced it",
       got.intent_contract_version === executor.loadContract(SLUG).version,
       got.intent_contract_version);
    ok("E4  …and the contract DIGEST",
       got.intent_contract_digest === executor.loadContract(SLUG).digest);
    ok("E5  …and the candidate predicate version",
       got.candidate_predicate_version === "1.0.0", got.candidate_predicate_version);
    ok("E6  …the bounded counts", Number(got.total_matching) === e.totals.total_matching &&
       Number(got.result_cap_per_lane) === e.totals.result_cap_per_lane);
    ok("E7  …and the sentence actually shown", got.rendered_answer === r.answer);

    //  READ TIME IS NOT FACT TIME.
    ok("E8  executed_at and evidence_as_of are separate columns",
       "executed_at" in got && "evidence_as_of" in got);
    ok("E9  evidence_as_of carries its BASIS, never a substituted now()",
       typeof got.evidence_as_of_basis === "string" && got.evidence_as_of_basis.length > 0,
       got.evidence_as_of_basis);
    if (got.evidence_as_of) {
      ok("E10 …and the observed instant precedes the read",
         new Date(got.evidence_as_of) <= new Date(got.executed_at),
         `${got.evidence_as_of} vs ${got.executed_at}`);
    } else {
      ok("E10 …or is honestly null with a reason",
         got.evidence_as_of_basis === "no_evidence_timestamp" ||
         got.evidence_as_of_basis === "no_supporting_records", got.evidence_as_of_basis);
    }

    //  HISTORY IS IMMUTABLE.
    let refusedU = false, refusedD = false;
    try { await c.query(`update ask_spine_read_receipts set rendered_answer='rewritten' where id=$1`, [row.id]); }
    catch (err) { refusedU = /append-only/.test(err.message); }
    try { await c.query(`delete from ask_spine_read_receipts where id=$1`, [row.id]); }
    catch (err) { refusedD = /append-only/.test(err.message); }
    ok("E11 a receipt cannot be rewritten", refusedU);
    ok("E12 …nor deleted", refusedD);
  }

  /* ═══ F · REAL HTTP ═════════════════════════════════════════════ */
  sec("F · real HTTP, real session, server-derived authority");
  let server, base;
  {
    const app = express();
    app.use(express.json());
    app.use("/", require(path.join(ROOT, "src/agent/ask_spine.js"))({ pool }));
    await new Promise((res) => { server = app.listen(0, res); });
    base = `http://127.0.0.1:${server.address().port}`;

    const get = (p, headers) => new Promise((resolve) => {
      http.get(base + p, { headers: headers || {} }, (r) => {
        let b = ""; r.on("data", (d) => { b += d; });
        r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* not json */ }
          resolve({ status: r.statusCode, json: j, raw: b }); });
      }).on("error", () => resolve({ status: 0, json: null, raw: "" }));
    });

    const anon = await get("/operator/ask-spine/completion-proof-gaps");
    ok("F1  no session → 401", anon.status === 401, String(anon.status));

    //  A real staff session, issued by the shipped service.
    const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
    await c.query(
      `insert into property_team_assignments (user_id, property_id, role_title, allowed_modules, active)
       values ($1,$2,'Manager',array['maintenance'],true)
       on conflict do nothing`, [TECH, PROP]);
    //  A REAL session from the shipped issuer. `bootstrap_invite` is an
    //  existing governed purpose; this proof does not add one.
    const issued = await staffSessions.issueStaffSession(pool, {
      userId: TECH, propertyId: PROP, purpose: "bootstrap_invite" });
    const token = issued.session_token;

    const authed = await get("/operator/ask-spine/completion-proof-gaps",
      { "x-staff-session": token });
    ok("F2  a real session → 200", authed.status === 200, `${authed.status} ${authed.raw.slice(0, 200)}`);
    ok("F3  the property is echoed from the SESSION",
       authed.json && authed.json.property_id === PROP, JSON.stringify(authed.json && authed.json.property_id));
    ok("F4  the answer travels as a sentence, the counts as data",
       typeof authed.json.answer === "string" && typeof authed.json.totals === "object");
    ok("F5  the contract version and digest travel with the answer",
       authed.json.contract && authed.json.contract.version && authed.json.contract.digest,
       JSON.stringify(authed.json.contract));
    ok("F6  a receipt id came back", !!authed.json.receipt_id, String(authed.json.receipt_id));

    //  §21 — the browser may request; it may not decide.
    const spoof = await get(`/operator/ask-spine/completion-proof-gaps?property_id=${OTHER}`,
      { "x-staff-session": token });
    ok("F7  a client-supplied property_id is REFUSED, not ignored",
       spoof.status === 403, String(spoof.status));
    ok("F8  …and the refusal names the property actually in force",
       spoof.json && spoof.json.acting_on === PROP, JSON.stringify(spoof.json));

    //  Module entitlement.
    await c.query(`update property_team_assignments set allowed_modules = array['leasing']
                    where user_id=$1 and property_id=$2`, [TECH, PROP]);
    const noMod = await get("/operator/ask-spine/completion-proof-gaps", { "x-staff-session": token });
    ok("F9  no maintenance entitlement → unavailable, not an empty answer",
       noMod.json && noMod.json.coverage_state === "unavailable" &&
       noMod.json.conclusion_code === "unauthorized_module",
       JSON.stringify(noMod.json && noMod.json.coverage_state));
    ok("F10 …and the sentence says so plainly",
       /do not have maintenance access/.test(noMod.json.answer), noMod.json.answer);
    await c.query(`update property_team_assignments set allowed_modules = array['maintenance']
                    where user_id=$1 and property_id=$2`, [TECH, PROP]);
  }

  /* ═══ G · SCOPE ═════════════════════════════════════════════════ */
  sec("G · another property's matching row is absent, not merely filtered");
  {
    const foreign = await guardWindow.withGuardOff(c,
      "a matching row in a DIFFERENT property",
      async () => mkWo("complete", OTHER));
    const e = await executor.execute(pool, {
      intent_slug: SLUG, property_id: PROP, allowed_modules: ["maintenance"] });
    ok("G1  the other property's row is not in the records",
       !e.supporting_records.some((r) => r.work_order_id === foreign));
    ok("G2  …and not in the total either",
       !JSON.stringify(e.totals).includes("null") && laneTotal(e, "current") === 0,
       JSON.stringify(e.totals) + " — a leak in the COUNT is still a leak");
    const e2 = await executor.execute(pool, {
      intent_slug: SLUG, property_id: OTHER, allowed_modules: ["maintenance"] });
    ok("G3  and it IS visible to its own property",
       e2.supporting_records.some((r) => r.work_order_id === foreign),
       "otherwise G1 proves nothing — the row might simply not match");
    await guardWindow.withGuardOff(c, "cleanup",
      async () => { await c.query(`delete from work_orders where id=$1`, [foreign]); });
  }

  /* ═══ H · THE MODEL BOUNDARY ════════════════════════════════════ */
  sec("H · operating truth does not depend on a model");
  {
    const execSrc = fs.readFileSync(path.join(ROOT, "src/askspine/intent_executor.js"), "utf8");
    const rendSrc = fs.readFileSync(path.join(ROOT, "src/askspine/renderer.js"), "utf8");
    ok("H1  the executor imports no model client",
       !/@anthropic-ai|openai|anthropic/i.test(execSrc.replace(/\/\*[\s\S]*?\*\//g, "")));
    ok("H2  the renderer imports no model client",
       !/@anthropic-ai|openai|anthropic/i.test(rendSrc.replace(/\/\*[\s\S]*?\*\//g, "")));
    ok("H3  an unknown conclusion code is REFUSED, not improvised", (() => {
      try { renderer.render({ conclusion_code: "invented_by_a_model", totals: null }); return false; }
      catch (e) { return /refuses to improvise/.test(e.message); }
    })());
    const e = await executor.execute(pool, {
      intent_slug: "maintenance.something_we_never_froze",
      property_id: PROP, allowed_modules: ["maintenance"] });
    ok("H4  a question outside the contract set is UNSUPPORTED",
       e.coverage_state === "unsupported", e.coverage_state);
    ok("H5  …and is not answered from nearby data",
       e.supporting_records.length === 0 && e.totals === null);
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}\n`);
  server.close();
  c.release();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
