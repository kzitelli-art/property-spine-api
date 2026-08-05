// ════════════════════════════════════════════════════════════════════
//  work_order_authority_proof.js — THE AUTHORITY SEAM
//
//    authenticated staff session
//      → server-derived property
//        → maintenance module entitlement
//          → canonical work-order service
//
//  WHAT THIS PROTECTS
//  ------------------
//  The maintenance module had no authority seam at all. POST /work-orders
//  took property_id from the request BODY, and GET /work-orders took it from
//  the QUERY STRING, both behind the shared x-operator-key server-to-server
//  gate — so one key read and wrote any building in the portfolio. §21 says
//  the browser may request an action but may not determine authority, and a
//  client-provided property ID is never authority. It was.
//
//  /operator/work-orders is the signed-in human's door. property_id comes
//  from the SESSION — staff_sessions joined live to property_team_assignments
//  on every single request — and a conflicting client-supplied property_id is
//  REFUSED rather than silently overwritten. Silently substituting the session
//  value would be a confident wrong: the caller believes it acted on property
//  A while the record landed on property B, and nothing anywhere says so.
//
//  Layer F is the one that matters most for the architecture: the operator
//  door and the resident door must reach the SAME canonical service instance.
//  Two doors into one service is correct. Two services would be a second
//  meaning of truth, which is the thing this codebase is organised to prevent.
//  So F instruments ONE service object, injects that same object into both
//  maintenanceModule and tenantLinkModule, drives both real HTTP routes, and
//  asserts both calls landed on it.
//
//  SCOPE SAFETY
//  ------------
//  Creates TWO scratch properties (A = assigned, B = the building the operator
//  must not be able to touch) and deletes only tracked ids behind name guards.
//  Never touches Demo Building.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  DATABASE_URL=... node tests/work_order_authority_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Pool } = require("pg");

const staffSessions = require("../src/identity/staff_session_service.js");
const { makeWorkOrderService } = require("../src/maintenance/work_order_service.js");
//  The REAL engine services the work-order service refuses to be built
//  without. `spawnObligationFromEvent` below is deliberately this file's own
//  double — it is what the authority assertions observe — but these two are
//  not: the service requires them precisely so the clarification path cannot
//  become a second obligation implementation, and handing it doubles would
//  defeat the guard rather than satisfy it.
const { satisfyObligation } = require("./_engine.js");
const { transitionObligation } = require("../src/shared/obligation_transitions.js");
const maintenanceModule = require("../src/maintenance/maintenance.js");
const tenantLinkModule = require("../src/comms/tenantlink.js");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const uuid = () => crypto.randomUUID();
const PROP_A = uuid();          // the operator's assigned property
const PROP_B = uuid();          // a property the operator has NO assignment on
const NAME_A = `__AUTHZ__A ${PROP_A.slice(0, 8)}`;
const NAME_B = `__AUTHZ__B ${PROP_B.slice(0, 8)}`;

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`); }

const track = { users: [], persons: [], units: [], leases: [] };

// ── the shared obligation engine stand-in (faithful to server.js:196/216) ──
async function spawnObligationFromEvent(client, o) {
  const r = await client.query(
    `insert into obligations
       (property_id, person_id, unit_id, source_event_id, module, type, label,
        owner_type, assigned_role, escalates_to_role, status, priority, severity,
        due_at, required_inputs, related_id, related_type)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
    [o.property_id, o.person_id ?? null, o.unit_id ?? null, o.source_event_id ?? null,
     o.module, o.type, o.label, o.owner_type ?? "human",
     o.assigned_role ?? null, o.escalates_to_role ?? null,
     o.status ?? "open", o.priority ?? "normal", o.severity ?? "normal",
     o.due_at ?? null, o.required_inputs ?? [], o.related_id ?? null, o.related_type ?? null]);
  return r.rows[0];
}

