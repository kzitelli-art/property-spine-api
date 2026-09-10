"use strict";
const assert=require('node:assert/strict');const {makeStaffLeasingAction}=require('../../src/leasing/staff_sms_action');
let completed=false;const db={release(){},async query(sql,p=[]){
if(sql==='rollback'||sql==='begin'||sql==='commit')return {rows:[]};
if(/insert into staff_threads/.test(sql))return {rows:[{id:'thread'}]};
if(/from tour_outcome_prompts p/.test(sql))return {rows:[]};
if(/from leasing_tours t/.test(sql))return {rows:[{tour_id:'unrelated-tour',person_id:'person',prospect_name:'Jane',unit_id:'unit'}]};
if(/insert into comm_events/.test(sql)){if(sql.includes('in_reply_to_comm_event_id'))return {rows:[{id:'reply',body:p[0]}]};return {rows:[{id:'source'}]};}
if(/update comm_events|update staff_threads/.test(sql))return {rows:[]};
throw Error('Unhandled SQL: '+sql);
}};const pool={query:db.query.bind(db),connect:async()=>db};
(async()=>{const out=await makeStaffLeasingAction({getLeasingTourService:()=>({completeTour:async()=>{completed=true;return {tour_id:'unrelated-tour',conversion_id:'conversion'};}})}).run(pool,{organizationId:'org',userId:'staff',lineId:'line',body:'Ready to Apply',providerMessageId:'new-message',propertyContext:{outcome:'one',propertyId:'property',allowedModules:['leasing']}});assert(!completed,'An unbound bare reply must not complete a different sole open tour');assert(out.operating.isClarificationQuestion);console.log('PASS bare outcome without pending context requires a subject');})().catch(e=>{console.error(e);process.exitCode=1});
