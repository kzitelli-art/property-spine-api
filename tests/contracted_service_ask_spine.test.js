"use strict";

const assert = require("assert");
const ask = require("../src/agent/ask_spine_answer.js");

const PROPERTY = "property-a";
let passed = 0;
async function ok(label, check) {
  await check();
  passed += 1;
  console.log(`  ok    ${label}`);
}

function governedReader(overrides = {}) {
  return {
    detailRequest() { return { mode: "service_detail" }; },
    async readForQuestion(_db, input) {
      if (overrides.error) throw overrides.error;
      if (overrides.spy) overrides.spy.input = input;
      return {
        mode: "service_detail",
        read_state: "READ_SUCCEEDED",
        attention_state: "ATTENTION_REQUIRED",
        standing: {
          contract_version: "contracted_service.v1",
          setup_state: "partially_established",
          engagement_count: 1,
          governed_engagement_count: 1,
          unmatched_document_count: 0,
          unmatched_financial_observation_count: 1,
          unresolved_count: 1,
        },
        detail: {
          engagements: [{ label: "Elevator maintenance", provider: "Fujitec",
            payment: { truth_state: "NOT_ESTABLISHED" } }],
        },
        references: [{ label: "Elevator agreement evidence", module: "asset_management",
          open: { kind: "contracted_service_evidence", id: "artifact-secret" } }],
      };
    },
  };
}

function model(answerText, spy = {}) {
  return { messages: { async create(request) {
    spy.request = request;
    return { content: [{ type: "text", text: JSON.stringify({
      outcome: "answered", answer: answerText,
    }) }] };
  } } };
}

async function main() {
  console.log("\nCONTRACTED SERVICES ASK SPINE\n");

  await ok("service-contract language selects only Contracted Services", async () => {
    assert.strictEqual(ask.questionSubject("Who handles our elevator service contract?"),
      "contracted_service");
    assert.strictEqual(ask.questionSubject("Who handles the elevator repair work order?"), "work");
  });

  await ok("cross-domain questions preserve the composition refusal", async () => {
    assert.strictEqual(ask.questionSubject(
      "Is the elevator service contract current and is the inspection compliant?"),
    "composition_unavailable");
  });

  await ok("no Asset Management entitlement means no governed read", async () => {
    let called = false;
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: [], subject: "contracted_service",
      question: "Who is the elevator vendor?",
      contractedServiceReader: { detailRequest() { return { mode: "standing" }; },
        async readForQuestion() { called = true; } },
    });
    assert.strictEqual(called, false);
    assert.strictEqual(facts.contracted_service, undefined);
  });

  await ok("the canonical reader receives server-derived scope and the exact question", async () => {
    const spy = {};
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"],
      subject: "contracted_service", question: "Who handles elevator service?",
      contractedServiceReader: governedReader({ spy }),
    });
    assert.strictEqual(spy.input.property_id, PROPERTY);
    assert.deepStrictEqual(spy.input.allowed_modules, ["asset_management"]);
    assert.strictEqual(spy.input.question, "Who handles elevator service?");
    assert.strictEqual(facts.contracted_service.read_state, "READ_SUCCEEDED");
    assert.strictEqual(facts.__refs[0].open.kind, "contracted_service_evidence");
  });

  await ok("a failed read is named and never shaped as empty service truth", async () => {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"],
      subject: "contracted_service", question: "Who handles cleaning?",
      contractedServiceReader: governedReader({ error: new Error("database down") }),
    });
    assert.strictEqual(facts.contracted_service.read_state, "READ_FAILED");
    assert.deepStrictEqual(facts.reads_that_failed, ["contracted_service"]);
    assert.strictEqual(facts.contracted_service.setup_state, undefined);
  });

  await ok("a timed-out read remains distinct from no agreements", async () => {
    const error = new Error("bounded read timed out"); error.code = "READ_TIMED_OUT";
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"],
      subject: "contracted_service", question: "When is the renewal?",
      contractedServiceReader: governedReader({ error }),
    });
    assert.strictEqual(facts.contracted_service.read_state, "READ_TIMED_OUT");
    assert.deepStrictEqual(facts.reads_that_failed, ["contracted_service_timed_out"]);
  });

  await ok("the composer grounds the answer and keeps database ids away from the model", async () => {
    const spy = {};
    const result = await ask.answer({}, model(
      "Fujitec is the recorded elevator provider. Payment is not established.", spy), {
      property_id: PROPERTY, allowed_modules: ["asset_management"],
      question: "Who handles our elevator service contract?",
      contractedServiceReader: governedReader(),
    });
    assert.strictEqual(result.outcome, "answered");
    assert.strictEqual(result.grounded_on.contracted_service_setup_state,
      "partially_established");
    assert.strictEqual(result.references[0].open.kind, "contracted_service_evidence");
    assert(!spy.request.messages[0].content.includes("artifact-secret"));
    assert(/invoice is not a contract price/i.test(spy.request.system));
    assert(/comparison and causal explanation are unavailable/i.test(spy.request.system));
  });

  await ok("unauthorized Contracted Services questions reach neither reader nor model", async () => {
    let read = false, composed = false;
    const result = await ask.answer({}, { messages: { async create() { composed = true; } } }, {
      property_id: PROPERTY, allowed_modules: [],
      question: "Who is our contracted cleaning provider?",
      contractedServiceReader: { async readForQuestion() { read = true; } },
    });
    assert.strictEqual(result.outcome, "not_authorized");
    assert.strictEqual(read, false);
    assert.strictEqual(composed, false);
    assert(/Contracted Services/.test(result.answer));
  });

  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
