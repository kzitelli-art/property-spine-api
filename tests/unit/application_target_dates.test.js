"use strict";
const assert = require("node:assert/strict");
const availability = require("../../src/surfaces/availability_read");
const dated = require("../../src/tenancy/dated_positions");
const rows = [
  {space_id:"late",unit_id:"u1",unit_number:"101",marketing_state:"turnover_required",available_from:"2026-10-10",availability_confidence:"expected"},
  {space_id:"fits",unit_id:"u2",unit_number:"102",marketing_state:"turnover_required",available_from:"2026-10-01",availability_confidence:"expected"},
];
const originalRead = availability.availabilityRead, originalInterval = dated.intervalPropertyPositions;
availability.availabilityRead = async () => ({ rows });
const intervals=[];
dated.intervalPropertyPositions = async (_q,p) => { intervals.push(p); return {positions:rows.map(r=>({...r,interval_state:"contractually_free"}))}; };
delete require.cache[require.resolve("../../src/applications/application_target_authority")];
delete require.cache[require.resolve("../../src/applications/application_target_read")];
const {leaseableApplicationTargets} = require("../../src/applications/application_target_read");
(async()=>{
  const q={query:async()=>({rows:rows.map(r=>({...r,space_count:1}))})};
  const out=await leaseableApplicationTargets(q,{property_id:"p",requested_start:"2026-10-05",requested_end:"2027-09-30"});
  assert.deepEqual(out.eligible_targets.map(t=>t.space_id),["fits"],"choose for the prospect's dates, not each home's ready date");
  assert.equal(out.eligible_targets[0].intended_move_in,"2026-10-05");
  assert.equal(out.eligible_targets[0].requested_end,"2027-09-30");
  assert.equal(intervals.length,1,"same interval is read only once");
  assert.equal(intervals[0].requested_end,"2027-09-30","check whole requested lease");
  assert.equal(out.excluded_targets.length,1,"refused homes retain an explanation");
  assert.equal(out.excluded_targets[0].space_id,"late");
  assert.equal(out.excluded_targets[0].offerable,false);
  assert.equal(out.excluded_targets[0].refusal_code,"application_move_in_before_expected_ready");
  assert.match(out.excluded_targets[0].refusal_reason,/ready/i);
  assert.equal(out.excluded_targets[0].available_from,"2026-10-10");
  assert.equal(out.excluded_targets[0].availability_confidence,"expected");
  assert.equal(out.excluded_targets[0].resolved_space_id,undefined);
  await assert.rejects(()=>leaseableApplicationTargets(q,{property_id:"p",requested_start:"2026-02-30",requested_end:"2027-09-30"}),/dates/i);
  await assert.rejects(()=>leaseableApplicationTargets(q,{property_id:"p",requested_start:"2026-10-05"}),/dates/i);
  console.log("application target dates: 15 assertions passed");
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  availability.availabilityRead=originalRead;dated.intervalPropertyPositions=originalInterval;
});
