"use strict";
// Service-level falsification. No provider, database or HTTP proof is claimed.
const assert = require('node:assert/strict');
const command = require('../../src/applications/application_send_command');
const capability = require('../../src/identity/capability');
const targetAuthority = require('../../src/applications/application_target_authority');
const originalTarget = targetAuthority.resolveApplicationTarget;
const {makeStaffLeasingAction} = require('../../src/leasing/staff_sms_action');
const originalStage = command.stageApplicationSend;
const originalBirth = capability.evaluateApplicationLinkBirth;
const terms={rent:'1025.00',security_deposit:'0.00',lease_start_date:'2026-10-01',lease_end_date:'2027-09-30',fees:[],concessions:{status:'none'}};
const hash=require('../../src/money/application_offer_terms').termsHash(terms);
let rolledBack = false;
const client = {release(){}, async query(sql) {
  if (sql === 'rollback') { rolledBack = true; return {rows:[]}; }
  if (sql === 'begin') return {rows:[]};
  if (/from application_intents ai/.test(sql)) return {rows:[]};
  if (/for update of lc/.test(sql)) return {rows:[{id:'conversion',person_id:'person',prospect_name:'Jane'}]};
  if (/from leasing_conversions lc/.test(sql)) return {rows:[{id:'conversion',person_id:'person',prospect_name:'Jane'}]};
  if (/from units u/.test(sql)) return {rows:[{unit_number:'3B',space_label:'Bed B'}]};
  if (/select \* from lease_offers/.test(sql)) return {rows:[{id:'offer',offered_terms_snapshot:{application_terms:terms,application_terms_hash:hash}}]};
  if (/from lease_offers where source=/.test(sql)) return {rows:[]};
  if (/from lease_offers/.test(sql)) return {rows:[{id:'offer'}]};
  throw Error('Unexpected test query');
}};
const pool = {query:client.query.bind(client),connect:async()=>client};
async function exercise(error) {
  rolledBack=false;
  command.stageApplicationSend=async()=>{throw error;};
  const action=makeStaffLeasingAction({getConversionService:()=>({}),getApplicationInvitations:()=>({})});
  const {token}=action._private.confirmationCodec.mint({property_id:'property',actor_user_id:'staff',conversion_id:'conversion',unit_id:'unit',space_id:'bed',application_offer_id:'offer',application_terms_hash:hash});
  return action.run(pool,{transport:'dashboard',userId:'staff',body:`Confirm ${token}`,
    propertyContext:{outcome:'one',propertyId:'property',allowedModules:['leasing']}});
}
(async()=>{
  capability.evaluateApplicationLinkBirth=async()=>({allowed:true});
  targetAuthority.resolveApplicationTarget=async()=>({offerable:true,resolved_space_id:'bed'});
  const proposal=await makeStaffLeasingAction()._private.issueApplicationProposal(pool,{
    propertyId:'property',userId:'staff',conversionId:'conversion',
    target:{unit_id:'unit',space_id:'bed',unit_number:'3B',space_label:'Bed B'},
  });
  for (const fragment of ['$1,025.00','$0.00','2026-10-01','2027-09-30','no applicable fees','no concessions']) {
    assert(proposal.sms_prompt.includes(fragment),`SMS review must display ${fragment}`);
    assert(proposal.sms_prompt.indexOf(fragment)<proposal.sms_prompt.indexOf('Confirm sca1.'),'terms precede confirmation');
  }
  const out=await exercise(Object.assign(new Error('private internal detail'),{code:'APPLICATION_TERMS_REQUIRED',httpStatus:409}));
  assert(rolledBack,'canonical staging refusal rolls back before receipt');
  assert.equal(out.http_status,409);
  assert.equal(out.sent,false);
  assert.equal(out.outcome,'APPLICATION_TERMS_REQUIRED');
  assert.match(out.receipt,/complete offer/i);
  assert.match(out.receipt,/Nothing was sent/);
  assert(!out.receipt.includes('private internal detail'));
  const unexpected=new Error('private database failure');
  await assert.rejects(exercise(unexpected),e=>e===unexpected);
  assert(rolledBack,'unexpected errors still roll back and propagate');
  console.log('PASS canonical terms refusal becomes a safe receipt; unexpected failures remain failures');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  command.stageApplicationSend=originalStage;capability.evaluateApplicationLinkBirth=originalBirth;targetAuthority.resolveApplicationTarget=originalTarget;
});
