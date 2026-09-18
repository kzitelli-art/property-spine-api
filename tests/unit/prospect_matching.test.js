"use strict";
// Class 3: reader seam controls, not a DB/HTTP proof.
const assert=require("node:assert/strict");
const targetPath=require.resolve("../../src/applications/application_target_read");
const pricePath=require.resolve("../../src/money/effective_pricing");
const previous=[require.cache[targetPath],require.cache[pricePath]];
const calls=[];
let failTarget=false,failPrice=false,unresolved=false;
const targets=[1,2,3].map(n=>({unit_id:`u${n}`,space_id:`s${n}`,unit_number:String(n),space_label:"Room2",position_kind:"bed",marketing_state:"marketable_now"}));
require.cache[targetPath]={id:targetPath,filename:targetPath,loaded:true,exports:{leaseableApplicationTargets:async(q,args)=>{
  calls.push(args);if(failTarget)throw Error("unavailable");return {eligible_targets:targets};
}}};
require.cache[pricePath]={id:pricePath,filename:pricePath,loaded:true,exports:{resolveSpaceEconomics:async(q,args)=>{
  calls.push(args);if(failPrice)throw Error("unavailable");
  if(unresolved)return {resolved:false,reason:"lease_term_not_published",published_terms:[6]};
  return {resolved:true,rent:{new_lease_rent:{s1:950,s2:850,s3:800}[args.space_id]},authority:{basis:"space_override",published_version_id:"version",pricing_term_id:args.space_id},as_of:"2026-09-10"};
}}};
const pool={query:async(sql,args)=>{
  assert.match(sql,/u.property_id=\$1/);assert.match(sql,/s.use_type='residential'/);
  assert(!sql.includes("market_rent"));assert.deepEqual(args,["p"]);
  return {rows:targets.map(t=>({id:t.unit_id,space_id:t.space_id,bedrooms:2,bathrooms:1,square_feet:900}))};
}};
const inventory=require("../../src/leasing/leasing_inventory")({pool});
const input={property_id:"p",requested_start:"2026-12-01",requested_end:"2027-11-30",lease_term_months:12,discovery_mode:"exact_spaces",max_rent:900};
(async()=>{
  try {
    const missing=await inventory.availableUnits({...input,lease_term_months:null});
    assert.equal(missing.qualification,"pricing_term_required");assert.equal(calls.length,0);
    for(const value of [true,"12",0,1.5,[]])assert.equal((await inventory.availableUnits({...input,lease_term_months:value})).qualification,"invalid_pricing_term");
    assert.equal((await inventory.availableUnits({...input,max_rent:"900"})).qualification,"invalid_preferences");
    const out=await inventory.availableUnits({...input,limit:1});
    assert.equal(out.units.length,1);assert.equal(out.units[0].space_id,"s3");assert.equal(out.units[0].rent,800);
    assert.equal(out.units[0].rent_basis,"per_bed_monthly");assert.equal(out.units[0].dimensions_basis,"whole_unit");
    assert.equal(out.units[0].selection_eligible,false);assert.equal(out.may_promise,false);
    assert(calls.every(c=>c.property_id==="p"));
    assert(calls.filter(c=>c.space_id).every(c=>c.lease_term_months===12));
    assert.equal(inventory.matchConfirmationToOffer("yes",out.units),null);
    const empty=await inventory.availableUnits({...input,max_rent:100});
    assert.equal(empty.units.length,0);assert.equal(empty.qualification,"exact_space_matches_informational");
    unresolved=true;
    const unknown=await inventory.availableUnits(input);
    assert.equal(unknown.qualification,"matching_incomplete_pricing_unresolved");assert.equal(unknown.pricing_unresolved.length,3);
    assert.deepEqual(unknown.pricing_unresolved[0].published_terms,[6]);
    unresolved=false;failPrice=true;
    assert.equal((await inventory.availableUnits(input)).qualification,"pricing_read_unavailable");
    failPrice=false;failTarget=true;
    assert.equal((await inventory.availableUnits(input)).qualification,"term_check_unavailable");
    console.log("PASS exact-space informational matching: term, budget, limit, scope, rent basis, unknowns and failures");
  } finally {
    for(const [i,path] of [targetPath,pricePath].entries()){
      if(previous[i])require.cache[path]=previous[i];else delete require.cache[path];
    }
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
