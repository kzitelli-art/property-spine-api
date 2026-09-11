"use strict";
// Class 3: real HTTP, separately owned Postgres, canonical session issuer.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const boundary = require('../e2e/proof_boundary');
require('../e2e/proof_fence_preload');
const { Pool } = require('pg');
const sessions = require('../../src/identity/staff_session_service');

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({connectionString:boundary.manifest().url,ssl:false});
  const one = async (sql,args=[]) => (await pool.query(sql,args)).rows[0];
  let checks=0;
  const check=(value,label)=>{assert(value,label);checks++;console.log('PASS '+label);};
  try {
    const property=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1");
    assert(property);
    const tag=randomUUID();
    const staff=[];
    for (const name of ['Owner','Other']) {
      const person=await one('insert into persons(name) values($1) returning id',[name+' '+tag]);
      const user=await one("insert into users(name,role,is_active,status,account_kind,person_id) values($1,'leasing_agent',true,'active','human_staff',$2) returning id",[name+' '+tag,person.id]);
      await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active) values($1,$2,'Leasing Agent','{leasing}',true)",[user.id,property.id]);
      const issued=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:property.id,purpose:'bootstrap_invite'});
      staff.push({id:user.id,token:issued.session_token||issued.token});
    }
    const req=async(method,path,actor,body)=>{
      const response=await fetch(process.env.E2E_API_BASE+path,{method,headers:{'content-type':'application/json',...(actor?{'x-staff-session':actor.token}:{'x-intake-secret':'e2e-intake'})},...(body?{body:JSON.stringify(body)}:{})});
      return {status:response.status,body:await response.json()};
    };
    const source='Owned takeover '+tag;
    await pool.query("insert into lead_sources(name,source_type) values($1,'website')",[source]);
    const create=async(consent=false)=>{
      const r=await req('POST','/leasing/intake',null,{property_id:property.id,source,name:'Owned inquiry',email:randomUUID()+'@example.invalid',phone:'+1202555'+String(1000+Math.floor(Math.random()*8999)),sms_consent:consent,attempt_sms:false,response_channel:'website'});
      assert.equal(r.status,200,JSON.stringify(r));
      return {...r.body,conversation_id:(await one('select id from conversations where person_id=$1 and property_id=$2',[r.body.person_id,property.id])).id};
    };
    const inquiry=await create(),cid=inquiry.conversation_id;
    await pool.query("insert into agent_thread_state(conversation_id,mode) values($1,'human_takeover') on conflict(conversation_id) do update set mode='human_takeover'",[cid]);
    const take=(actor)=>req('POST',`/operator/conversations/${cid}/take-over`,actor,{});
    check((await take(staff[0])).status===200,'first staff takes over authentic captured inquiry');
    const state=await one('select * from agent_thread_state where conversation_id=$1',[cid]);
    const work=await one('select * from obligations where id=$1',[state.current_review_obligation_id]);
    check(work?.assigned_user_id===staff[0].id&&work.module==='leasing'&&work.status==='in_progress','takeover persists one named leasing obligation');
    const queue=await req('GET','/operator/obligations',staff[0]);
    check(queue.status===200&&queue.body.items?.some(o=>o.id===work.id&&o.assigned_user_id===staff[0].id),'leasing-only staff sees named work through canonical scoped queue');
    const ownerAsk=await req('POST','/operator/ask-spine/ask',staff[0],{question:'What needs my attention?'});
    check(ownerAsk.status===200&&ownerAsk.body.references?.some(r=>r.open?.id===inquiry.person_id&&r.personal_basis==='assigned_to_you'),'Ask Spine routes the same next work to its actual owner');
    const otherAsk=await req('POST','/operator/ask-spine/ask',staff[1],{question:'What needs my attention?'});
    check(otherAsk.status===200&&!otherAsk.body.references?.some(r=>r.open?.id===inquiry.person_id),'Ask Spine does not present another staff member as owner');
    for(const actor of staff){
      const r=await req('GET',`/operator/leasing/conversations/${cid}`,actor);
      check(r.status===200&&r.body.human_owner?.user_id===staff[0].id&&r.body.human_owner?.obligation_id===work.id,'each scoped viewer reads same durable owner');
    }
    check((await take(staff[0])).status===200&&(await one('select current_review_obligation_id from agent_thread_state where conversation_id=$1',[cid])).current_review_obligation_id===work.id,'self repeat reuses accountable work');
    check((await take(staff[1])).status===409,'other staff cannot silently steal ownership');
    check((await req('POST',`/operator/conversations/${cid}/hand-back`,staff[1],{})).status===409,'other staff cannot complete owner work by handback');
    const reply=await req('POST',`/operator/leasing/conversations/${cid}/reply`,staff[0],{body:'Owned consent-free response proof'});
    check(reply.status===200&&reply.body.sent===false&&/not delivered/i.test(reply.body.receipt),'consent-free response records honestly without claiming delivery');
    const inbound=await fetch(process.env.E2E_API_BASE+'/agent/inbound',{method:'POST',headers:{'content-type':'application/json','x-operator-key':'e2e-key'},body:JSON.stringify({property_id:property.id,person_id:inquiry.person_id,body:'Owned follow-up question',sms_sid:'OWNED-'+tag})});
    check(inbound.status===200,'later inbound accepted on owned human thread');
    const after=await one('select s.mode,s.current_review_obligation_id,o.assigned_user_id from agent_thread_state s join obligations o on o.id=s.current_review_obligation_id where s.conversation_id=$1',[cid]);
    check(after.mode==='human_takeover'&&after.current_review_obligation_id===work.id&&after.assigned_user_id===staff[0].id,'later inbound retains owner and obligation without AI reentry');
    // A historical ready draft cannot be used as a side door to close somebody else's work.
    const inboundEvent=await one("select id from comm_events where conversation_id=$1 and direction='inbound' order by occurred_at desc limit 1",[cid]);
    const run=await one("insert into agent_runs(conversation_id,inbound_comm_event_id,input_thread_version,generation_no,generation_reason,prompt_revision,policy_revision,model,status) values($1,$2,1,99,'manager_regenerate','owned','owned','owned','ready') returning id",[cid,inboundEvent.id]);
    const draft=await one("insert into agent_drafts(agent_run_id,generated_body) values($1,'Owned historical draft') returning id",[run.id]);
    const refused=await req('POST',`/operator/agent-drafts/${draft.id}/send`,staff[1],{});
    check(refused.status===409&&/another staff member/.test(refused.body.error),'another staff cannot approve draft to resolve the owner work');
    check((await one('select status from agent_drafts where id=$1',[draft.id])).status==='ready','refused competing approval leaves the draft unchanged');
    check((await req('POST',`/operator/conversations/${cid}/hand-back`,staff[0],{})).status===200,'owner can explicitly hand back');
    check((await one('select status from obligations where id=$1',[work.id])).status==='complete','handback completes only linked work');
    const ended=await req('GET',`/operator/leasing/conversations/${cid}`,staff[1]);
    check(ended.body.mode==='ai_active'&&ended.body.human_owner===null,'handback projection clears current human ownership');
    const race=await create();
    const outcomes=await Promise.all(staff.map(actor=>req('POST',`/operator/conversations/${race.conversation_id}/take-over`,actor,{})));
    check(outcomes.map(r=>r.status).sort().join(',')==='200,409','concurrent self-claims elect one owner and refuse the other');
    const count=await one("select count(*)::int n from obligations where related_type='conversation' and related_id=$1",[race.conversation_id]);
    check(count.n===1,'concurrent takeover creates exactly one linked work item');
    const reviewed=await create();
    const review=await require('../../src/shared/obligation_engine').spawnObligationFromEvent(pool,{
      property_id:property.id,person_id:reviewed.person_id,module:'agent',type:'agent_review',
      label:'Owned escalated review',status:'escalated',assigned_role:'leasing_manager'
    });
    await pool.query("insert into agent_thread_state(conversation_id,mode,current_review_obligation_id) values($1,'awaiting_review',$2)",[reviewed.conversation_id,review.id]);
    check((await req('POST',`/operator/conversations/${reviewed.conversation_id}/take-over`,staff[0],{})).status===200,'takeover claims existing escalated review');
    const still=await one('select * from obligations where id=$1',[review.id]);
    check(still.status==='escalated'&&still.module==='leasing'&&still.assigned_user_id===staff[0].id&&still.label==='Owned escalated review'&&still.type==='agent_review','claim preserves escalation meaning and reuses canonical existing work');
    const escalated=await req('GET',`/operator/leasing/conversations/${reviewed.conversation_id}`,staff[1]);
    check(escalated.body.human_owner?.obligation_id===review.id&&escalated.body.human_owner?.label===review.label&&escalated.body.human_owner?.type===review.type,'escalated work remains visible with its actual next action');
    await require('../../src/shared/obligation_engine').completeObligation(pool,{obligation_id:review.id,completed_by:staff[0].id});
    check((await req('POST',`/operator/conversations/${reviewed.conversation_id}/take-over`,staff[1],{})).status===200,'completed historical owner does not block a new staff claim');
    const successor=await req('GET',`/operator/leasing/conversations/${reviewed.conversation_id}`,staff[0]);
    const history=await one('select status,assigned_user_id,label from obligations where id=$1',[review.id]);
    check(successor.body.human_owner?.obligation_id!==review.id&&successor.body.human_owner?.user_id===staff[1].id&&history.status==='complete'&&history.assigned_user_id===staff[0].id&&history.label===review.label,'new claim preserves completed prior owner history');
    const foreign=await one("insert into properties(name) values($1) returning id",['Owned foreign '+tag]);
    const outsider=await one("insert into persons(name) values('Owned foreign prospect') returning id");
    const foreignConv=await one('insert into conversations(property_id,person_id) values($1,$2) returning id',[foreign.id,outsider.id]);
    check((await req('POST',`/operator/conversations/${foreignConv.id}/take-over`,staff[0],{})).status===403,'staff cannot take over another property conversation');
    await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active) values($1,$2,'Leasing Agent','{leasing}',true)",[staff[0].id,foreign.id]);
    const foreignSession=await sessions.issueStaffSession(pool,{userId:staff[0].id,propertyId:foreign.id,purpose:'bootstrap_invite'});
    const foreignActor={id:staff[0].id,token:foreignSession.session_token||foreignSession.token};
    const lifecycle=[];
    for(const status of ['open','in_progress','blocked','escalated','complete','unknown_status']){
      lifecycle.push(await require('../../src/shared/obligation_engine').spawnObligationFromEvent(pool,{
        property_id:foreign.id,person_id:outsider.id,module:'leasing',type:'human_thread_reply',
        label:'Owned status '+status,status,assigned_user_id:staff[0].id
      }));
    }
    const attention=await req('GET','/operator/ask-spine/attention',foreignActor);
    check(attention.status===200&&attention.body.items.map(o=>o.status).sort().join(',')==='blocked,escalated,in_progress,open','Ask active lifecycle includes four existing unfinished states only');
    check(attention.body.items.every(o=>o.assigned_user_id===staff[0].id&&o.assigned_user_name==='Owner '+tag),'Ask carries canonical assigned actor and name without inference');
    const exactList=await req('GET','/operator/obligations?status=open',foreignActor);
    check(exactList.status===200&&exactList.body.items.length===1&&exactList.body.items[0].status==='open','explicit collection status filter stays exact');
    const crossAsk=await req('GET','/operator/ask-spine/attention?property_id='+foreign.id,staff[1]);
    check(crossAsk.status===403,'Ask refuses caller-selected foreign property');
    const badLink=await create();
    await pool.query("insert into agent_thread_state(conversation_id,mode,current_review_obligation_id) values($1,'human_takeover',$2)",[badLink.conversation_id,lifecycle[0].id]);
    const foreignWorkBefore=await one('select * from obligations where id=$1',[lifecycle[0].id]);
    check((await req('POST',`/operator/conversations/${badLink.conversation_id}/take-over`,staff[0],{})).status===409,'foreign linked obligation cannot be claimed through local conversation');
    check(JSON.stringify(await one('select * from obligations where id=$1',[lifecycle[0].id]))===JSON.stringify(foreignWorkBefore),'foreign linked obligation remains unchanged');
    const raceState=await one('select current_review_obligation_id from agent_thread_state where conversation_id=$1',[race.conversation_id]);
    await pool.query('update agent_thread_state set current_review_obligation_id=$2 where conversation_id=$1',[badLink.conversation_id,raceState.current_review_obligation_id]);
    const wrongPerson=await req('GET',`/operator/leasing/conversations/${badLink.conversation_id}`,staff[0]);
    check(wrongPerson.status===200&&wrongPerson.body.human_owner===null,'wrong-person linked work is not displayed as conversation ownership');
    check((await req('POST',`/operator/conversations/${badLink.conversation_id}/take-over`,staff[0],{})).status===409,'same-property wrong-person linked work is refused');
    const line=await one("select id from communication_lines where property_id=$1 and line_type='property_facing' and status='active'",[property.id]);
    if(!line) await pool.query("insert into communication_lines(e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) values('+12025550001','property_facing',$1,'external','residents_and_prospects',true,true,'proactive','active')",[property.id]);
    const consenting=await create(true);
    await req('POST',`/operator/conversations/${consenting.conversation_id}/take-over`,staff[0],{});
    const sent=await req('POST',`/operator/leasing/conversations/${consenting.conversation_id}/reply`,staff[0],{body:'Owned opted-in positive response'});
    check(sent.status===200&&sent.body.sent===true,'opted-in staff response reaches only fenced fake transport');
    console.log(`RESULT ${checks}/${checks}`);
  } finally {await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
