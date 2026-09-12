const assert = require("assert");
const Module = require("module");
const path = require("path");

const PROPERTY = "00000000-0000-0000-0000-000000000001";
const OTHER_PROPERTY = "00000000-0000-0000-0000-000000000099";
const APPLICATION = "00000000-0000-0000-0000-000000000010";
const PERSON = "00000000-0000-0000-0000-000000000011";
const SPACE = "00000000-0000-0000-0000-000000000012";
const OFFER = "00000000-0000-0000-0000-000000000013";
const PENDING_OFFER = "00000000-0000-0000-0000-000000000015";
const TERMS_HASH = "a".repeat(64);
const PENDING_TERMS_HASH = "b".repeat(64);

const applicationTerms = {
  property_id: PROPERTY,
  person_id: PERSON,
  target: { space_id: SPACE },
  rent: "1200.00",
  security_deposit: "0.00",
  lease_start_date: "2026-10-01",
  lease_end_date: "2027-09-30",
  fees: [{ code: "application", label: "Application fee", amount: "50.00", cadence: "one_time" }],
  concessions: { status: "none" },
};
const pendingTerms = { ...applicationTerms, rent: "1350.00" };

let boundReaderCalls = [];
let pendingInvitationOfferId = null;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./proposed_terms_service") {
    return {
      readBoundApplicationOffer: async (client, app, options) => {
        boundReaderCalls.push({ client, app, options });
        if (!app.application_offer_id) {
          return pendingInvitationOfferId ? {
            id: null, hash: null, terms: null,
            pending_review: {
              id: PENDING_OFFER, terms_hash: PENDING_TERMS_HASH, terms: pendingTerms,
            },
          } : null;
        }
        const state = { id: OFFER, hash: TERMS_HASH, terms: applicationTerms };
        if (pendingInvitationOfferId) {
          state.pending_review = {
            id: PENDING_OFFER, terms_hash: PENDING_TERMS_HASH, terms: pendingTerms,
          };
        }
        return state;
      },
    };
  }
  if (request === "../money/application_offer_terms") {
    return {
      readApplicationOffer: async (client, input) => {
        assert.strictEqual(input.offer_id, PENDING_OFFER);
        return {
          offer_id: PENDING_OFFER,
          terms_hash: PENDING_TERMS_HASH,
          application_terms: pendingTerms,
        };
      },
    };
  }
  return originalLoad(request, parent, isMain);
};
const { buildReviewDetail } = require(path.join(__dirname, "..", "..", "src", "applications", "application_review.js"));
Module._load = originalLoad;

function clientFor(app) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (/from lease_applications a/.test(text)) return { rows: [app] };
      if (/from lease_packets/.test(text)) return { rows: [] };
      if (/from executed_lease_records/.test(text)) return { rows: [] };
      if (/from leases/.test(text)) return { rows: [] };
      if (/from spaces/.test(text)) return { rows: [{ space_id: SPACE, space_label: "Room 1" }] };
      if (/from application_invitations/.test(text)) {
        return { rows: pendingInvitationOfferId ? [{ application_offer_id: pendingInvitationOfferId }] : [] };
      }
      throw new Error("Unhandled SQL: " + text);
    },
  };
}

function app(overrides = {}) {
  return {
    id: APPLICATION,
    property_id: PROPERTY,
    person_id: PERSON,
    unit_id: "00000000-0000-0000-0000-000000000014",
    space_id: SPACE,
    applicant_name: "Resident",
    unit_label: "Unit 1",
    status: "submitted",
    rent: 1200,
    deposit: 0,
    lease_start_date: "2026-10-01",
    lease_end_date: "2027-09-30",
    concession_status: "none",
    application_offer_id: OFFER,
    application_terms_hash: TERMS_HASH,
    application_terms_acknowledged_at: "2026-09-20T00:00:00Z",
    proposed_terms_confirmation_id: null,
    ...overrides,
  };
}

(async () => {
  boundReaderCalls = [];
  const client = clientFor(app());
  const detail = await buildReviewDetail(client, APPLICATION, PROPERTY);
  assert.deepStrictEqual(detail.application_offer, {
    id: OFFER,
    terms_hash: TERMS_HASH,
    acknowledged_at: "2026-09-20T00:00:00Z",
    terms: applicationTerms,
  });
  assert.strictEqual(boundReaderCalls.length, 1);
  assert.strictEqual(boundReaderCalls[0].app.property_id, PROPERTY);
  assert.strictEqual(boundReaderCalls[0].app.space_id, SPACE);
  // The review is a projection: historical offers are allowed and no row lock is
  // taken, so the Leasing desk can read it inside a READ ONLY transaction.
  assert.deepStrictEqual(boundReaderCalls[0].options, { allowHistorical: true, lock: false });

  pendingInvitationOfferId = PENDING_OFFER;
  const pending = await buildReviewDetail(clientFor(app()), APPLICATION, PROPERTY);
  assert.deepStrictEqual(pending.application_offer.pending_review, {
    id: PENDING_OFFER,
    terms_hash: PENDING_TERMS_HASH,
    terms: pendingTerms,
  });
  assert.strictEqual(pending.application_offer.acknowledged_at, "2026-09-20T00:00:00Z");
  pendingInvitationOfferId = null;

  boundReaderCalls = [];
  const outOfScope = await buildReviewDetail(clientFor(app({ property_id: OTHER_PROPERTY })), APPLICATION, PROPERTY);
  assert.deepStrictEqual(outOfScope, { notInScope: true });
  assert.strictEqual(boundReaderCalls.length, 0, "property wall must precede offer read");

  const legacy = await buildReviewDetail(clientFor(app({
    application_offer_id: null,
    application_terms_hash: null,
    application_terms_acknowledged_at: null,
  })), APPLICATION, PROPERTY);
  assert.strictEqual(legacy.application_offer, null);

  pendingInvitationOfferId = PENDING_OFFER;
  const unboundPending = await buildReviewDetail(clientFor(app({
    application_offer_id: null,
    application_terms_hash: null,
    application_terms_acknowledged_at: null,
  })), APPLICATION, PROPERTY);
  assert.deepStrictEqual(unboundPending.application_offer, {
    id: null,
    terms_hash: null,
    acknowledged_at: null,
    terms: null,
    pending_review: {
      id: PENDING_OFFER,
      terms_hash: PENDING_TERMS_HASH,
      terms: pendingTerms,
    },
  });

  console.log("application_review_offer: PASS (bound, pending, scoped, legacy, unbound-pending)");
})().catch((error) => { console.error(error); process.exit(1); });
