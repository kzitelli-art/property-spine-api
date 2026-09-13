/*
 * One deliberately retained negative source amount must never become a
 * trusted contractual obligation.  This is a reader proof: it does not
 * rewrite the source row or the lease, reject an import, or change a writer.
 *
 * REAL: the migration-built harness database, canonical readers, the real
 * Ask router, a real staff session, and a loopback HTTP request.
 * STUBBED: the model transport captures its supplied facts; no provider call.
 */
"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");
const boundary = require("../e2e/proof_boundary.js");

const CONN = receipt.harnessConnectionString();
boundary.manifest();
const PORT = Number(process.env.PROOF_HTTP_PORT || 3353);
const RUN_TAG = crypto.randomBytes(12).toString("hex");
const ORG = `Negative Contract Rent Reader Proof ${RUN_TAG}`;
const EMAIL = `negative-contract-rent-${RUN_TAG}@proof.test`;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
let passed = 0, failed = 0, ran = 0;

function check(label, actual, expected) {
  ran++;
  try {
    assert.deepEqual(actual, expected);
    passed++;
    console.log(`  ok    ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);
  }
}

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port: PORT, path, method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } },
    (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try { resolve({ status: response.statusCode, json: JSON.parse(raw) }); }
        catch (_) { resolve({ status: response.statusCode, raw }); }
      });
    });
    request.once("error", reject);
    request.end(payload);
  });
}

async function cleanup(pool) {
  const rows = (await pool.query(
    "select p.id from properties p join organizations o on o.id=p.organization_id where o.name=$1", [ORG]
  )).rows;
  for (const { id } of rows) {
    await pool.query("delete from staff_sessions where property_id=$1", [id]);
    await pool.query("delete from property_team_assignments where property_id=$1", [id]);
    await pool.query("delete from leases where property_id=$1", [id]);
    await pool.query("delete from import_source_rows where import_batch_id in (select id from import_batches where property_id=$1)", [id]);
    await pool.query("delete from import_batches where property_id=$1", [id]);
    await pool.query("delete from spaces where unit_id in (select id from units where property_id=$1)", [id]);
    await pool.query("delete from units where property_id=$1", [id]);
    await pool.query("delete from properties where id=$1", [id]);
  }
  await pool.query("delete from users where email=$1", [EMAIL]);
  await pool.query("delete from organizations where name=$1", [ORG]);
}

receipt.begin(__filename, { url: CONN, expected: 15 });
(async () => {
  const pool = new Pool({ connectionString: CONN });
  let server;
  try {
    await boundary.assertDatabase();
    const today = new Date().toISOString().slice(0, 10);
    const org = (await pool.query("insert into organizations(name) values($1) returning id", [ORG])).rows[0].id;
    const property = (await pool.query(
      "insert into properties(name,address,organization_id,leasing_basis) values('Negative Contract Fixture','1 Test Way',$1,'unit') returning id", [org]
    )).rows[0].id;
    const unit = (await pool.query(
      "insert into units(property_id,unit_number,occupancy_status) values($1,'N-1','occupied') returning id", [property]
    )).rows[0].id;
    // The unit writer creates its physical whole-unit position. Read that
    // actual position instead of making a competing duplicate fixture row.
    const space = (await pool.query(
      "select id from spaces where unit_id=$1 order by created_at, id limit 1", [unit]
    )).rows[0].id;
    const batch = (await pool.query(
      "insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status) values($1,'rent_roll_ledger','negative-contract.csv',$2,'unit','confirmed','committed') returning id",
      [property, today]
    )).rows[0].id;
    await pool.query(
      "insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id) values($1,1,$2::jsonb,'retained negative source amount',$3,$4) returning id",
      [batch, JSON.stringify({ unit_number: "N-1", actual_rent: -375 }), unit, space]
    );
    await pool.query(
      "insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status,import_batch_id,source_type,source_as_of_date,confidence) values($1,$2,'{}'::uuid[],-375,$3::date,$4::date,'active',$5,'historical_snapshot',$3,'confirmed')",
      [property, space, today, "2099-12-31", batch]
    );
    const user = (await pool.query(
      "insert into users(name,email,role,is_active,status,account_kind) values('Reader Operator',$1,'property_manager',true,'active','human_staff') returning id", [EMAIL]
    )).rows[0].id;
    await pool.query(
      "insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Reader Operator','{leasing}'::text[],true)",
      [property, user]
    );
    const token = crypto.randomBytes(24).toString("hex");
    await pool.query(
      "insert into staff_sessions(user_id,property_id,token_digest,issuance_purpose,expires_at) values($1,$2,$3,'bootstrap_invite',now()+interval '1 hour')",
      [user, property, digest(token)]
    );

    const { currentRentRoll } = require("../../src/surfaces/rent_roll_canonical.js");
    const { institutionalRentRoll, institutionalCsv } = require("../../src/surfaces/rent_roll_institutional.js");
    const { unitRentRoll } = require("../../src/surfaces/rent_roll_unit_view.js");
    const { readTenancyStanding } = require("../../src/tenancy/tenancy_position_read.js");
    const current = await currentRentRoll(pool, { property_id: property, as_of: today });
    const institutional = await institutionalRentRoll(pool, { property_id: property, as_of: today });
    const screen = await unitRentRoll(pool, { property_id: property, as_of: today });
    const standing = await readTenancyStanding(pool, { property_id: property, as_of: today });
    const row = current.rows.find((item) => String(item.space_id) === String(space));
    const screenPosition = screen.units.flatMap((item) => item.positions).find((item) => String(item.space_id) === String(space));

    const retainedRaw = (await pool.query("select raw from import_source_rows where import_batch_id=$1 and row_index=1", [batch])).rows[0].raw;
    check("the retained source row still carries its negative amount", Number(retainedRaw.actual_rent), -375);
    check("the retained source amount remains negative", row.current_rent, -375);
    check("physical inventory remains one unit and one position", [current.inventory, current.totals.leasable], [1, 1]);
    check("the lease still establishes contractual occupancy", row.tenancy_state, "contractually_occupied");
    check("the unit view preserves the raw negative amount", screenPosition.current.rent.amount, -375);
    check("the unit view relays unavailable economics", screenPosition.economics_state, "unavailable");
    check("negative contract amount contributes no trusted rent", [row.contributes_trusted_rent, current.totals.positions_contributing_rent], [false, 0]);
    check("no trusted total is fabricated when every amount is unavailable", current.totals.contractual_rent_trusted, null);
    check("institutional total is the canonical null", institutional.totals.trusted_monthly_contractual_rent, null);
    check("institutional CSV leaves unknown trusted total blank", institutionalCsv(institutional).includes("Trusted monthly contractual rent,\n"), true);
    check("existing no-recorded-rent meaning remains null-only", standing.unknowns.occupied_positions_with_no_recorded_rent, 0);
    check("standing adds unavailable contract economics without renaming no-recorded-rent", standing.unknowns.occupied_positions_with_unavailable_contract_economics, 1);

    const calls = [];
    const anthropic = { messages: { create: async (input) => {
      calls.push(input);
      return { content: [{ type: "text", text: JSON.stringify({ outcome: "answered", answer: "stubbed" }) }] };
    } } };
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(require("../../src/agent/ask_spine.js")({ pool, anthropic }));
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(PORT, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    });
    const answer = await post("/operator/ask-spine/ask", { question: "what tenancy economics are unavailable" }, { "x-staff-session": token });
    const sent = calls[0] && String(calls[0].messages[0].content);
    const facts = sent && JSON.parse(sent.slice(sent.indexOf("{"), sent.lastIndexOf("}") + 1));
    check("Ask receives the real answered tenancy read over loopback HTTP", [answer.status, answer.json && answer.json.outcome, calls.length], [200, "answered", 1]);
    check("Ask receives canonical no-recorded-rent and unavailable-economics counts", facts && facts.tenancy && facts.tenancy.unknowns, standing.unknowns);
    check("the configured local model stub is the only model transport invoked", calls.length, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await cleanup(pool);
    await pool.end();
  }
  process.exit(receipt.complete({ harness: __filename, passed, failed, expectedAtLeast: 15 }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(receipt.died(__filename, error, ran));
});
