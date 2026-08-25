/* ════════════════════════════════════════════════════════════════════
   skyline_ask_spine_leasing_http.db.js — LEASING, THROUGH THE REAL DOOR.
   REAL POSTGRES · REAL EXPRESS · REAL HTTP · REAL SESSION.

   §33's proof ladder puts "Proven (real DB + real HTTP)" between the unit
   rung and the browser rung. Tenancy has that rung
   (tenancy_ask_spine_http.db.js). LEASING — the person-grain domain that
   answers "has Jane signed", "what is holding this up", "who owns the
   next step" — did not. Its reader (leasing_standing_read.js) is proven
   directly; its composer branch is proven with an injected stub. Neither
   proves that an operator's actual request, over a socket, carrying a
   real session token, reaches the real canonical leasing read — which is
   the only claim that matters to a person holding a phone.

   ── SELF-SEEDED, DELIBERATELY ───────────────────────────────────────
   The tenancy proof loads 160 real beds from a rent-roll XLSX held
   outside this repository. That makes it unrunnable anywhere the file is
   absent, and a harness that cannot run in CI is not a gate. This one
   seeds every row it needs from SQL, so it runs wherever the migration
   chain does. It proves a different thing from the tenancy proof and is
   not a copy of it.

   ── WHAT IS REAL HERE, AND WHAT IS NOT ──────────────────────────────
   REAL: Postgres with the whole schema; a users row, a
   property_team_assignments row and a staff_sessions row resolved by the
   real resolveStaffSession; the real ask_spine router on a real Express
   app; requests over a real socket; the real leasing_standing_read.

   NOT REAL: the Anthropic client. It is a stub that CAPTURES what it was
   sent, and honours DECISION_SCHEMA. That is the point rather than a
   compromise — what needs proving is which facts crossed into model
   context. A stub that returns prose instead of the schema silently
   tests the FAILURE path while looking like the success path; that
   defect was made and caught in the sibling matrix harness, and the
   shape is asserted here rather than assumed.

   ── WHAT THIS RUNG EXISTS TO CATCH ──────────────────────────────────
   1  §21 · property authority is server-derived. A body naming another
      property is REFUSED, not ignored.
   2  §40.8 · entitlement precedes intelligence. An operator without
      leasing or management never causes resolveLeasingSubject or
      readLeasingStanding to run — asserted by the READER's own call
      count, not by reading the answer.
   3  §40.8 · no record id crosses into model context. Leasing standing
      is dense with uuids (packet_id, obligation_id, record_id), so this
      is the domain where withoutDatabaseIds actually earns its keep.
   4  §40.7 · the four leasing silences stay apart over the wire:
      NO_SUBJECT · AMBIGUOUS_SUBJECT · READ_FAILED · settled.
   5  The facts on the wire ARE the canonical read — not something that
      merely resembles it.

   ── WHAT THIS HARNESS ONCE PINNED, AND WHAT REPLACED IT ────────────
   Its first version recorded three defects as CURRENT BEHAVIOUR because
   they were durable product questions outside its lane. All three have
   since been repaired in src/agent/ask_spine_answer.js, so the pins are
   gone and the assertions are positive — pinning them now would assert
   the bug.

   D1/D1b (repaired) leasing_person was the only entitled subject with no
      top-level refusal. An unentitled question fell through to
      gatherFacts, spent a model call and returned `answered` with wording
      the model invented over a marker the system prompt never defines.
      It now returns the literal `not_authorized`, with Spine's own
      sentence, before gatherFacts and before Anthropic. L7–L11g.
   D2 (repaired) grounded_on carried no leasing key, so the one domain
      that answers about a named human was the one whose answer an
      operator could not check. Nine fields now come straight from the
      canonical read. L32–L40.

   ── WHAT IS STILL PINNED ────────────────────────────────────────────
   D3 · addressing matches the WHOLE recorded name, so "has Dana signed"
      resolves nobody and reports the same silence as a question naming
      no human at all. Safe — it never answers about the wrong person —
      but the sentence people actually say does not arrive, and the
      operator is not told a partial name was the reason. Held with Codex
      alongside the SMS surface-split and phrase-routing findings.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL —
   through the shared receipt guard, never a hand-rolled one.
   Every id is disposable and created by this file. It touches no
   pre-existing property, person or tour.

   CLASS 3 — test infrastructure. Removed when the leasing Ask Spine
   contract it pins is retired.

   Run:
     HARNESS_DATABASE_URL=postgres://postgres@127.0.0.1:5433/spine_verify \
       node tests/skyline_ask_spine_leasing_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const http = require("http");
const crypto = require("crypto");
const express = require("express");

const leasingRead = require("../src/leasing/leasing_standing_read.js");
const askSpineAnswer = require("../src/agent/ask_spine_answer.js");

const ORG = "Skyline Ask Spine Leasing HTTP";
const EMAIL_LIKE = "skyline-leasing-http-%@test";
const PERSON_SOURCE = "skyline_leasing_http";

let pass = 0, fail = 0, ran = 0; const failures = []; const divergences = [];
function ok(l, c, d) {
  ran++;
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
}
function divergence(text) { divergences.push(text); }
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/*  A real request over a real socket. No supertest, no in-process
 *  shortcut — the header, the body and the status line all travel.  */
function post(port, path_, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      { host: "127.0.0.1", port, path: path_, method: "POST",
        headers: { "content-type": "application/json",
                   "content-length": Buffer.byteLength(payload), ...(headers || {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { /* leave null; the test says so */ }
          resolve({ status: res.statusCode, json, raw });
        });
      });
    req.on("error", reject);
    req.end(payload);
  });
}

