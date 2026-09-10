"use strict";
// Class 3: browser actions against the same real-server journey and invitations.
// No alternate form, application writer, signer store, or mocked API response.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const path = require("node:path");
async function capture(page,name) {
  if(process.env.PROOF_OUTPUT_DIR) await page.screenshot({path:path.join(process.env.PROOF_OUTPUT_DIR,`${name}.png`),fullPage:true});
}
async function inBrowser(base, act) {
  const browser = await chromium.launch({executablePath:process.env.CHROME || process.env.CHROMIUM,headless:true});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.route("**/*", route => {
      const u=new URL(route.request().url());
      return u.origin===new URL(base).origin ? route.continue() : route.abort();
    });
    let result;
    try { result=await act(page); }
    catch(error) {
      await capture(page,"tenant-browser-first-red").catch(()=>{});
      throw error;
    }
    assert.deepEqual(errors,[],"Tenant page has no JavaScript errors");
    return result;
  } finally { await browser.close(); }
}
async function submitApplication(base,token,name,captured,{beforeSubmit=null}={}) {
  return inBrowser(base,async page=>{
    await page.goto(`${base}/t/application/${token}`);
    // Context hydrates and focuses the opening screen asynchronously. Wait
    // for that existing state before attempting the first user action.
    await page.locator('.screen.on[data-step="0"]').waitFor();
    await page.locator('#applicationTerms').getByText(/1,025/).first().waitFor();
    assert.match(await page.locator('#applicationTerms').innerText(), /Bed B/);
    await page.getByRole("button",{name:"Continue to application",exact:true}).click();
    assert(await page.locator('.screen.on[data-step="0"]').count(), "Cannot enter personal questions before terms acknowledgement");
    await capture(page,"tenant-application-terms-first");
    await page.locator('#termsAcknowledgement').check();
    await page.getByRole("button",{name:"Continue to application",exact:true}).click();
    if(await page.locator('#targetMoveRow[hidden]').count())
      assert.equal(await page.locator('#targetMoveRow').isVisible(),false,"Unknown target date has no empty labeled row");
    const fill=async values=>{for(const [id,value] of Object.entries(values)) await page.locator(`#${id}`).fill(String(value));};
    const next=async step=>{
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"Application fits mobile width");
      await page.locator(".screen.on [data-next]").click();
      await page.locator(`.screen.on[data-step="${step}"]`).waitFor();
    };
    await fill({legal_name:name,dob_input:captured.date_of_birth,email:captured.email,phone:captured.phone});
    await next(2);
    await fill({address_line1:captured.address.line1,city:captured.address.city,state:captured.address.state,
      postal_code:captured.address.postal_code,current_since:captured.current_since});
    await page.locator('label[for="hs_rent"]').click();
    await next(3);
    await page.locator('#income_status').selectOption(captured.income_status);
    await fill({employer:captured.employer,job_title:captured.job_title,income_amount:captured.income_amount});
    await page.locator('#income_frequency').selectOption(captured.income_frequency);
    await next(4);
    await fill({desired_move_in:captured.desired_move_in,occupants:captured.occupants});
    await page.locator('#move_flexibility').selectOption(captured.move_flexibility);
    await page.locator('label[for="pets_no"]').click();
    await page.locator('label[for="guarantor_yes"]').click();
    await fill({guarantor_name:captured.guarantor_contact.name,guarantor_phone:captured.guarantor_contact.phone,
      guarantor_email:captured.guarantor_contact.email});
    await next(5);
    await capture(page,"tenant-application-review");
    await page.locator('#certify').check();
    await page.locator('#electronicConsent').check();
    if(beforeSubmit){
      await beforeSubmit();
      await page.locator('#submitButton').click();
      await page.locator('.screen.on[data-step="0"]').waitFor();
      assert.equal(await page.locator('#termsAcknowledgement').isChecked(),false,"Changed terms clear prior acknowledgement");
      assert.equal(await page.locator('#legal_name').inputValue(),name,"Changed terms preserve the personal draft");
      await page.locator('#termsAcknowledgement').check();
      for(let step=1;step<=5;step++) await next(step);
      await page.locator('#certify').check();
      await page.locator('#electronicConsent').check();
    }
    const responsePromise=page.waitForResponse(r=>r.url()===`${base}/applications/submit-public`&&r.request().method()==="POST");
    await page.locator('#submitButton').click();
    const response=await responsePromise;
    assert(response.ok(),`Browser application submit HTTP ${response.status()}`);
    await page.getByRole('heading',{name:'Application submitted',exact:true}).waitFor();
    console.log("BROWSER_APPLICATION_SUBMITTED: real mobile form -> real HTTP writer");
    return response.json();
  });
}
async function acceptRevisedTerms(base,token,{previousAcknowledged=true}={}) {
  return inBrowser(base,async page=>{
    await page.goto(`${base}/t/application/${token}`);
    await page.getByRole('button',{name:'Accept revised terms',exact:true}).waitFor();
    await page.locator('.screen.on[data-step="0"]').waitFor();
    const termsText=await page.locator('#applicationTerms').innerText();
    if(previousAcknowledged) assert.match(termsText,/Previously reviewed/);
    else assert.doesNotMatch(termsText,/Previously reviewed/,"First review cannot invent prior agreement");
    assert.equal(await page.locator('#legal_name').isVisible(),false,"Re-acceptance does not repeat the personal application");
    await page.locator('#termsAcknowledgement').check();
    // Await both promises together so a response timeout cannot terminate the
    // process before the failure screenshot and browser cleanup run.
    const [response]=await Promise.all([
      page.waitForResponse(r=>r.url()===`${base}/applications/submit-public`&&r.request().method()==='POST'),
      page.getByRole('button',{name:'Accept revised terms',exact:true}).click(),
    ]);
    assert(response.ok(),`Revised terms acknowledgement HTTP ${response.status()}`);
    await page.getByRole('heading',{name:'Revised terms accepted',exact:true}).waitFor();
    await capture(page,'tenant-revised-terms-accepted');
    return response.json();
  });
}
async function signLease(base,token,name,requiredFields) {
  return inBrowser(base,async page=>{
    await page.goto(`${base}/t/lease/${token}`);
    await page.locator('#submitBtn').waitFor();
    await page.getByText(/Bed B/).first().waitFor();
    assert.match(await page.locator('body').innerText(),/Bed B/,"Signer sees exact bed");
    await capture(page,requiredFields[0].signer_role==="guarantor"?"guarantor-lease-review":"tenant-lease-review");
    for(const field of requiredFields) {
      const button=page.locator(`[data-complete="${field.id}"]`);
      if(field.field_type==='signature') await page.locator(`[data-signature-name="${field.id}"]`).fill(name);
      const responsePromise=page.waitForResponse(r=>r.url().endsWith(`/fields/${field.id}/complete`)&&r.request().method()==='POST');
      await button.click();
      assert((await responsePromise).ok(),`Signer completed ${field.field_key}`);
      await page.locator(`#field-${field.id}.done`).waitFor();
    }
    const responsePromise=page.waitForResponse(r=>r.url().endsWith(`/t/lease/${token}/submit`)&&r.request().method()==='POST');
    await page.locator('#submitBtn').click();
    const response=await responsePromise;
    const body=await response.json();
    assert(response.ok(),`Signer submission HTTP ${response.status()}`);
    console.log(`BROWSER_SIGNER_SUBMITTED: ${requiredFields[0].signer_role} -> real HTTP writer`);
    return {status:response.status(),body};
  });
}
module.exports={submitApplication,signLease,acceptRevisedTerms};
