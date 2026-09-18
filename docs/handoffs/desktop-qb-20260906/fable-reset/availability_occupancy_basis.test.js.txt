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

