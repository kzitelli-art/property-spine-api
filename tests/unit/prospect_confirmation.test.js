"use strict";
// Class 3: deterministic historical-offer confirmation boundary.
const assert = require('node:assert/strict');
const match = require('../../src/leasing/leasing_inventory')({pool:{}}).matchConfirmationToOffer;
const first={id:'u1',unit_number:'101'}, second={id:'u2',unit_number:'102'};
const offers=[first,second];
let count=0;
for (const text of ['not 101','101 or 102','101 and 102',"I don't want 101",'is 101 available','is 101 available?',
  'yes but not 101','101 if it has parking','maybe 101','101 instead of 102','I want 101 not 102',
  'never 101','101 is too expensive','I liked 101 yesterday','yes','the first one','1101',
  'I am not sure','yes I have another question','sure, is it available']) {
  assert.equal(match(text,offers),null,text);count++;
}
for(const text of ['101','Unit 101','I will take 101',"I'll take Unit 101.",'I choose 101','yes, 101','Please select 101','I want 101']) {
  assert.equal(match(text,offers),first,text);count++;
}
for(const text of ['yes','sure!','sounds good',"I'll take it"]) {
  assert.equal(match(text,[first]),first,text);count++;
}
for(const text of ['not sure','yes but I have a question','is it available','yes?','I am interested in pricing']) {
  assert.equal(match(text,[first]),null,text);count++;
}
assert.equal(match('101',[first,{...first,id:'duplicate'}]),null);count++;
assert.equal(match('101',[{...first,space_id:'bed-a'}]),null);count++;
assert.equal(match('yes',[{...first,space_id:'bed-a'}]),null);count++;
assert.equal(match('101',[{...first,selection_eligible:false}]),null);count++;
assert.equal(match('yes',[{...first,selection_eligible:false}]),null);count++;
console.log(`PASS ${count} historical unit confirmation controls`);
