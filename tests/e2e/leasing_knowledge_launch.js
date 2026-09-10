"use strict";
// Class 3 Windows launcher: same full server and preloads as boot.sh.
const path=require('path'),cp=require('child_process'),fs=require('fs');
const boundary=require('./proof_boundary');
(async()=>{
  await boundary.assertDatabase(); const m=boundary.manifest();await boundary.portFree(m.port);
  const dir=path.dirname(process.env.E2E_PROOF_MANIFEST);
  const env=boundary.serverEnvironment({PORT:String(m.port),SMS_SEND_MODE:'customer_care',
    OPERATOR_APP_ORIGIN:'http://127.0.0.1:5179',APP_BASE_URL:`http://127.0.0.1:${m.port}`,
    E2E_SMS_LOG:path.join(dir,'knowledge-sms.log'),E2E_ANTHROPIC_LOG:path.join(dir,'knowledge-anthropic.log'),
    E2E_EGRESS_LOG:path.join(dir,'knowledge-egress.log'),E2E_SESSION_LOG:path.join(dir,'knowledge-sessions.log'),
    E2E_SERVER_ROOT:process.cwd(), E2E_SERVER_APPLICATION_NAME:'spine_proof_'+m.nonce});
  for(const k of ['E2E_SMS_LOG','E2E_ANTHROPIC_LOG','E2E_EGRESS_LOG','E2E_SESSION_LOG'])fs.writeFileSync(env[k],'');
  const child=cp.spawn(process.execPath,['--require','./tests/e2e/proof_fence_preload.js','--require','./tests/e2e/fake_sms_preload.js','--require','./tests/e2e/fake_anthropic_preload.js','server.js'],{env,stdio:'inherit',windowsHide:true});
  process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
  child.on('exit',code=>{process.exitCode=code||0;});
  await boundary.waitServer(`http://127.0.0.1:${m.port}`,()=>child.exitCode===null);
  console.log('Owned full server ready for leasing knowledge proof');
})().catch(e=>{console.error(e);process.exitCode=1;});
