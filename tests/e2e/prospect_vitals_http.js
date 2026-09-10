"use strict";
// Class3. Owned proof only. Temporarily renames the owned facts table to prove read failure, then restores it.
const assert=require('node:assert/strict');
module.exports=async({c,f,session})=>{
 await require('./proof_boundary').assertDatabase();
 const person=(await c.query("insert into persons(name) values('Owned prospect-needs reader') returning id")).rows[0];
 const conversation=(await c.query('insert into conversations(property_id,person_id) values($1,$2) returning id',[f.property_id,person.id])).rows[0];
 const read=async route=>{const r=await fetch(process.env.E2E_API_BASE+route,{headers:{'x-staff-session':session}});return{status:r.status,body:await r.json()};};
 const door='/operator/leasing/conversations/'+conversation.id,card='/operator/leasing/person-card?person_id='+person.id;
 const empty=await read(door);assert.equal(empty.status,200,JSON.stringify(empty.body));assert.equal(empty.body.vitals.budget,null);
 const record=require('../../src/identity/person_facts').recordPersonFact;
 const context={personId:person.id,propertyId:f.property_id,source:'human',sourceRecordType:'unknown',actorType:'operator',actorUserId:f.user_id,claimStrength:'asserted'};
 for(const [attrKey,attrValue]of [['budget','0'],['unit_type','high-floor studio'],['move_month','2026-10']])assert((await record(c,{...context,attrKey,attrValue})).written);
 const before=await read(door),beforeCard=await read(card);assert.equal(before.status,200);assert.equal(beforeCard.status,200,JSON.stringify(beforeCard.body));assert.deepEqual(before.body.vitals,beforeCard.body.relationship.vitals);assert.equal(before.body.vitals.budget,'0');assert.equal(before.body.vitals.unit_type,'high-floor studio');
 assert((await record(c,{...context,attrKey:'move_month',attrValue:'2026-11',verb:'corrected',correctionReason:'Owned fixture prospect changed the requested month'})).written);
 const corrected=await read(door);assert.equal(corrected.body.vitals.move_month,'2026-11');
 await c.query('alter table person_attributes rename to proof_unavailable_person_attributes');
 try{
   const failed=await read(door);assert.equal(failed.status,503,JSON.stringify(failed.body));assert.equal(failed.body.error,'Prospect preferences could not be read. Retry before relying on them.');assert.equal(failed.body.vitals,undefined);
   const failedCard=await read(card);assert(failedCard.status>=500,'Person Card cannot represent a broken facts read as healthy preferences');
 }finally{await c.query('alter table proof_unavailable_person_attributes rename to person_attributes');}
 const recovered=await read(door),recoveredCard=await read(card);assert.equal(recovered.status,200);assert.equal(recoveredCard.status,200);assert.deepEqual(recovered.body.vitals,recoveredCard.body.relationship.vitals);assert.equal(recovered.body.vitals.move_month,'2026-11');

 console.log('PROSPECT_VITALS_HTTP: empty distinct from503; canonical facts/correction read identically through conversation and Person Card; owned failure restored; zero/text preserved');
 return {personId:person.id};
};
