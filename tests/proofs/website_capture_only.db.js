"use strict";
// Class 3: authenticated capture-only inquiry, real owned HTTP/Postgres.
const assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
const boundary=require('../e2e/proof_boundary');require('../e2e/proof_fence_preload');
const {Pool}=require('pg'),sessions=require('../../src/identity/staff_session_service');
(async()=>{
  await boundary.assertDatabase();
  const pool=new Pool({connectionString:boundary.manifest().url,ssl:false});
  const one=async(sql,args=[])=>(await pool.query(sql,args)).rows[0];
  let passed=0;const failures=[];
  const check=(v,label)=>{console.log(`${v?'PASS':'FAIL'} ${label}`);if(v)passed++;else failures.push(label);};
  const log=p=>p&&fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
  try{
    const p=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1");assert(p);
    const tag=randomUUID(),source=`Owned capture only ${tag}`;
    const staffPerson=await one('insert into persons(name) values($1) returning id',[`Capture staff ${tag}`]);
    const user=await one("insert into users(name,role,is_active,status,account_kind,person_id) values($1,'leasing_agent',true,'active','human_staff',$2) returning id",[`Capture staff ${tag}`,staffPerson.id]);
    await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active) values($1,$2,'Leasing Agent','{leasing}',true)",[user.id,p.id]);
    await pool.query("insert into lead_sources(name,source_type) values($1,'website')",[source]);
    const issued=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:p.id,purpose:'bootstrap_invite'}),token=issued.session_token||issued.token;
    // End fixture writes. Inquiry, retry, ownership and follow-up use HTTP.
    const req=async(method,path,body,key,intake=false)=>{
      const r=await fetch(process.env.E2E_API_BASE+path,{method,headers:{'content-type':'application/json',...(intake?{'x-intake-secret':'e2e-intake'}:{'x-staff-session':token}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});
      return {status:r.status,body:await r.json()};
    };
    let number=0;
    const body=()=>({property_id:p.id,source,name:`Capture prospect ${++number}`,email:`${tag}-${number}@example.invalid`,phone:'+1504'+String(parseInt(tag.slice(0,5),16)*10+number).padStart(7,'0').slice(-7),source_lead_id:`${tag}-${number}`,response_channel:'website',attempt_sms:false,message:'Please send the floor plan for this property.'});
    const intake=(b,key)=>req('POST','/leasing/intake',b,key,true);
    const state=async(r)=>one(`select s.mode,s.thread_version,s.current_review_obligation_id,
      (select count(*)::int from lead_source_touches where lead_id=$2) touches,
      (select count(*)::int from lead_events where lead_id=$2 and event_type='lead_received') captures,
      (select count(*)::int from lead_events where lead_id=$2 and event_type in ('ai_response_prepared','ai_text_sent')) responses,
      (select count(*)::int from comm_events where conversation_id=$1 and channel='website' and direction='inbound') inbound,
      (select count(*)::int from comm_events where conversation_id=$1 and direction='outbound') outbound
      from agent_thread_state s where s.conversation_id=$1`,[r.body.conversation_id,r.body.lead_id]);
    const smsBefore=log(process.env.E2E_SMS_LOG),modelBefore=log(process.env.E2E_ANTHROPIC_LOG);
    let first,firstBody,firstKey;
    for(const consent of [undefined,false,true]){
      const b=body(),key=`capture-${tag}-${number}`;if(consent!==undefined)b.sms_consent=consent;
      const r=await intake(b,key);assert.equal(r.status,200,JSON.stringify(r));
      const s=await state(r);
      check(r.body.capture?.response_state==='not_required'&&r.body.first_response_sent===false,`consent=${consent}: capture-only receipt does not request a response`);
      check(s.inbound===1&&s.outbound===0&&s.touches===1&&s.captures===1&&s.responses===0,`consent=${consent}: capture retains one inquiry/source and creates no outbound or response event`);
      const pref=await one("select consent_state from contact_preferences where person_id=$1 and channel='text'",[r.body.person_id]);
      check(consent===true?pref?.consent_state==='opted_in':pref?.consent_state!=='opted_in',`consent=${consent}: capture preserves the actual consent signal independently`);
      const detail=await req('GET',`/operator/leasing/conversations/${r.body.conversation_id}`);
      check(detail.status===200&&detail.body.messages.length===1&&detail.body.messages[0].body===b.message&&detail.body.draft===null&&detail.body.waiting_on==='manager',`consent=${consent}: staff sees exact inquiry and next reply with no AI draft`);
      if(!first){first=r;firstBody=b;firstKey=key;}
    }
    check(log(process.env.E2E_ANTHROPIC_LOG)===modelBefore,'all explicit capture-only inquiries make zero model attempts');
    check(log(process.env.E2E_SMS_LOG)===smsBefore,'all explicit capture-only inquiries make zero transport sends');
    const replay=await intake(Object.fromEntries(Object.entries(firstBody).reverse()),firstKey);
    check(replay.status===200&&replay.body.replayed===true&&replay.body.capture.response_state==='not_required'&&replay.body.capture.lead_event_id===first.body.capture.lead_event_id,'exact reordered replay returns the retained capture-only receipt');
    check((await intake({...firstBody,message:'Changed request under old key'},firstKey)).status===409,'changed replay payload conflicts without replacing original inquiry');
    const afterReplay=await state(first);
    check(afterReplay.inbound===1&&afterReplay.outbound===0&&afterReplay.touches===1&&Number(afterReplay.thread_version)===1,'retry retains one source touch, inquiry and thread version');
    const raceBody=body(),race=await Promise.all(Array.from({length:5},()=>intake(raceBody,`race-${tag}`)));
    const raceState=await state(race[0]);
    check(race.every(r=>r.status===200)&&race.filter(r=>r.body.replayed===false).length===1,'five concurrent submissions capture exactly once');
    check(raceState.inbound===1&&raceState.outbound===0&&raceState.responses===0&&raceState.touches===1,'concurrent replay creates no model response residue');
    const taken=await req('POST',`/operator/conversations/${first.body.conversation_id}/take-over`,{});
    assert.equal(taken.status,200,JSON.stringify(taken));
    const claimed=await state(first);
    const followBody={...firstBody,message:'A new question about laundry.',attempt_sms:true};
    const follow=await intake(followBody,`follow-${tag}`);
    const followed=await state(first);
    check(follow.status===200&&follow.body.reused_opportunity===true&&follow.body.capture.response_state==='not_required','human-owned repeat inquiry retains existing opportunity without requesting AI response');
    check(followed.mode==='human_takeover'&&followed.current_review_obligation_id===claimed.current_review_obligation_id&&followed.inbound===2&&followed.outbound===0&&Number(followed.thread_version)===Number(claimed.thread_version)+1,'follow-up preserves human work/control and captures a new question once');
    const work=await one('select assigned_user_id,status from obligations where id=$1',[followed.current_review_obligation_id]);
    check(work.assigned_user_id===user.id&&work.status==='in_progress','repeat inquiry retains its actual accountable staff member');
    check(log(process.env.E2E_ANTHROPIC_LOG)===modelBefore&&log(process.env.E2E_SMS_LOG)===smsBefore,'capture/replay/concurrency/human-follow-up never enters model or transport');
    // Explicitly protect the older default response-requested contract. Consent
    // remains absent; the boundary may refuse dispatch but intake still drafts.
    const defaults=body();delete defaults.attempt_sms;
    const defaultResult=await intake(defaults,`default-${tag}`),defaultState=await state(defaultResult);
    check(defaultResult.status===200&&defaultResult.body.first_response_sent===false&&defaultResult.body.capture.response_state==='not_sent','omitted attempt flag retains default response-requested receipt and truthful refusal');
    check(defaultState.outbound===1&&log(process.env.E2E_ANTHROPIC_LOG).length>modelBefore.length,'default response-requested path still prepares its opening text');
    check(log(process.env.E2E_SMS_LOG)===smsBefore,'no-consent default control does not bypass the communications boundary');
    console.log(`Website capture-only: ${passed} passed, ${failures.length} failed`);
    assert.equal(failures.length,0,failures.join('; '));
  }finally{await pool.end();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
