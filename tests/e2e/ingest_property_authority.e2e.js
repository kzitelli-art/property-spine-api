/*  ════════════════════════════════════════════════════════════════════
    ingest_property_authority.e2e.js — THE PROPERTY WALL ON THE LEGACY
    INGEST MUTATIONS, AND THE KEY-ONLY PATH NAMED FOR WHAT IT IS.

    extracted_route_bindings.e2e.js proved that /ingest/:runId/approve and
    /promote record the session's user. It did not prove that the session
    may act HERE. A staff session is seated on one property
    (staff_sessions.property_id); before this slice a session seated on
    another building approved and promoted this run's units, and was
    recorded as the reviewer and promoter. That is the seam this proves
    shut:

      · a session seated on the run's property performs the mutation
      · a session seated elsewhere is refused 403 with NO write
      · a body-supplied actor is still refused 400
      · the run-not-found 404 still comes first, unchanged

    And it names, in an assertion rather than a footnote, what is NOT
    decided here: with no session at all the route still runs on the
    shared operator key and records no actor. That key-only path has no
    caller in the pinned app (4849545) and no governed consumer in tools/
    or docs/. It is CLASSIFIED as ungoverned legacy and preserved; retiring
    it changes the route's contract and awaits an owner ruling. A presented
    session token that does not resolve behaves, today, exactly like no
    session — asserted so it cannot drift silently into either meaning.

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
async function call(method, p, { key = true, session = null, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers["x-operator-key"] = KEY;
  if (session) headers["x-staff-session"] = session;
  const r = await fetch(API + p, { method, headers, body: body === undefined ? undefined : J(body) });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

(async () => {
  const tag = "IPA" + Math.floor(Math.random() * 1e6);
  const propA = (await one("insert into properties (name,address) values ($1,'1 Here St') returning id", [tag + " Here"])).id;
  const propB = (await one("insert into properties (name,address) values ($1,'2 Elsewhere Ave') returning id", [tag + " Elsewhere"])).id;
  const mkUser = async (n) => (await one(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'property_manager',true,'active','human_staff') returning id`, [tag + " " + n, `${tag}-${n}@example.com`])).id;
  const seat = async (user, prop) => pool.query(
    `insert into property_team_assignments (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof','property','{leasing,management}','{leasing}',false,true)`, [prop, user]);
  const session = async (user, prop) => {
    const c = await pool.connect();
    try { await c.query("begin");
      const s = await staffSessions.issueStaffSession(c, { userId: user, propertyId: prop, purpose: "sms_otp" });
      await c.query("commit"); return s.session_token;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  const here = await mkUser("Here"); await seat(here, propA); const tokHere = await session(here, propA);
  const there = await mkUser("There"); await seat(there, propB); const tokThere = await session(there, propB);
  const newRun = async () => {
    const run = (await one(`insert into ingest_runs (property_id, kind, source_text, model_raw_output) values ($1,'rent_roll',$2,'{}') returning id`, [propA, tag + " 1br 1500"])).id;
    const cand = (await one(`insert into ingest_candidates (run_id, property_id, unit_number, bedrooms, market_rent, decision_status)
                             values ($1,$2,$3,1,1500,'pending') returning id`, [run, propA, "U" + Math.floor(Math.random() * 1e5)])).id;
    return { run, cand };
  };
  const candidate = (id) => one("select decision_status, reviewed_by, promoted_by, promoted_unit_id from ingest_candidates where id=$1", [id]);
  const unitsAtA = async () => Number((await one("select count(*)::int n from units where property_id=$1", [propA])).n);

  console.log("\n── 1 · a session seated on ANOTHER property is refused, and nothing is written ──");
  const { run: r1, cand: c1 } = await newRun();
  const unitsBefore = await unitsAtA();
  const a1 = await call("POST", `/ingest/${r1}/approve`, { session: tokThere });
  let st = await candidate(c1);
  check("approve from a session seated elsewhere → 403 property_scope_refused (was: 200, candidate approved, reviewer recorded)",
        a1.status === 403 && a1.body && a1.body.error === "property_scope_refused", `${a1.status} ${J(a1.body)}`);
  check("…the candidate is still pending with no reviewer", st.decision_status === "pending" && st.reviewed_by === null, J(st));
  await pool.query("update ingest_candidates set decision_status='approved' where id=$1", [c1]); // stage it so promote has work to refuse
  const p1 = await call("POST", `/ingest/${r1}/promote`, { session: tokThere });
  st = await candidate(c1);
  check("promote from a session seated elsewhere → 403 property_scope_refused (was: 200, units created, promoter recorded)",
        p1.status === 403 && p1.body && p1.body.error === "property_scope_refused", `${p1.status} ${J(p1.body).slice(0, 160)}`);
  check("…no unit was created and the candidate is not promoted",
        (await unitsAtA()) === unitsBefore && st.decision_status === "approved" && st.promoted_by === null && st.promoted_unit_id === null, J(st));
  check("…the refusal is sayable and names a next step", /different property/.test(a1.body.receipt || "") && /nothing was/i.test(a1.body.receipt || ""), a1.body.receipt);

  console.log("\n── 2 · a session seated on THIS property performs the intended mutation ──");
  const { run: r2, cand: c2 } = await newRun();
  const a2 = await call("POST", `/ingest/${r2}/approve`, { session: tokHere });
  const p2 = await call("POST", `/ingest/${r2}/promote`, { session: tokHere });
  st = await candidate(c2);
  check("approve → 200 approved_count 1, reviewed_by is the seated user", a2.status === 200 && a2.body.approved_count === 1 && st.reviewed_by === here, `${a2.status} ${J(st)}`);
  check("promote → 200 promoted_count 1, promoted_by is the seated user, unit linked", p2.status === 200 && p2.body.promoted_count === 1 && st.promoted_by === here && !!st.promoted_unit_id, `${p2.status} ${J(st)}`);

  console.log("\n── 3 · the existing refusals are unchanged: body actor 400, unknown run 404 before the wall ──");
  const { run: r3 } = await newRun();
  const b3a = await call("POST", `/ingest/${r3}/approve`, { session: tokThere, body: { reviewed_by: here } });
  const b3b = await call("POST", `/ingest/${r3}/promote`, { session: tokThere, body: { promoted_by: here } });
  check("a body reviewed_by / promoted_by is still refused 400 body_actor_field_rejected, even from a wrongly seated session",
        b3a.status === 400 && b3a.body.error === "body_actor_field_rejected" && b3b.status === 400 && b3b.body.error === "body_actor_field_rejected", `${b3a.status}/${b3b.status}`);
  const nf = await call("POST", "/ingest/00000000-0000-0000-0000-000000000000/promote", { session: tokThere });
  check("an unknown run is still 404 run not found (existence is answered before scope, as before)", nf.status === 404, `${nf.status} ${J(nf.body)}`);

  console.log("\n── 4 · CLASSIFIED, NOT DECIDED: the key-only legacy path, and an unresolvable session ──");
  const { run: r4, cand: c4 } = await newRun();
  const a4 = await call("POST", `/ingest/${r4}/approve`, {});
  st = await candidate(c4);
  check("[classified legacy] key only, no session: approve still 200 with reviewed_by blank — preserved pending an owner ruling on retiring key-only access",
        a4.status === 200 && st.decision_status === "approved" && st.reviewed_by === null, `${a4.status} ${J(st)}`);
  const { run: r5, cand: c5 } = await newRun();
  const a5 = await call("POST", `/ingest/${r5}/approve`, { session: "not-a-real-session-token" });
  st = await candidate(c5);
  check("[classified] a presented session that does NOT resolve behaves exactly like no session today (200, blank reviewer) — recorded so it cannot drift silently",
        a5.status === 200 && st.decision_status === "approved" && st.reviewed_by === null, `${a5.status} ${J(st)}`);

  console.log("\n  NOTE: the key-only path (no app caller at 4849545, no governed consumer found) is preserved and");
  console.log("        classified as ungoverned legacy. Requiring a session, or retiring the door, changes the route's");
  console.log("        contract and is an owner ruling, not an inference made here.");
  await pool.end();
  console.log(`\n══ ingest property authority: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