// ── ONE service instance, instrumented. Both modules receive THIS object. ──
const realService = makeWorkOrderService({ spawnObligationFromEvent, satisfyObligation, transitionObligation });
const serviceCalls = [];                       // { source, property_id }
const INSTANCE_TAG = uuid();                   // proves object identity, not shape
const instrumented = {
  ...realService,
  __tag: INSTANCE_TAG,
  createWorkOrder: async (client, spec) => {
    serviceCalls.push({ source: spec.source, property_id: spec.property_id });
    return realService.createWorkOrder(client, spec);
  },
};

let srv, base;

async function req(method, path, { staff, tenant, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (staff) headers["x-staff-session"] = staff;
  if (tenant) headers["x-tenant-session"] = tenant;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function mkStaff(name, modules, propertyId) {
  const id = uuid();
  track.users.push(id);
  await pool.query(
    `insert into users (id, name, role, is_active, status) values ($1,$2,'property_manager',true,'active')`,
    [id, name]);
  await pool.query(
    `insert into property_team_assignments
       (property_id, user_id, role_title, allowed_modules, active)
     values ($1,$2,$3,$4,true)`,
    [propertyId, id, "QA Maintenance [INTERNAL]", modules]);
  // Mint through the CANONICAL issuer — the same path production uses, read
  // back by the same production resolver. No hand-written session rows.
  const client = await pool.connect();
  try {
    await client.query("begin");
    const issued = await staffSessions.issueStaffSession(client, {
      userId: id, propertyId, purpose: "bootstrap_invite",
    });
    await client.query("commit");
    return { user_id: id, token: issued.token || issued.raw_token || issued.session_token };
  } finally { client.release(); }
}

// ════════════════════════════════════════════════════════════════════
async function main() {
  // ── scratch world ──
  await pool.query(`insert into properties (id,name) values ($1,$2),($3,$4)`,
    [PROP_A, NAME_A, PROP_B, NAME_B]);
  lines.push(`  scratch A ${PROP_A.slice(0, 8)} (${NAME_A})`);
  lines.push(`  scratch B ${PROP_B.slice(0, 8)} (${NAME_B})  — operator has NO assignment here`);

  // a unit on A (the ensure_unit_space trigger gives it a space)
  const unitA = uuid(); track.units.push(unitA);
  await pool.query(`insert into units (id,property_id,unit_number) values ($1,$2,'304')`, [unitA, PROP_A]);
  const spaceA = (await pool.query(`select id from spaces where unit_id=$1 limit 1`, [unitA])).rows[0];

  // a resident with an ACTIVE lease on that space, plus a tenant session
  const resident = uuid(); track.persons.push(resident);
  await pool.query(`insert into persons (id,name,lifecycle_status) values ($1,'QA Resident [INTERNAL]','tenant')`, [resident]);
  const leaseA = uuid(); track.leases.push(leaseA);
  await pool.query(
    `insert into leases (id,property_id,space_id,tenant_ids,lease_status) values ($1,$2,$3,$4,'active')`,
    [leaseA, PROP_A, spaceA.id, [resident]]);
  const tenantToken = "qa-tenant-" + uuid();
  await pool.query(
    `insert into tenant_sessions (person_id,property_id,token,expires_at) values ($1,$2,$3, now() + interval '2 hours')`,
    [resident, PROP_A, tenantToken]);

  // two staff: one WITH the maintenance module, one without
  const maint   = await mkStaff("QA Maint Operator [INTERNAL]",   ["maintenance", "leasing"], PROP_A);
  const noMaint = await mkStaff("QA Leasing Only [INTERNAL]",     ["leasing"],                PROP_A);

  ok("setup. both staff sessions minted through the canonical issuer",
    !!maint.token && !!noMaint.token, `maint=${!!maint.token} noMaint=${!!noMaint.token}`);

  // ── mount BOTH modules with the SAME instrumented service instance ──
  const app = express();
  app.use(express.json());
  app.use("/", maintenanceModule({ pool, spawnObligationFromEvent, workOrderService: instrumented }));
  app.use("/", tenantLinkModule({
    pool, anthropic: null, INGEST_MODEL: "fake",
    sms: { enabled: () => false, sendSms: async () => ({ sent: false }), validateWebhook: () => true },
    commBoundary: null, workOrderService: instrumented, getAgentService: () => null,
  }));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;

  // ════════ A · AN AUTHORIZED OPERATOR CAN ACT ══════════════════════
  section("A · an authorized operator can act at the assigned property");
  const created = await req("POST", "/operator/work-orders", {
    staff: maint.token,
    body: {
      title: "Water pouring from ceiling in 304", unit_id: unitA,
      field_category: "plumbing", unit_state: "occupied",
      is_emergency: true, emergency_type: "active_leak",
    },
  });
  ok("A1. an authorized maintenance operator creates a work order",
    created.status === 201 && !!created.json.work_order,
    `status=${created.status} body=${JSON.stringify(created.json).slice(0, 200)}`);
  ok("A2. it lands on the SESSION's property — never a client-named one",
    !!created.json.work_order && created.json.work_order.property_id === PROP_A,
    `landed on ${created.json.work_order && created.json.work_order.property_id} expected ${PROP_A}`);
  ok("A3. the receipt names the building actually acted on",
    !!created.json.acted_on && created.json.acted_on.property_id === PROP_A,
    JSON.stringify(created.json.acted_on));
  ok("A4. it still routes an obligation through the shared engine",
    !!created.json.obligation && created.json.obligation.related_type === "work_order",
    JSON.stringify(created.json.obligation && { t: created.json.obligation.type }));

  // ════════ B · ENTITLEMENT ═════════════════════════════════════════
  section("B · module entitlement is enforced, not assumed");
  const denied = await req("POST", "/operator/work-orders", {
    staff: noMaint.token,
    body: { title: "should never exist", field_category: "paint" },
  });
  ok("B1. a valid operator WITHOUT maintenance access is refused 403",
    denied.status === 403, `status=${denied.status} body=${JSON.stringify(denied.json).slice(0, 200)}`);
  ok("B2. the refusal names the real authority source, not a vague denial",
    /allowed_modules/.test(JSON.stringify(denied.json)), JSON.stringify(denied.json));
  const deniedRead = await req("GET", "/operator/work-orders", { staff: noMaint.token });
  ok("B3. the same operator cannot READ the maintenance queue either",
    deniedRead.status === 403, `status=${deniedRead.status}`);

  // ════════ C · NO CROSS-PROPERTY ACTION ════════════════════════════
  section("C · a valid operator cannot act across properties");
  const cross = await req("POST", "/operator/work-orders", {
    staff: maint.token,
    body: { property_id: PROP_B, title: "cross-property attempt", field_category: "plumbing" },
  });
  ok("C1. a body property_id for ANOTHER property is refused, not silently ignored",
    cross.status === 403, `status=${cross.status} body=${JSON.stringify(cross.json).slice(0, 220)}`);
  ok("C2. the refusal states which property authority actually covers",
    cross.json && cross.json.acting_on === PROP_A, JSON.stringify(cross.json));
  const crossCount = (await pool.query(
    `select count(*) from work_orders where property_id=$1`, [PROP_B])).rows[0].count;
  ok("C3. NOTHING was written to the other property",
    crossCount === "0", `work_orders on B = ${crossCount}`);

  const crossRead = await req("GET", `/operator/work-orders?property_id=${PROP_B}`, { staff: maint.token });
  ok("C4. a query-string property_id cannot widen or move the read scope",
    crossRead.status === 403, `status=${crossRead.status} body=${JSON.stringify(crossRead.json).slice(0, 200)}`);

  // ════════ D · THE BROWSER CANNOT SUPPLY AUTHORITY ═════════════════
  section("D · the browser cannot supply property authority");
  // Its OWN property id is accepted (it is not a claim of authority, it agrees
  // with the session) — but it is not what the server trusts.
  const echoed = await req("POST", "/operator/work-orders", {
    staff: maint.token,
    body: { property_id: PROP_A, title: "echoing my own property", field_category: "general" },
  });
  ok("D1. a body property_id that AGREES with the session is harmless",
    echoed.status === 201 && echoed.json.work_order.property_id === PROP_A,
    `status=${echoed.status}`);
  const scoped = await req("GET", "/operator/work-orders", { staff: maint.token });
  ok("D2. the scoped read returns ONLY the session's property",
    scoped.status === 200 && Array.isArray(scoped.json.work_orders) &&
      scoped.json.work_orders.every((w) => w.property_id === PROP_A) &&
      scoped.json.property_id === PROP_A,
    `status=${scoped.status} n=${scoped.json.work_orders && scoped.json.work_orders.length}`);

  // ════════ E · MISSING AUTHORITY FAILS HONESTLY ════════════════════
  section("E · missing authority fails honestly");
  const noSession = await req("POST", "/operator/work-orders", {
    body: { title: "no session at all", field_category: "general" },
  });
  ok("E1. no session → 401 with a human instruction, not 500, not a pretend session",
    noSession.status === 401 && /sign in/i.test(JSON.stringify(noSession.json)),
    `status=${noSession.status} body=${JSON.stringify(noSession.json)}`);

  const bogus = await req("POST", "/operator/work-orders", {
    staff: "not-a-real-token-" + uuid(),
    body: { title: "bogus token", field_category: "general" },
  });
  ok("E2. a bogus token → 401, never a partial or guessed scope",
    bogus.status === 401, `status=${bogus.status} body=${JSON.stringify(bogus.json)}`);

  const afterRefusals = (await pool.query(
    `select count(*) from work_orders where title in ('no session at all','bogus token','should never exist','cross-property attempt')`)).rows[0].count;
  ok("E3. no refused request wrote anything",
    afterRefusals === "0", `rows found = ${afterRefusals}`);

  // ════════ F · ONE SERVICE, TWO DOORS ══════════════════════════════
  section("F · operator and resident reach the SAME canonical service");
  const callsBefore = serviceCalls.length;
  const residentReq = await req("POST", "/tenant/maintenance", {
    tenant: tenantToken,
    body: { description: "The kitchen sink is backing up badly." },
  });
  ok("F1. the resident door creates a work order through its own session",
    residentReq.status === 201 && !!residentReq.json.work_order_id,
    `status=${residentReq.status} body=${JSON.stringify(residentReq.json).slice(0, 200)}`);

  ok("F2. that resident create landed on the SAME instrumented service object",
    serviceCalls.length === callsBefore + 1, `calls before=${callsBefore} after=${serviceCalls.length}`);

  //  Regression guard. F1 only checked the status code, so when the person
  //  columns were split this route silently began recording a resident-reported
  //  work order with NOBODY attached — 201, empty attribution, harness green.
  //  A status code is not evidence that the right facts were written.
  const residentRow = residentReq.json.work_order_id
    ? (await pool.query(
        `select reported_by_person_id, affected_person_id, unit_id
           from work_orders where id=$1`, [residentReq.json.work_order_id])).rows[0]
    : null;
  ok("F2b. the resident is recorded as BOTH reporter and affected — not dropped",
    !!residentRow &&
      residentRow.reported_by_person_id === resident &&
      residentRow.affected_person_id === resident &&
      residentRow.unit_id === unitA,
    `saved=${JSON.stringify(residentRow)} expected person=${resident}`);

  const bySource = serviceCalls.reduce((m, c) => { m[c.source] = (m[c.source] || 0) + 1; return m; }, {});
  ok("F3. THE ONE THAT MATTERS — both doors invoked ONE service instance",
    bySource.operator >= 1 && bySource.tenant >= 1 && instrumented.__tag === INSTANCE_TAG,
    `calls by source=${JSON.stringify(bySource)} tag_intact=${instrumented.__tag === INSTANCE_TAG}`);

  ok("F4. every service call carried a server-derived property, never a client one",
    serviceCalls.every((c) => c.property_id === PROP_A),
    JSON.stringify(serviceCalls.map((c) => ({ s: c.source, p: (c.property_id || "").slice(0, 8) }))));

  // capture once, read everywhere: the resident's work order is visible to the
  // operator's scoped read without anyone writing it twice.
  const afterResident = await req("GET", "/operator/work-orders", { staff: maint.token });
  const sawResident = (afterResident.json.work_orders || []).some(
    (w) => w.id === residentReq.json.work_order_id && w.source === "tenant");
  ok("F5. the resident's request appears in the operator queue — one write, two reads",
    sawResident, `operator sees ${(afterResident.json.work_orders || []).length} rows`);

  // ── both modules refuse to construct without the service (symmetry) ──
  section("G · neither door can be wired half-way");
  let mThrew = null, tThrew = null;
  try { maintenanceModule({ pool, spawnObligationFromEvent }); } catch (e) { mThrew = e.message; }
  try {
    tenantLinkModule({ pool, anthropic: null, INGEST_MODEL: "f", sms: null, commBoundary: null, getAgentService: () => null });
  } catch (e) { tThrew = e.message; }
  ok("G1. maintenance refuses to construct without the canonical service",
    mThrew !== null && /workOrderService/.test(mThrew || ""), String(mThrew));
  ok("G2. tenantlink refuses too — a silently dead resident route is worse than a failed boot",
    tThrew !== null && /workOrderService/.test(tThrew || ""), String(tThrew));
}

// ════════════════════════════════════════════════════════════════════
async function cleanup() {
  lines.push("");
  try {
    for (const p of [PROP_A, PROP_B]) {
      await pool.query("delete from obligations where property_id=$1", [p]);
      await pool.query("delete from work_orders where property_id=$1", [p]);
      await pool.query("delete from events where property_id=$1", [p]);
      await pool.query("delete from tenant_sessions where property_id=$1", [p]);
      await pool.query("delete from staff_sessions where property_id=$1", [p]);
      await pool.query("delete from property_team_assignments where property_id=$1", [p]);
      await pool.query("delete from leases where property_id=$1", [p]);
      await pool.query("delete from spaces where unit_id in (select id from units where property_id=$1)", [p]);
      await pool.query("delete from units where property_id=$1", [p]);
    }
    if (track.users.length)   await pool.query("delete from users where id = any($1::uuid[])", [track.users]);
    if (track.persons.length) await pool.query("delete from persons where id = any($1::uuid[])", [track.persons]);
    const gone = await pool.query(
      "delete from properties where id = any($1::uuid[]) and (name like '__AUTHZ__A %' or name like '__AUTHZ__B %')",
      [[PROP_A, PROP_B]]);
    lines.push(`  cleanup complete. scratch properties removed: ${gone.rowCount}/2`);
  } catch (e) {
    lines.push(`  CLEANUP FAILED — scratch properties may remain (${PROP_A.slice(0, 8)}, ${PROP_B.slice(0, 8)}): ${e.message}`);
  }
}

(async () => {
  try { await main(); }
  catch (e) {
    failed++;
    lines.push(`\n  FAIL  harness threw: ${e.message}\n        ${(e.stack || "").split("\n")[1] || ""}`);
  } finally {
    await cleanup();
    try { if (srv) srv.close(); } catch (_) {}
    await pool.end().catch(() => {});
  }
  const bar = "─".repeat(70);
  console.log(`\n${bar}\nWORK ORDER — THE AUTHORITY SEAM\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "The authority seam is not whole. Fix the failures above and re-run."
    : "Property authority is server-derived, entitlement is enforced, and both doors reach one service.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
})();
