'use strict';
const assert = require('node:assert/strict');
const {readRequiredWorkStanding} = require('../../src/maintenance/work_acceptance_service');
const {gatherFacts} = require('../../src/agent/ask_spine_answer');
(async()=>{
  const emptyDb={query:async()=>({rows:[]})};
  const oneDb={query:async()=>({rows:[{id:'private-work-id',space_id:'private-space-id',unit_id:'private-unit-id',unit_number:'101',scope_kind:'rentable_space',space_label:'Bed A',work_text:'Repair carpet',total_count:1}]})};
  const standing=await readRequiredWorkStanding(oneDb,{property_id:'owned'});
  const facts=await gatherFacts(emptyDb,{property_id:'owned',allowed_modules:['maintenance'],subject:'work',requiredWorkReader:{readRequiredWorkStanding:async()=>standing}});
  assert.equal(facts.composite_silence.state,'ATTENTION','outstanding required work cannot become composite quiet');
  assert.deepEqual(facts.composite_silence.domains,['maintenance']);
  assert.equal(facts.maintenance.items[0].location,'Bed A');
  assert.ok(!JSON.stringify(facts.maintenance).includes('private-'),'no work/unit/space identifiers in model facts');
  const quiet=await readRequiredWorkStanding(emptyDb,{property_id:'owned'});
  assert.equal(quiet.required_work_count,0);
  assert.equal(quiet.read_state,'OK');
  assert.equal(quiet.attention_state,'QUIET');
  assert.equal(quiet.readiness,'not_asserted');
  for(const code of ['BROKEN','READ_TIMED_OUT']) {
    const failed=await gatherFacts(emptyDb,{property_id:'owned',allowed_modules:['maintenance'],subject:'work',requiredWorkReader:{readRequiredWorkStanding:async()=>{throw Object.assign(new Error('owned failure'),{code});}}});
    assert.equal(failed.composite_silence.state,'BLIND');
    assert.equal(failed.maintenance.read_state,code==='READ_TIMED_OUT'?'READ_TIMED_OUT':'READ_FAILED');
  }
  console.log('required_work_standing: passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
