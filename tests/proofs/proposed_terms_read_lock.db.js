"use strict";
// Historical accumulated state, seeded before reads: acknowledged application
// and a pending revised invitation. This is not a claim about the write journey.
const assert = require("node:assert/strict");
const {randomUUID} = require("node:crypto");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const {Pool} = require("pg");
const {termsHash} = require("../../src/money/application_offer_terms");
const {readBoundApplicationOffer} = require("../../src/applications/proposed_terms_service");
const sessions = require("../../src/identity/staff_session_service");
const {readLeasingStanding} = require("../../src/leasing/leasing_standing_read");

(async () => {
  await boundary.assertDatabase();
  await boundary.waitServer(process.env.E2E_API_BASE);
  const pool = new Pool({connectionString:boundary.manifest().url, ssl:false});
  const one = async (sql,args=[]) => (await pool.query(sql,args)).rows[0];
  let passed=0;
  const check=(value,label)=>{assert.ok(value,label);passed++;console.log("PASS "+label);};
  try {
    const property=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1");
    const tag=randomUUID();
    // Keep this retained-history target separate from the journey's standard Bed B.
    const unit=await one("insert into units(property_id,unit_number,occupancy_status) values($1,$2,'unknown') returning id",[property.id,'History '+tag]);
    const target=await one("insert into spaces(unit_id,space_label,position_kind) values($1,'History bed','bed') returning id,unit_id",[unit.id]);
    const person=await one("insert into persons(name,source) values($1,'historical_read_fixture') returning id",['Terms history '+tag]);
    const actorPerson=await one("insert into persons(name,source) values($1,'historical_read_fixture') returning id",['Reader '+tag]);
    const user=await one("insert into users(name,role,is_active,status,account_kind,person_id) values($1,'leasing_agent',true,'active','human_staff',$2) returning id",['Reader '+tag,actorPerson.id]);
    await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active) values($1,$2,'Leasing Agent','{leasing}',true)",[user.id,property.id]);
    const session=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:property.id,purpose:'bootstrap_invite'});
    const terms={schema_version:1,property_id:property.id,person_id:person.id,target:{space_id:target.id,unit_id:target.unit_id},rent:'1200.00',security_deposit:'0.00',lease_start_date:'2026-10-01',lease_end_date:'2027-09-30',fees:[],concessions:{status:'none'}};
    const offers=[];
    for(const rent of ['1200.00','1350.00']){
      const version={...terms,rent};
      offers.push(await one(`insert into lease_offers(property_id,person_id,space_id,source,status,qualifying_action,offered_terms_snapshot,authority_basis_snapshot,granted_by_person_id,supersedes_application_offer_id,evidence_type,evidence_ref,communicated_at)
        values($1,$2,$3,'application_proposal','sent','application_submitted',$4,$5,$2,$6,'dispatched_message','historical_read_fixture',now()) returning id`,
        [property.id,person.id,target.id,JSON.stringify({application_terms:version,application_terms_hash:termsHash(version)}),JSON.stringify({via:'historical_read_fixture'}),offers[0]?.id||null]));
    }
    const app=await one(`insert into lease_applications(property_id,person_id,unit_id,space_id,applicant_name,status,application_offer_id,application_terms_hash,application_terms_acknowledged_at)
      values($1,$2,$3,$4,$5,'submitted',$6,$7,now()) returning *`,[property.id,person.id,target.unit_id,target.id,'Terms history '+tag,offers[0].id,termsHash(terms)]);
    await pool.query(`insert into application_invitations(token_digest,property_id,person_id,unit_id,space_id,lease_application_id,application_offer_id,expires_at)
      values($1,$2,$3,$4,$5,$6,$7,now()+interval '30 days')`,[randomUUID(),property.id,person.id,target.unit_id,target.id,app.id,offers[1].id]);
    // No fixture writes after this boundary. Current read must retain both versions.
    const client=await pool.connect();
    try{
      await client.query('begin transaction isolation level repeatable read read only');
      const read=await readBoundApplicationOffer(client,app,{allowHistorical:true,lock:false});
      check(read.id===offers[0].id&&read.terms.rent==='1200.00','acknowledged economics remain historical');
      check(read.pending_review.id===offers[1].id&&read.pending_review.terms.rent==='1350.00','pending revised economics remain separate');
      await client.query('commit');
      await client.query('begin transaction isolation level repeatable read read only');
      const standing=await readLeasingStanding(client,{person_id:person.id,property_id:property.id});
      check(!standing.uncertainty.some(n=>n.kind==='read_failed'), 'standing has no swallowed read failure: '+JSON.stringify(standing.uncertainty));
      check(standing.application.terms_review.acknowledged.rent==='1200.00'&&standing.application.terms_review.pending.rent==='1350.00','standing projects acknowledged and pending versions distinctly');
      await client.query('commit');
    }finally{await client.query('rollback').catch(()=>{});client.release();}
    const response=await fetch(process.env.E2E_API_BASE+'/operator/leasing/desk',{headers:{'x-staff-session':session.session_token||session.token},signal:AbortSignal.timeout(30000)});
    const body=await response.json();
    check(response.status===200,'real Leasing desk reads accumulated acknowledged plus successor state: '+JSON.stringify(body).slice(0,160));
    const after=await one('select application_offer_id,application_terms_hash from lease_applications where id=$1',[app.id]);
    check(after.application_offer_id===offers[0].id&&after.application_terms_hash===termsHash(terms),'reads do not transfer applicant acknowledgement to successor');
    console.log(`Proposed terms historical read: ${passed} passed, 0 failed`);
  }finally{await pool.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
