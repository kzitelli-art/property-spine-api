"use strict";
const assert = require("node:assert/strict");
const knowledge = require("../../src/leasing/leasing_knowledge");
const ask = require("../../src/agent/ask_spine_answer");
const { routeStaffSmsTurn } = require("../../src/conversation/staff_sms_router");
async function run() {
  const followup = require('../../src/leasing/followup_runner')({pool:{}});
  assert.match(followup.composeRung(2,{name:'Alex',virtualTourText:'Approved property tour https://example.com/tour'}),/https:\/\/example.com\/tour/);
  assert.equal(followup.composeRung(2,{name:'Alex',layout:'studio'}),'Hey Alex, would you like help arranging a tour?');
  for (const q of ["send me Skyline Matterport", "could you send me Greenery floor plans?", "show me photos", "does Skyline have laundry?", "does Skyline have a gym?", "is there a package room?", "where is the Fresh Grocer?", "what are the move-in instructions?", "what are the leasing highlights?", "what are the room dimensions?"]) {
    assert.equal(routeStaffSmsTurn({ text: q }).destination, "ask_spine", q);
    assert.equal(ask.questionSubject(q), "leasing_knowledge", q);
  }
  assert.deepEqual(knowledge.topicsFor("Does Skyline have a gym or package room?"), ["amenities"]);
  assert.deepEqual(knowledge.topicsFor("How close is the Fresh Grocer to Temple's campus?"), ["neighborhood"]);
  assert.equal(knowledge.isKnowledgeRead("What is the rent for a furnished apartment?"), false);
  assert.equal(ask.questionSubject("What is the rent for a furnished apartment?"), "economics");
  assert.equal(ask.questionSubject("What is the rent roll?"), "tenancy");
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
  assert.doesNotMatch(result.answer,/do not establish which apartment or bedroom/i);
  assert.equal(result.grounded_on.scope,"property_wide");
  assert.equal(result.grounded_on.exact_home_association,undefined);
  result = await ask.answer(db,null,{property_id:"property-a",allowed_modules:["leasing"],question:"send me Matterport for unit 2B"});
  assert.equal(result.outcome,"answered");
  assert.match(result.answer,/do not establish which apartment or bedroom/i);
  assert.equal(result.references[0].url,"https://my.matterport.com/show/?m=example");
  assert.equal(result.grounded_on.exact_home_association,"NOT_ESTABLISHED");
  const faq = await knowledge.answer({query:async()=>({rows:[{fact_key:"leasing_faq",rendered_text:"Contact the leasing office."}]})},
    {property_id:"property-a",allowed_modules:["leasing"],question:"show common questions"});
  assert.doesNotMatch(faq.answer,/apartment or bedroom/i);
  assert.equal(faq.grounded_on.exact_home_association,undefined);
  assert.deepEqual(knowledge.topicsFor("Do the apartments have washers and dryers?"), ["amenities"]);
  assert.deepEqual(knowledge.topicsFor("What one-bedroom and two-bedroom layouts do you have?"), ["layouts"]);
  assert.deepEqual(knowledge.topicsFor("What's around the building for coffee and groceries?"), ["neighborhood"]);
  assert.deepEqual(knowledge.topicsFor("Are utilities and internet included?"), ["leasing_faq"]);
  const before = reads;
  result = await ask.answer(db,null,{property_id:"property-a",allowed_modules:["maintenance"],question:"send me the Matterport"});
  assert.equal(result.outcome,"not_authorized"); assert.equal(reads,before);
  result = await knowledge.answer(db,{property_id:"property-a",allowed_modules:["leasing"],question:"show floor plans and Matterports"});
  assert.deepEqual(result.grounded_on.missing_topics,["floor_plans"]);
  assert.match(result.answer,/approved answer yet for floor plans/i);
  assert.match(result.answer,/approved virtual-tour resources/i);
  assert.doesNotMatch(result.answer,/^Virtual tours:/);
  const natural = await knowledge.answer({query:async()=>({rows:[{fact_key:"amenities",rendered_text:"Laundry is on every floor."}]})},
    {property_id:"property-a",allowed_modules:["leasing"],question:"what amenities are there?"});
  assert.match(natural.answer,/^For this property, I can confirm these amenities and inclusions:/);
  assert.doesNotMatch(natural.answer,/^Amenities:/m);
  result = await knowledge.answer({query:async()=>{throw new Error("offline");}},{property_id:"property-a",allowed_modules:["leasing"],question:"show photos"});
  assert.equal(result.grounded_on.leasing_knowledge,"READ_FAILED");
  assert.deepEqual(knowledge.safeLinks("javascript:alert(1) https://user:pass@example.com https://example.com/plan"),["https://example.com/plan"]);
  console.log("PASS leasing knowledge routing, scoped read, entitlement, missing topic, references and failure behavior");
}
run().catch(e=>{console.error(e);process.exitCode=1;});
