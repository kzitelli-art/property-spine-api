"use strict";

const assert = require("assert");
const ask = require("../../src/agent/ask_spine_answer.js");

let pass = 0;
function ok(label, fn) {
  fn(); pass += 1;
  console.log(`  ok    ${label}`);
}

const PROPERTY = "property-a";
const TABLE_ROWS = {
  utility_services: [
    { id: "service-electric-secret", property_id: PROPERTY,
      service_class: "electricity", service_label: null },
  ],
  utility_service_declarations: [
    { id: "declaration-secret", property_id: PROPERTY,
      service_id: "service-electric-secret", applicability: "present",
      effective_from: "2026-01-01", source_artifact_id: "artifact-a" },
  ],
  utility_providers: [
    { id: "provider-secret", property_id: PROPERTY, provider_name: "PECO Energy" },
  ],
  utility_service_providers: [
    { id: "service-provider-secret", property_id: PROPERTY,
      service_id: "service-electric-secret", provider_id: "provider-secret",
      effective_from: "2026-01-01", source_artifact_id: "artifact-a" },
  ],
  utility_arrangements: [
    { id: "arrangement-secret", property_id: PROPERTY,
      service_id: "service-electric-secret", effective_from: "2026-01-01",
      physical_arrangement: "whole_building_master_meter",
      provider_bill_recipient: "property", provider_responsible_party: "property",
      economic_responsibility: "property", resident_recovery_method: "rubs_allocation",
      billing_administrator_name: "Conservice",
      resident_payment_recipient: "billing_administrator",
      source_artifact_id: "artifact-a" },
  ],
  utility_provider_accounts: [
    { id: "account-db-secret", property_id: PROPERTY, provider_id: "provider-secret",
      external_account_identifier: "PECO-123456789", effective_from: "2026-01-01",
      source_artifact_id: "artifact-a" },
  ],
  utility_account_services: [
    { id: "account-service-secret", property_id: PROPERTY,
      account_id: "account-db-secret", service_id: "service-electric-secret",
      effective_from: "2026-01-01" },
  ],
  utility_service_points: [
    { id: "point-secret", property_id: PROPERTY, service_id: "service-electric-secret",
      point_kind: "whole_building", location_label: "Building", effective_from: "2026-01-01" },
  ],
  utility_meters: [
    { id: "meter-db-secret", property_id: PROPERTY, provider_id: "provider-secret",
      meter_kind: "provider_meter", meter_identifier: "METER-998877",
      effective_from: "2026-01-01" },
  ],
  utility_meter_service_points: [
    { id: "meter-point-secret", property_id: PROPERTY, meter_id: "meter-db-secret",
      service_point_id: "point-secret", effective_from: "2026-01-01" },
  ],
  utility_account_service_points: [
    { id: "account-point-secret", property_id: PROPERTY, account_id: "account-db-secret",
      service_point_id: "point-secret", effective_from: "2026-01-01" },
  ],
  utility_account_meters: [
    { id: "account-meter-secret", property_id: PROPERTY, account_id: "account-db-secret",
      meter_id: "meter-db-secret", effective_from: "2026-01-01" },
  ],
  utility_statements: [
    { id: "statement-db-secret", property_id: PROPERTY, account_id: "account-db-secret",
      statement_identifier: "BILL-PRIVATE-777", bill_date: "2026-08-01",
      service_period_start: "2026-07-01", service_period_end: "2026-07-31",
      due_date: "2026-08-20", currency_code: "USD", amount_billed_cents: 1844217,
      current_amount_due_cents: 1844217, late_fee_cents: 0,
      source_artifact_id: "artifact-a", recorded_at: "2026-08-02T00:00:00Z" },
  ],
  utility_statement_usage: [
    { id: "usage-secret", property_id: PROPERTY, statement_id: "statement-db-secret",
      account_id: "account-db-secret", service_id: "service-electric-secret",
      meter_id: "meter-db-secret", quantity: 123456, usage_unit: "kWh",
      usage_basis: "observed", source_artifact_id: "artifact-a" },
  ],
};

function database({ failUtility = false, timeoutUtility = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push({ text, params });
      const match = text.match(/from\s+(utility_[a-z_]+)/i);
      if (match) {
        if (timeoutUtility) {
          const error = new Error("Utility read exceeded its bound");
          error.code = "READ_TIMED_OUT";
          throw error;
        }
        if (failUtility) throw new Error("Utility read unavailable");
        return { rows: TABLE_ROWS[match[1]] || [] };
      }
      return { rows: [] };
    },
  };
}

