"use strict";
const assert=require('node:assert/strict');const {readStaffTourEssentials:read}=require('../../src/leasing/staff_sms_intent');
assert.equal(typeof read,'function','Existing staff intent owner must expose explicit preference capture');
const p=read('tour went great , they want a one bedroom high floor with a move in start of next month, send app');
assert.equal(p.unit_type,'one bedroom high floor');assert.equal(p.move_month,'start of next month');assert.equal(p.budget,undefined);
assert.deepEqual(read('Did they want a one bedroom with a move in next month?'),{});
assert.deepEqual(read('They do not want a one bedroom.'),{});
assert.deepEqual(read('If they want a studio, send app'),{});
assert.deepEqual(read('Tour was great. Unit 302 looked nice.'),{});
assert.equal(read('Tour finished. She wants a studio. Move-in October.').unit_type,'studio');
assert.equal(read('Tour finished. She wants a studio. Move-in October.').move_month,'October');
console.log('PASS explicit staff preference excerpts; relative timing preserved, no question/negative/hypothetical inference');

assert.deepEqual(read('Tour went great, they want one bedroom, not a high floor, send app'),{},'Do not strip a negative constraint from the recorded home preference');
