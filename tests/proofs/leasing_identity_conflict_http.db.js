#!/usr/bin/env node
"use strict";
/* ════════════════════════════════════════════════════════════════════
 *  leasing_identity_conflict_http.db.js
 *
 *  THE RUNG THE UNIT TESTS COULD NOT REACH.
 *
 *  tests/unit/property_line_identity.test.js drives resolveOrCreatePerson
 *  directly with a fake client. That proves the refusal fires and what the
 *  error carries — and it CANNOT prove any of the things that only exist
 *  once a real transaction rolls back against a real schema:
 *
 *    · that the inquiry survives the rollback that protects the person card
 *    · that the receipt the caller receives depends on the retention having
 *      COMMITTED, rather than on the code having intended to retain it
 *    · that a CHECK constraint, a unique index and a foreign key all accept
 *      the row the code actually writes
 *    · that a retry does not stack duplicates
 *    · that the operator door returns the inquiry, and refuses an
 *      unauthorized caller
 *
 *  Real Postgres, real Express, real HTTP over a real socket. Synthetic
 *  records only; nothing is sent anywhere.
 *
 *  Run:  HARNESS_DATABASE_URL="postgres://..." node tests/proofs/leasing_identity_conflict_http.db.js
 * ════════════════════════════════════════════════════════════════════ */

const http = require("node:http");
const crypto = require("node:crypto");
const express = require("express");
const { Pool } = require("pg");
const { harnessConnectionString } = require("../_run_receipt.js");

const url = harnessConnectionString();          // refuses without the guard
const pool = new Pool({ connectionString: url, ssl: false });

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); }
};

const uuid = () => crypto.randomUUID();
const sha256 = v => crypto.createHash("sha256").update(v).digest("hex");

//  One synthetic world, torn down at the end.
const ID = {
  property: uuid(), otherProperty: uuid(),
  personA: uuid(), personB: uuid(), personSolo: uuid(),
  user: uuid(), session: uuid(), otherUser: uuid(), otherSession: uuid(),
};
const SHARED_PHONE = "+12155550177";          // on BOTH personA and personB
const SOLO_PHONE   = "+12155550188";          // on exactly one person
const STAFF_TOKEN = "proof-staff-" + uuid();
const OTHER_TOKEN = "proof-other-" + uuid();
const INTAKE_SECRET = "proof-intake-" + uuid();

async function seed() {
  const q = (s, p) => pool.query(s, p);
  await q(`insert into properties (id, name) values ($1,'Proof Property A'), ($2,'Proof Property B')`,
    [ID.property, ID.otherProperty]);
  //  TWO people carrying the SAME canonical phone. This is the condition the
  //  refusal exists for; the owner's Neon read found zero such pairs in
  //  production, which is why it has to be constructed here.
  await q(`insert into persons (id, name, primary_phone_e164, phone) values
             ($1,'Ada Lovelace',$3,$3), ($2,'Grace Hopper',$3,$3)`,
    [ID.personA, ID.personB, SHARED_PHONE]);
  await q(`insert into persons (id, name, primary_phone_e164, phone) values ($1,'Solo Prospect',$2,$2)`,
    [ID.personSolo, SOLO_PHONE]);

  for (const [uid, sid, tok, prop, name] of [
    [ID.user, ID.session, STAFF_TOKEN, ID.property, "Proof Operator"],
    [ID.otherUser, ID.otherSession, OTHER_TOKEN, ID.otherProperty, "Other-Property Operator"],
  ]) {
    await q(`insert into users (id, name, role, is_active, status, account_kind)
             values ($1,$2,'leasing_manager',true,'active','human_staff')`, [uid, name]);
    await q(`insert into property_team_assignments (user_id, property_id, role_title, allowed_modules, active)
             values ($1,$2,'Leasing Manager', array['leasing'], true)`, [uid, prop]);
    //  Digest-at-rest, with issuance_purpose set: the schema's own CHECK
    //  refuses a digest row without one, which is the shape a real staff
    //  sign-in produces.
    await q(`insert into staff_sessions (id, user_id, property_id, token_digest, issuance_purpose, revoked, expires_at)
             values ($1,$2,$3,$4,'sms_otp',false, now() + interval '1 hour')`, [sid, uid, prop, sha256(tok)]);
  }
}

