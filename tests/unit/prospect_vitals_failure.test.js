"use strict";
const fs=require('fs'),assert=require('node:assert/strict');
const src=fs.readFileSync(require('path').join(__dirname,'../../src/identity/operator.js'),'utf8');
const start=src.indexOf('async function prospectVitals('),end=src.indexOf('// ── SOURCE CONVERSION',start);
const read=new Function(src.slice(start,end)+';return prospectVitals;')();
(async()=>{
 const scope={personId:'p',propertyId:'property'};
 const failed={query:async sql=>{if(sql.includes('person_attributes'))throw Object.assign(Error('private database failure'),{code:'42P01'});return{rows:[{raw_payload:{desired_move_month:'2026-10'}}]};}};
 await assert.rejects(()=>read(failed,scope),e=>e.httpStatus===503 && e.message==='Prospect preferences could not be read. Retry before relying on them.','attribute failure must not masquerade as healthy legacy fallback');
 const empty=await read({query:async()=>({rows:[]})},scope);assert.deepEqual(empty,{move_month:null,budget:null,unit_type:null,occupants:null,pets:null,reason:null});
 const calls=[];const populated=await read({query:async(sql,params)=>{calls.push(params);return{rows:sql.includes('person_attributes')?[{attr_key:'move_month',attr_value:'2026-11'},{attr_key:'budget',attr_value:'0'},{attr_key:'unit_type',attr_value:'high-floor studio'}]:[{raw_payload:{desired_move_month:'2026-10'}}]};}},scope);
 assert.equal(populated.move_month,'2026-11');assert.equal(populated.budget,'0');assert.equal(populated.unit_type,'high-floor studio');assert(calls.every(p=>p[0]==='p'&&p[1]==='property'));
 console.log('PASS prospect vitals: failure distinct from empty; active correction over legacy; literal zero; scoped reads; text preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});
