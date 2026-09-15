"use strict";
// Class 3: canonical agent service + real owned Postgres, scripted local model.
// No provider, dispatch, HTTP or complete matching claim.
const assert=require('node:assert/strict');
const boundary=require('../e2e/proof_boundary');
require('../e2e/proof_fence_preload');
const {Pool}=require('pg');
(async()=>{
 await boundary.assertDatabase();
 const pool=new Pool({connectionString:boundary.manifest().url,ssl:false});
 try {
  const property=(await pool.query("insert into properties(name) values('Owned inventory dates') returning id")).rows[0];
  const person=(await pool.query("insert into persons(name) values('Owned dates prospect') returning id")).rows[0];
  await pool.query('insert into leasing_leads(property_id,person_id) values($1,$2)',[property.id,person.id]);
  // Deliberately only a legacy vacancy label: contractual discovery must not
  // upgrade this synthetic home into confirmed readiness or a selectable offer.
  await pool.query("insert into units(property_id,unit_number,bedrooms,bathrooms,market_rent,occupancy_status) values($1,'101',1,1,1200,'vacant')",[property.id]);
  let input={},toolResult=null,advertised=null;
  const model={messages:{create:async req=>{
   if(!req.tools)return {content:[{type:'text',text:'{}'}]};
   const last=req.messages.at(-1);
   const result=Array.isArray(last.content)&&last.content.find(c=>c.type==='tool_result');
   if(result){toolResult=JSON.parse(result.content);return {id:'owned-reply',content:[{type:'text',text:'Thanks. I will explain what those dates allow.'}]};}
   advertised=req.tools.find(t=>t.name==='find_available_units');
   return {id:'owned-tool',content:[{type:'tool_use',id:'owned-inventory',name:'find_available_units',input}]};
  }}};
  const agent=require('../../src/agent/agent')({pool,anthropic:model})._service;
  async function invoke(criteria,body){
   input=criteria;toolResult=null;
   const out=await agent.processInbound({property_id:property.id,person_id:person.id,body});
   assert.equal(out.status,200,JSON.stringify(out));
   assert(toolResult,'canonical generation must reach the inventory tool result');
   return toolResult;
  }
  const term={requested_start:'2026-12-01',requested_end:'2027-11-30'};
  const dated=await invoke(term,'I want to move in 2026-12-01 and move out 2027-11-30. What homes fit those dates?');
  assert.deepEqual(dated.term,term,'the actual agent must carry the stated interval to inventory');
  assert(advertised.input_schema.properties.requested_start);
  assert(advertised.input_schema.properties.requested_end);
  assert.equal(dated.may_promise,false,'this connection cannot establish readiness');
  assert.equal(dated.qualification,'pricing_term_required','exact-space discovery preserves dates but must ask for the unchosen pricing term');
  assert.equal(dated.units.length,0,'legacy vacancy and unchosen economics cannot produce a candidate');
  const offered=(await pool.query('select offered_units_json from agent_runs where conversation_id=(select id from conversations where property_id=$1 and person_id=$2) order by created_at desc limit 1',[property.id,person.id])).rows[0].offered_units_json;
  assert.equal(offered.length,0);
  assert.equal(require('../../src/leasing/leasing_inventory')({pool}).matchConfirmationToOffer('yes',offered),null,'durable informational result cannot authorize selection');
  const missing=await invoke({},'What homes could work?');
  assert.equal(missing.qualification,'term_required');
  assert.equal(missing.may_promise,false);
  const invalid=await invoke({requested_start:'2026-02-30',requested_end:'2027-11-30'},'Could these dates work?');
  assert.equal(invalid.qualification,'invalid_term');
  assert.equal(invalid.may_promise,false);
  const counts=(await pool.query("select (select count(*) from application_invitations where property_id=$1)::int invitations, (select count(*) from lease_offers where property_id=$1)::int offers, (select count(*) from comm_events where property_id=$1 and direction='outbound')::int sent",[property.id])).rows[0];
  assert.deepEqual(counts,{invitations:0,offers:0,sent:0});
  console.log('PASS actual agent inventory dates: exact term, advertised inputs, missing/invalid distinct, no readiness promise or send');
 } finally {await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
