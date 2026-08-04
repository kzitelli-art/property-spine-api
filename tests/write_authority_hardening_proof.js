#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  write_authority_hardening_proof.js — SLICES 1–9 WRITE AUTHORITY.
//
//  Real Postgres, real HTTP, synthetic data only.
//
//  WHAT THIS EXISTS TO PROVE. A human operating decision must be attributed
//  to the authenticated staff session and scoped to the authenticated
//  property — not to a user ID or property supplied by the request body.
//
//  Before this packet, POST /applications/:id/deny accepted
//  decided_by_user_id from the body behind a portfolio-wide shared key, and
//  the browser read that value out of a hidden input backed by localStorage.
//  The durable record of who declined an application was a typed string.
//
//  ── THE FIXTURE SUBMITS THROUGH THE CANONICAL LIFECYCLE ──────────
//  An earlier version of this harness inserted lease_applications rows
//  directly. The denial service refused every one of them with
//
//      {"receipt":"No open application_approval gate on this application."}
//
//  which was the PRODUCT BEING RIGHT: a denial closes an approval gate, and
//  only the canonical submission path spawns one. The eight resulting
//  failures were left red rather than relaxed, because relaxing them would
//  have turned a real gap into a green tick.
//
//  They are fixed the correct way: every application under test is now
//  created by submitApplicationService — the one service that creates an
//  application and spawns its gate. No obligation is manufactured with raw
//  SQL to satisfy the service. The applications under test are applications
//  the product itself created.
//
//  Run:  HARNESS_DATABASE_URL=… OPERATOR_KEY=… node tests/write_authority_hardening_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const CONN = receipt.harnessConnectionString();
const PORT = Number(process.env.PROOF_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = process.env.OPERATOR_KEY || "harness-operator-key";

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); }
                       else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 60 - s.length)));

