/*  ════════════════════════════════════════════════════════════════════
    org_roster_scope.e2e.js — AN ORG ADMIN'S ROSTER STOPS AT THE ORG.

    GET /org/me and GET /org/users (src/identity/org_admin.js) list the
    organization's users, but joined property_team_assignments without
    asking which organization the property belongs to. A user seated on
    a property in ANOTHER organization showed that seat to this org's
    admin — assignment id, property id, role and modules, with only the
    property name blanked — and /org/me counted it. Proven here: seats on
    other organizations' properties are neither counted nor listed, the
    org's own seats still are, and other organizations' users never appear.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const get = async (url, session) => {
  const r = await fetch(`${API}${url}`, { headers: { "x-staff-session": session } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const tag = "ORS" + Math.floor(Math.random() * 1e6);
  const orgX = (await one("insert into organizations (name) values ($1) returning id", [tag + " Org X"])).id;
  const orgY = (await one("insert into organizations (name) values ($1) returning id", [tag + " Org Y"])).id;
  const propX = (await one("insert into properties (name,address,organization_id) values ($1,'1 X St',$2) returning id", [tag + " X House", orgX])).id;
  const propY = (await one("insert into properties (name,address,organization_id) values ($1,'2 Y St',$2) returning id", [tag + " Y House", orgY])).id;
  const mkUser = async (n, org, platformRole) => (await one(
    `insert into users (name,email,role,is_active,status,account_kind,organization_id,platform_role)
     values ($1,$2,'property_manager',true,'active','human_staff',$3,$4) returning id`,
    [tag + " " + n, `${tag}-${n}@example.com`, org, platformRole])).id;
  const seat = (user, prop) => pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,role_key,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Manager','property_manager','property','{management}','{management}',false,true)`, [prop, user]);
  const admin = await mkUser("Admin", orgX, "org_admin"); await seat(admin, propX);
  const staff = await mkUser("Staff", orgX, "member");    await seat(staff, propX); await seat(staff, propY);
  const outsider = await mkUser("Outsider", orgY, "member"); await seat(outsider, propY);
  const c = await pool.connect();
  let session;
  try { await c.query("begin"); session = (await staffSessions.issueStaffSession(c, { userId: admin, propertyId: propX, purpose: "sms_otp" })).session_token; await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  console.log("\n── 1 · GET /org/me — the count of properties a user operates stops at the org ──");
  const me = await get("/org/me", session);
  const meStaff = me.body && Array.isArray(me.body.users) ? me.body.users.find((u) => u.id === staff) : null;
  check("GET /org/me → 200 listing the org's staff member", me.status === 200 && !!meStaff, `${me.status} ${J(me.body).slice(0, 200)}`);
  check("…that member's property_count is 1: the seat on the other organization's property is not counted", !!meStaff && meStaff.property_count === 1, J(meStaff));
  check("…the other organization's user is not in the org", !!(me.body && me.body.users && !me.body.users.some((u) => u.id === outsider)));

  console.log("\n── 2 · GET /org/users — a seat on another organization's property is not disclosed ──");
  const users = await get("/org/users", session);
  const rowStaff = Array.isArray(users.body) ? users.body.find((u) => u.id === staff) : null;
  const rowAdmin = Array.isArray(users.body) ? users.body.find((u) => u.id === admin) : null;
  check("GET /org/users → 200 with the org's staff member", users.status === 200 && !!rowStaff, `${users.status} ${J(users.body).slice(0, 200)}`);
  const seats = (rowStaff && rowStaff.assignments) || [];
  check("…their assignments name only the org's own property", seats.length === 1 && seats[0].property_id === propX && seats[0].property_name === tag + " X House", J(seats));
  check("…no assignment on the other organization's property leaks (was listed with its name blanked)", !seats.some((a) => a.property_id === propY), J(seats));
  check("…the admin's own seat is still listed", !!rowAdmin && (rowAdmin.assignments || []).some((a) => a.property_id === propX), J(rowAdmin && rowAdmin.assignments));
  check("…the other organization's user is not listed", Array.isArray(users.body) && !users.body.some((u) => u.id === outsider));

  await pool.end();
  console.log(`\n══ org roster scope: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
