#!/usr/bin/env node
"use strict";
const path = require("path");
const service = require(path.resolve(process.argv[2] || path.join(__dirname, "..", "..", "src", "tenancy", "economic_tenancy_service.js")));
let pass=0,fail=0; const ok=(n,c)=>{if(c){pass++;console.log("PASS "+n)}else{fail++;console.log("FAIL "+n)}};

function dbFor({delivery=null,possession=null}){
  const lease={
    id:"lease-1", property_id:"p1", space_id:"s1", unit_id:"u1", unit_number:"101",
    start_date:"2026-07-01", end_date:"2027-06-30", lease_status:"active",
    tenant_ids:["person-1"], security_deposit:0, economic_tenancy_activated_at:"2026-07-01T12:00:00Z",
    executed_lease_record_id:"er1", executed_record_state:"verified"
  };
  return {query:async(sql,params)=>{
    if(sql.includes("from leases l")) return {rows:[lease]};
    if(sql.includes("from lease_move_in_charge_sets")) return {rows:[{id:"set1",required_fees:[],confirmed_at:"2026-07-01",confirmed_by_user_id:"user1",calculation_note:"verified",authority_basis:{}}]};
    if(sql.includes("from scheduled_charges c")) return {rows:[{id:"c1",move_in_requirement_key:"first_month",display_label:"First rent",charge_type:"first_month",amount:100,amount_paid:100,status:"paid",applied_total:100,cash_proven_total:100}]};
    if(sql.includes("current_date::text")) return {rows:[{today:"2026-07-23"}]};
    if(sql.includes("from persons")) return {rows:[{id:"person-1",name:"Resident"}]};
    if(sql.includes("from obligations")) return {rows:delivery?[delivery]:[]};
    if(sql.includes("from unit_events")) return {rows:possession?[possession]:[]};
    throw new Error("unhandled SQL: "+sql);
  }};
}

(async()=>{
  const none=await service.composeMoveInState(dbFor({}),"lease-1");
  ok("missing delivery is explicit",none.state==="delivery_obligation_missing");
  ok("missing delivery has no write",none.primary_action.method===null&&none.primary_action.endpoint===null);
  ok("missing delivery blocker emitted",none.blockers.some(b=>b.code==="delivery_obligation_missing"));

  const closed=await service.composeMoveInState(dbFor({delivery:{id:"ob1",status:"complete",required_inputs:[],assigned_role:"property_manager"}}),"lease-1");
  ok("closed-before-possession is blocked",closed.state==="delivery_obligation_missing");
  ok("closed delivery reported non-open",closed.delivery&&closed.delivery.open===false);

  const open=await service.composeMoveInState(dbFor({delivery:{id:"ob2",status:"open",required_inputs:[],assigned_role:"property_manager"}}),"lease-1");
  ok("open clear delivery is handoff-ready",open.state==="ready_for_handoff");
  ok("open delivery reported open",open.delivery&&open.delivery.open===true);

  const possessed=await service.composeMoveInState(dbFor({possession:{id:"pos1",effective_date:"2026-07-23",created_at:"2026-07-23T12:00:00Z",payload:{},source:"keys_handed_over"}}),"lease-1");
  ok("possession remains terminal truth",possessed.state==="possession_delivered");
  ok("possession beats missing delivery",possessed.primary_action.code==="view_completed_move_in");
  console.log(`${pass}/${pass+fail}`); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