async function teardown() {
  const q = (s, p) => pool.query(s, p).catch(() => {});
  await q(`delete from obligations where property_id = any($1::uuid[])`, [[ID.property, ID.otherProperty]]);
  await q(`delete from comm_events where property_id = any($1::uuid[])`, [[ID.property, ID.otherProperty]]);
  await q(`delete from staff_sessions where id = any($1::uuid[])`, [[ID.session, ID.otherSession]]);
  await q(`delete from property_team_assignments where user_id = any($1::uuid[])`, [[ID.user, ID.otherUser]]);
  await q(`delete from lead_events where lead_id in (select id from leasing_leads where property_id=$1)`, [ID.property]);
  await q(`delete from leasing_leads where property_id = any($1::uuid[])`, [[ID.property, ID.otherProperty]]);
  await q(`delete from users where id = any($1::uuid[])`, [[ID.user, ID.otherUser]]);
  await q(`delete from persons where id = any($1::uuid[])`, [[ID.personA, ID.personB, ID.personSolo]]);
  await q(`delete from properties where id = any($1::uuid[])`, [[ID.property, ID.otherProperty]]);
  //  §6 adds a temporary CHECK to make the retention fail for real. If that
  //  section aborts between adding and dropping it, the constraint would
  //  poison every later run against this database.
  await q(`alter table comm_events drop constraint if exists tmp_proof_retention_fails`);
}

function buildApp(withPool) {
  const usePool = withPool || pool;
  const app = express();
  app.use(express.json());
  //  No model, no transport. A refusal must never reach a real prospect, and
  //  the control cases run capture-only (attempt_sms:false).
  const sms = { sendSms: async () => { throw new Error("proof: transport must not be reached"); } };
  //  STUBBED, AND WHAT THAT LEAVES UNPROVEN. Two collaborators are no-ops
  //  here: commBoundary.reclassify (the birth-guard record classification)
  //  and leasingLifecycle.maybeReopenOnQualifyingInbound. Both belong to
  //  other domains and both are reached only on the SUCCESS path, AFTER the
  //  identity refusal has already thrown — so nothing this proof asserts
  //  about the conflict path runs through them. What they do cost is
  //  coverage of §7's controls: those prove identity resolution and the HTTP
  //  contract, not that classification and lifecycle wrote correctly.
  const commBoundary = { reclassify: async () => {} };
  const leasingLifecycle = { maybeReopenOnQualifyingInbound: async () => {} };
  app.use("/", require("../../src/leasing/leasing_leads")({
    pool: usePool, anthropic: null, INGEST_MODEL: "proof", sms,
    leasingLifecycle, conversionServices: null, commBoundary,
  }));
  app.use("/", require("../../src/obligations/operator_obligations")({ pool: usePool }));
  return app;
}