function req(method, p, { session, key, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { "content-type": "application/json" };
    if (session) h["x-staff-session"] = session;
    if (key) h["x-operator-key"] = key;
    if (data) h["content-length"] = Buffer.byteLength(data);
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method, headers: h }, (res) => {
      let buf = ""; res.on("data", (d) => (buf += d));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const t0 = receipt.begin(__filename, { url: CONN, expected: 93 });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const svc = require(path.join(__dirname, "..", "src/identity/staff_session_service.js"));
  const c = await pool.connect();
  const one = async (q, a = []) => (await c.query(q, a)).rows[0];

  //  ── SYNTHETIC FIXTURE ────────────────────────────────────────────
  await c.query("begin");
  const uniq = "wah" + Date.now().toString(36);
  const A = (await one(`insert into properties (name, operating_timezone)
    values ($1,'America/New_York') returning id`, [uniq + " Property A"])).id;
  const B = (await one(`insert into properties (name, operating_timezone)
    values ($1,'America/New_York') returning id`, [uniq + " Property B"])).id;
  const mkUser = async (n) => (await one(
    `insert into users (name,email,phone,role,is_active,status)
     values ($1,$2,$3,'property_manager',true,'active') returning id`,
    [n, `${n}@${uniq}.test`, "+1727" + String(Math.floor(Math.random() * 9e6 + 1e6))])).id;
  const uA = await mkUser(uniq + "-leasingA");     // leasing on A
  const uB = await mkUser(uniq + "-leasingB");     // leasing on B — the neighbour
  const uNoMod = await mkUser(uniq + "-nomodule"); // real staff on A, maintenance only
  const uImposter = await mkUser(uniq + "-imposter"); // exists, never acts
  const assign = (u, p, m) => c.query(
    `insert into property_team_assignments
      (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof','property',$3,$3,false,true)`, [p, u, m]);
  await assign(uA, A, ["leasing"]);
  await assign(uB, B, ["leasing"]);
  await assign(uNoMod, A, ["maintenance"]);
  await assign(uImposter, A, ["leasing"]);

  const person = (await one(`insert into persons (name, lifecycle_status)
    values ($1,'lead') returning id`, [uniq + " Applicant"])).id;
  //  ── THE APPLICATION IS CREATED THROUGH THE CANONICAL LIFECYCLE ────
  //  submitApplicationService is the ONE service that creates an application,
  //  and it spawns the application_approval gate itself (:296). A raw
  //  lease_applications insert has no gate, so the denial service correctly
  //  refuses 409 "No open application_approval gate" — the product being
  //  right and the fixture being wrong.
  //
  //  Manufacturing that obligation with raw SQL would satisfy the service
  //  while proving nothing about the real lifecycle, so the fixture calls the
  //  real submission instead. Every application under test is therefore an
  //  application the product itself created.
  const submissionModule = require(path.join(__dirname, "..", "src/applications/applicationSubmission.js"));
  let _submit = null;
  const mkApp = async (prop) => {
    const cc = await pool.connect();
    try {
      await cc.query("begin");
      const out = await _submit(cc, {
        property_id: prop, person_id: person,
        applicant_name: uniq + " Applicant",
        source: "applicant",
      });
      await cc.query("commit");
      return out.application.id;
    } catch (e) { await cc.query("rollback").catch(() => {}); throw e; }
    finally { cc.release(); }
  };
  await c.query("commit");
  c.release();

  const mkSession = async (u, p) => {
    const cc = await pool.connect();
    try { await cc.query("begin");
      const s = await svc.issueStaffSession(cc, { userId: u, propertyId: p, purpose: "sms_otp" });
      await cc.query("commit"); return s.session_token;
    } finally { cc.release(); }
  };
  const sA = await mkSession(uA, A), sB = await mkSession(uB, B), sNoMod = await mkSession(uNoMod, A);

  //  ── THE SERVER, real HTTP ────────────────────────────────────────
  process.env.DATABASE_URL = CONN;
  process.env.OPERATOR_KEY = KEY;
  process.env.PORT = String(PORT);
  const app = require(path.join(__dirname, "..", "server.js"));
  await new Promise((r) => setTimeout(r, 1500));
  //  server.js exports nothing, so the fixture builds the SAME module with the
  //  SAME deps the server gives it — one implementation, reached twice.
  const { spawnObligationFromEvent, completeObligation } =
    require(path.join(__dirname, "..", "src/shared/obligation_engine.js"));
  _submit = submissionModule({
    pool, spawnObligationFromEvent, completeObligation,
    conversionService: null, commBoundary: null, applicationInputAuthority: null,
  })._service.submitApplicationService;

  const DENY = "/operator/leasing/applications/";

  section("A  the authenticated actor is the durable actor");
  {
    const id = await mkApp(A);
    const r = await req("POST", `${DENY}${id}/deny`, { session: sA, body: { reason: "declined", note: "proof" } });
    ok(`A1  a valid authorized staff session succeeds (got ${r.status}) ${r.status!==200?JSON.stringify(r.body).slice(0,200):""}`, r.status === 200);
    ok("A2  the response names the session actor as the decider", r.body && r.body.decided_by_user_id === uA);
    const row = await (await pool.query(
      `select terminal_code, decision_by_user_id, status
         from lease_applications where id=$1`, [id])).rows[0];
    const durableActor = row && (row.decision_by_user_id);
    ok(`A3  DURABLE actor equals the authenticated actor (${durableActor === uA ? "match" : String(durableActor)})`,
      durableActor === uA);
    ok("A4  the durable status is terminal", row && row.status === "declined");
    const ev = await (await pool.query(
      `select count(*)::int n from events where type='application_denied' and property_id=$1`, [A])).rows[0];
    ok("A5  a durable event survives the authority change (provenance preserved)", ev.n >= 1);

    //  THE GATE MUST CLOSE. A denial that leaves the approval gate open would
    //  leave the team chasing a decision that has already been made.
    const gate = await (await pool.query(
      `select o.status from obligations o
        where o.property_id=$1 and o.type='application_approval'
        order by o.created_at desc limit 1`, [A])).rows[0];
    ok(`A6  the application_approval gate is CLOSED by the denial (${gate ? gate.status : "no gate"})`,
      !!gate && gate.status !== "open" && gate.status !== "in_progress");

    //  THE EVENT MUST REACH THE EXACT APPLICATION. A denial event that names
    //  only a property cannot tell a later reader WHICH proposal it ended —
    //  which is the future-accounting lineage question.
    const evRow = await (await pool.query(
      `select e.person_id, e.note from events e
        where e.type='application_denied' and e.property_id=$1
        order by e.occurred_at desc limit 1`, [A])).rows[0];
    ok("A7  the denial event carries the person lineage of the exact application",
      !!evRow && String(evRow.person_id) === String(person));

    //  THE ROUTE IS A WRAPPER, NOT A SECOND SHAPE. The operator response must
    //  be the canonical service payload plus only the fields the route adds.
    const canonicalKeys = ["receipt", "application"];
    const routeAdded = ["decided_by_user_id", "property_id"];
    const got = Object.keys(r.body || {}).sort();
    ok(`A8  the payload is the canonical service's, plus only route wrapper fields (${got.join(",")})`,
      canonicalKeys.every((k) => got.includes(k))
      && got.every((k) => canonicalKeys.includes(k) || routeAdded.includes(k)));
  }

  section("B  forged actor and forged property are ineffective");
  {
    const id = await mkApp(A);
    const r = await req("POST", `${DENY}${id}/deny`,
      { session: sA, body: { reason: "declined", decided_by_user_id: uImposter } });
    ok(`B1  a body-supplied actor is REFUSED, not silently ignored (got ${r.status})`, r.status === 400);
    ok("B2  and the refusal names the field", r.body && Array.isArray(r.body.fields)
      && r.body.fields.includes("decided_by_user_id"));
    const still = await (await pool.query("select status from lease_applications where id=$1", [id])).rows[0];
    ok("B3  and NOTHING was written — the application is untouched", still.status === "submitted");

    const r2 = await req("POST", `${DENY}${id}/deny`, { session: sA, body: { reason: "declined", property_id: B } });
    ok(`B4  a body-supplied property_id is REFUSED (got ${r2.status})`, r2.status === 400);
    const r3 = await req("POST", `${DENY}${id}/deny`, { session: sA, body: { reason: "declined", actor_user_id: uImposter } });
    ok("B5  actor_user_id is refused too", r3.status === 400);

    //  and after the refusals, a clean call still records the SESSION actor
    const r4 = await req("POST", `${DENY}${id}/deny`, { session: sA, body: { reason: "declined" } });
    const row = await (await pool.query(
      `select decision_by_user_id from lease_applications where id=$1`, [id])).rows[0];
    const actor = row.decision_by_user_id;
    ok(`B6  the imposter never reaches the durable record (${actor === uA ? "session actor" : String(actor)})`,
      r4.status === 200 && actor === uA && actor !== uImposter);
  }

  section("C  property scope and module entitlement");
  {
    const idA = await mkApp(A);
    const rB = await req("POST", `${DENY}${idA}/deny`, { session: sB, body: { reason: "declined" } });
    ok(`C1  a session scoped to ANOTHER property is refused (got ${rB.status})`, rB.status === 403);
    const stillA = await (await pool.query("select status from lease_applications where id=$1", [idA])).rows[0];
    ok("C2  and the neighbouring application is unchanged", stillA.status === "submitted");

    const rNo = await req("POST", `${DENY}${idA}/deny`, { session: sNoMod, body: { reason: "declined" } });
    ok(`C3  a REAL signed-in operator without the leasing module is refused (got ${rNo.status})`,
      rNo.status === 403 || rNo.status === 401);

    const rNone = await req("POST", `${DENY}${idA}/deny`, { body: { reason: "declined" } });
    ok(`C4  no session is refused (got ${rNone.status})`, rNone.status === 401);

    const rKey = await req("POST", `${DENY}${idA}/deny`, { key: KEY, body: { reason: "declined" } });
    ok(`C5  the shared OPERATOR_KEY ALONE cannot perform the staff decision (got ${rKey.status})`,
      rKey.status === 401);

    const rBogus = await req("POST", `${DENY}${idA}/deny`, { session: "not-a-real-session", body: { reason: "declined" } });
    ok(`C6  an invalid session is refused (got ${rBogus.status})`, rBogus.status === 401);

    const after = await (await pool.query("select status from lease_applications where id=$1", [idA])).rows[0];
    ok("C7  after five refusals the application is STILL untouched", after.status === "submitted");
  }

  section("F  the same standard on APPROVE — the other decision-class route");
  {
    const id = await mkApp(A);
    const APPROVE = `/operator/leasing/applications/${id}/approve`;
    const rF = await req("POST", APPROVE, { session: sA, body: { approved_by: uImposter } });
    ok(`F1  a forged approved_by is REFUSED, not silently ignored (got ${rF.status})`, rF.status === 400);
    ok("F2  and the refusal names the field", rF.body && (rF.body.fields || []).includes("approved_by"));
    const rP = await req("POST", APPROVE, { session: sA, body: { property_id: B } });
    ok(`F3  a forged property_id is REFUSED (got ${rP.status})`, rP.status === 400);
    const rWrongProp = await req("POST", APPROVE, { session: sB, body: {} });
    ok(`F4  a session scoped to another property is refused (got ${rWrongProp.status})`,
      rWrongProp.status === 403 || rWrongProp.status === 404);
    const rNoMod = await req("POST", APPROVE, { session: sNoMod, body: {} });
    ok(`F5  a real operator without the leasing module is refused (got ${rNoMod.status})`,
      rNoMod.status === 403 || rNoMod.status === 401);
    const rNoSess = await req("POST", APPROVE, { body: {} });
    ok(`F6  no session is refused (got ${rNoSess.status})`, rNoSess.status === 401);
    const rKey2 = await req("POST", APPROVE, { key: KEY, body: {} });
    ok(`F7  the shared key alone cannot approve (got ${rKey2.status})`, rKey2.status === 401);
    const still = await (await pool.query("select status from lease_applications where id=$1", [id])).rows[0];
    ok("F8  after every refusal the application is untouched", still.status === "submitted");
    //  ONE REFUSAL RULE, not two copies.
    const opSrc2 = require("fs").readFileSync(
      path.join(__dirname, "..", "src/identity/operator.js"), "utf8");
    ok("F9  approve and deny share ONE authority-refusal implementation",
      (opSrc2.match(/function refuseClientAssertedAuthority/g) || []).length === 1
      && (opSrc2.match(/refuseClientAssertedAuthority\(req, res\)/g) || []).length >= 2);
  }

  section("G  TOUR CHECK-IN — physical presence, session-derived");
  {
    //  A tour on A, built through the canonical lead + tour rails.
    const lead = (await pool.query(
      `insert into leasing_leads (person_id, property_id, status, received_at)
       values ($1,$2,'new', now()) returning id`, [person, A])).rows[0].id;
    //  'scheduled' is the status EVERY canonical booking path writes
    //  (leasingleads.js:1574, :1826, :2579; operator.js:2993). Not invented here.
    const tour = (await pool.query(
      `insert into leasing_tours (lead_id, property_id, scheduled_for, status)
       values ($1,$2, now() + interval '1 hour', 'scheduled') returning id`, [lead, A])).rows[0].id;
    const CI = `/operator/leasing/tours/${tour}/check-in`;

    const rForge = await req("POST", CI, { session: sA, body: { actor_id: uImposter } });
    ok(`G1  a forged actor_id is REFUSED (got ${rForge.status})`, rForge.status === 400);
    const rProp = await req("POST", CI, { session: sA, body: { property_id: B } });
    ok(`G2  a forged property_id is REFUSED (got ${rProp.status})`, rProp.status === 400);
    const rNoSess = await req("POST", CI, { body: {} });
    ok(`G3  no session is refused (got ${rNoSess.status})`, rNoSess.status === 401);
    const rKey = await req("POST", CI, { key: KEY, body: {} });
    ok(`G4  the shared key alone cannot check in (got ${rKey.status})`, rKey.status === 401);
    const rMod = await req("POST", CI, { session: sNoMod, body: {} });
    ok(`G5  a real operator without the leasing module is refused (got ${rMod.status})`,
      rMod.status === 403 || rMod.status === 401);
    const rWrongProp = await req("POST", CI, { session: sB, body: {} });
    ok(`G6  a session on another property is refused (got ${rWrongProp.status})`, rWrongProp.status === 403);

    const none = await (await pool.query(
      `select count(*)::int n from tour_events where tour_id=$1 and event_type='checked_in'`, [tour])).rows[0];
    ok("G7  after every refusal NO check-in was recorded", none.n === 0);

    //  THE EMPLOYEE TYPES NOTHING. Empty body, valid session.
    const rOk = await req("POST", CI, { session: sA, body: {} });
    ok(`G8  a valid session checks in with an EMPTY body (got ${rOk.status})`, rOk.status === 200);
    const ev = await (await pool.query(
      `select actor_id, actor_type from tour_events
        where tour_id=$1 and event_type='checked_in' order by event_at desc limit 1`, [tour])).rows[0];
    ok(`G9  the DURABLE presence actor is the authenticated session user`,
      !!ev && String(ev.actor_id) === String(uA) && ev.actor_type === "human");
    ok("G10 and it is never the imposter", !ev || String(ev.actor_id) !== String(uImposter));

    const src = require("fs").readFileSync(
      path.join(__dirname, "..", "src/leasing/leasingleads.js"), "utf8");
    ok("G11 exactly ONE check-in implementation exists",
      (src.match(/async function checkInTourService/g) || []).length === 1);
    ok("G12 the legacy key door calls the same service",
      /checkInTourService\(client, \{ tourId, actorUserId: b\.actor_id \}\)/.test(src));
  }

  //  ── WAVE 1: THE REMAINING FIVE ────────────────────────────────────
  //  Tour completion, walk-in capture, the follow-up task rail and executed-
  //  lease verification all ALREADY derived their actor and property from the
  //  session. What they did not do was refuse a body that claimed otherwise:
  //  a stale caller sending actor_id got a 200 and never learned it had been
  //  overruled. Silent correctness is still a lie by omission — the caller
  //  goes on believing it named the actor. Each now refuses, and each is held
  //  to the same six questions as deny and check-in.
  section("H  TOUR COMPLETION — session-derived recorder");
  {
    //  A FRESH PERSON PER TOUR. leasing_leads carries a unique index of one
    //  OPEN lead per person per property — the product being right about a
    //  prospect not being two live leads at one building. Reusing the section-G
    //  person violates it, so each tour gets its own prospect.
    const mkTour = async (prop) => {
      const p = (await pool.query(`insert into persons (name, lifecycle_status)
        values ($1,'lead') returning id`, [uniq + " Tourer " + Math.random().toString(36).slice(2, 8)])).rows[0].id;
      const lead = (await pool.query(
        `insert into leasing_leads (person_id, property_id, status, received_at)
         values ($1,$2,'new', now()) returning id`, [p, prop])).rows[0].id;
      return (await pool.query(
        `insert into leasing_tours (lead_id, property_id, scheduled_for, status)
         values ($1,$2, now() - interval '1 hour', 'scheduled') returning id`, [lead, prop])).rows[0].id;
    };
    const t = await mkTour(A);
    const P = (id) => `/operator/leasing/tours/${id}/complete`;
    const good = { feedback: { interest_level: "warm", next_step: "follow_up", tour_given: true } };

    const rForge = await req("POST", P(t), { session: sA, body: { ...good, actor_id: uImposter } });
    ok(`H1  a forged actor_id is REFUSED (got ${rForge.status})`, rForge.status === 400);
    const rProp = await req("POST", P(t), { session: sA, body: { ...good, property_id: B } });
    ok(`H2  a forged property_id is REFUSED (got ${rProp.status})`, rProp.status === 400);
    ok(`H3  no session is refused (got ${(await req("POST", P(t), { body: good })).status})`,
      (await req("POST", P(t), { body: good })).status === 401);
    ok(`H4  the shared key alone cannot complete on this door`,
      (await req("POST", P(t), { key: KEY, body: good })).status === 401);
    const rMod = await req("POST", P(t), { session: sNoMod, body: good });
    ok(`H5  a real operator without the leasing module is refused (got ${rMod.status})`,
      rMod.status === 403 || rMod.status === 401);
    const rXProp = await req("POST", P(t), { session: sB, body: good });
    ok(`H6  a session on another property is refused (got ${rXProp.status})`, rXProp.status === 403);
    const untouched = (await pool.query(`select status from leasing_tours where id=$1`, [t])).rows[0];
    ok("H7  after every refusal the tour is UNTOUCHED", untouched.status === "scheduled");

    const rOk = await req("POST", P(t), { session: sA, body: good });
    ok(`H8  a valid session completes the tour (got ${rOk.status})`, rOk.status === 200);
    const ev = (await pool.query(
      `select actor_id, actor_type, metadata from tour_events
        where tour_id=$1 and event_type='completed' order by event_at desc limit 1`, [t])).rows[0];
    ok("H9  the DURABLE recorder is the authenticated session user",
      !!ev && String(ev.actor_id) === String(uA) && String(ev.metadata.recorded_by_user_id) === String(uA));
    ok("H10 and it is never the imposter", !!ev && String(ev.actor_id) !== String(uImposter));
    //  BUSINESS FACTS ARE NOT AUTHORITY. The two fields naming who GAVE the
    //  tour and who OWNS the follow-up must still be accepted: refusing them
    //  would destroy real leasing facts to protect an identity they never claim.
    const t2 = await mkTour(A);
    const rHost = await req("POST", P(t2), { session: sA,
      body: { ...good, actual_tour_host_user_id: uImposter, follow_up_owner_user_id: uImposter } });
    ok(`H11 actual_tour_host_user_id / follow_up_owner_user_id are ACCEPTED — business facts, not authority (got ${rHost.status})`,
      rHost.status === 200);
    const ev2 = (await pool.query(
      `select actor_id, metadata from tour_events
        where tour_id=$1 and event_type='completed' order by event_at desc limit 1`, [t2])).rows[0];
    //  AND THE PRODUCT IS STRICTER THAN "ACCEPTED". A host id that is not a
    //  roster-validated staff identity at this property does NOT become
    //  actual_tour_host_user_id — it degrades to a free-text CLAIM that is
    //  never dereferenced. So the fact survives, is honestly labelled as
    //  unverified, and the recorder is still the session user.
    ok("H12 an unvalidated host id degrades to a free-text claim — never a staff attribution",
      !!ev2 && ev2.metadata.actual_tour_host_user_id === null
      && String(ev2.metadata.actual_tour_host_name_claim) === String(uImposter));
    ok("H12b and the recorder on that same event is still the session user",
      !!ev2 && String(ev2.actor_id) === String(uA)
      && String(ev2.metadata.recorded_by_user_id) === String(uA));

    const src = require("fs").readFileSync(
      path.join(__dirname, "..", "src/leasing/leasingleads.js"), "utf8");
    ok("H13 exactly ONE completion implementation exists",
      (src.match(/async function completeTourService/g) || []).length === 1);
  }

  section("I  FOLLOW-UP COMPLETION — the task rail");
  {
    //  The follow-up is OPENED by completeTourService (server-derived, no
    //  client identity anywhere) and CLOSED here. Section H just completed a
    //  tour on A, so a real conversion task exists to aim at.
    const task = (await pool.query(
      `select lco.obligation_id, c.property_id from leasing_conversion_obligations lco
         join leasing_conversions c on c.id = lco.conversion_id
        where c.property_id=$1 order by lco.created_at desc limit 1`, [A])).rows[0];
    ok("I0  completing a tour OPENED a follow-up task with no client identity involved", !!task);
    if (task) {
      const R = `/operator/leasing/tasks/${task.obligation_id}/resolve`;
      const RA = `/operator/leasing/tasks/${task.obligation_id}/reassign`;
      const rForge = await req("POST", R, { session: sA, body: { result: "completed", by_user_id: uImposter } });
      ok(`I1  a forged by_user_id on resolve is REFUSED (got ${rForge.status})`, rForge.status === 400);
      const rProp = await req("POST", R, { session: sA, body: { result: "completed", property_id: B } });
      ok(`I2  a forged property_id on resolve is REFUSED (got ${rProp.status})`, rProp.status === 400);
      const rForgeA = await req("POST", RA, { session: sA, body: { to_user_id: uA, actor_user_id: uImposter } });
      ok(`I3  a forged actor on reassign is REFUSED (got ${rForgeA.status})`, rForgeA.status === 400);
      ok(`I4  no session is refused`, (await req("POST", R, { body: {} })).status === 401);
      ok(`I5  the shared key alone cannot resolve`, (await req("POST", R, { key: KEY, body: {} })).status === 401);
      const rMod = await req("POST", R, { session: sNoMod, body: {} });
      ok(`I6  a real operator without the leasing module is refused (got ${rMod.status})`,
        rMod.status === 403 || rMod.status === 401);
      const rXProp = await req("POST", R, { session: sB, body: {} });
      ok(`I7  a session on another property is refused (got ${rXProp.status})`, rXProp.status === 403);
      const st = (await pool.query(`select status from obligations where id=$1`, [task.obligation_id])).rows[0];
      ok("I8  after every refusal the task is still open", !!st && st.status === "open");
      //  to_user_id is the BUSINESS decision "who does this work" and must
      //  reach the service. The claim under test is NOT that it succeeds —
      //  eligibility and reason rules are the service's own business, and a
      //  400 from them is the product working. The claim is that the AUTHORITY
      //  layer let it through: whatever comes back is never client_supplied_authority.
      const rReassign = await req("POST", RA, { session: sA,
        body: { to_user_id: uA, reason: "coverage_change" } });
      ok(`I9  to_user_id reaches the service — assigning work is a business decision, not an authority claim (got ${rReassign.status})`,
        !(rReassign.body && rReassign.body.error === "client_supplied_authority"));
      ok("I10 and its refusal, if any, is a BUSINESS refusal with its own reason",
        rReassign.status === 200
        || (rReassign.body && typeof (rReassign.body.error || rReassign.body.receipt) === "string"
            && rReassign.body.error !== "client_supplied_authority"));
    } else {
      //  NO SILENT SKIP. If the rail did not open, that is a finding, not a gap
      //  to paper over — the remaining assertions are recorded as failures.
      for (let i = 1; i <= 9; i++) ok(`I${i}  NOT RUN — no follow-up task was opened by tour completion`, false);
    }
  }

  section("J  WALK-IN CAPTURE — post-tour capture with no scheduled tour");
  {
    const W = "/operator/leasing/walk-in-tour";
    //  Its own prospect, with a lead on A only — so the cross-property refusal
    //  below is a real property wall, not an accident of shared fixture state.
    const person = (await pool.query(`insert into persons (name, lifecycle_status)
      values ($1,'lead') returning id`, [uniq + " WalkIn"])).rows[0].id;
    await pool.query(`insert into leasing_leads (person_id, property_id, status, received_at)
      values ($1,$2,'new', now())`, [person, A]);
    const rForge = await req("POST", W, { session: sA, body: { person_id: person, actor_id: uImposter } });
    ok(`J1  a forged actor_id is REFUSED (got ${rForge.status})`, rForge.status === 400);
    const rProp = await req("POST", W, { session: sA, body: { person_id: person, property_id: B } });
    ok(`J2  a forged property_id is REFUSED (got ${rProp.status})`, rProp.status === 400);
    ok(`J3  no session is refused`, (await req("POST", W, { body: { person_id: person } })).status === 401);
    ok(`J4  the shared key alone cannot capture`,
      (await req("POST", W, { key: KEY, body: { person_id: person } })).status === 401);
    const rMod = await req("POST", W, { session: sNoMod, body: { person_id: person } });
    ok(`J5  a real operator without the leasing module is refused (got ${rMod.status})`,
      rMod.status === 403 || rMod.status === 401);
    //  CROSS-PROPERTY: B's session cannot capture a walk-in for A's person,
    //  because the lead lookup is walled to the SESSION's property.
    const rXProp = await req("POST", W, { session: sB, body: { person_id: person } });
    ok(`J6  a session on another property cannot capture this person (got ${rXProp.status})`,
      rXProp.status === 409 || rXProp.status === 404 || rXProp.status === 403);
    const before = (await pool.query(
      `select count(*)::int n from leasing_tours where property_id=$1 and origin='walk_in'`, [A])).rows[0].n;
    ok("J7  after every refusal NO walk-in tour was created", before === 0);
    const rOk = await req("POST", W, { session: sA, body: { person_id: person } });
    ok(`J8  a valid session captures the walk-in (got ${rOk.status})`, rOk.status === 200);
    const t = (await pool.query(
      `select id, property_id, leasing_agent_id from leasing_tours
        where property_id=$1 and origin='walk_in' order by created_at desc limit 1`, [A])).rows[0];
    ok("J9  the durable tour is on the SESSION's property, hosted by the session user",
      !!t && String(t.property_id) === String(A) && String(t.leasing_agent_id) === String(uA));
  }

  section("K  EXECUTED-LEASE VERIFICATION");
  {
    const id = await mkApp(A);
    const V = `/operator/leasing/applications/${id}/executed-lease/verify`;
    const rForge = await req("POST", V, { session: sA, body: { actor_user_id: uImposter } });
    ok(`K1  a forged actor is REFUSED (got ${rForge.status})`, rForge.status === 400);
    const rProp = await req("POST", V, { session: sA, body: { property_id: B } });
    ok(`K2  a forged property_id is REFUSED (got ${rProp.status})`, rProp.status === 400);
    ok(`K3  no session is refused`, (await req("POST", V, { body: {} })).status === 401);
    ok(`K4  the shared key alone cannot verify`, (await req("POST", V, { key: KEY, body: {} })).status === 401);
    const rMod = await req("POST", V, { session: sNoMod, body: {} });
    ok(`K5  a real operator without the leasing module is refused (got ${rMod.status})`,
      rMod.status === 403 || rMod.status === 401);
    const rXProp = await req("POST", V, { session: sB, body: {} });
    ok(`K6  a session on another property is refused (got ${rXProp.status})`, rXProp.status === 403);
    const st = (await pool.query(`select status from lease_applications where id=$1`, [id])).rows[0];
    ok("K7  after every refusal the application is untouched", st.status === "submitted");
    ok("K8  the verifying user is server-derived in source, never a body value",
      /verified_by_user_id: req\.operator\.id/.test(
        require("fs").readFileSync(path.join(__dirname, "..", "src/identity/operator.js"), "utf8")));
  }

  section("L  ONE REFUSAL RULE ACROSS EVERY WAVE 1 DOOR");
  {
    const opSrc = require("fs").readFileSync(
      path.join(__dirname, "..", "src/identity/operator.js"), "utf8");
    ok("L1  exactly ONE refusal implementation exists",
      (opSrc.match(/function refuseClientAssertedAuthority/g) || []).length === 1);
    //  deny, approve, check-in, complete, task resolve, taskAction (covering
    //  reassign/reopen/change-due), walk-in capture, executed-lease verify.
    const calls = (opSrc.match(/refuseClientAssertedAuthority\(req, res\)/g) || []).length;
    ok(`L2  every migrated door calls that one rule (${calls} call sites)`, calls >= 8);
    //  ONE ARRAY LITERAL, not one mention. The name appears three times —
    //  the definition, the filter inside the rule, and the DENY_BODY_… alias
    //  that keeps the older name pointing at the SAME frozen array. Aliasing
    //  a single source is not a second list; a second literal would be.
    ok("L3  exactly ONE literal defines the refused fields — the alias points at it, it does not copy it",
      (opSrc.match(/STAFF_AUTHORITY_ASSERTION_FIELDS\s*=\s*Object\.freeze\(\[/g) || []).length === 1
      && /DENY_BODY_AUTHORITY_FIELDS\s*=\s*STAFF_AUTHORITY_ASSERTION_FIELDS\s*;/.test(opSrc));
  }

  section("D  one canonical service, two doors, no fork");
  {
    const submission = require(path.join(__dirname, "..", "src/applications/applicationSubmission.js"));
    const src = require("fs").readFileSync(
      path.join(__dirname, "..", "src/applications/applicationSubmission.js"), "utf8");
    ok("D1  exactly ONE denial implementation exists in source",
      (src.match(/async function denyApplicationService/g) || []).length === 1);
    const opSrc = require("fs").readFileSync(
      path.join(__dirname, "..", "src/identity/operator.js"), "utf8");
    ok("D2  the operator door CALLS it and contains no denial logic of its own",
      /submissionService\.denyApplicationService\(/.test(opSrc)
      && !/markTerminal\(/.test(opSrc.slice(opSrc.indexOf("applications/:id/deny"),
                                            opSrc.indexOf("applications/:id/deny") + 4000)));
    ok("D3  the legacy door also calls it — behaviour unchanged, not duplicated",
      /denyApplicationService\(client, \{[\s\S]{0,200}decidedByUserId: b\.decided_by_user_id/.test(src));
    ok("D4  no new business service and no migration were added",
      require("fs").readdirSync(path.join(__dirname, "..", "migrations"))
        .filter((f) => /^13\d_/.test(f)).length === 0);
  }

  section("E  the legacy shared-key door is unchanged (deprecated, not broken)");
  {
    const id = await mkApp(A);
    const r = await req("POST", `/applications/${id}/deny`, { key: KEY, body: { reason: "withdrawn", decided_by_user_id: uImposter } });
    ok(`E1  the legacy door still works for its existing consumers (got ${r.status})`, r.status === 200);
    ok("E2  and still records what it always recorded — no silent behaviour change",
      r.body && /withdrawn/.test(JSON.stringify(r.body)));
    console.log("   NOTE  the legacy door remains caller-asserted. It is DEPRECATED, not retired:");
    console.log("         its actor must not be read as an authenticated staff decision.");
  }

  console.log(`\n════ write authority: ${pass} passed, ${fail} failed ════`);
  await pool.end();
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 93 });
  process.exit(code);
})().catch((e) => {
  console.error("DIED: " + (e && e.stack || e));
  console.log(`\n════ write authority: ${pass} passed, ${fail + 1} failed ════`);
  process.exit(1);
});
