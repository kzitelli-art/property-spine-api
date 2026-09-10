"use strict";
// Class 3. Real agent service and owned Postgres, scripted in-process model.
// Fixture patterns: prospect_inventory_dates, opening_claim_identity,
// availability_readiness_axis and space_economics. No provider or dispatch.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { Pool } = require("pg");
const { leaseableApplicationTargets } = require("../../src/applications/application_target_read");
const { resolveSpaceEconomics } = require("../../src/money/effective_pricing");

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  try {
    const tag = `prospect-matching-${randomUUID()}`;
    const today = (await one("select current_date::text as day")).day;
    const dates = await one("select (current_date+10)::text as start, (current_date+375)::text as finish, (current_date-30)::text as past");
    const term = { requested_start: dates.start, requested_end: dates.finish };
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const actor = await one(`insert into users(name,email,is_active,status,platform_role,organization_id)
      values($1,$2,true,'active','super_admin',$3) returning id`, [tag, `${tag}@example.invalid`, org.id]);
    const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`, [tag, org.id]);
    const property = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'bed') returning id`, [tag, org.id]);
    const pid = property.id;
    await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id,pid]);
    const type = await one("insert into property_unit_types(property_id,code,label) values($1,'2BR','Two bedrooms') returning id", [pid]);
    const homes = [];
    for (const [number, legacy, labels] of [["101",2400,["Room1","Room2"]],["102",700,["Room1"]],["103",700,["Room1"]]]) {
      const unit = await one(`insert into units(property_id,unit_number,bedrooms,bathrooms,market_rent,unit_type_id,occupancy_status)
        values($1,$2,2,1,$3,$4,'vacant') returning id`, [pid,number,legacy,type.id]);
      const auto = await one("select id from spaces where unit_id=$1", [unit.id]);
      for (let i=0;i<labels.length;i++) {
        const space = i===0
          ? await one("update spaces set space_label=$2,use_type='residential',position_kind='bed' where id=$1 returning id", [auto.id,labels[i]])
          : await one("insert into spaces(unit_id,space_label,use_type,position_kind) values($1,$2,'residential','bed') returning id", [unit.id,labels[i]]);
        homes.push({unit_id:unit.id,space_id:space.id,unit_number:number,space_label:labels[i]});
      }
      const walk = await one(`insert into unit_readiness_walks(property_id,unit_id,walked_by_user_id,outcome,
        work_complete_confirmed,cleaning_acceptable_confirmed,appliances_present_confirmed,appliance_function_confirmed,
        no_repair_blocker_confirmed,keys_accounted_confirmed,condition_acceptable_confirmed,no_unknowns_confirmed)
        values($1,$2,$3,'ready',true,true,true,true,true,true,true,true) returning id`, [pid,unit.id,actor.id]);
      await pool.query(`insert into unit_readiness_certifications(walk_id,property_id,unit_id,certified_by_user_id,walked_by_user_id,state)
        values($1,$2,$3,$4,$4,'ready')`, [walk.id,pid,unit.id,actor.id]);
    }
    const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger','synthetic-matching.csv',$2,'bed','confirmed','committed') returning id`, [pid,dates.past]);
    const activation = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
      values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id,pid,dates.past,batch.id,actor.id]);
    for (const [i,h] of homes.entries()) {
      const raw={section:"current",unit_number:h.unit_number,space_label:h.space_label,is_vacant:true};
      const ev=await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,$2,$3,'synthetic matching baseline',$4,$5) returning id`,[batch.id,i+1,JSON.stringify(raw),h.unit_id,h.space_id]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`,[activation.id,pid,`${h.unit_number}|${h.space_label}`,JSON.stringify(raw),ev.id,String(actor.id)]);
    }
    await pool.query(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
      positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
      values($1,$2,$3,$4,$5,4,0,4,$6,'platform_role:super_admin','established')`,[pid,deal.id,activation.id,batch.id,dates.past,actor.id]);
    // One sibling's current rights must not hide a distinct free bed.
    const occupied=homes[0], free=homes[1], expensive=homes[2], control=homes[3];
    await pool.query(`insert into leases(property_id,space_id,lease_status,start_date,end_date,rent)
      values($1,$2,'active',$3,$4,1000)`,[pid,occupied.space_id,today,dates.finish]);
    // Fixture-only publication, as in space_economics.db.js. This is NOT a
    // proof of the publication workflow: draft rows then frozen published rows.
    const version=await one(`insert into property_pricing_versions(property_id,status,effective_from,authority_basis)
      values($1,'draft',$2,'{"basis":"owned proof fixture"}'::jsonb) returning id`,[pid,today]);
    for (const [months,rent,space] of [[12,1000,null],[6,1300,null],[12,850,free.space_id],[12,950,expensive.space_id],[12,800,control.space_id]]) {
      await pool.query(`insert into pricing_terms(pricing_version_id,property_id,unit_type_id,unit_type,lease_term_months,base_rent,offer_state,override_scope,override_ref)
        values($1,$2,$3,'2BR',$4,$5,'offered',$6,$7)`,[version.id,pid,type.id,months,rent,space?'space':null,space]);
    }
    await pool.query("update property_pricing_versions set status='published',published_at=now() where id=$1",[version.id]);
    // Fixture validity is fatal, and is not counted as a product first red.
    const menu=await leaseableApplicationTargets(pool,{property_id:pid,...term});
    for (const h of [free,expensive,control]) assert(menu.eligible_targets.some(t=>t.space_id===h.space_id),`FIXTURE: ${h.unit_number}/${h.space_label} must be canonically eligible: ${JSON.stringify(menu.excluded_targets)}`);
    assert(!menu.eligible_targets.some(t=>t.space_id===occupied.space_id),"FIXTURE: occupied sibling must be excluded");
    for (const [h,rent] of [[free,850],[expensive,950],[control,800]]) {
      const price=await resolveSpaceEconomics(pool,{property_id:pid,space_id:h.space_id,lease_term_months:12});
      assert.equal(price.resolved,true,"FIXTURE: exact economics resolves");
      assert.equal(price.rent.new_lease_rent,rent);
      assert.equal(price.authority.basis,"space_override");
    }
    console.log("FIXTURE GREEN: free sibling and controls eligible; exact overrides 850/950/800; published terms 6 and 12");
    const person=await one("insert into persons(name) values($1) returning id",[`${tag} prospect`]);
    await pool.query("insert into leasing_leads(property_id,person_id) values($1,$2)",[pid,person.id]);
    let advertised=null,result=null;
    const input={...term,lease_term_months:12,bedrooms:2,max_rent:900};
    const model={messages:{create:async req=>{
      if(!req.tools)return {content:[{type:"text",text:"{}"}]};
      const last=req.messages.at(-1);
      const tool=Array.isArray(last.content)&&last.content.find(c=>c.type==="tool_result");
      if(tool){result=JSON.parse(tool.content);return {id:"owned-matching-reply",content:[{type:"text",text:"I will explain the recorded options."}]};}
      advertised=req.tools.find(t=>t.name==="find_available_units");
      return {id:"owned-matching-tool",content:[{type:"tool_use",id:"owned-matching",name:"find_available_units",input}]};
    }}};
    const agent=require("../../src/agent/agent")({pool,anthropic:model})._service;
    const response=await agent.processInbound({property_id:pid,person_id:person.id,
      body:`I want a 12-month pricing term, two bedrooms, at most $900 per month, from ${dates.start} to ${dates.finish}. Which homes fit?`});
    assert.equal(response.status,200,JSON.stringify(response));
    assert(result,"real agent must reach existing inventory tool");
    const failures=[];
    const check=(condition,label)=>{console.log(`${condition?'PASS':'FAIL'} ${label}`);if(!condition)failures.push(label);};
    const units=result.units||[];
    check(!!advertised?.input_schema?.properties?.lease_term_months,"tool advertises explicit pricing term (script supplies it even on the old contract)");
    check(units.some(u=>u.unit_number==="101" && u.rent===850),"free sibling survives legacy unit rent and occupied-sibling exclusion at its $850 published override");
    check(!units.some(u=>u.unit_number==="102"),"$950 published exact price fails $900 budget despite $700 legacy rent");
    check(units.some(u=>u.unit_number==="103" && u.rent===800 && u.lease_term_months===12),"positive control uses explicit 12-month term and $800 exact override");
    const durable=(await one("select offered_units_json from agent_runs where conversation_id=(select id from conversations where property_id=$1 and person_id=$2) order by created_at desc limit 1",[pid,person.id])).offered_units_json||[];
    check(durable.some(u=>u.space_id===free.space_id && u.rent===850),"durable offered evidence preserves the exact sibling identity and price");
    const exact=durable.find(u=>u.space_id===free.space_id);
    check(exact?.lease_term_months===12 && exact?.authority?.published_version_id===version.id
      && exact?.authority?.basis==='space_override' && !!exact?.authority?.pricing_term_id,
      "durable exact offer carries selected term and canonical pricing authority envelope");
    check(result.may_promise===false && durable.every(u=>u.selection_eligible===false),
      "matching-only successor remains informational until the exact-selection writer is corrected");
    const writes=await one(`select (select count(*) from application_invitations where property_id=$1)::int invitations,
      (select count(*) from lease_offers where property_id=$1)::int offers,
      (select count(*) from comm_events where property_id=$1 and direction='outbound')::int sent`,[pid]);
    assert.deepEqual(writes,{invitations:0,offers:0,sent:0});
    console.log(JSON.stringify({property_id:pid,term,result,failures}));
    assert.equal(failures.length,0,`MATCHING FIRST RED: ${failures.join('; ')}`);
  } finally { await pool.end(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
