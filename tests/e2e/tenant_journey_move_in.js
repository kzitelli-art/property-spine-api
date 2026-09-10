"use strict";
// Continue the same synthetic executed lease through canonical HTTP owners.
module.exports = async function moveIn({api,requireOk,expect,q,leaseId,propertyId,unitId,spaceId,personId,name,token}) {
  const route=`/operator/leasing/leases/${leaseId}`;
  const get=async path=>requireOk(await api("GET",path,{token}),path);
  const post=async(path,body={})=>requireOk(await api("POST",path,{token,key:true,body}),path);
  const state=()=>get(`${route}/move-in-state`);
  let s=await state();
  expect(!s.current_rent_roll_tenancy&&!s.possession,"Signing alone establishes neither active tenancy nor possession");
  const blocked=await api("POST",`${route}/activate-tenancy`,{token,body:{}});
  expect(blocked.status===409,"Activation refuses before required move-in funds are applied");
  const today=(await q("select current_date::text as today")).rows[0].today;
  const monthEnd=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(5,7)),0)).toISOString().slice(0,10);
  await post(`${route}/move-in-charges/confirm`,{first_period_amount:1025,first_period_start:today,
    first_period_end:monthEnd,required_fees:[],calculation_note:"Synthetic fixture: explicitly agreed first period 1025; no additional required fees.",
    idempotency_key:`tenant-journey-${leaseId}`});
  s=await state();
  expect(s.funds.charges.length>=2&&!s.funds.cleared,"Confirmed first rent and deposit remain unpaid claims");
  for(const charge of s.funds.charges) {
    const payment=await post(`/properties/${propertyId}/payments`,{person_id:personId,lease_id:leaseId,
      amount:charge.outstanding,paid_date:today,method:"manual",reference:"Synthetic local journey; no real money"});
    await post(`/payments/${payment.payment.id}/apply`,{scheduled_charge_id:charge.id,amount_applied:charge.outstanding});
  }
  await post(`${route}/activate-tenancy`);
  s=await state();
  expect(s.current_rent_roll_tenancy&&!s.possession,"Applied funds activate tenancy without inventing key handover");
  const premature=await api("POST",`${route}/delivery/keys-handed-over`,{token,body:{recipient_name:name}});
  expect(premature.status===409,"Keys refuse while operational readiness remains incomplete");
  await post("/operator/leasing/move-ins/process-due");
  const obligation=(await q(`select o.id from obligations o join unit_events ue on ue.id=o.related_id
    where ue.lease_id=$1 and o.related_type='unit_event' and o.module='movein' and o.type='readiness'`,[leaseId])).rows[0];
  expect(!!obligation,"The same lease's scheduled move-in creates its readiness work");
  for(const gate of ["readiness_checklist","appliances_checked","unit_condition_photos"])
    await post(`/operator/leasing/move-in-readiness/${obligation.id}/satisfy`,{gate,proof:{note:"Synthetic readiness proof; no real inspection"}});
  await post(`/operator/leasing/move-in-readiness/${obligation.id}/approve`,{note:"Synthetic local readiness approval"});
  await post(`${route}/delivery/keys-ready`);
  const handed=await post(`${route}/delivery/keys-handed-over`,{recipient_name:name,recipient_type:"resident",access_items:["Synthetic bed key"]});
  s=await state();
  expect(s.current_rent_roll_tenancy&&s.possession&&s.lease.space_id===spaceId&&handed.delivery_completed,
    "Key handover completes physical possession for the exact signed bed");
  const repeat=await post(`${route}/delivery/keys-handed-over`,{recipient_name:name});
  expect(repeat.idempotent===true,"Repeated handover does not duplicate possession");
  const roll=await get(`/operator/rent-roll/canonical?as_of=${today}`);
  const row=roll.rows.find(r=>r.space_id===spaceId);
  expect(!!row&&row.tenancy_state==="contractually_occupied","Canonical rent roll reads the same bed as occupied");
  expect(row.lease&&row.lease.lease_id===leaseId&&row.resident&&row.resident.person_id===personId,
    "Rent roll names the exact executed lease and original lead's durable person");
  expect(roll.totals.contractual_rent_trusted===1025,"Rent roll reads the agreed 1025 once");
  const lease=(await q("select tenant_ids,space_id from leases where id=$1",[leaseId])).rows[0];
  expect(lease.space_id===spaceId&&lease.tenant_ids.includes(personId),"Lead identity survives application, execution, move-in and rent roll");
};
