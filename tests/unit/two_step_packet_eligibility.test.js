#!/usr/bin/env node
"use strict";
// Two-step leasing (195): a submitted application bound to an acknowledged,
// current authored offer is packet-eligible WITHOUT approval; without that
// exact lineage the released refusal stands byte-for-byte.
const assert = require("node:assert/strict");
const { assessLeasePacketEligibility, REASON } = require("../../src/applications/lease_packet_eligibility");

const offer = { id: "offer-1", hash: "h1", terms: {} };
const base = { status: "submitted", property_id: "p", application_offer_id: "offer-1",
  application_terms_acknowledged_at: "2026-09-13T00:00:00Z", application_terms_hash: "h1",
  terms_review_obligation_id: null, activation_obligation_id: null, proposed_terms_confirmation_id: null };

let v = assessLeasePacketEligibility(base, { authoredOffer: offer });
assert.equal(v.eligible, true); assert.equal(v.preparation_basis, "authored_offer");

v = assessLeasePacketEligibility(base, {});
assert.equal(v.eligible, false); assert.equal(v.reason_code, REASON.STATUS_NOT_ELIGIBLE);
assert.equal(v.preparation_basis, null);

v = assessLeasePacketEligibility({ ...base, application_terms_acknowledged_at: null }, { authoredOffer: offer });
assert.equal(v.eligible, false, "unacknowledged offer is not a basis");
v = assessLeasePacketEligibility({ ...base, application_terms_hash: "old" }, { authoredOffer: offer });
assert.equal(v.eligible, false, "acknowledging a different version is not a basis");
v = assessLeasePacketEligibility({ ...base, application_offer_id: "offer-2" }, { authoredOffer: offer });
assert.equal(v.eligible, false, "a different offer id is not a basis");
v = assessLeasePacketEligibility({ ...base, status: "withdrawn" }, { authoredOffer: offer });
assert.equal(v.reason_code, REASON.TERMINAL, "a withdrawn application is terminal on either basis");
v = assessLeasePacketEligibility(base, { authoredOffer: offer, existingPacket: { id: "pk", status: "sent" } });
assert.equal(v.reason_code, REASON.ALREADY_ISSUED, "existing-packet rules still apply on the authored-offer basis");
v = assessLeasePacketEligibility({ ...base, status: "lease_ready", terms_review_obligation_id: "ob", proposed_terms_confirmation_id: "c" }, { authoredOffer: offer });
assert.equal(v.eligible, true); assert.equal(v.preparation_basis, "operator_confirmation", "the released basis is named as such");
v = assessLeasePacketEligibility(base, { authoredOffer: offer, expectedPropertyId: "other" });
assert.equal(v.reason_code, REASON.NOT_AT_PROPERTY, "the property wall precedes the basis");
console.log("two_step_packet_eligibility: PASS (10 assertions)");
