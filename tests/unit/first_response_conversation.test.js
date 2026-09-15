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
        return { rows: [{ fact_key: "amenities", rendered_text: "The fitness center is open 24/7." }] };
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
  assert.match(captured.messages[0].content, /Answer their actual question first/i);
  console.log("PASS first prospect response receives question and approved property knowledge");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
