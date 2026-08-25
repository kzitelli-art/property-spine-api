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

   ── TWO DIVERGENCES THIS HARNESS PINS RATHER THAN REPAIRS ───────────
   Both are durable product-source questions outside this harness's
   ownership. They are asserted as CURRENT BEHAVIOUR so that a future
   change to either goes red here and is seen, rather than discovered by
   an operator. Each is printed in the DIVERGENCES report at the end.

   D1  leasing_person has NO top-level entitlement refusal. Every other
       subject with an entitlement (tenancy, tour_schedule, economics,
       debt, equity, compliance, utility, contracted_service) returns
       `not_authorized` from answer() BEFORE any fact is gathered and
       before the model is called. leasing_person instead falls through
       to gatherFacts, which marks the fact NOT_AUTHORIZED — and then the
       model IS called. No unentitled FACT reaches the model, so §40.8's
       letter holds; the SURFACE is nonetheless inconsistent with every
       sibling domain, and an unentitled operator spends a model call.
   D1b The same unentitled response comes back `answered`, not
       `not_authorized`, and the word NOT_AUTHORIZED appears exactly once
       in ask_spine_answer.js — at the line that writes it — so the
       refusal wording is the model's to invent.
   D3  Addressing matches the WHOLE recorded name, so "has Dana signed"
       resolves nobody and is reported as the same silence as a question
       naming no human at all.
   D2  `grounded_on` carries no leasing_person key at all. An answered
       leasing question returns a grounded_on object in which every key
       is null. The dashboard shows grounded_on so a claim is checkable;
       for leasing there is nothing to check it against.

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
    await pool.query(`delete from lease_applications where property_id=$1`, [id]);
    await pool.query(`delete from leasing_leads where property_id=$1`, [id]);
    await pool.query(`delete from leasing_conversions where property_id=$1`, [id]);
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`delete from persons where source=$1`, [PERSON_SOURCE]);
  await pool.query(`delete from users where email like $1`, [EMAIL_LIKE]);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

