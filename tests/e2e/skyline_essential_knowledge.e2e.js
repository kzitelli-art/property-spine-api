"use strict";
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {Pool}=require('pg'),boundary=require('./proof_boundary');
const sessions=require('../../src/identity/staff_session_service');
async function main(){
  await boundary.assertDatabase();const m=boundary.manifest(),base=`http://127.0.0.1:${m.port}`;
  await boundary.waitServer(base);
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

    const livePacket=require('../../docs/content/temple/leasing-content.json');
    const packet=structuredClone(livePacket);
    packet.properties.find(p=>p.property_name==='Skyline').canonical_property_id=props[0];
    const {stage}=require('../../tools/stage_leasing_content');
    let snapshot=(await api('GET','/operator/agent-facts')).data;
    const plan=stage(packet,'skyline_essentials',props[0],snapshot);
    assert.throws(()=>stage(livePacket,'skyline_essentials',props[0],snapshot),/canonical property/);
    assert.equal(plan.requests.length,2);
    assert.throws(()=>stage(packet,'skyline_essentials',props[1],snapshot),/Target must match/);
    const ids=[];
    for(const request of plan.requests){
      assert.equal(request.action,'create_requires_publication_review');
      assert.equal(request.provenance[0].confirmed_on,'2026-08-20');
      assert.equal(request.body.confirmed_at,undefined,'source date must not become publisher confirmation');
      const r=await api(request.method,request.path,request.body);
      assert.equal(r.status,200,JSON.stringify(r));
      assert.equal(r.data.fact.approved_by_user_id,user);
      assert.equal(r.data.fact.property_id,props[0]);ids.push(r.data.fact.id);
    }
    snapshot=(await api('GET','/operator/agent-facts')).data;
    const corrupt=structuredClone(snapshot);corrupt.facts[0].effective_until='not-a-date';
    assert.throws(()=>stage(packet,'skyline_essentials',props[0],corrupt),/Invalid effective_until/);
    assert.equal(snapshot.coverage.counts.current,2);assert.equal(snapshot.coverage.counts.missing,8);
    assert.ok(stage(packet,'skyline_essentials',props[0],snapshot).requests.every(r=>r.action==='skip_unchanged'));
    for(const request of plan.requests)assert.equal(snapshot.current.find(f=>f.fact_key===request.fact_key).rendered_text,request.body.rendered_text);
    for(const [message,match] of [['does Skyline have laundry?',/cardio room/],['what are the common questions?',/wardrobe/]]){
      const r=await api('POST','/operator/ask-spine/message',{message});
      assert.equal(r.data.outcome,'answered',JSON.stringify(r));assert.match(r.data.answer,match);assert.match(r.data.answer,/August 20, 2026/);
      assert.doesNotMatch(r.data.answer,/\$|850|750|775|ESA|vaccin/i);
    }
    const agent=require('../../src/agent/agent')({pool})._service;
    const context=await agent.resolveContext(pool,{property_id:props[0]});
    for(const request of plan.requests)assert.equal(context.facts.find(f=>f.fact_key===request.fact_key).rendered_text,request.body.rendered_text);
    let r=await api('POST','/operator/ask-spine/message',{message:'does Skyline have laundry?'},tokens[1]);assert.equal(r.data.outcome,'not_established');
    assert.equal((await api('GET','/operator/agent-facts',null,tokens[1])).data.facts.length,0);
    r=await api('POST','/operator/agent-facts/'+ids[0]+'/replace',plan.requests[0].body,tokens[1]);assert.equal(r.status,403);
    // Expiry does not silently republish. The offline plan requests an explicit
    // replacement through the existing stale-id writer, retaining its history.
    await q("update agent_facts set effective_until='2020-01-01' where id=$1",[ids[0]]);
    snapshot=(await api('GET','/operator/agent-facts')).data;
    const renewal=stage(packet,'skyline_essentials',props[0],snapshot).requests[0];
    assert.equal(renewal.action,'replace_requires_publication_review');assert.equal(renewal.previous_fact_id,ids[0]);
    r=await api('POST','/operator/ask-spine/message',{message:'does Skyline have laundry?'});assert.equal(r.data.outcome,'not_established');
    r=await api(renewal.method,renewal.path,renewal.body);assert.equal(r.status,200,JSON.stringify(r));
    assert.equal((await api(renewal.method,renewal.path,renewal.body)).status,409);
    assert.equal((await q('select status from agent_facts where id=$1',[ids[0]])).rows[0].status,'retired');
    console.log('PASS exact Skyline essentials: existing staff HTTP writer, approved actor, current workspace, Ask, prospect context, unchanged repeat, cross-property refusal, expiry and stale replacement history');
  }finally{await pool.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
