"use strict";
const assert=require('node:assert/strict');
const inventory=require('../../src/leasing/leasing_inventory')({pool:{query:async()=>{throw Error('Invalid dates must not query inventory');}}});
(async()=>{
 for(const term of [
  {requested_start:'2026-02-30',requested_end:'2027-11-30'},
  {requested_start:'2026-12-01',requested_end:'2026-12-01'},
  {requested_start:'2027-12-01',requested_end:'2026-12-01'},
  {requested_start:['2026-12-01'],requested_end:'2027-12-01'},
 ]) {
  const out=await inventory.availableUnits({property_id:'p',...term});
  assert.equal(out.qualification,'invalid_term');
  assert.equal(out.may_promise,false);
 }
 const missing=await inventory.availableUnits({property_id:'p',requested_start:'2026-12-01'});
 assert.equal(missing.qualification,'term_required');
 assert.equal(inventory.matchConfirmationToOffer('yes',[{id:'u',unit_number:'101',selection_eligible:false}]),null,'informational inventory is not a selectable offer');
 assert.equal(inventory.matchConfirmationToOffer('101',[{id:'u',unit_number:'101',selection_eligible:false}]),null);
 assert.equal(inventory.matchConfirmationToOffer('yes',[{id:'u',unit_number:'101',selection_eligible:true}]).id,'u');
 console.log('PASS inventory date validation and informational-versus-selectable controls');
})().catch(e=>{console.error(e);process.exitCode=1;});
