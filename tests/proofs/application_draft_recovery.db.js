"use strict";
// Historical ambiguity/corruption fixtures are established before every read.
// This proves the owner read in PostgreSQL READ ONLY, not an onboarding writer.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const boundary=require('../e2e/proof_boundary');
require('../e2e/proof_fence_preload');
const {Pool}=require('pg');
const {readCurrentApplicationDrafts,termsHash}=require('../../src/money/application_offer_terms');

(async()=>{
  await boundary.assertDatabase();
  const pool=new Pool({connectionString:boundary.manifest().url,ssl:false});
  const client=await pool.connect();
  let passed=0;
  const check=(condition,label)=>{assert.ok(condition,label);passed++;console.log('PASS '+label);};
  try {
    const property=(await client.query("select id from properties where name='Skyline E2E' order by created_at desc limit 1")).rows[0];
    assert.ok(property,'owned property fixture required');
    const target=(await client.query("select s.id,s.unit_id from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and s.space_label='Bed B' limit 1",[property.id])).rows[0];
    assert.ok(target,'owned exact-home fixture required');
    const otherProperty=(await client.query('select id from properties where id<>$1 limit 1',[property.id])).rows[0];
    assert.ok(otherProperty,'owned foreign property fixture required');
    const people=[];
    // Deliberately historical rows: the current public writer refuses these
    // duplicates. Never seed them as a claimed result of the corrected writer.
    for(const label of ['ambiguous','corrupt','quiet']) people.push((await client.query('insert into persons(name,source) values($1,$2) returning id',[`Draft recovery ${label} ${randomUUID()}`,'historical_read_fixture'])).rows[0].id);
    for(const [person,rent,corrupt] of [[people[0],1025,false],[people[0],1250,false],[people[1],1100,true]]){
      const terms={schema_version:1,property_id:property.id,person_id:person,target:{space_id:target.id,unit_id:target.unit_id},rent:String(rent)+'.00',security_deposit:'0.00',lease_start_date:'2026-10-01',lease_end_date:'2027-09-30',fees:[],concessions:{status:'none'}};
      await client.query(`insert into lease_offers(property_id,person_id,space_id,source,status,qualifying_action,offered_terms_snapshot,authority_basis_snapshot,granted_by_person_id)
        values($1,$2,$3,'application_proposal','draft','application_submitted',$4,$5,$2)`,
        [property.id,person,target.id,JSON.stringify({application_terms:terms,application_terms_hash:corrupt?'0'.repeat(64):termsHash(terms)}),JSON.stringify({via:'historical_read_fixture'})]);
    }
    await client.query('begin transaction isolation level repeatable read read only');
    const read=await readCurrentApplicationDrafts(client,{property_id:property.id,person_ids:[people[0],people[2]]});
    check(read.get(people[0]).draft_offers.length===0 && read.get(people[0]).ambiguous_space_ids.length===1 && read.get(people[0]).ambiguous_space_ids[0]===target.id,'historical duplicate current offers remain ambiguous, never newest-wins');
    check(read.get(people[2]).draft_offers.length===0 && read.get(people[2]).ambiguous_space_ids.length===0,'a quiet person remains empty, distinct from ambiguity');
    const foreign=await readCurrentApplicationDrafts(client,{property_id:otherProperty.id,person_ids:[people[0]]});
    check(foreign.get(people[0]).draft_offers.length===0 && foreign.get(people[0]).ambiguous_space_ids.length===0,'the property scope excludes foreign draft facts');
    await assert.rejects(()=>readCurrentApplicationDrafts(client,{property_id:property.id,person_ids:[people[1]]}),e=>e.code==='APPLICATION_OFFER_CORRUPT');
    check(true,'corrupt retained terms fail the read instead of becoming an empty draft list');
    await client.query('commit');
    console.log(`Application draft recovery: ${passed} passed, 0 failed (READ ONLY)`);
  } finally {await client.query('rollback').catch(()=>{});client.release();await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
