/*  ========================================================================
    extracted_route_bindings.e2e.js -- RETIRED DOCUMENT INGESTION BINDINGS.

    The eight legacy document-ingest routes and Deal Intake's bridge into the
    same pipeline are retained only as explicit 410 walls. The global operator
    key gate still runs first. The leasing-basis route in the extracted module
    remains live, as does the separately extracted POST /properties route.

    This proof runs against the real server and checks the mounted HTTP
    contract plus durable invariance. A retired route must not parse input,
    resolve an actor, look up a run, or write a candidate/unit.
    ======================================================================== */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
const baselineRoutes = require(path.join(ROOT, "src/baseline/baseline_routes.js"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  -- " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  -- " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const isRetired = (r) => r.status === 410 && r.body
  && r.body.code === "legacy_ingestion_retired"
  && r.body.next_action === "open_deal_setup"
  && /nothing was changed/i.test(r.body.receipt || "");
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
  try {
    await client.query("begin");
    token = (await staffSessions.issueStaffSession(client, { userId: user, propertyId: prop, purpose: "sms_otp" })).session_token;
    await client.query("commit");
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }

  const run = (await one(
    `insert into ingest_runs (property_id, kind, source_text, model_raw_output)
     values ($1,'rent_roll',$2,'{}') returning id`, [prop, tag + " 1br 1500"])).id;
  const cand = (await one(
    `insert into ingest_candidates (run_id, property_id, unit_number, bedrooms, market_rent, decision_status)
     values ($1,$2,$3,1,1500,'pending') returning id`, [run, prop, tag + "-U1"])).id;
  const intake = (await one(
    `insert into deal_intakes (onboarding_type, deal_name)
     values ('existing_asset',$1) returning id`, [tag + " Deal"])).id;
  const intakeFile = (await one(
    `insert into deal_intake_files
       (intake_id, original_filename, detected_document_type, source_category,
        classification_basis, registry_status, registry_property_id, extracted_text)
     values ($1,'retired-roll.csv','rent_roll','operating_setup','filename',
             'resolved',$2,$3) returning id`, [intake, prop, tag + " 1br 1500"])).id;
  const durable = async () => one(
    `select (select count(*)::int from ingest_runs) runs,
            (select count(*)::int from ingest_candidates) candidates,
            (select count(*)::int from units where property_id=$1) units,
            c.decision_status, c.reviewed_by, c.promoted_by, c.promoted_unit_id,
            f.ingest_run_id as deal_file_ingest_run_id
       from ingest_candidates c
       cross join deal_intake_files f
      where c.id=$2 and f.id=$3`, [prop, cand, intakeFile]);

  console.log("\n-- 1 - POST /properties remains session-authenticated ----------------");
  const p1 = await call("POST", "/properties", { body: { name: tag + " Unowned" } });
  check("key but no session -> 401 no_authenticated_actor",
    p1.status === 401 && p1.body && p1.body.reason === "no_authenticated_actor", `${p1.status} ${J(p1.body)}`);
  check("no property was created", !(await one("select 1 from properties where name=$1", [tag + " Unowned"])));

  const retired = [
    ["pasted-text ingest", "POST", `/properties/${prop}/ingest`, { rent_roll_text: tag }],
    ["file ingest", "POST", `/properties/${prop}/ingest-file`, {}],
    ["ingest run read", "GET", `/ingest/${run}`],
    ["candidate edit", "POST", `/ingest/${run}/candidates/${cand}/edit`, { unit_number: tag + "-EDIT" }],
    ["bed-group preview", "GET", `/ingest/${run}/bed-groups`],
    ["bed-group apply", "POST", `/ingest/${run}/group-bed-rows`, { confirm: true }],
    ["candidate promote", "POST", `/ingest/${run}/promote`, { promoted_by: user }],
    ["candidate approve", "POST", `/ingest/${run}/approve`, { reviewed_by: user }],
    ["Deal Intake rent-roll bridge", "POST", `/deal-intakes/${intake}/run-rentroll`,
      { file_id: intakeFile, property_id: prop }],
  ];

  console.log("\n-- 2 - the global key gate remains in front of every retired door ----");
  for (const [label, method, route, body] of retired) {
    const r = await call(method, route, { key: false, session: token, body });
    check(`${label}: session without operator key -> 401`, r.status === 401, `${r.status} ${J(r.body)}`);
  }

  console.log("\n-- 3 - authenticated legacy ingestion is uniformly retired ----------");
  const before = await durable();
  for (const [label, method, route, body] of retired) {
    const r = await call(method, route, { session: token, body });
    check(`${label} -> 410 legacy_ingestion_retired`,
      isRetired(r), `${r.status} ${J(r.body)}`);
  }
  const after = await durable();
  check("retired reads and writes leave runs, candidates, actors and units unchanged",
    J(after) === J(before), `before=${J(before)} after=${J(after)}`);

  console.log("\n-- 4 - leasing basis is the explicit live exception -----------------");
  const basis = await call("POST", `/properties/${prop}/leasing-basis`, { body: { leasing_basis: "bed" } });
  const storedBasis = await one("select leasing_basis from properties where id=$1", [prop]);
  check("POST /properties/:id/leasing-basis remains live",
    basis.status === 200 && basis.body && basis.body.leasing_basis === "bed" && storedBasis.leasing_basis === "bed",
    `${basis.status} ${J(basis.body)} stored=${J(storedBasis)}`);

  const health = await fetch(API + "/health");
  check("server remains healthy after the refusal matrix", health.status === 200, String(health.status));

  console.log("\n-- 5 - the unrelated baseline extraction still fails fast ----------");
  let threwBaseline = null;
  try { baselineRoutes({ pool, spawnObligationFromEvent: async () => ({}) }); } catch (e) { threwBaseline = e; }
  check("baselineRoutes without staffSessions throws at construction",
    threwBaseline && /staffSessions/.test(threwBaseline.message), threwBaseline && threwBaseline.message);

  await pool.end();
  console.log(`\n== extracted route bindings: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("HARNESS ERROR:", e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
