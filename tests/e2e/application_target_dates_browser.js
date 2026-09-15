"use strict";
// Class3: actual app picker/review functions over the real owned API. Does not
// claim full app-shell navigation or a send. Browser reads only; no product writes.
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {chromium}=require("playwright");
module.exports=async function({base,session,start,end,spaceId,outgoingEnd,personId}) {
  const picker=fs.readFileSync(path.join(process.env.PSPINE_APP_ROOT,"application-offer-review.js"),"utf8");
  const followups=fs.readFileSync(path.join(process.env.PSPINE_APP_ROOT,"followups-door.js"),"utf8");
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME});
  let page;
  try {
    page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto(base+"/health");
    await page.setContent('<main id="psFollowupsEntry"></main>');
    const appHtml=fs.readFileSync(path.join(process.env.PSPINE_APP_ROOT,'index.html'),'utf8');
    await page.addStyleTag({content:Array.from(appHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi),m=>m[1]).join('\n')});
    await page.evaluate(({session})=>{
      const read=async route=>{const r=await fetch(route,{headers:{'x-staff-session':session}});if(!r.ok)throw Error('Owned read failed: '+r.status);return {data:await r.json()};};
      window.__psLive={hasSession:()=>true,
        loadResource:async(name,params)=>read(name==='personCard'?'/operator/leasing/person-card?person_id='+encodeURIComponent(params.personId):name==='leasingDesk'?'/operator/leasing/desk':'/operator/leasing/lease-configuration'),
        leaseableUnits:term=>read('/operator/leasing/leaseable-units?'+new URLSearchParams(term)),
        createApplicationOffer:()=>{throw Error('No writes in picker proof');},
        sendApplicationFromConversion:()=>{throw Error('No sends in picker proof');}};
    },{session});
    await page.addScriptTag({content:picker});
    await page.addScriptTag({content:followups});
    await page.evaluate(()=>window.__psFollowups.mount(document.getElementById('psFollowupsEntry')));
    await page.waitForSelector('[data-ps-state="data"]');
    // Read-only synthetic navigation context; no canonical tour/conversion birth
    // is claimed by this fixture. Complete write path has its separate proof.
    await page.evaluate(personId=>window.__psFollowups.openApplicationSend({conversion_id:'owned-read-only',person_id:personId,person_name:'Owned prospect'}),personId);
    await page.waitForFunction(()=>document.getElementById('lqProspectContext').textContent.includes('high-floor studio'),undefined,{polling:100});
    assert.match(await page.locator('#lqProspectContext').innerText(),/Budget: 0/);
    assert.match(await page.locator('#lqProspectContext').innerText(),/Move month: 2026-11/);
    assert.equal(await page.locator('#lqTargetStart').inputValue(),'');
    console.log('PICKER_LAYOUT',await page.locator('#lqFindHomes').evaluate(e=>({connected:e.isConnected,rect:e.getBoundingClientRect().toJSON(),ancestors:Array.from((function*(n){while(n){yield n;n=n.parentElement;}})(e)).map(n=>({tag:n.tagName,cls:n.className,display:getComputedStyle(n).display,visibility:getComputedStyle(n).visibility}))})));
    await page.locator('#lqFindHomes').click();
    assert.match(await page.locator('#lqUnitWrap').innerText(),/both dates/);
    await page.locator('#lqTargetStart').fill(start);
    await page.locator('#lqTargetEnd').fill(end);
    await page.locator('#lqFindHomes').click();
    const button=page.locator(`[data-space="${spaceId}"]`);
    await button.waitFor();
    const label=(await button.innerText()).toLowerCase().replace(/\s+/g,' ');assert(label.includes('lease ends '+outgoingEnd));assert(label.includes('expected ready '+start));assert(!label.includes('vacancy window'));
    const excluded=await page.evaluate(async({session,start,end})=>{
      const response=await fetch('/operator/leasing/leaseable-units?'+new URLSearchParams({requested_start:start,requested_end:end}),{headers:{'x-staff-session':session}});
      if(!response.ok)throw Error('Excluded target read failed');
      return (await response.json()).excluded_targets;
    },{session,start,end});
    assert(excluded.length>0,'the owned fixture must challenge excluded rows');
    const blockedText=await page.locator('#lqUnitWrap').innerText();
    for(const target of excluded){
      assert(blockedText.includes(target.refusal_reason),'browser retains canonical dated refusal');
      assert(blockedText.includes(target.unit_number));
      if(target.space_label)assert(blockedText.includes(target.space_label));
      assert.equal(await page.locator(`.lqdt-unitbtn[data-space="${target.space_id}"]`).count(),0,'rejected exact home is not selectable');
    }
    await button.click();
    assert.equal(await page.locator('#lqOfferStart').inputValue(),start);
    assert.equal(await page.locator('#lqOfferEnd').inputValue(),end);
    assert(await page.locator('#lqOfferStart').evaluate(e=>e.readOnly));
    await page.locator('#lqOfferBack').click();
    assert.equal(await page.locator('#lqTargetStart').inputValue(),start);
    assert.equal(await page.locator('#lqTargetEnd').inputValue(),end);
    assert.equal(await page.locator('.lqdt-unitbtn').count(),0,"Back requires a fresh date check; no stale targets");
    console.log('BROWSER_PICKER_DATES: actual post-tour controller -> shared picker -> owned HTTP -> same dates in terms; no send');
  } catch(error){
    const folder=path.dirname(process.env.E2E_PROOF_MANIFEST);
    if(page){await page.screenshot({path:path.join(folder,'picker-failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(folder,'picker-failure.html'),await page.content().catch(()=>''));}
    throw error;
  } finally {await browser.close();}
};
