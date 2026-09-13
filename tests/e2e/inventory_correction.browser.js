"use strict";
// Class 3. Governed inventory correction through the actual staff shell.
// Runs AFTER inventory_correction.e2e.js on the same owned database; that
// proof leaves one retired record (retired citing the bed-basis source, so
// its identity reads UNRESOLVED), one eligible record and one blocked
// record and hands their runtime identifiers over in
// PROOF_OUTPUT_DIR/inventory_correction_handoff.json. Here a Mike-shaped
// session reviews and is offered no decision; the admin session retires the
// eligible record (and the Rent Roll table, counts, list and history reread
// together), meets a network failure and retries the SAME command, reads
// the history with its explanation, pages the list, has a late review
// response dropped, and reinstates the retired record with an explicit
// identity correction — all through visible controls, with visibility
// asked of the DOCUMENT.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{Pool}=require('pg');
const boundary=require('./proof_boundary');
require('./proof_fence_preload');
const sessions=require('../../src/identity/staff_session_service');
(async()=>{
 await boundary.assertDatabase();
 const api=process.env.E2E_API_BASE,appRoot=path.resolve(process.env.E2E_APP_ROOT||'../property-spine-app');
 assert(api,'E2E_API_BASE is required');await boundary.waitServer(api);
 const out=process.env.PROOF_OUTPUT_DIR||path.join(require('os').tmpdir(),'inventory-correction');
 const handoffFile=path.join(out,'inventory_correction_handoff.json');
 assert(fs.existsSync(handoffFile),'inventory_correction.e2e.js must run first on this database and leave inventory_correction_handoff.json');
 const H=JSON.parse(fs.readFileSync(handoffFile,'utf8'));
 const artifacts=path.resolve(process.env.E2E_ARTIFACT_DIR||path.join(out,'browser'));fs.mkdirSync(artifacts,{recursive:true});
 const pool=new Pool({connectionString:boundary.manifest().url,ssl:false}),one=async(q,a=[])=>(await pool.query(q,a)).rows[0];
 let server,browser,checks=0;const check=(v,label)=>{assert(v,label);checks++;console.log('PASS '+label);};
 //  Visibility is asked of the DOCUMENT after scrolling the element into the
 //  viewport: a control below the fold is reachable, a covered one is not.
 const visible=async(page,selector)=>page.evaluate(sel=>{const el=document.querySelector(sel);if(!el)return {found:false};el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,18));return {found:true,text:(el.innerText||'').trim(),covered:!(hit===el||el.contains(hit)),rect:{w:r.width,h:r.height}};},selector);
 const rruCounts=async(page)=>page.evaluate(()=>{const el=document.querySelector('.rru-sub');const t=el?el.innerText:'';const m=/(\d+)\s+positions\s+·\s+(\d+)\s+units/.exec(t);return m?{positions:+m[1],units:+m[2],text:t}:{positions:null,units:null,text:t};});
 try{
  const adminTok=(await sessions.issueStaffSession(pool,{userId:H.admin_user_id,propertyId:H.property_id,purpose:'bootstrap_invite'})).session_token;
  const mikeTok=(await sessions.issueStaffSession(pool,{userId:H.mike_user_id,propertyId:H.property_id,purpose:'bootstrap_invite'})).session_token;
  await boundary.portFree(5174);
  server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(appRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(appRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5174,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{})});
  const writes=[];const errors=[];
  //  Network shaping, decided by the proof: a review response to delay, and
  //  one retire POST to drop on the floor (a lost request, not a refusal).
  const shape={delayReviewFor:null,delayMs:0,dropNextRetire:false,dropped:0};
  async function openRecords(token,userId){
   const page=await browser.newPage({viewport:{width:1440,height:1200}});
   page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR '+e.message);});
   page.on('dialog',async d=>{writes.push({dialog:d.message()});await d.accept();});
   await page.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url());
    if(u.origin==='https://property-spine-api.onrender.com'){
     if(request.method()==='POST'&&u.pathname.endsWith('/inventory/corrections/retire')&&shape.dropNextRetire){shape.dropNextRetire=false;shape.dropped++;writes.push({path:u.pathname,request:request.postDataJSON(),status:'dropped'});return route.abort('failed');}
     if(shape.delayReviewFor&&u.pathname.endsWith('/inventory/corrections/review')&&u.searchParams.get('unit_id')===shape.delayReviewFor){await new Promise(r=>setTimeout(r,shape.delayMs));}
     const response=await route.fetch({url:api+u.pathname+u.search,maxRedirects:0});
     if(request.method()==='POST'&&/\/inventory\/corrections\//.test(u.pathname)) writes.push({path:u.pathname,request:request.postDataJSON(),status:response.status(),body:await response.json()});
     return route.fulfill({response});
    }
    if(u.origin==='http://localhost:5174')return route.continue();
    return route.abort();
   });
   await page.addInitScript(s=>sessionStorage.setItem('__ps_staff_session__',JSON.stringify({t:s.token,m:{user_id:s.user,property_id:s.property}})),{token,user:userId,property:H.property_id});
   await page.goto('http://localhost:5174/');await page.waitForLoadState('networkidle');
   const desk=page.locator('.desk-card-management');
   if(await desk.isVisible())await desk.click(); else { await page.locator('.crumb-back').click(); await page.locator('.desk-card-management').click(); }
   await page.locator('.mg-door').first().waitFor({state:'visible',timeout:30000});
   await page.locator('.mg-door').first().click();
   await page.locator('#psInvToggle').waitFor({state:'visible',timeout:30000});
   await page.locator('#psInvToggle').click();
   await page.locator('.inv-t').waitFor({state:'visible',timeout:30000});
   return page;
  }
  const review=async(page,unitId)=>{ const b=page.locator('[data-inv-review="'+unitId+'"]'); if(await b.count()===0){ await page.locator('#psInvQ').fill(''); await page.waitForTimeout(400); } await b.scrollIntoViewIfNeeded(); await b.click(); await page.locator('.inv-review[data-inv-unit="'+unitId+'"]').waitFor({state:'visible',timeout:20000}); await page.waitForLoadState('networkidle'); };
  const findRow=async(page,unitId)=>{ if(await page.locator('[data-inv-review="'+unitId+'"]').count()) return; await page.locator('#psInvQ').fill(H.eligible_unit_number.slice(0,3)); await page.waitForTimeout(500); };
  // ── Mike-shaped: review is read-only, no decision is offered ──
  const mikePage=await openRecords(mikeTok,H.mike_user_id);
  let v=await visible(mikePage,'.inv-counts');
  check(v.found&&!v.covered&&/current inventory/.test(v.text)&&/retired/.test(v.text)&&/retained records/.test(v.text),'the panel labels current inventory, retired and retained records as three different counts');
  v=await visible(mikePage,'#psInvPaging');
  check(v.found&&!v.covered&&/Showing 1–100 of 171/.test(v.text),'the list is bounded (first 100 of 171) with the whole-property total visible');
  await mikePage.locator('#psInvPaging button',{hasText:'Next'}).click();
  await mikePage.waitForFunction(()=>/Showing 101–171 of 171/.test((document.querySelector('#psInvPaging')||{}).innerText||''),null,{timeout:15000});
  check(true,'the second page shows records 101–171');
  await mikePage.locator('#psInvPaging button',{hasText:'Previous'}).click();
  await mikePage.waitForFunction(()=>/Showing 1–100/.test((document.querySelector('#psInvPaging')||{}).innerText||''),null,{timeout:15000});
  await findRow(mikePage,H.eligible_unit_id);
  await review(mikePage,H.eligible_unit_id);
  v=await visible(mikePage,'.inv-verdict');
  check(v.found&&!v.covered&&/Eligible for retirement/.test(v.text),'Mike sees the eligibility verdict for the eligible record');
  check((await mikePage.locator('#psInvRetireBtn').count())===0&&/does not carry inventory-correction authority/.test(await mikePage.locator('.inv-review').innerText()),'Mike is offered no decision and is told why');
  await findRow(mikePage,H.blocked_unit_id);
  await review(mikePage,H.blocked_unit_id);
  v=await visible(mikePage,'.inv-verdict.blocked');
  check(v.found&&!v.covered&&/unit carries leases/.test(v.text),'the blocked record names its blocker visibly');
  await mikePage.screenshot({path:path.join(artifacts,'inventory_mike_review.png'),fullPage:true});
  await mikePage.locator('.inv-panel').screenshot({path:path.join(artifacts,'inventory_mike_panel.png')});
  await mikePage.close();
  // ── Admin: a late review response is dropped ──
  const page=await openRecords(adminTok,H.admin_user_id);
  await findRow(page,H.blocked_unit_id);
  shape.delayReviewFor=H.blocked_unit_id;shape.delayMs=2500;
  await page.locator('[data-inv-review="'+H.blocked_unit_id+'"]').click();
  await page.waitForTimeout(150);
  await findRow(page,H.eligible_unit_id);
  await page.locator('[data-inv-review="'+H.eligible_unit_id+'"]').click();
  await page.locator('.inv-review[data-inv-unit="'+H.eligible_unit_id+'"]').waitFor({state:'visible',timeout:20000});
  await page.waitForTimeout(3200);
  check((await page.locator('.inv-review').getAttribute('data-inv-unit'))===H.eligible_unit_id,'the review that arrived late (for the first click) did not overwrite the newer selection');
  shape.delayReviewFor=null;
  // ── Admin: retire the eligible record; a lost request is retried as the SAME command ──
  const before=await rruCounts(page);
  check(before.units!==null,'the Rent Roll header states positions and units before the decision');
  check((await page.locator('#psInvRetireBtn').count())===1,'the admin is offered the retirement decision');
  await page.locator('#psInvRetireBtn').click();
  await page.waitForFunction(()=>/Confirm the retirement explicitly/.test(document.body.innerText),null,{timeout:10000});
  check(writes.filter(w=>w.path).length===0,'an unconfirmed decision sends nothing');
  await page.locator('#psInvConfirm').check();
  await page.locator('#psInvRationale').fill('Browser rehearsal: this record modelled a bed as a unit under the pre-bed-basis source; the bed-basis source supersedes it.');
  await page.screenshot({path:path.join(artifacts,'inventory_admin_before_retire.png'),fullPage:true});
  await page.locator('.inv-review').screenshot({path:path.join(artifacts,'inventory_admin_review_panel.png')});
  shape.dropNextRetire=true;
  await page.locator('#psInvRetireBtn').click();
  await page.waitForFunction(()=>!!document.querySelector('#psInvError'),null,{timeout:15000});
  check(shape.dropped===1&&(await page.locator('#psInvRationale').inputValue()).length>20&&(await page.locator('#psInvConfirm').isChecked()),'a lost request shows an error and keeps what was typed and confirmed');
  await page.locator('#psInvRetireBtn').click();
  await page.waitForFunction(id=>{const el=document.querySelector('.inv-review[data-inv-unit="'+id+'"] .inv-verdict');return el&&/Retired record/.test(el.innerText);},H.eligible_unit_id,{timeout:30000});
  const retireWrites=writes.filter(w=>w.path&&w.path.endsWith('/retire'));
  check(retireWrites.length===2&&retireWrites[0].status==='dropped'&&retireWrites[1].status===201&&retireWrites[0].request.idempotency_key===retireWrites[1].request.idempotency_key&&retireWrites[0].request.rationale===retireWrites[1].request.rationale,'the retry carried the SAME idempotency key and payload as the lost request (one command, not two)');
  const retireWrite=retireWrites[1];
  check(retireWrite.request.confirmed===true&&retireWrite.request.unit_ids[0]===H.eligible_unit_id&&typeof retireWrite.request.review_tokens[H.eligible_unit_id]==='string'&&retireWrite.body.command_identity==='recorded','one confirmed retirement request carried the review token and got a durable command identity');
  check(writes.some(w=>w.dialog&&/Retire .* from current inventory/.test(w.dialog)),'the confirmation dialog named the record and the consequence');
  v=await visible(page,'.inv-counts');
  check(v.found&&/2 retired/.test(v.text),'the counts reread: two retired records now');
  const after=await rruCounts(page);
  check(after.units===before.units-1&&after.positions===before.positions-1,'the Rent Roll table header reread with the server: one unit and one position fewer');
  const row=await one("select retired_by_user_id, reversed_at from inventory_retirements where unit_id=$1 and reversed_at is null",[H.eligible_unit_id]);
  check(row&&row.retired_by_user_id===H.admin_user_id,'the owner\'s row names the admin');
  await page.screenshot({path:path.join(artifacts,'inventory_admin_after_retire.png'),fullPage:true});
  // ── Admin: blocked action offers no decision ──
  await findRow(page,H.blocked_unit_id);
  await review(page,H.blocked_unit_id);
  check((await page.locator('#psInvRetireBtn').count())===0&&/No decision is offered/.test(await page.locator('.inv-review').innerText()),'a blocked record offers the admin no decision either');
  // ── History, with the explanation the standing read also carries ──
  await page.locator('.inv-filters button',{hasText:'History'}).click();
  await page.locator('.inv-history').waitFor({state:'visible',timeout:20000});
  v=await visible(page,'.inv-history');
  check(v.found&&!v.covered&&/2 retired now/.test(v.text)&&/1 reversed/.test(v.text),'history shows two live retirements and one reversal, visible to the document');
  v=await visible(page,'#psInvExplain');
  check(v.found&&!v.covered&&/2 records excluded from current inventory/.test(v.text)&&/no operative work attached/.test(v.text)&&v.text.includes(H.retired_unit_number)&&v.text.includes(H.eligible_unit_number)&&/superseded by corrected inventory grain/.test(v.text),'the explanation names the excluded records, their reason and that no operative work is attached');
  // ── Admin: reinstate the record the HTTP proof retired — an identity decision ──
  await findRow(page,H.retired_unit_id);
  await review(page,H.retired_unit_id);
  check((await page.locator('#psInvReinstateBtn').count())===1&&/Retired record/.test(await page.locator('.inv-verdict').innerText()),'the retired record offers reinstatement');
  v=await visible(page,'#psInvIdentity');
  check(v.found&&!v.covered&&/Unsettled/.test(v.text)&&/does not name this record/.test(v.text),'the identity is shown as unsettled: the cited source does not name the record');
  await page.locator('#psInvConfirm').check();
  await page.locator('#psInvReason').fill('Browser rehearsal: designation withdrawn pending physical verification.');
  await page.locator('#psInvReinstateBtn').click();
  await page.waitForFunction(()=>/State explicitly that no current record covers this position/.test(document.body.innerText),null,{timeout:10000});
  check(writes.filter(w=>w.path&&w.path.endsWith('/reinstate')).length===0,'without the explicit identity correction nothing is sent');
  await page.locator('#psInvIdentityAck').check();
  await page.locator('#psInvIdentityReason').fill('Browser rehearsal: the bed-basis source established the first parent only; this legacy record was not in it.');
  await page.locator('.inv-review').screenshot({path:path.join(artifacts,'inventory_admin_identity_decision.png')});
  await page.locator('#psInvReinstateBtn').click();
  await page.waitForFunction(id=>{const el=document.querySelector('.inv-review[data-inv-unit="'+id+'"] .inv-verdict');return el&&/Eligible for retirement|Blocked/.test(el.innerText);},H.retired_unit_id,{timeout:30000});
  const reinstateWrite=writes.find(w=>w.path&&w.path.endsWith('/reinstate'));
  check(reinstateWrite&&reinstateWrite.status===201&&reinstateWrite.request.unit_id===H.retired_unit_id&&reinstateWrite.request.confirmed===true&&reinstateWrite.request.identity_decision==='position_not_covered_by_current_representation'&&typeof reinstateWrite.request.idempotency_key==='string','one confirmed reinstatement carried the review token, the explicit identity correction and a command key');
  const rev=await one("select reversed_by_user_id, reversal_reason from inventory_retirements where unit_id=$1 order by retired_at desc limit 1",[H.retired_unit_id]);
  check(rev&&rev.reversed_by_user_id===H.admin_user_id&&/physical verification/.test(rev.reversal_reason),'the reversal is recorded as history with who and why');
  v=await visible(page,'.inv-counts');
  check(v.found&&/1 retired/.test(v.text),'the counts reread: one retired record remains');
  const after2=await rruCounts(page);
  check(after2.units===before.units&&after2.positions===before.positions,'the Rent Roll header reread again: the reinstated unit and its position are back');
  v=await visible(page,'.inv-history');
  check(v.found&&/1 retired now/.test(v.text)&&/2 reversed/.test(v.text),'the history, still open, reread with the decision');
  await page.screenshot({path:path.join(artifacts,'inventory_admin_after_reinstate.png'),fullPage:true});
  await page.locator('.inv-panel').screenshot({path:path.join(artifacts,'inventory_admin_panel_after.png')});
  check(errors.length===0,'no page errors');
  await page.close();
  const receipt={proof_kind:'actual staff shell, owned HTTP/database',complete:true,checks,writes:writes.map(w=>w.dialog?{dialog:w.dialog}:{path:w.path,status:w.status,error:w.body&&w.body.error,idempotency_key_present:!!(w.request&&w.request.idempotency_key)}),screenshots:['inventory_mike_review.png','inventory_admin_before_retire.png','inventory_admin_after_retire.png','inventory_admin_identity_decision.png','inventory_admin_after_reinstate.png']};
  fs.writeFileSync(path.join(artifacts,'inventory_correction.receipt.json'),JSON.stringify(receipt,null,2));
  console.log(`\ninventory correction (browser): ${checks} checks passed · ${artifacts}`);
 }finally{ if(browser)await browser.close(); if(server)server.close(); await pool.end(); }
})().catch(e=>{console.error(e);process.exit(1);});
