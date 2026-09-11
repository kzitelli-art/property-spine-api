"use strict";
// Class 3: owned HTTP/Postgres. Requires Skyline E2E activated in server config.
// E2E_INTAKE_INACTIVE_PROPERTY_ID must also be intake-allowlisted but NOT activated.
const assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
const boundary=require('../e2e/proof_boundary');require('../e2e/proof_fence_preload');
const {Pool}=require('pg'),sessions=require('../../src/identity/staff_session_service');
(async()=>{
 await boundary.assertDatabase();const pool=new Pool({connectionString:boundary.manifest().url,ssl:false});
 const one=async(s,a=[])=>(await pool.query(s,a)).rows[0];let failures=[];let count=0;
 const check=(v,label)=>{count++;console.log(`${v?'PASS':'FAIL'} ${label}`);if(!v)failures.push(label)};
 try{
  const p=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1");assert(p);
  const tag=randomUUID(), source=`Owned website ${tag}`;
  await pool.query("insert into lead_sources(name,source_type) values($1,'website')",[source]);
  const sms=()=>fs.existsSync(process.env.E2E_SMS_LOG)?fs.readFileSync(process.env.E2E_SMS_LOG,'utf8'):'';const beforeSms=sms();
  const post=async body=>{const r=await fetch(process.env.E2E_API_BASE+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake'},body:JSON.stringify({property_id:p.id,source,attempt_sms:false,response_channel:'website',...body})});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b};
  const made=[];
  for(const consent of [undefined,false,true]){
   const result=await post({name:'Owned real form',email:`${tag}-${String(consent)}@example.invalid`,phone:'+1202555'+String(1000+Math.floor(Math.random()*8999)),sms_consent:consent,source_lead_id:`${tag}-${String(consent)}`});made.push(result);
   const c=await one('select record_class,classification_reason from person_property_classifications where person_id=$1 and property_id=$2 and superseded_at is null',[result.person_id,p.id]);
   check(c.record_class==='production',`activated authenticated form consent=${String(consent)} is real production intake`);
   const pref=await one("select consent_state from contact_preferences where person_id=$1 and channel='text'",[result.person_id]);
   check(consent===true?pref?.consent_state==='opted_in':pref?.consent_state!=='opted_in',`consent=${String(consent)} permission matches evidence`);
   check(result.first_response_sent===false,'capture-only does not claim dispatched response');
  }
  const inactive=process.env.E2E_INTAKE_INACTIVE_PROPERTY_ID;assert(inactive,'inactive property control required');
  const held=await post({property_id:inactive,name:'Owned inactive form',email:`${tag}-inactive@example.invalid`,record_class:'production',authenticatedRealIntake:true});
  check((await one('select record_class from person_property_classifications where person_id=$1 and property_id=$2 and superseded_at is null',[held.person_id,inactive])).record_class==='internal_qa','unactivated authorized property stays QA despite forged body provenance');
  const denied=await fetch(process.env.E2E_API_BASE+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({property_id:p.id,email:`${tag}-anonymous@example.invalid`,authenticatedRealIntake:true})});
  check(denied.status===401,'anonymous client cannot assert real-source provenance');
  const foreign=await fetch(process.env.E2E_API_BASE+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake'},body:JSON.stringify({property_id:randomUUID(),email:`${tag}-foreign@example.invalid`})});
  check(foreign.status===403,'credential cannot write an unbound property');
  const demo=await fetch(process.env.E2E_API_BASE+'/demo/intake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({property_id:p.id,name:'Owned demo claim',phone:'+12025550199',authenticatedRealIntake:true})});
  check(demo.status===403,'disabled public demo cannot opt into real intake with body flags');
  const first=made[0];await pool.query("insert into contact_preferences(person_id,channel,consent_state,source) values($1,'text','opted_out','owned_fixture') on conflict(person_id,channel) do update set consent_state='opted_out'",[first.person_id]);
  const payload={name:'Owned real form',email:`${tag}-undefined@example.invalid`,source_lead_id:`${tag}-undefined`};
  const repeat=await post(payload);check(repeat.person_id===first.person_id&&repeat.lead_id===first.lead_id,'same source retry reuses person and open opportunity');
  check((await one("select consent_state from contact_preferences where person_id=$1 and channel='text'",[first.person_id])).consent_state==='opted_out','consent-free repeat preserves opted_out');
  const touches=await one('select count(*)::int n from lead_source_touches where lead_id=$1',[first.lead_id]);console.log(`OBSERVATION retry source touches=${touches.n}; source ID is not an exactly-once delivery key`);
  // A deliberate existing QA decision is not silently promoted by real-source birth.
  await pool.query("update person_property_classifications set record_class='internal_qa' where person_id=$1 and property_id=$2 and superseded_at is null",[first.person_id,p.id]);
  await post({...payload,record_class:'production',authenticated_real_intake:true});
  check((await one('select record_class from person_property_classifications where person_id=$1 and property_id=$2 and superseded_at is null',[first.person_id,p.id])).record_class==='internal_qa','existing explicit QA classification survives consent-free resubmission');
  const human=await one("insert into persons(name) values('Owned intake staff') returning id");const user=await one("insert into users(name,role,is_active,status,account_kind,person_id) values('Owned intake staff','leasing_agent',true,'active','human_staff',$1) returning id",[human.id]);
  await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,primary_for_modules,active) values($1,$2,'Leasing Agent','{leasing}','{leasing}',true)",[user.id,p.id]);
  const issued=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:p.id,purpose:'bootstrap_invite'});
  const r=await fetch(process.env.E2E_API_BASE+'/operator/leasing/conversations',{headers:{'x-staff-session':issued.session_token||issued.token}});const listing=await r.json();check(r.status===200&&listing.conversations?.some(c=>c.person_id===made[1].person_id),'real nonconsenting lead visible in scoped staff conversation read');
  check(sms()===beforeSms,'attempt_sms:false makes zero fake transport sends');
  console.log(`RESULT ${count-failures.length}/${count}`);assert.equal(failures.length,0,failures.join('; '));
 }finally{await pool.end()}
})().catch(e=>{console.error(e);process.exitCode=1});
