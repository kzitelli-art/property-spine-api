"use strict";

// A published opening position is immutable. Confirmation, rejection,
// identity resolution and establishment serialize on the activation row, and
// no proposal decision may change after that setup becomes established.
const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Pool } = require("pg");
const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const activation = require(path.join(root, "src/onboarding/activation_service.js"));

const HARNESS = "canonical_onboarding_lifecycle.db.js";
const EXPECTED = parent ? 7 : 10;
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const one = async (pool, sql, params = []) => (await pool.query(sql, params)).rows[0];
async function refused(label, action, reason) {
  try {
    await action();
    ok(label, false, "request unexpectedly succeeded");
  } catch (error) {
    ok(label, error && (error.reason === reason || error.code === reason),
      `${error && (error.reason || error.code)}: ${error && error.message}`);
  }
}

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root, encoding: "utf8", windowsHide: true,
  }).trim();
  if (parent) {
    assert.equal(sha, "e09c5411e2c072c3452e48b434a9f8a8250ce1bb");
    execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "src", "server.js", "migrations"], {
      cwd: root, windowsHide: true, stdio: "pipe",
    });
  }
  console.log(`LIFECYCLE_PROOF_MODE=${parent ? "positive_parent_defect" : "successor"}; BUSINESS_SHA=${sha}`);
  const local = /^(localhost|127\.0\.0\.1)$/i.test(new URL(CONN).hostname);
  const pool = new Pool({ connectionString: CONN, ssl: local ? false : { rejectUnauthorized: false } });
  try {
    const tag = `opening-lifecycle-${Date.now()}`;
    const org = (await one(pool, "insert into organizations(name) values($1) returning id", [tag])).id;
    const user = (await one(pool,
      `insert into users(name,email,is_active,status,platform_role,organization_id)
       values('Opening lifecycle proof',$1,true,'active','super_admin',$2) returning id`,
      [`${tag}@example.invalid`, org])).id;
    const property = (await one(pool,
      `insert into properties(name,address,organization_id,leasing_basis)
       values($1,'2 Lifecycle Way',$2,'unit') returning id`, [tag, org])).id;
    const deal = (await one(pool,
      `insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
       values('existing_asset','classified',$1,$2) returning id`, [tag, org])).id;
    await pool.query(
      "insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')",
      [deal, property]);
    const batch = (await one(pool,
      `insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
       values($1,'rent_roll_ledger','lifecycle.csv','2026-07-31','unit','extracted','committed') returning id`,
      [property])).id;
    const setup = (await one(pool,
      `insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
       values($1,$2,'open','2026-07-31',$3,$4) returning id`,
      [deal, property, batch, user])).id;
    const promoted = (await one(pool,
      `insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status)
       values($1,$2,'leasing','lease','101',$3,'promoted') returning id`,
      [setup, property, JSON.stringify({ section: "current", unit_number: "101", is_vacant: true })])).id;
    const stagedConfirm = (await one(pool,
      `insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status)
       values($1,$2,'leasing','lease','102',$3,'staged') returning id`,
      [setup, property, JSON.stringify({ section: "current", unit_number: "102", is_vacant: true })])).id;
    const stagedReject = (await one(pool,
      `insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status)
       values($1,$2,'leasing','lease','103',$3,'staged') returning id`,
      [setup, property, JSON.stringify({ section: "current", unit_number: "103", is_vacant: true })])).id;
    await pool.query(
      `insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status)
       values($1,$2,'leasing','person','person:102',$3,'promoted')`,
      [setup, property, JSON.stringify({ name: "Identity candidate only" })]);

    const established = await activation.establishOpeningPosition(pool, {
      user_id: user, activation_id: setup,
    });
    ok("opening position is established", !!(established && established.opening_position));
    if (parent) {
      ok("parent baseline falsely records no unresolved staged claims",
        established.opening_position.positions_unresolved === 0,
        JSON.stringify(established.opening_position));
      await activation.confirmProposal(pool, { user_id: user, proposed_id: stagedConfirm });
      ok("parent actually mutates a proposal after establishment by confirming it",
        (await one(pool, "select status from proposed_records where id=$1", [stagedConfirm])).status === "promoted");
      await activation.rejectProposal(pool, { user_id: user, proposed_id: stagedReject });
      ok("parent actually mutates a proposal after establishment by rejecting it",
        (await one(pool, "select status from proposed_records where id=$1", [stagedReject])).status === "rejected");
      const frozen = await one(pool,
        "select positions_unresolved,status from opening_tenancy_positions where activation_id=$1", [setup]);
      ok("published parent baseline remains stale after both proposal mutations",
        frozen.status === "established" && frozen.positions_unresolved === 0, JSON.stringify(frozen));
      ok("parent setup remains marked activated despite mutable published inputs",
        (await one(pool, "select status from activations where id=$1", [setup])).status === "activated");
      const final = await one(pool,
        `select (select count(*) from opening_tenancy_positions where activation_id=$1)::int openings,
                (select count(*) from leases where property_id=$2)::int leases`, [setup, property]);
      ok("parent witness changes proposal decisions without creating another baseline",
        final.openings === 1 && final.leases === 0, JSON.stringify(final));
    } else {
      ok("only promoted lease claims count as established",
        established.opening_position.positions_established === 1,
        JSON.stringify(established.opening_position));
      ok("every unconfirmed staged lease remains unresolved",
        established.opening_position.positions_unresolved === 2,
        JSON.stringify(established.opening_position));
      ok("person proposals do not inflate source-position totals",
        established.opening_position.source_rows_read === 3,
        JSON.stringify(established.opening_position));
      ok("establishment closes the setup",
        (await one(pool, "select status from activations where id=$1", [setup])).status === "activated");

      await refused("confirmation after establishment is refused",
        () => activation.confirmProposal(pool, { user_id: user, proposed_id: stagedConfirm }), "setup_not_open");
      await refused("rejection after establishment is refused",
        () => activation.rejectProposal(pool, { user_id: user, proposed_id: stagedReject }), "setup_not_open");
      await refused("the same setup cannot establish a second baseline",
        () => activation.establishOpeningPosition(pool, { user_id: user, activation_id: setup }), "setup_not_open");

      const statuses = (await pool.query(
        "select id,status from proposed_records where id=any($1::uuid[])", [[stagedConfirm, stagedReject]])).rows;
      ok("refused lifecycle writes leave both proposals unchanged",
        statuses.length === 2 && statuses.every(row => row.status === "staged"), JSON.stringify(statuses));
      const final = await one(pool,
        `select (select count(*) from opening_tenancy_positions where activation_id=$1)::int openings,
                (select count(*) from leases where property_id=$2)::int leases`, [setup, property]);
      ok("published baseline remains singular and no lease appears afterward",
        final.openings === 1 && final.leases === 0, JSON.stringify(final));
    }

    // Keep the promoted variable visibly tied to the fixture: the established
    // count above must have had one concrete lease claim as its source.
    if (!promoted) throw new Error("promoted fixture was not created");
  } catch (error) {
    failed++;
    console.error("  FAIL  harness threw  →  " + (error && error.stack ? error.stack : error));
  } finally {
    await pool.end();
  }
  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})().catch((error) => process.exit(receipt.died(HARNESS, error, passed + failed)));
