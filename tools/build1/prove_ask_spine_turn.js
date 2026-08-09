#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE ASK SPINE TURN — question → understanding → governed answer

     R  resolution: supported, ambiguous, unsupported, and the frontier
     S  the turn, over real HTTP
     T  clarification is not an answer, and earns no receipt
     U  correction lineage — the original is never overwritten
     V  reload comes from the RECEIPT, never a transcript
     W  the model boundary: no model exists on this path at all
     X  supporting records across TWO entity types, unflattened
     Y  no operating state was mutated by answering

   ⚠ ISOLATED POSTGRES ONLY — run through tools/build1/run_isolated.sh.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const resolver = require(path.join(ROOT, "src/askspine/intent_resolver.js"));
const askService = require(path.join(ROOT, "src/askspine/ask_service.js"));
const acceptance = require(path.join(ROOT, "src/technician/acceptance_service.js"));

const URL = process.env.TURN_DATABASE_URL;
const C1 = "maintenance.completion_without_valid_proof";
const C2 = "maintenance.ownership_and_acceptance";

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);

const ID = (n) => crypto.createHash("md5").update("turn:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), ALICE = ID("alice");

(async function main() {
  if (!URL) { console.error("REFUSED: TURN_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL, max: 8 });
  const c = await pool.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  for (const m of ["141_ask_spine_read_receipts.sql",
                   "142_obligation_acceptance_cannot_be_orphaned.sql",
                   "143_ask_spine_interpretations.sql"]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(fs.readFileSync(path.join(ROOT, "migrations", m), "utf8"));
  }
  await c.query(`insert into organizations (id,name) values ($1,'Turn') on conflict do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'Turn Prop',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role)
                 values ($1,'Alice','+15005553001','maintenance') on conflict (id) do nothing`, [ALICE]);
  await c.query(`insert into property_team_assignments
                   (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Technician',array['maintenance'],true)
                 on conflict do nothing`, [ALICE, PROP]);

  const wo = ID("wo1");
  await c.query(`insert into work_orders (id,property_id,title,status,source)
                 values ($1,$2,'turn fixture','open','turnproof')`, [wo, PROP]);
  const o1 = (await c.query(
    `insert into obligations (property_id,related_id,related_type,module,type,label,assigned_user_id,status)
     values ($1,$2,'work_order','maintenance','work_order_routing','route',$3,'open') returning id`,
    [PROP, wo, ALICE])).rows[0].id;
  await acceptance.acceptWork(c, { obligation_id: o1, user_id: ALICE,
    organization_id: ORG, acceptance_key: "turn-1" });
  await c.query(
    `insert into obligations (property_id,related_id,related_type,module,type,label,status)
     values ($1,$2,'work_order','maintenance','proof_evaluation_missing','defect','open')`, [PROP, wo]);

  const askIt = (q, extra = {}) => askService.ask(pool, {
    question: q, property_id: PROP, allowed_modules: ["maintenance"],
    actor: { user_id: ALICE }, ...extra });

  console.log("THE ASK SPINE TURN\n");

  /* ═══ R · RESOLUTION ════════════════════════════════════════════ */
  sec("R · what Spine understood — and when it refuses to decide");
  {
    const cases = [
      ["Which completed repairs don't have proof?", "resolved", C1],
      ["Who is assigned to maintenance work and has accepted it?", "resolved", C2],
      ["Who actually took the maintenance work?", "resolved", C2],
      ["What's blocked right now?", "unsupported", null],
      ["What did all this cost?", "unsupported", null],
      ["Who is accountable for this?", "unsupported", null],
      ["What's wrong with maintenance?", "clarification_required", null],
    ];
    for (const [q, want, slug] of cases) {
      const r = resolver.resolve(q);
      ok(`R·  "${q}" → ${want}`, r.resolution === want &&
         (!slug || r.intent_slug === slug),
         JSON.stringify(r).slice(0, 130));
    }
    const blocked = resolver.resolve("What's blocked right now?");
    ok("R1  the blocked frontier is NAMED, not merely unrecognised",
       blocked.topic === "blocked_work" && /no governed resolution/.test(blocked.why),
       JSON.stringify(blocked));
    console.log(`        → "${blocked.why}"`);
    const vague = resolver.resolve("What needs attention in maintenance?");
    ok("R2  a vague question does NOT fall through to maintenance.attention",
       vague.resolution === "clarification_required" &&
       !JSON.stringify(vague).includes("attention"),
       JSON.stringify(vague).slice(0, 140));
  }

  /* ═══ S · THE TURN OVER REAL HTTP ═══════════════════════════════ */
  sec("S · one turn, over a real socket, with a real session");
  let server, post, get;
  {
    const app = express();
    app.use(express.json());
    app.use("/", require(path.join(ROOT, "src/agent/ask_spine.js"))({ pool }));
    server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const port = server.address().port;
    const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
    const issued = await staffSessions.issueStaffSession(pool, {
      userId: ALICE, propertyId: PROP, purpose: "bootstrap_invite" });
    const TOKEN = issued.session_token;

    const call = (method, p, body, headers) => new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: "127.0.0.1", port, path: p, method,
        headers: { "content-type": "application/json",
                   ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
                   ...(headers || {}) } }, (r) => {
        let b = ""; r.on("data", (d) => { b += d; });
        r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* */ }
          resolve({ status: r.statusCode, json: j }); });
      });
      req.on("error", () => resolve({ status: 0, json: null }));
      if (data) req.write(data);
      req.end();
    });
    post = (p, b) => call("POST", p, b, { "x-staff-session": TOKEN });
    get = (p) => call("GET", p, null, { "x-staff-session": TOKEN });

    ok("S1  no session → 401",
       (await call("POST", "/operator/ask-spine/ask", { question: "x" })).status === 401);

    const a = await post("/operator/ask-spine/ask",
      { question: "Who is assigned to maintenance work and has accepted it?" });
    ok("S2  a supported question is answered", a.status === 200 && a.json.outcome === "answered",
       JSON.stringify(a.json && a.json.outcome));
    ok("S3  the turn says what it UNDERSTOOD, not just the answer",
       a.json.understood && a.json.understood.intent_slug === C2,
       JSON.stringify(a.json.understood));
    ok("S4  …with a governed answer", typeof a.json.answer === "string" && a.json.answer.length > 0,
       a.json.answer);
    ok("S5  …a durable receipt", !!a.json.receipt_id);
    ok("S6  …and a recorded interpretation", !!a.json.interpretation_id);
    console.log(`        → understood: ${a.json.understood.intent_slug}`);
    console.log(`        → "${a.json.answer}"`);

    const caps = await get("/operator/ask-spine/capabilities");
    ok("S7  the surface can state its own frontier",
       caps.json.supported.length === 2 &&
       caps.json.not_supported.some((t) => t.topic === "blocked_work"),
       JSON.stringify(caps.json).slice(0, 120));
  }

  /* ═══ T · CLARIFICATION IS NOT AN ANSWER ════════════════════════ */
  sec("T · a clarification records a reading and earns no receipt");
  let clarifyId = null;
  {
    const r = await post("/operator/ask-spine/ask", { question: "What's wrong with maintenance?" });
    clarifyId = r.json.interpretation_id;
    ok("T1  the turn asks rather than guessing",
       r.json.outcome === "clarification_required", r.json.outcome);
    ok("T2  …offering both supported readings",
       r.json.candidates.length === 2, JSON.stringify(r.json.candidates));
    ok("T3  …with NO receipt", r.json.receipt_id === null, String(r.json.receipt_id));
    ok("T4  …and NO records", r.json.supporting_records.length === 0);
    const row = (await c.query(
      `select * from ask_spine_interpretations where id=$1`, [clarifyId])).rows[0];
    ok("T5  the interpretation is recorded as clarification_required",
       row.resolution === "clarification_required" && row.intent_slug === null,
       JSON.stringify({ r: row.resolution, s: row.intent_slug }));
    ok("T6  …and the schema REFUSES to attach a receipt to it", await (async () => {
      try {
        await c.query(`update ask_spine_interpretations set read_receipt_id=$1 where id=$2`,
          [null, clarifyId]);
        return false;   // append-only should refuse the UPDATE outright
      } catch (e) { return /append-only/.test(e.message); }
    })());

    const unsupported = await post("/operator/ask-spine/ask", { question: "What's blocked?" });
    ok("T7  an unsupported question tells the truth about the frontier",
       unsupported.json.outcome === "unsupported" &&
       /not currently supported|can't answer that yet/i.test(unsupported.json.answer),
       unsupported.json.answer);
    ok("T8  …and is NOT an empty answer", unsupported.json.totals === null &&
       unsupported.json.supporting_records.length === 0 &&
       unsupported.json.coverage_state === undefined,
       "an unsupported question that renders as `0 results` is a lie");
    console.log(`        → "${unsupported.json.answer}"`);
  }

  /* ═══ U · CORRECTION LINEAGE ════════════════════════════════════ */
  sec("U · a correction adds a reading; it never overwrites one");
  {
    const first = await post("/operator/ask-spine/ask",
      { question: "Which completed repairs don't have proof?" });
    ok("U1  the first turn resolved to completion proof",
       first.json.understood.intent_slug === C1, first.json.understood.intent_slug);

    const correction = await post("/operator/ask-spine/ask", {
      question: "No, I meant who accepted it",
      preferred_intent: C2,
      corrects_interpretation_id: first.json.interpretation_id });
    ok("U2  the correction resolves to the OTHER intent",
       correction.json.understood.intent_slug === C2, correction.json.understood.intent_slug);

    const orig = (await c.query(`select * from ask_spine_interpretations where id=$1`,
      [first.json.interpretation_id])).rows[0];
    const corr = (await c.query(`select * from ask_spine_interpretations where id=$1`,
      [correction.json.interpretation_id])).rows[0];
    ok("U3  the ORIGINAL interpretation is unchanged", orig.intent_slug === C1, orig.intent_slug);
    ok("U4  the correction NAMES the reading it corrects",
       corr.corrects_id === first.json.interpretation_id, String(corr.corrects_id));
    ok("U5  both readings survive, so the pair is legible",
       orig.id !== corr.id && orig.question_text !== corr.question_text);
    //  Whatever the first turn produced, the interpretation records it
    //  faithfully. In THIS fixture Release 0 is unactivated, so C1 is
    //  honestly unavailable and earns no receipt — and the interpretation
    //  must not claim one. That is the assertion worth making.
    ok("U6  …and the original interpretation records its receipt faithfully",
       orig.read_receipt_id === (first.json.receipt_id || null),
       JSON.stringify({ interp: orig.read_receipt_id, turn: first.json.receipt_id }));
    ok("U7  …with C1 honestly unavailable here (no activation in this fixture)",
       first.json.coverage_state === "unavailable" && first.json.receipt_id === null,
       String(first.json.coverage_state));
    console.log(`        → "${orig.question_text}" → ${orig.intent_slug}`);
    console.log(`        → "${corr.question_text}" → ${corr.intent_slug} (corrects the above)`);
  }

  /* ═══ V · RELOAD FROM THE RECEIPT ═══════════════════════════════ */
  sec("V · a completed answer reloads from its receipt, not a transcript");
  {
    const a = await post("/operator/ask-spine/ask",
      { question: "Who is assigned to maintenance work?" });
    const replay = await get(`/operator/ask-spine/receipt/${a.json.receipt_id}`);
    ok("V1  the receipt rebuilds the answer", replay.status === 200 &&
       replay.json.replayed_from === "read_receipt", JSON.stringify(replay.json && replay.json.replayed_from));
    ok("V2  …the SAME sentence that was shown", replay.json.answer === a.json.answer,
       `${replay.json.answer} vs ${a.json.answer}`);
    ok("V3  …with the contract that produced it",
       replay.json.contract.version && replay.json.contract.digest);
    ok("V4  …and the records", replay.json.supporting_records.length ===
       a.json.supporting_records.length);

    //  GOVERNED TRUTH MOVES. The receipt must NOT.
    await c.query(
      `insert into obligations (property_id,related_id,related_type,module,type,label,status)
       values ($1,$2,'work_order','maintenance','resident_follow_up','new one','open')`, [PROP, wo]);
    const fresh = await post("/operator/ask-spine/ask",
      { question: "Who is assigned to maintenance work?" });
    const replayAgain = await get(`/operator/ask-spine/receipt/${a.json.receipt_id}`);
    ok("V5  a NEW answer reflects the new truth", fresh.json.answer !== a.json.answer,
       `${fresh.json.answer}`);
    ok("V6  …while the OLD receipt still says what it said",
       replayAgain.json.answer === a.json.answer, replayAgain.json.answer);

    const other = await get(`/operator/ask-spine/receipt/${ID("nope")}`);
    ok("V7  a receipt outside this property is not readable", other.status === 404,
       String(other.status));
  }

  /* ═══ W · THE MODEL BOUNDARY ════════════════════════════════════ */
  sec("W · there is no model on this path to turn off");
  {
    for (const f of ["src/askspine/intent_resolver.js", "src/askspine/ask_service.js",
                     "src/askspine/intent_executor.js", "src/askspine/renderer.js"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
      ok(`W·  ${path.basename(f)} imports no model client`,
         !/@anthropic-ai|openai|anthropic|messages\.create/i.test(src));
    }
    const saved = {};
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL"]) {
      saved[k] = process.env[k]; delete process.env[k];
    }
    const out = await askIt("Who is assigned to maintenance work and has accepted it?");
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    ok("W1  a governed turn completes with every model credential removed",
       out.outcome === "answered" && out.coverage_state === "decisive", out.coverage_state);
    ok("W2  …and still produced a receipt", !!out.receipt_id);
  }

  /* ═══ X · TWO ENTITY TYPES ══════════════════════════════════════ */
  sec("X · supporting records across both capabilities, unflattened");
  {
    const own = await askIt("Who is assigned to maintenance work?");
    ok("X1  Capability 2 returns OBLIGATIONS",
       own.supporting_records.every((r) => r.record_type === "obligation"),
       JSON.stringify([...new Set(own.supporting_records.map((r) => r.record_type))]));
    ok("X2  …each carrying its related work order as CONTEXT",
       own.supporting_records.every((r) => !!r.work_order_id));
    const many = own.supporting_records.filter((r) => r.work_order_id === wo);
    ok("X3  …and one work order still yields several, unflattened", many.length >= 2,
       String(many.length));
    ok("X4  no record invented a priority, ranking or recommendation",
       own.supporting_records.every((r) =>
         !("priority" in r) && !("rank" in r) && !("recommendation" in r) &&
         !("next_action" in r)),
       "supporting records are not a second task system");
  }

  /* ═══ Y · NOTHING WAS MUTATED ═══════════════════════════════════ */
  sec("Y · answering changed no operating state");
  {
    const snap = async () => (await c.query(
      `select (select count(*) from work_orders)::int wo,
              (select count(*) from obligations)::int ob,
              (select count(*) from work_order_proof_evaluations)::int ev,
              (select count(*) from work_order_progress)::int pr,
              (select coalesce(sum(case when accepted_at is not null then 1 else 0 end),0) from obligations)::int acc`
    )).rows[0];
    const before = await snap();
    await askIt("Which completed repairs don't have proof?");
    await askIt("Who is assigned to maintenance work?");
    await askIt("What's wrong with maintenance?");
    await askIt("What's blocked?");
    const after = await snap();
    ok("Y1  no work order, obligation, evaluation, progress row or acceptance changed",
       JSON.stringify(before) === JSON.stringify(after),
       `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    console.log("        → Ask Spine reads and explains. It does not act.");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}\n`);
  if (server) server.close();
  c.release();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
