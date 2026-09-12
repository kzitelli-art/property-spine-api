"use strict";
// Class 3: owned HTTP witness on live source b4a494c; no product repair here.
// Two desired behavior assertions are expected to fail on that baseline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const boundary = require('../e2e/proof_boundary');
require('../e2e/proof_fence_preload');
const {Pool} = require('pg');
const sessions = require('../../src/identity/staff_session_service');

(async()=>{
  await boundary.assertDatabase();
  const pool=new Pool({connectionString:boundary.manifest().url,ssl:false});
  const one=async(sql,args=[])=>(await pool.query(sql,args)).rows[0];
  let passed=0;
  const failures=[];
  const check=(value,label)=>{console.log(`${value?'PASS':'FIRST RED'} ${label}`);if(value)passed++;else failures.push(label);};
  const log=path=>path&&fs.existsSync(path)?fs.readFileSync(path,'utf8'):'';
  try {
    const property=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1");
    assert(property,'owned property fixture required');
    const tag=randomUUID();
    const staffPerson=await one('insert into persons(name) values($1) returning id',[`Owned reply staff ${tag}`]);
    const user=await one("insert into users(name,role,is_active,status,account_kind,person_id) values($1,'leasing_agent',true,'active','human_staff',$2) returning id",[`Owned reply staff ${tag}`,staffPerson.id]);
    await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active) values($1,$2,'Leasing Agent','{leasing}',true)",[user.id,property.id]);
    const issued=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:property.id,purpose:'bootstrap_invite'});
    const token=issued.session_token||issued.token;
    const source=`Owned website reply ${tag}`;
    await pool.query("insert into lead_sources(name,source_type) values($1,'website')",[source]);
    // Fixture setup ends here. Every prospect action is HTTP; later SQL is read-only.
    const request=async(method,path,body,intake=false)=>{
      const r=await fetch(process.env.E2E_API_BASE+path,{method,headers:{'content-type':'application/json',...(intake?{'x-intake-secret':'e2e-intake','idempotency-key':`${tag}-${body.email}`}:{'x-staff-session':token})},...(body?{body:JSON.stringify(body)}:{})});
      return {status:r.status,body:await r.json()};
    };
    const intake=async(kind)=>{
      const body={property_id:property.id,source,name:`Owned ${kind} inquiry`,email:`${tag}-${kind}@example.invalid`,source_lead_id:`${tag}-${kind}`,response_channel:'website',attempt_sms:false,message:`Owned ${kind} question: where can I find the floor plan?`,raw_payload:{form:'synthetic_property_form',sms_consent_field_present:false}};
      if(kind==='phone')body.phone='+1500555'+String(parseInt(tag.slice(0,4),16)%10000).padStart(4,'0');
      return request('POST','/leasing/intake',body,true);
    };
    const detail=cid=>request('GET',`/operator/leasing/conversations/${cid}`);
    const row=async(cid)=>{
      const r=await request('GET','/operator/leasing/conversation-queue');
      assert.equal(r.status,200,JSON.stringify(r.body));
      return (r.body.items||r.body.conversations||[]).find(x=>x.conversation_id===cid);
    };
    const smsBefore=log(process.env.E2E_SMS_LOG);
    const modelBefore=log(process.env.E2E_ANTHROPIC_LOG);

    const phone=await intake('phone');
    assert.equal(phone.status,200,JSON.stringify(phone));
    const phoneId=phone.body.conversation_id;
    const phoneDetail=await detail(phoneId);
    assert.equal(phoneDetail.status,200,JSON.stringify(phoneDetail));
    const outbound=phoneDetail.body.messages.filter(m=>m.direction==='outbound');
    check(phoneDetail.body.messages.some(m=>m.channel==='website'&&m.direction==='inbound'&&m.body.includes('Owned phone question')),'phone inquiry captures the original question in the staff thread');
    check(phone.body.first_response_sent===false&&log(process.env.E2E_SMS_LOG)===smsBefore,'capture-only inquiry does not send or claim a text');
    check(!(await one("select 1 from contact_preferences where person_id=$1 and channel='text' and consent_state='opted_in'",[phone.body.person_id])),'missing consent does not become texting permission');
    check(outbound.length===0,'capture-only website phone inquiry should not add an unsolicited outbound text to communication history');
    const phoneQueue=await row(phoneId);
    assert(phoneQueue,'phone inquiry must be in the canonical queue');
    check(phoneQueue.waiting_on==='manager'&&phoneQueue.last_delivered_outbound_at===null,'undelivered prepared text does not falsely answer the question');
    check(phoneDetail.body.draft===null,'initial opening text is distinct from an actionable agent draft');
    console.log('PHONE_OBSERVATION '+JSON.stringify({intake_response:phone.body.capture,thread_outbound:outbound.map(m=>({channel:m.channel,direction:m.direction,sender_role:m.sender_role,provider_status:m.provider_status})),queue:{waiting_on:phoneQueue.waiting_on,delivery_state:phoneQueue.delivery_state,bucket_reason_code:phoneQueue.bucket_reason_code},model_calls_added:log(process.env.E2E_ANTHROPIC_LOG).slice(modelBefore.length).trim().split('\n').filter(Boolean).length}));

    const email=await intake('email');
    assert.equal(email.status,200,JSON.stringify(email));
    const emailId=email.body.conversation_id;
    const before=await detail(emailId),beforeQueue=await row(emailId);
    check(before.status===200&&before.body.messages.length===1&&before.body.messages[0].channel==='website'&&beforeQueue.waiting_on==='manager','email-only inquiry is captured and honestly awaits staff');
    const take=await request('POST',`/operator/conversations/${emailId}/take-over`,{});
    check(take.status===200,'staff claims the existing conversation through the governed takeover action');
    const owned=await detail(emailId);
    const workId=owned.body.human_owner?.obligation_id;
    check(owned.body.human_owner?.user_id===user.id&&owned.body.waiting_on==='manager','takeover names accountable staff and does not mean answered');
    const externalBody='Owned mailbox reply: I sent the requested floor plan by email.';
    // A synthetic staff assertion of an already-sent external email. No mailbox
    // provider is used. The existing /reply door is the only staff reply action;
    // its current handler ignores channel/occurred_at/reference and requires phone.
    const recorded=await request('POST',`/operator/leasing/conversations/${emailId}/reply`,{body:externalBody,channel:'email',occurred_at:new Date().toISOString(),external_reference:`owned-mailbox-${tag}`});
    check(recorded.status===200,'staff should be able to record an actual external email reply without a phone or text send');
    const after=await detail(emailId),afterQueue=await row(emailId);
    const replyRows=await one('select count(*)::int n from comm_events where conversation_id=$1 and body=$2',[emailId,externalBody]);
    const work=await one('select status,assigned_user_id from obligations where id=$1',[workId]);
    check(recorded.status===409&&/no verified text number/.test(recorded.body.error)&&replyRows.n===0,'baseline refusal is phone-specific and records no fabricated reply');
    check(afterQueue.waiting_on==='manager'&&after.body.waiting_on==='manager'&&afterQueue.last_delivered_outbound_at===null,'after refused email capture the original question still reads unanswered');
    check(work.assigned_user_id===user.id&&work.status==='in_progress','refusal preserves the accountable open reply work');
    check(log(process.env.E2E_SMS_LOG)===smsBefore,'entire witness makes zero fake transport sends');
    console.log('EMAIL_OBSERVATION '+JSON.stringify({reply:recorded,thread_channels:after.body.messages.map(m=>m.channel),waiting_on:afterQueue.waiting_on,work_status:work.status}));
    console.log(`Website reply witness: ${passed} passed, ${failures.length} first reds`);
    assert.equal(failures.length,0,failures.join('; '));
  } finally {await pool.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
