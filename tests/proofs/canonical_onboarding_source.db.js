"use strict";

// Synthetic positive parent witnesses and successor contract checks through the
// real services. The caller owns the nonce-marked disposable database.
const assert = require("node:assert/strict");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");
const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const activation = require(path.join(root, "src/onboarding/activation_service.js"));
const artifacts = require(path.join(root, "src/onboarding/source_artifact_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
let pool;
let assertions = 0;
function check(label, condition) { assert.ok(condition, label); assertions++; console.log(`PASS ${label}`); }
async function refuses(label, fn, code) {
  await assert.rejects(fn, e => e.reason === code || e.code === code, label);
  assertions++; console.log(`PASS ${label}`);
}
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const csv = "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n101,Room1,Synthetic Tenant (s123456),900,,2026-07-01,2027-06-30\n";
const sourceRows = [{Unit:"101",Room:"Room1",Resident:"Synthetic Tenant (s123456)","Market Rent":"900","Actual Rent":"","Lease From":"2026-07-01","Lease To":"2027-06-30",__row_number:2,__section:"current"}];

(async () => {
  await boundary.assertDatabase();
  const owned = boundary.manifest();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {cwd:root, encoding:"utf8", windowsHide:true}).trim();
  if (parent) {
    assert.equal(sha, "e09c5411e2c072c3452e48b434a9f8a8250ce1bb");
    execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "src", "server.js", "migrations"], {cwd:root,windowsHide:true,stdio:"pipe"});
  }
  console.log(`SOURCE_PROOF_MODE=${parent ? "positive_parent_defects" : "successor"}; BUSINESS_SHA=${sha}`);
  pool = new Pool({connectionString:owned.url, ssl:false});
  const tag = `source-proof-${randomUUID()}`;
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const human = await one("insert into persons(name) values('Synthetic Source Operator') returning id");
  const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
    values('Synthetic Source Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`, [`${tag}@example.test`,org.id,human.id]);
  const deal = await deals.createDeal(pool, {user_id:user.id,deal_name:tag,creation_source:"deal_setup_console"});
  async function setup(bytes = Buffer.from(csv)) {
    const key = randomUUID();
    const property = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id", [key,org.id]);
    await deals.addProperty(pool,{user_id:user.id,deal_intake_id:deal.id,property_id:property.id});
    const act = (await activation.openActivation(pool,{user_id:user.id,deal_intake_id:deal.id,property_id:property.id})).activation;
    const artifact = await artifacts.store(pool,{scope_type:"property",scope_id:property.id,filename:"synthetic.csv",mimetype:"text/csv",buffer:bytes,
      uploaded_by_user_id:user.id,source_as_of_date:"2026-07-31"});
    const args = {user_id:user.id,deal_intake_id:deal.id,property_id:property.id,activation_id:act.id,source_artifact_id:artifact.id,source_as_of_date:"2026-07-31"};
    return {property,act,artifact,args,bytes};
  }
  // A caller changes both unit and rent while citing different retained bytes.
  const tamper = await setup();
  const forged = [{...sourceRows[0],Unit:"999","Actual Rent":"1"}];
  if (parent) {
    await activation.ingestRentRoll(pool,{...tamper.args,rows:forged});
    const row = await one("select normalized_json from proposed_records where activation_id=$1",[tamper.act.id]);
    check("parent actually staged forged unit/rent against retained source",row.normalized_json.unit_number === "999" && Number(row.normalized_json.rent) === 1);
  } else {
    await refuses("caller rows contradicting retained bytes refused",()=>activation.ingestRentRoll(pool,{...tamper.args,rows:forged}),"source_rows_mismatch");
    check("tamper leaves zero evidence batches",Number((await one("select count(*) from import_batches where property_id=$1",[tamper.property.id])).count) === 0);
  }
  const date = await setup();
  if (parent) {
    await activation.ingestRentRoll(pool,{...date.args,rows:sourceRows,source_as_of_date:"2026-08-31"});
    check("parent actually overrides retained artifact date",(await one("select to_char(source_as_of_date,'YYYY-MM-DD') as d from activations where id=$1",[date.act.id])).d === "2026-08-31");
    const duplicate = await artifacts.store(pool,{scope_type:"property",scope_id:date.property.id,filename:"synthetic.csv",mimetype:"text/csv",buffer:date.bytes,
      uploaded_by_user_id:user.id,source_as_of_date:"2026-09-30"});
    check("parent reupload silently accepts contradictory date",duplicate.id === date.artifact.id && duplicate.deduplicated);
  } else {
    await refuses("request cannot override retained artifact date",()=>activation.ingestRentRoll(pool,{...date.args,source_as_of_date:"2026-08-31"}),"source_date_mismatch");
    await refuses("same bytes cannot be relabelled with a new date",()=>artifacts.store(pool,{scope_type:"property",scope_id:date.property.id,filename:"synthetic.csv",mimetype:"text/csv",buffer:date.bytes,
      uploaded_by_user_id:user.id,source_as_of_date:"2026-09-30"}),"source_date_mismatch");
  }
  // Standard CSV supports structural sections through the same format adapter.
  const claimsCsv = csv + "Future Residents/Applicants\n101,Room1,Synthetic Future (s654321),950,,2027-07-01,2028-06-30\n,,Synthetic Applicant (s654322),950,,,\n";
  const claims = await setup(Buffer.from(claimsCsv));
  const supplied = [...sourceRows,
    {...sourceRows[0],Resident:"Synthetic Future (s654321)","Market Rent":"950","Lease From":"2027-07-01","Lease To":"2028-06-30",__row_number:4,__section:"future"},
    {Unit:"",Room:"",Resident:"Synthetic Applicant (s654322)","Market Rent":"950","Actual Rent":"","Lease From":"","Lease To":"",__row_number:5,__section:"future"}];
  const out = await activation.ingestRentRoll(pool,{...claims.args,...(parent ? {rows:supplied} : {})});
  const proposals = (await pool.query("select * from proposed_records where activation_id=$1 order by normalized_json->>'section',natural_key",[claims.act.id])).rows;
  if (parent) {
    check("parent evidence retains three but proposals drop assigned future",out.rows_read === 3 && proposals.length === 2);
    const current = proposals.find(p=>p.natural_key === "101|Room1");
    check("parent converts asking to proposed contract rent",current.normalized_json.actual_rent == null && Number(current.normalized_json.rent) === 900);
    await activation.confirmProposal(pool,{user_id:user.id,proposed_id:current.id});
    check("parent actually creates a lease from missing actual rent",Number((await one("select rent from leases where property_id=$1",[claims.property.id])).rent) === 900);
  } else {
    check("every current future and unassigned claim retained",out.rows_read === 3 && proposals.length === 3);
    check("two assigned claims retain the same spatial key",proposals.filter(p=>p.natural_key === "101|Room1").length === 2);
    check("source resident codes and future section survive",proposals.filter(p=>p.normalized_json.section === "future" && p.normalized_json.resident_id).length === 2);
    check("missing actual remains missing contract",proposals.every(p=>p.normalized_json.rent == null && p.normalized_json.actual_rent == null));
    const current = proposals.find(p=>p.normalized_json.section === "current");
    const future = proposals.find(p=>p.normalized_json.section === "future" && p.natural_key);
    await refuses("generic Add cannot fill missing actual rent",()=>activation.confirmProposal(pool,{user_id:user.id,proposed_id:current.id}),"actual_rent_required");
    await refuses("generic Add cannot promote a future claim",()=>activation.confirmProposal(pool,{user_id:user.id,proposed_id:future.id}),"future_claim_requires_review");
    check("no lease manufactured",Number((await one("select count(*) from leases where property_id=$1",[claims.property.id])).count) === 0);
    const shape = await one("select (select count(*) from units where property_id=$1)::int units,(select count(*) from spaces s join units u on u.id=s.unit_id where u.property_id=$1)::int spaces",[claims.property.id]);
    check("claim count does not inflate inventory",shape.units === 1 && shape.spaces === 1);
    const reread = await activation.readActivation(pool,{user_id:user.id,activation_id:claims.act.id});
    check("durable review exposes all three claims",reread.proposals.length === 3);

    // Retained-source authority is exact: another property and another kind
    // may both be readable files, but neither is this property's rent roll.
    const foreign = await setup();
    await refuses("another property's retained source is refused",()=>activation.ingestRentRoll(pool,{
      ...foreign.args,source_artifact_id:claims.artifact.id}),"artifact_out_of_scope");
    check("wrong-property source leaves no evidence batch",Number((await one(
      "select count(*) from import_batches where property_id=$1",[foreign.property.id])).count) === 0);

    const unassigned = await setup(Buffer.from("Unit,Room,Resident,Actual Rent\n,,Synthetic Unassigned,850\n"));
    await activation.ingestRentRoll(pool, unassigned.args);
    const unassignedReview = await activation.readActivation(pool,{user_id:user.id,activation_id:unassigned.act.id});
    check("current resident without a unit remains one blocked review claim",unassignedReview.proposals.length === 1 && unassignedReview.counts.blocked === 1);
    check("canonical assignment summary includes current unknown unit",unassignedReview.review_counts.total === 1 && unassignedReview.review_counts.current === 1 && unassignedReview.review_counts.assigned === 0 && unassignedReview.review_counts.unassigned_current === 1 && unassignedReview.review_counts.unassigned_future === 0);
    const conflicts = await setup(Buffer.from("Unit,Room,Resident,Actual Rent\n101,Room1,Synthetic A,850\n101,Room1,Synthetic B,850\n"));
    await activation.ingestRentRoll(pool, conflicts.args);
    const conflictReview = await activation.readActivation(pool,{user_id:user.id,activation_id:conflicts.act.id});
    check("two disagreeing current claims remain two conflicted proposals",conflictReview.proposals.length === 2 && conflictReview.counts.conflicted === 2 && conflictReview.review_counts.total === 2);

    const wrongKind = await setup();
    const otherBytes = Buffer.from("Unit,Resident,Actual Rent\n301,Synthetic Other,800\n");
    const otherArtifact = await artifacts.store(pool,{scope_type:"property",scope_id:wrongKind.property.id,
      filename:"synthetic-other.csv",mimetype:"text/csv",buffer:otherBytes,artifact_kind:"other",
      uploaded_by_user_id:user.id,source_as_of_date:"2026-07-31"});
    await refuses("a retained source of another kind is refused",()=>activation.ingestRentRoll(pool,{
      ...wrongKind.args,source_artifact_id:otherArtifact.id}),"artifact_kind_mismatch");
    check("wrong-kind source leaves no evidence batch",Number((await one(
      "select count(*) from import_batches where property_id=$1",[wrongKind.property.id])).count) === 0);

    // A later source carrying the same source-resident code gets continuity
    // as a candidate only. The first Add creates no person or lease; the
    // operator must choose that displayed candidate explicitly.
    const continuityCode = "s777777";
    const continuityCsv = "Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n" +
      `201,Room1,Synthetic Continuity (${continuityCode}),900,850,2026-07-01,2027-06-30\n`;
    const continuity = await setup(Buffer.from(continuityCsv));
    const priorPerson = await one("insert into persons(name,source) values('Synthetic Prior Resident','prior proof source') returning id");
    const priorBatch = await one(`insert into import_batches
      (property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
      values($1,'historical_snapshot',$2,'2026-06-30','bed','confirmed','committed') returning id`,
      [continuity.property.id,`prior-${randomUUID()}.csv`]);
    await pool.query(`insert into import_source_rows
      (import_batch_id,row_index,raw,produced_person_id,parse_note)
      values($1,1,$2,$3,'prior source produced this person')`,
      [priorBatch.id,JSON.stringify({resident_id:continuityCode}),priorPerson.id]);

    await activation.ingestRentRoll(pool,{...continuity.args});
    const continuityLease = await one(`select * from proposed_records
      where activation_id=$1 and target_type='lease'`,[continuity.act.id]);
    const peopleBeforeReview = Number((await one("select count(*) from persons")).count);
    await refuses("historical continuity remains a candidate until explicit review",()=>
      activation.confirmProposal(pool,{user_id:user.id,proposed_id:continuityLease.id}),
      "resident_identity_requires_review");
    check("candidate review creates neither a person nor a lease",
      Number((await one("select count(*) from persons")).count) === peopleBeforeReview &&
      Number((await one("select count(*) from leases where property_id=$1",[continuity.property.id])).count) === 0);

    const pendingRead = await activation.readActivation(pool,{user_id:user.id,activation_id:continuity.act.id});
    const pendingLease = pendingRead.proposals.find(p=>p.id === continuityLease.id);
    check("activation review exposes the prior resident candidate without binding it",
      pendingLease && pendingLease.status === "needs_review" && pendingLease.identity_review &&
      pendingLease.identity_review.status === "needs_review" &&
      pendingLease.identity_review.person_id == null &&
      pendingLease.identity_review.candidates.length === 1 &&
      pendingLease.identity_review.candidates[0].person_id === priorPerson.id);

    const stranger = await one("insert into persons(name) values('Synthetic Unoffered Person') returning id");
    await refuses("an arbitrary noncandidate person cannot be selected",()=>activation.resolveResidentIdentity(pool,{
      user_id:user.id,proposed_id:continuityLease.id,action:"resolved_existing",person_id:stranger.id}),
      "identity_candidate_not_offered");
    check("refused noncandidate leaves identity review pending",(await one(`select status from proposed_records
      where activation_id=$1 and import_source_row_id=$2 and target_type='person'`,
      [continuity.act.id,continuityLease.import_source_row_id])).status === "needs_review");

    const outsiderOrg = await one("insert into organizations(name,slug) values($1,$1) returning id",[`outsider-${randomUUID()}`]);
    const outsiderPerson = await one("insert into persons(name) values('Synthetic Outside Operator') returning id");
    const outsider = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values('Synthetic Outside Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`,
      [`outside-${randomUUID()}@example.test`,outsiderOrg.id,outsiderPerson.id]);
    await refuses("an operator outside the deal cannot resolve resident identity",()=>activation.resolveResidentIdentity(pool,{
      user_id:outsider.id,proposed_id:continuityLease.id,action:"resolved_existing",person_id:priorPerson.id}),
      "organization_scope_violation");

    const resolved = await activation.resolveResidentIdentity(pool,{user_id:user.id,
      proposed_id:continuityLease.id,action:"resolved_existing",person_id:priorPerson.id});
    check("explicit candidate resolution records continuity without establishing a lease",
      resolved.person_id === priorPerson.id &&
      Number((await one("select count(*) from leases where property_id=$1",[continuity.property.id])).count) === 0);
    const resolvedRead = await activation.readActivation(pool,{user_id:user.id,activation_id:continuity.act.id});
    const readyLease = resolvedRead.proposals.find(p=>p.id === continuityLease.id);
    check("durable review shows the signed identity decision and leaves lease confirmation separate",
      readyLease && readyLease.status === "staged" && readyLease.identity_review &&
      readyLease.identity_review.status === "promoted" &&
      readyLease.identity_review.person_id === priorPerson.id &&
      readyLease.identity_review.resolution_kind === "resolved_existing");

    const peopleBeforeLease = Number((await one("select count(*) from persons")).count);
    const confirmedContinuity = await activation.confirmProposal(pool,{user_id:user.id,proposed_id:continuityLease.id});
    const continuityCanonical = await one("select tenant_ids,rent from leases where id=$1",[confirmedContinuity.lease_id]);
    const continuityEvidence = await one("select produced_person_id,produced_lease_id from import_source_rows where id=$1",
      [continuityLease.import_source_row_id]);
    check("lease confirmation reuses the signed person and creates no duplicate",
      confirmedContinuity.person_id === priorPerson.id &&
      continuityCanonical.tenant_ids.length === 1 && continuityCanonical.tenant_ids[0] === priorPerson.id &&
      Number(continuityCanonical.rent) === 850 &&
      Number((await one("select count(*) from persons")).count) === peopleBeforeLease);
    check("successor evidence closes onto the same person and new lease",
      continuityEvidence.produced_person_id === priorPerson.id &&
      continuityEvidence.produced_lease_id === confirmedContinuity.lease_id);
  }
  const unnamed = await setup(Buffer.from("Unit,Room,Resident,Status,Market Rent,Actual Rent\n301,Room1,,occupied,900,850\n"));
  await activation.ingestRentRoll(pool,{...unnamed.args,...(parent ? {rows:[{Unit:"301",Room:"Room1",Resident:"",Status:"occupied","Market Rent":"900","Actual Rent":"850",__row_number:2}]} : {})});
  const unnamedClaim = await one("select id,status,normalized_json from proposed_records where activation_id=$1 and target_type='lease'",[unnamed.act.id]);
  if (parent) {
    const result = await activation.confirmProposal(pool,{user_id:user.id,proposed_id:unnamedClaim.id});
    check("parent positively confirms explicitly occupied unnamed evidence as vacant",unnamedClaim.normalized_json.is_vacant === true && result.vacant === true);
  } else {
    check("missing name never turns an occupied claim into vacancy",unnamedClaim.status === "needs_review" && unnamedClaim.normalized_json.is_vacant === false);
    await refuses("unnamed occupied claim cannot be confirmed as vacancy",()=>activation.confirmProposal(pool,{user_id:user.id,proposed_id:unnamedClaim.id}),"resident_identity_required");
  }
  console.log(`SOURCE_PROOF_PASSED=${assertions}`);
})().catch(e=>{ console.error(e.stack); process.exitCode=1; }).finally(async()=>{if(pool) await pool.end();});
