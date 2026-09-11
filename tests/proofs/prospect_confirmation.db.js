"use strict";
// Class 3: owned Postgres and the real agent inbound service, scripted model.
// Historical dispatched offers are fixtures, never provider messages.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const boundary = require('../e2e/proof_boundary');
require('../e2e/proof_fence_preload');
const { Pool } = require('pg');
(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args=[]) => (await pool.query(sql,args)).rows[0];
  try {
    const property = await one("insert into properties(name) values($1) returning id", [`Owned confirmation ${randomUUID()}`]);
    const units = [];
    for (const number of ['101','102']) units.push(await one("insert into units(property_id,unit_number,bedrooms,occupancy_status) values($1,$2,1,'vacant') returning id,unit_number", [property.id,number]));
    const model = { messages: { create: async () => ({id:'owned-confirmation',content:[{type:'text',text:'Please clarify your preferred home.'}]}) } };
    const agent = require('../../src/agent/agent')({pool,anthropic:model})._service;
    const cases = [
      ['not 101',null], ['101 or 102?',null], ['is 101 available?',null],
      ["I do not want 101",null], ['yes, but not 101',null],
      ["I will take 101",units[0].id], ['101',units[0].id],
      ['yes',null], // two offers cannot be resolved from yes
      ['yes',units[0].id,[units[0]]],
      ['is 101 available',null],
      ['101',null,[{...units[0],space_id:randomUUID(),selection_eligible:true}]],
      ['yes',null,[{...units[0],space_id:randomUUID(),selection_eligible:true}]],
    ];
    const failures=[];
    for (const [body,expected,offered=units] of cases) {
      const person=await one("insert into persons(name) values('Owned confirmation prospect') returning id");
      const lead=await one('insert into leasing_leads(property_id,person_id) values($1,$2) returning id',[property.id,person.id]);
      const conv=await one("insert into conversations(property_id,person_id,channel_primary,status) values($1,$2,'sms','open') returning id",[property.id,person.id]);
      const inbound=await one("insert into comm_events(property_id,person_id,conversation_id,channel,direction,body) values($1,$2,$3,'sms','inbound','What homes?') returning id",[property.id,person.id,conv.id]);
      const outbound=await one("insert into comm_events(property_id,person_id,conversation_id,channel,direction,body) values($1,$2,$3,'sms','outbound','Historical fixture: units 101 and 102') returning id",[property.id,person.id,conv.id]);
      const run=await one("insert into agent_runs(conversation_id,inbound_comm_event_id,input_thread_version,generation_no,generation_reason,status,prompt_revision,policy_revision,model,offered_units_json) values($1,$2,0,1,'initial_inbound','ready','fixture','fixture','scripted',$3) returning id",[conv.id,inbound.id,JSON.stringify(offered)]);
      await pool.query("insert into agent_drafts(agent_run_id,generated_body,status,dispatched_comm_event_id,dispatched_at) values($1,'Historical fixture','dispatched',$2,now())",[run.id,outbound.id]);
      const response=await agent.processInbound({property_id:property.id,person_id:person.id,body});
      assert.equal(response.status,200,JSON.stringify(response));
      const selected=await one('select unit_id from leasing_leads where id=$1',[lead.id]);
      const pass=selected.unit_id===expected;
      console.log(`${pass?'PASS':'FAIL'} ${JSON.stringify(body)} => ${selected.unit_id}`);
      if(!pass) failures.push(body);
    }
    assert.equal(failures.length,0,`False confirmations: ${failures.join('; ')}`);
    console.log(`PASS ${cases.length} real agent/DB confirmation cases; no HTTP/provider proof`);
  } finally { await pool.end(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
