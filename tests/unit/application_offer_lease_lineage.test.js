#!/usr/bin/env node
"use strict";

/**
 * APPLICATION OFFER → PROPOSED TERMS LINEAGE
 *
 * Focused service contract. The offer reader is stubbed at its existing module
 * boundary; this test does not create a database or replace the reader's
 * canonical terms hash.
 */
const assert = require("assert");
const Module = require("module");
const path = require("path");

const APP = "11111111-1111-4111-8111-111111111111";
const PROPERTY = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const SPACE = "44444444-4444-4444-8444-444444444444";
const OFFER = "55555555-5555-4555-8555-555555555555";
const PENDING_OFFER = "77777777-7777-4777-8777-777777777777";
const TERMS_HASH = "a".repeat(64);

const offer = {
  offer_id: OFFER,
  property_id: PROPERTY,
  person_id: PERSON,
  space_id: SPACE,
  terms_hash: TERMS_HASH,
  rent: "1200.00",
  security_deposit: "0.00",
  lease_start_date: "2026-10-01",
  lease_end_date: "2027-09-30",
  fees: [{ code: "application", label: "Application fee", amount: "50.00", cadence: "one_time" }],
  concessions: { status: "none" },
  application_terms: {
    schema_version: 1,
    property_id: PROPERTY,
    person_id: PERSON,
    target: { space_id: SPACE },
    rent: "1200.00",
    security_deposit: "0.00",
    lease_start_date: "2026-10-01",
    lease_end_date: "2027-09-30",
    fees: [{ code: "application", label: "Application fee", amount: "50.00", cadence: "one_time" }],
    concessions: { status: "none" },
  },
};

let currentOffer = offer;
const pendingOffer = { ...offer, offer_id: PENDING_OFFER, terms_hash: "b".repeat(64), application_terms: { ...offer.application_terms, rent: "1350.00" }, rent: "1350.00" };
let currentGuardError = null;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../money/application_offer_terms") {
    return {
      readApplicationOffer: async (_client, input = {}) => input.offer_id === PENDING_OFFER ? pendingOffer : currentOffer,
      assertCurrentApplicationOffer: async () => {
        if (currentGuardError) throw currentGuardError;
      },
    };
  }
  return originalLoad(request, parent, isMain);
};
const svc = require(path.join(__dirname, "..", "..", "src", "applications", "proposed_terms_service.js"));
Module._load = originalLoad;

function clientFor(appOverrides = {}, existing = null, pendingOfferId = null) {
  const calls = [];
  const app = {
    id: APP, property_id: PROPERTY, person_id: PERSON, unit_id: "unit-1", space_id: SPACE,
    status: "lease_ready", terms_review_obligation_id: "ob-1",
    proposed_terms_confirmation_id: null, application_offer_id: OFFER,
    application_terms_hash: TERMS_HASH, application_terms_acknowledged_at: "2026-09-20T00:00:00Z",
    ...appOverrides,
  };
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (/from lease_applications where id=\$1/.test(text)) return { rows: [app] };
      if (/from application_invitations/.test(text)) return { rows: pendingOfferId ? [{ application_offer_id: pendingOfferId, property_id: PROPERTY, person_id: PERSON, space_id: SPACE }] : [] };
      if (/from obligations where id=\$1/.test(text)) {
        return { rows: [{ id: "ob-1", type: "terms_review", status: "open",
          assigned_role: "Leasing", assigned_user_id: null, required_inputs: ["terms_acknowledged"] }] };
      }
      if (/from application_proposed_terms_confirmations/.test(text)) return { rows: existing ? [existing] : [] };
      if (/from lease_packets/.test(text)) return { rows: [] };
      if (/from lease_economic_schedules/.test(text)) return { rows: [] };
      if (/insert into events/.test(text)) return { rows: [{ id: "event-1" }] };
      if (/insert into application_proposed_terms_confirmations/.test(text)) {
        return { rows: [{ id: "conf-1", created_at: "2026-09-21T00:00:00Z" }] };
      }
      if (/update lease_applications/.test(text)) return { rows: [] };
      throw new Error("Unhandled SQL: " + text);
    },
  };
}

