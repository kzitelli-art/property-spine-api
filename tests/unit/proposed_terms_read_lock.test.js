"use strict";
const assert = require("node:assert/strict");
const {readBoundApplicationOffer} = require("../../src/applications/proposed_terms_service");
const {termsHash} = require("../../src/money/application_offer_terms");

const terms = {
  property_id: "property", person_id: "person", target: {space_id: "space"},
  rent: "1200.00", security_deposit: "0.00", fees: [], concessions: {status: "none"},
  lease_start_date: "2026-10-01", lease_end_date: "2027-09-30",
};
const hash = termsHash(terms);
const bound = {
  id: "application", property_id: "property", person_id: "person", space_id: "space",
  application_offer_id: "acknowledged", application_terms_hash: hash,
  application_terms_acknowledged_at: "2026-09-12T00:00:00Z",
};
function client() {
  const queries = [];
  return {queries, async query(sql, args) {
    queries.push(sql);
    if (/from application_invitations/.test(sql)) return {rows: [{
      id: "invitation", application_offer_id: "pending", property_id: "property",
      person_id: "person", space_id: "space",
    }]};
    if (/select \* from lease_offers/.test(sql)) return {rows: [{
      id: args[0], offered_terms_snapshot: {application_terms: terms, application_terms_hash: hash},
    }]};
    throw Error("Unexpected query: " + sql);
  }};
}
(async () => {
  for (const app of [{...bound, application_offer_id: null}, bound]) {
    for (const lock of [false, undefined]) {
      const db = client();
      const result = await readBoundApplicationOffer(db, app,
        {allowHistorical: true, ...(lock === false ? {lock: false} : {})});
      assert.equal(result.pending_review.id, "pending");
      assert.equal(result.id, app.application_offer_id);
      const offers = db.queries.filter(sql => /select \* from lease_offers/.test(sql));
      assert.equal(offers.length, app.application_offer_id ? 2 : 1);
      assert.ok(offers.every(sql => /for update/i.test(sql) === (lock !== false)),
        `${app.application_offer_id ? "acknowledged plus successor" : "unbound pending"}: ${lock === false ? "read" : "default writer"} lock contract`);
    }
  }
  console.log("proposed terms read-lock: four branch/mode combinations passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
