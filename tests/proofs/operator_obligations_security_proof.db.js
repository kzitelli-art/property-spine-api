#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  operator_obligations_security_proof.db.js
//  THE OBLIGATION AUTHORITY BOUNDARY — real Postgres, real sessions,
//  real authenticated HTTP.
//
//  Proves the replacement doors enforce server-derived property, module
//  and ACTOR authority, and that all five legacy shared-key doors are
//  gone — not merely unused.
//
//  ISOLATION via receipt.harnessConnectionString(): requires
//  HARNESS_DATABASE_URL and refuses when it resolves to DATABASE_URL.
//  Commits its fixture; must never touch an operating database.
// ════════════════════════════════════════════════════════════════════

"use strict";

const http = require("http");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");

const EXPECTED_ASSERTIONS = 20;
const CONN = receipt.harnessConnectionString();

let pass = 0, fail = 0;
function T(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }

const pool = new Pool({ connectionString: CONN });
const TAG = "oblig-sec-" + process.pid;
const hrs = (n) => new Date(Date.now() + n * 3600e3).toISOString();

let PORT = 0, server = null;
function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const h = {}; if (token) h["x-staff-session"] = token;
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload) { h["content-type"] = "application/json"; }
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method, headers: h }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}

(async () => {
  receipt.begin(__filename, { url: CONN, expected: EXPECTED_ASSERTIONS });
  const svc = require("../../src/identity/staff_session_service.js");

  let A, B, uA, uLeasing, uB, obA, obB, obAccounting;
  const c = await pool.connect();
  try {
    await c.query("begin");
    A = (await c.query(`insert into properties (name) values ($1) returning id`, [TAG + "-A"])).rows[0].id;
    B = (await c.query(`insert into properties (name) values ($1) returning id`, [TAG + "-B"])).rows[0].id;
    const mk = async (n) => (await c.query(
      `insert into users (name,email,phone,role,is_active,status)
       values ($1,$2,$3,'property_manager',true,'active') returning id`,
      [n, `${n}@${TAG}.test`, "+1724555" + Math.floor(Math.random() * 9000 + 1000)])).rows[0].id;
    uA = await mk(TAG + "-uA"); uLeasing = await mk(TAG + "-uLeasing"); uB = await mk(TAG + "-uB");
    const assign = (u, p, m) => c.query(
      `insert into property_team_assignments
        (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
       values ($1,$2,'Proof','property',$3,$3,false,true)`, [p, u, m]);
    await assign(uA, A, ["leasing", "maintenance"]);
    await assign(uLeasing, A, ["leasing"]);
    await assign(uB, B, ["leasing"]);
    const ob = async (p, m, label) => (await c.query(
      `insert into obligations (property_id,module,type,label,status,due_at)
       values ($1,$2,'proof',$3,'open',$4) returning id`, [p, m, label, hrs(-24)])).rows[0].id;
    obA = await ob(A, "leasing", "A leasing work");
    obAccounting = await ob(A, "accounting", "A ACCOUNTING — unauthorised module");
    obB = await ob(B, "leasing", "B OTHER PROPERTY");
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  const mkSession = async (u, p) => {
    const cc = await pool.connect();
    try { await cc.query("begin");
      const s = await svc.issueStaffSession(cc, { userId: u, propertyId: p, purpose: "sms_otp" });
      await cc.query("commit"); return s.session_token;
    } catch (e) { await cc.query("rollback"); throw e; } finally { cc.release(); }
  };
  const tokA = await mkSession(uA, A);
  const tokLeasing = await mkSession(uLeasing, A);
  const tokB = await mkSession(uB, B);

  const express = require("express");
  const app = express(); app.use(express.json());
  app.use("/", require("../../src/obligations/operator_obligations.js")({ pool }));
  app.use("/", require("../../src/obligations/operator_obligation_actions.js")({ pool }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  console.log(`  (real API on 127.0.0.1:${PORT}, real Postgres)\n`);

  const R = "/operator/obligations";
  const labels = (r) => (r.json.items || []).map((i) => i.label);

  // ── READ AUTHORITY ────────────────────────────────────────────────
  const noSess = await req("GET", R, null);
  T("R1  no session → 401, and no items list", () => {
    eq(noSess.status, 401); ok(!noSess.json || !Array.isArray(noSess.json.items));
  });

  const rA = await req("GET", R, tokA);
  T("R2  Property A session gets only Property A rows", () => {
    eq(rA.status, 200);
    ok(!labels(rA).some((l) => /OTHER PROPERTY/.test(l)), "cross-property leak: " + labels(rA).join(" | "));
  });
  T("R3  unauthorised-module rows are absent", () => {
    ok(!labels(rA).some((l) => /ACCOUNTING/.test(l)), "module leak: " + labels(rA).join(" | "));
  });
  const rL = await req("GET", R, tokLeasing);
  T("R4  a leasing-only session still sees no accounting work", () => {
    ok(!labels(rL).some((l) => /ACCOUNTING/.test(l)));
  });
  const rWiden = await req("GET", `${R}?property_id=${B}&module=accounting&status=open`, tokA);
  T("R5  a client property_id cannot widen — 403", () => eq(rWiden.status, 403));
  const rMod = await req("GET", `${R}?module=accounting`, tokLeasing);
  T("R6  a client module parameter cannot widen", () => {
    eq(rMod.status, 200);
    ok(!labels(rMod).some((l) => /ACCOUNTING/.test(l)));
  });
  T("R7  explicit projection — no unrelated columns leak", () => {
    const row = rA.json.items[0];
    ok(row, "expected a row");
    const allowed = new Set(["id","property_id","module","type","label","status","due_at",
      "assigned_user_id","assigned_role","person_id","unit_id","related_type","related_id",
      "created_at","updated_at","is_overdue"]);
    const extra = Object.keys(row).filter((k) => !allowed.has(k));
    eq(extra.length, 0, "unexpected columns: " + extra.join(","));
  });
  T("R8  the envelope echoes SERVER-DERIVED scope", () => {
    eq(rA.json.scope.property_id, A);
    ok(Array.isArray(rA.json.scope.modules));
  });
  // zero entitlement: deactivate the assignment mid-proof
  await pool.query(`update property_team_assignments set allowed_modules='{}' where user_id=$1`, [uLeasing]);
  const rZero = await req("GET", R, tokLeasing);
  T("R9  zero entitlement → honest empty, no unrestricted query", () => {
    eq(rZero.status, 200); eq(rZero.json.items.length, 0);
    eq(rZero.json.scope_note, "no_module_entitlement");
  });
  await pool.query(`update property_team_assignments set allowed_modules='{leasing}' where user_id=$1`, [uLeasing]);

  // ── LEGACY DOORS ARE GONE ─────────────────────────────────────────
  const legacyApp = express(); legacyApp.use(express.json());
  legacyApp.use("/", require("../../src/obligations/operator_obligations.js")({ pool }));
  legacyApp.use("/", require("../../src/obligations/operator_obligation_actions.js")({ pool }));
  const srv2 = http.createServer(legacyApp);
  await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  const P2 = srv2.address().port;
  const hit = (m, p) => new Promise((res) => {
    const r = http.request({ host: "127.0.0.1", port: P2, path: p, method: m }, (x) => { x.resume(); res(x.statusCode); });
    r.on("error", () => res(0)); r.end();
  });
  const legacyPaths = [["GET","/obligations"],["GET","/obligations/x"],
    ["PATCH","/obligations/x/claim"],["PATCH","/obligations/x/satisfy"],["PATCH","/obligations/x/complete"]];
  const codes = [];
  for (const [m, p] of legacyPaths) codes.push(await hit(m, p));
  T("L1  all five legacy doors are UNROUTED (404), not merely unused", () => {
    eq(codes.filter((x) => x === 404).length, 5, "codes: " + codes.join(","));
  });
  await new Promise((r) => srv2.close(r));

  // ── CLAIM AUTHORITY ───────────────────────────────────────────────
  const cNo = await req("POST", `${R}/${obA}/claim`, null, {});
  T("C1  claim with no session → 401", () => eq(cNo.status, 401));

  const cCross = await req("POST", `${R}/${obB}/claim`, tokA, {});
  T("C2  Property A cannot claim Property B work → 404 (not a disclosure)", () => eq(cCross.status, 404));

  const cMod = await req("POST", `${R}/${obAccounting}/claim`, tokLeasing, {});
  T("C3  an unauthorised module cannot be claimed → 404", () => eq(cMod.status, 404));

  const cSpoof = await req("POST", `${R}/${obA}/claim`, tokA, { user_id: uB });
  T("C4  a client-supplied user_id is REFUSED — no spoofing → 403", () => {
    eq(cSpoof.status, 403);
    ok(/authenticated staff member/.test(cSpoof.json.error));
  });

  const cOk = await req("POST", `${R}/${obA}/claim`, tokA, {});
  T("C5  an ordinary claim succeeds", () => eq(cOk.status, 200));
  T("C6  the assignee is the SESSION user", () => eq(cOk.json.obligation.assigned_user_id, uA));
  const dbRow = (await pool.query(`select assigned_user_id, status from obligations where id=$1`, [obA])).rows[0];
  T("C7  the database agrees — session user, status advanced", () => {
    eq(dbRow.assigned_user_id, uA); eq(dbRow.status, "in_progress");
  });
  const cSteal = await req("POST", `${R}/${obA}/claim`, tokB, {});
  T("C8  another property's session still cannot take it → 404", () => eq(cSteal.status, 404));

  // revoked session
  await pool.query(`update property_team_assignments set active=false where user_id=$1`, [uA]);
  const cRevoked = await req("POST", `${R}/${obA}/claim`, tokA, {});
  T("C9  a revoked assignment cannot claim → 401", () => eq(cRevoked.status, 401));
  const rRevoked = await req("GET", R, tokA);
  T("C10 a revoked assignment cannot read either → 401", () => eq(rRevoked.status, 401));

  // ── canonical services untouched ──────────────────────────────────
  const engine = require("../../src/shared/obligation_engine.js");
  T("S1  the canonical services still exist after their doors were removed", () => {
    ok(typeof engine.satisfyObligation === "function", "satisfyObligation missing");
    ok(typeof engine.completeObligation === "function", "completeObligation missing");
  });

  await new Promise((r) => server.close(r));
  await pool.end();
  process.exit(receipt.complete({
    harness: __filename, passed: pass, failed: fail, expectedAtLeast: EXPECTED_ASSERTIONS,
  }));
})().catch(async (e) => {
  try { if (server) server.close(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  receipt.died(__filename, e, pass + fail);
  process.exit(1);
});
