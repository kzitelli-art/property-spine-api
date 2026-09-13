"use strict";
// Class 3. Two-step leasing · EXECUTE through the actual staff shell.
// Runs AFTER two_step_leasing.e2e.js on the same owned database: that proof
// leaves one application (J4) with every resident-side signature recorded and
// hands its runtime identifiers over in PROOF_OUTPUT_DIR/two_step_handoff.json.
// Here a Mike-shaped session sees the server-authored Execute control and is
// refused through the real path; the KZ-shaped session executes — one click,
// explicit confirmation naming both consequences — and the page rereads the
// tenancy. Visibility is asked of the DOCUMENT (elementFromPoint), not the
// element.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{Pool}=require('pg');
const boundary=require('./proof_boundary');
require('./proof_fence_preload');
const sessions=require('../../src/identity/staff_session_service');
(async()=>{
 await boundary.assertDatabase();
 const api=process.env.E2E_API_BASE,appRoot=path.resolve(process.env.E2E_APP_ROOT||'../property-spine-app');
 assert(api,'E2E_API_BASE is required');await boundary.waitServer(api);
 const out=process.env.PROOF_OUTPUT_DIR||path.join(require('os').tmpdir(),'two-step-leasing');
 const handoffFile=path.join(out,'two_step_handoff.json');
 assert(fs.existsSync(handoffFile),'two_step_leasing.e2e.js must run first on this database and leave two_step_handoff.json');
 const H=JSON.parse(fs.readFileSync(handoffFile,'utf8'));
 const artifacts=path.resolve(process.env.E2E_ARTIFACT_DIR||path.join(out,'browser'));fs.mkdirSync(artifacts,{recursive:true});
 const pool=new Pool({connectionString:boundary.manifest().url,ssl:false}),one=async(q,a=[])=>(await pool.query(q,a)).rows[0];
 let server,browser,checks=0;const check=(v,label)=>{assert(v,label);checks++;console.log('PASS '+label);};
 const visible=async(page,selector)=>page.evaluate(sel=>{const el=document.querySelector(sel);if(!el)return {found:false};const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {found:true,text:(el.innerText||'').trim(),covered:!(hit===el||el.contains(hit)),rect:{w:r.width,h:r.height}};},selector);
 try{
  const before=await one("select a.status, a.approved_at, pk.status as packet_status from lease_applications a join lease_packets pk on pk.id=$2 where a.id=$1",[H.application_id,H.packet_id]);
  check(before&&before.status==='submitted'&&!before.approved_at&&before.packet_status==='resident_executed','hand-off state: application submitted (unapproved), packet resident_executed');
  const kzTok=(await sessions.issueStaffSession(pool,{userId:H.kz_user_id,propertyId:H.property_id,purpose:'bootstrap_invite'})).session_token;
  const mikeTok=(await sessions.issueStaffSession(pool,{userId:H.mike_user_id,propertyId:H.property_id,purpose:'bootstrap_invite'})).session_token;
  await boundary.portFree(5174);
  server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(appRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(appRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5174,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{})});
  const writes=[];const errors=[];
  async function openReview(token,userId){
   const page=await browser.newPage({viewport:{width:1440,height:1100}});
   page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR '+e.message);});
   page.on('dialog',async d=>{writes.push({dialog:d.message()});await d.accept();});
   await page.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url());
    if(u.origin==='https://property-spine-api.onrender.com'){
     const response=await route.fetch({url:api+u.pathname+u.search,maxRedirects:0});
     if(request.method()==='POST'&&/\/execute$|\/company-sign$|\/approve$|\/proposed-terms$/.test(u.pathname)) writes.push({path:u.pathname,request:request.postDataJSON(),status:response.status(),body:await response.json()});
     return route.fulfill({response});
    }
    if(u.origin==='http://localhost:5174')return route.continue();
    return route.abort();
   });
   await page.addInitScript(s=>sessionStorage.setItem('__ps_staff_session__',JSON.stringify({t:s.token,m:{user_id:s.user,property_id:s.property}})),{token,user:userId,property:H.property_id});
   await page.goto('http://localhost:5174/');await page.waitForLoadState('networkidle');
   const home=page.locator('.psx-work');
   if(!(await home.isVisible())){const desk=page.locator('.desk-card').filter({hasText:'LEASING'});if(await desk.isVisible())await desk.click();else await page.locator('.crumb-back').click();await home.waitFor({state:'visible'});}
   //  Signed-in shell: Leasing Work card → Application Records tab → this
   //  applicant's record → Open. Every step is a visible control.
   await home.click();
   await page.locator('button.pslh-view[data-view="records"]').click();
   const row=page.locator('.pslh-row[data-record-id="'+H.application_id+'"]');
   await row.waitFor({state:'visible',timeout:30000});
   await row.locator('button[data-act="recopen"]').click();
   await page.locator('#psReviewDetail[data-ps-state="ready"], #psReviewDetail .ps-ar-detail').first().waitFor({state:'visible',timeout:30000});
   await page.waitForLoadState('networkidle');
   return page;
  }
  // ── Mike-shaped: the control is server-authored for the application; the refusal is the server's ──
  const mikePage=await openReview(mikeTok,H.mike_user_id);
  let v=await visible(mikePage,'#psArExecuteBtn');
  check(v.found&&!v.covered&&/approve the application and sign for the company/i.test(v.text),'Mike sees the server-authored Execute control, visible to the document, labelled as approve + sign');
  await mikePage.screenshot({path:path.join(artifacts,'execute_mike_before.png'),fullPage:true});
  await mikePage.locator('#psArExecuteBtn').click();
  await mikePage.waitForFunction(()=>/holds neither approval authority|not authorized|not permitted/i.test(document.body.innerText),null,{timeout:20000});
  const mikeWrite=writes.find(w=>w.path&&w.path.endsWith('/execute'));
  check(mikeWrite&&mikeWrite.status===403&&mikeWrite.body.error==='execute_not_authorized','Mike\'s click reached the real Execute door and was refused (403 execute_not_authorized)');
  check(mikeWrite.request.application_decision==='approve'&&!!mikeWrite.request.idempotency_key,'the browser sent the explicit decision and a retry key');
  const refusalShown=await mikePage.evaluate(()=>{const el=document.querySelector('.ps-ar-error, .ps-ar-detail [class*="error"]');if(!el)return null;const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,20));return {text:(el.innerText||'').trim(),covered:!(hit===el||el.contains(hit))};});
  check(refusalShown&&!refusalShown.covered&&/holds neither approval authority/i.test(refusalShown.text),'the server\'s own refusal is visible on the page as product copy');
  await mikePage.screenshot({path:path.join(artifacts,'execute_mike_refused.png'),fullPage:true});
  const afterMike=await one("select status, approved_at from lease_applications where id=$1",[H.application_id]);
  check(afterMike.status==='submitted'&&!afterMike.approved_at,'nothing was approved or signed by the refused click');
  await mikePage.close();
  // ── KZ-shaped: one click, explicit confirmation, two consequences ──
  const kzPage=await openReview(kzTok,H.kz_user_id);
  v=await visible(kzPage,'#psArExecuteBtn');
  check(v.found&&!v.covered,'KZ sees the same visible Execute control');
  const progressBefore=await kzPage.locator('.ps-ar-progress').innerText();
  check(/Authored offer acknowledged by the applicant/.test(progressBefore)&&!/Proposed terms confirmed/.test(progressBefore),'the progress ladder shows the authored offer as the terms record and no separate confirmation step');
  await kzPage.screenshot({path:path.join(artifacts,'execute_kz_before.png'),fullPage:true});
  await kzPage.locator('#psArExecuteBtn').click();
  await kzPage.waitForFunction(()=>/Lease term confirmed|Term Confirmed/i.test(document.body.innerText),null,{timeout:40000});
  await kzPage.waitForLoadState('networkidle');
  const dialog=writes.find(w=>w.dialog);
  check(dialog&&/approve this application and sign/i.test(dialog.dialog)&&/two consequences/i.test(dialog.dialog),'the confirmation dialog named both consequences before anything was sent');
  const kzWrites=writes.filter(w=>w.path&&w.path.endsWith('/execute'));
  const decided=kzWrites.filter(w=>w.status===201);
  check(decided.length===1&&kzWrites.filter(w=>w.status>=400).length===1,'exactly one Execute request decided (the earlier one is Mike\'s refusal)');
  check(Array.isArray(decided[0].body.decisions)&&decided[0].body.decisions.map(d=>d.decision).join(',')==='application_approved,company_signed'&&decided[0].body.tenancy&&decided[0].body.tenancy.lease_id,'the server returned two decisions and the pending tenancy');
  check(!writes.some(w=>w.path&&(/\/approve$|\/proposed-terms$|\/company-sign$/.test(w.path))),'the browser sent no separate approve, confirm-terms or company-sign request');
  const progressAfter=await kzPage.locator('.ps-ar-progress').innerText();
  check(/Application approved and signed for the company \(Execute\)/.test(progressAfter),'the progress ladder names the executed decision');
  const panel=await visible(kzPage,'.ps-mi');
  check(panel.found&&!panel.covered&&/Lease term confirmed/i.test(panel.text),'the execution panel rereads the confirmed tenancy, visible to the document');
  await kzPage.screenshot({path:path.join(artifacts,'execute_kz_after.png'),fullPage:true});
  const lease=await one("select l.id, l.lease_status, l.space_id, l.rent from leases l where l.application_id=$1",[H.application_id]);
  check(lease&&lease.lease_status==='pending'&&lease.space_id===H.bed_id&&Number(lease.rent)===Number(H.rent),'the database holds one pending lease on the exact bed at the authored rent');
  check((await one("select count(*)::int n from leases where application_id=$1",[H.application_id])).n===1,'exactly one lease');
  check(errors.length===0,'no page errors');
  await kzPage.close();
  const receipt={proof_kind:'actual staff shell, owned HTTP/database',complete:true,checks,writes:writes.map(w=>w.dialog?{dialog:w.dialog}:{path:w.path,status:w.status,error:w.body&&w.body.error,decisions:w.body&&w.body.decisions&&w.body.decisions.map(d=>d.decision)}),screenshots:['execute_mike_before.png','execute_mike_refused.png','execute_kz_before.png','execute_kz_after.png']};
  fs.writeFileSync(path.join(artifacts,'two_step_execute.receipt.json'),JSON.stringify(receipt,null,2));
  console.log(`\ntwo-step execute (browser): ${checks} checks passed · ${artifacts}`);
 }finally{ if(browser)await browser.close(); if(server)server.close(); await pool.end(); }
})().catch(e=>{console.error(e);process.exit(1);});
