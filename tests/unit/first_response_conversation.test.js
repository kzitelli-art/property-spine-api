"use strict";

// The opening reply is a prospect-facing surface. This small unit witness
// makes sure the first model turn receives the actual question and the same
// current descriptive shelf Ask Spine reads, instead of only a generic tour
// prompt. No database, provider or transport is touched.
const assert = require("node:assert/strict");
const leasingLeadsModule = require("../../src/leasing/leasing_leads.js");

async function run() {
  let captured = null;
  const pool = {
    query: async (sql) => {
      if (/agent_facts/i.test(sql)) {
        return { rows: [
          { fact_key: "amenities", rendered_text: "The fitness center is open 24/7." },
          { fact_key: "neighborhood", rendered_text: "Fresh Grocer is a short walk away." },
          { fact_key: "leasing_highlights", rendered_text: "Apartments are furnished." },
        ] };
      }
      return { rows: [] };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release() {} }),
  };
  const anthropic = {
    messages: {
      create: async (input) => {
        captured = input;
        return { content: [{ type: "text", text: "Yes, the fitness center is open 24/7. Want to see it?" }] };
      },
    },
  };
  const router = leasingLeadsModule({
    pool,
    anthropic,
    INGEST_MODEL: "test-model",
    sms: { enabled: () => false, sendSms: async () => ({ sid: null }) },
    leasingLifecycle: { assertNotSoftClosedForLead: async () => {} },
    conversionServices: {},
    commBoundary: { reclassify: async () => {}, sendPropertySms: async () => ({ sent: false }) },
  });

  const out = await router.__test__.draftFirstResponse({
    name: "Alex Prospect",
    propertyName: "Skyline",
    propertyId: "property-test",
    inquiryText: "Does this building have a gym?",
    rent: null,
    unitLabel: null,
    slots: [],
  });

  assert.equal(out.body, "Yes, the fitness center is open 24/7. Want to see it?");
  assert.ok(captured, "the model receives the opening turn");
  assert.match(captured.messages[0].content, /Does this building have a gym\?/i);
  assert.match(captured.messages[0].content, /fitness center is open 24\/7/i);
  assert.doesNotMatch(captured.messages[0].content, /Fresh Grocer/i,
    "an amenities question does not receive an unrelated neighborhood card");
  assert.doesNotMatch(captured.messages[0].content, /Apartments are furnished/i,
    "recognized questions do not receive the generic highlights card");
  assert.match(captured.messages[0].content, /Answer their actual question first/i);
  const overlong = "x".repeat(321);
  anthropic.messages.create = async () => ({ content: [{ type: "text", text: overlong }] });
  const guarded = await router.__test__.draftFirstResponse({
    name: "Alex Prospect", propertyName: "Skyline", propertyId: "property-test",
    inquiryText: "What is the rent?", pricingGuidance: "The current published price needs the leasing team to confirm the lease term.",
    rent: null, unitLabel: "Unit 2B", slots: [],
  });
  assert.equal(guarded.body,
    "Hi Alex! The current published price needs the leasing team to confirm the lease term.",
    "an overlong model answer falls back to the governed answer-first pricing sentence");
  anthropic.messages.create = async () => ({ content: [{ type: "text", text: "Pennsylvania law requires the deposit back within 30 days." }] });
  const legal = await router.__test__.draftFirstResponse({
    name: "Alex Prospect", propertyName: "Skyline", propertyId: "property-test",
    inquiryText: "When do I get my deposit back?", rent: null, unitLabel: null, slots: [],
  });
  assert.match(legal.body, /specific to local law and the lease/i,
    "the website opener uses the same local-law floor as the ongoing conversation");
  assert.equal(legal.operatingContextApplied, false,
    "a blocked model answer is not recorded as applied operating context");
  anthropic.messages.create = async () => ({ content: [{ type: "text", text: "The fee is $75–99 depending on the plan." }] });
  const range = await router.__test__.draftFirstResponse({
    name: "Alex Prospect", propertyName: "Skyline", propertyId: "property-test",
    inquiryText: "What is the fee range?", rent: null, unitLabel: null, slots: [],
  });
  assert.match(range.body, /\$75 to 99/,
    "the shared prospect formatter preserves a sourced numeric range");
  anthropic.messages.create = async () => { throw new Error("model offline"); };
  const priced = await router.__test__.draftFirstResponse({
    name: "Alex Prospect", propertyName: "Skyline", propertyId: "property-test",
    inquiryText: "Tell me about Unit 2B", rent: 1025, unitLabel: "Unit 2B", slots: [],
  });
  assert.match(priced.body, /is priced at \$1025/i);
  assert.doesNotMatch(priced.body, /available/i,
    "a unit binding and governed price do not establish availability");
  const source = require("node:fs").readFileSync(require.resolve("../../src/leasing/leasing_leads.js"), "utf8");
  assert.doesNotMatch(source, /select unit_number, market_rent/i,
    "the prospect opener never reads legacy unit market_rent");
  console.log("PASS first prospect response receives question and approved property knowledge");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
