"use strict";

// Temporary release-coupling witness: remove/revise the ceiling-192 expectation
// when the claim-index rewrite is allocated into the numbered migration chain.
// This proof never applies DDL; its caller owns the explicit pending step.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");
const activation = require("../../src/onboarding/activation_service.js");
const artifacts = require("../../src/onboarding/source_artifact_service.js");
const deals = require("../../src/onboarding/deal_service.js");
let pool;
(async () => {
  await boundary.assertDatabase();
  const mode = process.env.PROOF_CLAIM_INDEX;
  assert.ok(mode === "released" || mode === "pending");
  pool = new Pool({connectionString:boundary.manifest().url,ssl:false});
  const one = async (sql,args=[]) => (await pool.query(sql,args)).rows[0];
  const index = await one("select indexdef from pg_indexes where schemaname='public' and indexname='uq_proposed_natural'");
  assert.ok(index);
  assert.equal(index.indexdef.includes("import_source_row_id IS NULL"),mode === "pending");
  const tag = `index-proof-${randomUUID()}`;
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id",[tag]);
  const human = await one("insert into persons(name) values('Synthetic Index Operator') returning id");
  const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
    values('Synthetic Index Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`,[`${tag}@example.test`,org.id,human.id]);
  const deal = await deals.createDeal(pool,{user_id:user.id,deal_name:tag,creation_source:"deal_setup_console"});
  const property = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id",[tag,org.id]);
  await deals.addProperty(pool,{user_id:user.id,deal_intake_id:deal.id,property_id:property.id});
  const act = (await activation.openActivation(pool,{user_id:user.id,deal_intake_id:deal.id,property_id:property.id})).activation;
  const bytes = Buffer.from("Unit,Room,Resident,Actual Rent\n101,Room1,Synthetic Current,850\nFuture Residents/Applicants\n101,Room1,Synthetic Future,900\n");
  const artifact = await artifacts.store(pool,{scope_type:"property",scope_id:property.id,filename:"synthetic-index.csv",mimetype:"text/csv",buffer:bytes,
    uploaded_by_user_id:user.id,source_as_of_date:"2026-07-31"});
  const args = {user_id:user.id,deal_intake_id:deal.id,property_id:property.id,activation_id:act.id,source_artifact_id:artifact.id,source_as_of_date:"2026-07-31"};
  if (mode === "released") {
    await assert.rejects(()=>activation.ingestRentRoll(pool,args),error=>error.code === "23505" && error.constraint === "uq_proposed_natural");
    assert.equal(Number((await one("select count(*) from import_batches where property_id=$1",[property.id])).count),0);
    assert.equal(Number((await one("select count(*) from proposed_records where activation_id=$1",[act.id])).count),0);
    assert.deepEqual((await one("select content from source_artifacts where id=$1",[artifact.id])).content,bytes);
    console.log("PASS ceiling192: raw23505 on natural-key index; stage transaction rolled back; original retained");
  } else {
    const result = await activation.ingestRentRoll(pool,args);
    const review = await activation.readActivation(pool,{user_id:user.id,activation_id:act.id});
    assert.equal(result.rows_read,2);
    assert.equal(review.proposals.length,2);
    assert.equal(new Set(review.proposals.map(p=>p.import_source_row_id)).size,2);
    assert.deepEqual(review.proposals.map(p=>p.normalized_json.section).sort(),["current","future"]);
    console.log("PASS pending index: both distinct source-linked current/future claims retained");
  }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(pool)await pool.end();});
