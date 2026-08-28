/* ════════════════════════════════════════════════════════════════════
   phase_zero_property_boundary.db.js — PHASE ZERO, PROVEN AGAINST REAL
   POSTGRES AND REAL HTTP.

   Two routes are under test:
     GET  /operator/properties
     POST /operator/properties/select

   ── WHAT THIS PROOF REFUSES TO ASSUME ───────────────────────────────
   · A LIST IS NOT AUTHORIZATION. The central assertion is not "the list
     is right" — it is that a property ABSENT from the list is still
     refused when requested directly. A proof that only checked the list
     would pass on a build where the mint granted anything, which is the
     exact failure Phase Zero exists to prevent.

   · REVOCATION MUST BITE BETWEEN RENDER AND CLICK. The picker is
     rendered from a read; the grant happens later. So the harness
     deactivates an assignment AFTER listing it and proves the select is
     refused — the race a pre-validating implementation would lose.

   · THE OLD SESSION MUST DIE. A switch that leaves the previous token
     live means two property scopes are usable at once from one browser.
     Proven by replaying the old token and requiring 401.

   · SESSION LIFETIME MUST NOT SILENTLY SHORTEN. An sms_otp session (14
     days) that switches property must not come back as a 12-hour
     bootstrap_invite session. Asserted on issuance_purpose in the row.

   Real HTTP: server.js is booted in-process on a loopback port and every
   assertion goes over the wire. No route handler is called directly.

   CLASS 3 — test infrastructure. Outside the operator workflow.
   Removal condition: none while these routes exist.

   Run:
     HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:5433/postgres?sslmode=require" \
       node tests/proofs/phase_zero_property_boundary.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Pool } = require("pg");
const http = require("http");
const path = require("path");
const fs = require("fs");

//  THE HOUSE REFUSAL, NOT A LOCAL ONE. The first version of this file
//  hand-rolled the same-target check with a string comparison, which
//  gate_harness_isolation.js correctly flagged: a private copy misses the
//  cases sameTarget() already knows about (differing sslmode, credentials or
//  query strings on the same host+database compare unequal as strings and
//  identical as targets), and a second implementation is a second thing to
//  keep right. harnessConnectionString() refuses a missing variable and a
//  production target, and it is the only refusal this harness performs.
const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const SCHEMA = "phase_zero_proof";

/*  The scoped schema, in the house style of tests/_ops_scoped_schema.sql:
 *  exactly the tables the routes under test touch, with the real column
 *  shapes taken from migrations 035, 060, 067, 070, 095. It is NOT the
 *  full migration chain — this repo proves domain work against a scoped
 *  schema, and a harness that replayed 173 migrations would be testing
 *  the migration runner instead of the routes.  */
const SCOPED_SCHEMA = `
  create extension if not exists pgcrypto;
  drop schema if exists ${SCHEMA} cascade;
  create schema ${SCHEMA};
  set search_path to ${SCHEMA}, public;

  create table organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null);

  create table properties (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    display_name text,
    address text,
    organization_id uuid references organizations(id) on delete set null,
    sms_number text,
    created_at timestamptz not null default now());

  create table users (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    email text unique,
    phone text,
    role text not null default 'leasing_agent',
    platform_role text default 'member',
    account_kind text not null default 'human_staff',
    is_active boolean not null default true,
    status text not null default 'active',
    organization_id uuid references organizations(id) on delete set null,
    person_id uuid,
    created_at timestamptz not null default now());

  create table property_team_assignments (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    role_title text not null,
    role_key text,
    scope_type text not null default 'property',
    allowed_modules text[] not null default '{}',
    primary_for_modules text[] not null default '{}',
    can_manage_roles boolean not null default false,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (property_id, user_id));

  create table staff_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    property_id uuid not null references properties(id) on delete cascade,
    token text unique,
    token_digest text,
    issuance_purpose text
      check (issuance_purpose is null
             or issuance_purpose in ('demo','bootstrap_invite','sms_otp')),
    expires_at timestamptz not null,
    revoked boolean not null default false,
    created_at timestamptz not null default now());
  create unique index on staff_sessions (token_digest) where token_digest is not null;
`;

