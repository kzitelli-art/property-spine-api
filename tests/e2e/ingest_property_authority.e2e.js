/*  ========================================================================
    ingest_property_authority.e2e.js -- THE RETIRED INGESTION WALL.

    Legacy approve/promote no longer have a property-authority contract: both
    operations are retired for every authenticated caller. The global operator
    key gate remains first; after that gate, session validity, property scope,
    run existence and body-supplied actors must not change the uniform 410.

    Runs against the real server and proves every refusal leaves the candidate,
    actor columns and canonical unit count unchanged.
    ======================================================================== */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  -- " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  -- " + d : ""}`); };
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
const isRetired = (r) => r.status === 410 && r.body
  && r.body.code === "legacy_ingestion_retired"
  && r.body.next_action === "open_deal_setup"
  && /nothing was changed/i.test(r.body.receipt || "");

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
    try {
      await c.query("begin");
      const s = await staffSessions.issueStaffSession(c, { userId: user, propertyId: prop, purpose: "sms_otp" });
      await c.query("commit");
      return s.session_token;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  };
  const here = await mkUser("Here"); await seat(here, propA); const tokHere = await session(here, propA);
  const there = await mkUser("There"); await seat(there, propB); const tokThere = await session(there, propB);

  let fixtureNumber = 0;
  const newRun = async (status = "pending") => {
    fixtureNumber++;
    const run = (await one(
      `insert into ingest_runs (property_id, kind, source_text, model_raw_output)
       values ($1,'rent_roll',$2,'{}') returning id`, [propA, `${tag} ${fixtureNumber}`])).id;
    const cand = (await one(
      `insert into ingest_candidates (run_id, property_id, unit_number, bedrooms, market_rent, decision_status)
       values ($1,$2,$3,1,1500,$4) returning id`, [run, propA, `${tag}-U${fixtureNumber}`, status])).id;
    return { run, cand };
  };
  const state = async (id) => one(
    `select c.decision_status, c.reviewed_by, c.reviewed_at, c.promoted_by,
            c.promoted_at, c.promoted_unit_id,
            (select count(*)::int from units where property_id=$2) units
       from ingest_candidates c where c.id=$1`, [id, propA]);
  const unchanged = async (label, id, before) => {
    const after = await state(id);
    check(`${label}: candidate, actor receipts and units unchanged`, J(after) === J(before),
      `before=${J(before)} after=${J(after)}`);
  };

  console.log("\n-- 1 - wrong-property and same-property sessions meet one wall -------");
  for (const [label, token] of [["wrong-property session", tokThere], ["same-property session", tokHere]]) {
    const approve = await newRun();
    let before = await state(approve.cand);
    const a = await call("POST", `/ingest/${approve.run}/approve`, { session: token });
    check(`${label}: approve -> 410 legacy_ingestion_retired`, isRetired(a), `${a.status} ${J(a.body)}`);
    await unchanged(`${label} approve`, approve.cand, before);

    const promote = await newRun("approved");
    before = await state(promote.cand);
    const p = await call("POST", `/ingest/${promote.run}/promote`, { session: token });
    check(`${label}: promote -> 410 legacy_ingestion_retired`, isRetired(p), `${p.status} ${J(p.body)}`);
    await unchanged(`${label} promote`, promote.cand, before);
  }

  console.log("\n-- 2 - body actors and invalid sessions cannot enter legacy logic ----");
  const actorApprove = await newRun();
  let before = await state(actorApprove.cand);
  const ba = await call("POST", `/ingest/${actorApprove.run}/approve`, {
    session: tokThere, body: { reviewed_by: here },
  });
  check("body reviewed_by is absorbed by the retired wall, not parsed as a 400", isRetired(ba), `${ba.status} ${J(ba.body)}`);
  await unchanged("body-actor approve", actorApprove.cand, before);

  const actorPromote = await newRun("approved");
  before = await state(actorPromote.cand);
  const bp = await call("POST", `/ingest/${actorPromote.run}/promote`, {
    session: tokThere, body: { promoted_by: here },
  });
  check("body promoted_by is absorbed by the retired wall, not parsed as a 400", isRetired(bp), `${bp.status} ${J(bp.body)}`);
  await unchanged("body-actor promote", actorPromote.cand, before);

  const invalid = await newRun();
  before = await state(invalid.cand);
  const invalidResponse = await call("POST", `/ingest/${invalid.run}/approve`, { session: "not-a-real-session-token" });
  check("invalid presented session still reaches the uniform retired wall", isRetired(invalidResponse),
    `${invalidResponse.status} ${J(invalidResponse.body)}`);
  await unchanged("invalid-session approve", invalid.cand, before);

  console.log("\n-- 3 - key-only is retired; missing key still fails first ------------");
  const keyOnly = await newRun();
  before = await state(keyOnly.cand);
  const ko = await call("POST", `/ingest/${keyOnly.run}/approve`);
  check("operator key with no session -> 410 legacy_ingestion_retired", isRetired(ko), `${ko.status} ${J(ko.body)}`);
  await unchanged("key-only approve", keyOnly.cand, before);

  const noKey = await newRun("approved");
  before = await state(noKey.cand);
  const nk = await call("POST", `/ingest/${noKey.run}/promote`, { key: false, session: tokHere });
  check("session without operator key -> 401 before retirement handler", nk.status === 401, `${nk.status} ${J(nk.body)}`);
  await unchanged("no-key promote", noKey.cand, before);

  console.log("\n-- 4 - retirement precedes run lookup -------------------------------");
  const nf = await call("POST", "/ingest/00000000-0000-0000-0000-000000000000/promote", { session: tokThere });
  check("unknown run -> 410 without existence disclosure", isRetired(nf), `${nf.status} ${J(nf.body)}`);

  await pool.end();
  console.log(`\n== ingest retirement authority: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("HARNESS ERROR:", e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
