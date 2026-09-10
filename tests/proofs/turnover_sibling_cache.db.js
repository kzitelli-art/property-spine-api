"use strict";
// Class 3: owned disposable DB, canonical possession setup and real HTTP move-out.
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const boundary=require('../e2e/proof_boundary');
const {recordEffectivePossession,spacePosition}=require('../../src/tenancy/space_position');
(async()=>{
  await boundary.assertDatabase();
  assert.ok(process.env.E2E_API_BASE,'owned HTTP server required');
  const pool=new Pool({connectionString:boundary.manifest().url,ssl:false});
  try {
    const one=async(sql,args)=>(await pool.query(sql,args)).rows[0];
    const property=await one("insert into properties(name) values('Owned sibling turnover proof') returning id");
    const unit=await one("insert into units(property_id,unit_number,occupancy_status) values($1,'SIB','occupied') returning id",[property.id]);
    await pool.query('delete from spaces where unit_id=$1',[unit.id]);
    const beds=[];
    const start=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
    const end=new Date(Date.now()+180*86400000).toISOString().slice(0,10);
    for(const label of ['Bed A','Bed B']) {
      const space=await one("insert into spaces(unit_id,space_label,use_type) values($1,$2,'residential') returning id",[unit.id,label]);
      const lease=await one("insert into leases(property_id,space_id,start_date,end_date,lease_status) values($1,$2,$3,$4,'active') returning id",[property.id,space.id,start,end]);
      await recordEffectivePossession(pool,{kind:'move_in',lease_id:lease.id,unit_id:unit.id,property_id:property.id,effective_date:start,actor:null,source:'owned_fixture'});
      beds.push({space,lease});
    }
    const before=await spacePosition(pool,{property_id:property.id});
    assert.equal(before.positions.filter(p=>p.current_possession).length,2,'two canonical possessed beds before move-out');
    const response=await fetch(process.env.E2E_API_BASE+`/units/${unit.id}/move-out`,{
      method:'POST',headers:{'content-type':'application/json','x-operator-key':'e2e-key'},
      body:JSON.stringify({outgoing_lease_id:beds[0].lease.id,expected_ready_date:end}),
    });
    const body=await response.json();
    assert.equal(response.status,201,JSON.stringify(body));
    const events=(await pool.query("select space_id,lease_id from unit_events where unit_id=$1 and event_type='move_out'",[unit.id])).rows;
    assert.deepEqual(events,[{space_id:beds[0].space.id,lease_id:beds[0].lease.id}],'only outgoing bed possession ends');
    const after=await spacePosition(pool,{property_id:property.id});
    assert.ok(after.positions.find(p=>p.space_id===beds[1].space.id).current_possession,'sibling remains possessed');
    assert.equal((await one('select lease_status from leases where id=$1',[beds[1].lease.id])).lease_status,'active');
    assert.equal((await one('select occupancy_status from units where id=$1',[unit.id])).occupancy_status,'occupied','unit cache must not call an occupied sibling vacant');
    console.log('TURNOVER_SIBLING_CACHE_HTTP_PASSED');
  } finally {await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