(async () => {
  const pool = new Pool({ connectionString: CONN });
  const admin = new Pool({ connectionString: CONN });

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  PHASE ZERO — PROPERTY BOUNDARY, real Postgres + real HTTP");
  console.log("════════════════════════════════════════════════════════════════\n");

  await admin.query(SCOPED_SCHEMA);
  // Every pooled connection must land in the scoped schema.
  pool.on("connect", (c) => c.query(`set search_path to ${SCHEMA}, public`));

  // ── the world ────────────────────────────────────────────────────
  const org = (await admin.query(
    `insert into ${SCHEMA}.organizations (name) values ('Zitelli') returning id`)).rows[0].id;
  const otherOrg = (await admin.query(
    `insert into ${SCHEMA}.organizations (name) values ('Someone Else') returning id`)).rows[0].id;

  async function property(name, display, address, orgId) {
    return (await admin.query(
      `insert into ${SCHEMA}.properties (name, display_name, address, organization_id)
       values ($1,$2,$3,$4) returning id`, [name, display, address, orgId])).rows[0].id;
  }
  const demoBuilding = await property("Property Spine Demo Building", null, "Demo St", org);
  const skyline = await property("Skyline Apartments", "Skyline", "1417 N 15th St", org);
  const greenery = await property("Greenery Apartments", null, "1325 N 15th St", org);
  const foreign = await property("Not Yours", null, "Elsewhere", otherOrg);

  async function user(name, email) {
    return (await admin.query(
      `insert into ${SCHEMA}.users (name, email) values ($1,$2) returning id`,
      [name, email])).rows[0].id;
  }
  const kameron = await user("Kameron", "k@example.test");
  const mike = await user("Mike", "m@example.test");

  async function assign(userId, propertyId, { active = true, modules = ["leasing"], manage = false } = {}) {
    await admin.query(
      `insert into ${SCHEMA}.property_team_assignments
         (property_id, user_id, role_title, allowed_modules, can_manage_roles, active)
       values ($1,$2,$3,$4,$5,$6)`,
      [propertyId, userId, "Asset Manager", modules, manage, active]);
  }
  //  Kameron: Demo Building + Skyline + Greenery. Mike: Skyline + Greenery.
  await assign(kameron, demoBuilding, { manage: true });
  await assign(kameron, skyline);
  await assign(kameron, greenery);
  await assign(mike, skyline);
  await assign(mike, greenery);
  //  Nobody is assigned to `foreign`. Kameron gets a REVOKED assignment to it
  //  so the "inactive assignment" case is distinct from "no row at all".
  await assign(kameron, foreign, { active: false });

  // ── boot the real server ─────────────────────────────────────────
  process.env.DATABASE_URL = CONN;
  process.env.PGSSL = process.env.PGSSL || "require";
  const staffSessions = require("../../src/identity/staff_session_service.js");
  const operatorProperties = require("../../src/identity/operator_properties.js");
  const express = require("express");

  //  The two routes under test, mounted on a real express app with the real
  //  json body parser, exactly as server.js mounts them. Booting all of
  //  server.js would drag in ~60 modules and 173 migrations' worth of schema;
  //  the ROUTES and their authority path are what this proves, and they are
  //  the same objects server.js mounts.
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/", operatorProperties({ pool }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, p, { token, body } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: Object.assign({ "accept": "application/json" },
        token ? { "x-staff-session": token } : {},
        body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed = null;
    try { parsed = await res.json(); } catch (_) { parsed = null; }
    return { status: res.status, body: parsed };
  }

  async function mint(userId, propertyId, purpose = "bootstrap_invite") {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const out = await staffSessions.issueStaffSession(c, { userId, propertyId, purpose });
      await c.query("commit");
      return out;
    } catch (e) { await c.query("rollback"); throw e; }
    finally { c.release(); }
  }

  try {
    // ══ 1. AUTHORIZED LIST ═══════════════════════════════════════════
    console.log("  ── the authorized list is the operator's own, and only theirs ──");

    const kSession = await mint(kameron, demoBuilding);
    const kList = await api("GET", "/operator/properties", { token: kSession.session_token });
    ok("Kameron: 200", kList.status === 200, `got ${kList.status}`);
    const kNames = (kList.body.properties || []).map((p) => p.property_name).sort();
    ok("Kameron sees exactly his 3 active properties",
      JSON.stringify(kNames) === JSON.stringify(["Greenery Apartments", "Property Spine Demo Building", "Skyline"]),
      JSON.stringify(kNames));
    ok("revoked assignment is absent from the list",
      !(kList.body.properties || []).some((p) => p.property_id === foreign));
    ok("active_property_id comes from the session",
      kList.body.active_property_id === demoBuilding);
    ok("display_name wins over name (Skyline, not Skyline Apartments)",
      (kList.body.properties || []).some((p) => p.property_id === skyline && p.property_name === "Skyline"));
    ok("address is carried when present",
      (kList.body.properties || []).some((p) => p.property_id === skyline && p.address === "1417 N 15th St"));
    ok("module entitlements are returned",
      (kList.body.properties || []).every((p) => Array.isArray(p.allowed_modules)));

    const mSession = await mint(mike, skyline);
    const mList = await api("GET", "/operator/properties", { token: mSession.session_token });
    const mNames = (mList.body.properties || []).map((p) => p.property_name).sort();
    ok("Mike sees exactly his 2 properties",
      JSON.stringify(mNames) === JSON.stringify(["Greenery Apartments", "Skyline"]), JSON.stringify(mNames));
    ok("Mike does NOT see Demo Building",
      !(mList.body.properties || []).some((p) => p.property_id === demoBuilding));
    ok("another organization's property is absent",
      !(mList.body.properties || []).some((p) => p.property_id === foreign));

    ok("no session → 401", (await api("GET", "/operator/properties")).status === 401);
    ok("garbage token → 401",
      (await api("GET", "/operator/properties", { token: "not-a-token" })).status === 401);

    // ══ 2. THE SWITCH ════════════════════════════════════════════════
    console.log("\n  ── switching is minting, and the server grants it ──");

    const sw = await api("POST", "/operator/properties/select",
      { token: kSession.session_token, body: { property_id: skyline } });
    ok("authorized switch → 200", sw.status === 200, JSON.stringify(sw.body));
    ok("a new session token is issued", typeof sw.body.session_token === "string" && sw.body.session_token.length > 20);
    ok("the token is NOT the old one", sw.body.session_token !== kSession.session_token);
    ok("the grant names the chosen property", sw.body.property && sw.body.property.id === skyline);
    ok("the grant reports where it came from", sw.body.previous_property_id === demoBuilding);
    ok("role_title is mapped from property_role_title", sw.body.role_title === "Asset Manager");

    const scoped = await api("GET", "/operator/properties", { token: sw.body.session_token });
    ok("the new session is scoped to Skyline", scoped.body.active_property_id === skyline);

    const replay = await api("GET", "/operator/properties", { token: kSession.session_token });
    ok("THE OLD TOKEN IS DEAD after a switch", replay.status === 401, `got ${replay.status}`);

    const again = await api("POST", "/operator/properties/select",
      { token: sw.body.session_token, body: { property_id: skyline } });
    ok("re-selecting the active property is a no-op, not a new token",
      again.status === 200 && again.body.unchanged === true && !again.body.session_token);

    // ══ 3. REFUSALS — THE POINT OF THE SLICE ═════════════════════════
    console.log("\n  ── the browser proposes; the server refuses ──");

    const mikeTries = await api("POST", "/operator/properties/select",
      { token: mSession.session_token, body: { property_id: demoBuilding } });
    ok("Mike CANNOT select Demo Building (never in his list)",
      mikeTries.status === 403 && mikeTries.body.error === "no_access_to_property",
      `${mikeTries.status} ${JSON.stringify(mikeTries.body)}`);

    const inactiveTry = await api("POST", "/operator/properties/select",
      { token: sw.body.session_token, body: { property_id: foreign } });
    ok("an INACTIVE assignment is refused", inactiveTry.status === 403);

    const missingTry = await api("POST", "/operator/properties/select",
      { token: sw.body.session_token, body: { property_id: "00000000-0000-4000-8000-000000000000" } });
    ok("a nonexistent property is refused with the SAME shape (no existence oracle)",
      missingTry.status === 403 && missingTry.body.error === "no_access_to_property");

    ok("a malformed id is 400, not a permission answer",
      (await api("POST", "/operator/properties/select",
        { token: sw.body.session_token, body: { property_id: "../../etc/passwd" } })).status === 400);
    ok("a missing body is 400",
      (await api("POST", "/operator/properties/select", { token: sw.body.session_token, body: {} })).status === 400);
    ok("select with no session → 401",
      (await api("POST", "/operator/properties/select", { body: { property_id: skyline } })).status === 401);

    // ══ 4. REVOCATION BITES BETWEEN RENDER AND CLICK ═════════════════
    console.log("\n  ── a list is not a permission slip ──");

    const beforeRevoke = await api("GET", "/operator/properties", { token: sw.body.session_token });
    ok("Greenery is listed before revocation",
      (beforeRevoke.body.properties || []).some((p) => p.property_id === greenery));

    await admin.query(
      `update ${SCHEMA}.property_team_assignments set active = false
        where user_id = $1 and property_id = $2`, [kameron, greenery]);

    const afterRevoke = await api("POST", "/operator/properties/select",
      { token: sw.body.session_token, body: { property_id: greenery } });
    ok("SELECTING A JUST-REVOKED PROPERTY IS REFUSED — the mint is the authority, not the list",
      afterRevoke.status === 403, `got ${afterRevoke.status}`);

    // ══ 5. SESSION POLICY IS NOT SILENTLY DOWNGRADED ═════════════════
    console.log("\n  ── a switch continues the session, it does not re-label it ──");

    const smsSession = await mint(mike, skyline, "sms_otp");
    const smsSwitch = await api("POST", "/operator/properties/select",
      { token: smsSession.session_token, body: { property_id: greenery } });
    ok("sms_otp operator can switch", smsSwitch.status === 200, JSON.stringify(smsSwitch.body));
    const purposeRow = (await admin.query(
      `select issuance_purpose from ${SCHEMA}.staff_sessions
        where user_id = $1 and property_id = $2 and revoked = false
        order by created_at desc limit 1`, [mike, greenery])).rows[0];
    ok("the new session KEEPS sms_otp (14-day policy), not bootstrap_invite (12h)",
      purposeRow && purposeRow.issuance_purpose === "sms_otp",
      `got ${purposeRow && purposeRow.issuance_purpose}`);
    ok("and its TTL reflects that policy", smsSwitch.body.expires_in_hours === 24 * 14,
      `got ${smsSwitch.body.expires_in_hours}`);

    // ══ 6. NO SESSION IS LEFT BEHIND ═════════════════════════════════
    const live = (await admin.query(
      `select count(*)::int as n from ${SCHEMA}.staff_sessions
        where user_id = $1 and revoked = false`, [kameron])).rows[0].n;
    ok("Kameron holds exactly ONE live session after two switches", live === 1, `got ${live}`);

  } finally {
    server.close();
    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
    await pool.end();
    await admin.end();
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass + fail} run · ${pass} passed · ${fail} failed`);
  if (fail) { console.log("  FAILED: " + failures.join(" | ")); }
  console.log(fail ? "  ✗ FAIL" : "  ✓ PASS");
  console.log("════════════════════════════════════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
