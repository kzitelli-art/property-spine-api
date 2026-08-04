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
  const t0 = receipt.begin(__filename, { url: CONN, expected: 27 });
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
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 27 });
  process.exit(code);
})().catch((e) => {
  console.error("DIED: " + (e && e.stack || e));
  console.log(`\n════ write authority: ${pass} passed, ${fail + 1} failed ════`);
  process.exit(1);
});
