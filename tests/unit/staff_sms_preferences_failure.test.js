"use strict";
const assert=require('node:assert/strict');const {makeStaffLeasingAction}=require('../../src/leasing/staff_sms_action');
let rolledBack=false, replied=false;const db={release(){},async query(sql,p=[]){
if(sql==='rollback'){rolledBack=true;return {rows:[]};}
if(sql==='begin'||sql==='commit')return {rows:[]};
if(/insert into staff_threads/.test(sql))return {rows:[{id:'thread'}]};
if(/from leasing_tours t/.test(sql))return {rows:[{tour_id:'tour',person_id:'person',prospect_name:'Jane',unit_id:'unit'}]};
if(/select occurred_at/.test(sql))return {rows:[{occurred_at:'2026-09-09T02:00:00Z'}]};
if(/person_attributes/.test(sql))throw Error('private database diagnostic');
if(/insert into comm_events/.test(sql)){if(sql.includes('in_reply_to_comm_event_id')){replied=true;return {rows:[{id:'reply',body:p[0]}]};}return {rows:[{id:'source'}]};}
if(/update comm_events|update staff_threads/.test(sql))return {rows:[]};
throw Error('Unhandled SQL: '+sql);
}};const pool={query:db.query.bind(db),connect:async()=>db};
(async()=>{const out=await makeStaffLeasingAction().run(pool,{organizationId:'org',userId:'staff',lineId:'line',body:'Tour went great. They want a studio.',providerMessageId:'message',propertyContext:{outcome:'one',propertyId:'property',allowedModules:['leasing']}});assert(rolledBack);assert(replied);assert.match(out.outbound.body,/couldn't save.*preferences/i);assert(!out.outbound.body.includes('private database diagnostic'));console.log('PASS preference failure rolls back and sends an honest retry receipt');})().catch(e=>{console.error(e);process.exitCode=1});
