/*  ════════════════════════════════════════════════════════════════════
    extracted_route_bindings.e2e.js — THE BINDING THE EXTRACTION LOST.

    On 2026-08-27 server.js was decomposed into route modules. Three routes
    kept calling `staffSessions.resolveStaffSession(...)` — a module-level
    constant of server.js — after they had moved into files that never
    received it:

      src/agent/document_ingest_routes.js   POST /ingest/:runId/promote
                                            POST /ingest/:runId/approve
      src/baseline/baseline_routes.js       POST /properties

    In the ingest routes the resolution ran BEFORE the handler's `try`, so the
    ReferenceError was an unhandled rejection: under Node 22 one call ended
    the process. In POST /properties the `try` caught it and answered 500
    where the route intends 401. Same defect class, three sites.

    This proof runs against the REAL server.js the verification parent
    booted (port 3000, OPERATOR_KEY e2e-key, the disposable E2E database)
    and proves the whole class, then — with an injected resolver that
    rejects — proves a resolver failure is a handled 500, never a dead
    process.

    WHAT THIS DOES AND DOES NOT PROVE. It proves ACTOR ATTRIBUTION: the
    session's user is recorded as reviewer and promoter, and no session
    leaves the field honestly blank as the routes have always done. It does
    NOT change or prove property-scope authorization on these legacy
    routes; that policy is untouched by this slice and is a separate
    decision.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const http = require("http");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const express = require(path.join(ROOT, "node_modules", "express"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
const documentIngestRoutes = require(path.join(ROOT, "src/agent/document_ingest_routes.js"));
const baselineRoutes = require(path.join(ROOT, "src/baseline/baseline_routes.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
async function call(base, method, p, { key = true, session = null, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers["x-operator-key"] = KEY;
  if (session) headers["x-staff-session"] = session;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : J(body) });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

(async () => {
  const tag = "ERB" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'1 Binding St') returning id", [tag + " Ingest"])).id;
  const user = (await one(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'property_manager',true,'active','human_staff') returning id`, [tag + " Reviewer", tag + "@example.com"])).id;
  await pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof','property','{leasing,management}','{leasing}',false,true)`, [prop, user]);
  const client = await pool.connect();
  let token;
  try { await client.query("begin");
    token = (await staffSessions.issueStaffSession(client, { userId: user, propertyId: prop, purpose: "sms_otp" })).session_token;
    await client.query("commit");
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
  const newRun = async () => {
    const run = (await one(`insert into ingest_runs (property_id, kind, source_text, model_raw_output) values ($1,'rent_roll',$2,'{}') returning id`, [prop, tag + " 1br 1500"])).id;
    const cand = (await one(`insert into ingest_candidates (run_id, property_id, unit_number, bedrooms, market_rent, decision_status)
                             values ($1,$2,$3,1,1500,'pending') returning id`, [run, prop, "U" + Math.floor(Math.random() * 1e5)])).id;
    return { run, cand };
  };

  console.log("\n── 1 · POST /properties: key, no session → the INTENDED 401 (was 500: ReferenceError caught by its try) ──");
  const p1 = await call(API, "POST", "/properties", { body: { name: tag + " Unowned" } });
  check("key but no session → 401 no_authenticated_actor", p1.status === 401 && p1.body && p1.body.reason === "no_authenticated_actor", `${p1.status} ${J(p1.body)}`);
  check("…and no property was created", !(await one("select 1 from properties where name=$1", [tag + " Unowned"])));

  console.log("\n── 2 · session but NO operator key: the global gate still refuses, nothing moves ──");
  const { run: r2, cand: c2 } = await newRun();
  const a2 = await call(API, "POST", `/ingest/${r2}/approve`, { key: false, session: token });
  const still = await one("select decision_status, reviewed_by from ingest_candidates where id=$1", [c2]);
  check("approve without the key → 401", a2.status === 401, `${a2.status} ${J(a2.body)}`);
  check("…candidate untouched (pending, no reviewer)", still.decision_status === "pending" && still.reviewed_by === null, J(still));

  console.log("\n── 3 · key + canonical same-property session: approve then promote, the actor RECORDED ──");
  const a3 = await call(API, "POST", `/ingest/${r2}/approve`, { session: token });
  const after3 = await one("select decision_status, reviewed_by, reviewed_at from ingest_candidates where id=$1", [c2]);
  check("approve → 200 with approved_count 1", a3.status === 200 && a3.body && a3.body.approved_count === 1, `${a3.status} ${J(a3.body)}`);
  check("…reviewed_by is the session's user, reviewed_at set", after3.reviewed_by === user && !!after3.reviewed_at, J(after3));
  const p3 = await call(API, "POST", `/ingest/${r2}/promote`, { session: token });
  const after3b = await one("select decision_status, promoted_by, promoted_unit_id from ingest_candidates where id=$1", [c2]);
  const unit = after3b.promoted_unit_id && await one("select id, property_id, unit_number from units where id=$1", [after3b.promoted_unit_id]);
  check("promote → 200, promoted_count 1, no skips", p3.status === 200 && p3.body && p3.body.promoted_count === 1 && Array.isArray(p3.body.skipped) && p3.body.skipped.length === 0, `${p3.status} ${J(p3.body).slice(0, 200)}`);
  check("…promoted_by is the session's user and the candidate links the new unit at this property",
        after3b.decision_status === "promoted" && after3b.promoted_by === user && unit && unit.property_id === prop, J({ after3b, unit }));
  const h = await fetch(API + "/health");
  check("…the server is still healthy afterwards (before the fix, this call ended the process)", h.status === 200, String(h.status));

  console.log("\n── 4 · the body-actor refusal and the optional session are unchanged ──");
  const b4 = await call(API, "POST", `/ingest/${r2}/promote`, { session: token, body: { promoted_by: user } });
  check("a body promoted_by is still rejected 400 body_actor_field_rejected", b4.status === 400 && b4.body && b4.body.error === "body_actor_field_rejected", `${b4.status} ${J(b4.body)}`);
  const { run: r4, cand: c4 } = await newRun();
  const a4 = await call(API, "POST", `/ingest/${r4}/approve`, {});
  const after4 = await one("select decision_status, reviewed_by from ingest_candidates where id=$1", [c4]);
  check("approve with key and NO session still approves with reviewed_by honestly blank", a4.status === 200 && after4.decision_status === "approved" && after4.reviewed_by === null, `${a4.status} ${J(after4)}`);

  console.log("\n── 5 · a resolver that REJECTS is a handled 500, and the process lives ──");
  const rejecting = { resolveStaffSession: async () => { throw new Error("resolver down (injected)"); } };
  const noop = (_q, _s, next) => next();
  const app = express(); app.use(express.json());
  app.use("/", documentIngestRoutes({ pool, upload: { single: () => noop, array: () => noop, any: () => noop }, runIngestAuto: async () => ({}), fileToText: async () => "", staffSessions: rejecting }));
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${srv.address().port}`;
  const { run: r5, cand: c5 } = await newRun();
  const a5 = await call(local, "POST", `/ingest/${r5}/approve`, { key: false, session: "anything" });
  const p5 = await call(local, "POST", `/ingest/${r5}/promote`, { key: false, session: "anything" });
  const after5 = await one("select decision_status from ingest_candidates where id=$1", [c5]);
  check("approve with a rejecting resolver → handled 500 JSON naming the error", a5.status === 500 && a5.body && /resolver down/.test(a5.body.error || ""), `${a5.status} ${J(a5.body)}`);
  check("promote with a rejecting resolver → handled 500 JSON naming the error", p5.status === 500 && p5.body && /resolver down/.test(p5.body.error || ""), `${p5.status} ${J(p5.body)}`);
  check("…this process is still alive and the candidate is untouched", after5.decision_status === "pending", J(after5));
  srv.close();

  console.log("\n── 6 · the missing binding fails at CONSTRUCTION, not at the first request ──");
  let threwIngest = null, threwBaseline = null;
  try { documentIngestRoutes({ pool, upload: {}, runIngestAuto: async () => ({}), fileToText: async () => "" }); } catch (e) { threwIngest = e; }
  try { baselineRoutes({ pool, spawnObligationFromEvent: async () => ({}) }); } catch (e) { threwBaseline = e; }
  check("documentIngestRoutes without staffSessions throws at construction", threwIngest && /staffSessions/.test(threwIngest.message), threwIngest && threwIngest.message);
  check("baselineRoutes without staffSessions throws at construction", threwBaseline && /staffSessions/.test(threwBaseline.message), threwBaseline && threwBaseline.message);

  console.log("\n  NOTE: this proves actor attribution on three legacy routes. It does not change or prove");
  console.log("        property-scope authorization on them; that is a separate decision.");
  await pool.end();
  console.log(`\n══ extracted route bindings: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
