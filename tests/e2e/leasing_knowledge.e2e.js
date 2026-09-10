"use strict";
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {Pool}=require('pg'),boundary=require('./proof_boundary');
const sessions=require('../../src/identity/staff_session_service');
async function main(){
  await boundary.assertDatabase();const m=boundary.manifest(),base=`http://127.0.0.1:${m.port}`;
  const pool=new Pool({connectionString:m.url,ssl:false});
  const q=(s,p)=>pool.query(s,p);const tag=Date.now().toString();
  try{
    const org=(await q("insert into organizations(name,slug) values($1,$2) returning id",['Knowledge proof '+tag,'knowledge-'+tag])).rows[0].id;
    const props=[];for(const name of ['Skyline','Greenery'])props.push((await q("insert into properties(name,organization_id) values($1,$2) returning id",[name,org])).rows[0].id);
    const phone='+1500'+tag.slice(-7),line='+1501'+tag.slice(-7);
    const user=(await q("insert into users(name,phone,role,status,account_kind) values($1,$2,'property_manager','active','human_staff') returning id",['Knowledge proof '+tag,phone])).rows[0].id;
    const tokens=[];
    for(const prop of props){await q("insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active) values($1,$2,'Property Manager',ARRAY['leasing','management'],true)",[prop,user]);const c=await pool.connect();try{await c.query('begin');tokens.push((await sessions.issueStaffSession(c,{userId:user,propertyId:prop,purpose:'bootstrap_invite'})).session_token);await c.query('commit');}finally{c.release();}}
    const api=async(method,url,body,token=tokens[0])=>{const r=await fetch(base+url,{method,headers:{'content-type':'application/json','x-staff-session':token},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
    const text='Representative 2BR / 1BA: https://my.matterport.com/show/?m=M7Lgne1gA72';
    let r=await api('POST','/operator/agent-facts',{fact_key:'virtual_tours',rendered_text:text,source_type:'verified_operator_confirmation'});assert.equal(r.status,200,JSON.stringify(r));const fact=r.data.fact.id;
    assert.equal(r.data.fact.approved_by_user_id,user);assert.equal(r.data.fact.property_id,props[0]);
    r=await api('GET','/operator/agent-facts');assert.equal(r.data.current.find(f=>f.id===fact).rendered_text,text);
    r=await api('POST','/operator/ask-spine/message',{message:'send me Skyline Matterport'});assert.equal(r.data.outcome,'answered',JSON.stringify(r));assert.match(r.data.answer,/M7Lgne1gA72/);
    r=await api('POST','/operator/ask-spine/message',{message:'send me Matterport'},tokens[1]);assert.equal(r.data.outcome,'not_established');assert.doesNotMatch(r.data.answer,/M7Lgne1gA72/);
    r=await api('POST',`/operator/agent-facts/${fact}/replace`,{fact_key:'virtual_tours',rendered_text:'Wrong property',source_type:'verified_operator_confirmation'},tokens[1]);assert.equal(r.status,403);
    const agent=require('../../src/agent/agent')({pool})._service;
    let context=await agent.resolveContext(pool,{property_id:props[0]});assert.equal(context.facts.find(f=>f.fact_key==='virtual_tours').rendered_text,text);
    r=await api('POST',`/operator/agent-facts/${fact}/replace`,{fact_key:'virtual_tours',rendered_text:'Updated representative tour: https://my.matterport.com/show/?m=3bM9GESQ7o2',source_type:'verified_operator_confirmation'});assert.equal(r.status,200);const replacement=r.data.new_fact.id;
    assert.equal((await q('select status from agent_facts where id=$1',[fact])).rows[0].status,'retired');
    r=await api('POST',`/operator/agent-facts/${fact}/replace`,{fact_key:'virtual_tours',rendered_text:'Stale browser',source_type:'verified_operator_confirmation'});assert.equal(r.status,409);
    await q("insert into communication_lines(e164,line_type,organization_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) values($1,'operations',$2,'operational','staff',true,true,'reply_only','active')",[line,org]);
    const sid='SM_KNOWLEDGE_'+tag;
    const sms=await fetch(base+'/communications/inbound-sms',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({MessageSid:sid,From:phone,To:line,Body:'send me Skyline Matterport'}).toString()});assert.equal(sms.status,200);
    let reply;for(let i=0;i<100;i++){reply=(await q('select o.body from comm_events i join comm_events o on o.in_reply_to_comm_event_id=i.id where i.sms_sid=$1',[sid])).rows[0];if(reply)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(reply,'staff webhook must record a reply');assert.match(reply.body,/3bM9GESQ7o2/);assert.doesNotMatch(reply.body,/M7Lgne1gA72/);
    r=await api('POST','/operator/agent-facts',{fact_key:'amenities',rendered_text:'Expired amenity',source_type:'verified_operator_confirmation',effective_until:'2020-01-01T00:00:00Z'});assert.equal(r.status,200);
    r=await api('POST','/operator/ask-spine/message',{message:'does Skyline have laundry?'});assert.equal(r.data.outcome,'not_established');
    await q("update property_team_assignments set allowed_modules=ARRAY['maintenance'] where user_id=$1 and property_id=$2",[user,props[1]]);
    r=await api('POST','/operator/ask-spine/message',{message:'show photos'},tokens[1]);assert.equal(r.data.outcome,'not_authorized');
    r=await api('GET','/operator/agent-facts',null,tokens[1]);assert.equal(r.status,403);
    r=await api('POST',`/operator/agent-facts/${replacement}/retire`,{});assert.equal(r.status,200);
    r=await api('POST','/operator/ask-spine/message',{message:'send me Matterport'});assert.equal(r.data.outcome,'not_established');
    // Local-only handoff to the browser proof. Never print bearer tokens.
    fs.writeFileSync(path.join(path.dirname(process.env.E2E_PROOF_MANIFEST),'knowledge-browser-session.json'),JSON.stringify({token:tokens[0],user_id:user,property_id:props[0],base}),{mode:0o600});
    console.log('PASS full server HTTP writer/read, prospect context, staff SMS webhook/reply, cross-property refusal, live entitlement, expiry, replacement and retirement');
  }finally{await pool.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
