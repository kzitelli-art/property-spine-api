"use strict";
// Class 3. Actual static app, real owned HTTP/DB, synthetic session and carrier.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {randomUUID}=require('crypto'),{chromium}=require('playwright'),{Pool}=require('pg');
const boundary=require('./proof_boundary');
require('./proof_fence_preload');
const sessions=require('../../src/identity/staff_session_service');
(async()=>{
 await boundary.assertDatabase();
 const api=process.env.E2E_API_BASE,appRoot=path.resolve(process.env.E2E_APP_ROOT||'../app-fable-review-20260907');
 assert(api,'E2E_API_BASE is required');await boundary.waitServer(api);
 assert(process.env.E2E_SMS_LOG,'owned server E2E_SMS_LOG is required');
 const sms=()=>fs.existsSync(process.env.E2E_SMS_LOG)?fs.readFileSync(process.env.E2E_SMS_LOG,'utf8'):'';
 const artifacts=path.resolve(process.env.E2E_ARTIFACT_DIR||'../../tmp/staff-shell-browser');fs.mkdirSync(artifacts,{recursive:true});
 const pool=new Pool({connectionString:boundary.manifest().url,ssl:false}),one=async(q,a=[])=>(await pool.query(q,a)).rows[0];
 let server,browser,page,checks=0;const check=(v,label)=>{assert(v,label);checks++;console.log('PASS '+label);};
 try{
  const p=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1"),tag=randomUUID();assert(p);
  await pool.query("update properties set operating_timezone='America/New_York' where id=$1",[p.id]);
  const phone='+1500'+String(parseInt(tag.slice(0,6),16)).padStart(7,'0').slice(-7);
  const person=await one("insert into persons(name,phone) values('Browser Mike-shaped manager',$1) returning id",[phone]);
  const user=await one("insert into users(name,phone,role,is_active,status,account_kind,person_id) values('Browser Mike-shaped manager',$1,'property_manager',true,'active','human_staff',$2) returning id",[phone,person.id]);
  await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active,can_manage_roles) values($1,$2,'Property Manager','{leasing,management,maintenance}',true,false)",[user.id,p.id]);
  await pool.query("insert into assignments(person_id,property_id,role,is_active,provenance) values($1,$2,'property_manager',true,'{\"source\":\"staff_shell_fixture\"}'::jsonb)",[person.id,p.id]);
  const authorPhone=phone.replace('+1500','+1503');
  const authorPerson=await one("insert into persons(name,phone) values('Browser authorized offer author',$1) returning id",[authorPhone]);
  const authorUser=await one("insert into users(name,phone,role,is_active,status,account_kind,person_id) values('Browser authorized offer author',$1,'property_manager',true,'active','human_staff',$2) returning id",[authorPhone,authorPerson.id]);
  await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active,can_manage_roles) values($1,$2,'Property Admin','{leasing,management}',true,true)",[authorUser.id,p.id]);
  await pool.query("insert into assignments(person_id,property_id,role,is_active,provenance) values($1,$2,'asset_manager',true,'{\"source\":\"staff_shell_fixture\"}'::jsonb)",[authorPerson.id,p.id]);
  await pool.query("insert into communication_lines(e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) select $1,'property_facing',$2,'external','residents_and_prospects',true,true,'proactive','active' where not exists(select 1 from communication_lines where property_id=$2 and status='active' and outbound_enabled=true)",[phone,p.id]);
  const priorTransport=sms();
  const control=await fetch(api+'/auth/sms/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone_number:phone})});
  assert.equal(control.status,200,'owned returning-staff OTP control succeeds');
  await control.json();
  assert(sms().slice(priorTransport.length).split(/\r?\n/).filter(Boolean).some(line=>JSON.parse(line).to===phone),'real owned HTTP transport writes this exact fake log');
  const issued=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:p.id,purpose:'bootstrap_invite'}),token=issued.session_token||issued.token;
  const authorIssued=await sessions.issueStaffSession(pool,{userId:authorUser.id,propertyId:p.id,purpose:'bootstrap_invite'}),authorToken=authorIssued.session_token||authorIssued.token;
  const source='Browser owned '+tag,name='Browser Offer '+tag.slice(0,8);await pool.query("insert into lead_sources(name,source_type) values($1,'website')",[source]);
  const original='Please send me the studio floor plan.',followup='Also, which layout has a balcony?';
  const payload={property_id:p.id,name,phone:'+15005550'+String(parseInt(tag.slice(0,3),16)%1000).padStart(3,'0'),email:tag+'@example.invalid',source,attempt_sms:false,response_channel:'website',message:original};
  const intake=await fetch(api+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake','Idempotency-Key':tag},body:JSON.stringify(payload)});
  assert.equal(intake.status,200);const lead=await intake.json(),conv=await one('select id from conversations where person_id=$1 and property_id=$2',[lead.person_id,p.id]);
  const second=await fetch(api+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake','Idempotency-Key':tag+'-followup'},body:JSON.stringify({...payload,message:followup})});assert.equal(second.status,200);await second.json();
  const starts=new Date(Date.now()+30*3600000),ends=new Date(starts.getTime()+1800000);
  const slot=await one("insert into tour_availability(property_id,leasing_agent_id,starts_at,ends_at,status,capacity) values($1,$2,$3,$4,'open',1) returning *",[p.id,user.id,starts.toISOString(),ends.toISOString()]);
  await boundary.portFree(5174);
  server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(appRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(appRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5174,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[],bookings=[],writes=[];let loseFirst=true,loseFirstPreparation=true;
  page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR '+e.message);});
  await page.route('**/*',async route=>{
   const request=route.request(),u=new URL(request.url());
   if(u.origin==='https://property-spine-api.onrender.com'){
    const response=await route.fetch({url:api+u.pathname+u.search,maxRedirects:0});if(response.status()>=400)console.log('HTTP '+response.status()+' '+u.pathname+' '+(await response.text()).slice(0,200)); if(request.method()==='POST'&&(/application-offer|send-application/.test(u.pathname))) writes.push({path:u.pathname,request:request.postDataJSON(),status:response.status(),body:await response.json()});
    if(u.pathname.endsWith('/book-tour')&&request.method()==='POST'){
     bookings.push({request:request.postDataJSON(),status:response.status(),body:await response.json()});
     if(loseFirst){loseFirst=false;return route.abort('failed');}
    }
    if(u.pathname.endsWith('/send-application')&&request.method()==='POST'&&request.postDataJSON().delivery_method==='manual_email'&&response.status()===200&&loseFirstPreparation){loseFirstPreparation=false;return route.abort('failed');}
    return route.fulfill({response});
   }
   if(u.origin==='http://localhost:5174')return route.continue();
   return route.abort();
  });
  await page.addInitScript(s=>sessionStorage.setItem('__ps_staff_session__',JSON.stringify({t:s.token,m:{user_id:s.user,property_id:s.property}})),{token,user:user.id,property:p.id});
  // The shell restores its last module after hydration; navigate the visible
  // native Back/Home controls rather than clicking a hidden pre-hydration desk.
  async function openLeasingHome(){
   await page.waitForLoadState('networkidle');
   const home=page.locator('.psx-work');
   if(await home.isVisible())return;
   const desk=page.locator('.desk-card').filter({hasText:'LEASING'});
   if(await desk.isVisible())await desk.click();
   else await page.locator('.crumb-back').click();
   await home.waitFor({state:'visible'});
  }
  await page.goto('http://localhost:5174/');await page.waitForLoadState('networkidle');
  await openLeasingHome();
  await page.getByText(/open lead conversations/i).click();
  await page.getByRole('button',{name,exact:true}).click();
  await page.getByRole('tab',{name:'Communication',exact:true}).click();
  await page.getByText(original,{exact:true}).waitFor();await page.getByText(followup,{exact:true}).waitFor();
  check((await page.locator('#pcRail').innerText()).includes('Website inquiry needs attention'),'actual app labels unanswered website inquiry as staff attention');
  check(!(await page.locator('#pcRail').innerText()).includes('AI is handling'),'actual app does not claim nonexistent AI work');
  check((await page.locator('#pcRail').innerText()).includes(tag+'@example.invalid'),'website inquiry retains email contact');
  await page.screenshot({path:path.join(artifacts,'website-questions.png'),fullPage:true});
  await page.getByRole('button',{name:'Take over',exact:true}).click();
  await page.getByText('You are handling this conversation',{exact:true}).waitFor();
  const work=await one('select current_review_obligation_id from agent_thread_state where conversation_id=$1',[conv.id]);
  check(!!work.current_review_obligation_id,'actual browser takeover persists work');
  const beforeSms=sms();
  await page.getByRole('button',{name:'Schedule a tour',exact:true}).click();
  const select=page.getByRole('combobox',{name:'Available tour time'});await select.waitFor();
  check((await select.locator(`option[value="${slot.id}"]`).count())===1,'actual scoped availability renders selected native slot');
  await select.selectOption(slot.id);
  await page.getByRole('button',{name:'Book tour',exact:true}).click();
  await page.getByRole('alert').waitFor();
  check(bookings.length===1&&bookings[0].status===200,'first browser request committed before simulated response loss');
  check((await one('select count(*)::int n from leasing_tours where lead_id=$1',[lead.lead_id])).n===1,'lost response still corresponds to one real tour');
  await page.screenshot({path:path.join(artifacts,'response-lost.png'),fullPage:true});
  await page.getByRole('button',{name:'Book tour',exact:true}).click();
  await page.getByText('Tour booked. No confirmation message was sent.',{exact:true}).filter({visible:true}).waitFor();
  check(bookings.length===2&&bookings[1].status===200&&bookings[1].body.idempotent===true,'actual UI retry receives canonical idempotent receipt');
  check(bookings[0].request.idempotency_key===bookings[1].request.idempotency_key&&bookings[1].request.slot_id===slot.id,'same UI intent keeps exact slot and request identity');
  const tour=await one('select * from leasing_tours where lead_id=$1',[lead.lead_id]);
  check(tour.slot_id===slot.id&&tour.property_id===p.id&&tour.leasing_agent_id===user.id,'browser creates the chosen canonical tour');
  const event=await one("select * from tour_events where tour_id=$1 and event_type='scheduled'",[tour.id]);
  check(event.actor_id===user.id&&event.actor_type==='human'&&event.metadata.subject_person_id===lead.person_id,'browser booking stamps staff actor and distinct prospect subject');
  check(sms()===beforeSms,'browser booking and retry dispatch no message');

  // HTTP precondition: the prior browser proof owns tour booking. Actual outcome
  // is recorded at its canonical HTTP door here; no SQL after a domain action.
  const call=async(method,route,body,session=token)=>{const r=await fetch(api+route,{method,headers:{'content-type':'application/json','x-staff-session':session,'x-operator-key':'e2e-key'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const ci=await call('POST','/leasing/tours/'+tour.id+'/check-in',{actor_id:user.id});assert.equal(ci.status,200);
  const done=await call('POST','/operator/leasing/tours/'+tour.id+'/complete',{actual_tour_host_user_id:user.id,feedback:{standing:'ready_to_apply',next_move:'send_application',notes:'No-consent email inquiry needs exact home application.'},idempotency_key:tag+'-outcome'});assert.equal(done.status,200,JSON.stringify(done));
  const conversion=await one('select id from leasing_conversions where origin_tour_id=$1',[tour.id]);assert(conversion);
  const bed=await one("select s.id,u.id as unit_id from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and u.unit_number='3B' and s.space_label='Bed B'",[p.id]);assert(bed);
  const requestedStart=new Date(Date.now()+30*86400000).toISOString().slice(0,10),requestedEnd=new Date(Date.now()+394*86400000).toISOString().slice(0,10);
  // Existing canonical draft authored before the staff reopens this person's work.
  const draft=await call('POST','/operator/leasing/conversions/'+conversion.id+'/application-offer',{space_id:bed.id,rent:1250,security_deposit:1025,lease_start_date:requestedStart,lease_end_date:requestedEnd,fees:[],concessions:{status:'none'},idempotency_key:tag+'-original-draft'},authorToken);
  assert.equal(draft.status,200,JSON.stringify(draft));assert(draft.body.application_offer_id);

  await page.reload();await page.waitForLoadState('networkidle');
  await openLeasingHome();
  await page.locator('.psx-work').click();
  const row=page.locator('[data-desk-key]').filter({hasText:name});
  const send=row.getByRole('button',{name:/^(Send|Prepare email)$/});await send.waitFor();
  const firstState={proof_kind:'actual staff browser on owned DB/HTTP',complete:false,checks,actor:{role:'property_manager',can_manage_roles:false,no_pricing_grants:true,synthetic_mike_shape:true},sms_consent:'absent',property:p.id,person:lead.person_id,conversion:conversion.id,send_disabled:await send.isDisabled(),visible:await page.locator('body').innerText()};
  fs.writeFileSync(path.join(artifacts,'first-send-state.json'),JSON.stringify(firstState,null,2));await page.screenshot({path:path.join(artifacts,'first-send-state.png'),fullPage:true});
  console.log('FIRST SEND STATE '+JSON.stringify({checks,send_disabled:firstState.send_disabled,actor:firstState.actor}));
  assert(!firstState.send_disabled,'no-consent website lead can enter a native manual application preparation path');
  await send.click();
  check(await page.locator('#lqTargetStart').isVisible(),'actual staff board opens complete terms review from this prospect');
  const start=requestedStart,end=requestedEnd;
  await page.locator('#lqTargetStart').fill(start);await page.locator('#lqTargetEnd').fill(end);await page.locator('#lqFindHomes').click();

  await page.locator('.lqdt-unitbtn[data-space="'+bed.id+'"]').click();
  check((await page.locator('.lqdt-terms-note').filter({hasText:'Exact target:'}).innerText()).includes('3B · Bed B'),'actual review preserves selected exact bed');
  check(Number(await page.locator('#lqOfferRent').inputValue())===1250,'page reopen recovers the exact existing draft terms');
  await page.locator('#lqOfferRent').fill('1025');await page.locator('#lqOfferDep').fill('1025');await page.locator('#lqNoFees').check();await page.locator('#lqNoConcessions').check();

  await page.getByRole('button',{name:'Prepare application for email',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('lqOfferErr')?.textContent);
  check(writes.some(w=>w.path.endsWith('/application-offer')&&w.status===403&&w.body.error==='NO_APPLICATION_OFFER_AUTHORITY'),'Mike-shaped native rent correction refuses without pricing authority');
  check(!writes.some(w=>w.path.endsWith('/send-application')),'refused correction never advances into application preparation');
  const corrected=await call('POST','/operator/leasing/conversions/'+conversion.id+'/application-offer',{space_id:bed.id,rent:1025,security_deposit:1025,lease_start_date:requestedStart,lease_end_date:requestedEnd,fees:[],concessions:{status:'none'},supersedes_application_offer_id:draft.body.application_offer_id,idempotency_key:tag+'-authorized-correction'},authorToken);
  assert.equal(corrected.status,200,JSON.stringify(corrected));
  check(corrected.body.draft_revision===true&&corrected.body.applicant_review_required===false,'separate authorized actor corrects the exact draft over canonical HTTP');
  await page.reload();await page.waitForLoadState('networkidle');await openLeasingHome();await page.locator('.psx-work').click();
  await page.locator('[data-desk-key]').filter({hasText:name}).getByRole('button',{name:/^(Send|Prepare email)$/}).click();
  await page.locator('#lqTargetStart').fill(start);await page.locator('#lqTargetEnd').fill(end);await page.locator('#lqFindHomes').click();await page.locator('.lqdt-unitbtn[data-space="'+bed.id+'"]').click();
  check(Number(await page.locator('#lqOfferRent').inputValue())===1025,'Mike-shaped page reload reads the authorized successor on the same exact bed');
  await page.locator('#lqNoFees').check();await page.locator('#lqNoConcessions').check();

  check(await page.locator('input[name="lqDelivery"][value="sms"]').isDisabled(),'server refusal keeps unconsented text disabled');
  check(await page.locator('input[name="lqDelivery"][value="manual_email"]').isChecked(),'canonical manual preparation is selected');
  const beforeSendSms=sms();
  await page.getByRole('button',{name:'Prepare application for email',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('lqOfferErr')?.textContent);
  check(writes.filter(w=>w.path.endsWith('/send-application')&&w.status===200).length===1,'manual preparation committed before simulated response loss');
  check(sms()===beforeSendSms,'preparation sends no SMS');
  check(writes.filter(w=>w.path.endsWith('/application-offer')).length===1&&writes.find(w=>w.path.endsWith('/send-application')).request.application_offer_id===corrected.body.application_offer_id,'unchanged authorized terms prepare without another authoring request');
  await page.getByRole('button',{name:'Prepare application for email',exact:true}).click();
  await page.getByRole('button',{name:'Replace lost link',exact:true}).waitFor();
  check(writes.filter(w=>w.path.endsWith('/application-offer')).length===1,'same page retry retains the exact authorized offer');
  check(writes.some(w=>w.body.error==='APPLICATION_LINK_ALREADY_PREPARED'),'same preparation retry returns canonical lost-link correction');
  await page.getByRole('button',{name:'Replace lost link',exact:true}).click();
  await page.locator('#lqPreparedLink').waitFor();
  const firstReplacement=(await pool.query("select id,space_id from application_invitations where conversion_id=$1 and status='prepared'",[conversion.id])).rows;
  check(firstReplacement.length===1&&firstReplacement[0].space_id===bed.id,'replacement remains one prepared invitation on the chosen bed');
  await page.reload();await page.waitForLoadState('networkidle');await openLeasingHome();await page.locator('.psx-work').click();
  await page.locator('[data-desk-key]').filter({hasText:name}).getByRole('button',{name:/^(Send|Prepare email)$/}).click();
  await page.getByRole('button',{name:'Replace lost link',exact:true}).waitFor();
  check(await page.locator('#lqTargetStart').count()===0,'page reopen reads existing invitation without starting another offer');
  await page.getByRole('button',{name:'Replace lost link',exact:true}).click();await page.locator('#lqPreparedLink').waitFor();
  check(await page.locator('#lqRecordEmailSent').isDisabled(),'prepared link does not attest an email send');
  check((await page.locator('body').innerText()).includes('Spine has not sent this email.'),'actual app states preparation has not sent email');
  await page.getByRole('button',{name:'Copy link',exact:true}).click();
  check((await one("select count(*)::int n from application_invitations where conversion_id=$1 and status='manually_sent'",[conversion.id])).n===0,'copying link writes no send attestation');
  await page.screenshot({path:path.join(artifacts,'prepared-email.png'),fullPage:true});
  // Synthetic staff attestation on an isolated test record, no real email sent.
  await page.locator('#lqEmailSentCheck').check();await page.getByRole('button',{name:'Record email send',exact:true}).click();
  await page.getByText(/Send attested/).waitFor();
  const sent=(await pool.query("select id,status,space_id,sent_by_user_id,recipient_snapshot,dispatch_source,channel from application_invitations where conversion_id=$1 and status='manually_sent'",[conversion.id])).rows;
  check(sent.length===1&&sent[0].space_id===bed.id&&sent[0].sent_by_user_id===user.id&&sent[0].channel==='email'&&sent[0].dispatch_source==='manual','explicit UI attestation records exact invitation, bed, actor and email channel');
  check(sms()===beforeSendSms,'preparation, correction, reload, copy and attestation dispatch no SMS');
  check(errors.length===0,'actual app has no page errors');
  const receipt={proof_kind:'actual staff shell, owned HTTP/database',complete:true,checks,actor:{role:'property_manager',can_manage_roles:false,no_pricing_grants:true,synthetic_mike_shape:true},author:{user_id:authorUser.id,role:'asset_manager',can_manage_roles:true,canonical_http_actions:['initial_draft','draft_correction']},sms_consent:'absent',property:p.id,person:lead.person_id,conversion:conversion.id,bed:bed.id,authorized_offer_id:corrected.body.application_offer_id,sent,writes,external_email_sent:false,manual_attestation:'synthetic fixture user action',visible:await page.locator('body').innerText()};
  fs.writeFileSync(path.join(artifacts,'receipt.json'),JSON.stringify(receipt,null,2));await page.screenshot({path:path.join(artifacts,'email-send-recorded.png'),fullPage:true});
  console.log('RESULT '+checks+'/'+checks+' actual staff manual-email preparation and attestation; no real email sent');
 }catch(e){if(page){fs.writeFileSync(path.join(artifacts,'failure.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});}throw e;}
 finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