async function main() {
  process.env.LEASING_INTAKE_SECRET = INTAKE_SECRET;
  process.env.LEASING_INTAKE_PROPERTY_IDS = `${ID.property},${ID.otherProperty}`;

  await teardown();            // a previous aborted run must not poison this one
  await seed();

  const server = http.createServer(buildApp());
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = (path, body, headers = {}) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
  const get = (path, headers = {}) => fetch(base + path, { headers })
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  const intake = (body, headers = {}) =>
    post("/leasing/intake", body, { "x-intake-secret": INTAKE_SECRET, ...headers });

  const MESSAGE = "Hi - is the 2BR still available for August? I can tour Saturday.";

  console.log("\nLEASING IDENTITY CONFLICT — REAL DB, REAL HTTP\n");

  // ══════════════════════════════════════════════════════════════════
  console.log("1 · an ambiguous inquiry is refused and attached to nobody");
  const first = await intake({
    property_id: ID.property, name: "New Prospect", phone: SHARED_PHONE,
    message: MESSAGE, source: "website-form", attempt_sms: false,
  }, { "Idempotency-Key": "proof-key-1" });

  ok("the endpoint answers 409", first.status === 409, first);
  ok("the receipt says it was saved", /has been saved/i.test(first.json?.receipt || ""), first.json);
  ok("the receipt names no phone number",
    !/\d{3}[^a-zA-Z]{0,3}\d{4}/.test(first.json?.receipt || ""), first.json?.receipt);
  ok("the receipt names no candidate",
    !/Ada|Grace|Lovelace|Hopper/.test(first.json?.receipt || ""), first.json?.receipt);

  const leadRows = (await pool.query(
    `select id from leasing_leads where property_id=$1 and person_id = any($2::uuid[])`,
    [ID.property, [ID.personA, ID.personB]])).rows;
  ok("NEITHER person got a lead — the inquiry attached to nobody", leadRows.length === 0, leadRows);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n2 · the inquiry itself survived the rollback");
  const retained = (await pool.query(
    `select id, body, person_id, needs_human, classification, channel, correlation_key, unresolved_inquiry
       from comm_events where property_id=$1 and unresolved_inquiry is not null`, [ID.property])).rows;
  ok("exactly one inquiry was retained", retained.length === 1, retained.length);
  const r0 = retained[0] || {};
  ok("the ORIGINAL MESSAGE survived", r0.body === MESSAGE, r0.body);
  ok("it is attached to no person", r0.person_id === null, r0.person_id);
  ok("it is flagged for a human", r0.needs_human === true, r0.needs_human);
  const ev = r0.unresolved_inquiry || {};
  ok("the SUBMITTED PHONE survived", ev.submitted?.phone === SHARED_PHONE, ev.submitted);
  ok("the SUBMITTED NAME survived", ev.submitted?.name === "New Prospect", ev.submitted);
  ok("the SOURCE survived", ev.source === "website-form", ev.source);
  ok("the RECEIVED TIME survived", typeof ev.received_at === "string" && !isNaN(Date.parse(ev.received_at)), ev.received_at);
  ok("which identity key conflicted is recorded", ev.conflict?.evidence === "canonical_phone", ev.conflict);
  ok("both candidates are recoverable", (ev.conflict?.candidate_person_ids || []).length === 2, ev.conflict);
  ok("candidate NAMES are not written into the retained evidence",
    !JSON.stringify(ev).match(/Ada|Grace|Lovelace|Hopper/), ev.conflict);

  const obs = (await pool.query(
    `select id, related_type, related_id, person_id, label, assigned_role
       from obligations where property_id=$1 and type='prospect_identity_conflict'`, [ID.property])).rows;
  ok("exactly one review task was opened", obs.length === 1, obs.length);
  const ob0 = obs[0] || {};
  ok("the task LINKS to the retained inquiry",
    ob0.related_type === "comm_event" && String(ob0.related_id) === String(r0.id), ob0);
  ok("the task is attached to no person", ob0.person_id === null, ob0.person_id);
  ok("the task LABEL discloses no contact details",
    !/\d{3}[^a-zA-Z]{0,3}\d{4}/.test(ob0.label || "") && !/Ada|Grace/.test(ob0.label || ""), ob0.label);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n3 · an authorized operator can retrieve the actual inquiry");
  const opView = await get(`/operator/obligations/${ob0.id}/retained-inquiry`,
    { "x-staff-session": STAFF_TOKEN });
  ok("the operator door answers 200", opView.status === 200, opView);
  const ri = opView.json?.retained_inquiry || {};
  ok("the operator gets the ORIGINAL MESSAGE, not just a notification",
    ri.message === MESSAGE, ri.message);
  ok("the operator gets the submitted contact", ri.submitted?.phone === SHARED_PHONE, ri.submitted);
  ok("the operator gets the source", ri.source === "website-form", ri.source);
  ok("the operator gets both candidate records to choose between",
    (ri.candidates || []).length === 2, ri.candidates);
  ok("the candidates carry the names the operator needs to decide",
    (ri.candidates || []).every(c => c.name && c.person_id), ri.candidates);
  ok("it is still attached to nobody", ri.attached_to_person === null, ri.attached_to_person);
  ok("the read does not pretend to resolve it", /does not attach/i.test(opView.json?.next_step || ""), opView.json?.next_step);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n4 · an unauthorized caller gets nothing");
  const noSession = await get(`/operator/obligations/${ob0.id}/retained-inquiry`);
  ok("no session → 401", noSession.status === 401, noSession);
  ok("no session → no message leaked", !JSON.stringify(noSession.json || {}).includes("2BR"), noSession.json);

  const badSession = await get(`/operator/obligations/${ob0.id}/retained-inquiry`,
    { "x-staff-session": "not-a-real-token" });
  ok("bogus session → 401", badSession.status === 401, badSession);

  const otherProp = await get(`/operator/obligations/${ob0.id}/retained-inquiry`,
    { "x-staff-session": OTHER_TOKEN });
  ok("an operator of ANOTHER property → 404, not 403", otherProp.status === 404, otherProp);
  const leaked = JSON.stringify(otherProp.json || {});
  ok("another property's operator sees no message, no contact, no candidate",
    !leaked.includes("2BR") && !leaked.includes(SHARED_PHONE)
    && !/Ada|Grace|Lovelace|Hopper/.test(leaked), otherProp.json);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n5 · a retry does not stack duplicates");
  const replay = await intake({
    property_id: ID.property, name: "New Prospect", phone: SHARED_PHONE,
    message: MESSAGE, source: "website-form", attempt_sms: false,
  }, { "Idempotency-Key": "proof-key-1" });
  ok("the retry is still refused", replay.status === 409, replay.status);
  ok("the retry still reports saved", /has been saved/i.test(replay.json?.receipt || ""), replay.json);
  const afterRetry = (await pool.query(
    `select count(*)::int n from comm_events where property_id=$1 and unresolved_inquiry is not null`,
    [ID.property])).rows[0].n;
  const obsAfter = (await pool.query(
    `select count(*)::int n from obligations where property_id=$1 and type='prospect_identity_conflict'`,
    [ID.property])).rows[0].n;
  ok("still exactly ONE retained inquiry", afterRetry === 1, afterRetry);
  ok("still exactly ONE review task", obsAfter === 1, obsAfter);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n6 · a failed retention cannot return a 'saved' receipt");
  //  Provoke a REAL failure on the retention write through the real path,
  //  rather than asserting the branch exists.
  //
  //  The first version of this tried to flip the needs_human DEFAULT — and
  //  proved nothing, because the insert passes needs_human explicitly, so
  //  the write simply succeeded and the "failure" case retained normally.
  //  It failed loudly here rather than passing for the wrong reason, which
  //  is the whole reason this case exists.
  //
  //  A temporary CHECK refusing exactly this body is a genuine database-level
  //  failure of the retention insert, which is what a constraint, a disk or a
  //  lost connection would look like to this code path.
  await pool.query(`alter table comm_events add constraint tmp_proof_retention_fails
                      check (body is null or body not like '%must not be claimed as saved%')`);
  const broken = await intake({
    property_id: ID.property, name: "Second Prospect", phone: SHARED_PHONE,
    message: "this one must not be claimed as saved", source: "website-form", attempt_sms: false,
  }, { "Idempotency-Key": "proof-key-2" });
  await pool.query(`alter table comm_events drop constraint tmp_proof_retention_fails`);

  ok("still refused with 409", broken.status === 409, broken.status);
  ok("the receipt does NOT claim it was saved",
    !/has been saved/i.test(broken.json?.receipt || ""), broken.json?.receipt);
  ok("the receipt says plainly that it was not saved",
    /not able to save|were not able/i.test(broken.json?.receipt || ""), broken.json?.receipt);
  ok("the receipt names a next step the caller can take",
    /send it again|call the leasing office/i.test(broken.json?.receipt || ""), broken.json?.receipt);
  const stillOne = (await pool.query(
    `select count(*)::int n from comm_events where property_id=$1 and unresolved_inquiry is not null`,
    [ID.property])).rows[0].n;
  ok("nothing partial was left behind by the failed retention", stillOne === 1, stillOne);
  const obsStill = (await pool.query(
    `select count(*)::int n from obligations where property_id=$1 and type='prospect_identity_conflict'`,
    [ID.property])).rows[0].n;
  ok("and no orphan review task was opened for it", obsStill === 1, obsStill);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n6b · the refusal survives its own recovery failing to connect");
  //  pool.connect() for the recovery used to sit OUTSIDE the try. A pool that
  //  is exhausted or a database that is unreachable — precisely when a
  //  retention fails — threw from there, replaced the identity-conflict error
  //  on its way out, and handed the caller a generic 500. The pessimistic
  //  receipt is worthless if the path that returns it can be skipped.
  //
  //  Injected at the seam the code actually uses: the FIRST connect is the
  //  intake transaction and must succeed; the SECOND is the recovery.
  {
    let connects = 0;
    const faultyPool = {
      query: (...a) => pool.query(...a),
      connect: async () => {
        connects += 1;
        if (connects === 2) throw new Error("proof: pool exhausted");
        return pool.connect();
      },
    };
    const s2 = http.createServer(buildApp(faultyPool));
    await new Promise(r => s2.listen(0, "127.0.0.1", r));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const r = await fetch(b2 + "/leasing/intake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-intake-secret": INTAKE_SECRET },
      body: JSON.stringify({ property_id: ID.property, name: "Third Prospect", phone: SHARED_PHONE,
        message: "the recovery connection will fail for this one", attempt_sms: false }),
    }).then(async x => ({ status: x.status, json: await x.json().catch(() => null) }));
    await new Promise(r2 => s2.close(r2));

    ok("a failed recovery CONNECT still answers 409, not 500", r.status === 409, r);
    ok("and still returns the honest not-saved receipt",
      !/has been saved/i.test(r.json?.receipt || "") && /not able to save/i.test(r.json?.receipt || ""),
      r.json?.receipt);
    ok("the recovery connection really was the one that failed", connects >= 2, connects);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log("\n6c · a widely-shared number does not disclose everyone on it");
  //  An unbounded candidate map wrote EVERY matching person's id into the
  //  retained record and returned every name to the operator. A corporate or
  //  family line is a shared line, not a pair of duplicate records, and the
  //  operator needs to be told that rather than handed a roster.
  {
    const many = [];
    for (let i = 0; i < 12; i++) many.push(uuid());
    await pool.query(
      `insert into persons (id, name, primary_phone_e164, phone)
       select u.id, 'Shared Line Person ' || u.ord, $2, $2
         from unnest($1::uuid[]) with ordinality as u(id, ord)`, [many, "+12155550222"]);
    try {
      const r = await intake({ property_id: ID.property, name: "Shared Line Caller",
        phone: "+12155550222", message: "twelve people share this number",
        source: "website-form", attempt_sms: false }, { "Idempotency-Key": "proof-key-shared" });
      ok("still refused", r.status === 409, r.status);
      const row = (await pool.query(
        `select unresolved_inquiry from comm_events
          where property_id=$1 and correlation_key like '%proof-key-shared%'
             or (unresolved_inquiry->'submitted'->>'phone') = $2`,
        [ID.property, "+12155550222"])).rows[0];
      const ev = (row && row.unresolved_inquiry) || {};
      const kept = (ev.conflict && ev.conflict.candidate_person_ids) || [];
      ok("the retained record keeps a BOUNDED candidate list", kept.length === 10, kept.length);
      ok("but records the true total, so nothing is silently truncated",
        ev.conflict && ev.conflict.candidate_total === 12, ev.conflict && ev.conflict.candidate_total);

      const ob = (await pool.query(
        `select id from obligations where property_id=$1 and type='prospect_identity_conflict'
          and related_id=(select id from comm_events where property_id=$1
                          and (unresolved_inquiry->'submitted'->>'phone')=$2)`,
        [ID.property, "+12155550222"])).rows[0];
      const view = await get(`/operator/obligations/${ob.id}/retained-inquiry`,
        { "x-staff-session": STAFF_TOKEN });
      ok("the operator is TOLD the list is partial",
        view.json?.retained_inquiry?.candidates_truncated === true,
        view.json?.retained_inquiry);
      ok("and told how many there really are",
        view.json?.retained_inquiry?.candidate_total === 12,
        view.json?.retained_inquiry?.candidate_total);
    } finally {
      await pool.query(`delete from persons where id = any($1::uuid[])`, [many]).catch(() => {});
    }
  }

  // ══════════════════════════════════════════════════════════════════
  console.log("\n7 · ordinary intake still works — the controls");
  const single = await intake({
    property_id: ID.property, name: "Solo Prospect", phone: SOLO_PHONE,
    message: "single match should just work", source: "website-form", attempt_sms: false,
  });
  ok("a single-match intake succeeds", single.status === 200, single);
  ok("it resolved to the EXISTING person, not a new one",
    String(single.json?.person_id) === String(ID.personSolo) && single.json?.new_person === false, single.json);

  const fresh = await intake({
    property_id: ID.property, name: "Brand New", phone: "+12155550199",
    message: "nobody has this number", source: "website-form", attempt_sms: false,
  });
  ok("a brand-new prospect is created", fresh.status === 200 && fresh.json?.new_person === true, fresh.json);
  if (fresh.json?.person_id) {
    await pool.query(`delete from lead_events where lead_id in (select id from leasing_leads where person_id=$1)`, [fresh.json.person_id]).catch(() => {});
    await pool.query(`delete from leasing_leads where person_id=$1`, [fresh.json.person_id]).catch(() => {});
    await pool.query(`delete from comm_events where person_id=$1`, [fresh.json.person_id]).catch(() => {});
    await pool.query(`delete from persons where id=$1`, [fresh.json.person_id]).catch(() => {});
  }

  await new Promise(r => server.close(r));
  await teardown();
  await pool.end();
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(async e => {
  console.error("\n  PROOF ABORTED:", e && e.stack || e);
  await teardown().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
