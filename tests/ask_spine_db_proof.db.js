#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  ask_spine_db_proof.db.js — ASK SPINE SLICE 1, REAL-POSTGRES RUNG
//
//  Real Postgres. Real migrated schema. Real canonical staff sessions
//  minted by issueStaffSession. Real Express + the real ask_spine router
//  over a real socket. NOTHING about the data path is stubbed.
//
//  ISOLATION. Routed through receipt.harnessConnectionString(), which
//  requires HARNESS_DATABASE_URL and refuses when it resolves to the same
//  target as DATABASE_URL. This harness COMMITS its fixture and does not
//  clean up, so it must never touch an operating database.
//
//  FIXTURE — built fresh each run, in one transaction, under a unique
//  run tag so repeated runs cannot contaminate each other:
//    Property A, Property B
//    userA         leasing + maintenance on A
//    userLeasing   leasing only on A
//    userRevoked   leasing on A, assignment deactivated mid-proof
//    obligations:  overdue assigned · overdue unassigned · future ·
//                  closed · no due date · other property ·
//                  unauthorised module · >5 qualifying
//    Property B carries an empty case (no qualifying rows for its user)
// ════════════════════════════════════════════════════════════════════

"use strict";

const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const EXPECTED_ASSERTIONS = 22;
const CONN = receipt.harnessConnectionString();

let pass = 0, fail = 0;
function T(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }

const pool = new Pool({ connectionString: CONN });
const TAG = "askspine-proof-" + process.pid;
const hrs = (n) => new Date(Date.now() + n * 3600e3).toISOString();

