"use strict";

// Focused standing projection contract. The application-offer service remains
// the owner of immutable terms; this test only verifies that standing asks it
// for the already-established/pending view and preserves its uncertainty.
const assert = require("assert");
const Module = require("module");
const path = require("path");

const PROPERTY = "00000000-0000-0000-0000-000000000001";
const PERSON = "00000000-0000-0000-0000-000000000002";
const SPACE = "00000000-0000-0000-0000-000000000003";
const APP = "00000000-0000-0000-0000-000000000004";
const TERMS = { property_id: PROPERTY, person_id: PERSON, target: { space_id: SPACE }, rent: "1350.00" };

let offerState = null;
let offerCalls = [];
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../shared/relationship_stage") {
    return { resolveRelationshipStage: async () => ({ stage: "application", basis: "recorded" }) };
  }
  if (request === "../money/effective_pricing") {
    return { resolveSpaceEconomics: async () => ({ resolved: false, reason: "no_published_schedule" }) };
  }
  if (request === "../applications/proposed_terms_service") {
    return {
      readBoundApplicationOffer: async (db, app, options) => {
        offerCalls.push({ db, app, options });
        if (offerState instanceof Error) throw offerState;
        return offerState;
      },
    };
  }
  return originalLoad(request, parent, isMain);
};
const { readLeasingStanding } = require(path.join(__dirname, "..", "..", "src", "leasing", "leasing_standing_read.js"));
Module._load = originalLoad;

function application(overrides = {}) {
  return {
    id: APP, property_id: PROPERTY, person_id: PERSON, unit_id: "unit-1", space_id: SPACE,
    applicant_name: "Resident", terms_review_obligation_id: null,
    executed_lease_record_id: null, created_at: "2026-09-20T00:00:00Z",
    application_offer_id: null, application_terms_hash: null,
    application_terms_acknowledged_at: null,
    unit_number: "Unit 1", space_label: "Room 1", status: "submitted",
    ...overrides,
  };
}

function dbFor(app) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (/from persons/.test(text)) return { rows: [{ id: PERSON, name: "Resident" }] };
      if (/from lease_applications a/.test(text)) return { rows: [app] };
      if (/from leasing_conversions/.test(text)) return { rows: [] };
      if (/from lease_packets/.test(text)) return { rows: [] };
      if (/from executed_lease_records/.test(text)) return { rows: [] };
      if (/from leases/.test(text)) return { rows: [] };
      if (/from application_proposed_terms_confirmations/.test(text)) return { rows: [] };
      if (/from obligations/.test(text)) return { rows: [] };
      throw new Error("Unhandled SQL: " + text);
    },
  };
}

(async () => {
  offerCalls = [];
  offerState = {
    id: null, hash: null, terms: null,
    pending_review: { id: "offer-pending", terms_hash: "b".repeat(64), terms: TERMS },
  };
  let db = dbFor(application());
  let standing = await readLeasingStanding(db, { person_id: PERSON, property_id: PROPERTY });
  assert.deepStrictEqual(standing.application.terms_review, {
    acknowledged_at: null, acknowledged: null, pending: TERMS,
  });
  assert.strictEqual(offerCalls[0].options.allowHistorical, true);
  assert.strictEqual(offerCalls[0].app.application_offer_id, null);
  const appSql = db.calls.find((c) => /from lease_applications a/.test(c.text));
  assert.match(appSql.text, /application_offer_id/);
  assert.match(appSql.text, /application_terms_hash/);
  assert.match(appSql.text, /application_terms_acknowledged_at/);

  offerState = { id: "offer-accepted", hash: "a".repeat(64), terms: TERMS };
  db = dbFor(application({ application_offer_id: "offer-accepted", application_terms_hash: "a".repeat(64), application_terms_acknowledged_at: "2026-09-21T00:00:00Z" }));
  standing = await readLeasingStanding(db, { person_id: PERSON, property_id: PROPERTY });
  assert.deepStrictEqual(standing.application.terms_review, {
    acknowledged_at: "2026-09-21T00:00:00Z", acknowledged: TERMS, pending: null,
  });

  offerState = null;
  db = dbFor(application());
  standing = await readLeasingStanding(db, { person_id: PERSON, property_id: PROPERTY });
  assert.strictEqual(standing.application.terms_review, null);

  offerState = new Error("offer reader unavailable");
  db = dbFor(application({ application_offer_id: "offer-failed", application_terms_hash: "a".repeat(64), application_terms_acknowledged_at: "2026-09-21T00:00:00Z" }));
  standing = await readLeasingStanding(db, { person_id: PERSON, property_id: PROPERTY });
  assert.strictEqual(standing.application.terms_review, null);
  assert(standing.uncertainty.some((n) => n.kind === "read_failed" && n.subject === "application_offer"));

  offerState = Object.assign(new Error("offer reader timed out"), {code:"READ_TIMED_OUT"});
  standing = await readLeasingStanding(dbFor(application()), {person_id:PERSON,property_id:PROPERTY});
  assert(standing.uncertainty.some(n=>n.subject==="application_offer" && n.read_state==="READ_TIMED_OUT"),"timeout must survive the standing read");

  console.log("leasing_standing_application_offer: PASS (pending, accepted, legacy, failed)");
})().catch((error) => { console.error(error); process.exit(1); });
