"use strict";
// Class 3: existing authenticated HTTP route + owned canonical event ledger.
const assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
const boundary=require('../e2e/proof_boundary');require('../e2e/proof_fence_preload');
const {Pool}=require('pg');
(async()=>{
 await boundary.assertDatabase();const m=boundary.manifest(),base='http://127.0.0.1:'+m.port;await boundary.waitServer(base);
 const pool=new Pool({connectionString:m.url,ssl:false});let checks=0;
 const check=(value,label)=>{assert.ok(value,label);checks++;console.log('PASS '+label)};
 try{
  const one=async(sql,args=[])=>(await pool.query(sql,args)).rows[0];
  const property=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1");assert(property);
  const other=process.env.E2E_INTAKE_INACTIVE_PROPERTY_ID;assert(other,'second allowlisted property required');
  assert(process.env.E2E_SMS_LOG,'owned fake SMS log required');
  assert(process.env.E2E_ANTHROPIC_LOG,'owned model sentinel log required');
  const log=file=>file&&fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  const otpSuffix=String(parseInt(randomUUID().slice(0,6),16)).padStart(7,'0').slice(-7),otpPhone='+1502'+otpSuffix;
  const otpProperty=await one("insert into properties(name) values($1) returning id",['Owned intake transport '+randomUUID()]);
  await pool.query("insert into communication_lines(e164,line_type,property_id,authority_ceiling,permitted_audience,outbound_enabled,outbound_policy,status) values($1,'property_facing',$2,'external','residents_and_prospects',true,'proactive','active')",['+1503'+otpSuffix,otpProperty.id]);
  const otpUser=await one("insert into users(name,phone,role,status,account_kind) values('Owned returning staff',$1,'property_manager','active','human_staff') returning id",[otpPhone]);
  await pool.query("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Manager','{leasing}',true)",[otpProperty.id,otpUser.id]);
  const otp=await fetch(base+'/auth/sms/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone_number:otpPhone})});
  const otpResult=await otp.json();check(otp.status===200&&otpResult.delivery==='sms_sent','owned returning-user OTP reaches fake transport');
  const smsBefore=log(process.env.E2E_SMS_LOG);
  check(smsBefore.trim().split('\n').some(line=>{const row=JSON.parse(line);return row.to===otpPhone&&/access code is \d{6}/.test(row.body)}),'unique synthetic OTP appears in this owned server SMS log');
  const bodyFor=()=>{const tag=randomUUID();return {property_id:property.id,source:'Website',source_lead_id:'provider-lead-'+tag,name:'Owned delivery proof',email:tag+'@example.invalid',phone:'+1500'+String(parseInt(tag.slice(0,6),16)).padStart(7,'0').slice(-7),attempt_sms:false,response_channel:'website',message:'Please tell me about laundry',raw_payload:{form:'leasing',submission:tag}}};
  const post=async(payload,key)=>{const r=await fetch(base+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake',...(key!==undefined?{'Idempotency-Key':key}:{})},body:JSON.stringify(payload)});return {status:r.status,body:await r.json()};};
  const counts=id=>one("select (select count(*)::int from lead_source_touches where lead_id=$1) touches,(select count(*)::int from lead_events where lead_id=$1 and event_type='lead_received') received,(select count(*)::int from lead_events where lead_id=$1 and event_type='ai_response_prepared') prepared",[id]);
  const body=bodyFor(),key='submission-'+randomUUID();
  const modelBeforeFirst=log(process.env.E2E_ANTHROPIC_LOG);
  const first=await post(body,key);check(first.status===200&&first.body.capture?.state==='captured'&&first.body.replayed===false,'first keyed delivery captures canonical receipt');
  const modelAfter=log(process.env.E2E_ANTHROPIC_LOG);
  check(modelAfter.length>modelBeforeFirst.length&&modelAfter.slice(modelBeforeFirst.length).includes('messages.create'),'first successful draft exercises the owned model sentinel');
  const reordered=Object.fromEntries(Object.entries(body).reverse());reordered.raw_payload={submission:body.raw_payload.submission,form:'leasing'};
  const second=await post(reordered,key);check(second.status===200&&second.body.replayed===true,'JSON key order does not change delivery fingerprint');
  check(second.body.lead_id===first.body.lead_id&&second.body.person_id===first.body.person_id&&second.body.conversation_id===first.body.conversation_id,'retry returns same durable identities');
  check(second.body.capture.lead_event_id===first.body.capture.lead_event_id&&second.body.capture.response_state==='prepared'&&second.body.first_response_sent===false,'retry reads existing preparation without a sent claim');
  assert.deepEqual(await counts(first.body.lead_id),{touches:1,received:1,prepared:1});check(true,'one touch, capture and prepared event for repeated key');
  check(log(process.env.E2E_ANTHROPIC_LOG)===modelAfter,'replay makes no second model request');
  for(const changed of [{...body,email:'changed-'+body.email},{...body,attempt_sms:true},{...body,message:'changed question'}])check((await post(changed,key)).status===409,'changed payload conflicts instead of rewriting captured delivery');
  for(const bad of ['', ' ', 'x'.repeat(257)])check((await post(bodyFor(),bad)).status===400,'supplied blank/oversize header refuses');
  const parallel=bodyFor(),parallelKey=randomUUID(),race=await Promise.all(Array.from({length:5},()=>post(parallel,parallelKey)));
  check(race.every(r=>r.status===200)&&race.filter(r=>r.body.replayed===false).length===1,'five concurrent retries capture once');
  const raceId=race[0].body.lead_id;assert.deepEqual(await counts(raceId),{touches:1,received:1,prepared:1});check(true,'concurrent retry creates one prepared draft');
  check((await one('select count(*)::int n from comm_events where conversation_id=$1',[race[0].body.conversation_id])).n===1,'concurrent replay creates one comm event');
  const distinct=await post(body,key+'-another-submission');check(distinct.status===200&&!distinct.body.replayed&&distinct.body.lead_id===first.body.lead_id,'new delivery retains another touch on same provider lead');
  assert.deepEqual(await counts(first.body.lead_id),{touches:2,received:2,prepared:2});check(true,'distinct submission not deduplicated by source_lead_id');
  const legacy=bodyFor();const legacyA=await post(legacy),legacyB=await post(legacy);check(legacyA.status===200&&legacyB.status===200&&!legacyB.body.capture,'legacy headerless intake keeps existing response contract');
  assert.deepEqual(await counts(legacyA.body.lead_id),{touches:2,received:2,prepared:2});check(true,'legacy same source_lead_id still records distinct arrivals');
  const scoped=bodyFor(),scopeKey=randomUUID();const sourceA=await post({...scoped,source:'Unmapped provider A'},scopeKey),sourceB=await post({...scoped,source:'Unmapped provider B'},scopeKey);
  check(sourceA.status===200&&sourceB.status===200&&!sourceB.body.replayed,'different original unmapped provider labels do not collapse into shared source bucket');
  const propertyB=await post({...scoped,property_id:other,source:'Unmapped provider A'},scopeKey);check(propertyB.status===200&&!propertyB.body.replayed&&propertyB.body.lead_id!==sourceA.body.lead_id,'delivery identity scoped by property');
  // Fail precisely AFTER canonical capture: raising from the response write
  // rolls back only response work. Retry must not regenerate or send.
  const failing=bodyFor(),failKey=randomUUID();const suffix=randomUUID().replaceAll('-','');
  const fn='owned_intake_fail_'+suffix;
  await pool.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if exists(select 1 from persons where id=NEW.person_id and email='${failing.email}') then raise exception 'owned post-capture response failure'; end if; return NEW; end $$`);
  await pool.query(`create trigger ${fn} before insert on comm_events for each row execute function ${fn}()`);
  let failed;try{failed=await post(failing,failKey)}finally{await pool.query(`drop trigger ${fn} on comm_events`);await pool.query(`drop function ${fn}()`);}
  check(failed.status===500,'injected response failure happens after canonical capture');
  const modelBeforeRetry=log(process.env.E2E_ANTHROPIC_LOG),recovered=await post(failing,failKey);
  check(recovered.status===200&&recovered.body.replayed===true&&recovered.body.capture.response_state==='not_established'&&recovered.body.first_response_sent===null,'captured incomplete response returns unknown rather than falsely sent or undelivered');
  assert.deepEqual(await counts(recovered.body.lead_id),{touches:1,received:1,prepared:0});check(true,'post-capture retry preserves one capture without a second draft');
  check((await one('select count(*)::int n from comm_events where conversation_id=$1',[recovered.body.conversation_id])).n===0&&log(process.env.E2E_ANTHROPIC_LOG)===modelBeforeRetry,'post-capture retry makes no model or message attempt');
  const crashBody=bodyFor(),crashKey=randomUUID(),modelBeforeCrash=log(process.env.E2E_ANTHROPIC_LOG);
  const childEnv=boundary.serverEnvironment({LEASING_INTAKE_SECRET:'e2e-intake',LEASING_INTAKE_PROPERTY_IDS:property.id,
    PROSPECT_ACTIVATION_PROPERTY_IDS:property.id,E2E_INTAKE_CRASH_INPUT:JSON.stringify({body:crashBody,key:crashKey})});
  const crashed=await new Promise((resolve,reject)=>{
    const child=require('node:child_process').spawn(process.execPath,[require('node:path').join(__dirname,'intake_delivery_crash_child.js')],{env:childEnv,stdio:'pipe',windowsHide:true});
    let errors='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},15000);
    child.stdout.resume();child.stderr.on('data',d=>{errors+=d});
    child.on('error',error=>{clearTimeout(timer);reject(error)});
    child.on('exit',code=>{clearTimeout(timer);resolve({code:timedOut?'timed_out':code,errors})});
  });
  check(crashed.code===86,'worker process died immediately after real canonical COMMIT: '+crashed.errors);
  const afterCrash=await post(crashBody,crashKey);
  check(afterCrash.status===200&&afterCrash.body.replayed&&afterCrash.body.capture.response_state==='not_established'&&afterCrash.body.first_response_sent===null,'HTTP retry after process death returns captured unknown response');
  assert.deepEqual(await counts(afterCrash.body.lead_id),{touches:1,received:1,prepared:0});check(true,'process death and retry leave one capture, no prepared response');
  check(log(process.env.E2E_ANTHROPIC_LOG)===modelBeforeCrash&&(await one('select count(*)::int n from comm_events where conversation_id=$1',[afterCrash.body.conversation_id])).n===0,'process-death retry makes no model or message attempt');
  check(log(process.env.E2E_SMS_LOG)===smsBefore,'all capture-only and conflicting retries make no SMS transport calls');
  console.log('RESULT '+checks+'/'+checks+' intake delivery checks');
 }finally{await pool.end()}
})().catch(e=>{console.error(e);process.exitCode=1});
