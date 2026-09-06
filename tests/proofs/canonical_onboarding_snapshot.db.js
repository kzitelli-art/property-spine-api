/* ════════════════════════════════════════════════════════════════════
   canonical_onboarding_snapshot.db.js — EVIDENCE DOES NOT PUBLISH ITSELF

   An activation may retain and interpret a source before an operator
   establishes the opening position. That committed evidence batch must not
   replace a prior operating snapshot, or turn a future source row into a
   commitment. Legacy batches without an activation keep their historical
   behavior. Synthetic and confined to the caller-owned proof database.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const receipt = require("../_run_receipt.js");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const HARNESS = "canonical_onboarding_snapshot.db.js";
const EXPECTED = 15;
const CONN = receipt.harnessConnectionString();
const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const snapshot = require(path.join(root, "src/shared/snapshot_loader.js"));
const dated = require(path.join(root, "src/tenancy/dated_positions.js"));
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];

(async () => {
  await boundary.assertDatabase();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root, encoding: "utf8", windowsHide: true,
  }).trim();
  if (parent) {
    if (sha !== "e09c5411e2c072c3452e48b434a9f8a8250ce1bb") {
      throw new Error(`parent proof requires e09c541, received ${sha}`);
    }
    execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "src", "server.js", "migrations"],
      { cwd: root, windowsHide: true, stdio: "pipe" });
  }
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  console.log(`SNAPSHOT_PROOF_MODE=${parent ? "positive_parent_defect" : "successor"}; BUSINESS_SHA=${sha}`);
  const pool = new Pool({ connectionString: CONN, ssl: false });
  try {
    const tag = `snapshot-proof-${randomUUID()}`;
    const org = await one(pool,"insert into organizations(name,slug) values($1,$1) returning id",[tag]);
    const user = await one(pool,`insert into users(name,email,is_active,status,platform_role,organization_id)
      values('Synthetic Snapshot Operator',$1,true,'active','super_admin',$2) returning id`,
      [`${tag}@example.invalid`,org.id]);
    const deal = await one(pool,`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`,[tag,org.id]);
    const property = await one(pool,`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'unit') returning id`,[`property-${randomUUID()}`,org.id]);
    const onlyOpenProperty = await one(pool,`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'unit') returning id`,[`property-${randomUUID()}`,org.id]);
    await pool.query(`insert into deal_intake_properties(intake_id,property_id,status)
      values($1,$2,'current'),($1,$3,'current')`,[deal.id,property.id,onlyOpenProperty.id]);

    async function addBatch(propertyId, sourceType, sourceFile, rows) {
      const batch = await one(pool,`insert into import_batches
        (property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
        values($1,$2,$3,'2026-07-31','unit','extracted','committed') returning id`,
        [propertyId,sourceType,sourceFile]);
      for (let index = 0; index < rows.length; index += 1) {
        await pool.query(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note)
          values($1,$2,$3,'synthetic publication evidence')`,
          [batch.id,index + 1,JSON.stringify(rows[index])]);
      }
      return batch;
    }
    async function bindOpen(propertyId, batchId) {
      return one(pool,`insert into activations
        (deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
        values($1,$2,'open','2026-07-31',$3,$4) returning id`,
        [deal.id,propertyId,batchId,user.id]);
    }

    const legacy = await addBatch(property.id,"historical_snapshot","legacy.csv",[
      {row_index:1,unit_number:"101",status:"vacant",market_rent:700,section:"current"},
      {row_index:2,unit_number:"101",name:"Synthetic Legacy Future",status:"future",
        actual_rent:725,lease_from:"2027-01-01",lease_to:"2027-12-31",section:"future"},
    ]);
    const before = await snapshot.readLatestSnapshot(pool,property.id);
    ok("legacy unbound batch retains historical source-future semantics",
      before.has_data && before.source.import_batch_id === legacy.id && before.rows.length === 2 &&
      before.summary.future_commitments === 1 && before.availability.length === 1 &&
      before.availability[0].committed === true && before.availability[0].future_commitments.length === 1);
    const beforeTruth = await dated.openingTruth(pool,property.id);
    ok("legacy source remains eligible for the latest confirmed receipt",
      beforeTruth.latest_confirmed_source && beforeTruth.latest_confirmed_source.batch_id === legacy.id);

    const reviewBatch = await addBatch(property.id,"rent_roll_ledger","review.csv",[
      {row_index:1,unit_number:"201",status:"vacant",market_rent:900,section:"current"},
      {row_index:2,unit_number:"202",name:"Synthetic Held Current",status:"current",
        actual_rent:null,lease_from:"2026-02-01",lease_to:"2027-01-31",section:"current"},
      {row_index:3,unit_number:"201",name:"Synthetic Future",status:"future",
        actual_rent:950,lease_from:"2027-08-01",lease_to:"2028-07-31",section:"future"},
    ]);
    const reviewActivation = await bindOpen(property.id,reviewBatch.id);
    const during = await snapshot.readLatestSnapshot(pool,property.id);
    const duringTruth = await dated.openingTruth(pool,property.id);
    if (parent) {
      ok("parent open activation batch overwrites the prior live snapshot",
        during.source && during.source.import_batch_id === reviewBatch.id);
      ok("parent publishes an unconfirmed future source row as a commitment",
        during.availability.find(row=>row.unit_number === "201").committed === true &&
        during.availability.find(row=>row.unit_number === "201").future_commitments.length === 1);
      ok("parent calls the open activation batch its latest confirmed source",
        duringTruth.latest_confirmed_source && duringTruth.latest_confirmed_source.batch_id === reviewBatch.id);
    } else {
      ok("open activation evidence cannot overwrite the prior live snapshot",
        during.source && during.source.import_batch_id === legacy.id &&
        during.rows.every(row=>row.unit_number === "101"));
      ok("open activation future evidence adds no commitment to the retained legacy snapshot",
        during.availability.length === 1 && during.availability[0].unit_number === "101" &&
        during.availability[0].committed === true && during.availability[0].future_commitments.length === 1);
      const reviewSource = duringTruth.sources.find(source=>source.batch_id === reviewBatch.id);
      ok("receipt retains review evidence but marks it unpublished",
        reviewSource && reviewSource.operating_published === false &&
        duringTruth.latest_confirmed_source.batch_id === legacy.id);
    }

    const onlyOpenBatch = await addBatch(onlyOpenProperty.id,"rent_roll_ledger","only-review.csv",[
      {row_index:1,unit_number:"301",status:"vacant",market_rent:800,section:"current"},
      {row_index:2,unit_number:"301",name:"Synthetic Future Only",status:"future",
        actual_rent:825,lease_from:"2027-08-01",lease_to:"2028-07-31",section:"future"},
    ]);
    await bindOpen(onlyOpenProperty.id,onlyOpenBatch.id);
    const onlyOpen = await snapshot.readLatestSnapshot(pool,onlyOpenProperty.id);
    const onlyOpenTruth = await dated.openingTruth(pool,onlyOpenProperty.id);
    if (parent) {
      ok("parent reports a snapshot where only open setup evidence exists",onlyOpen.has_data === true);
      ok("parent lets that unconfirmed future evidence close availability",
        onlyOpen.availability[0] && onlyOpen.availability[0].committed === true);
      ok("parent receipt calls review-only evidence confirmed",
        onlyOpenTruth.latest_confirmed_source && onlyOpenTruth.latest_confirmed_source.batch_id === onlyOpenBatch.id);
    } else {
      ok("only open setup evidence yields an honest no-snapshot result",
        onlyOpen.has_data === false && onlyOpen.source === null && onlyOpen.rows.length === 0);
      ok("no snapshot also means no manufactured availability",onlyOpen.availability.length === 0);
      ok("all evidence remains visible while latest confirmed stays empty",
        onlyOpenTruth.sources.length === 1 &&
        onlyOpenTruth.sources[0].operating_published === false &&
        onlyOpenTruth.latest_confirmed_source === null);
    }

    // Publishing the setup makes its current row eligible, but its future row
    // is still only evidence until a canonical lease exists.
    const unit = await one(pool,`insert into units(property_id,unit_number,market_rent)
      values($1,'201',900) returning id`,[property.id]);
    let space = await one(pool,"select id from spaces where unit_id=$1 order by created_at limit 1",[unit.id]);
    if (!space) space = await one(pool,"insert into spaces(unit_id,space_label) values($1,'(whole unit)') returning id",[unit.id]);
    const evidence = (await pool.query(`select id,row_index from import_source_rows
      where import_batch_id=$1 order by row_index`,[reviewBatch.id])).rows;
    const byRow = new Map(evidence.map(row=>[Number(row.row_index),row.id]));
    await pool.query(`insert into proposed_records
      (activation_id,property_id,module,target_type,natural_key,normalized_json,status,status_reason,import_source_row_id)
      values
        ($1,$2,'leasing','lease','201',$3,'promoted',null,$4),
        ($1,$2,'leasing','lease','202',$5,'needs_review','actual rent requires review',$6),
        ($1,$2,'leasing','lease','future-201',$7,'needs_review','future resident is evidence only',$8)`,
      [reviewActivation.id,property.id,
       JSON.stringify({section:"current",unit_number:"201",is_vacant:true}),byRow.get(1),
       JSON.stringify({section:"current",unit_number:"202",resident_name:"Synthetic Held Current"}),byRow.get(2),
       JSON.stringify({section:"future",unit_number:"201",resident_name:"Synthetic Future"}),byRow.get(3)]);
    await pool.query("update activations set status='activated' where id=$1",[reviewActivation.id]);
    await pool.query(`insert into opening_tenancy_positions
      (property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
       positions_established,positions_unresolved,source_rows_read,
       established_by_user_id,authority_basis,status)
      values($1,$2,$3,$4,'2026-07-31',1,2,3,$5,'platform_role:super_admin','established')`,
      [property.id,deal.id,reviewActivation.id,reviewBatch.id,user.id]);

    const published = await snapshot.readLatestSnapshot(pool,property.id);
    const publishedTruth = await dated.openingTruth(pool,property.id);
    ok("established opening position publishes its activation-bound batch",
      published.source && published.source.import_batch_id === reviewBatch.id &&
      publishedTruth.latest_confirmed_source.batch_id === reviewBatch.id);
    if (parent) {
      ok("parent counts unresolved current evidence as established operating occupancy",
        published.summary.current_rows === 2 && published.summary.occupied === 1);
      ok("parent still promotes held future evidence into availability",
        published.availability.find(row=>row.unit_number === "201").committed === true);
      ok("parent future commitment is unattributed source data",
        published.availability.find(row=>row.unit_number === "201").future_commitments[0].lease_id == null);
      ok("parent gives unresolved source rows no publication boundary",
        published.rows.filter(row=>row.unit_number === "202" || row.section === "future")
          .every(row=>row.publication_status == null));
    } else {
      ok("only promoted claims shape the operating snapshot summary",
        published.summary.current_rows === 1 && published.summary.inventory === 1 &&
        published.summary.vacant === 1 && published.summary.occupied === 0 &&
        published.summary.source_rows === 3 && published.summary.source_current_rows === 2 &&
        published.summary.source_future_rows === 1 && published.summary.held_for_review === 2);
      const heldCurrent = published.rows.find(row=>row.unit_number === "202");
      ok("unresolved current evidence remains visible and explicitly held",
        heldCurrent && heldCurrent.source_status === "current" &&
        heldCurrent.status === "needs_review" && heldCurrent.publication_status === "held_for_review");
      ok("published future evidence remains held without a canonical lease",
        published.summary.future_rows === 1 && published.summary.future_commitments === 0 &&
        published.availability.length === 1 && published.availability[0].unit_number === "201" &&
        published.availability[0].committed === false && published.availability[0].future_commitments.length === 0 &&
        published.rows.find(row=>row.section === "future").publication_status === "held_for_review");
      ok("published source is explicitly marked operating truth",
        publishedTruth.sources.find(source=>source.batch_id === reviewBatch.id).operating_published === true);
    }

    const resident = await one(pool,"insert into persons(name) values('Synthetic Canonical Future') returning id");
    const canonicalLease = await one(pool,`insert into leases
      (property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status,source_type,confidence)
      values($1,$2,$3,975,'2027-08-01','2028-07-31','pending','operator_confirmed','confirmed') returning id`,
      [property.id,space.id,[resident.id]]);
    const withLease = await snapshot.readLatestSnapshot(pool,property.id);
    const committed = withLease.availability.find(row=>row.unit_number === "201");
    ok("canonical future lease closes availability",committed && committed.committed === true);
    if (parent) {
      ok("parent commitment still lacks canonical lease identity",
        committed.future_commitments.length === 1 && committed.future_commitments[0].lease_id == null);
    } else {
      ok("future commitment names the canonical lease and its economics",
        committed.future_commitments.length === 1 &&
        committed.future_commitments[0].lease_id === canonicalLease.id &&
        committed.future_commitments[0].rent === 975 &&
        withLease.summary.future_commitments === 1);
    }
  } catch (error) {
    failed++;
    console.error("  FAIL  harness threw  →  " + (error && error.stack ? error.stack : error));
  } finally {
    await pool.end();
  }
  process.exit(receipt.complete({harness:HARNESS,passed,failed,expectedAtLeast:EXPECTED}));
})().catch(error=>{
  console.error(error && error.stack ? error.stack : error);
  process.exit(receipt.died(HARNESS,error,passed+failed));
});
