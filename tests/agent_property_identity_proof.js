"use strict";

const assert = require("assert");
const agentModule = require("../src/agent/agent");

const router = agentModule({ pool: {}, anthropic: {}, INGEST_MODEL: "proof-model" });
const buildMessages = router._service.buildMessages;

const unit = {
  unit_number: "1417-102",
  bedrooms: 2,
  bathrooms: 1,
  square_feet: null,
  pricing: { quotable: true, rent: 850, lease_term_months: 12 },
};
const history = [{ direction: "inbound", body: "What does a two-bedroom cost?" }];

const skyline = buildMessages({ facts: [], unit, history, propertyName: "Skyline" });
assert.match(skyline.system, /leasing contact for Skyline/);
assert.match(skyline.system, /rent \$850\/mo on a 12-month term/);
assert.doesNotMatch(skyline.system, /SOLO|4233 Chestnut|University City/i);

const solo = buildMessages({ facts: [], unit: null, history, propertyName: "4233 Chestnut" });
assert.match(solo.system, /leasing contact for 4233 Chestnut/);
assert.match(solo.system, /SOLO on Chestnut is at 4233 Chestnut Street/);

const fairHousingFallback = router._service.postGenerationPolicy(
  "This is a safe area for students.",
  "Is this area safe?"
);
assert.doesNotMatch(JSON.stringify(fairHousingFallback), /SOLO|4233 Chestnut|University City/i);

console.log("agent property identity proof: passed");