receipt.begin(__filename, { url: CONN, expected: 34 });

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
  await pool.query(
    `insert into lease_applications (property_id, person_id, status, applicant_name)
     values ($1,$2,'submitted','Marisol Trejo')`, [prop, marisol]);

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
  {
    const before = modelCalls.length;
    const r = await askLeasing(Q, amOnlyToken);
    //  THE ASSERTION THAT MATTERS: the READER never ran, so no leasing
    //  fact about a real human was ever gathered for an unentitled
    //  session. This is measured at the reader, not read off the answer.
    ok("L7  an asset-management-only operator never causes the leasing reader to run",
       readerCalls.subject === 0 && readerCalls.standing === 0, JSON.stringify(readerCalls));
    /*  ⚠ THE FIRST VERSION OF L8 TESTED THE WRONG BOUNDARY. It asserted
     *  that the string "Marisol Trejo" never reached the model — and it
     *  failed, correctly. The QUESTION is in the prompt, and the question
     *  is the operator's own sentence. A name the caller typed is not a
     *  fact Spine disclosed. What §40.8 forbids is an unentitled FACT
     *  entering model context, so the assertion is made about the fact
     *  payload: the marker is there and the standing read is not.  */
    const unentitled = (() => {
      const s = String(modelCalls[modelCalls.length - 1].messages[0].content);
      return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    })();
    ok("L8  …the fact is a bare NOT_AUTHORIZED marker with no standing payload",
       unentitled.leasing_person
       && unentitled.leasing_person.read_state === "NOT_AUTHORIZED"
       && unentitled.leasing_person.subject_name === undefined
       && unentitled.leasing_person.current_position === undefined
       && unentitled.leasing_person.uncertainty === undefined,
       JSON.stringify(unentitled.leasing_person));
    ok("L8b …and the composite silence refuses to read as health (§40.7)",
       unentitled.composite_silence && unentitled.composite_silence.state === "BLIND"
       && (unentitled.composite_silence.unread || []).some(
            (u) => u.domain === "leasing_person" && u.read_state === "NOT_AUTHORIZED"),
       JSON.stringify(unentitled.composite_silence));
    ok("L9  …and no reference was minted",
       Array.isArray(r.json && r.json.references) && r.json.references.length === 0,
       JSON.stringify(r.json && r.json.references));

    /*  D1 · PINNED, NOT REPAIRED. Every sibling subject refuses at
     *  answer() before the model is reached; leasing_person does not.
     *  Whichever way this is later resolved, it changes here first.  */
    const modelWasCalled = modelCalls.length > before;
    ok("L10 D1 · leasing_person reaches the model even unentitled (CURRENT BEHAVIOUR, pinned)",
       modelWasCalled === true, `model calls: ${modelCalls.length - before}`);
    if (modelWasCalled) {
      divergence(
        "D1 · an UNENTITLED leasing question still costs a model call. Every other "
        + "entitled subject (tenancy, tour_schedule, economics, debt, equity, compliance, "
        + "utility, contracted_service) returns not_authorized from answer() before "
        + "gatherFacts. leasing_person has no such top-level refusal — it is marked "
        + "NOT_AUTHORIZED as a FACT and composed over. §40.8's letter holds (no "
        + "unentitled fact reaches the model, asserted at L7/L8); the surface is "
        + "inconsistent with every sibling domain.");
    }
    /*  D1's SHARP EDGE, and it is sharper than the note above alone.
     *  An unentitled operator does not merely spend a model call — the
     *  response comes back `answered`, not `not_authorized`. Every
     *  sibling subject returns the literal outcome `not_authorized` with
     *  a fixed sentence Spine wrote. Leasing returns whatever the model
     *  composed over a marker word the system prompt never defines:
     *  "NOT_AUTHORIZED" appears exactly ONCE in ask_spine_answer.js, at
     *  the line that writes it. The generic composite-silence block does
     *  carry it to the model as an unread domain — so this is not a
     *  silent leak — but the refusal SENTENCE is left to the model's
     *  discretion, where READ_FAILED, NOT_ESTABLISHED and NOT_CONFIGURED
     *  each get explicit named instructions.  */
    ok("L11 D1 · an unentitled leasing question comes back `answered`, not "
       + "`not_authorized` (CURRENT BEHAVIOUR, pinned)",
       r.status === 200 && r.json.outcome === "answered",
       `${r.status} ${JSON.stringify(r.json && r.json.outcome)}`);
    if (r.json && r.json.outcome === "answered") {
      divergence(
        "D1b · the unentitled leasing response carries outcome `answered`. Every "
        + "sibling subject returns the literal outcome `not_authorized` with a "
        + "sentence Spine wrote. The word NOT_AUTHORIZED occurs exactly once in "
        + "ask_spine_answer.js — at the line that writes it — so the system prompt "
        + "never defines it, and the refusal wording is the model's to invent. The "
        + "model is told the domain went unread by the generic composite-silence "
        + "block, so nothing leaks; what it is not given is Spine's own refusal.");
    }
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
  ok("L17 …read at the property the SESSION named",
     !!facts && String(facts.property_id) === String(prop));

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

    /*  D2 · PINNED, NOT REPAIRED. */
    const leasingKeys = Object.keys(g).filter((k) => /^leasing/.test(k));
    ok("L32 D2 · grounded_on carries NO leasing_person key (CURRENT BEHAVIOUR, pinned)",
       leasingKeys.length === 0, JSON.stringify(leasingKeys));
    if (leasingKeys.length === 0) {
      divergence(
        "D2 · an ANSWERED leasing question returns a grounded_on object with no "
        + "leasing key — every key in it is null. grounded_on exists so an operator "
        + "can check a claim; tenancy gets six keys, contracted_service four, debt "
        + "three (counted in the grounded_on literal itself, not from memory). "
        + "Leasing gets none, so the one domain that answers about a NAMED "
        + "HUMAN is the one whose answer is unverifiable on the surface.");
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
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 34 }));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(receipt.died(__filename, e, ran));
});
