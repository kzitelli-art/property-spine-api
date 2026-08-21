"use strict";

const assert = require("assert");
const { evaluateReviewerPrecondition } = require("../src/identity/authority_resolution");

const GRANTEE_USER = "11111111-1111-4111-8111-111111111111";
const GRANTEE_PERSON = "22222222-2222-4222-8222-222222222222";
const REVIEWER_USER = "33333333-3333-4333-8333-333333333333";
const REVIEWER_PERSON = "44444444-4444-4444-8444-444444444444";

const context = ({ userId = REVIEWER_USER, personId = REVIEWER_PERSON,
  accountKind = "human_staff", mayManage = true, ok = true } = {}) => ({
  ok,
  failure_reason: ok ? null : "no_governed_authority_on_this_property",
  user: { user_id: userId, account_kind: accountKind },
  person: { person_id: personId },
  capabilities: { may_manage_concession_authority: mayManage },
  basis: { may_manage_concession_authority: mayManage ? "assignment:asset_manager" : null },
});
const evaluate = (overrides = {}) => evaluateReviewerPrecondition({
  reviewer_user_id: REVIEWER_USER,
  grantee_user_id: GRANTEE_USER,
  grantee_person_id: GRANTEE_PERSON,
  reason: "reviewed for proof",
  reviewer_context: context(),
  reviewer_staff_context_state: "present",
  ...overrides,
});

assert.strictEqual(evaluate().passed, true, "a distinct authorized reviewer passes");
assert.strictEqual(evaluate({ reviewer_user_id: null }).passed, false, "a missing reviewer is refused");
assert.strictEqual(evaluate({ reason: "  " }).passed, false, "a blank reason is refused");
assert.strictEqual(evaluate({ reviewer_user_id: GRANTEE_USER }).passed, false, "self-review by login is refused");
assert.strictEqual(evaluate({ reviewer_context: context({ personId: GRANTEE_PERSON }) }).passed, false,
  "a second login for the grantee's person is still self-review");
assert.strictEqual(evaluate({ reviewer_context: context({ accountKind: "unclassified" }) }).passed, false,
  "an unclassified reviewer is refused");
assert.strictEqual(evaluate({ reviewer_staff_context_state: "absent" }).passed, false,
  "a reviewer without property staff context is refused");
assert.strictEqual(evaluate({ reviewer_staff_context_state: "read_failed" }).passed, false,
  "a failed reviewer staff read refuses closed");
assert.strictEqual(evaluate({ reviewer_context: context({ mayManage: false }) }).passed, false,
  "pricing-review authority alone cannot grant authority");
assert.strictEqual(evaluate({ caller_granted_by_person_id: GRANTEE_PERSON }).passed, false,
  "caller-supplied grantor identity cannot override the reviewer");
assert.match(evaluate().detail, /assignment:asset_manager/,
  "the passing receipt records the reviewer's authority basis");

console.log("authority reviewer precondition proof: passed");