const actor = { user_id: "66666666-6666-4666-8666-666666666666", property_id: PROPERTY, role: "Leasing" };
const matching = {
  application_id: APP, rent: 1200, security_deposit: 0,
  lease_start_date: "2026-10-01", lease_end_date: "2027-09-30",
  concession_status: "none", idempotency_key: "confirm-1", actor,
};

(async () => {
  const c = clientFor();
  const out = await svc.confirmProposedTerms(c, matching);
  assert.strictEqual(out.application_offer_id, OFFER);
  assert.strictEqual(out.application_terms_hash, TERMS_HASH);
  const insert = c.calls.find((x) => /insert into application_proposed_terms_confirmations/.test(x.text));
  assert(insert && /application_offer_id/.test(insert.text) && /application_terms_hash/.test(insert.text));
  assert(insert.params.includes(OFFER) && insert.params.includes(TERMS_HASH));

  currentGuardError = Object.assign(
    new Error("these application terms were superseded; review the current offer."),
    { code: "APPLICATION_TERMS_REVIEW_REQUIRED", httpStatus: 409 },
  );
  await assert.rejects(
    () => svc.confirmProposedTerms(clientFor(), matching),
    (e) => e.code === "APPLICATION_TERMS_REVIEW_REQUIRED" && e.httpStatus === 409,
  );
  currentGuardError = null;

  await assert.rejects(
    () => svc.confirmProposedTerms(clientFor(), { ...matching, rent: 1300 }),
    (e) => e.code === "application_terms_conflict" && e.httpStatus === 409
  );

  await assert.rejects(
    () => svc.confirmProposedTerms(clientFor({ application_terms_hash: null, application_terms_acknowledged_at: null }), matching),
    (e) => e.code === "application_terms_not_acknowledged" && e.httpStatus === 409
  );

  const missingTarget = JSON.parse(JSON.stringify(offer));
  delete missingTarget.application_terms.target;
  currentOffer = missingTarget;
  await assert.rejects(
    () => svc.confirmProposedTerms(clientFor(), matching),
    (e) => e.code === "application_offer_target_mismatch" && e.httpStatus === 403
  );
  currentOffer = offer;

  const legacy = clientFor({ application_offer_id: null, application_terms_hash: null, application_terms_acknowledged_at: null });
  const legacyOut = await svc.confirmProposedTerms(legacy, matching);
  assert.strictEqual(legacyOut.application_offer_id, null);
  const legacyInsert = legacy.calls.find((x) => /insert into application_proposed_terms_confirmations/.test(x.text));
  assert(legacyInsert && legacyInsert.params.includes(null));

  const pendingClient = clientFor({ application_offer_id: null, application_terms_hash: null, application_terms_acknowledged_at: null }, null, PENDING_OFFER);
  await assert.rejects(
    () => svc.confirmProposedTerms(pendingClient, matching),
    (e) => e.code === "APPLICATION_TERMS_REVIEW_REQUIRED" && e.httpStatus === 409,
  );
  const pendingReview = await svc.readBoundApplicationOffer(
    clientFor({ application_offer_id: null, application_terms_hash: null, application_terms_acknowledged_at: null }, null, PENDING_OFFER),
    { id: APP, property_id: PROPERTY, person_id: PERSON, space_id: SPACE, application_offer_id: null },
    { allowHistorical: true },
  );
  assert.deepStrictEqual(pendingReview, {
    id: null, hash: null, terms: null,
    pending_review: { id: PENDING_OFFER, terms_hash: pendingOffer.terms_hash, terms: pendingOffer.application_terms },
  });

  console.log("application_offer_lease_lineage: PASS (8 cases)");
})().catch((error) => { console.error(error); process.exit(1); });
