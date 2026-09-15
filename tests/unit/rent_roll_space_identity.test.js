"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {availabilityProjection}=require("../../src/shared/snapshot_loader");
const positions=[
  {space_id:"a",unit_number:"101",space_label:"Room1",physical_readiness:"ready",current_lease_position:{lease_id:"lease-a"}},
  {space_id:"b",unit_number:"101",space_label:"Room2",physical_readiness:"ready"}
];
const rows=[
  {unit_number:"101",room:"Room1",produced_space_id:"a",status:"current",actual_rent:0},
  {unit_number:"101",room:"Room2",produced_space_id:"b",status:"vacant",market_rent:0}
];
test("same-unit rooms retain identity, status and literal zero in either source order",()=>{
  for(const source of [rows,rows.slice().reverse()]) {
    const out=availabilityProjection(source,positions,"2026-07-31",true);
    assert.equal(out.length,2);
    const byId=Object.fromEntries(out.map(r=>[r.space_id,r]));
    assert.equal(byId.a.current_status,"current");assert.equal(byId.a.actual_rent,0);
    assert.equal(byId.a.contractual_open_now,false);
    assert.equal(byId.b.current_status,"vacant");assert.equal(byId.b.market_rent,0);
    assert.equal(byId.b.contractual_open_now,true);
  }
});
test("a future lease closes only its own room",()=>{
  const out=availabilityProjection(rows.map(r=>({...r,status:"vacant"})),[
    {...positions[0],future_lease_position:{lease_id:"future-a",rent:0}},positions[1]
  ],"2026-07-31",true);
  assert.equal(out.find(r=>r.space_id==="a").committed,true);
  assert.equal(out.find(r=>r.space_id==="b").committed,false);
});
test("recorded unresolved evidence stays unresolved when inventory shrinks to one room",()=>{
  const [out]=availabilityProjection([{unit_number:"101",status:"vacant",produced_space_id:null}],
    [positions[1]],"2026-07-31",true);
  assert.equal(out.space_id,null);assert.equal(out.current_status,"needs_review");
  assert.equal(out.contractual_open_now,false);assert.equal(out.marketable_now,false);
});
test("a stale durable link never falls back to a neighboring or renamed room",()=>{
  const [out]=availabilityProjection([rows[0]],[positions[1]],"2026-07-31",true);
  assert.equal(out.space_id,null);assert.equal(out.current_status,"needs_review");
});