async function cleanup(pool) {
  const props = (await pool.query(
    `select p.id from properties p join organizations o on o.id=p.organization_id where o.name=$1`,
    [ORG])).rows;
  for (const { id } of props) {
    await pool.query(`delete from staff_sessions where property_id=$1`, [id]);
    await pool.query(`delete from property_team_assignments where property_id=$1`, [id]);
    await pool.query(`delete from executed_lease_records where property_id=$1`, [id]);
    await pool.query(`delete from lease_packets where property_id=$1`, [id]);
    await pool.query(`delete from lease_applications where property_id=$1`, [id]);
    await pool.query(`delete from spaces where unit_id in (select id from units where property_id=$1)`, [id]);
    await pool.query(`delete from units where property_id=$1`, [id]);
    await pool.query(`delete from leasing_leads where property_id=$1`, [id]);
    await pool.query(`delete from leasing_conversions where property_id=$1`, [id]);
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`delete from persons where source=$1`, [PERSON_SOURCE]);
  await pool.query(`delete from users where email like $1`, [EMAIL_LIKE]);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

receipt.begin(__filename, { url: CONN, expected: 128 });

(async () => {
  const pool = new Pool({ connectionString: CONN });
  await cleanup(pool);

  // ── DISPOSABLE PROPERTY, DISPOSABLE PEOPLE ────────────────────────
  const org = (await pool.query(
    `insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
  const prop = (await pool.query(
    `insert into properties (name, address, organization_id, leasing_basis)
     values ('Skyline Leasing Proof','1417 N 15th St',$1,'bed') returning id`, [org])).rows[0].id;
  const otherProp = (await pool.query(
    `insert into properties (name, address, organization_id)
     values ('Elsewhere Leasing Proof','1 Other St',$1) returning id`, [org])).rows[0].id;

  //  Three people, chosen for what each proves:
  //    Marisol Trejo  — unique here; the resolvable subject.
  //    Dana Whitfield — also at THIS property, and there are two of them,
  //                     so "Dana" is genuinely ambiguous.
  //    Jordan Pike    — present only at the OTHER property, so naming
  //                     Jordan must NOT resolve. Addressing is scoped to
  //                     the server-derived property, and a harness that
  //                     never tries to cross that line has not tested it.
  async function person(name, atProperty) {
    const id = (await pool.query(
      `insert into persons (name, source, lifecycle_status, leasing_stage)
       values ($1,$2,'prospect','prospect') returning id`, [name, PERSON_SOURCE])).rows[0].id;
    await pool.query(
      `insert into leasing_leads (person_id, property_id) values ($1,$2)`, [id, atProperty]);
    return id;
  }
  const marisol = await person("Marisol Trejo", prop);
  await person("Dana Whitfield", prop);
  await person("Dana Whitfield", prop);
  await person("Jordan Pike", otherProp);

  //  A real application for Marisol, so her standing read has something
  //  to stand on rather than reading an empty person.
  const application = (await pool.query(
    `insert into lease_applications (property_id, person_id, status, applicant_name)
     values ($1,$2,'submitted','Marisol Trejo') returning id`, [prop, marisol])).rows[0].id;

  /*  ── A PACKET AND AN EXECUTED RECORD THAT CARRY REAL HASHES ────────
   *  Without these the canonical read returns no `lease` band at all,
   *  the hash keys are simply absent, and an assertion that "no hash
   *  reaches the model" passes by measuring an empty payload. That is
   *  precisely the false green this file exists to prevent: the FIRST
   *  version of this harness seeded no packet, so the two hash leaks it
   *  later reported were read out of the source rather than measured.
   *  The seeded values are distinctive, so the assertions can look for
   *  the exact strings and not merely for a key name.
   *
   *  The schema is strict here and correctly so: `document_sha256` is
   *  only permitted alongside a full spine_instrument lineage, and the
   *  executed document's hash must equal the packet's package hash. The
   *  seed satisfies the real constraints rather than working around
   *  them.  */
  const HASH = {
    body:    "b0dy" + "a".repeat(60),
    terms:   "7e2m" + "b".repeat(60),
    package: "9ac4" + "c".repeat(60),
    //  NOT NULL on executed_lease_records, so EVERY real executed record
    //  carries one. The only thing keeping it out of model context is the
    //  reader's SELECT list — not its absence. Seeded so the proof can say
    //  that from measurement rather than from reading the schema.
    payload:  "9a71" + "e".repeat(60),
  };
  const packet = (await pool.query(
    `insert into lease_packets (property_id, application_id, version, status, is_placeholder,
        instrument_form_code, instrument_form_version, instrument_body_sha256,
        instrument_terms_sha256, instrument_package_sha256, resident_executed_at)
     values ($1,$2,1,'sent',false,'PA-RES-2026','1.0',$3,$4,$5,now()) returning id`,
    [prop, application, HASH.body, HASH.terms, HASH.package])).rows[0].id;
  {
    const ev = (await pool.query(
      `insert into events (type) values ('lease_executed') returning id`)).rows[0].id;
    const verifier = (await pool.query(
      `insert into users (name,email,role,account_kind)
       values ($1,$1,'property_manager','human_staff') returning id`,
      ["skyline-leasing-http-verifier@test"])).rows[0].id;
    const unit = (await pool.query(
      `insert into units (property_id,unit_number,occupancy_status)
       values ($1,'101','unknown') returning id`, [prop])).rows[0].id;
    const space = (await pool.query(
      `insert into spaces (unit_id,space_label) values ($1,'A') returning id`, [unit])).rows[0].id;
    await pool.query(
      `insert into executed_lease_records (property_id, application_id, space_id, rent,
          security_deposit, lease_start_date, lease_end_date, document_sha256, payload_hash, signers,
          verified_by_user_id, event_id, executed_at, execution_channel, admission_status,
          admission_blockers, verification_basis, source_lease_packet_id)
       values ($1,$2,$3,1450,1450,current_date,current_date + 365,$4,$5,
               '[{"role":"resident","name":"Marisol Trejo"}]',$6,$7,current_date,'spine_esign',
               'blocked','[{"code":"deposit_unpaid"}]','spine_instrument',$8)`,
      [prop, application, space, HASH.package, HASH.payload, verifier, ev, packet]);
  }

  // ── REAL OPERATORS, REAL SESSIONS ─────────────────────────────────
  async function operator(email, modules) {
    const uid = (await pool.query(
      `insert into users (name,email,role,account_kind)
       values ($1,$2,'property_manager','human_staff') returning id`, [email, email])).rows[0].id;
    await pool.query(
      `insert into property_team_assignments (property_id,user_id,role_title,allowed_modules,active)
       values ($1,$2,'Operator',$3::text[],true)`, [prop, uid, modules]);
    const token = crypto.randomBytes(24).toString("hex");
    await pool.query(
      `insert into staff_sessions (user_id,property_id,token_digest,issuance_purpose,expires_at)
       values ($1,$2,$3,'bootstrap_invite',now() + interval '1 hour')`,
      [uid, prop, digest(Buffer.from(token))]);
    return token;
  }
  const leasingToken = await operator("skyline-leasing-http-leasing@test", ["leasing"]);
  const amOnlyToken = await operator("skyline-leasing-http-am@test", ["asset_management"]);

  // ── THE REAL ROUTER, ON A REAL SERVER ─────────────────────────────
  //  The stub RECORDS, and returns the DECISION SCHEMA the composer
  //  actually requires. Anything else exercises the "model did not
  //  return a valid decision" path while looking like success.
  const modelCalls = [];
  const anthropic = { messages: { create: async (input) => {
    modelCalls.push(input);
    return { content: [{ type: "text", text: JSON.stringify({
      outcome: "answered",
      answer: "Marisol Trejo has an application submitted; nothing is signed yet.",
    }) }] };
  } } };

  /*  ⚠ COUNTING READER — AND A DEFECT THIS FILE MADE FIRST.
   *
   *  The first version built a wrapper object and passed it nowhere. The
   *  router takes { pool, anthropic }; it has no reader injection, and
   *  answer() resolves its default from its own module-level require. So
   *  the counters stayed at zero on EVERY path, and the three assertions
   *  standing on them — including L7, the headline §40.8 assertion —
   *  were green because nothing could ever move them. Caught by the
   *  falsification cycle: the sibling matrix harness went red and this
   *  one did not, on the same removed predicate.
   *
   *  A measurement that cannot move is not evidence. So the REAL module
   *  object is instrumented in place. ask_spine_answer.js holds this
   *  exact object and looks the method up at call time, so the real
   *  router on the real socket runs through these counters — no
   *  reimplementation, no second path, and L7b below PROVES the counter
   *  can move before any assertion relies on it standing still.  */
  const readerCalls = { subject: 0, standing: 0 };
  const realResolve = leasingRead.resolveLeasingSubject;
  const realStanding = leasingRead.readLeasingStanding;
  leasingRead.resolveLeasingSubject = (...a) => { readerCalls.subject++; return realResolve(...a); };
  leasingRead.readLeasingStanding = (...a) => { readerCalls.standing++; return realStanding(...a); };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(require("../src/agent/ask_spine.js")({ pool, anthropic }));
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const port = server.address().port;

  const askLeasing = (q, token) => post(port, "/operator/ask-spine/ask",
    { question: q }, { "x-staff-session": token });

  //  The question this harness is about. Asserted to ROUTE to leasing
  //  before it is used, so a routing change cannot silently turn every
  //  assertion below into a proof about a different domain.
  const Q = "has Marisol Trejo signed her lease packet";

  console.log("\n  ── the sentence under test really is a leasing question ──");
  ok("L0  the question routes to leasing_person",
     askSpineAnswer.questionSubject(Q) === "leasing_person",
     askSpineAnswer.questionSubject(Q));

  console.log("\n  ── the door itself ──");
  {
    const r = await post(port, "/operator/ask-spine/ask", { question: Q });
    ok("L1  no session is 401, not an empty answer", r.status === 401, `${r.status} ${r.raw.slice(0, 120)}`);
    ok("L2  …and the model was never called", modelCalls.length === 0, `${modelCalls.length} call(s)`);
    ok("L3  …and the leasing reader was never called",
       readerCalls.subject === 0 && readerCalls.standing === 0, JSON.stringify(readerCalls));
  }
  {
    //  §21. The browser may REQUEST; it may not determine authority.
    const r = await post(port, "/operator/ask-spine/ask",
      { question: Q, property_id: otherProp }, { "x-staff-session": leasingToken });
    ok("L4  a body naming another property is REFUSED (403), not quietly ignored",
       r.status === 403, `${r.status} ${r.raw.slice(0, 160)}`);
    ok("L5  …and the refusal names the property it IS acting on",
       r.json && String(r.json.acting_on) === String(prop), JSON.stringify(r.json));
    ok("L6  …and still no reader call",
       readerCalls.subject === 0 && readerCalls.standing === 0, JSON.stringify(readerCalls));
  }

  console.log("\n  ── §40.8 · entitlement precedes intelligence, over the wire ──");
  /*  ── WHAT CHANGED HERE, AND WHY THE OLD ASSERTIONS ARE GONE ────────
   *  The previous version of this block PINNED a defect: leasing_person
   *  was the only entitled subject with no top-level refusal, so an
   *  unentitled question fell through to gatherFacts, spent a model call
   *  and came back `answered` with wording the model invented over a
   *  marker the system prompt never defines. Those assertions were
   *  correct about the product as it stood. The product has been
   *  repaired, so pinning that behaviour would now assert the bug.
   *
   *  The refusal is the product, so the refusal is what is asserted —
   *  not the inner NOT_AUTHORIZED fact envelope, which still exists as
   *  depth and would happily keep passing with the top-level refusal
   *  removed.  */
  {
    const beforeModel = modelCalls.length;
    const r = await askLeasing(Q, amOnlyToken);

    ok("L7  an asset-management-only operator never causes the leasing reader to run",
       readerCalls.subject === 0 && readerCalls.standing === 0, JSON.stringify(readerCalls));
    ok("L8  …and Anthropic is NEVER reached for an unentitled question",
       modelCalls.length === beforeModel, `${modelCalls.length - beforeModel} call(s)`);
    ok("L9  …the outcome is the literal `not_authorized`, not a composed sentence",
       r.status === 200 && r.json && r.json.outcome === "not_authorized",
       `${r.status} ${JSON.stringify(r.json && r.json.outcome)}`);
    /*  A refusal a person can see is PRODUCT COPY (§5). The exact string
     *  is asserted, not a shape: "it said something refusal-ish" is how
     *  a model-authored sentence slips back in unnoticed. It must also
     *  name a next step, which here is the access that would grant it.  */
    ok("L10 …and the sentence is Spine's own, deterministic and unchanged run to run",
       r.json.answer === "A person's leasing standing is not available in your "
                       + "current access for this property.",
       JSON.stringify(r.json && r.json.answer));
    ok("L11 …grounded_on is null — there is nothing to ground a refusal on",
       r.json.grounded_on === null, JSON.stringify(r.json.grounded_on));
    ok("L11b …and references is an empty array, not absent",
       Array.isArray(r.json.references) && r.json.references.length === 0,
       JSON.stringify(r.json.references));
    /*  NO PERSON, APPLICATION OR LEASE FACT ANYWHERE IN THE RESPONSE.
     *  Asserted over the WHOLE serialized body rather than key by key:
     *  a key-by-key check only refutes the leak it thought of.  */
    const body = JSON.stringify(r.json);
    ok("L11c …and no person, application or lease fact appears anywhere in the response",
       !/Marisol|Trejo|Whitfield|submitted|packet|executed|prospect|application_status/i.test(body),
       body.slice(0, 200));
    ok("L11d …and the same refusal is byte-identical on a second ask (deterministic)",
       (await askLeasing(Q, amOnlyToken)).json.answer === r.json.answer);
    ok("L11e …and that second ask reached neither reader nor model",
       readerCalls.subject === 0 && readerCalls.standing === 0
       && modelCalls.length === beforeModel,
       `${JSON.stringify(readerCalls)} model+${modelCalls.length - beforeModel}`);
  }

  /*  ── THE SAME REFUSAL, DIRECTLY ─────────────────────────────────────
   *  QB requires both HTTP and direct evidence. answer() is called with
   *  no database and no Anthropic client AT ALL: if the refusal were not
   *  returned before gatherFacts, this would throw rather than pass, so
   *  the ordering is proven by construction and not by a counter.       */
  {
    const explode = { query: () => { throw new Error("the database must not be touched"); } };
    const noModel = { messages: { create: async () => { throw new Error("Anthropic must not be reached"); } } };
    const direct = await askSpineAnswer.answer(explode, noModel, {
      property_id: prop, allowed_modules: ["asset_management"],
      operator_user_id: "unused", question: Q,
    });
    ok("L11f the refusal is returned BEFORE any database or model work exists to do",
       direct.outcome === "not_authorized" && direct.grounded_on === null
       && Array.isArray(direct.references) && direct.references.length === 0,
       JSON.stringify(direct));
    /*  THE WALL IS ENTITLEMENT, NOT A LEASING-ONLY DOOR. Management
     *  resolves the operation and must reach this read; asset management
     *  must not. Both are checked against the SAME exploding deps, so
     *  the two outcomes differ only by module:
     *      refused      → `not_authorized`, nothing was attempted
     *      not refused  → `unavailable`, because the work was attempted
     *                     and the deliberately broken model threw
     *  A single-module assertion would pass just as well if the wall
     *  refused everyone.  */
    const byModule = {};
    for (const m of [["management"], ["leasing"], ["asset_management"], []]) {
      byModule[m.join(",") || "(none)"] = (await askSpineAnswer.answer(explode, noModel, {
        property_id: prop, allowed_modules: m, operator_user_id: "u", question: Q,
      })).outcome;
    }
    ok("L11g leasing AND management both pass the wall; asset_management and none are refused",
       byModule.management === "unavailable" && byModule.leasing === "unavailable"
       && byModule.asset_management === "not_authorized" && byModule["(none)"] === "not_authorized",
       JSON.stringify(byModule));
  }

  console.log("\n  ── the entitled question, against the real canonical read ──");
  let answered = null;
  {
    const before = modelCalls.length;
    answered = await askLeasing(Q, leasingToken);
    /*  THE COUNTER IS NOT VACUOUS. L3, L6 and L7 assert that a number
     *  STAYED at zero, and a number that can never leave zero proves
     *  nothing at all. This is the same number, moved by the entitled
     *  request through the same real router — so those three assertions
     *  are measurements rather than tautologies.  */
    ok("L7b the reader counter CAN move — so L3/L6/L7 are measurements, not tautologies",
       readerCalls.subject >= 1 && readerCalls.standing >= 1, JSON.stringify(readerCalls));
    ok("L12 200 and `answered`",
       answered.status === 200 && answered.json.outcome === "answered",
       JSON.stringify(answered.json).slice(0, 240));
    ok("L13 the model was called exactly once for it", modelCalls.length - before === 1,
       String(modelCalls.length - before));
  }

  const sent = modelCalls.length ? String(modelCalls[modelCalls.length - 1].messages[0].content) : "";
  const facts = sent ? JSON.parse(sent.slice(sent.indexOf("{"), sent.lastIndexOf("}") + 1)) : null;

  ok("L14 the subject reached the model as leasing_person",
     /QUESTION SUBJECT: leasing_person/.test(sent), sent.slice(0, 80));
  ok("L15 the read succeeded and says so",
     !!facts && facts.leasing_person && facts.leasing_person.read_state === "OK",
     JSON.stringify(facts && facts.leasing_person && facts.leasing_person.read_state));
  ok("L16 …addressed at the person the DATABASE resolved, not one the model picked",
     !!facts && facts.leasing_person.subject_name === "Marisol Trejo",
     JSON.stringify(facts && facts.leasing_person && facts.leasing_person.subject_name));
  /*  ⚠ THIS ASSERTION USED TO READ `facts.property_id` OUT OF THE MODEL
   *  PAYLOAD. That was only possible because the property UUID was being
   *  sent to the model, which is exactly what the firewall now stops.
   *  Scope is a SERVER fact and is proven where the server states it:
   *  the response the router echoes from the session, and the canonical
   *  read the payload is compared against below (L18–L20) — which was
   *  taken at this property and would not match if the read had been
   *  scoped anywhere else.  */
  ok("L17 …read at the property the SESSION named — proven server-side, not by a uuid in the payload",
     String(answered.json.property_id) === String(prop)
     && !String(sent).includes(String(prop)),
     `echoed=${answered.json.property_id} inPayload=${String(sent).includes(String(prop))}`);

  /*  THE FACTS ON THE WIRE *ARE* THE CANONICAL READ. Not "resemble".
   *  The canonical read is called directly, at the date the wire itself
   *  reported, and the two are compared after the same id-stripping the
   *  composer applies. Comparing against a hand-built expectation would
   *  only prove the harness agrees with itself.  */
  {
    const canonical = await leasingRead.readLeasingStanding(pool, {
      person_id: marisol, property_id: prop,
      as_of: facts && facts.leasing_person && facts.leasing_person.as_of,
    });
    const stripped = JSON.parse(JSON.stringify(canonical, (k, v) => (UUID.test(String(v)) ? undefined : v)));
    const wire = facts && facts.leasing_person ? facts.leasing_person : {};
    ok("L18 the position on the wire IS the canonical read's",
       JSON.stringify(wire.current_position) === JSON.stringify(stripped.current_position),
       `wire ${JSON.stringify(wire.current_position)}\n          read ${JSON.stringify(stripped.current_position)}`);
    ok("L19 …and its uncertainty, so a fluent sentence cannot be built over the gaps",
       JSON.stringify(wire.uncertainty) === JSON.stringify(stripped.uncertainty),
       `wire ${JSON.stringify(wire.uncertainty)}\n          read ${JSON.stringify(stripped.uncertainty)}`);
    ok("L20 …and `settled` is carried, so an empty uncertainty list cannot read as 'we did not look'",
       typeof wire.settled === "boolean" && wire.settled === stripped.settled,
       JSON.stringify(wire.settled));
  }

  /*  §40.8 · a model holding a record id can compose a link Spine did not
   *  resolve. Leasing standing is the densest uuid payload in the system
   *  (packet_id, obligation_id, executed record_id, space_id), so this is
   *  where withoutDatabaseIds is actually load-bearing.  */
  ok("L21 NO record id crosses into model context",
     !UUID.test(sent.replace(/QUESTION SUBJECT: \w+/, "").split(String(prop)).join("")),
     (sent.match(UUID) || []).slice(0, 1).join(""));

  console.log("\n  ── §40.7 · the four leasing silences stay apart over the wire ──");
  {
    const before = modelCalls.length;
    /*  ⚠ THE FIRST VERSION OF THIS ASKED "has Dana signed anything" and
     *  got NO_SUBJECT, not ambiguity. resolveLeasingSubject compares the
     *  WHOLE recorded name against the sentence, so a first name alone
     *  addresses nobody. That is pinned separately at L24b below; here
     *  the full name is used, because the thing under test is whether
     *  genuine ambiguity is kept apart from absence.  */
    await askLeasing("has Dana Whitfield signed anything", leasingToken);
    const s = String(modelCalls[modelCalls.length - 1].messages[0].content);
    const f = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    ok("L22 two people named Dana is AMBIGUOUS_SUBJECT, never a confident answer about one",
       f.leasing_person && f.leasing_person.read_state === "AMBIGUOUS_SUBJECT",
       JSON.stringify(f.leasing_person));
    ok("L23 …and the candidates reach the model as NAMES, never as database ids",
       f.leasing_person && Array.isArray(f.leasing_person.candidates)
       && f.leasing_person.candidates.length === 2
       && f.leasing_person.candidates.every((c) => typeof c === "string" && !UUID.test(c)),
       JSON.stringify(f.leasing_person && f.leasing_person.candidates));
    ok("L24 …and that is a DIFFERENT silence from 'nobody by that name'",
       f.leasing_person.read_state !== "NO_SUBJECT", "collapsed");
    void before;
  }
  {
    /*  D3 · ADDRESSING IS FULL-NAME-ONLY. "has Dana signed" — the way a
     *  person actually speaks about a colleague's applicant — resolves
     *  NOBODY, and is reported as the same silence as a question naming
     *  no human at all. It is not a wrong answer and it is not unsafe;
     *  it is the natural sentence failing to arrive. Pinned so that a
     *  future first-name or fuzzy match goes red here and is seen.  */
    await askLeasing("has Dana signed anything", leasingToken);
    const s = String(modelCalls[modelCalls.length - 1].messages[0].content);
    const f = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    ok("L24b D3 · a FIRST NAME alone addresses nobody (CURRENT BEHAVIOUR, pinned)",
       f.leasing_person && f.leasing_person.read_state === "NO_SUBJECT",
       JSON.stringify(f.leasing_person));
    if (f.leasing_person && f.leasing_person.read_state === "NO_SUBJECT") {
      divergence(
        "D3 · addressing matches the WHOLE recorded name. \"has Dana signed\" "
        + "resolves nobody even with two Dana Whitfields at the property, and "
        + "reports the same NO_SUBJECT silence as a question naming no human at "
        + "all. Safe — it never answers about the wrong person — but the "
        + "first-name sentence people actually say does not reach the read, and "
        + "the operator is not told a partial name was the reason.");
    }
  }
  {
    await askLeasing("has anyone signed a packet yet", leasingToken);
    const s = String(modelCalls[modelCalls.length - 1].messages[0].content);
    const f = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    ok("L25 a question naming nobody is NO_SUBJECT, not an empty standing read",
       f.leasing_person && f.leasing_person.read_state === "NO_SUBJECT",
       JSON.stringify(f.leasing_person));
  }
  {
    //  ADDRESSING IS SCOPED TO THE SERVER-DERIVED PROPERTY. Jordan Pike
    //  exists, and is a real leasing lead — at the OTHER property. He
    //  must be unreachable from this session's question.
    await askLeasing("has Jordan Pike signed", leasingToken);
    const s = String(modelCalls[modelCalls.length - 1].messages[0].content);
    const f = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    ok("L26 a person who exists only at ANOTHER property is NO_SUBJECT here",
       f.leasing_person && f.leasing_person.read_state === "NO_SUBJECT",
       JSON.stringify(f.leasing_person));
    ok("L27 …and their name never crossed into model context",
       !/Jordan|Pike/.test(JSON.stringify(f)), "the other property's person leaked");
  }

  console.log("\n  ── the response KEYS are a contract (a rename broke one before) ──");
  {
    const g = (answered.json && answered.json.grounded_on) || {};
    ok("L28 grounded_on is present on an answered leasing question",
       g && typeof g === "object", JSON.stringify(g));
    ok("L29 reads_that_failed is an empty ARRAY, stated rather than omitted",
       Array.isArray(g.reads_that_failed) && g.reads_that_failed.length === 0,
       JSON.stringify(g.reads_that_failed));
    ok("L30 gathered_at is present, so the answer carries when it was assembled",
       typeof g.gathered_at === "string" && !isNaN(Date.parse(g.gathered_at)),
       String(g.gathered_at));
    ok("L31 the property_id echoed to the client is the SESSION's",
       String(answered.json.property_id) === String(prop));

    /*  ── PHASE 2 · LEASING IS NOW CHECKABLE ────────────────────────
     *  This block previously PINNED the absence of any leasing key. That
     *  was true of the product as it stood and is now the defect, so the
     *  assertions are positive: the grounding exists, it is exactly the
     *  canonical read's, and it carries nothing it should not.
     *
     *  Every expected value is taken from the CANONICAL READ at the same
     *  as_of, never from a literal. A hand-written expectation would
     *  only prove the harness agrees with itself, and would keep passing
     *  if grounding silently stopped tracking the read.  */
    const canon = await realStanding(pool, {
      person_id: marisol, property_id: prop,
      as_of: facts && facts.leasing_person ? facts.leasing_person.as_of : null,
    });
    const expected = {
      leasing_read_state: "OK",
      leasing_subject_name: "Marisol Trejo",
      leasing_relationship_stage: canon.current_position ? canon.current_position.stage : null,
      leasing_application_status: canon.application ? canon.application.status : null,
      leasing_packet_status: canon.lease ? canon.lease.packet_status : null,
      leasing_resident_executed_at: canon.lease ? (canon.lease.resident_executed_at || null) : null,
      leasing_company_executed_at: canon.lease ? (canon.lease.company_executed_at || null) : null,
      leasing_next_action_code: canon.next && canon.next.action ? canon.next.action.code : null,
      leasing_uncertainty_count: Array.isArray(canon.uncertainty) ? canon.uncertainty.length : null,
    };
    for (const key of Object.keys(expected)) {
      ok(`L32 ${key} is present and equals the canonical read`,
         key in g && JSON.stringify(g[key]) === JSON.stringify(expected[key]),
         `grounded_on=${JSON.stringify(g[key])} canonical=${JSON.stringify(expected[key])}`);
    }
    /*  THE TWO SIGNATURES ARE SEPARATE FACTS (§40.5). `resident signed`
     *  and `company countersigned` are different acts on different
     *  clocks; a surface that collapses them reports an executed lease
     *  when one party has signed. Grounding must carry both slots even
     *  when both are empty — and empty must be null, never false and
     *  never a date-shaped zero.  */
    ok("L33 the two execution facts are separate slots, and unsigned is null (never false, never a zero date)",
       "leasing_resident_executed_at" in g && "leasing_company_executed_at" in g
       && (g.leasing_resident_executed_at === null || typeof g.leasing_resident_executed_at === "string")
       && (g.leasing_company_executed_at === null || typeof g.leasing_company_executed_at === "string"),
       JSON.stringify([g.leasing_resident_executed_at, g.leasing_company_executed_at]));
    /*  PROSE INPUTS AND GROUNDING MUST AGREE. The model was handed
     *  facts.leasing_person; the operator is shown grounded_on. If those
     *  two ever disagree the surface contradicts its own citation, which
     *  is worse than having no citation at all.  */
    const lp = facts.leasing_person;
    ok("L34 grounding agrees with the facts the model was actually given",
       g.leasing_read_state === lp.read_state
       && g.leasing_subject_name === lp.subject_name
       && g.leasing_application_status === (lp.application ? lp.application.status : null)
       && g.leasing_packet_status === (lp.lease ? lp.lease.packet_status : null)
       && g.leasing_uncertainty_count === (Array.isArray(lp.uncertainty) ? lp.uncertainty.length : null),
       JSON.stringify({ g, lp_read: lp.read_state, lp_app: lp.application }));
    /*  §40.8 · NOTHING IDENTIFYING, AND NOTHING THE MODEL CHOSE.
     *  grounded_on is rendered on a surface, so an id here is as bad as
     *  an id in model context. Hashes are excluded too: they identify a
     *  document without naming it, which is an internal reference
     *  wearing a value's clothes.  */
    const gs = JSON.stringify(g);
    ok("L35 no database id reaches grounded_on", !UUID.test(gs), (gs.match(UUID) || [])[0]);
    ok("L36 no hash or token reaches grounded_on",
       !/[0-9a-f]{32,}/i.test(gs) && !/sha256|token|digest/i.test(gs),
       (gs.match(/[0-9a-f]{32,}/i) || [])[0] || "a hash-shaped key is present");
    ok("L37 grounded_on is server-built — the model's own words appear nowhere in it",
       !gs.includes("Marisol Trejo has an application submitted"), gs.slice(0, 160));
  }

  /*  ── PHASE 2 · THE SILENCES REACH GROUNDING AS THEMSELVES (§40.7) ──
   *  Four different empty answers, and grounding must keep them four.
   *  If NO_SUBJECT, AMBIGUOUS_SUBJECT, READ_FAILED and READ_TIMED_OUT
   *  all arrive on the surface as the same blank, the operator cannot
   *  tell "nobody by that name" from "Spine could not look" — and one of
   *  those is a fact about the property while the other is a fact about
   *  Spine. Driven through the real HTTP door for the two the door can
   *  reach, and through the composer directly for the two that need a
   *  reader that fails, since a real socket cannot make a read time out
   *  on demand.  */
  console.log("\n  ── §40.7 · the four silences survive INTO grounded_on ──");
  {
    const seen = {};
    for (const [label, question] of [["NO_SUBJECT", "has anyone signed a packet yet"],
                                     ["AMBIGUOUS_SUBJECT", "has Dana Whitfield signed anything"]]) {
      const rr = await askLeasing(question, leasingToken);
      seen[label] = rr.json.grounded_on ? rr.json.grounded_on.leasing_read_state : "(no grounded_on)";
      ok(`L38 ${label} reaches grounded_on as itself`,
         seen[label] === label, JSON.stringify(seen[label]));
      ok(`L38 ${label} carries no subject name and no stage`,
         rr.json.grounded_on
         && rr.json.grounded_on.leasing_subject_name === null
         && rr.json.grounded_on.leasing_relationship_stage === null,
         JSON.stringify(rr.json.grounded_on));
    }
    //  READ_FAILED and READ_TIMED_OUT need a reader that fails, which a
    //  real socket cannot arrange. The composer is called directly with
    //  an injected failing reader — the same seam gatherFacts exposes.
    for (const [label, err] of [["READ_FAILED", Object.assign(new Error("boom"), {})],
                                ["READ_TIMED_OUT", Object.assign(new Error("slow"), { code: "READ_TIMED_OUT" })]]) {
      const failing = {
        resolveLeasingSubject: async () => { throw err; },
        readLeasingStanding: async () => { throw err; },
      };
      const f = await askSpineAnswer.gatherFacts(pool, {
        property_id: prop, allowed_modules: ["leasing"], subject: "leasing_person",
        question: Q, leasingReader: failing,
      });
      seen[label] = f.leasing_person.read_state;
      ok(`L39 ${label} is its own silence, not collapsed into absence`,
         f.leasing_person.read_state === label, JSON.stringify(f.leasing_person));
    }
    ok("L40 all four silences are DISTINCT values, not one blank wearing four names",
       new Set(Object.values(seen)).size === 4, JSON.stringify(seen));
  }

  /*  ══ MODEL-CONTEXT IDENTIFIER FIREWALL (§40.8) ═════════════════════
   *  The model narrates governed facts. It must never receive an
   *  internal identity it could repeat, correlate between answers, or
   *  offer as a reference Spine never resolved.
   *
   *  A payload census through this same door found TWO leaks that the
   *  id rules could not see, because a hash is an identity wearing a
   *  value's clothes rather than an `id`:
   *      leasing_person.lease.instrument_package_sha256
   *      leasing_person.lease.executed_lease.document_sha256
   *  Both are now stripped by the ONE recursive sanitizer.
   *
   *  Asserted BY KEY SHAPE AND BY VALUE, at every nesting depth. Key
   *  shape alone misses a hash under an innocent name; the exact seeded
   *  values alone miss a key whose value happens to differ. Both, or
   *  neither is worth much.  */
  console.log("\n  ── §40.8 · no internal identifier reaches model context ──");
  {
    //  Walk to leaves so nesting depth cannot hide anything. A sanitizer
    //  that only cleaned the top level would pass a shallow check.
    const leaves = [];
    (function walk(v, path) {
      if (Array.isArray(v)) return v.forEach((c, i) => walk(c, `${path}[${i}]`));
      if (v && typeof v === "object") {
        for (const [k, c] of Object.entries(v)) walk(c, path ? `${path}.${k}` : k);
        return;
      }
      leaves.push({ path, key: path.split(".").pop().replace(/\[\d+\]$/, ""), value: v });
    })(facts, "");

    const offenders = (test) => leaves.filter((l) => test(l.key)).map((l) => l.path);

    ok("F1  no key `id` anywhere in model context",
       offenders((k) => k === "id").length === 0, JSON.stringify(offenders((k) => k === "id")));
    /*  ⚠ THIS ASSERTION USED TO ALLOW ONE EXCEPTION — the top-level
     *  `property_id` — on the reasoning that a server-derived scope is
     *  not really a record identifier. That exception is withdrawn. A
     *  server-derived scope is still a database UUID; the server needs
     *  it to scope its readers, the model needs the story. The earlier
     *  argument leaned on an existing tenancy proof asserting the same
     *  thing, and an existing test documents behaviour rather than
     *  making it canonical.
     *
     *  NO key ending `_id` now, with no exception at all.  */
    const idKeys = offenders((k) => /_id$/.test(k));
    ok("F2  NO key ending `_id` reaches model context — including property_id",
       idKeys.length === 0, JSON.stringify(idKeys));
    ok("F2b …and the session's own property UUID appears nowhere in the payload",
       !sent.includes(String(prop)), "the property uuid is in model context");
    ok("F2c …while the server still scopes and echoes it normally",
       String(answered.json.property_id) === String(prop),
       String(answered.json.property_id));
    ok("F3  no unmasked key ending `_identifier`",
       offenders((k) => /_identifier$/.test(k) && !/_masked$/.test(k)).length === 0,
       JSON.stringify(offenders((k) => /_identifier$/.test(k) && !/_masked$/.test(k))));
    ok("F4  no key ending `_sha256` — the leak this firewall closed",
       offenders((k) => /_sha256$/.test(k)).length === 0,
       JSON.stringify(offenders((k) => /_sha256$/.test(k))));

    /*  BY VALUE, NOT ONLY BY KEY. The exact seeded hashes are searched
     *  for in the SERIALIZED payload — the literal bytes the model would
     *  receive — so a hash surviving under any key at any depth is
     *  caught even if its key shape was never anticipated.  */
    for (const [name, value] of Object.entries(HASH)) {
      ok(`F5  the seeded ${name} hash appears NOWHERE in the serialized model context`,
         !sent.includes(value), `${name} present`);
    }
    ok("F6  …and no 32+ char hex run survives at all, whatever its key",
       !/[0-9a-f]{32,}/i.test(sent.split(String(prop)).join("")),
       (sent.match(/[0-9a-f]{32,}/i) || [])[0]);
    ok("F7  no database uuid other than the session's property reaches the model",
       !UUID.test(sent.split(String(prop)).join("")),
       (sent.match(UUID) || [])[0]);
    ok("F8  __refs never reaches the model",
       !/__refs/.test(sent), "__refs is in the payload");

    /*  NESTED-ARRAY CONTROL. A sanitizer that recursed into objects but
     *  not through arrays would pass every assertion above, because the
     *  real leasing payload happens to carry its hashes on plain
     *  objects. This drives the same sanitizer with a hash buried two
     *  array levels down, so a shallow implementation cannot pass.  */
    /*  ⚠ THE FIRST VERSION OF F9 WAS VACUOUS AND PASSED ANYWAY. It
     *  reached for a `__test_sanitize` export that does not exist, found
     *  undefined, and its `nested === null ||` guard made the assertion
     *  true without sanitizing anything. A control that cannot fail
     *  controls nothing — the same defect this file's L7b already exists
     *  to prevent, made again.
     *
     *  Driven through the REAL path instead: an injected reader returns
     *  a hash buried two array levels down, gatherFacts passes it to the
     *  same one sanitizer, and the result is read back. No test-only
     *  export, and the thing under test is the shipping code path.  */
    const nestedFacts = await askSpineAnswer.gatherFacts(pool, {
      property_id: prop, allowed_modules: ["leasing"], subject: "leasing_person",
      question: Q,
      leasingReader: {
        resolveLeasingSubject: async () => ({ resolved: true, person: { id: marisol, name: "Marisol Trejo" } }),
        readLeasingStanding: async () => ({
          lots: [[{ deep_package_sha256: HASH.package, keep: "narrative",
                    inner: [{ another_body_sha256: HASH.body }] }]],
        }),
      },
    });
    const deep = nestedFacts.leasing_person.lots[0][0];
    ok("F9  CONTROL · hashes two and three array levels deep are stripped, neighbour survives",
       deep.deep_package_sha256 === undefined
       && deep.keep === "narrative"
       && deep.inner[0].another_body_sha256 === undefined
       && !JSON.stringify(nestedFacts).includes(HASH.package)
       && !JSON.stringify(nestedFacts).includes(HASH.body),
       JSON.stringify(nestedFacts.leasing_person.lots));

    /*  THE FIREWALL MUST NOT HAVE EATEN THE ANSWER. A sanitizer that
     *  removed everything would pass every assertion above and leave the
     *  model with nothing to say — so the narrative facts are asserted
     *  present, by value, in the same payload.  */
    const lp = facts.leasing_person;
    ok("F10 the narrative facts still reach the model after sanitizing",
       lp.subject_name === "Marisol Trejo"
       && lp.lease && lp.lease.packet_status === "sent"
       && lp.lease.instrument_form_code === "PA-RES-2026"
       && typeof lp.lease.resident_executed_at === "string"
       && lp.lease.company_executed_at === null
       && lp.application.status === "submitted"
       && lp.current_position && typeof lp.current_position.stage === "string"
       && lp.lease.executed_lease.admission_status === "blocked"
       && Array.isArray(lp.uncertainty),
       JSON.stringify(lp).slice(0, 300));
    ok("F11 …and the answer still succeeds through the structured-output contract",
       answered.status === 200 && answered.json.outcome === "answered",
       JSON.stringify(answered.json && answered.json.outcome));
    /*  The form CODE is narrative and must survive; only the HASH goes.
     *  Stripping both would be a sanitizer that cannot tell an identity
     *  from a description.  */
    ok("F12 the instrument FORM CODE survives while its hash does not",
       lp.lease.instrument_form_code === "PA-RES-2026"
       && lp.lease.instrument_package_sha256 === undefined,
       JSON.stringify({ code: lp.lease.instrument_form_code, hash: lp.lease.instrument_package_sha256 }));

    /*  SERVER-SIDE SURFACES ARE UNAFFECTED. The firewall is about model
     *  context; references and grounding are built server-side after the
     *  model answers and must keep working — while themselves carrying
     *  no prohibited identifier.  */
    const gjson = JSON.stringify(answered.json.grounded_on || {});
    ok("F13 grounded_on remains server-built and carries no id, hash or uuid",
       !UUID.test(gjson) && !/[0-9a-f]{32,}/i.test(gjson)
       && !/"[a-z_]*_sha256"/.test(gjson) && answered.json.grounded_on.leasing_read_state === "OK",
       gjson.slice(0, 200));
    ok("F14 the HTTP response still carries its references array",
       Array.isArray(answered.json.references), JSON.stringify(answered.json.references));
  }

  /*  ══ PHASE B · REPRESENTATIVE-DOMAIN MODEL-PAYLOAD CENSUS ══════════
   *  The firewall is only worth what it covers. leasing_person is
   *  proven above through the real socket; this drives EVERY OTHER
   *  model-called subject to the same serialization boundary and reads
   *  the captured Anthropic request back.
   *
   *  ── THE RUNG, STATED HONESTLY ──────────────────────────────────
   *  These rows are NOT over a socket. The HTTP router takes only
   *  { pool, anthropic } and forwards no readers, so a domain whose
   *  facts must be injected cannot be driven through it — and building
   *  a second door to pretend otherwise would be faking a rung. They
   *  call the real `answer()`, which is where serialization actually
   *  happens: same sanitizer, same replacer, same bytes. What they do
   *  not prove is the socket, the session and the router gate, and
   *  leasing_person (L1–F14) proves those.
   *
   *  Note `answer()` forwards every reader EXCEPT leasingReader, which
   *  is why leasing cannot be injected here and had to be seeded for
   *  real — the harder path, and the better one.
   *
   *  Each injected reader returns facts LACED with identifier-shaped
   *  values at several depths, including inside nested arrays, plus
   *  narrative that must survive. Both are asserted: a firewall that
   *  ate the narrative would pass a leak test and fail the product.  */
  console.log("\n  ── PHASE B · every model-called subject, at the serialization boundary ──");
  {
    const SEEDED = {
      uuid:   "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      sha:    "5ha2" + "f".repeat(60),
      token:  "tok_" + "9".repeat(40),
      secret: "sk-live-" + "z".repeat(32),
    };
    //  Identifier-shaped at the top, one array level down, and two —
    //  and narrative beside each, so stripping is proven selective.
    const laced = (extra) => ({
      id: SEEDED.uuid, some_id: SEEDED.uuid, vendor_identifier: SEEDED.uuid,
      document_sha256: SEEDED.sha, api_token: SEEDED.token, client_secret: SEEDED.secret,
      rows: [[{ nested_id: SEEDED.uuid, deep_sha256: SEEDED.sha, label: "narrative-deep" }]],
      name: "Marisol Trejo", status: "submitted", as_of: "2026-08-25",
      amount: 1450, label: "narrative-top", form_code: "PA-RES-2026", read_state: "OK",
      ...(extra || {}),
    });

    const CASES = [
      { subject: "tenancy", q: "how many beds are occupied", mods: ["leasing"], injected: true,
        dep: { tenancyReader: { readTenancyStanding: async () => laced({
          standing: { truth_state: "ESTABLISHED" },
          position: { rentable_positions: 160, occupied: 128, open: 32 },
          unknowns: { occupied_positions_with_no_recorded_rent: 0 },
          truth_walls: ["occupied ≠ paying"] }) } } },
      { subject: "tour_schedule", q: "tour availability this week", mods: ["leasing"], injected: true,
        dep: { tourScheduleReader: async () => laced({
          next_open_times: [{ start: "2026-08-26T15:00:00Z", host_user_id: SEEDED.uuid, host_name: "Mike" }],
          coverage_attention: [] }) } },
      { subject: "economics", q: "what are our asking rents", mods: ["asset_management"], projects: true,
        dep: { economicReader: { effectiveEconomicPicture: async () => laced({
          base_rent: { types: [{ unit_type: "1BR", rent: 1450, unit_type_id: SEEDED.uuid }],
                       completeness: { overall: "complete" } },
          one_time_fees: { completeness: { overall: "complete" }, unresolved_reason: null, published: [] },
          recurring_charges: { completeness: { overall: "complete" }, unresolved_reason: null, published: [] },
          completeness: { overall: "complete" },
          combined_monthly_total: { withheld: false, amount: 1450 } }) } } },
      { subject: "compliance", q: "what licenses expire soon", mods: ["asset_management"], projects: true,
        extra: { mintComplianceReference: () => ({ token: SEEDED.token }) },
        dep: { complianceReader: { readComplianceStanding: async () => laced({
          contract_version: "1", capability_classes: ["retrieval"],
          composition_authorization: "single_domain", coverage: { state: "partial" },
          items: [laced({ kind: "license", state: "expiring", due_on: "2026-09-30",
                          evidence: [], references: [] })],
          references: [] }) } } },
      { subject: "utility", q: "who is the electric provider", mods: ["asset_management"], injected: true,
        dep: { utilityReader: { readForQuestion: async () => ({
          read_state: "OK", attention_state: "QUIET", mode: "detail",
          detail: laced({ service: "electric" }),
          standing: laced({ setup_state: "established", established_services: ["electric"] }) }) } } },
      { subject: "contracted_service", q: "what contracted services do we have",
        mods: ["asset_management"], injected: true,
        dep: { contractedServiceReader: { readForQuestion: async () => ({
          read_state: "OK", attention_state: "QUIET", mode: "detail",
          detail: laced({ service: "landscaping" }),
          standing: laced({ setup_state: "established", engagement_count: 2 }) }) } } },
      //  Debt and equity are driven through their real NOT_ESTABLISHED
      //  path: an empty property is a real answer, and it is the one
      //  their services can produce here without inventing instruments.
      { subject: "debt", q: "what is our debt service", mods: ["asset_management"], injected: false,
        dep: { debtService: { listInstrumentsForProperty: async () => [] },
               debtRead: { NOT_ESTABLISHED: "NOT_ESTABLISHED" } } },
      { subject: "equity", q: "what is our preferred equity position", mods: ["asset_management"],
        injected: false,
        dep: { equityService: { loadHistory: async () => ({ positions: [] }) },
               equityRead: { NOT_ESTABLISHED: "NOT_ESTABLISHED" } } },
      //  `work` runs entirely on real rows at the seeded property.
      { subject: "work", q: "what work orders are open", mods: ["maintenance"], injected: false, dep: {} },
    ];

    const censusRows = [];
    for (const c of CASES) {
      const seen = [];
      const stub = { messages: { create: async (input) => {
        seen.push(input);
        return { content: [{ type: "text", text: JSON.stringify({ outcome: "answered", answer: "ok" }) }] };
      } } };
      const out = await askSpineAnswer.answer(pool, stub, {
        property_id: prop, allowed_modules: c.mods, operator_user_id: "census",
        question: c.q, ...(c.extra || {}), ...c.dep,
      });
      ok(`B0  ${c.subject} reaches the model at all (subject selected, entitlement passed)`,
         seen.length === 1, `calls=${seen.length} outcome=${out.outcome}`);
      if (seen.length !== 1) { censusRows.push({ subject: c.subject, note: "NO MODEL CALL" }); continue; }

      const payload = String(seen[0].messages[0].content);
      ok(`B1  ${c.subject} · the server's chosen subject is what the model was told`,
         new RegExp(`QUESTION SUBJECT: ${c.subject}\\b`).test(payload), payload.slice(0, 60));

      const factsSent = JSON.parse(payload.slice(payload.indexOf("{"), payload.lastIndexOf("}") + 1));
      const leaves = [];
      (function walk(v, path) {
        if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
        if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
          return;
        }
        leaves.push({ path, key: path.split(".").pop().replace(/\[\d+\]$/, ""), value: v });
      })(factsSent, "");

      //  BY KEY SHAPE …
      const badKeys = leaves.filter((l) =>
        l.key === "id" || /_id$/.test(l.key)
        || (/_identifier$/.test(l.key) && !/_masked$/.test(l.key))
        || /_sha256$/.test(l.key) || /(^|_)(hash|token|secret)$/.test(l.key));
      ok(`B2  ${c.subject} · no id, identifier, hash, token or secret KEY reaches the model`,
         badKeys.length === 0, JSON.stringify(badKeys.map((b) => b.path)));

      //  … AND BY VALUE, which catches a leak under a key nobody predicted.
      const badValues = leaves.filter((l) =>
        UUID.test(String(l.value)) || /^[0-9a-f]{32,}$/i.test(String(l.value))
        || /^(tok_|sk-)/.test(String(l.value)));
      ok(`B3  ${c.subject} · no uuid, hex run, token or secret VALUE reaches the model`,
         badValues.length === 0, JSON.stringify(badValues.map((b) => `${b.path}=${b.value}`)));

      ok(`B4  ${c.subject} · the session's property UUID is absent from the payload`,
         !payload.includes(String(prop)), "property uuid present");
      ok(`B5  ${c.subject} · __refs never reaches the model`,
         !/__refs/.test(payload), "__refs present");

      //  NARRATIVE SURVIVAL — only meaningful where facts were injected;
      //  the projecting domains select their own fields by design.
      /*  ── TWO SHAPES OF DOMAIN, AND THE DIFFERENCE MATTERS ────────
       *  Measured, not assumed. Some branches SPREAD the reader's object
       *  into the envelope (`...governed.standing`), so whatever a
       *  reader returns travels and the sanitizer is the only thing
       *  standing between it and the model. Others PROJECT — they name
       *  the fields they take — so they are allow-listed by
       *  construction and an injected extra never travels at all.
       *
       *  Both are asserted, in opposite directions, because each has its
       *  own failure: a spreading domain fails by carrying too much, a
       *  projecting domain fails by silently dropping a fact the
       *  operator needed. Anyone changing a branch from one shape to the
       *  other should have to come here and say so.  */
      if (c.injected) {
        ok(`B6  ${c.subject} · SPREADS · narrative survives at top level AND two array levels deep`,
           payload.includes("narrative-top") && payload.includes("narrative-deep"),
           payload.slice(0, 160));
      } else if (c.projects) {
        ok(`B6  ${c.subject} · PROJECTS · the composer names its own fields, so injected extras never travel`,
           !payload.includes("narrative-top") && !payload.includes("narrative-deep")
           && badKeys.length === 0 && badValues.length === 0,
           payload.slice(0, 200));
      }
      censusRows.push({ subject: c.subject, leaves: leaves.length, injected: c.injected });
    }

    /*  THE CENSUS COVERED WHAT IT CLAIMS. If a subject silently stopped
     *  being exercised, the table would shrink and nobody would notice —
     *  so the count is asserted, and leasing_person is named as proven
     *  on the stronger rung above rather than counted twice here.  */
    ok("B7  the census covered every model-called subject except leasing_person",
       censusRows.length === 9
       && ["tenancy", "tour_schedule", "economics", "compliance", "utility",
           "contracted_service", "debt", "equity", "work"]
            .every((n) => censusRows.some((r) => r.subject === n)),
       JSON.stringify(censusRows.map((r) => r.subject)));

    /*  ── THE FIREWALL DID NOT EAT THE SERVER'S OWN REFERENCE ─────────
     *  `__refs` carries a minted opener TOKEN, and the sanitizer now
     *  strips keys named `token`. The sanitized copy is what the model
     *  sees; `references` is returned from the ORIGINAL envelope, so the
     *  app still gets its opener. That distinction is the whole design
     *  and it is worth an assertion rather than an argument.  */
    {
      const seen = [];
      const stub = { messages: { create: async (input) => {
        seen.push(input);
        return { content: [{ type: "text", text: JSON.stringify({ outcome: "answered", answer: "ok" }) }] };
      } } };
      const out = await askSpineAnswer.answer(pool, stub, {
        property_id: prop, allowed_modules: ["asset_management"], operator_user_id: "census",
        question: "what licenses expire soon",
        mintComplianceReference: () => ({ token: "opener_" + SEEDED.token }),
        complianceReader: { readComplianceStanding: async () => ({
          contract_version: "1", capability_classes: ["retrieval"],
          composition_authorization: "single_domain", as_of: "2026-08-25",
          coverage: { state: "partial" }, items: [],
          references: [{ role: "canonical_record", label: "Rental Licence",
                         opener: { token: "opener_" + SEEDED.token } }] }) },
      });
      const payload = String(seen[0].messages[0].content);
      ok("B8  the minted opener token reaches the HTTP response…",
         Array.isArray(out.references) && out.references.length === 1
         && out.references[0].open.token === "opener_" + SEEDED.token,
         JSON.stringify(out.references));
      ok("B8b …and never reaches the model",
         !payload.includes("opener_" + SEEDED.token) && !payload.includes(SEEDED.token),
         "the opener token is in model context");
      ok("B8c …and the reference label is server-resolved, not parsed from prose",
         out.references[0].label === "Rental Licence", JSON.stringify(out.references[0]));
    }
  }

  leasingRead.resolveLeasingSubject = realResolve;
  leasingRead.readLeasingStanding = realStanding;
  server.close();
  await cleanup(pool);
  await pool.end();

  if (divergences.length) {
    console.log("\n  ── DIVERGENCES · pinned as current behaviour, not repaired ──");
    for (const d of divergences) console.log("  • " + d.replace(/\n\s*/g, "\n    "));
    console.log("\n  These are durable product-source questions outside this harness's");
    console.log("  ownership. Green here means CURRENT BEHAVIOUR IS PINNED — it does");
    console.log("  not mean the behaviour is right.");
  }
  console.log("");
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 128 }));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(receipt.died(__filename, e, ran));
});
