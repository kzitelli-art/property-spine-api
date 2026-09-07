/*
 * opening_claim_relay_edges.db.js - edge witnesses for the retained opening
 * claim relay. Synthetic only; no confirmation path or production data.
 *
 * Default mode asserts the successor contract. PROOF_EXPECT_DEFECT=1 runs
 * against the parent source and records the pre-repair behavior instead.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const { datedPropertyPositions } = require(path.join(root, "src/tenancy/dated_positions.js"));
const { unitRentRoll } = require(path.join(root, "src/surfaces/rent_roll_unit_view.js"));
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const { gatherFacts } = require(path.join(root, "src/agent/ask_spine_answer.js"));
const retirement = require(path.join(root, "src/tenancy/inventory_retirement.js"));
const sessions = require(path.join(root, "src/identity/staff_session_service.js"));

const AS_OF = "2026-07-31";
let passed = 0;
let failed = 0;
const evidence = [];
function ok(label, condition, detail = "") {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ""}`); }
}

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  try {
    const tag = `relay-edges-${randomUUID()}`;
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const person = await one("insert into persons(name) values('Synthetic Relay Operator') returning id");
    const user = await one(`insert into users(name,email,is_active,status,platform_role,organization_id,person_id,account_kind)
      values('Synthetic Relay Operator',$1,true,'active','org_admin',$2,$3,'human_staff') returning id`,
      [`${tag}@example.invalid`, org.id, person.id]);
    const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`, [tag, org.id]);
    const httpFixtures = [];
    const browserFixtures = [];
    async function verifyHttp(propertyId, expectedCount, truncated, revoke = false) {
      if (process.env.PROOF_RELAY_HTTP !== "1") return;
      const api = process.env.E2E_API_BASE;
      assert.match(api, /^http:\/\/127\.0\.0\.1:\d+$/);
      await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof Manager','{management}',true)", [propertyId,user.id]);
      const client = await pool.connect();
      let token;
      try {
        await client.query("begin");
        token = (await sessions.issueStaffSession(client, { userId:user.id, propertyId, purpose:"sms_otp" })).session_token;
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
      const get = async suffix => {
        const response = await fetch(api + "/operator/rent-roll/units?as_of=" + AS_OF + suffix,
          { headers:{"x-staff-session":token}, signal:AbortSignal.timeout(30000) });
        return { status:response.status, body:await response.json() };
      };
      assert.equal((await get("")).status,403);
      ok("HTTP refuses management-only access to the leasing Rent Roll",true);
      await pool.query("update property_team_assignments set allowed_modules='{management,leasing}' where property_id=$1 and user_id=$2",[propertyId,user.id]);
      const result = await get("");
      assert.equal(result.status,200);
      assert.equal(result.body.property_id,propertyId);
      assert.equal(result.body.totals.confirmed_rows_not_attached,expectedCount);
      assert.equal(result.body.unattached_source_rows.length,Math.min(expectedCount,50));
      assert.equal(result.body.unattached_source_rows_truncated,truncated);
      ok(`HTTP carries retained count ${expectedCount} and bounded-list metadata`,true);
      if (httpFixtures.length) {
        const retargeted = await get("&property_id=" + httpFixtures[0]);
        assert.equal(retargeted.status,200);
        assert.equal(retargeted.body.property_id,propertyId);
        assert.equal(retargeted.body.totals.confirmed_rows_not_attached,expectedCount);
        ok("HTTP query cannot retarget the signed-in property",true);
      }
      httpFixtures.push(propertyId);
      browserFixtures.push({token, property_id:propertyId, expected_count:expectedCount,
        expected_truncated:truncated, expected_positions:result.body.totals.rentable_positions});
      if (revoke) {
        await pool.query("update property_team_assignments set allowed_modules='{management}' where property_id=$1 and user_id=$2",[propertyId,user.id]);
        assert.equal((await get("")).status,403);
        ok("HTTP refuses retained claim reads after leasing entitlement removal",true);
        await pool.query("update property_team_assignments set allowed_modules='{management,leasing}' where property_id=$1 and user_id=$2",[propertyId,user.id]);
      }
    }

    async function property(name, basis = "unit") {
      const p = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
        values($1,$1,$2,$3) returning id`, [`${tag}-${name}`, org.id, basis]);
      await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')",
        [deal.id, p.id]);
      return p.id;
    }
    async function unit(propertyId, number, label = "(whole unit)") {
      const u = await one("insert into units(property_id,unit_number) values($1,$2) returning id",
        [propertyId, number]);
      await pool.query("update spaces set space_label=$2,use_type='residential' where unit_id=$1",
        [u.id, label]);
      return { id: u.id, space: await one("select id from spaces where unit_id=$1", [u.id]) };
    }
    async function baseline(propertyId, activationId, batchId, established, total) {
      await pool.query(`insert into opening_tenancy_positions
        (property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
         positions_established,positions_unresolved,source_rows_read,
         established_by_user_id,authority_basis,status)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,'platform_role:org_admin','established')`,
        [propertyId, deal.id, activationId, batchId, AS_OF, established, total - established, total, user.id]);
    }
    async function activation(propertyId, name) {
      const batch = await one(`insert into import_batches
        (property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
        values($1,'rent_roll_ledger',$2,$3,$4,'confirmed','committed') returning id`,
        [propertyId, `${name}.csv`, AS_OF, "unit"]);
      const act = await one(`insert into activations
        (deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
        values($1,$2,'activated',$3,$4,$5) returning id`,
        [deal.id, propertyId, AS_OF, batch.id, user.id]);
      return { batchId: batch.id, activationId: act.id };
    }
    async function proposal({ propertyId, activationId, batchId, rowIndex, key, unitId = null, spaceId = null }) {
      const source = await one(`insert into import_source_rows
        (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,$2,$3,'synthetic relay edge',$4,$5) returning id`,
        [batchId, rowIndex, JSON.stringify({ unit_number: key.split("|")[0], is_vacant: true }), unitId, spaceId]);
      return one(`insert into proposed_records
        (activation_id,property_id,module,target_type,natural_key,normalized_json,status,
         import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now()) returning id`,
        [activationId, propertyId, key,
          JSON.stringify({ section: "current", unit_number: key.split("|")[0], is_vacant: true }),
          source.id, String(user.id)]);
    }
    async function ask(propertyId) {
      const client = await pool.connect();
      try {
        await client.query("begin isolation level repeatable read read only");
        const facts = await gatherFacts(client, {
          property_id: propertyId, allowed_modules: ["management"], subject: "tenancy",
        });
        await client.query("rollback");
        return facts.tenancy || null;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally { client.release(); }
    }

    // A completed baseline read with zero retained claims is known zero;
    // no baseline remains an unknown. Neither establishes current inventory.
    {
      const propertyId = await property("empty-baseline");
      const absent = await readTenancyStanding(pool,{property_id:propertyId,as_of:AS_OF});
      assert.equal(absent.unknowns,null);
      assert.equal(absent.standing.truth_state,"NOT_ESTABLISHED");
      const {batchId,activationId} = await activation(propertyId,"empty-baseline");
      await baseline(propertyId,activationId,batchId,0,0);
      const standing = await readTenancyStanding(pool,{property_id:propertyId,as_of:AS_OF});
      const facts = await ask(propertyId);
      assert.equal(standing.position,null);
      assert.equal(standing.standing.truth_state,"NOT_ESTABLISHED");
      if (parent || process.env.PROOF_RELAY_ZERO_EXPECT_DEFECT === "1") {
        assert.equal(standing.unknowns,null);
        assert.equal(facts.unknowns,null);
        ok("parent witness: successful empty baseline read loses explicit zero counts",true);
      } else {
        assert.equal(standing.unknowns.confirmed_source_rows_not_attached_to_a_position,0);
        assert.equal(standing.unknowns.held_source_rows_not_attached_to_a_position,0);
        assert.deepEqual(facts.unknowns,standing.unknowns);
        ok("empty baseline preserves known zeros; absent baseline remains unknown",true);
      }
    }

    // 1. Two distinct agreeing keys answer the same sole position. The relay
    // must count neither as unattached even though one is selected for detail.
    {
      const propertyId = await property("agreeing-keys");
      const only = await unit(propertyId, "101", "Room1");
      const { batchId, activationId } = await activation(propertyId, "agreeing-keys");
      await proposal({ propertyId, activationId, batchId, rowIndex: 1, key: "101", unitId: only.id });
      await proposal({ propertyId, activationId, batchId, rowIndex: 2, key: "101|Room1", unitId: only.id });
      await baseline(propertyId, activationId, batchId, 2, 2);
      const historyBefore = (await pool.query("select to_jsonb(p) as row from proposed_records p where activation_id=$1 order by id", [activationId])).rows;
      const dp = await datedPropertyPositions(pool, { property_id: propertyId, as_of: AS_OF });
      const relay = dp.opening_claims_unattached;
      ok("agreement preserves one vacant opening claim position", dp.positions.length === 1
        && dp.positions[0].basis_type === "opening_claim_vacant");
      if (parent) {
        ok("parent defect: one agreeing eligible claim is falsely unattached", relay.promoted === 1 && relay.held === 0);
      } else {
        ok("successor: agreeing alternate keys are both attached", relay.promoted === 0 && relay.held === 0,
          JSON.stringify({ promoted: relay.promoted, held: relay.held }));
      }
      evidence.push({ case: "agreeing_alternate_keys", mode: parent ? "parent" : "successor",
        positions: dp.positions.length, unattached_promoted: relay ? relay.promoted : null });
      if (!parent) await verifyHttp(propertyId,0,false);
      assert.deepEqual((await pool.query("select to_jsonb(p) as row from proposed_records p where activation_id=$1 order by id", [activationId])).rows, historyBefore);
      ok("reading agreeing claims does not rewrite retained history", true);
      // Competing evidence must remain unresolved, never become vacancy by
      // collecting every supporting id. This is a synthetic fixture change.
      await pool.query("update proposed_records set normalized_json=normalized_json || $2::jsonb where activation_id=$1 and natural_key='101|Room1'",
        [activationId, JSON.stringify({ is_vacant: false, tenant_name: "Synthetic conflicting claim" })]);
      const conflictBefore = (await pool.query("select to_jsonb(p) as row from proposed_records p where activation_id=$1 order by id", [activationId])).rows;
      const conflict = await datedPropertyPositions(pool, { property_id: propertyId, as_of: AS_OF });
      ok("conflicting eligible claims remain unresolved and attached", conflict.positions.length === 1
        && conflict.positions[0].evidence_state === "unreconciled"
        && conflict.opening_claims_unattached.promoted === 0 && conflict.opening_claims_unattached.held === 0);
      assert.deepEqual((await pool.query("select to_jsonb(p) as row from proposed_records p where activation_id=$1 order by id", [activationId])).rows, conflictBefore);
      ok("reading conflicting claims does not rewrite retained history", true);
    }

    // 2. Retiring the only current unit leaves zero positions, but retained
    // history still needs to reach Rent Roll and Ask Spine.
    {
      const propertyId = await property("zero-current");
      const only = await unit(propertyId, "201");
      const { batchId, activationId } = await activation(propertyId, "zero-current");
      await proposal({ propertyId, activationId, batchId, rowIndex: 1, key: "201", unitId: only.id });
      await baseline(propertyId, activationId, batchId, 1, 1);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await retirement.retireInventoryUnits(client, {
          property_id: propertyId, unit_ids: [only.id],
          rationale: "Synthetic relay edge retires the current inventory representation.",
          actor: { system: "opening_claim_relay_edges" },
        });
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
      const dp = await datedPropertyPositions(pool, { property_id: propertyId, as_of: AS_OF });
      const rr = await unitRentRoll(pool, { property_id: propertyId, as_of: AS_OF });
      const standing = await readTenancyStanding(pool, { property_id: propertyId, as_of: AS_OF });
      const askFacts = await ask(propertyId);
      const relay = dp.opening_claims_unattached;
      if (parent) {
        ok("parent: retired-only read has zero positions", dp.positions.length === 0);
        ok("parent defect: Ask drops retained history that the canonical and Rent Roll reads carry",
          relay.promoted === 1 && rr.totals.confirmed_rows_not_attached === 1 && standing.position === null
            && standing.unknowns === null && !standing.unattached_source_rows
            && askFacts && askFacts.position === null && askFacts.unknowns === null);
      } else {
        ok("successor: retired-only read has zero positions and one unattached claim",
          dp.positions.length === 0 && relay.promoted === 1);
        ok("successor: Rent Roll preserves zero-position relay",
          rr.totals.confirmed_rows_not_attached === 1 && rr.unattached_source_rows.length === 1);
        ok("successor: standing and Ask preserve zero-position relay",
          standing.position === null && askFacts.position === null
            && standing.standing.truth_state === "NOT_ESTABLISHED"
            && askFacts.standing.truth_state === "NOT_ESTABLISHED"
            && standing.unknowns.confirmed_source_rows_not_attached_to_a_position === 1
            && standing.unattached_source_rows.length === 1
            && askFacts.unknowns.confirmed_source_rows_not_attached_to_a_position === 1
            && askFacts.unattached_source_rows.length === 1);
      }
      evidence.push({ case: "zero_current_positions", mode: parent ? "parent" : "successor",
        positions: dp.positions.length, relay_promoted: relay ? relay.promoted : null,
        rent_roll_relay: rr.totals.confirmed_rows_not_attached ?? null,
        standing_relay: standing.unknowns ? standing.unknowns.confirmed_source_rows_not_attached_to_a_position ?? null : null });
      if (!parent) await verifyHttp(propertyId,1,false);
    }

    // 3. More than the public relay bound must expose an explicit truncation
    // signal through every compact consumer.
    {
      const propertyId = await property("truncated");
      const { batchId, activationId } = await activation(propertyId, "truncated");
      for (let i = 1; i <= 51; i++) {
        const u = await unit(propertyId, `3${String(i).padStart(2, "0")}`);
        await proposal({ propertyId, activationId, batchId, rowIndex: i,
          key: `3${String(i).padStart(2, "0")}|Missing`, unitId: u.id });
      }
      await baseline(propertyId, activationId, batchId, 51, 51);
      const dp = await datedPropertyPositions(pool, { property_id: propertyId, as_of: AS_OF });
      const rr = await unitRentRoll(pool, { property_id: propertyId, as_of: AS_OF });
      const standing = await readTenancyStanding(pool, { property_id: propertyId, as_of: AS_OF });
      const askFacts = await ask(propertyId);
      const relay = dp.opening_claims_unattached;
      if (parent) {
        ok("parent defect: the bounded canonical list loses truncation in downstream readers",
          relay.promoted === 51 && relay.source_rows.length === 50 && relay.truncated === true
            && rr.unattached_source_rows.length === 50 && standing.unattached_source_rows.length === 50
            && rr.unattached_source_rows_truncated === undefined
            && standing.unattached_source_rows_truncated === undefined
            && askFacts.unattached_source_rows_truncated === undefined);
      } else {
        ok("successor: relay counts all 51 unattached claims", relay.promoted === 51);
        ok("successor: relay exposes exactly 50 rows and truncation", relay.source_rows.length === 50 && relay.truncated === true);
        ok("successor: Rent Roll and Ask preserve truncation", rr.unattached_source_rows.length === 50
          && rr.unattached_source_rows_truncated === true
          && standing.unattached_source_rows.length === 50
          && standing.unattached_source_rows_truncated === true
          && askFacts.unattached_source_rows.length === 50
          && askFacts.unattached_source_rows_truncated === true);
      }
      evidence.push({ case: "fifty_one_unattached", mode: parent ? "parent" : "successor",
        positions: dp.positions.length, relay_promoted: relay ? relay.promoted : null,
        relay_rows: relay ? relay.source_rows.length : null, relay_truncated: relay ? relay.truncated : null });
      if (!parent) await verifyHttp(propertyId,51,true,true);
    }

    console.log(`\n==== opening claim relay edges: ${passed} passed, ${failed} failed ====`);
    if (process.env.PROOF_OUTPUT_DIR) {
      if (browserFixtures.length) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR,"claim-relay-state.private.json"),
        JSON.stringify({fixtures:browserFixtures},null,2));
      fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR,
        `opening-claim-relay-edges-${parent ? "parent" : "successor"}.json`),
        JSON.stringify({ mode: parent ? "positive_defect_witness" : "successor", http_checked: process.env.PROOF_RELAY_HTTP === "1" && !parent, passed, failed, evidence }, null, 2));
    }
    process.exitCode = failed ? 1 : 0;
  } finally {
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