function model(answerText, spy) {
  return {
    messages: {
      async create(request) {
        spy.request = request;
        return { content: [{ type: "text", text: JSON.stringify({
          outcome: "answered", answer: answerText,
        }) }] };
      },
    },
  };
}

function factsFrom(spy) {
  return JSON.parse(spy.request.messages[0].content
    .replace(/^QUESTION SUBJECT:[^\n]+\nFACTS:\n/, "")
    .replace(/\n\nOPERATOR ASKED:[\s\S]*$/, ""));
}

async function main() {
  console.log("\nUTILITY ASK SPINE - CONVERSATIONAL TRUTH PROOFS\n");

  const noEntitlementDb = database();
  const noEntitlement = await ask.gatherFacts(noEntitlementDb, {
    property_id: PROPERTY, allowed_modules: ["maintenance"], subject: "utility",
  });
  ok("unentitled operators do not receive a Utility fact key", () => {
    assert.strictEqual(noEntitlement.utility, undefined);
  });
  ok("unentitled operators never cause a Utility table read", () => {
    assert(!noEntitlementDb.queries.some((query) => /from\s+utility_/i.test(query.text)));
  });

  const entitledDb = database();
  const gathered = await ask.gatherFacts(entitledDb, {
    property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "utility",
  });
  ok("entitled Utility facts come from every property-scoped canonical read", () => {
    const utilityQueries = entitledDb.queries.filter((query) => /from\s+utility_/i.test(query.text));
    assert.strictEqual(utilityQueries.length, Object.keys(TABLE_ROWS).length);
    assert(utilityQueries.every((query) => /property_id\s*=\s*\$1/i.test(query.text)
      && query.params[0] === PROPERTY));
  });
  ok("gas remains NOT_ESTABLISHED in the conversational standing facts", () => {
    assert(gathered.utility.unresolved_services > 0);
    const gas = gathered.utility.services.find((service) => service.service_class === "natural_gas");
    assert.strictEqual(gas.applicability.truth_state, "NOT_ESTABLISHED");
  });
  ok("broad questions keep the conversational Utility read on standing", () => {
    assert.strictEqual(gathered.utility.detail_mode, "standing");
    assert.strictEqual(gathered.utility.detail, null);
    assert.strictEqual(gathered.utility.read_state, "READ_SUCCEEDED");
  });
  ok("provider, billing administrator, and recovery remain separate", () => {
    const electric = gathered.utility.services.find((service) => service.service_class === "electricity");
    assert.deepStrictEqual(electric.providers, ["PECO Energy"]);
    assert.strictEqual(electric.billing_administrator_name, "Conservice");
    assert.strictEqual(electric.resident_recovery_method, "rubs_allocation");
  });
  ok("a statement and RUBS still leave provider payment NOT_ESTABLISHED", () => {
    const electric = gathered.utility.services.find((service) => service.service_class === "electricity");
    assert.strictEqual(electric.provider_payment.truth_state, "NOT_ESTABLISHED");
  });
  ok("sensitive account and meter identifiers do not enter standing model context", () => {
    const serialized = JSON.stringify(gathered.utility);
    assert(!serialized.includes("PECO-123456789"));
    assert(!serialized.includes("METER-998877"));
  });

  const spy = {};
  const answer = await ask.answer(database(), model(
    "PECO provides electricity. Residents are billed through a RUBS arrangement administered by Conservice. The July statement is recorded, but provider payment is not established. Gas remains unknown.",
    spy), {
    property_id: PROPERTY,
    allowed_modules: ["asset_management"],
    question: "Who provides electricity, how are residents billed, and has the provider been paid? Do we have gas?",
  });
  const modelFacts = factsFrom(spy);
  ok("a governed Utility question is answered in the existing Ask Spine composer", () => {
    assert.strictEqual(answer.outcome, "answered");
    assert(/payment is not established/i.test(answer.answer));
    assert(/Gas remains unknown/i.test(answer.answer));
  });
  ok("database and external statement identifiers never enter model context", () => {
    const content = spy.request.messages[0].content;
    for (const secret of [
      "account-db-secret", "meter-db-secret", "statement-db-secret", "arrangement-secret",
      "artifact-a", "BILL-PRIVATE-777", "PECO-123456789", "METER-998877",
    ]) assert(!content.includes(secret), secret);
  });
  ok("the model receives explicit payment and recovery walls", () => {
    const electric = modelFacts.utility.services.find((service) => service.service_class === "electricity");
    assert.strictEqual(electric.provider_payment.truth_state, "NOT_ESTABLISHED");
    assert.strictEqual(electric.resident_recovery_method, "rubs_allocation");
    assert(/statement is not a provider payment/i.test(spy.request.system));
  });
  ok("the model is explicitly forbidden from causal Utility stories", () => {
    assert(/Do not invent weather, occupancy, rates, leaks/i.test(spy.request.system));
    assert(/cause is not\s+established/i.test(spy.request.system));
  });
  ok("Utility evidence references are server-resolved outside model context", () => {
    assert(answer.references.some((reference) => reference.open.kind === "utility_evidence"
      && reference.open.id === "artifact-a"));
    assert(!spy.request.messages[0].content.includes("artifact-a"));
  });
  ok("grounding names the Utility setup used for the answer", () => {
    assert.strictEqual(answer.grounded_on.utility_setup_state, "partially_established");
    assert.strictEqual(answer.grounded_on.utility_services, 1);
    assert.strictEqual(answer.grounded_on.utility_read_state, "READ_SUCCEEDED");
  });

  const detailSpy = {};
  await ask.answer(database(), model(
    "Account ending 6789 serves the Building and has provider meter ending 8877.", detailSpy), {
    property_id: PROPERTY,
    allowed_modules: ["asset_management"],
    question: "What does account ending 6789 serve?",
  });
  const detailFacts = factsFrom(detailSpy);
  ok("an account-specific question receives bounded governed detail", () => {
    assert.strictEqual(detailFacts.utility.detail_mode, "account_detail");
    assert.strictEqual(detailFacts.utility.detail.selector.account_ending, "6789");
    assert.strictEqual(detailFacts.utility.detail.accounts.length, 1);
    assert.strictEqual(detailFacts.utility.detail.accounts[0].reference, "UTILITY-ACCOUNT-1");
  });
  ok("governed detail gives the model masked identifiers and no database IDs", () => {
    const content = detailSpy.request.messages[0].content;
    assert(content.includes("*****6789"));
    assert(!content.includes("PECO-123456789"));
    for (const secret of ["account-db-secret", "meter-db-secret", "statement-db-secret"])
      assert(!content.includes(secret), secret);
  });

  const failedSpy = {};
  await ask.answer(database({ failUtility: true }), model(
    "I could not read the Utility position, so I cannot report it as empty.", failedSpy), {
    property_id: PROPERTY,
    allowed_modules: ["asset_management"],
    question: "How do utilities work here?",
  });
  const failedFacts = factsFrom(failedSpy);
  ok("a failed Utility read is named and never becomes an empty position", () => {
    assert(failedFacts.reads_that_failed.includes("utility"));
    assert.strictEqual(failedFacts.utility.read_state, "READ_FAILED");
    assert.strictEqual(failedFacts.utility.detail, null);
  });

  const timeoutSpy = {};
  await ask.answer(database({ timeoutUtility: true }), model(
    "The Utility read timed out, so I cannot report an empty account roster.", timeoutSpy), {
    property_id: PROPERTY,
    allowed_modules: ["asset_management"],
    question: "How many PECO accounts do we have?",
  });
  const timeoutFacts = factsFrom(timeoutSpy);
  ok("a timed-out Utility detail read remains distinct from no accounts", () => {
    assert.strictEqual(timeoutFacts.utility.read_state, "READ_TIMED_OUT");
    assert(timeoutFacts.reads_that_failed.includes("utility_timed_out"));
    assert.strictEqual(timeoutFacts.utility.detail, null);
  });
  ok("the composer teaches the model all four silence meanings", () => {
    assert(/READ_FAILED means Spine could not read it/i.test(timeoutSpy.request.system));
    assert(/READ_TIMED_OUT/.test(timeoutSpy.request.system));
    assert(/QUIET means the read succeeded/i.test(timeoutSpy.request.system));
    assert(/NOT_ESTABLISHED exactly as unknown/i.test(timeoutSpy.request.system));
  });

  const causeSpy = {};
  const cause = await ask.answer(database(), model(
    "The recorded statement is $18,442.17. Spine has no governed causal fact explaining a change, so the cause is not established.", causeSpy), {
    property_id: PROPERTY,
    allowed_modules: ["asset_management"],
    question: "Why did electric expense increase?",
  });
  ok("a causal question can retrieve the statement without inventing a cause", () => {
    assert.strictEqual(cause.outcome, "answered");
    assert(/cause is not established/i.test(cause.answer));
  });

  console.log(`\n${pass} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
