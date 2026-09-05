"use strict";

// Real mounted HTTP proof. The unchanged pre-retirement server must positively
// approve AND promote with only the shared key. The successor must refuse all
// nine retired doors with unchanged retained evidence and canonical records.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const boundary = require("./proof_boundary.js");
const owned = boundary.manifest();
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service.js");
const pool = new Pool({ connectionString: owned.url, ssl: false });
const API = process.env.E2E_API_BASE;
boundary.origin(API);
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const parent = process.env.PROOF_EXPECT_LEGACY_OPEN === "1";
const unconfigured = process.env.E2E_WITHOUT_OPERATOR_KEY === "1";
assert.ok(!(parent && unconfigured), "parent witness requires a configured shared key");
const expectedCommit = process.env.E2E_EXPECT_SERVER_COMMIT;
assert.match(expectedCommit || "", /^[a-f0-9]{40}$/, "exact expected runtime SHA required");
const one = async (sql, values) => (await pool.query(sql, values)).rows[0];
let passed = 0;
function check(label, condition, detail) {
  assert.ok(condition, `${label}: ${JSON.stringify(detail)}`);
  passed++;
  console.log(`PASS ${label}`);
}
async function call(method, path, { body, key = true, token, upload = false } = {}) {
  const headers = {};
  if (key) headers["x-operator-key"] = KEY;
  if (token) headers["x-staff-session"] = token;
  let payload;
  if (upload) {
    payload = new FormData();
    payload.append("file", new Blob(["Unit,Beds,Market Rent\nA,1,1500\n"], { type: "text/csv" }), "retained-proof.csv");
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(API + path, {
    method, headers, body: payload, signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
async function snapshot() {
  const state = {};
  // Entire retained rows, not just counts: catches overwrites and deletes too.
  for (const table of ["properties", "ingest_runs", "ingest_candidates", "deal_intakes",
    "deal_intake_files", "units", "spaces", "persons", "leases", "events", "documents"]) {
    state[table] = (await one(`select md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' order by id),'')) digest from ${table} t`)).digest;
  }
  return JSON.stringify(state);
}
function providerState() {
  return ["E2E_ANTHROPIC_LOG", "E2E_SMS_LOG"].map((name) => {
    assert.ok(process.env[name], `${name} must identify the sentinel log`);
    return fs.readFileSync(process.env[name], "utf8");
  });
}

(async () => {
  await boundary.assertDatabase(owned);
  const tag = `Retire-${randomUUID()}`;
  const property = await one("insert into properties(name,address) values($1,'1 Proof Way') returning id", [tag]);
  const user = await one(`insert into users(name,email,role,is_active,status,account_kind)
    values($1,$2,'property_manager',true,'active','human_staff') returning id`, [tag, `${tag}@example.com`]);
  await pool.query(`insert into property_team_assignments
    (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
    values($1,$2,'Proof','property','{leasing,management}','{leasing}',false,true)`, [property.id, user.id]);
  const client = await pool.connect();
  let token;
  try {
    await client.query("begin");
    token = (await staffSessions.issueStaffSession(client, { userId: user.id, propertyId: property.id, purpose: "sms_otp" })).session_token;
    await client.query("commit");
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
  const build = await call("GET", "/operator/build", { token });
  check("runtime build receipt is accessible", build.status === 200, build);
  const commit = build.body.build && build.body.build.commit;
  check("receipt names the exact expected revision", commit === expectedCommit, { commit, expectedCommit });
  console.log(`PROOF_RUNTIME=${commit} mode=${parent ? "expected-legacy-open" : unconfigured ? "key-unconfigured" : "retired"}`);

  const run = await one(`insert into ingest_runs(property_id,kind,source_text,model_raw_output)
    values($1,'rent_roll','Original source evidence','{}') returning id`, [property.id]);
  const candidate = await one(`insert into ingest_candidates(run_id,property_id,unit_number,bedrooms,market_rent,decision_status)
    values($1,$2,'Proof A',1,1500,'pending') returning id`, [run.id, property.id]);
  const intake = await one("insert into deal_intakes(onboarding_type) values('existing_asset') returning id");
  const file = await one(`insert into deal_intake_files(intake_id,original_filename,detected_document_type,extracted_text,ingest_run_id,registry_status,registry_property_id)
    values($1,'original-rent-roll.csv','rent_roll','Unit,Beds,Rent\nProof A,1,1500',$2,'resolved',$3) returning id`, [intake.id, run.id, property.id]);
  const providers = providerState();

  if (parent) {
    const approve = await call("POST", `/ingest/${run.id}/approve`, { body: {} });
    check("EXPECTED LEGACY OPEN: key-only approval succeeds", approve.status === 200 && approve.body.approved_count === 1, approve);
    const reviewed = await one("select decision_status,reviewed_by from ingest_candidates where id=$1", [candidate.id]);
    check("approval persisted without a staff actor", reviewed.decision_status === "approved" && reviewed.reviewed_by === null, reviewed);
    const promote = await call("POST", `/ingest/${run.id}/promote`, { body: {} });
    check("EXPECTED LEGACY OPEN: key-only promotion succeeds", promote.status === 200 && promote.body.promoted_count === 1, promote);
    const persisted = await one(`select c.decision_status,c.promoted_by,u.unit_number,u.property_id
      from ingest_candidates c join units u on u.id=c.promoted_unit_id where c.id=$1`, [candidate.id]);
    check("promotion committed a real unit without a staff actor", persisted && persisted.decision_status === "promoted"
      && persisted.promoted_by === null && persisted.property_id === property.id && persisted.unit_number === "Proof A", persisted);
    console.log("EXPECTED LEGACY OPEN PROVEN: successful HTTP plus durable approval and promotion; not a setup failure.");
  } else {
    const approvedRun = await one(`insert into ingest_runs(property_id,kind,source_text,model_raw_output)
      values($1,'rent_roll','Approved historical source','{}') returning id`, [property.id]);
    await pool.query(`insert into ingest_candidates(run_id,property_id,unit_number,bedrooms,market_rent,decision_status)
      values($1,$2,'Proof B',1,1500,'approved')`, [approvedRun.id, property.id]);
    const uploadedIntake = await one("insert into deal_intakes(onboarding_type) values('existing_asset') returning id");
    for (const [intakeId, types] of [[intake.id, ["t12", "insurance", "tax_bill"]],
      [uploadedIntake.id, ["rent_roll", "t12", "insurance", "tax_bill"]]]) {
      for (const type of types) {
        await pool.query(`insert into deal_intake_files(intake_id,original_filename,detected_document_type,registry_status,registry_property_id)
          values($1,$2,$3,'resolved',$4)`, [intakeId, `proof-${type}.txt`, type, property.id]);
      }
    }
    const before = await snapshot();
    const routes = [
      ["POST", `/properties/${property.id}/ingest`, { body: { rent_roll_text: "Proof A 1br 1500" } }],
      ["POST", `/properties/${property.id}/ingest-file`, { upload: true }],
      ["GET", `/ingest/${run.id}`, {}],
      ["POST", `/ingest/${run.id}/candidates/${candidate.id}/edit`, { body: { bedrooms: 4, market_rent: 9999 } }],
      ["GET", `/ingest/${run.id}/bed-groups`, {}],
      ["POST", `/ingest/${run.id}/group-bed-rows`, { body: {} }],
      ["POST", `/ingest/${run.id}/approve`, { body: {} }],
      ["POST", `/ingest/${approvedRun.id}/promote`, { body: {} }],
      ["POST", `/deal-intakes/${intake.id}/run-rentroll`, { body: { file_id: file.id, property_id: property.id, leasing_basis: "bed" } }],
    ];
    for (const [method, path, options] of routes) {
      const anonymous = await call(method, path, { ...options, key: false });
      check(`${method} ${path}: existing anonymous gate remains ${unconfigured ? 503 : 401}`, anonymous.status === (unconfigured ? 503 : 401), anonymous);
      const response = await call(method, path, options);
      if (unconfigured) {
        check(`${method} ${path}: unconfigured server refuses even a supplied key before the route`, response.status === 503
          && /Operator routes are locked/.test(response.body.receipt || "") && !response.body.code, response);
      } else {
        check(`${method} ${path}: retired 410 with canonical next action`, response.status === 410
          && response.body.code === "legacy_ingestion_retired" && response.body.next_action === "open_deal_setup", response);
      }
      check("all retained rows and canonical records unchanged", await snapshot() === before);
    }
    if (unconfigured) {
      check("no model or SMS invocation occurred", JSON.stringify(providerState()) === JSON.stringify(providers));
      console.log(`Legacy ingestion unconfigured-key refusal: ${passed} assertions passed`);
      return;
    }
    const malformed = await call("POST", "/ingest/not-a-run/promote", { body: { promoted_by: "not-an-actor" } });
    check("retirement precedes run lookup and actor parsing", malformed.status === 410 && malformed.body.code === "legacy_ingestion_retired", malformed);
    check("malformed request also preserves all rows", await snapshot() === before);
    for (const intakeId of [intake.id, uploadedIntake.id]) {
      const summary = await call("GET", `/deal-intakes/${intakeId}/summary`);
      check("retained intake summary points to canonical Deal Setup", summary.status === 200
        && summary.body.next_actions.some((a) => a.action === "open_deal_setup")
        && !summary.body.next_actions.some((a) => ["run_rentroll", "review_candidates"].includes(a.action)), summary);
    }
    const funnel = await call("GET", "/deal-funnel");
    check("retained funnel remains readable", funnel.status === 200, funnel);
    for (const [intakeId, state] of [[intake.id, "ingested"], [uploadedIntake.id, "uploaded"]]) {
      const deal = funnel.body.board.find((d) => d.intake_id === intakeId);
      check("funnel preserves historical state and directs to Deal Setup", deal && deal.rent_roll === state
        && deal.next.action === "open_deal_setup", deal);
    }
    check("funnel names Deal Setup review rather than an available legacy ingest stage",
      funnel.body.stages.deal_setup_review >= 1 && !Object.hasOwn(funnel.body.stages, "ready_to_ingest"), funnel.body.stages);
    check("summary and funnel reads preserve retained evidence", await snapshot() === before);
    // The independent basis setter was never part of the retirement ruling.
    const basis = await call("POST", `/properties/${property.id}/leasing-basis`, { body: { leasing_basis: "unit" } });
    check("independent leasing-basis setter is preserved", basis.status === 200 && basis.body.leasing_basis === "unit", basis);
    check("leasing-basis change persisted", (await one("select leasing_basis from properties where id=$1", [property.id])).leasing_basis === "unit");
  }
  check("no model or SMS invocation occurred", JSON.stringify(providerState()) === JSON.stringify(providers));
  console.log(`Legacy ingestion ${parent ? "parent witness" : "retirement"}: ${passed} assertions passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
