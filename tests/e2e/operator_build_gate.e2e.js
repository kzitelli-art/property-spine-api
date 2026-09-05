/*  ════════════════════════════════════════════════════════════════════
    operator_build_gate.e2e.js — /operator/build IS BEHIND THE GATE IT
    SAYS IT IS BEHIND.

    server.js exempts /operator/* from the operator-key gate because every
    route there resolves its own staff session. GET /operator/build
    (src/baseline/baseline_routes.js) resolved nothing and published the
    full build identity — untruncated commit, node version, process start
    — to anyone. Proven here: no session → 401 and no build record; the
    shared operator key alone is not a session; a staff session → the
    record. /health keeps its anonymous SHORT sha by design; pinned so the
    two doors do not drift into each other.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const get = async (url, headers = {}) => {
  const r = await fetch(`${API}${url}`, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const tag = "OBG" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'8 Build Rd') returning id", [tag + " Build"])).id;
  const user = (await one(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'property_manager',true,'active','human_staff') returning id`, [tag + " Operator", `${tag}@example.com`])).id;
  await pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof','property','{management}','{management}',false,true)`, [prop, user]);
  const c = await pool.connect();
  let session;
  try { await c.query("begin"); session = (await staffSessions.issueStaffSession(c, { userId: user, propertyId: prop, purpose: "sms_otp" })).session_token; await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

  console.log("\n── 1 · no session ──");
  const anon = await get("/operator/build");
  check("GET /operator/build with no credentials → 401", anon.status === 401, `${anon.status} ${J(anon.body).slice(0, 160)}`);
  check("…and no build record in the refusal", !(anon.body && anon.body.build), J(anon.body));
  const keyOnly = await get("/operator/build", { "x-operator-key": KEY });
  check("GET /operator/build with the shared operator key alone → 401 (a key is not a session)", keyOnly.status === 401 && !(keyOnly.body && keyOnly.body.build), `${keyOnly.status} ${J(keyOnly.body).slice(0, 160)}`);
  const bogus = await get("/operator/build", { "x-staff-session": "not-a-session-" + tag });
  check("GET /operator/build with an unresolvable session token → 401", bogus.status === 401, `${bogus.status} ${J(bogus.body).slice(0, 160)}`);

  console.log("\n── 2 · a staff session ──");
  const auth = await get("/operator/build", { "x-staff-session": session });
  check("GET /operator/build with a staff session → 200 with the build record", auth.status === 200 && auth.body && auth.body.build && "commit" in auth.body.build && typeof auth.body.build.resolved_from === "string", `${auth.status} ${J(auth.body).slice(0, 200)}`);

  console.log("\n── 3 · /health keeps its anonymous short sha by design ──");
  const health = await get("/health");
  check("GET /health with no credentials → 200 carrying build.commit_short (never the full commit)", health.status === 200 && health.body && health.body.build && "commit_short" in health.body.build && !("commit" in health.body.build), `${health.status} ${J(health.body).slice(0, 200)}`);

  await pool.end();
  console.log(`\n══ operator build gate: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
