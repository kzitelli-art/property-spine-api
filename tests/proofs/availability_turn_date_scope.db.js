"use strict";
// Class 3: synthetic records only in a nonce-verified, caller-owned database.
// This exercises the canonical read, not a prospective planning writer.
const assert = require('node:assert/strict');
const boundary = require('../e2e/proof_boundary');
require('../e2e/proof_fence_preload');
const { Pool } = require('pg');
const { availabilityRead } = require('../../src/surfaces/availability_read');
const sessions = require('../../src/identity/staff_session_service');

(async () => {
  await boundary.assertDatabase();
  assert.ok(process.env.E2E_API_BASE, 'owned HTTP server required');
  const pool = new Pool({connectionString:boundary.manifest().url,ssl:false});
  const one = async (sql,args=[]) => (await pool.query(sql,args)).rows[0];
  try {
    const p = await one("insert into properties(name) values('Owned turnover date scope proof') returning id");
    const user = await one("insert into users(name,is_active,status) values('Owned date scope operator',true,'active') returning id");
    await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Leasing',array['leasing'],true)",[p.id,user.id]);
    const session = await sessions.issueStaffSession(pool,{userId:user.id,propertyId:p.id,purpose:'bootstrap_invite'});
    const u = await one("insert into units(property_id,unit_number) values($1,'Shared') returning id",[p.id]);
    await pool.query('delete from spaces where unit_id=$1',[u.id]);
    const a = await one("insert into spaces(unit_id,space_label,use_type) values($1,'Bed A','residential') returning id",[u.id]);
    const b = await one("insert into spaces(unit_id,space_label,use_type) values($1,'Bed B','residential') returning id",[u.id]);
    const l = await one("insert into leases(property_id,space_id,start_date,end_date,lease_status) values($1,$2,'2026-01-01','2026-07-01','active') returning id",[p.id,a.id]);
    const t = await one("insert into turnovers(property_id,unit_id,outgoing_lease_id,status,ready_date) values($1,$2,$3,'in_progress','2026-10-01') returning id",[p.id,u.id,l.id]);
    let reconciliations=0;
    const read = async () => {
      const canonical = await availabilityRead(pool,{property_id:p.id,as_of:'2026-09-11'});
      const r=await fetch(process.env.E2E_API_BASE+'/operator/leasing/availability-canonical?as_of=2026-09-11', {headers:{'x-staff-session':session.session_token}});
      assert.equal(r.status,200);
      const served=await r.json();
      assert.deepEqual(served.rows,canonical.rows,'staff HTTP uses the same canonical dates, scope and provenance');
      reconciliations++;
      return served.rows;
    };
    let rows = await read();
    const at = id => rows.find(r=>r.space_id===id);
    assert.equal(at(a.id).available_from,'2026-10-01','outgoing bed retains its expected date');
    assert.equal(at(a.id).availability_confidence,'expected','a plan is never confirmed readiness');
    assert.equal(at(b.id).available_from,null,'a sibling cannot inherit another bed expected-ready date');
    assert.equal(at(b.id).turnover,null,'sibling cannot receive another bed turnover provenance');
    assert.notEqual(at(a.id).physical_readiness,'ready','expected date is not certification');
    await pool.query('update turnovers set ready_date=$2 where id=$1',[t.id,'2026-10-10']);
    rows=await read();
    assert.equal(at(a.id).available_from,'2026-10-10','read follows the current canonical date');
    assert.equal(at(b.id).available_from,null);
    await pool.query('update turnovers set outgoing_lease_id=null where id=$1',[t.id]);
    rows=await read();
    assert.equal(at(a.id).available_from,null,'unspecified shared-unit scope remains unknown');
    assert.equal(at(b.id).available_from,null);
    const whole = await one("insert into units(property_id,unit_number) values($1,'Whole') returning id",[p.id]);
    await pool.query("update spaces set use_type='residential' where unit_id=$1",[whole.id]);
    await pool.query("insert into turnovers(property_id,unit_id,status,ready_date) values($1,$2,'in_progress','2026-10-02')",[p.id,whole.id]);
    rows=await read();
    assert.equal(rows.find(r=>r.unit_id===whole.id).available_from,'2026-10-02','single whole-unit position retains unit-grain plan');
    const wholeSpace = await one('select id from spaces where unit_id=$1',[whole.id]);
    const wrongUnitLease = await one("insert into leases(property_id,space_id,start_date,end_date,lease_status) values($1,$2,'2026-01-01','2026-07-01','active') returning id",[p.id,wholeSpace.id]);
    await pool.query('update turnovers set outgoing_lease_id=$2 where id=$1',[t.id,wrongUnitLease.id]);
    rows=await read();
    assert.equal(at(a.id).available_from,null,'outgoing lease on another unit cannot grant a date');
    assert.equal(at(b.id).available_from,null);
    await pool.query("update spaces set position_kind='bed' where id=$1",[wholeSpace.id]);
    rows=await read();
    assert.equal(rows.find(r=>r.unit_id===whole.id).available_from,null,'one remaining bed is not a whole-unit plan');
    await pool.query("update turnovers set status='ready' where unit_id=$1",[whole.id]);
    rows=await read();
    assert.equal(rows.find(r=>r.unit_id===whole.id).turnover,null,'closed turn cannot remain a future estimate');
    console.log(`availability turnover date scope: 14 domain assertions and ${reconciliations} staff HTTP/canonical reconciliations passed`);
  } finally { await pool.end(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
