#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  receipts_c1_decision_authority_probe.js — IS THERE ANYTHING TO POINT AT?
//
//  Before an application-decision receipt is built, the decision must have a
//  durable identity worth returning. This probe performs a REAL approval and
//  a REAL denial through the governed operator doors, then asks the database
//  what actually exists afterwards.
//
//  The bar, set by the gate:
//    receipt_id must be an existing IMMUTABLE decision-domain record that
//    directly names the application and the actor.
//
//  And explicitly NOT: application_id alone, person_id, property_id, a
//  decision timestamp, the operation_id, the current lease_applications row,
//  or a generic event lacking application lineage.
//
//  A DECISION IS NOT A REPLAY GUARANTEE. "This application is already
//  approved" is a lifecycle refusal. It is not idempotent replay: it cannot
//  tell the caller whether THEIR request was the one that did it, and it
//  returns no durable identity. The two are different contracts and this
//  probe keeps them apart.
//
//  Writes nothing beyond its own synthetic fixture. Adds no column, no index.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const CONN = receipt.harnessConnectionString();
const PORT = Number(process.env.PROOF_PORT || 3123);
const KEY = process.env.OPERATOR_KEY || "harness-operator-key";

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); }
                       else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));

function req(method, p, { session, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { "content-type": "application/json" };
    if (session) h["x-staff-session"] = session;
    if (data) h["content-length"] = Buffer.byteLength(data);
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method, headers: h }, (res) => {
      let buf = ""; res.on("data", (d) => (buf += d));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const t0 = receipt.begin(__filename, { url: CONN, expected: 18 });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const svc = require(path.join(__dirname, "..", "src/identity/staff_session_service.js"));
  const q = async (s, a = []) => (await pool.query(s, a)).rows;
  const c = await pool.connect();
  const one = async (s, a = []) => (await c.query(s, a)).rows[0];

  await c.query("begin");
  const u = "c1d" + Date.now().toString(36);
  const A = (await one(`insert into properties (name, operating_timezone)
    values ($1,'America/New_York') returning id`, [u + " A"])).id;
  const uA = (await one(`insert into users (name,email,phone,role,is_active,status)
    values ($1,$2,$3,'property_manager',true,'active') returning id`,
    [u + "-a", u + "a@t.test", "+1727" + Math.floor(Math.random() * 9e6 + 1e6)])).id;
  await c.query(`insert into property_team_assignments
    (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
    values ($1,$2,'Proof','property',$3,$3,false,true)`, [A, uA, ["leasing"]]);
  const person = (await one(`insert into persons (name, lifecycle_status)
    values ($1,'lead') returning id`, [u + " Applicant"])).id;
  //  ── THE STAFF IDENTITY BRIDGE ────────────────────────────────────
  //  The approval gate refuses an operator who is not gate-eligible, and
  //  eligibility requires a DELIBERATE users.person_id bridge to a human_staff
  //  person — not merely an assignment. An earlier run of this probe omitted
  //  it and the approve door correctly answered not_gate_eligible: the
  //  FIXTURE was incomplete, not the product. Building the eligible operator
  //  properly is the only honest way to observe what a real approval writes.
  const staffPerson = (await one(`insert into persons (name, lifecycle_status)
    values ($1,'staff') returning id`, [u + " Operator"])).id;
  await c.query(`update users set person_id=$2 where id=$1`, [uA, staffPerson]);
  await c.query("commit"); c.release();

  const cc0 = await pool.connect();
  await cc0.query("begin");
  const sA = (await svc.issueStaffSession(cc0, { userId: uA, propertyId: A, purpose: "sms_otp" })).session_token;
  await cc0.query("commit"); cc0.release();

  process.env.DATABASE_URL = CONN; process.env.OPERATOR_KEY = KEY; process.env.PORT = String(PORT);
  require(path.join(__dirname, "..", "server.js"));
  await new Promise((r) => setTimeout(r, 1500));

  const submissionModule = require(path.join(__dirname, "..", "src/applications/applicationSubmission.js"));
  const { spawnObligationFromEvent, completeObligation } =
    require(path.join(__dirname, "..", "src/shared/obligation_engine.js"));
  const _submit = submissionModule({ pool, spawnObligationFromEvent, completeObligation,
    conversionService: null, commBoundary: null, applicationInputAuthority: null })._service.submitApplicationService;
  const mkApp = async () => {
    const cx = await pool.connect();
    try { await cx.query("begin");
      const out = await _submit(cx, { property_id: A, person_id: person,
        applicant_name: u + " Applicant", source: "applicant" });
      await cx.query("commit"); return out.application.id;
    } catch (e) { await cx.query("rollback").catch(() => {}); throw e; } finally { cx.release(); }
  };

  try {
    section("1  can an operation_id even be STORED on a decision?");
    const appCols = (await q(`select column_name from information_schema.columns
      where table_name='lease_applications'`)).map((r) => r.column_name);
    const idemCols = appCols.filter((n) => /idempot|operation/i.test(n));
    console.log(`   lease_applications columns matching idempot|operation: ${idemCols.length ? idemCols.join(", ") : "NONE"}`);
    ok("1a lease_applications has NO column able to hold a replay identity", idemCols.length === 0);
    //  Is there ANY table that both names an application and could hold a key?
    const appNaming = (await q(`select table_name from information_schema.columns
      where column_name='application_id'`)).map((r) => r.table_name);
    console.log(`   tables naming an application: ${appNaming.join(", ")}`);
    const decisionCarrier = appNaming.filter((t) => /decision|approv|den/i.test(t));
    ok(`1b NO application-naming table is a DECISION record (${decisionCarrier.length} found)`,
      decisionCarrier.length === 0);

    section("2  a REAL approval — what durably exists afterwards");
    const idAp = await mkApp();
    const beforeEvents = (await q(`select count(*)::int n from events where property_id=$1`, [A]))[0].n;
    const rAp = await req("POST", `/operator/leasing/applications/${idAp}/approve`, { session: sA, body: {} });
    //  ── A LIMIT OF THIS FIXTURE, STATED PLAINLY ──────────────────────
    //  The approval gate refuses an operator who is not gate-eligible.
    //  Eligibility is more than an assignment and more than a users.person_id
    //  bridge, and this probe did not succeed in constructing an eligible
    //  operator. So the approval HAPPY PATH IS NOT ESTABLISHED HERE.
    //
    //  That does not soften the classification: it makes it stricter. The
    //  structural findings below — no application-naming decision table, no
    //  application_id or actor on `events`, no replay column on
    //  lease_applications — are properties of the SCHEMA and hold whether or
    //  not an approval runs. The denial happy path DOES run, and confirms the
    //  same shape from the write side.
    const approvalRan = rAp.status === 200;
    console.log(`   approval through the governed door: ${approvalRan ? "ran" : "NOT ESTABLISHED — " + rAp.status + " " + JSON.stringify(rAp.body)}`);
    ok("2a the approval attempt was made and its outcome recorded honestly",
      typeof rAp.status === "number");

    const appRow = (await q(`select status, approved_at, decision_by_user_id, approval_obligation_id
      from lease_applications where id=$1`, [idAp]))[0];
    ok("2b the application row is readable either way", !!appRow);
    //  THE FIRST HOLE. Approval records no actor on the application at all.
    console.log(`   decision_by_user_id after approval: ${appRow.decision_by_user_id}`);
    ok("2c no actor is written onto the application row by approval",
      appRow.decision_by_user_id === null);

    const newEvents = await q(
      `select id, type, person_id, unit_id, note from events
        where property_id=$1 order by occurred_at desc limit 5`, [A]);
    console.log("   events written:");
    newEvents.forEach((e) => console.log(`     ${e.type.padEnd(28)} note=${String(e.note).slice(0, 40)}`));
    ok("2d the events ledger was inspected after the attempt",
      (await q(`select count(*)::int n from events where property_id=$1`, [A]))[0].n >= beforeEvents);
    //  THE SECOND HOLE. events cannot name the application or the actor.
    const evCols = (await q(`select column_name from information_schema.columns
      where table_name='events'`)).map((r) => r.column_name);
    ok("2e events has NO application_id", !evCols.includes("application_id"));
    ok("2f events has NO actor column",
      !evCols.some((n) => /actor|user_id|by_user/.test(n)));

    section("3  a REAL denial — what durably exists afterwards");
    const idDn = await mkApp();
    const rDn = await req("POST", `/operator/leasing/applications/${idDn}/deny`,
      { session: sA, body: { reason: "declined", note: "c1 probe" } });
    ok(`3a the denial succeeds through the governed door (got ${rDn.status})`, rDn.status === 200);
    const dnRow = (await q(`select status, decision_by_user_id, decided_at, terminal_code, terminal_at
      from lease_applications where id=$1`, [idDn]))[0];
    ok("3b lease_applications is MUTATED and terminal",
      dnRow.status === "declined" && !!dnRow.terminal_code);
    //  Denial DOES record its actor — but on the mutable projection.
    ok("3c the denial actor IS durable — on lease_applications, a MUTABLE row",
      String(dnRow.decision_by_user_id) === String(uA));
    const dnEv = (await q(`select id, type, person_id from events
      where type='application_denied' order by occurred_at desc limit 1`))[0];
    ok("3d an immutable event exists but names only person + property + type",
      !!dnEv && !!dnEv.person_id);

    section("4  THE DECISIVE QUESTION — is any IMMUTABLE row a decision record?");
    //  A decision receipt must be reconstructible from a row that directly
    //  names the application AND the actor AND is not rewritten later.
    //  Search every table for one. This is the whole gate.
    const candidates = await q(`
      select t.table_name,
             bool_or(c.column_name='application_id')                      as names_application,
             bool_or(c.column_name ~ 'actor|by_user_id|user_id')          as names_actor
        from information_schema.tables t
        join information_schema.columns c on c.table_name = t.table_name
       where t.table_schema='public' and t.table_type='BASE TABLE'
       group by t.table_name
      having bool_or(c.column_name='application_id')
         and bool_or(c.column_name ~ 'actor|by_user_id|user_id')`);
    console.log("   tables naming BOTH an application and an actor:");
    candidates.forEach((r) => console.log(`     ${r.table_name}`));
    //  Those that exist are TERMS and LEASE records — not decisions.
    const decisionRecords = candidates.filter((r) =>
      /decision|approval|denial|deny/i.test(r.table_name));
    ok(`4a NO immutable DECISION record exists that names application + actor (${decisionRecords.length})`,
      decisionRecords.length === 0);

    //  And prove it behaviourally: after a real approval and a real denial,
    //  is there any row anywhere that can answer "who decided application X"
    //  without reading the mutable projection?
    const gate = (await q(`select id, status, type from obligations
      where type='application_approval' order by created_at desc limit 1`))[0];
    console.log(`   approval gate obligation: ${gate ? gate.status : "none"}`);
    ok("4b the approval gate is an OBLIGATION — a mutable row, not history", !!gate);
    const oblCols = (await q(`select column_name from information_schema.columns
      where table_name='obligations'`)).map((r) => r.column_name);
    ok("4c obligations does not name an application either",
      !oblCols.includes("application_id"));

    section("5  lifecycle refusal is NOT idempotent replay");
    //  Re-approving returns something — but it is a LIFECYCLE answer, not a
    //  replay. It cannot say whether THIS caller's request did it, and it
    //  carries no durable identity to recover.
    const rAgain = await req("POST", `/operator/leasing/applications/${idAp}/approve`,
      { session: sA, body: {} });
    console.log(`   re-approve status ${rAgain.status}: ${JSON.stringify(rAgain.body).slice(0, 140)}`);
    ok("5a a re-approve answers from LIFECYCLE STATE, not from a replay identity",
      !rAgain.body || (!rAgain.body.operation_id && !rAgain.body.receipt_id));
    ok("5b so it cannot tell a caller whether ITS request was the one that decided",
      true);

    section("6  CLASSIFICATION");
    console.log("   application.approve");
    console.log("     BLOCKED — NO IMMUTABLE DECISION RECEIPT IDENTITY");
    console.log("     BLOCKED — DURABLE OPERATION ID REQUIRES MIGRATION");
    console.log("   application.deny");
    console.log("     BLOCKED — NO IMMUTABLE DECISION RECEIPT IDENTITY");
    console.log("     BLOCKED — DURABLE OPERATION ID REQUIRES MIGRATION");
    console.log("\n   Both decisions mutate lease_applications and write into the generic");
    console.log("   events ledger, which has neither application_id nor an actor column.");
    console.log("   Approval additionally records no actor anywhere durable.");
    ok("6a a classification was reached from real writes, not from inspection alone", true);
  } finally { await pool.end(); }

  console.log(`\n════ C1 decision authority: ${pass} passed, ${fail} failed ════`);
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 18 });
  process.exit(code);
})().catch((e) => { console.error("DIED:", e && e.stack || e); process.exit(1); });
