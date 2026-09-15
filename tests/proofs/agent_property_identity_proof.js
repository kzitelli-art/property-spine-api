"use strict";

const assert = require("assert");
const agentModule = require("../../src/agent/agent");

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

assert.deepStrictEqual(router._service.directPricingReply({
  inboundText: "What is the monthly rent for a two-bedroom?", unit,
}), {
  body: "Unit 1417-102 is $850/month on a 12-month lease.",
  code: "pricing_direct_quote",
});
const termMenu = "We have 2 Bedroom on 5 and 12-month terms. Which length do you want?";
assert.deepStrictEqual(router._service.directPricingReply({
  inboundText: "How much is the rent?",
  unit: { ...unit, pricing: { quotable: false, reason: "lease_term_not_selected", say: termMenu } },
}), { body: termMenu, code: "pricing_direct_refusal" });
assert.strictEqual(router._service.directPricingReply({
  inboundText: "What is the application fee?", unit,
}), null, "mixed economic classes stay on the composed path");
assert.strictEqual(router._service.directPricingReply({
  inboundText: "Is the fitness center open late?", unit,
}), null, "an unrelated question never triggers a rent reply");

console.log("agent property identity proof: passed");
