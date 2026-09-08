"use strict";
const assert = require("node:assert/strict");
const {test} = require("node:test");
const {marketingState,availableFrom}=require("../../src/surfaces/availability_read");
const vacant={basis_state:"established",basis_type:"opening_claim_vacant",evidence_state:"confirmed",
  use_type:"residential",physical_readiness:"ready",successor:{state:"none"}};

test("unknown occupancy cannot become an offer merely because a room is configured",()=>{
  for(const evidence_state of ["inconclusive","confirmed"]) {
    const p={...vacant,basis_state:"not_established",basis_type:"unit_occupancy_status_only",evidence_state};
    const m=marketingState(p,true);
    assert.equal(m.state,"occupancy_unknown");
    assert.equal(availableFrom(p,m.state,"2026-07-31").available_from,null);
  }
});
test("unreconciled opening evidence is held separately from absence of evidence",()=>{
  assert.equal(marketingState({...vacant,basis_type:"opening_position_unreconciled",evidence_state:"unreconciled"},true).state,"evidence_unreconciled");
  assert.equal(marketingState(vacant,true).state,"marketable_now","known vacancy remains a positive control");
});
test("a weaker opening claim does not hide an operative lease or future commitment",()=>{
  const unknown={...vacant,basis_state:"not_established",evidence_state:"inconclusive"};
  assert.equal(marketingState({...unknown,lease:{lease_id:"operative"}},true).state,"occupied");
  assert.equal(marketingState({...unknown,successor:{state:"locked"}},true).state,"successor_locked");
  assert.equal(marketingState({...unknown,availability_state:"committed_future",future_commitment:{state:"pending",proof_basis:"confirmed_opening_import"}},true).state,"successor_pending");
  assert.equal(marketingState({...unknown,availability_state:"committed_activation_pending"},true).state,"activation_pending");
});
test("read failure, conflict, down and readiness guards preserve their independent meaning",()=>{
  assert.equal(marketingState(vacant,false).state,"unavailable");
  assert.equal(marketingState({...vacant,conflict_state:"conflicted"},true).state,"contested");
  assert.equal(marketingState({...vacant,is_down:true},true).state,"down");
  assert.equal(marketingState({...vacant,evidence_state:"disagrees"},true).state,"evidence_disagrees");
  assert.equal(marketingState({...vacant,physical_readiness:"turning"},true).state,"turnover_required");
  assert.equal(marketingState({...vacant,triage:{pending_walk:true}},true).state,"readiness_unknown");
});

test("an accepted occupied opening claim with no operative lease is a claim, not an offer",()=>{
  // The dated position classifies this shape as evidence_state 'uncorroborated'
  // (source says occupied, Spine holds no lease). Before 2026-09-07 this read
  // consumed none of that and fell through to marketable_now.
  const uncorroborated={...vacant,basis_type:"opening_claim_occupied",evidence_state:"uncorroborated"};
  const m=marketingState(uncorroborated,true);
  assert.equal(m.state,"occupied");
  assert.equal(m.reason,"opening_claim_occupied_uncorroborated");
  const from=availableFrom(uncorroborated,m.state,"2026-07-31");
  assert.equal(from.available_from,null);
  assert.equal(from.blocking_fact,"opening_claim_occupied_uncorroborated");
  // Uncorroborated and contradictory stay different facts.
  assert.equal(marketingState({...vacant,evidence_state:"disagrees"},true).state,"evidence_disagrees");
  // Stronger facts still win: a lease, a turn in progress, a down hold, a contest, an unknown basis.
  assert.equal(marketingState({...uncorroborated,lease:{lease_id:"operative",end_date:"2027-12-31"}},true).reason,"spanning_lease");
  assert.equal(marketingState({...uncorroborated,physical_readiness:"turning"},true).state,"turnover_required");
  assert.equal(marketingState({...uncorroborated,is_down:true},true).state,"down");
  assert.equal(marketingState({...uncorroborated,conflict_state:"conflicted"},true).state,"contested");
  assert.equal(marketingState({...uncorroborated,basis_state:"not_established"},true).state,"occupancy_unknown");
  // The triage overlay does not turn an occupied claim into readiness_unknown.
  assert.equal(marketingState({...uncorroborated,triage:{pending_walk:true}},true).state,"occupied");
  // Positive control: a confirmed vacancy is still marketable.
  assert.equal(marketingState(vacant,true).state,"marketable_now");
});
