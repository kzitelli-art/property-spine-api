"use strict";
const assert = require("node:assert/strict");
const {randomUUID} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const {Pool} = require("pg");
const activation = require("../../src/onboarding/activation_service");
const artifacts = require("../../src/onboarding/source_artifact_service");
const deals = require("../../src/onboarding/deal_service");
const sessions = require("../../src/identity/staff_session_service");
const parent = process.env.PROOF_SPACE_EXPECT_DEFECT === "1";
let pool;
(async()=>{
  await boundary.assertDatabase();
  pool = new Pool({connectionString:boundary.manifest().url,ssl:false});
  const one = async(sql,args=[]) => (await pool.query(sql,args)).rows[0];
  const tag = `space-proof-${randomUUID()}`;
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id",[tag]);
  const person = await one("insert into persons(name) values('Synthetic Space Operator') returning id");
  const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
    values('Synthetic Space Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`,[`${tag}@example.test`,org.id,person.id]);
  const api = process.env.E2E_API_BASE;
  assert.match(api,/^http:\/\/127\.0\.0\.1:\d+$/);
  const http = async(token,url,method="GET") => {
    const response = await fetch(api+url,{method,headers:{"x-staff-session":token,"content-type":"application/json"},...(method==="POST"?{body:"{}"}:{}),signal:AbortSignal.timeout(30000)});
    return {status:response.status,body:await response.json()};
  };
  async function fixture(csv,preexisting=false) {
    const key=randomUUID();
    const deal=await deals.createDeal(pool,{user_id:user.id,deal_name:key,creation_source:"deal_setup_console"});
    const property=await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id",[key,org.id]);
    await deals.addProperty(pool,{user_id:user.id,deal_intake_id:deal.id,property_id:property.id});
    await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Proof Manager','{management,leasing}',true)",[property.id,user.id]);
    const client=await pool.connect();let token;
    try {await client.query("begin");token=(await sessions.issueStaffSession(client,{userId:user.id,propertyId:property.id,purpose:"sms_otp"})).session_token;await client.query("commit");}
    finally {client.release();}
    if(preexisting) {
      const unit=await one("insert into units(property_id,unit_number) values($1,'101') returning id",[property.id]);
      const initial=await one("select id from spaces where unit_id=$1",[unit.id]);
      for(const label of (preexisting==="single"?["Room1"]:["Room1","Room2"])) {
        const space=label==="Room1" && initial
          ? await one("update spaces set space_label=$2 where id=$1 returning id",[initial.id,label])
          : await one("insert into spaces(unit_id,space_label) values($1,$2) returning id",[unit.id,label]);
        if(label==="Room1" && preexisting!=="single") await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,850,'2026-01-01','2027-12-31','active')",[property.id,space.id,[person.id]]);
      }
    }
    const act=(await activation.openActivation(pool,{user_id:user.id,deal_intake_id:deal.id,property_id:property.id})).activation;
    const artifact=await artifacts.store(pool,{scope_type:"property",scope_id:property.id,filename:"synthetic-space.csv",mimetype:"text/csv",buffer:Buffer.from(csv),uploaded_by_user_id:user.id,source_as_of_date:"2026-07-31"});
    await activation.ingestRentRoll(pool,{user_id:user.id,deal_intake_id:deal.id,property_id:property.id,activation_id:act.id,source_artifact_id:artifact.id,source_as_of_date:"2026-07-31"});
    const proposals=(await activation.readActivation(pool,{user_id:user.id,activation_id:act.id})).proposals;
    return {property,act,proposals,token};
  }
  const header="Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n";
  const occupied="101,Room1,Synthetic Resident,900,850,2026-01-01,2027-12-31\n";
  const vacant="101,Room2,VACANT,900,,,\n";
  const evidence=[];
  const browserFixtures=[];
  for(const reverse of [false,true]) {
    const f=await fixture(header+(reverse?vacant+occupied:occupied+vacant));
    for(const p of f.proposals) assert.equal((await http(f.token,`/deal-setup/proposals/${p.id}/confirm`,"POST")).status,200);
    await activation.establishOpeningPosition(pool,{user_id:user.id,activation_id:f.act.id});
    const rr=await http(f.token,"/operator/rent-roll?as_of=2026-07-31");
    const canonical=await http(f.token,"/operator/leasing/availability-canonical?as_of=2026-07-31");
    assert.equal(rr.status,200);assert.equal(canonical.status,200);
    assert.equal(canonical.body.rows.length,2);
    const states=Object.fromEntries(canonical.body.rows.map(r=>[r.space_label,r.marketing_state]));
    assert.equal(states.Room1,"occupied");
    if(parent) {
      assert.equal(rr.body.availability.length,1);
      assert.equal(rr.body.availability[0].current_status,reverse?"vacant":"current");
      const wrongOverlay=rr.body.rows.find(r=>(r.space_label||r.room)==="Room2");
      assert.ok(wrongOverlay.canonical?.current?.lease_id,"parent overlays the occupied neighbor's lease onto the vacant room");
      assert.ok(wrongOverlay.person_id,"parent overlays the occupied neighbor's person onto the vacant room");
    } else {
      assert.equal(rr.body.availability.length,2,"each canonical position survives the compatibility read");
      assert.equal(new Set(rr.body.availability.map(r=>r.space_id)).size,2);
      const byRoom=Object.fromEntries(rr.body.availability.map(r=>[r.space_label,r]));
      assert.equal(byRoom.Room1.current_status,"current");
      assert.equal(byRoom.Room2.current_status,"vacant");
      assert.equal(byRoom.Room1.contractual_open_now,false);
      assert.equal(byRoom.Room2.contractual_open_now,true);
      const empty=rr.body.rows.find(r=>(r.space_label||r.room)==="Room2");
      assert.equal(empty.person_id ?? null,null,"vacant room cannot inherit its neighbor's person");
      assert.equal(empty.canonical?.current ?? null,null,"vacant room cannot inherit its neighbor's lease");
      const askClient=await pool.connect();
      try {
        await askClient.query("begin isolation level repeatable read read only");
        const {gatherFacts}=require("../../src/agent/ask_spine_answer");
        const facts=await gatherFacts(askClient,{property_id:f.property.id,allowed_modules:["management"],subject:"tenancy"});
        assert.equal(facts.tenancy.read_state,"OK");
        assert.equal(facts.tenancy.position.rentable_positions,2);
        assert.equal(facts.tenancy.position.occupied,1);
        assert.equal(facts.tenancy.position.open,1);
        const denied=await gatherFacts(askClient,{property_id:f.property.id,allowed_modules:[],subject:"tenancy"});
        assert.equal(denied.tenancy,undefined);
        await askClient.query("rollback");
      } catch(error) { await askClient.query("rollback").catch(()=>{}); throw error; }
      finally {askClient.release();}
    }
    evidence.push({case:reverse?"vacant_first":"occupied_first",rent_roll_rows:rr.body.availability.length,rent_roll_statuses:rr.body.availability.map(r=>r.current_status),canonical_states:states});
  }
  const ambiguous=await fixture("Unit,Resident,Market Rent\n101,VACANT,900\n",true);
  const outcome=await http(ambiguous.token,`/deal-setup/proposals/${ambiguous.proposals[0].id}/confirm`,"POST");
  if(parent) {
    assert.equal(outcome.status,200);
    await activation.establishOpeningPosition(pool,{user_id:user.id,activation_id:ambiguous.act.id});
    const rr=await http(ambiguous.token,"/operator/rent-roll?as_of=2026-07-31");
    const canonical=await http(ambiguous.token,"/operator/leasing/availability-canonical?as_of=2026-07-31");
    assert.equal(rr.status,200);assert.equal(canonical.status,200);
    assert.equal(rr.body.availability[0].contractual_open_now,true);
    assert.equal(canonical.body.rows.find(r=>r.space_label==="Room1").marketing_state,"occupied");
    evidence.push({case:"ambiguous_vacancy",confirm_status:outcome.status,rent_roll_contractual_open:true,canonical_states:Object.fromEntries(canonical.body.rows.map(r=>[r.space_label,r.marketing_state]))});
  } else {
    assert.equal(outcome.status,422);
    assert.equal(outcome.body.error,"ambiguous_bed");
    const review=await activation.readActivation(pool,{user_id:user.id,activation_id:ambiguous.act.id});
    assert.equal(review.proposals[0].status,"needs_review");
    assert.equal(review.proposals[0].confirmed_at,null);
    evidence.push({case:"ambiguous_vacancy",confirm_status:outcome.status,error:outcome.body.error});
  }
  if (!parent) {
    const named=await fixture(header+vacant,true);
    assert.equal((await http(named.token,`/deal-setup/proposals/${named.proposals[0].id}/confirm`,"POST")).status,200,"named empty neighbor can be confirmed");
    const contested=await fixture(header+vacant.replace("Room2","Room1"),true);
    const contestedResult=await http(contested.token,`/deal-setup/proposals/${contested.proposals[0].id}/confirm`,"POST");
    assert.equal(contestedResult.status,409);
    assert.equal(contestedResult.body.error,"vacancy_contradicted_by_operative_lease");
    const unknown=await fixture(header+vacant.replace("Room2","Missing"),true);
    const unknownResult=await http(unknown.token,`/deal-setup/proposals/${unknown.proposals[0].id}/confirm`,"POST");
    assert.equal(unknownResult.status,422);
    assert.equal(unknownResult.body.error,"unknown_space_label");
    const renamed=await fixture(header+vacant,true);
    await pool.query("update units set unit_number='Renamed' where property_id=$1",[renamed.property.id]);
    const renamedResult=await http(renamed.token,`/deal-setup/proposals/${renamed.proposals[0].id}/confirm`,"POST");
    assert.equal(renamedResult.status,422);
    assert.equal(renamedResult.body.error,"current_unit_unavailable");
    assert.equal(Number((await one("select count(*) as n from units where property_id=$1",[renamed.property.id])).n),1,"vacancy confirmation cannot recreate inventory");
    const scoped=await http(named.token,`/operator/leasing/availability-canonical?property_id=${unknown.property.id}`);
    assert.equal(scoped.status,200);
    assert.equal(scoped.body.property_id,named.property.id,"query cannot retarget session property");
    await pool.query("update property_team_assignments set allowed_modules='{management}' where property_id=$1 and user_id=$2",[unknown.property.id,user.id]);
    assert.equal((await http(unknown.token,"/operator/leasing/availability-canonical")).status,403,"Leasing entitlement holds at the actual reader");
    evidence.push({case:"named_vacancy_boundaries",empty_neighbor:200,occupied_room:409,unknown_label:422});
    const single=await fixture("Unit,Resident,Market Rent\n101,VACANT,900\n","single");
    assert.equal((await http(single.token,`/deal-setup/proposals/${single.proposals[0].id}/confirm`,"POST")).status,200,"legitimate single-position vacancy remains confirmable");
    await activation.establishOpeningPosition(pool,{user_id:user.id,activation_id:single.act.id});
    const singleRead=await http(single.token,"/operator/rent-roll?as_of=2026-07-31");
    assert.equal(singleRead.body.availability.length,1);
    assert.ok(singleRead.body.availability[0].space_id,"single-position confirmation closes durable source lineage");
    assert.equal(singleRead.body.availability[0].current_status,"vacant");
    // Replay a historical promotion in synthetic setup; this is intentionally
    // not a new confirmation path. The reader must not publish that old error.
    await pool.query("update proposed_records set status='promoted', confirmed_by=$2, confirmed_at=now() where id=$1",[ambiguous.proposals[0].id,user.id]);
    await activation.establishOpeningPosition(pool,{user_id:user.id,activation_id:ambiguous.act.id});
    const history=await http(ambiguous.token,"/operator/rent-roll?as_of=2026-07-31");
    assert.equal(history.body.rows.length,1);
    assert.equal(history.body.rows[0].proposal_status,"promoted","historical confirmation is preserved");
    assert.equal(history.body.rows[0].publication_status,"held_for_review");
    assert.equal(history.body.availability.length,0,"old ambiguous claim cannot open a unit");
    evidence.push({case:"historical_ambiguous_claim",retained_rows:1,historical_status:"promoted",current_publication:"held_for_review"});
    // Opt-in historical-reader challenge. Product history is replayed only in
    // this owned synthetic database. TWO MODES, kept apart on purpose:
    //   "1"         positive defect witness — asserts the OBSERVED defect on the
    //               unrepaired product (77d6156): a position with no established
    //               occupancy basis was advertised beside legitimate vacancy.
    //               Expected to FAIL on repaired code; that failure is the
    //               evidence the repair changed the observed outcome.
    //   "successor" acceptance of the repair — the same fixtures, the same
    //               reads, the opposite outcome, plus controls the witness
    //               never needed: an operative lease, a future commitment and
    //               unreconciled evidence each keep their own state.
    // Neither mode deletes the other's assertions.
    if (process.env.PROOF_HISTORICAL_READER_CHALLENGE) {
      const challengeMode=process.env.PROOF_HISTORICAL_READER_CHALLENGE;
      assert.ok(["1","successor"].includes(challengeMode),"PROOF_HISTORICAL_READER_CHALLENGE must be 1 (witness) or successor");
      const witness=challengeMode==="1";
      const {datedPropertyPositions}=require("../../src/tenancy/dated_positions");
      const {gatherFacts}=require("../../src/agent/ask_spine_answer");
      const historical=await fixture("Unit,Resident,Market Rent\n101,VACANT,900\n",true);
      await pool.query("delete from leases where property_id=$1",[historical.property.id]);
      await pool.query("update proposed_records set status='promoted', confirmed_by=$2, confirmed_at=now() where id=$1",[historical.proposals[0].id,user.id]);
      await activation.establishOpeningPosition(pool,{user_id:user.id,activation_id:historical.act.id});
      const untouched=await fixture("Unit,Resident,Market Rent\n101,VACANT,900\n","single");
      const challenge=[];
      for (const [name,f,unknownCount] of [["historical_unbound",historical,2],["unconfirmed_source",untouched,1],["valid_single_position",single,0]]) {
        await pool.query("update spaces set use_type='residential' where unit_id in (select id from units where property_id=$1)",[f.property.id]);
        const before=await one("select to_jsonb(p) as record from proposed_records p where id=$1",[f.proposals[0].id]);
        const dp=await datedPropertyPositions(pool,{property_id:f.property.id,as_of:"2026-07-31"});
        const av=await http(f.token,"/operator/leasing/availability-canonical?as_of=2026-07-31");
        assert.equal(av.status,200);
        assert.equal(dp.positions.filter(p=>p.basis_state==="not_established").length,unknownCount);
        // Every position appears in exactly one state, in both modes.
        assert.equal(Object.values(av.body.states).reduce((a,b)=>a+b,0),av.body.count,"availability states are exhaustive");
        assert.equal(av.body.count,dp.positions.length);
        if (witness) {
          assert.equal(av.body.rows.filter(r=>r.marketing_state==="marketable_now").length,dp.positions.length,
            "positive defect witness: missing basis is currently advertised alongside legitimate vacancy");
        } else {
          const unknownRows=av.body.rows.filter(r=>r.marketing_state==="occupancy_unknown");
          assert.equal(unknownRows.length,unknownCount,"every position without an established basis reads occupancy_unknown");
          assert.equal(av.body.rows.filter(r=>r.marketing_state==="marketable_now").length,dp.positions.length-unknownCount,
            "only positions with an established basis may be offered");
          assert.equal(av.body.headline.marketable_now,dp.positions.length-unknownCount);
          assert.equal(av.body.headline.occupancy_unknown,unknownCount,"the headline never hides an unknown as a remainder");
          assert.equal(av.body.states.occupancy_unknown,unknownCount);
          for (const r of unknownRows) {
            assert.ok(r.space_id && r.unit_number && r.space_label,"an unknown position keeps its exact identity");
            assert.equal(r.basis_state,"not_established","the basis that produced the state travels with the row");
            assert.equal(r.available_from,null,"an unknown carries no promised date");
            assert.equal(r.blocking_fact,"occupancy_basis_not_established");
            assert.equal(r.blocking_reason,"no_established_occupancy_basis");
            assert.match(r.blocking_label,/not established/i);
          }
          // Same truth, third reader: the Rent Roll unit view refuses these the same way.
          const rrUnits=await http(f.token,"/operator/rent-roll/units?as_of=2026-07-31");
          assert.equal(rrUnits.status,200);
          assert.equal(rrUnits.body.totals.not_established,unknownCount);
          assert.equal(rrUnits.body.totals.open,unknownCount ? 0 : 1);
        }
        assert.ok(av.body.rows.every(r=>r.physical_readiness==="ready" && !r.certified_ready));
        const client=await pool.connect(); let facts;
        try {
          await client.query("begin isolation level repeatable read read only");
          facts=await gatherFacts(client,{property_id:f.property.id,allowed_modules:["management"],subject:"tenancy"});
          await client.query("rollback");
        } finally {client.release();}
        assert.equal(facts.tenancy.position.not_established,unknownCount);
        assert.equal(facts.tenancy.position.open,unknownCount ? 0 : 1);
        assert.deepEqual(await one("select to_jsonb(p) as record from proposed_records p where id=$1",[f.proposals[0].id]),before,
          "canonical reads must preserve every historical proposal field");
        challenge.push({case:name,positions:dp.positions.length,not_established:unknownCount,
          ask_open:facts.tenancy.position.open,marketable_now:av.body.headline.marketable_now,
          occupancy_unknown:av.body.states.occupancy_unknown ?? null,
          marketing_states:Object.fromEntries(av.body.rows.map(r=>[r.space_label,r.marketing_state])),
          evidence_states:av.body.rows.map(r=>r.evidence_state),readiness:av.body.rows.map(r=>r.physical_readiness),
          certifications:av.body.rows.filter(r=>r.certified_ready).length,proposal_unchanged:true});
      }
      if (!witness) {
        // CONTROL 1 — an operative lease outranks a missing basis. Room1 holds a
        // lease in force and no opening claim; Room2 holds nothing at all.
        const leased=await fixture("Unit,Resident,Market Rent\n101,VACANT,900\n",true);
        await pool.query("update spaces set use_type='residential' where unit_id in (select id from units where property_id=$1)",[leased.property.id]);
        const leasedAv=await http(leased.token,"/operator/leasing/availability-canonical?as_of=2026-07-31");
        const leasedStates=Object.fromEntries(leasedAv.body.rows.map(r=>[r.space_label,r.marketing_state]));
        assert.deepEqual(leasedStates,{Room1:"occupied",Room2:"occupancy_unknown"},"a lease in force is never hidden by a weak or missing opening claim");
        assert.equal(leasedAv.body.rows.find(r=>r.space_label==="Room1").basis_state,"established");
        // CONTROL 2 — a future commitment outranks a missing basis. The single
        // unconfirmed room gains a lease that starts after the as-of date.
        const [untouchedSpace]=(await pool.query("select s.id from spaces s join units u on u.id=s.unit_id where u.property_id=$1",[untouched.property.id])).rows;
        await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,900,'2026-10-01','2027-09-30','active')",[untouched.property.id,untouchedSpace.id,[]]);
        const futureAv=await http(untouched.token,"/operator/leasing/availability-canonical?as_of=2026-07-31");
        assert.equal(futureAv.body.rows.length,1);
        assert.equal(futureAv.body.rows[0].marketing_state,"successor_pending","a committed future resident is reported as a commitment, not as an unknown and not as an offer");
        assert.equal(futureAv.body.rows[0].basis_state,"not_established","the commitment does not manufacture an occupancy basis for today");
        // CONTROL 3 — unreconciled opening evidence keeps its own state. A
        // confirmed named vacancy under an established baseline is replayed as a
        // held row (synthetic history, this owned database only): the reader
        // must say "unresolved", never "unknown" and never "marketable".
        const held=await fixture(header+vacant,true);
        assert.equal((await http(held.token,`/deal-setup/proposals/${held.proposals[0].id}/confirm`,"POST")).status,200);
        await activation.establishOpeningPosition(pool,{user_id:user.id,activation_id:held.act.id});
        await pool.query("update proposed_records set status='needs_review', status_reason='synthetic replay: held under an established baseline' where id=$1",[held.proposals[0].id]);
        await pool.query("update spaces set use_type='residential' where unit_id in (select id from units where property_id=$1)",[held.property.id]);
        const heldDp=await datedPropertyPositions(pool,{property_id:held.property.id,as_of:"2026-07-31"});
        const heldRoom2=heldDp.positions.find(p=>p.space_label==="Room2");
        assert.equal(heldRoom2.basis_type,"opening_position_unreconciled");
        assert.equal(heldRoom2.bucket,"needs_review","the Rent Roll holds the bed for review");
        const heldAv=await http(held.token,"/operator/leasing/availability-canonical?as_of=2026-07-31");
        const heldStates=Object.fromEntries(heldAv.body.rows.map(r=>[r.space_label,r.marketing_state]));
        assert.deepEqual(heldStates,{Room1:"occupied",Room2:"evidence_unreconciled"});
        const heldRow=heldAv.body.rows.find(r=>r.space_label==="Room2");
        assert.equal(heldRow.available_from,null);
        assert.equal(heldRow.blocking_fact,"opening_evidence_unreconciled");
        assert.equal(heldAv.body.headline.evidence_unreconciled,1);
        assert.equal(heldAv.body.headline.occupancy_unknown,0,"unresolved evidence is not counted as absence of evidence");
        const heldClient=await pool.connect(); let heldFacts;
        try {
          await heldClient.query("begin isolation level repeatable read read only");
          heldFacts=await gatherFacts(heldClient,{property_id:held.property.id,allowed_modules:["management"],subject:"tenancy"});
          await heldClient.query("rollback");
        } finally {heldClient.release();}
        assert.equal(heldFacts.tenancy.position.needs_review,1,"Ask Spine holds the same bed for review");
        assert.equal(heldFacts.tenancy.position.open,0);
        challenge.push({case:"controls",operative_lease:leasedStates,future_commitment:futureAv.body.rows[0].marketing_state,
          unreconciled:heldStates,unreconciled_bucket:heldRoom2.bucket,ask_needs_review:heldFacts.tenancy.position.needs_review});
      }
      fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR,`historical-reader-challenge-${witness?"witness":"successor"}.json`),JSON.stringify({
        mode:witness?"positive_defect_witness":"successor",product_base:witness?"77d61569cf184720eea5af9f88e339c0ba2c0779":null,evidence:challenge,
        actual_source_confirmations:0,limits:["No browser or production proof","Replacement inventory and missing named-room witnesses not exercised"]},null,2));
      console.log(`PASS historical reader ${witness?"positive defect witnesses":"successor acceptance"}`);
    }
    const browserFixture=await fixture(header+occupied+vacant+vacant.replace("Room2","Room3"));
    for(const p of browserFixture.proposals) assert.equal((await http(browserFixture.token,`/deal-setup/proposals/${p.id}/confirm`,"POST")).status,200);
    await activation.establishOpeningPosition(pool,{user_id:user.id,activation_id:browserFixture.act.id});
    await pool.query("update spaces set use_type='residential' where unit_id in (select id from units where property_id=$1)",[browserFixture.property.id]);
    const marketing=await http(browserFixture.token,"/operator/leasing/availability-canonical?as_of=2026-07-31");
    assert.deepEqual(marketing.body.rows.filter(r=>r.marketing_state==="marketable_now").map(r=>r.space_label).sort(),["Room2","Room3"]);
    browserFixtures.push({token:browserFixture.token,property_id:browserFixture.property.id,expected_available_labels:["Room2","Room3"]});

  }
  if(!parent) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR,"space-state.private.json"),JSON.stringify({fixtures:browserFixtures}));
  fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR,`space-availability-${parent?"parent":"successor"}.json`),JSON.stringify({mode:parent?"positive_defect_witness":"successor",evidence},null,2));
  console.log(`PASS space availability ${parent?"positive defect witness":"successor"}`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(pool)await pool.end();});
