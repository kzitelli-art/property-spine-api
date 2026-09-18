"use strict";
// Class 3: Windows launch adapter for the existing owned proof boundary and
// migration/precondition chain. No ambient database, provider or reset path.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const boundary=require('./proof_boundary');
async function main(){
  await boundary.assertDatabase();
  const m=boundary.manifest();
  const psql=process.env.E2E_PSQL;
  if(!psql)throw new Error('Explicit E2E_PSQL binary required');
  const run=(args)=>{const r=cp.spawnSync(psql,[m.url,'-X','-v','ON_ERROR_STOP=1',...args],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(r.stderr||r.stdout);return r.stdout;};
  run(['-q','-f','migrations/000_schema_migrations.sql']);
  for(const file of fs.readdirSync('migrations').filter(f=>/^\d{3}.*\.sql$/.test(f)&&!f.startsWith('000')).sort()){
    const version=file.slice(0,3);
    if(run(['-tAc',`select 1 from schema_migrations where version='${version}'`]).trim()==='1')continue;
    const pre=path.join('tests/e2e/preconditions',version+'.sql');if(fs.existsSync(pre))run(['-q','-f',pre]);
    try{run(['-q','-f',path.join('migrations',file)]);}
    catch(e){if(!/duplicate key value.*schema_migrations_pkey/.test(e.message))throw e;}
    run(['-q','-c',`insert into schema_migrations(version,name) values('${version}','${file}') on conflict do nothing`]);
  }
  console.log('Migration chain ceiling',run(['-tAc','select max(version::int) from schema_migrations']).trim());
}
main().catch(e=>{console.error(e);process.exitCode=1;});
