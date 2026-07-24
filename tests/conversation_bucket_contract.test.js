"use strict";
const fs=require('fs');
const path=require('path');
const root=path.resolve(process.argv[2]||'.');
const c=require(path.join(root,'conversation_operating_contract.js'));
let pass=0,fail=0;
function ok(name,condition){if(condition){pass++;console.log('  PASS '+name);}else{fail++;console.log('  FAIL '+name);}}
function row(overrides){return Object.assign({control_mode:'ai_active',waiting_on:'none',delivery_state:'none',last_inbound_at:null,last_delivered_outbound_at:null,last_any_outbound_at:null,rule_code:null},overrides||{});}
const cases=[
  ['human takeover is attention',row({control_mode:'human_takeover'}),'needs_attention','human_owned',10],
  ['awaiting review is attention',row({control_mode:'awaiting_review'}),'needs_attention','draft_requires_review',20],
  ['manager wait is attention',row({waiting_on:'manager',last_inbound_at:'2026-07-24'}),'needs_attention','human_attention_required',30],
  ['cadence exhaustion stays attention',row({waiting_on:'manager',rule_code:'cadence_exhausted_pending_human',last_delivered_outbound_at:'2026-07-24',delivery_state:'delivered'}),'needs_attention','cadence_exhausted_pending_human',30],
  ['no outreach is attention',row({}),'needs_attention','outreach_not_started',40],
  ['failed delivery is attention',row({last_any_outbound_at:'2026-07-24',delivery_state:'unknown'}),'needs_attention','delivery_failed_or_unconfirmed',40],
  ['delivered with zero inbound is no response',row({delivery_state:'delivered',last_delivered_outbound_at:'2026-07-24',last_any_outbound_at:'2026-07-24'}),'no_response','delivered_no_inbound_reply',100],
  ['AI waiting on a prospect after engagement is AI handling',row({waiting_on:'prospect',last_inbound_at:'2026-07-23',delivery_state:'delivered',last_delivered_outbound_at:'2026-07-24'}),'ai_handling','ai_waiting_on_prospect',200],
  ['AI preparing reply is AI handling',row({waiting_on:'ai',last_inbound_at:'2026-07-24'}),'ai_handling','ai_preparing_reply',200],
  ['engaged AI active is AI handling',row({last_inbound_at:'2026-07-24'}),'ai_handling','ai_active',200],
];
for(const [name,input,bucket,reason,priority] of cases){
  ok(name+' / bucket',c.classifyConversation(input)===bucket);
  ok(name+' / reason',c.reasonForConversation(input)===reason);
  ok(name+' / priority',c.priorityForConversation(input)===priority);
}
ok('exact three active buckets',JSON.stringify(c.ACTIVE_BUCKETS)===JSON.stringify(['needs_attention','ai_handling','no_response']));
ok('empty counts reconcile',Object.keys(c.EMPTY_COUNTS).length===3&&Object.values(c.EMPTY_COUNTS).every(v=>v===0));
const operator=path.join(root,'operator.js');
if(fs.existsSync(operator)){
  const src=fs.readFileSync(operator,'utf8');
  ok('operator imports one contract',src.includes('require("./conversation_operating_contract")'));
  ok('operator authors operating bucket',src.includes('operating_bucket'));
  ok('operator returns operating counts',src.includes('counts.operating_buckets = operatingBuckets'));
  ok('operator preserves legacy bucket during rollout',src.includes('control_bucket, bucket_reason_code'));
  ok('operator uses conversation board projection version',src.includes('projection_version: "conversation_board_v1"'));
}
console.log(`${pass}/${pass+fail}`);
process.exit(fail?1:0);
