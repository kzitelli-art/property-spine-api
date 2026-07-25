#!/usr/bin/env node
const path = require('path');
'use strict';
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname,'..','src','applications','application_review.js'),'utf8');
let pass=0, fail=0;
function ok(name, cond){ if(cond){pass++; console.log('PASS '+name);} else {fail++; console.log('FAIL '+name);} }
function extractFunction(name){
  const re=new RegExp('function\\s+'+name+'\\s*\\('), m=re.exec(src);
  if(!m) throw new Error('missing '+name);
  const start=m.index, brace=src.indexOf('{',m.index+m[0].length); let d=0,mode='code',q='',i=brace;
  for(;i<src.length;i++){const c=src[i],n=src[i+1]||'';
    if(mode==='line'){if(c==='\n')mode='code';continue;}
    if(mode==='block'){if(c==='*'&&n==='/'){mode='code';i++;}continue;}
    if(mode==='str'){if(c==='\\'){i++;continue;}if(c===q)mode='code';continue;}
    if(mode==='tpl'){if(c==='\\'){i++;continue;}if(c==='`')mode='code';continue;}
    if(c==='/'&&n==='/'){mode='line';i++;continue;}
    if(c==='/'&&n==='*'){mode='block';i++;continue;}
    if(c==='"'||c==="'"){mode='str';q=c;continue;}
    if(c==='`'){mode='tpl';continue;}
    if(c==='{')d++; else if(c==='}'&&--d===0)return src.slice(start,i+1);
  }
  throw new Error('unterminated '+name);
}
let sandbox={};
try {
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('executionPrimaryAction'), sandbox);
} catch (err) {
  console.error('FAIL executionPrimaryAction extract/evaluate');
  console.error(err.message || err);
  process.exit(1);
}
const app={id:'app-1'};
let out=sandbox.executionPrimaryAction(app,{present:false}) || {};
ok('absent evidence authors verify POST',out.action==='verify_executed_lease'&&out.method==='POST');
ok('verify endpoint exact application',out.endpoint==='/operator/leasing/applications/app-1/executed-lease/verify');
out=sandbox.executionPrimaryAction(app,{present:true,activation_status:'blocked',blockers:[{code:'rent_mismatch'}]}) || {};
ok('blocked is navigation-only',out.action==='review_conflict'&&out.method===null&&out.endpoint===null);
ok('blocked surfaces blocker code',Array.isArray(out.blockers)&&out.blockers[0]==='rent_mismatch');
out=sandbox.executionPrimaryAction(app,{present:true,activation_status:'admitted',blockers:[]}) || {};
ok('admitted authors confirm POST',out.action==='confirm_term'&&out.method==='POST');
ok('confirm endpoint exact application',out.endpoint==='/operator/leasing/applications/app-1/confirm-term');
ok('legacy countersign copy removed',!src.includes('regenerate before countersign'));
ok('detail calls action composer with application and lease',/executionPrimaryAction\(app, executed_lease(, lease_id)?\)/.test(src));
// an existing lease is terminal: never re-author a confirm-term the server refuses
out=sandbox.executionPrimaryAction(app,{present:true,activation_status:'admitted',blockers:[]},'lease-1') || {};
ok('existing lease yields terminal state',out.action==='term_confirmed');
ok('terminal state authors no write',out.method===null&&out.endpoint===null);
console.log(`${pass}/${pass+fail}`);
process.exit(fail?1:0);
