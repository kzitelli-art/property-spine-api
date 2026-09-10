"use strict";
// Class 3: owned disposable database; real staff-session HTTP triage capture.
// Required-work scope is a confirmed identity, never extracted from the note.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const boundary = require('../e2e/proof_boundary');
const sessions = require('../../src/identity/staff_session_service');
const {recordEffectivePossession,spacePosition} = require('../../src/tenancy/space_position');
const {gatherFacts} = require('../../src/agent/ask_spine_answer');

(async () => {
  await boundary.assertDatabase();
  assert.ok(process.env.E2E_API_BASE, 'owned HTTP server required');
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  try {
    const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
    const property = await one("insert into properties(name) values('Owned work scope proof') returning id");
    const unit = await one("insert into units(property_id,unit_number,occupancy_status) values($1,'Scope home','occupied') returning id", [property.id]);
    await pool.query('delete from spaces where unit_id=$1', [unit.id]);
    const bed = await one("insert into spaces(unit_id,space_label,use_type) values($1,'Bed A','residential') returning id", [unit.id]);
    const sibling = await one("insert into spaces(unit_id,space_label,use_type) values($1,'Bed B','residential') returning id", [unit.id]);
    const today = new Date().toISOString().slice(0,10);
    const end = new Date(Date.now()+365*86400000).toISOString().slice(0,10);
    const lease = await one("insert into leases(property_id,space_id,start_date,end_date,lease_status) values($1,$2,$3,$4,'active') returning id",[property.id,sibling.id,today,end]);
    await recordEffectivePossession(pool,{kind:'move_in',lease_id:lease.id,unit_id:unit.id,property_id:property.id,effective_date:today,source:'owned_fixture',actor:null});
    const possessionBefore = (await spacePosition(pool,{property_id:property.id})).positions.find(p=>p.space_id===sibling.id).current_possession;
    assert.ok(possessionBefore,'canonical sibling possession established');
    const user = await one("insert into users(name,is_active,status) values('Owned maintenance operator',true,'active') returning id");
    await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Maintenance',array['maintenance','management'],true)", [property.id,user.id]);
    const issued = await sessions.issueStaffSession(pool, { userId:user.id, propertyId:property.id, purpose:'bootstrap_invite' });
    assert.ok(issued.session_token, 'real session token issued');
    const response = await fetch(process.env.E2E_API_BASE + `/operator/units/${unit.id}/triage/confirm`, {
      method:'POST', headers:{'content-type':'application/json','x-staff-session':issued.session_token},
      body:JSON.stringify({text:'Bed A needs carpet work; Bed B remains occupied.',vacancy_observation:'occupied_or_someone_remains',initial_condition:'normal_turn',inspection_completeness:'initial_triage',
        findings:[],required_work:[{work_text:'Replace carpet',scope_kind:'rentable_space',space_id:bed.id}]})
    });
    const result = await response.json();
    assert.equal(response.status,201,JSON.stringify(result));
    assert.equal(result.recorded,true,'confirmation durably recorded');
    assert.equal(result.required_work.length,1,'one required work identity');
    const work = await one('select * from unit_triage_required_work where id=$1',[result.required_work[0].id]);
    assert.equal(work.unit_id,unit.id,'work retains its unit');
    assert.equal(work.property_id,property.id,'work retains server-derived property');
    assert.equal(work.space_id,bed.id,'confirmed exact bed survives HTTP capture into the canonical work row');
    assert.equal(work.scope_kind,'rentable_space','explicit scope remains distinct from unspecified or unit-wide');
    assert.notEqual(work.space_id,sibling.id,'sibling is not the work target');
    assert.equal((await one('select occupancy_status from units where id=$1',[unit.id])).occupancy_status,'occupied','planning work never performs move-out');
    assert.equal((await one('select count(*)::int n from turnovers where unit_id=$1',[unit.id])).n,0,'planning creates no actual turnover');
    const request = async (path,body) => {
      const r = await fetch(process.env.E2E_API_BASE+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-staff-session':issued.session_token},...(body?{body:JSON.stringify(body)}:{})});
      return {status:r.status,body:await r.json()};
    };
    const base = {text:'Bed B mentioned without a location decision',vacancy_observation:'occupied_or_someone_remains',initial_condition:'normal_turn',inspection_completeness:'initial_triage',findings:[]};
    const postWork = work => request(`/operator/units/${unit.id}/triage/confirm`,{...base,required_work:[work]});
    const unspecified = await postWork({work_text:'Bed B needs inspection'});
    assert.equal(unspecified.status,201);
    assert.equal(unspecified.body.required_work[0].scope_kind,'unspecified','prose does not select a bed');
    assert.equal(unspecified.body.required_work[0].space_id,null);
    assert.equal(unspecified.body.required_work[0].scope_label,'Location not established');
    const whole = await postWork({work_text:'Inspect common areas',scope_kind:'unit_wide'});
    assert.equal(whole.status,201);
    assert.equal(whole.body.required_work[0].scope_kind,'unit_wide');
    assert.equal(whole.body.required_work[0].space_id,null);
    assert.equal(whole.body.required_work[0].scope_label,'Whole unit');
    const otherProperty = await one("insert into properties(name) values('Other owned work property') returning id");
    const otherUnit = await one("insert into units(property_id,unit_number) values($1,'Other') returning id",[otherProperty.id]);
    const foreign = await one('select id from spaces where unit_id=$1',[otherUnit.id]);
    const samePropertyUnit = await one("insert into units(property_id,unit_number) values($1,'Other same property') returning id",[property.id]);
    const wrongUnit = await one('select id from spaces where unit_id=$1',[samePropertyUnit.id]);
    const counts = async()=> (await one(`select
      (select count(*)::int from unit_observations where unit_id=$1) observations,
      (select count(*)::int from unit_triage_required_work where unit_id=$1) work`,[unit.id]));
    const priorCounts = await counts();
    const invalidCorrection = await request(`/operator/units/${samePropertyUnit.id}/triage/confirm`,{
      ...base,required_work:[],supersedes_id:result.confirmation.id,correction_reason:'Must not correct another unit'});
    assert.equal(invalidCorrection.status,400,'correction predecessor must belong to the same unit and property');
    assert.equal((await one('select count(*)::int n from unit_observations where unit_id=$1',[samePropertyUnit.id])).n,0,'refused correction writes no observation');
    for (const bad of [
      {scope_kind:'rentable_space',space_id:foreign.id},
      {scope_kind:'rentable_space',space_id:wrongUnit.id},
      {scope_kind:'rentable_space'}, {scope_kind:'unit_wide',space_id:bed.id},
      {scope_kind:'made_up'}, {space_id:bed.id},
    ]) {
      const refusal = await postWork({work_text:'Rejected target',...bad});
      assert.equal(refusal.status,400,JSON.stringify(refusal));
      assert.deepEqual(await counts(),priorCounts,'invalid target writes no partial observation or work');
    }
    await assert.rejects(pool.query('update unit_triage_required_work set space_id=$2 where id=$1',[work.id,sibling.id]),/immutable/,'scope cannot be silently retargeted');
    for (const path of [`/operator/turn-work/${work.id}`,`/operator/units/${unit.id}/work-flow`,`/operator/units/${unit.id}/turn`]) {
      const read = await request(path);
      assert.equal(read.status,200,JSON.stringify(read));
      const text = JSON.stringify(read.body);
      assert.ok(text.includes(bed.id),`${path}: exact target retained`);
      assert.ok(text.includes('Bed A'),`${path}: canonical label retained`);
    }
    const proposal = await request(`/operator/units/${unit.id}/triage/propose`,{text:'Carpet needs replacement'});
    assert.equal(proposal.status,200);
    assert.deepEqual(proposal.body.work_targets.map(w=>w.space_id).sort(),[bed.id,sibling.id].sort(),'proposal offers only this unit spaces');
    const facts = await gatherFacts(pool,{property_id:property.id,allowed_modules:['maintenance'],subject:'work'});
    assert.equal(facts.maintenance.required_work_count,3,'Ask canonical standing includes the same three work identities');
    assert.deepEqual(facts.maintenance.items.map(w=>w.location),['Bed A','Location not established','Whole unit']);
    assert.equal(facts.maintenance.readiness,'not_asserted');
    assert.equal(facts.composite_silence.state,'ATTENTION');
    assert.ok(facts.composite_silence.domains.includes('maintenance'));
    assert.ok(!JSON.stringify(facts.maintenance).includes(bed.id),'composer receives labels, not raw database identifiers');
    const inaccessible = await gatherFacts(pool,{property_id:property.id,allowed_modules:['leasing'],subject:'work',requiredWorkReader:{readRequiredWorkStanding(){throw new Error('must not call unentitled reader');}}});
    assert.equal(inaccessible.maintenance,undefined,'unentitled maintenance facts never gathered');
    for (const code of ['BROKEN','READ_TIMED_OUT']) {
      const failed = await gatherFacts(pool,{property_id:property.id,allowed_modules:['maintenance'],subject:'work',requiredWorkReader:{async readRequiredWorkStanding(){throw Object.assign(new Error('owned read failure'),{code});}}});
      assert.equal(failed.maintenance.read_state,code==='READ_TIMED_OUT'?'READ_TIMED_OUT':'READ_FAILED','failed and timed out remain distinct');
      assert.ok(failed.reads_that_failed.some(x=>x.startsWith('maintenance')),'failed reader is named');
    }
    assert.deepEqual((await spacePosition(pool,{property_id:property.id})).positions.find(p=>p.space_id===sibling.id).current_possession,possessionBefore,'all scope writes preserve sibling possession');
    for (const table of ['unit_readiness_walks','unit_readiness_certifications','turnovers']) {
      assert.equal((await one(`select count(*)::int n from ${table} where unit_id=$1`,[unit.id])).n,0,`${table}: no readiness or actual turnover invented`);
    }
    const correction = await request(`/operator/units/${unit.id}/triage/confirm`,{
      ...base,required_work:[],supersedes_id:result.confirmation.id,correction_reason:'Clarify observation without changing existing work'});
    assert.equal(correction.status,201,'same-unit attributed correction remains available');
    assert.equal(correction.body.confirmation.supersedes_id,result.confirmation.id);
    assert.equal((await one('select space_id from unit_triage_required_work where id=$1',[work.id])).space_id,bed.id,'correction preserves original work identity');
    if (process.env.PROOF_WORK_SCOPE_BROWSER === '1') {
      const path = require('node:path');
      const {chromium} = require('playwright');
      const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME});
      try {
        const page = await browser.newPage({viewport:{width:390,height:844}});
        let captured;
        await page.exposeFunction('ownedTriageRequest',async(action,args)=>{
          let out;
          if(action==='propose') out=await request(`/operator/units/${args.unitId}/triage/propose`,{text:args.text});
          if(action==='confirm') {
            const {unitId,...body}=args;
            out=await request(`/operator/units/${unitId}/triage/confirm`,body);
            captured=out;
          }
          if(action==='walks') out=await request('/operator/unit-triage/open-walks');
          if(action==='risk') out=await request('/operator/unit-triage/risk');
          if(out.status>=400) throw new Error(JSON.stringify(out));
          return {data:out.body};
        });
        await page.setContent('<main id="psUnitTriageCapture"></main>');
        await page.evaluate(()=>{window.__psLive={hasSession:()=>true,
          proposeUnitTriage:a=>window.ownedTriageRequest('propose',a),
          confirmUnitTriage:a=>window.ownedTriageRequest('confirm',a),
          unitTriageOpenWalks:()=>window.ownedTriageRequest('walks'),
          unitTriageRisk:()=>window.ownedTriageRequest('risk')};});
        await page.addScriptTag({path:path.join(process.env.PSPINE_APP_ROOT,'unit-triage-door.js')});
        await page.locator('#utUnit').fill(unit.id);
        await page.locator('#utText').fill('Someone remains. The refrigerator is missing.');
        await page.locator('#utPropose').click();
        await page.locator('.ut-work-scope').first().selectOption('space:'+bed.id);
        await page.screenshot({path:path.join(require('node:os').tmpdir(),'triage-work-scope-browser.png'),fullPage:true});
        await page.locator('#utConfirm').click();
        await page.waitForFunction(()=>window.__psUnitTriage._state.receipt!==null);
        assert.equal(captured.status,201,'browser confirmation used real HTTP writer');
        const browserWork=captured.body.required_work[0];
        assert.equal(browserWork.space_id,bed.id,'browser-selected bed reaches durable work');
        const persisted=await one('select space_id,scope_kind from unit_triage_required_work where id=$1',[browserWork.id]);
        assert.deepEqual(persisted,{space_id:bed.id,scope_kind:'rentable_space'});
        console.log('TRIAGE_WORK_SCOPE_BROWSER_HTTP_PASSED');
      } finally {await browser.close();}
    }
    console.log('TRIAGE_WORK_SCOPE_HTTP_PASSED');
  } finally { await pool.end(); }
})().catch(error => { console.error(error); process.exitCode=1; });
