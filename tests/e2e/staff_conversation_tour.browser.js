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
 const artifacts=path.resolve(process.env.E2E_ARTIFACT_DIR||'../../tmp/tour-browser-proof');fs.mkdirSync(artifacts,{recursive:true});
 const pool=new Pool({connectionString:boundary.manifest().url,ssl:false}),one=async(q,a=[])=>(await pool.query(q,a)).rows[0];
 let server,browser,page,checks=0;const check=(v,label)=>{assert(v,label);checks++;console.log('PASS '+label);};
 try{
  const p=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1"),tag=randomUUID();assert(p);
  await pool.query("update properties set operating_timezone='America/New_York' where id=$1",[p.id]);
  const phone='+1500'+String(parseInt(tag.slice(0,6),16)).padStart(7,'0').slice(-7);
  const person=await one("insert into persons(name,phone) values('Browser owned staff',$1) returning id",[phone]);
  const user=await one("insert into users(name,phone,role,is_active,status,account_kind,person_id) values('Browser owned staff',$1,'leasing_agent',true,'active','human_staff',$2) returning id",[phone,person.id]);
  await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active) values($1,$2,'Leasing Agent','{leasing}',true)",[user.id,p.id]);
  await pool.query("insert into communication_lines(e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) select $1,'property_facing',$2,'external','residents_and_prospects',true,true,'proactive','active' where not exists(select 1 from communication_lines where property_id=$2 and status='active' and outbound_enabled=true)",[phone,p.id]);
  const priorTransport=sms();
  const control=await fetch(api+'/auth/sms/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone_number:phone})});
  assert.equal(control.status,200,'owned returning-staff OTP control succeeds');
  await control.json();
  assert(sms().slice(priorTransport.length).split(/\r?\n/).filter(Boolean).some(line=>JSON.parse(line).to===phone),'real owned HTTP transport writes this exact fake log');
  const issued=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:p.id,purpose:'bootstrap_invite'}),token=issued.session_token||issued.token;
  const source='Browser owned '+tag,name='Browser Tour '+tag.slice(0,8);await pool.query("insert into lead_sources(name,source_type) values($1,'website')",[source]);
  const original='Please send me the studio floor plan.',followup='Also, which layout has a balcony?';
  const payload={property_id:p.id,name,email:tag+'@example.invalid',source,sms_consent:false,attempt_sms:false,response_channel:'website',message:original};
  const intake=await fetch(api+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake','Idempotency-Key':tag},body:JSON.stringify(payload)});
  assert.equal(intake.status,200);const lead=await intake.json(),conv=await one('select id from conversations where person_id=$1 and property_id=$2',[lead.person_id,p.id]);
  const second=await fetch(api+'/leasing/intake',{method:'POST',headers:{'content-type':'application/json','x-intake-secret':'e2e-intake','Idempotency-Key':tag+'-followup'},body:JSON.stringify({...payload,message:followup})});assert.equal(second.status,200);await second.json();
  const starts=new Date(Date.now()+30*3600000),ends=new Date(starts.getTime()+1800000);
  const slot=await one("insert into tour_availability(property_id,leasing_agent_id,starts_at,ends_at,status,capacity) values($1,$2,$3,$4,'open',1) returning *",[p.id,user.id,starts.toISOString(),ends.toISOString()]);
  await boundary.portFree(5173);
  server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(appRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!file.startsWith(appRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5173,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM?{executablePath:process.env.CHROMIUM}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[],bookings=[];let loseFirst=true;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const request=route.request(),u=new URL(request.url());
   if(u.origin==='https://property-spine-api.onrender.com'){
    const response=await route.fetch({url:api+u.pathname+u.search,maxRedirects:0});
    if(u.pathname.endsWith('/book-tour')&&request.method()==='POST'){
     bookings.push({request:request.postDataJSON(),status:response.status(),body:await response.json()});
     if(loseFirst){loseFirst=false;return route.abort('failed');}
    }
    return route.fulfill({response});
   }
   if(u.origin==='http://localhost:5173')return route.continue();
   return route.abort();
  });
  await page.addInitScript(s=>sessionStorage.setItem('__ps_staff_session__',JSON.stringify({t:s.token,m:{user_id:s.user,property_id:s.property}})),{token,user:user.id,property:p.id});
  await page.goto('http://localhost:5173/');
  await page.locator('.desk-card').filter({hasText:'LEASING'}).click();
  await page.getByText(/open lead conversations/i).click();
  await page.getByRole('button',{name,exact:true}).click();
  await page.getByRole('tab',{name:'Communication',exact:true}).click();
  await page.getByText(original,{exact:true}).waitFor();await page.getByText(followup,{exact:true}).waitFor();
  check((await page.locator('#pcRail').innerText()).includes('Website inquiry needs attention'),'actual app labels unanswered website inquiry as staff attention');
  check(!(await page.locator('#pcRail').innerText()).includes('AI is handling'),'actual app does not claim nonexistent AI work');
  check((await page.locator('#pcRail').innerText()).includes('No phone is recorded for texting.')
    && (await page.locator('#pcRail').innerText()).includes(tag+'@example.invalid')
    && await page.locator('#pcxCompose').count()===0,'email-only inquiry shows its contact and no unusable SMS composer');
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
  await page.getByRole('tab',{name:'Overview',exact:true}).click();
  const overview=await page.locator('#pcRail').innerText();
  check(/Respond to prospect inquiry/.test(overview)&&/Conversation owner/.test(overview),'refreshed actual overview retains canonical next work');
  const askResponse=await fetch(api+'/operator/ask-spine/ask',{method:'POST',headers:{'content-type':'application/json','x-staff-session':token},body:JSON.stringify({question:'What needs my attention?'})});
  const ask=await askResponse.json();
  check(ask.references?.some(r=>r.open?.id===lead.person_id&&r.personal_basis==='assigned_to_you'),'same staff Ask read retains accountable inquiry work after booking');
  check((await one('select count(*)::int n from leasing_tours where lead_id=$1',[lead.lead_id])).n===1,'UI retry does not duplicate canonical appointment');
  check(errors.length===0,'actual app produced no page errors');
  await page.screenshot({path:path.join(artifacts,'booked-overview.png'),fullPage:true});
  fs.writeFileSync(path.join(artifacts,'receipt.json'),JSON.stringify({checks,app_root:appRoot,property:p.id,person:lead.person_id,conversation:conv.id,tour:tour.id,slot:slot.id,actor:user.id,bookings,ask,overview},null,2));
  console.log(`RESULT ${checks}/${checks}`);
 }catch(e){if(page){fs.writeFileSync(path.join(artifacts,'failure.txt'),await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});}throw e;}
 finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
