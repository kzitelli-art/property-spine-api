"use strict";
const assert = require("node:assert/strict");
const knowledge = require("../../src/leasing/leasing_knowledge");
const ask = require("../../src/agent/ask_spine_answer");
const { routeStaffSmsTurn } = require("../../src/conversation/staff_sms_router");
async function run() {
  const followup = require('../../src/leasing/followup_runner')({pool:{}});
  assert.match(followup.composeRung(2,{name:'Alex',virtualTourText:'Approved property tour https://example.com/tour'}),/https:\/\/example.com\/tour/);
  assert.equal(followup.composeRung(2,{name:'Alex',layout:'studio'}),'Hey Alex, would you like help arranging a tour?');
  for (const q of ["send me Skyline Matterport", "could you send me Greenery floor plans?", "show me photos", "does Skyline have laundry?", "what are the leasing highlights?", "what are the room dimensions?"]) {
    assert.equal(routeStaffSmsTurn({ text: q }).destination, "ask_spine", q);
    assert.equal(ask.questionSubject(q), "leasing_knowledge", q);
  }
  for (const q of ["send Maria the floor plans", "send the floor plans to Maria", "send me floor plans to Maria", "show photos and loan balance", "update the amenities", "the laundry is broken", "send me photos and then text Maria"]) {
    assert.notEqual(ask.questionSubject(q), "leasing_knowledge", q);
  }
  assert.equal(routeStaffSmsTurn({text:"show me photos", attachments:[{url:"https://example.com/p.jpg"}]}).destination,"technician");
  let reads = 0;
  const db = { query: async (sql, params) => {
    reads++; assert.deepEqual(params,["property-a"]);
    assert.match(sql,/effective_until > now\(\)/); assert.match(sql,/space_id is null/);
    return { rows: [{fact_key:"virtual_tours", rendered_text:"Representative two bedroom: https://my.matterport.com/show/?m=example", source_type:"verified_operator_confirmation"}] };
  }};
  let result = await ask.answer(db, null, { property_id:"property-a", allowed_modules:["leasing"], question:"send me the Matterport" });
  assert.equal(result.outcome,"answered"); assert.match(result.answer,/Representative/);
  assert.equal(result.references[0].url,"https://my.matterport.com/show/?m=example");
  assert.match(result.answer,/do not establish which apartment or bedroom/i);
  assert.equal(result.grounded_on.scope,"property_wide");
  assert.equal(result.grounded_on.exact_home_association,"NOT_ESTABLISHED");
  result = await ask.answer(db,null,{property_id:"property-a",allowed_modules:["leasing"],question:"send me Matterport for unit 2B"});
  assert.equal(result.outcome,"answered");
  assert.match(result.answer,/do not establish which apartment or bedroom/i);
  assert.equal(result.references[0].url,"https://my.matterport.com/show/?m=example");
  assert.equal(result.grounded_on.exact_home_association,"NOT_ESTABLISHED");
  const faq = await knowledge.answer({query:async()=>({rows:[{fact_key:"leasing_faq",rendered_text:"Contact the leasing office."}]})},
    {property_id:"property-a",allowed_modules:["leasing"],question:"show common questions"});
  assert.doesNotMatch(faq.answer,/apartment or bedroom/i);
  assert.equal(faq.grounded_on.exact_home_association,undefined);
  const before = reads;
  result = await ask.answer(db,null,{property_id:"property-a",allowed_modules:["maintenance"],question:"send me the Matterport"});
  assert.equal(result.outcome,"not_authorized"); assert.equal(reads,before);
  result = await knowledge.answer(db,{property_id:"property-a",allowed_modules:["leasing"],question:"show floor plans and Matterports"});
  assert.deepEqual(result.grounded_on.missing_topics,["floor_plans"]); assert.match(result.answer,/Not established/);
  result = await knowledge.answer({query:async()=>{throw new Error("offline");}},{property_id:"property-a",allowed_modules:["leasing"],question:"show photos"});
  assert.equal(result.grounded_on.leasing_knowledge,"READ_FAILED");
  assert.deepEqual(knowledge.safeLinks("javascript:alert(1) https://user:pass@example.com https://example.com/plan"),["https://example.com/plan"]);
  console.log("PASS leasing knowledge routing, scoped read, entitlement, missing topic, references and failure behavior");
}
run().catch(e=>{console.error(e);process.exitCode=1;});
