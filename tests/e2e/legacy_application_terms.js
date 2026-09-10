"use strict";
const crypto = require("crypto");

// Class 3: an explicitly migrated, already-submitted shape, created only in the
// owned E2E database. This does not claim canonical application birth or a send.
module.exports = async ({q,api,requireOk,expect,propertyId,unitId,spaceId,conversionId,token,base,dates}) => {
  if (process.env.E2E_DISPOSABLE_DATABASE !== "true") throw new Error("Owned database required");
  const person = (await q("insert into persons(name,lifecycle_status,source) values('Owned legacy terms applicant','prospect','legacy_terms_e2e') returning id")).rows[0];
  const conv = (await q(`insert into leasing_conversions(person_id,property_id,actual_tour_host_user_id,conversation_owner_user_id,tour_notes)
    select $1,property_id,actual_tour_host_user_id,conversation_owner_user_id,'Owned migration-shape fixture; no actual tour claimed'
    from leasing_conversions where id=$2 returning id`,[person.id,conversionId])).rows[0];
  const captured = {fixture:"already submitted before application offers",income_amount:72000};
  const app = (await q(`insert into lease_applications(property_id,person_id,unit_id,space_id,conversion_id,status,applicant_name,captured)
    values($1,$2,$3,$4,$5,'submitted','Owned legacy terms applicant',$6) returning *`,
    [propertyId,person.id,unitId,spaceId,conv.id,JSON.stringify(captured)])).rows[0];
  const secret=crypto.randomBytes(32).toString("hex");
  const inv=(await q(`insert into application_invitations(token_digest,conversion_id,person_id,property_id,unit_id,space_id,lease_application_id,status,consumed_at)
    values($1,$2,$3,$4,$5,$6,$7,'consumed',now()) returning id`,
    [crypto.createHash("sha256").update(secret).digest("hex"),conv.id,person.id,propertyId,unitId,spaceId,app.id])).rows[0];
  const before=requireOk(await api("GET",`/t/application/${secret}/context`,{}),"legacy submitted context");
  expect(before.state==="already_submitted","legacy fixture begins as submitted without pretending terms were accepted");
  async function askTerms(){
    const question="What are Owned legacy terms applicant's application terms?";
    const dashboard=requireOk(await api("POST","/operator/ask-spine/message",{token,body:{message:question}}),"Ask application terms");
    const compatibility=requireOk(await api("POST","/operator/ask-spine/ask",{token,body:{question}}),"Ask terms compatibility door");
    expect(dashboard.outcome==="answered" && dashboard.answer===compatibility.answer,"both Ask doors return the same governed application terms without model calls");
    return dashboard;
  }
  const notEstablished=await askTerms();
  expect(notEstablished.grounded_on.application_terms_state==="NOT_ESTABLISHED","Ask keeps missing legacy terms distinct from reader failure");
  const body={application_id:app.id,space_id:spaceId,rent:1025,security_deposit:0,lease_start_date:dates.start,
    lease_end_date:dates.end,fees:[],concessions:{status:"none"},idempotency_key:`legacy-terms-${app.id}`};
  const proposed=requireOk(await api("POST",`/operator/leasing/conversions/${conv.id}/application-offer`,{token,body}),"legacy offer proposal");
  const link=(await q("select application_offer_id from application_invitations where id=$1",[inv.id])).rows[0];
  expect(link.application_offer_id===proposed.application_offer_id,"proposing missing terms attaches to the SAME consumed legacy invitation");
  const unchanged=(await q("select * from lease_applications where id=$1",[app.id])).rows[0];
  expect(unchanged.rent===null && unchanged.application_offer_id===null && unchanged.application_terms_acknowledged_at===null
    && JSON.stringify(unchanged.captured)===JSON.stringify(app.captured),"manager proposal does not invent legacy acceptance or alter the submitted answers");
  const review=requireOk(await api("GET",`/operator/leasing/application-review?application_id=${app.id}`,{token}),"legacy pending review");
  expect(review.application_offer.id===null && review.application_offer.acknowledged_at===null
    && review.application_offer.pending_review.id===proposed.application_offer_id,"staff detail separates missing acknowledgement from pending initial terms");
  const pendingAsk=await askTerms();
  expect(pendingAsk.grounded_on.application_terms.acknowledged===null
    && pendingAsk.grounded_on.application_terms.pending.rent===review.application_offer.pending_review.terms.rent
    && pendingAsk.grounded_on.application_terms.pending.security_deposit==="0.00"
    && /Bed B/.test(pendingAsk.answer),"Ask and staff detail agree on pending rent, zero deposit and exact bed without inventing acceptance");
  const context=requireOk(await api("GET",`/t/application/${secret}/context`,{}),"legacy pending context");
  expect(context.state==="terms_review" && !context.previous_terms_acknowledged && !context.previous_application_terms,
    "same tenant link requests first terms review without inventing previously agreed terms");
  const retry=requireOk(await api("POST",`/operator/leasing/conversions/${conv.id}/application-offer`,{token,body}),"legacy proposal replay");
  expect(retry.idempotent && retry.application_offer_id===proposed.application_offer_id,"legacy proposal retry reuses the same offer");
  const conflicting=await api("POST",`/operator/leasing/conversions/${conv.id}/application-offer`,{token,body:{...body,idempotency_key:body.idempotency_key+"-other"}});
  expect(conflicting.status===409,"another initial proposal cannot replace pending terms without naming their predecessor");
  const wrongApp=await api("POST",`/operator/leasing/conversions/${conv.id}/application-offer`,{token,body:{...body,application_id:crypto.randomUUID()}});
  expect(wrongApp.status===409,"client application identifier cannot redirect the invitation relationship");
  const unack=await api("POST","/applications/submit-public",{body:{token:secret}});
  expect(unack.status===409,"legacy consumed link cannot skip its newly required acknowledgement");
  const acceptance=process.env.PROOF_TENANT_BROWSER==="1"
    ? await require("./tenant_journey_browser").acceptRevisedTerms(base,secret,{previousAcknowledged:false})
    : requireOk(await api("POST","/applications/submit-public",{body:{token:secret,application_terms_hash:context.application_terms.terms_hash,application_terms_acknowledged:true}}),"first legacy acknowledgement");
  const history=(await q("select * from application_terms_acknowledgements where application_id=$1",[app.id])).rows;
  expect(acceptance.application.id===app.id && history.length===1 && acceptance.application.deposit!==null && Number(acceptance.application.deposit)===0
    && JSON.stringify(acceptance.application.captured)===JSON.stringify(app.captured),
    "first explicit terms acceptance preserves one legacy application, zero deposit, and original answers");
  const acceptedAsk=await askTerms();
  expect(acceptedAsk.grounded_on.application_terms_state==="ACKNOWLEDGED"
    && acceptedAsk.grounded_on.application_terms.pending===null
    && Number(acceptedAsk.grounded_on.application_terms.acknowledged.rent)===Number(acceptance.application.rent),
    "Ask rereads the same application acceptance and removes the pending proposal");
  await q(`insert into lease_applications(property_id,person_id,unit_id,space_id,status,applicant_name,created_at)
    values($1,$2,$3,$4,'withdrawn','Owned earlier migrated application',now()-interval '1 year')`,[propertyId,person.id,unitId,spaceId]);
  const ambiguous=requireOk(await api("POST","/operator/ask-spine/ask",{token,body:{question:"What are Owned legacy terms applicant's application terms?"}}),"multiple application clarification");
  expect(ambiguous.outcome==="clarification" && ambiguous.grounded_on.application_count===2,"Ask refuses to choose silently between multiple applications for one person");
  const latest=requireOk(await api("POST","/operator/ask-spine/ask",{token,body:{question:"What are Owned legacy terms applicant's latest application terms?"}}),"explicit latest application");
  expect(latest.outcome==="answered" && latest.grounded_on.application_terms_state==="ACKNOWLEDGED"
    && /latest application/.test(latest.answer),"explicit latest request reads the same accepted application and names that selection");
};
