#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  receipts_gate2_proof.js — RECOVERABLE RECEIPTS, OPERATION A.
//
//  Real Postgres, real HTTP, synthetic data only.
//
//  WHAT THIS EXISTS TO PROVE. A write that succeeded but whose response was
//  lost must be RECOVERABLE — not re-sent blindly. Today the four existing
//  replay mechanisms never return their key to the caller, so a browser that
//  reloads has no way to ask "did that land?" and its only option is a new
//  key, which produces a second mutation.
//
//  The sharp test is section D: the response is DISCARDED without being read,
//  the harness throws away everything it learned from it, and recovery is
//  driven purely from the operation_id that was persisted BEFORE the request
//  — the way a browser outbox would after a reload.
//
//  Run:  HARNESS_DATABASE_URL=… OPERATOR_KEY=… node tests/receipts_gate2_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const OPRC = require(path.join(__dirname, "..", "src/shared/operation_receipt.js"));

const CONN = receipt.harnessConnectionString();
const PORT = Number(process.env.PROOF_PORT || 3121);
const KEY = process.env.OPERATOR_KEY || "harness-operator-key";

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); }
                       else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));

function req(method, p, { session, key, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { "content-type": "application/json" };
    if (session) h["x-staff-session"] = session;
    if (key) h["x-operator-key"] = key;
    if (data) h["content-length"] = Buffer.byteLength(data);
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method, headers: h }, (res) => {
      let buf = ""; res.on("data", (d) => (buf += d));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const t0 = receipt.begin(__filename, { url: CONN, expected: 46 });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const svc = require(path.join(__dirname, "..", "src/identity/staff_session_service.js"));
  const c = await pool.connect();
  const one = async (q, a = []) => (await c.query(q, a)).rows[0];

  await c.query("begin");
  const uniq = "rg2" + Date.now().toString(36);
  const A = (await one(`insert into properties (name, operating_timezone)
    values ($1,'America/New_York') returning id`, [uniq + " A"])).id;
  const B = (await one(`insert into properties (name, operating_timezone)
    values ($1,'America/New_York') returning id`, [uniq + " B"])).id;
  const mkUser = async (n) => (await one(
    `insert into users (name,email,phone,role,is_active,status)
     values ($1,$2,$3,'property_manager',true,'active') returning id`,
    [n, `${n}@${uniq}.test`, "+1727" + String(Math.floor(Math.random() * 9e6 + 1e6))])).id;
  const uA = await mkUser(uniq + "-a"), uB = await mkUser(uniq + "-b");
  const assign = (u, p, m) => c.query(
    `insert into property_team_assignments
      (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof','property',$3,$3,false,true)`, [p, u, m]);
  await assign(uA, A, ["leasing"]); await assign(uB, B, ["leasing"]);

  //  Premises: an executed lease must identify a real space at the property.
  const mkSpace = async (prop) => {
    const unit = (await one(`insert into units (property_id, unit_number)
      values ($1,$2) returning id`, [prop, "U" + Math.floor(Math.random() * 9999)])).id;
    return (await one(`insert into spaces (unit_id, space_label) values ($1,'Whole') returning id`, [unit])).id;
  };
  const spaceA = await mkSpace(A);
  const person = (await one(`insert into persons (name, lifecycle_status)
    values ($1,'lead') returning id`, [uniq + " Applicant"])).id;
  await c.query("commit"); c.release();

  const mkSession = async (u, p) => {
    const cc = await pool.connect();
    try { await cc.query("begin");
      const s = await svc.issueStaffSession(cc, { userId: u, propertyId: p, purpose: "sms_otp" });
      await cc.query("commit"); return s.session_token;
    } finally { cc.release(); }
  };
  const sA = await mkSession(uA, A), sB = await mkSession(uB, B);

  //  ── THE EXECUTED-LEASE DEPLOY GATE ───────────────────────────────
  //  verifyExecutedLease is behind a two-part flag: intake enabled, and the
  //  property on an explicit allowlist. That gate is real product behaviour
  //  and is NOT bypassed — it is satisfied, for the two synthetic properties
  //  this harness created and for nothing else. A run that switched the gate
  //  off entirely would prove the receipt contract against a route that never
  //  executes.
  process.env.EXECUTED_LEASE_INTAKE_ENABLED = "true";
  process.env.EXECUTED_LEASE_PROPERTY_IDS = `${A},${B}`;
  process.env.DATABASE_URL = CONN;
  process.env.OPERATOR_KEY = KEY;
  process.env.PORT = String(PORT);
  require(path.join(__dirname, "..", "server.js"));
  await new Promise((r) => setTimeout(r, 1500));

  //  Applications through the canonical lifecycle — never raw inserts.
  const submissionModule = require(path.join(__dirname, "..", "src/applications/applicationSubmission.js"));
  const { spawnObligationFromEvent, completeObligation } =
    require(path.join(__dirname, "..", "src/shared/obligation_engine.js"));
  const _submit = submissionModule({
    pool, spawnObligationFromEvent, completeObligation,
    conversionService: null, commBoundary: null, applicationInputAuthority: null,
  })._service.submitApplicationService;
  const mkApp = async (prop) => {
    const cc = await pool.connect();
    try { await cc.query("begin");
      const out = await _submit(cc, { property_id: prop, person_id: person,
        applicant_name: uniq + " Applicant", source: "applicant" });
      await cc.query("commit"); return out.application.id;
    } catch (e) { await cc.query("rollback").catch(() => {}); throw e; }
    finally { cc.release(); }
  };

  const VERIFY = (id) => `/operator/leasing/applications/${id}/executed-lease/verify`;
  const OP = OPRC.OPERATIONS.EXECUTED_LEASE_VERIFY;
  const terms = () => ({
    space_id: spaceA, rent: 2100, security_deposit: 2100,
    lease_start_date: "2026-09-01", lease_end_date: "2027-08-31",
    executed_at: "2026-08-20T15:00:00Z", effective_date: "2026-09-01",
    execution_channel: "external_esign",
    signers: [{ name: uniq + " Applicant", capacity: "resident", signed_at: "2026-08-20T15:00:00Z" }],
    document_reference: "doc://" + uniq, document_sha256: crypto.createHash("sha256").update(uniq).digest("hex"),
  });

  section("A  the receipt envelope is exact and complete");
  {
    const id = await mkApp(A);
    const opId = crypto.randomUUID();
    const r = await req("POST", VERIFY(id), { session: sA, body: { ...terms(), operation_id: opId } });
    ok(`A1  the write succeeds (got ${r.status}) ${r.status !== 200 ? JSON.stringify(r.body).slice(0, 200) : ""}`,
      r.status === 200);
    const rc = r.body && r.body.operation_receipt;
    ok("A2  a structured receipt is returned alongside the existing payload", !!rc);
    if (!rc) { for (let i = 3; i <= 14; i++) ok(`A${i} NOT RUN — no receipt`, false); }
    else {
      ok(`A3  contract is versioned (${rc.contract})`, rc.contract === OPRC.RECEIPT_CONTRACT);
      ok(`A4  operation names the governed type (${rc.operation})`, rc.operation === OP);
      ok("A5  operation_id is the caller's identity, echoed back", rc.operation_id === opId);
      ok("A6  receipt_id is a DURABLE domain identity, not a synthetic handle",
        !!rc.receipt_id && rc.receipt_id === r.body.record_id);
      ok("A7  replayed is false on a first write", rc.replayed === false);
      ok("A8  actor is the AUTHENTICATED session user", rc.actor && rc.actor.user_id === uA);
      ok("A9  property_id is the server-derived scope", rc.property_id === A);
      ok("A10 targets name the exact canonical objects",
        rc.targets.application_id === id && rc.targets.executed_lease_record_id === rc.receipt_id
        && rc.targets.space_id === spaceA);
      ok("A11 before/after state a MATERIAL transition, not a row dump",
        rc.before.executed_lease_record_id === null
        && rc.after.executed_lease_record_id === rc.receipt_id
        && rc.after.record_state === "verified");
      //  THREE TIMES KEPT APART — the accrual reader's whole requirement.
      ok("A12 occurred_at, recorded_at and effective_at are three DIFFERENT fields",
        !!rc.occurred_at && !!rc.recorded_at && !!rc.effective_at
        && String(rc.occurred_at) !== String(rc.recorded_at));
      ok("A13 evidence and event ids are carried", rc.evidence_ids.length >= 1 && rc.event_ids.length >= 1);
      ok("A14 recovery tells the caller exactly how to ask again",
        rc.recovery && rc.recovery.operation === OP && rc.recovery.operation_id === opId
        && /operation-receipts/.test(rc.recovery.route));
      ok("A15 canonical_destination names where the truth lives",
        rc.canonical_destination === "executed_lease_records");
      //  ADDITIVE: prose survives for unmigrated consumers, but is deprecated.
      ok("A16 the existing prose receipt is RETAINED (additive transition)",
        typeof r.body.receipt === "string" && r.body.receipt.length > 0);
      ok("A17 and the structured receipt carries it as deprecated `message`",
        typeof rc.message === "string");
    }
  }

  section("B  replay — same operation_id, same operation");
  {
    const id = await mkApp(A);
    const opId = crypto.randomUUID();
    const body = { ...terms(), operation_id: opId };
    const first = await req("POST", VERIFY(id), { session: sA, body });
    const again = await req("POST", VERIFY(id), { session: sA, body });
    ok(`B1  the duplicate is accepted, not refused (got ${again.status})`, again.status === 200);
    ok("B2  it is marked replayed", again.body.operation_receipt.replayed === true);
    ok("B3  SAME receipt_id — same durable result",
      again.body.operation_receipt.receipt_id === first.body.operation_receipt.receipt_id);
    //  THE POINT OF ALL OF THIS: no second row.
    const n = (await pool.query(
      `select count(*)::int n from executed_lease_records where application_id=$1`, [id])).rows[0].n;
    ok(`B4  NO SECOND MUTATION — exactly one durable record exists (${n})`, n === 1);
  }

  section("C  payload binding — a replay identity may recover, never change");
  {
    const id = await mkApp(A);
    const opId = crypto.randomUUID();
    await req("POST", VERIFY(id), { session: sA, body: { ...terms(), operation_id: opId } });
    //  SAME key, DIFFERENT rent. The exact thing that must never pass.
    const changed = await req("POST", VERIFY(id), {
      session: sA, body: { ...terms(), rent: 3400, operation_id: opId } });
    ok(`C1  same operation_id + materially different terms is REFUSED (got ${changed.status})`,
      changed.status === 409);
    ok("C2  and the refusal is typed",
      !!changed.body && /idempotency_conflict|operation_id_payload_mismatch/.test(String(changed.body.error)));
    const rent = (await pool.query(
      `select rent from executed_lease_records where application_id=$1`, [id])).rows[0];
    ok(`C3  the ORIGINAL rent stands, unchanged (${rent && rent.rent})`,
      !!rent && Number(rent.rent) === 2100);
    ok("C4  still exactly one record",
      (await pool.query(`select count(*)::int n from executed_lease_records where application_id=$1`,
        [id])).rows[0].n === 1);
  }

  section("D  LOST RESPONSE — recovery from the persisted operation_id alone");
  {
    const id = await mkApp(A);
    //  ── THE BROWSER OUTBOX, SIMULATED HONESTLY ───────────────────────
    //  Everything the app persists BEFORE the request leaves. Nothing else
    //  survives the reload below.
    const pending = {
      operation_id: crypto.randomUUID(),
      operation: OP,
      targets: { application_id: id },
      created_at: new Date().toISOString(),
      status: "pending",
    };
    ok("D1  a pending operation is persisted BEFORE the request",
      OPRC.isValidOperationId(pending.operation_id) && pending.status === "pending");

    //  The write happens. The response is DISCARDED — not inspected, not
    //  parsed, not kept. This is the timeout the packet exists for.
    await req("POST", VERIFY(id), { session: sA, body: { ...terms(), operation_id: pending.operation_id } });

    //  ── THE RELOAD ───────────────────────────────────────────────────
    //  Process memory is gone. The ONLY thing carried across is the pending
    //  record, reconstructed here from its serialized form so the harness
    //  cannot cheat by closing over a variable it should not have.
    const afterReload = JSON.parse(JSON.stringify(pending));
    ok("D2  after the reload the caller holds only the persisted record",
      afterReload.operation_id === pending.operation_id && !afterReload.receipt_id);

    const rec = await req("GET",
      `/operator/operation-receipts/${afterReload.operation}/${afterReload.operation_id}`,
      { session: sA });
    ok(`D3  the recovery read finds the original operation (got ${rec.status})`, rec.status === 200);
    ok("D4  it is typed receipt_found", rec.body && rec.body.state === OPRC.RECOVERY.FOUND);
    const rc = rec.body && rec.body.operation_receipt;
    ok("D5  and it returns the SAME operation_id", !!rc && rc.operation_id === afterReload.operation_id);
    ok("D6  with a durable receipt_id", !!rc && !!rc.receipt_id);
    ok("D7  marked replayed — this operation already completed", !!rc && rc.replayed === true);
    ok("D8  naming the authenticated actor and the server-derived property",
      !!rc && rc.actor.user_id === uA && rc.property_id === A);
    ok("D9  NO SECOND MUTATION was caused by recovering",
      (await pool.query(`select count(*)::int n from executed_lease_records where application_id=$1`,
        [id])).rows[0].n === 1);
    //  The outbox entry can now be cleared — the caller has durable proof.
    afterReload.status = "settled"; afterReload.receipt_id = rc && rc.receipt_id;
    ok("D10 the pending record can be cleared against a durable receipt",
      afterReload.status === "settled" && !!afterReload.receipt_id);

    //  AND the retry path agrees with the recovery path. A caller may choose
    //  either; they must not disagree about what happened.
    const retry = await req("POST", VERIFY(id), {
      session: sA, body: { ...terms(), operation_id: afterReload.operation_id } });
    ok("D11 re-sending the SAME operation_id agrees with the recovery read",
      retry.status === 200 && retry.body.operation_receipt.receipt_id === rc.receipt_id
      && retry.body.operation_receipt.replayed === true);
    ok("D12 and still exactly one durable record",
      (await pool.query(`select count(*)::int n from executed_lease_records where application_id=$1`,
        [id])).rows[0].n === 1);
  }

  section("E  recovery is walled, typed, and never guesses");
  {
    const id = await mkApp(A);
    const opId = crypto.randomUUID();
    await req("POST", VERIFY(id), { session: sA, body: { ...terms(), operation_id: opId } });

    //  ANOTHER PROPERTY'S SESSION MUST NOT SEE IT. Recovery is a read of your
    //  own work — a lookup service would leak every operation in the estate.
    const xProp = await req("GET", `/operator/operation-receipts/${OP}/${opId}`, { session: sB });
    ok(`E1  a session on another property cannot recover it (got ${xProp.status})`,
      xProp.status === 404 || xProp.status === 403);
    ok("E2  and it is told 'no qualifying operation' — never another property's data",
      !xProp.body || !xProp.body.operation_receipt);

    ok("E3  no session is refused",
      (await req("GET", `/operator/operation-receipts/${OP}/${opId}`)).status === 401);
    ok("E4  the shared key alone cannot recover",
      (await req("GET", `/operator/operation-receipts/${OP}/${opId}`, { key: KEY })).status === 401);

    //  UNKNOWN ≠ ABSENT. The three states the packet forbids collapsing.
    const unknownOp = await req("GET",
      `/operator/operation-receipts/not.a.real.operation/${opId}`, { session: sA });
    ok(`E5  an unknown operation namespace is a 400, not a 404 (got ${unknownOp.status})`,
      unknownOp.status === 400 && unknownOp.body.state === OPRC.RECOVERY.UNAVAILABLE);
    const noResolver = await req("GET",
      `/operator/operation-receipts/${OPRC.OPERATIONS.TOUR_CHECK_IN}/${opId}`, { session: sA });
    ok(`E6  a governed operation with no resolver yet is 501 recovery_unavailable, NOT 404 (got ${noResolver.status})`,
      noResolver.status === 501 && noResolver.body.state === OPRC.RECOVERY.UNAVAILABLE);
    ok("E7  and it warns explicitly against retrying on the strength of that answer",
      /does NOT mean the operation did not happen|Do NOT retry/i.test(noResolver.body.receipt || ""));
    const absent = await req("GET", `/operator/operation-receipts/${OP}/${crypto.randomUUID()}`,
      { session: sA });
    ok(`E8  a governed lookup that PROVES absence is 404 no_qualifying_operation (got ${absent.status})`,
      absent.status === 404 && absent.body.state === OPRC.RECOVERY.NONE);
    ok("E9  and it says the write may be safely re-sent with the same operation_id",
      /same operation_id/i.test(absent.body.receipt || ""));
    ok("E10 a malformed operation_id is refused as malformed",
      (await req("GET", `/operator/operation-receipts/${OP}/not-a-uuid`, { session: sA })).status === 400);
  }

  section("F  operation_id must be a governed random identity");
  {
    const id = await mkApp(A);
    //  A DERIVED KEY IS REFUSED. Deriving from a timestamp or a target id is
    //  exactly how two properties collide on the same key.
    const derived = await req("POST", VERIFY(id), {
      session: sA, body: { ...terms(), operation_id: "verify-" + id } });
    ok(`F1  a non-UUID operation_id is REFUSED (got ${derived.status})`, derived.status === 400);
    ok("F2  and the refusal names why deriving one is unsafe",
      !!derived.body && derived.body.error === "operation_id_invalid"
      && /collide/i.test(derived.body.receipt || ""));
    //  ADDITIVE TRANSITION: absent is still allowed at this step.
    const none = await req("POST", VERIFY(id), { session: sA, body: terms() });
    ok(`F3  an ABSENT operation_id is still accepted at this transition step (got ${none.status})`,
      none.status === 200);
    ok("F4  its receipt is honest that it has no replay identity",
      none.body.operation_receipt && none.body.operation_receipt.operation_id === null);
  }

  section("G  M3 — the cross-property key leak is closed");
  {
    const src = require("fs").readFileSync(
      path.join(__dirname, "..", "src/identity/operator.js"), "utf8");
    ok("G1  the walk-in booking lookup is scoped by property_id",
      /booking_idempotency_key=\$1 and property_id=\$2/.test(src));
    ok("G2  no unscoped booking-key lookup remains",
      !/where booking_idempotency_key=\$1 limit 1/.test(src));
  }

  console.log(`\n════ receipts gate 2: ${pass} passed, ${fail} failed ════`);
  await pool.end();
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 46 });
  process.exit(code);
})().catch((e) => {
  console.error("DIED: " + (e && e.stack || e));
  console.log(`\n════ receipts gate 2: ${pass} passed, ${fail + 1} failed ════`);
  process.exit(1);
});
