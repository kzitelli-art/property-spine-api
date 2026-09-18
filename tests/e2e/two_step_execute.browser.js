"use strict";
// Class 3. Two-step leasing · EXECUTE through the actual staff shell.
// Runs AFTER two_step_leasing.e2e.js on the same owned database. The default
// handoff is the Execute slice. TWO_STEP_BROWSER_FULL_JOURNEY=1 hands J4 over
// after the tour: all subsequent STAFF Author/prepare/issue/Execute actions
// use visible app controls; applicant submission and signatures use owned HTTP.
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
 const fullJourney=H.stage==='before_author';
 if(process.env.TWO_STEP_BROWSER_FULL_JOURNEY==='1')assert(fullJourney,'full staff journey requires a pre-Author handoff; an Execute-only handoff is not equivalent');
 const artifacts=path.resolve(process.env.E2E_ARTIFACT_DIR||path.join(out,'browser'));fs.mkdirSync(artifacts,{recursive:true});
 const pool=new Pool({connectionString:boundary.manifest().url,ssl:false}),one=async(q,a=[])=>(await pool.query(q,a)).rows[0];
 let server,browser,checks=0;const check=(v,label)=>{assert(v,label);checks++;console.log('PASS '+label);};
 const visible=async(page,selector)=>page.evaluate(sel=>{const el=document.querySelector(sel);if(!el)return {found:false};const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {found:true,text:(el.innerText||'').trim(),covered:!(hit===el||el.contains(hit)),rect:{w:r.width,h:r.height}};},selector);
 try{
  const kzTok=(await sessions.issueStaffSession(pool,{userId:H.kz_user_id,propertyId:H.property_id,purpose:'bootstrap_invite'})).session_token;
  const mikeTok=(await sessions.issueStaffSession(pool,{userId:H.mike_user_id,propertyId:H.property_id,purpose:'bootstrap_invite'})).session_token;
  await boundary.portFree(5174);
  server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(appRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(appRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5174,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{})});
  const writes=[];const errors=[];
  async function openWork(token,userId,actor){
   const page=await browser.newPage({viewport:{width:1440,height:1100}});
   page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR '+e.message);});
   page.on('dialog',async d=>{writes.push({actor,dialog:d.message(),at:Date.now()});await d.accept();});
   await page.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url());
    if(u.origin==='https://property-spine-api.onrender.com'){
     const response=await route.fetch({url:api+u.pathname+u.search,maxRedirects:0});
     if(request.method()!=='GET') writes.push({actor,path:u.pathname,method:request.method(),request:request.postDataJSON(),status:response.status(),body:await response.json(),at:Date.now()});
     return route.fulfill({response});
    }
    if(u.origin==='http://localhost:5174')return route.continue();
    return route.abort();
   });
   await page.addInitScript(s=>sessionStorage.setItem('__ps_staff_session__',JSON.stringify({t:s.token,m:{user_id:s.user,property_id:s.property}})),{token,user:userId,property:H.property_id});
   await page.goto('http://localhost:5174/');await page.waitForLoadState('networkidle');
   //  The combined app (a4a32a4 onward) puts "Choose a property" above the
   //  shell after entry, at z-index 3900. A signed-in person chooses the
   //  property the server marked as this session's before any desk is
   //  reachable; the proof does the same visible step, once, and only when
   //  the layer is shown. Nothing in the app is patched.
   const picker=page.locator('#livePropertyLayer.show');
   if(await picker.isVisible()){
    const choice=picker.locator('.live-property-choice:has(.live-property-current)');
    await choice.first().waitFor({state:'visible'});
    await page.screenshot({path:path.join(artifacts,'choose_property_'+actor+'.png'),fullPage:true}).catch(()=>{});
    await choice.first().click();
    await page.waitForFunction(()=>{const l=document.getElementById('livePropertyLayer');return !l||!l.classList.contains('show');});
    await page.waitForLoadState('networkidle');
   }
   const home=page.locator('.psx-work');
   if(!(await home.isVisible())){const desk=page.locator('.desk-card').filter({hasText:'LEASING'});if(await desk.isVisible())await desk.click();else await page.locator('.crumb-back').click();await home.waitFor({state:'visible'});}
   //  Signed-in shell: Leasing Work card → Application Records tab → this
   //  applicant's record → Open. Every step is a visible control.
   await home.click();
   return page;
  }
  async function openReview(token,userId,actor){
   const page=await openWork(token,userId,actor);
   await page.locator('button.pslh-view[data-view="records"]').click();
   const row=page.locator('.pslh-row[data-record-id="'+H.application_id+'"]');
   await row.waitFor({state:'visible',timeout:30000});
   await row.locator('button[data-act="recopen"]').click();
   await page.locator('#psReviewDetail[data-ps-state="ready"], #psReviewDetail .ps-ar-detail').first().waitFor({state:'visible',timeout:30000});
   await page.waitForLoadState('networkidle');
   return page;
  }
  const call=async(method,route,body)=>{const r=await fetch(api+route,{method,headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});return{status:r.status,body:await r.json()};};
  async function sign(token,name,initials){
   const data=await call('GET',`/t/lease/${token}/data`);check(data.status===200,'resident signing HTTP read succeeds');
   for(const field of data.body.packet.fields.filter(f=>f.required)){
    const done=await call('POST',`/t/lease/${token}/fields/${field.id}/complete`,{value:field.field_type==='signature'?name:initials,consent:field.field_type==='signature',session_id:'browser-journey-'+H.person_id});
    check(done.status===200,'resident HTTP field is completed through its governed door');
   }
   const submitted=await call('POST',`/t/lease/${token}/submit`,{session_id:'browser-journey-'+H.person_id});check(submitted.status===200,'resident signing HTTP submission succeeds');
  }
  if(fullJourney){
   assert(process.env.E2E_SMS_LOG&&process.env.E2E_ANTHROPIC_LOG,'full journey requires both fake-provider logs to prove no transport/model work');
   assert(H.conversion_id&&H.person_id&&H.unit_id&&H.bed_id&&H.prospect&&H.guarantor&&H.lease_start_date&&H.lease_end_date,'full journey requires the explicit pre-Author fixture handoff');
   const log=p=>p&&fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
   const quiet={sms:log(process.env.E2E_SMS_LOG),model:log(process.env.E2E_ANTHROPIC_LOG)};
   const author=await openWork(kzTok,H.kz_user_id,'KZ');
   const row=author.locator('[data-desk-key]').filter({hasText:H.prospect.name});
   await row.getByRole('button',{name:/^(Send|Prepare email)$/}).click();
   await author.locator('#lqTargetStart').fill(H.lease_start_date);await author.locator('#lqTargetEnd').fill(H.lease_end_date);
   await author.locator('#lqFindHomes').click();await author.locator('.lqdt-unitbtn[data-space="'+H.bed_id+'"]').click();
   check((await author.locator('.lqdt-terms-note').filter({hasText:'Exact target:'}).innerText()).includes(H.unit_number),'KZ reviews the exact home through the shared native reviewer');
   await author.locator('#lqOfferRent').fill(String(H.rent));await author.locator('#lqOfferDep').fill(String(H.rent));
   await author.locator('#lqNoFees').check();await author.locator('#lqNoConcessions').check();
   check(await author.locator('input[value="sms"]').isDisabled(),'no-consent staff review does not enable SMS');
   await author.getByRole('button',{name:'Prepare application for email',exact:true}).click();await author.locator('#lqPreparedLink').waitFor();
   const authored=writes.filter(w=>w.actor==='KZ'&&w.path&&w.path.endsWith('/application-offer'));
   check(authored.length===1&&authored[0].status===200,'AUTHOR is one successful native KZ offer command');
   check(authored[0].request.space_id===H.bed_id&&Number(authored[0].request.rent)===Number(H.rent)&&authored[0].request.lease_start_date===H.lease_start_date&&authored[0].request.lease_end_date===H.lease_end_date,'native Author carries the reviewed exact bed, rent and date rights');
   H.application_offer_id=authored[0].body.application_offer_id;
   check(writes.some(w=>w.actor==='KZ'&&w.path&&w.path.endsWith('/send-application')&&w.status===200&&w.body.prepared===true&&w.body.sent===false),'native application preparation records no transport send');
   await author.screenshot({path:path.join(artifacts,'author_prepared.png'),fullPage:true});await author.close();
   const preparer=await openWork(mikeTok,H.mike_user_id,'Mike');
   await preparer.locator('[data-desk-key]').filter({hasText:H.prospect.name}).getByRole('button',{name:/^(Send|Prepare email)$/}).click();
   await preparer.getByRole('button',{name:'Replace lost link',exact:true}).click();await preparer.locator('#lqPreparedLink').waitFor();
   const appLink=await preparer.locator('#lqPreparedLink').inputValue();
   check(await preparer.locator('#lqRecordEmailSent').isDisabled(),'Mike must explicitly attest the synthetic external email; link preparation is not sending');
   await preparer.locator('#lqEmailSentCheck').check();await preparer.getByRole('button',{name:'Record email send',exact:true}).click();
   await preparer.waitForFunction(()=>/Email send recorded|Send attested/.test(document.body.innerText));
   check(writes.filter(w=>w.actor==='Mike'&&w.path&&/application-invitations\/[^/]+\/sent$/.test(w.path)&&w.status===200).length===1,'Mike records the exact invitation send through the native attestation control');
   check(!writes.some(w=>w.actor==='Mike'&&w.path&&w.path.endsWith('/application-offer')),'the preparer never reauthors KZ terms');
   await preparer.close();
   const token=appLink.split('/t/application/')[1],ctx=await call('GET',`/t/application/${token}/context`);
   check(ctx.status===200&&Number(ctx.body.application_terms.rent)===Number(H.rent),'applicant HTTP context reads the native-authored offer');
   const captured={application_form_version:'tenant_v3',date_of_birth:'1995-04-12',email:H.prospect.email,phone:H.prospect.phone,address:{line1:'100 Test Street',line2:'',city:'Philadelphia',state:'PA',postal_code:'19147'},current_since:'2024-01',housing_status:'rent',income_status:'employed',employer:'Test Employer',job_title:'Analyst',income_amount:72000,income_frequency:'annual',income_notes:'',desired_move_in:H.lease_start_date,move_flexibility:'plus_minus_7',occupants:1,household_names:'',has_pets:'no',pets:'None',guarantor_needed:'yes',guarantor_contact:H.guarantor,additional_notes:'',applicant_accuracy_certified:true,electronic_delivery_consent:true};
   const submitted=await call('POST','/applications/submit-public',{token,applicant_name:H.prospect.name,captured,application_terms_hash:ctx.body.application_terms.terms_hash,application_terms_acknowledged:true});
   check(submitted.status===200&&submitted.body.application&&submitted.body.application.id,'applicant submits the current acknowledged native offer over HTTP');H.application_id=submitted.body.application.id;H.prospect_name=H.prospect.name;
   const packetPage=await openReview(mikeTok,H.mike_user_id,'Mike');
   await packetPage.getByRole('button',{name:'Prepare signing package',exact:true}).click();
   await packetPage.getByRole('button',{name:/Issue.*link/i}).waitFor();
   const generated=writes.filter(w=>w.actor==='Mike'&&w.path&&/applications\/[^/]+\/lease-packet$/.test(w.path)&&w.method==='POST');
   check(generated.length===1&&generated[0].status===200,'Mike prepares the package through the actual Application Review control');
   await packetPage.getByRole('button',{name:/Issue.*link/i}).click();await packetPage.locator('#psArIssuedUrl0').waitFor();
   const issued=writes.filter(w=>w.actor==='Mike'&&w.path&&/lease-packets\/[^/]+\/send$/.test(w.path)&&w.status===200);
   check(issued.length===1,'Mike issues signing links through the native control');
   H.packet_id=issued[0].path.split('/lease-packets/')[1].split('/')[0];
   const rows=await pool.query('select status,approved_at,application_offer_id,space_id from lease_applications where id=$1',[H.application_id]);
   check(rows.rows[0].status==='submitted'&&!rows.rows[0].approved_at&&rows.rows[0].application_offer_id===H.application_offer_id&&rows.rows[0].space_id===H.bed_id,'native packet preparation/issue preserve an unapproved application on the acknowledged exact bed');
   const links=issued[0].body.signing_links;
   check(Array.isArray(links)&&links.some(x=>x.signer_role==='tenant')&&links.some(x=>x.signer_role==='guarantor'),'native issue returns distinct resident and guarantor links');
   await packetPage.screenshot({path:path.join(artifacts,'mike_packet_links.png'),fullPage:true});await packetPage.close();
   for(const link of links){await sign(link.url.split('/t/lease/')[1],link.signer_role==='guarantor'?H.guarantor.name:H.prospect.name,link.signer_role==='guarantor'?'GG':'PP');}
   check(log(process.env.E2E_SMS_LOG)===quiet.sms&&log(process.env.E2E_ANTHROPIC_LOG)===quiet.model,'native Author/preparation/issue and applicant HTTP steps call no provider/model transport');
  }
  const before=await one("select a.status, a.approved_at, pk.status as packet_status from lease_applications a join lease_packets pk on pk.id=$2 where a.id=$1",[H.application_id,H.packet_id]);
  check(before&&before.status==='submitted'&&!before.approved_at&&before.packet_status==='resident_executed','before Execute: application submitted (unapproved), packet resident_executed');
  // ── Mike-shaped: the control is server-authored for the application; the refusal is the server's ──
  const mikePage=await openReview(mikeTok,H.mike_user_id,'Mike');
  let v=await visible(mikePage,'#psArExecuteBtn');
  check(v.found&&!v.covered&&/approve the application and sign for the company/i.test(v.text),'Mike sees the server-authored Execute control, visible to the document, labelled as approve + sign');
  await mikePage.screenshot({path:path.join(artifacts,'execute_mike_before.png'),fullPage:true});
  await mikePage.locator('#psArExecuteBtn').click();
  await mikePage.waitForFunction(()=>/holds neither approval authority|not authorized|not permitted/i.test(document.body.innerText),null,{timeout:20000});
  const mikeWrite=writes.find(w=>w.actor==='Mike'&&w.path&&w.path.endsWith('/execute'));
  check(mikeWrite&&mikeWrite.status===403&&mikeWrite.body.error==='execute_not_authorized','Mike\'s click reached the real Execute door and was refused (403 execute_not_authorized)');
  check(mikeWrite.request.application_decision==='approve'&&!!mikeWrite.request.idempotency_key,'the browser sent the explicit decision and a retry key');
  const refusalShown=await mikePage.evaluate(()=>{const el=document.querySelector('.ps-ar-error, .ps-ar-detail [class*="error"]');if(!el)return null;const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,20));return {text:(el.innerText||'').trim(),covered:!(hit===el||el.contains(hit))};});
  check(refusalShown&&!refusalShown.covered&&/holds neither approval authority/i.test(refusalShown.text),'the server\'s own refusal is visible on the page as product copy');
  await mikePage.screenshot({path:path.join(artifacts,'execute_mike_refused.png'),fullPage:true});
  const afterMike=await one("select a.status, a.approved_at, pk.company_executed_at from lease_applications a join lease_packets pk on pk.id=$2 where a.id=$1",[H.application_id,H.packet_id]);
  check(afterMike.status==='submitted'&&!afterMike.approved_at&&!afterMike.company_executed_at,'nothing was approved or signed by the refused click');
  await mikePage.close();
  // ── KZ-shaped: one click, explicit confirmation, two consequences ──
  const kzPage=await openReview(kzTok,H.kz_user_id,'KZ');
  v=await visible(kzPage,'#psArExecuteBtn');
  check(v.found&&!v.covered,'KZ sees the same visible Execute control');
  const progressBefore=await kzPage.locator('.ps-ar-progress').innerText();
  check(/Authored offer acknowledged by the applicant/.test(progressBefore)&&!/Proposed terms confirmed/.test(progressBefore),'the progress ladder shows the authored offer as the terms record and no separate confirmation step');
  await kzPage.screenshot({path:path.join(artifacts,'execute_kz_before.png'),fullPage:true});
  await kzPage.locator('#psArExecuteBtn').click();
  await kzPage.waitForFunction(()=>/Lease term confirmed|Term Confirmed/i.test(document.body.innerText),null,{timeout:40000});
  await kzPage.waitForLoadState('networkidle');
  const dialog=writes.find(w=>w.actor==='KZ'&&w.dialog);
  check(dialog&&/approve this application and sign/i.test(dialog.dialog)&&/two consequences/i.test(dialog.dialog),'the confirmation dialog named both consequences before anything was sent');
  const kzWrites=writes.filter(w=>w.actor==='KZ'&&w.path&&w.path.endsWith('/execute'));
  const decided=kzWrites.filter(w=>w.status===201);
  check(decided.length===1&&kzWrites.length===1,'KZ sent exactly one Execute request and it decided');
  check(dialog.at<=decided[0].at,'KZ confirmation precedes KZ decision response');
  check(Array.isArray(decided[0].body.decisions)&&decided[0].body.decisions.map(d=>d.decision).join(',')==='application_approved,company_signed'&&decided[0].body.tenancy&&decided[0].body.tenancy.lease_id,'the server returned two decisions and the pending tenancy');
  check(!writes.some(w=>w.path&&(/\/approve$|\/proposed-terms$|\/company-sign$/.test(w.path))),'the browser sent no separate approve, confirm-terms or company-sign request');
  const progressAfter=await kzPage.locator('.ps-ar-progress').innerText();
  check(/Application approved and signed for the company \(Execute\)/.test(progressAfter),'the progress ladder names the executed decision');
  check(await kzPage.locator('.ps-ar-step.done').filter({hasText:'Application approved and signed for the company (Execute)'}).count()===1,'the current-packet canonical Execute receipt completes the progress row');
  const panel=await visible(kzPage,'.ps-mi:not(#moveInSection)');
  check(panel.found&&!panel.covered&&/Lease term confirmed/i.test(panel.text),'the execution panel rereads the confirmed tenancy, visible to the document');
  await kzPage.locator('#moveInSection h3').waitFor({state:'visible',timeout:20000});
  check(!/cannot be displayed|does not understand|could not be loaded|state unavailable/.test(await kzPage.locator('#moveInSection').innerText()),'the distinct move-in panel understands the actual canonical response');
  check(/possession pending/i.test(await kzPage.locator('#moveInSection').innerText()),'executed lease display does not claim possession');
  check(!/lease active/i.test(await kzPage.locator('#psReviewDetail').innerText()),'the pending tenancy is not described as an active lease');
  await kzPage.screenshot({path:path.join(artifacts,'execute_kz_after.png'),fullPage:true});
  const lease=await one("select l.id, l.lease_status, l.space_id, l.rent from leases l where l.application_id=$1",[H.application_id]);
  check(lease&&lease.lease_status==='pending'&&lease.space_id===H.bed_id&&Number(lease.rent)===Number(H.rent),'the database holds one pending lease on the exact bed at the authored rent');
  check((await one("select count(*)::int n from leases where application_id=$1",[H.application_id])).n===1,'exactly one lease');
  check(errors.length===0,'no page errors');
  await kzPage.close();
  if(fullJourney)check(writes.filter(w=>w.actor==='KZ'&&w.path&&w.path.endsWith('/application-offer')&&w.status===200).length===1&&decided.length===1,'staff browser records exactly two commercial acts: one Author and one Execute');
  const receipt={proof_kind:'actual staff shell, owned HTTP/database',scope:fullJourney?'native staff Author, application preparation/attestation, packet preparation/issue, Execute; applicant submission/signatures via HTTP':'Execute slice only; earlier steps via HTTP',complete:true,checks,external_email_sent:false,writes:writes.map(w=>w.dialog?{actor:w.actor,dialog:w.dialog}:{actor:w.actor,path:w.path,status:w.status,error:w.body&&w.body.error,decisions:w.body&&w.body.decisions&&w.body.decisions.map(d=>d.decision)}),screenshots:['execute_mike_before.png','execute_mike_refused.png','execute_kz_before.png','execute_kz_after.png']};
  fs.writeFileSync(path.join(artifacts,'two_step_execute.receipt.json'),JSON.stringify(receipt,null,2));
  console.log(`\ntwo-step execute (browser): ${checks} checks passed · ${artifacts}`);
 }catch(error){
  if(browser){
   const pages=browser.contexts().flatMap(c=>c.pages());
   for(let i=0;i<pages.length;i++){
    fs.writeFileSync(path.join(artifacts,'failure-'+i+'.txt'),await pages[i].locator('body').innerText().catch(()=>''));
    await pages[i].screenshot({path:path.join(artifacts,'failure-'+i+'.png'),fullPage:true}).catch(()=>{});
   }
  }
  throw error;
 }finally{ if(browser)await browser.close(); if(server)await new Promise(resolve=>server.close(resolve)); await pool.end(); }
})().catch(e=>{console.error(e);process.exit(1);});