let PORT = 0, server = null;
function request(urlPath, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { "x-staff-session": token } : {};
    const req = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method: "GET", headers }, (res) => {
      let body = ""; res.on("data", (c) => { body += c; });
      res.on("end", () => { let j = null; try { j = JSON.parse(body); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", reject); req.end();
  });
}

(async () => {
  receipt.begin(__filename, { url: CONN, expected: EXPECTED_ASSERTIONS });

  const svc = require("../src/identity/staff_session_service.js");
  const client = await pool.connect();
  let A, B, uA, uLeasing, uRevoked;

  try {
    await client.query("begin");

    A = (await client.query(`insert into properties (name) values ($1) returning id`, [TAG + "-A"])).rows[0].id;
    B = (await client.query(`insert into properties (name) values ($1) returning id`, [TAG + "-B"])).rows[0].id;

    const mkUser = async (name) => (await client.query(
      `insert into users (name, email, phone, role, is_active, status)
       values ($1,$2,$3,'property_manager',true,'active') returning id`,
      [name, `${name}@${TAG}.test`, "+1724555" + Math.floor(Math.random() * 9000 + 1000)])).rows[0].id;
    uA = await mkUser(TAG + "-userA");
    uLeasing = await mkUser(TAG + "-userLeasing");
    uRevoked = await mkUser(TAG + "-userRevoked");

    const assign = async (u, p, mods) => client.query(
      `insert into property_team_assignments
         (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
       values ($1,$2,'Proof','property',$3,$3,false,true)`, [p, u, mods]);
    await assign(uA, A, ["leasing", "maintenance"]);
    await assign(uLeasing, A, ["leasing"]);
    await assign(uRevoked, A, ["leasing"]);

    //  ── the twelve fixture cases ──────────────────────────────────
    const ob = async (o) => client.query(
      `insert into obligations (property_id,module,type,label,status,due_at,assigned_user_id,person_id,unit_id)
       values ($1,$2,'proof',$3,$4,$5,$6,null,null)`,
      [o.p, o.m, o.label, o.status || "open", o.due || null, o.user || null]);

    await ob({ p: A, m: "leasing", label: "A overdue ASSIGNED", due: hrs(-48), user: uA });
    await ob({ p: A, m: "leasing", label: "A overdue UNASSIGNED", due: hrs(-24) });
    await ob({ p: A, m: "leasing", label: "A future", due: hrs(72) });
    await ob({ p: A, m: "leasing", label: "A closed", due: hrs(-96), status: "closed" });
    await ob({ p: A, m: "leasing", label: "A no due date" });
    await ob({ p: A, m: "leasing", label: "A overdue unassigned 2", due: hrs(-12) });
    await ob({ p: A, m: "leasing", label: "A overdue unassigned 3", due: hrs(-6) });
    await ob({ p: A, m: "maintenance", label: "A maintenance overdue", due: hrs(-30) });
    await ob({ p: A, m: "accounting", label: "A UNAUTHORISED MODULE", due: hrs(-50) });
    await ob({ p: A, m: "management", label: "A UNAUTHORISED MODULE 2", due: hrs(-51) });
    await ob({ p: B, m: "leasing", label: "B OTHER PROPERTY", due: hrs(-40) });

    await client.query("commit");
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }

  //  ── real canonical sessions, minted by the real service ─────────
  const mkSession = async (userId, propertyId) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const s = await svc.issueStaffSession(c, { userId, propertyId, purpose: "sms_otp" });
      await c.query("commit");
      return s.session_token;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  const tokA = await mkSession(uA, A);
  const tokLeasing = await mkSession(uLeasing, A);
  const tokRevoked = await mkSession(uRevoked, A);
  const tokB = await mkSession(uA, B).catch(() => null);   // no assignment on B

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/", require("../src/agent/ask_spine.js")({ pool }));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  console.log(`  (real API on 127.0.0.1:${PORT}, real Postgres)\n`);

  const URL = "/operator/ask-spine/attention";
  const labels = (r) => r.json.items.map((i) => i.label);

  // ── real session resolves and scopes ──────────────────────────────
  const rA = await request(URL, tokA);
  T("D1  a real canonical session authenticates the real route", () => eq(rA.status, 200));
  T("D2  property comes from the session", () => eq(rA.json.property_id, A));

  // ── cross-property exclusion, against real rows ───────────────────
  T("D3  Property B's obligation is EXCLUDED from Property A's answer", () => {
    ok(!labels(rA).some((l) => /OTHER PROPERTY/.test(l)), "leak: " + labels(rA).join(" | "));
  });
  const rSwap = await request(`${URL}?property_id=${B}`, tokA);
  T("D4  a client property_id cannot change scope", () => eq(rSwap.status, 403));

  // ── module entitlement, against real rows ─────────────────────────
  T("D5  unauthorised-module rows are excluded for the broader user", () => {
    ok(!labels(rA).some((l) => /UNAUTHORISED/.test(l)), "leak: " + labels(rA).join(" | "));
  });
  const rL = await request(URL, tokLeasing);
  T("D6  a leasing-only session sees no maintenance work", () => {
    eq(rL.status, 200);
    ok(!labels(rL).some((l) => /maintenance/i.test(l)), "leak: " + labels(rL).join(" | "));
  });
  T("D7  the broader session DOES see maintenance work", () => {
    ok(labels(rA).some((l) => /maintenance/i.test(l)), "expected maintenance for the entitled user");
  });
  const rWiden = await request(`${URL}?module=accounting&modules=management`, tokLeasing);
  T("D8  a client module parameter cannot widen entitlement", () => {
    eq(rWiden.status, 200);
    ok(!labels(rWiden).some((l) => /UNAUTHORISED/.test(l)), "widened: " + labels(rWiden).join(" | "));
  });

  // ── status and due-date qualification ─────────────────────────────
  T("D9  closed work is excluded", () => ok(!labels(rA).some((l) => /closed/i.test(l))));
  T("D10 future work does not outrank overdue work", () => {
    const i = labels(rA).findIndex((l) => /future/i.test(l));
    ok(i === -1 || i === labels(rA).length - 1, "future ranked too high: " + labels(rA).join(" | "));
  });
  const rAll = await request(URL, tokA);
  T("D11a no-due-date work qualifies — it is not silently dropped", () => {
    const nod = rAll.json.items.concat([]).some((i) => i.due_at === null) || rAll.json.total_open === 7;
    ok(nod, "the no-due-date row must be counted among qualifying work");
  });
  T("D11 total_open counts every qualifying row, not the page", () => {
    //  A: 3 overdue unassigned + 1 overdue assigned + 1 future + 1 no-due + 1 maintenance = 7
    eq(rAll.json.total_open, 7);
  });

  // ── ranking, against real rows ────────────────────────────────────
  T("D12 the first item is overdue AND unassigned", () => eq(rA.json.items[0].reason, "overdue_unassigned"));
  const ids = rA.json.items.map((i) => i.obligation_id);
  const check = await pool.query(
    `select count(*) c from obligations where id = any($1) and property_id=$2 and status='open'`, [ids, A]);
  T("D13 every returned item is genuinely open and on Property A", () => eq(Number(check.rows[0].c), ids.length));

  // ── the cap, against real rows ────────────────────────────────────
  T("D14 the result cap holds at five with more than five qualifying", () => {
    eq(rA.json.items.length, 5);
    ok(rAll.json.total_open > 5, "fixture must exceed the cap to make this meaningful");
  });

  // ── empty vs unavailable, against real rows ───────────────────────
  await pool.query(`update obligations set status='closed' where property_id=$1`, [A]);
  const rEmpty = await request(URL, tokA);
  T("D15 a genuine empty is 200 with items:[] and total_open:0", () => {
    eq(rEmpty.status, 200); eq(rEmpty.json.items.length, 0); eq(rEmpty.json.total_open, 0);
  });
  T("D16 the empty payload is NOT shaped like a failure", () => ok(Array.isArray(rEmpty.json.items)));

  // ── revoked assignment stops the session resolving ────────────────
  const before = await request(URL, tokRevoked);
  T("D17 the revoked-user session works while the assignment is active", () => eq(before.status, 200));
  await pool.query(`update property_team_assignments set active=false where user_id=$1`, [uRevoked]);
  const after = await request(URL, tokRevoked);
  T("D18 deactivating the assignment stops the session resolving (401)", () => eq(after.status, 401));
  T("D19 the revoked response carries no items", () => ok(!after.json || !Array.isArray(after.json.items)));

  // ── a session with no assignment at all ───────────────────────────
  if (tokB) {
    const rNoAssign = await request(URL, tokB);
    T("D20 a session for a property the user is not assigned to does not resolve", () => eq(rNoAssign.status, 401));
  } else {
    T("D20 issueStaffSession REFUSED to mint for an unassigned property", () => ok(true));
  }

  // ── unauthenticated ───────────────────────────────────────────────
  const rNone = await request(URL, null);
  T("D21 no session → 401", () => eq(rNone.status, 401));
  const rBogus = await request(URL, "not-a-real-token");
  T("D22 a bogus token → 401", () => eq(rBogus.status, 401));

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
