"use strict";
// Class 3: actual app, fresh owned HTTP/Postgres, synthetic staff attestation.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {randomUUID}=require('crypto'),{chromium}=require('playwright'),{Pool}=require('pg');
const boundary=require('./proof_boundary');require('./proof_fence_preload');
const sessions=require('../../src/identity/staff_session_service');
(async()=>{
 await boundary.assertDatabase();const api=process.env.E2E_API_BASE;await boundary.waitServer(api);
 const appRoot=path.resolve(process.env.E2E_APP_ROOT||'../app-fable-review-20260907'),artifacts=path.resolve(process.env.E2E_ARTIFACT_DIR);fs.mkdirSync(artifacts,{recursive:true});
 assert(process.env.E2E_SMS_LOG&&process.env.E2E_ANTHROPIC_LOG);
 const log=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
 const pool=new Pool({connectionString:boundary.manifest().url,ssl:false}),one=async(sql,a=[])=>(await pool.query(sql,a)).rows[0];
 let server,browser,page,checks=0;const receipts=[],check=(v,label)=>{assert(v,label);checks++;console.log('PASS '+label);};
 try{
  const p=await one("select id from properties where name='Skyline E2E' order by created_at desc limit 1"),tag=randomUUID();assert(p);
  const phone='+1500'+String(parseInt(tag.slice(0,6),16)).padStart(7,'0').slice(-7);
  const person=await one("insert into persons(name,phone) values('Browser email staff',$1) returning id",[phone]);
  const user=await one("insert into users(name,phone,role,is_active,status,account_kind,person_id) values('Browser email staff',$1,'property_manager',true,'active','human_staff',$2) returning id",[phone,person.id]);
  await pool.query("insert into property_team_assignments(user_id,property_id,role_title,allowed_modules,active,can_manage_roles) values($1,$2,'Property Manager','{leasing,management,maintenance}',true,false)",[user.id,p.id]);
  await pool.query("insert into assignments(person_id,property_id,role,is_active,provenance) values($1,$2,'property_manager',true,'{\"source\":\"external_email_browser_fixture\"}'::jsonb)",[person.id,p.id]);
  await pool.query("insert into communication_lines(e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) select $1,'property_facing',$2,'external','residents_and_prospects',true,true,'proactive','active' where not exists(select 1 from communication_lines where property_id=$2 and status='active' and outbound_enabled=true)",[phone,p.id]);
  const source='Owned email browser '+tag;await pool.query("insert into lead_sources(name,source_type) values($1,'website')",[source]);
  const issued=await sessions.issueStaffSession(pool,{userId:user.id,propertyId:p.id,purpose:'bootstrap_invite'}),token=issued.session_token||issued.token;
  // Fixture setup ends here. Subsequent SQL observes only; domain actions use HTTP.
  const call=async(method,route,body,headers={})=>{const r=await fetch(api+route,{method,headers:{'content-type':'application/json','x-staff-session':token,...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  const beforeControl=log(process.env.E2E_SMS_LOG),otp=await call('POST','/auth/sms/start',{phone_number:phone});assert.equal(otp.status,200);
  assert(log(process.env.E2E_SMS_LOG).slice(beforeControl.length).includes(phone),'owned OTP control proves fake transport observation');
  const beforeSms=log(process.env.E2E_SMS_LOG),beforeModel=log(process.env.E2E_ANTHROPIC_LOG);
  await boundary.portFree(5174);server=http.createServer((req,res)=>{
   const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(appRoot,'.'+(pathname==='/'?'/index.html':pathname));
   if(!file.startsWith(appRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
   res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(file));
  });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(5174,'127.0.0.1',resolve);});
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM});
  for(const hasPhone of [false,true]){
   const shape=hasPhone?'phone_without_consent':'email_only',id=randomUUID(),name='Email Browser '+id.slice(0,8),email=id+'@example.invalid',question='Can you email the two-bedroom floor plan?';
   const payload={property_id:p.id,source,name,email,attempt_sms:false,response_channel:'website',message:question,...(hasPhone?{phone:'+1500555'+String(parseInt(id.slice(0,6),16)%10000).padStart(4,'0')}:{})};
   const intake=async(message,key)=>call('POST','/leasing/intake',{...payload,message},{'x-intake-secret':'e2e-intake','idempotency-key':id+'-'+key});
   const first=await intake(question,'first');assert.equal(first.status,200,JSON.stringify(first));const cid=first.body.conversation_id;assert(cid);
   check((await one("select count(*)::int n from comm_events where conversation_id=$1 and direction='outbound'",[cid])).n===0,shape+': website inquiry creates no phantom outbound');
   check(log(process.env.E2E_SMS_LOG)===beforeSms&&log(process.env.E2E_ANTHROPIC_LOG)===beforeModel,shape+': capture invokes neither SMS transport nor model');
   page=await browser.newPage({viewport:{width:1440,height:1100},timezoneId:'UTC'});const errors=[],writes=[];let loseFirst=!hasPhone;
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin==='https://property-spine-api.onrender.com'){
     const response=await route.fetch({url:api+url.pathname+url.search,maxRedirects:0});
     if(url.pathname.endsWith('/reply')&&request.method()==='POST'){
      writes.push({path:url.pathname,request:request.postDataJSON(),status:response.status(),body:await response.json()});
      if(loseFirst&&response.status()===200){loseFirst=false;return route.abort('failed');}
     }
     return route.fulfill({response});
    }
    if(url.origin==='http://localhost:5174')return route.continue();return route.abort();
   });
   await page.addInitScript(s=>sessionStorage.setItem('__ps_staff_session__',JSON.stringify({t:s.token,m:{user_id:s.user,property_id:s.property}})),{token,user:user.id,property:p.id});
   async function openConversation(){
    await page.waitForLoadState('networkidle');const home=page.locator('.psx-conversations');
    if(!(await home.isVisible())){const desk=page.locator('.desk-card').filter({hasText:'LEASING'});if(await desk.isVisible())await desk.click();else await page.locator('.crumb-back').click();await home.waitFor();}
    await home.click();await page.getByRole('button',{name,exact:true}).click();await page.getByRole('tab',{name:'Communication',exact:true}).click();await page.getByText(question,{exact:true}).waitFor();
   }
   await page.goto('http://localhost:5174/');await openConversation();
   check((await page.locator('#pcRail').innerText()).includes('Website inquiry needs attention'),shape+': original question remains unanswered in native Person Card');
   await page.getByRole('button',{name:'Take over',exact:true}).click();await page.getByText('You are handling this conversation',{exact:true}).waitFor();
   const before=await call('GET','/operator/leasing/conversations/'+cid);assert.equal(before.status,200);const workId=before.body.human_owner.obligation_id;
   if(hasPhone){check(await page.locator('#pcxCompose').isVisible(),'phone contact preserves the default text composer');await page.getByRole('button',{name:'Email already sent',exact:true}).click();}
   check(await page.locator('#pcxRecordEmail').isDisabled(),shape+': opening the email form records nothing');
   check(await page.locator('#pcxEmailTo').inputValue()===email&&await page.locator('#pcxEmailTo').getAttribute('readonly')!==null,shape+': email recipient stays canonical and read-only');
   const body='I emailed the requested two-bedroom floor plan and tour information. '+id.slice(0,8);
   await page.locator('#pcxEmailBody').fill(body);
   // Distinguish this synthetic actual-send time from intake at second precision.
   await page.waitForTimeout(1100);
   const sentLocal=new Date().toISOString().slice(0,19).replace(/:00$/,'');
   await page.locator('#pcxEmailTime').fill(sentLocal);await page.locator('#pcxEmailReference').fill('Synthetic external mailbox record '+id);
   check(await page.locator('#pcxRecordEmail').isDisabled()&&writes.length===0,shape+': body and actual time do not replace explicit sent attestation');
   await page.locator('#pcxEmailAttest').check();await page.locator('#pcxRecordEmail').click();
   if(!hasPhone){
    await page.getByRole('button',{name:'Retry recording',exact:true}).waitFor();
    check(writes.length===1&&writes[0].status===200,shape+': first recording committed before simulated response loss');
    check(await page.locator('#pcxEmailBody').isDisabled(),shape+': uncertain response retains the exact request for replay');
    await page.getByRole('button',{name:'Retry recording',exact:true}).click();
   }
   await page.getByText(/Your report of the external email was recorded/).waitFor();
   if(!hasPhone)check(writes.length===2&&JSON.stringify(writes[0].request)===JSON.stringify(writes[1].request)&&writes[1].body.replayed===true,shape+': identical recording key/body/time/recipient replays once');
   const result=writes.at(-1).body,event=await one('select * from comm_events where id=$1',[result.comm_event.id]);
   check(result.recorded===true&&result.dispatched===false&&result.provider_delivery==='not_verified'&&event.channel==='email'&&event.provider_status==='recorded_external',shape+': real receipt and communication make no delivery claim');
   check(event.actor_user_id===user.id&&event.sent_by_user_id===user.id&&event.obligation_id===workId&&event.body===body,shape+': exact staff actor, body and accountable work persist');
   check((await one("select count(*)::int n from comm_events where conversation_id=$1 and channel='email'",[cid])).n===1,shape+': one attributed external email exists');
   const queue=await call('GET','/operator/leasing/conversation-queue'),row=(queue.body.items||queue.body.conversations).find(r=>r.conversation_id===cid);
   check(row.waiting_on==='prospect'&&row.last_delivered_outbound_at===null,shape+': queue can await prospect without inventing delivery');
   await page.reload();await openConversation();await page.getByText(body,{exact:true}).waitFor();
   check((await page.locator('#pcxThread').innerText()).includes('Email recorded by staff · delivery unverified'),shape+': full reload shows retained email with manual provenance');
   const detail=await call('GET','/operator/leasing/conversations/'+cid),card=await call('GET','/operator/leasing/person-card?person_id='+first.body.person_id);
   check(detail.body.messages.some(m=>m.id===event.id&&m.external_email_reply?.actor_user_id===user.id)&&card.body.history.some(h=>h.detail?.body===body&&h.claim_strength==='asserted'),shape+': same event returns through canonical conversation and Person history');
   check(detail.body.human_owner.user_id===user.id&&detail.body.human_owner.obligation_id===workId&&detail.body.mode==='human_takeover',shape+': recording retains the same human owner');
   await page.screenshot({path:path.join(artifacts,shape+'-recorded.png'),fullPage:true});
   const later='One more question: is the balcony private?';const inbound=await intake(later,'later');assert.equal(inbound.status,200);
   await page.reload();await openConversation();await page.getByText(later,{exact:true}).waitFor();
   const laterQueue=await call('GET','/operator/leasing/conversation-queue'),laterRow=(laterQueue.body.items||laterQueue.body.conversations).find(r=>r.conversation_id===cid),laterDetail=await call('GET','/operator/leasing/conversations/'+cid);
   check(laterRow.waiting_on==='manager'&&laterDetail.body.human_owner.obligation_id===workId&&laterDetail.body.human_owner.user_id===user.id,shape+': later inbound returns unanswered work to the same owner');
   check(log(process.env.E2E_SMS_LOG)===beforeSms&&log(process.env.E2E_ANTHROPIC_LOG)===beforeModel,shape+': capture, recording, reload and later inbound call neither provider nor model');
   check(errors.length===0,shape+': actual staff app has no page errors');
   receipts.push({shape,conversation_id:cid,person_id:first.body.person_id,event_id:event.id,work_id:workId,actor_user_id:user.id,writes,external_email_sent:false});
   await page.screenshot({path:path.join(artifacts,shape+'-later-inbound.png'),fullPage:true});await page.close();page=null;
  }
  fs.writeFileSync(path.join(artifacts,'receipt.json'),JSON.stringify({complete:true,checks,proof_kind:'full actual staff app, owned HTTP/Postgres',receipts,external_email_sent:false},null,2));
  console.log('RESULT '+checks+'/'+checks+' actual external-email browser checks; no external email sent');
 }catch(e){if(page){fs.writeFileSync(path.join(artifacts,'failure.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});}throw e;}
 finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
