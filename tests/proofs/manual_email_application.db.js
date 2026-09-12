"use strict";
// Class 3. Real owned HTTP/DB, synthetic session and observed fake carrier.
const fs=require('fs'),assert=require('node:assert/strict');
const {randomUUID}=require('crypto'),{Pool}=require('pg');
const boundary=require('../e2e/proof_boundary');
require('../e2e/proof_fence_preload');
const sessions=require('../../src/identity/staff_session_service');
(async()=>{
 await boundary.assertDatabase();
 const api=process.env.E2E_API_BASE;
 assert(api,'E2E_API_BASE is required');await boundary.waitServer(api);
 assert(process.env.E2E_SMS_LOG,'owned server E2E_SMS_LOG is required');
 const sms=()=>fs.existsSync(process.env.E2E_SMS_LOG)?fs.readFileSync(process.env.E2E_SMS_LOG,'utf8'):'';
 const pool=new Pool({connectionString:boundary.manifest().url,ssl:false}),one=async(q,a=[])=>(await pool.query(q,a)).rows[0];
 let checks=0;const check=(v,label)=>{assert(v,label);checks++;console.log('PASS '+label);};
 try{
  const p=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1"),tag=randomUUID();assert(p);
  await pool.query("update properties set operating_timezone='America/New_York' where id=$1",[p.id]);
  const phone='+1500'+String(parseInt(tag.slice(0,6),16)).padStart(7,'0').slice(-7);
  const person=await one("insert into persons(name,phone) values('Browser authorized manager',$1) returning id",[phone]);
  const user=await one("insert into users(name,phone,role,is_active,status,account_kind,person_id) values('Browser authorized manager',$1,'property_manager',true,'active','human_staff',$2) returning id",[phone,person.id]);
  await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active,can_manage_roles) values($1,$2,'Property Admin','{leasing,management}',true,true)",[user.id,p.id]);
  await pool.query("insert into assignments(person_id,property_id,role,is_active,provenance) values($1,$2,'property_manager',true,'{\"source\":\"staff_shell_fixture\"}'::jsonb)",[person.id,p.id]);
  await pool.query("insert into communication_lines(e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) select $1,'property_facing',$2,'external','residents_and_prospects',true,true,'proactive','active' where not exists(select 1 from communication_lines where property_id=$2 and status='active' and outbound_enabled=true)",[phone,p.id]);
  const priorTransport=sms();
  const control=await fetch(api+'/auth/sms/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone_number:phone})});
  assert.equal(control.status,200,'owned returning-staff OTP control succeeds');
  await control.json();
  assert(sms().slice(priorTransport.length).split(/\r?\n/).filter(Boolean).some(line=>JSON.parse(line).to===phone),'real owned HTTP transport writes this exact fake log');
  const issued=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:p.id,purpose:'bootstrap_invite'}),token=issued.session_token||issued.token;
  const source='Browser owned '+tag,name='Browser Offer '+tag.slice(0,8);await pool.query("insert into lead_sources(name,source_type) values($1,'website')",[source]);
  const original='Please send me the studio floor plan.',followup='Also, which layout has a balcony?';
  const payload={property_id:p.id,name,phone:'+15005550'+String(parseInt(tag.slice(0,3),16)%1000).padStart(3,'0'),email:tag+'@example.invalid',source,attempt_sms:false,response_channel:'website',message:original};
  const intake=await fetch(api+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake','Idempotency-Key':tag},body:JSON.stringify(payload)});
  assert.equal(intake.status,200);const lead=await intake.json(),conv=await one('select id from conversations where person_id=$1 and property_id=$2',[lead.person_id,p.id]);
  const second=await fetch(api+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake','Idempotency-Key':tag+'-followup'},body:JSON.stringify({...payload,message:followup})});assert.equal(second.status,200);await second.json();
  const starts=new Date(Date.now()+30*3600000),ends=new Date(starts.getTime()+1800000);
  const slot=await one("insert into tour_availability(property_id,leasing_agent_id,starts_at,ends_at,status,capacity) values($1,$2,$3,$4,'open',1) returning *",[p.id,user.id,starts.toISOString(),ends.toISOString()]);

  const call=async(method,route,body)=>{const r=await fetch(api+route,{method,headers:{'content-type':'application/json','x-staff-session':token,'x-operator-key':'e2e-key'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
  const booked=await call('POST','/operator/leasing/conversations/'+conv.id+'/book-tour',{slot_id:slot.id,idempotency_key:tag+'-book'});assert.equal(booked.status,200,JSON.stringify(booked));
  const tourId=booked.body.tour_id;
  assert.equal((await call('POST','/leasing/tours/'+tourId+'/check-in',{actor_id:user.id})).status,200);
  const done=await call('POST','/operator/leasing/tours/'+tourId+'/complete',{actual_tour_host_user_id:user.id,feedback:{standing:'ready_to_apply',next_move:'send_application'},idempotency_key:tag+'-outcome'});assert.equal(done.status,200,JSON.stringify(done));
  const conversion=await one('select id from leasing_conversions where origin_tour_id=$1',[tourId]);
  const unit=await one("select id from units where property_id=$1 and unit_number='3B'",[p.id]);assert(unit);
  const bed=await one("select id from spaces where unit_id=$1 and space_label='Bed B'",[unit.id]);
  const start=new Date(Date.now()+30*86400000).toISOString().slice(0,10),end=new Date(Date.now()+394*86400000).toISOString().slice(0,10);
  const offer=await call('POST','/operator/leasing/conversions/'+conversion.id+'/application-offer',{space_id:bed.id,rent:1025,security_deposit:1025,lease_start_date:start,lease_end_date:end,fees:[],concessions:{status:'none'},idempotency_key:tag+'-offer'});assert.equal(offer.status,200,JSON.stringify(offer));
  const body={unit_id:unit.id,space_id:bed.id,intended_move_in:start,application_offer_id:offer.body.application_offer_id,idempotency_key:tag+'-manual',delivery_method:'manual_email'};
  const before=sms();
  const invalid=await call('POST','/operator/leasing/conversions/'+conversion.id+'/send-application',{...body,delivery_method:'email'});check(invalid.status===400&&invalid.body.error==='invalid_delivery_method','unsupported transport cannot silently fall through');
  // These are refusal-only fixture personas; no intent or invitation may be born.
  for(const [email,state,expected] of [[null,null,'person_email_missing'],['revoked@example.invalid','opted_out','person_email_opted_out']]){
   const deniedPerson=await one("insert into persons(name,email) values('Manual refusal fixture',$1) returning id",[email]);
   if(state) await pool.query("insert into contact_preferences(person_id,channel,consent_state) values($1,'email',$2)",[deniedPerson.id,state]);
   const deniedConversion=await one("insert into leasing_conversions(person_id,property_id,actual_tour_host_user_id,conversation_owner_user_id) values($1,$2,$3,$3) returning id",[deniedPerson.id,p.id,user.id]);
   const denied=await call('POST','/operator/leasing/conversions/'+deniedConversion.id+'/send-application',body);
   check(denied.status===403&&denied.body.error===expected,expected+' refuses before birth');
   check((await one('select count(*)::int n from application_invitations where conversion_id=$1',[deniedConversion.id])).n===0,expected+' leaves no invitation');
  }
  const smsDenied=await call('POST','/operator/leasing/conversions/'+conversion.id+'/send-application',{...body,delivery_method:'sms'});check(smsDenied.status===403&&smsDenied.body.error==='person_has_not_consented','default text still refuses absent consent');
  const detail=await call('GET','/operator/leasing/conversations/'+conv.id);check(detail.status===200&&detail.body.manual_email_preparation.allowed&&!detail.body.send_application_capability.allowed,'conversation reads independent manual and SMS verdicts');
  const parallel=await Promise.all([call('POST','/operator/leasing/conversions/'+conversion.id+'/send-application',body),call('POST','/operator/leasing/conversions/'+conversion.id+'/send-application',body)]);
  const result=parallel.find(r=>r.status===200)||parallel[0];
  check(parallel.filter(r=>r.status===200).length===1&&parallel.some(r=>r.status===409&&r.body.error==='APPLICATION_LINK_ALREADY_PREPARED'),'concurrent attempts prepare exactly once');
  console.log('MANUAL REQUEST '+JSON.stringify({...result,body:{...result.body,link:result.body.link?'[once-returned link]':null}}));
  assert.equal(result.status,200,'no-consent manual preparation reaches existing command');
  const out=result.body;check(out.prepared&&out.sent===false&&out.dispatched===false&&out.recipient_snapshot===payload.email&&out.space_id===bed.id&&!!out.link,'manual preparation is truthful and binds exact bed and recorded email');
  const inv=await one('select status,sent_at,channel,token_digest from application_invitations where id=$1',[out.invitation_id]);check(inv.status==='prepared'&&!inv.sent_at&&!inv.channel,'preparation records no send or channel attestation');
  const replay=await call('POST','/operator/leasing/conversions/'+conversion.id+'/send-application',body);check(replay.status===409&&replay.body.invitation_id===out.invitation_id&&replay.body.send_obligation_id===out.send_obligation_id&&!replay.body.link&&replay.body.recovery_action==='regenerate','lost response retry preserves invitation and exposes explicit token recovery');
  const wrong=await call('POST','/operator/leasing/conversions/'+conversion.id+'/send-application',{...body,space_id:randomUUID()});check(wrong.status===409&&wrong.body.error==='APPLICATION_PREPARATION_CONFLICT','changed target refuses without another invitation');
  check((await one('select count(*)::int n from application_invitations where conversion_id=$1',[conversion.id])).n===1,'retry and conflict preserve one invitation');
  check(sms()===before,'manual preparation and retries never use transport');
  const recoveryRead=await call('GET','/operator/leasing/conversations/'+conv.id);
  check(recoveryRead.body.manual_email_preparation.prepared_invitations.some(r=>r.conversion_id===conversion.id&&r.invitation_id===out.invitation_id&&r.send_obligation_id===out.send_obligation_id&&r.link===null),'reload reads exact-conversion recovery without exposing token');
  const regenerated=await call('POST','/operator/leasing/application-invitations/'+out.invitation_id+'/regenerate',{});check(regenerated.status===200&&!!regenerated.body.link,'explicit canonical regenerate remains reachable');
  const attested=await call('POST','/operator/leasing/application-invitations/'+regenerated.body.invitation_id+'/sent',{send_obligation_id:regenerated.body.send_obligation_id,channel:'email',recipient_snapshot:payload.email,note:'Synthetic proof attestation only'});check(attested.status===200,'explicit manual email attestation uses existing writer');
  check((await one('select status,channel from application_invitations where id=$1',[regenerated.body.invitation_id])).status==='manually_sent','only explicit attestation records manually sent');
  check(sms()===before,'regeneration and attestation do not dispatch transport');
  console.log('manual email application: '+checks+' checks passed');
 }finally{await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
