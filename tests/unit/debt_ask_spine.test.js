"use strict";

const assert = require("assert");
const ask = require("../../src/agent/ask_spine_answer.js");
const canonicalRead = require("../../src/asset/debt_position_read.js");

const PROPERTY = "property-debt";
const INSTRUMENT = "instrument-secret";
let passed = 0;

async function ok(label, check) {
  await check();
  passed += 1;
  console.log(`  ok    ${label}`);
}

function reading(asOf) {
  return {
    as_of: asOf,
    instrument: {
      id: INSTRUMENT,
      instrument_kind: "mortgage_loan",
      loan_number: "ending-0465",
    },
    principal_position: {
      observed: { value_cents: 2774526577, as_of_date: "2025-08-01", stale: true },
      projected: { value_cents: 2713187412, as_of_date: "2026-08-01",
        basis: "schedule_derivation", assumes: "every scheduled payment occurred" },
    },
    payoff: { truth_state: canonicalRead.NOT_ESTABLISHED },
    rate_position: { kind: "fixed", effective_rate_bp: 328 },
    debt_service: { principal_and_interest_cents: 12341140,
      excludes: ["escrow", "reserve_funding"] },
    payment_standing: { truth_state: canonicalRead.NOT_ESTABLISHED },
    contractual_maturity: { date: "2030-08-01" },
    extension: { truth_state: canonicalRead.NOT_ESTABLISHED },
    reserve_requirements: [{ reserve_kind: "tax_escrow", funds_obligation_of: "borrower" }],
    covenant_standing: { truth_state: canonicalRead.NOT_ESTABLISHED },
    important_unknowns: ["payoff amount not established", "payment standing not established"],
    next_requirement: { due_date: "2026-09-01", total_debt_service_cents: 12341140,
      basis: "schedule_derivation" },
  };
}

function debtService(overrides = {}) {
  return {
    async listInstrumentsForProperty(_db, propertyId) {
      if (overrides.error) throw overrides.error;
      if (overrides.spy) overrides.spy.propertyId = propertyId;
      return overrides.ids === undefined ? [INSTRUMENT] : overrides.ids;
    },
    async loadHistory(_db, instrumentId) {
      if (overrides.spy) overrides.spy.instrumentId = instrumentId;
      return { instrument: { id: instrumentId } };
    },
  };
}

function debtRead() {
  return {
    NOT_ESTABLISHED: canonicalRead.NOT_ESTABLISHED,
    position(_history, asOf) { return reading(asOf); },
    standingProjection: canonicalRead.standingProjection,
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
  console.log("\nDEBT ASK SPINE\n");

  await ok("Debt language selects Debt without swallowing unrelated work", async () => {
    assert.strictEqual(ask.questionSubject("What is the mortgage balance and maturity date?"), "debt");
    assert.strictEqual(ask.questionSubject("Who is the lender on this loan?"), "debt");
    assert.strictEqual(ask.questionSubject("Who has the open repair?"), "work");
  });

  await ok("a cross-domain capital question preserves the composition refusal", async () => {
    assert.strictEqual(ask.questionSubject(
      "What are the mortgage balance and preferred equity terms?"), "composition_unavailable");
  });

  await ok("no Asset Management entitlement means no Debt read", async () => {
    let called = false;
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: [], subject: "debt",
      debtService: { async listInstrumentsForProperty() { called = true; } },
      debtRead: debtRead(),
    });
    assert.strictEqual(called, false);
    assert.strictEqual(facts.debt, undefined);
  });

  await ok("the canonical reader receives only the server-derived property", async () => {
    const spy = {};
    await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "debt",
      debtService: debtService({ spy }), debtRead: debtRead(),
    });
    assert.strictEqual(spy.propertyId, PROPERTY);
    assert.strictEqual(spy.instrumentId, INSTRUMENT);
  });

  await ok("zero instruments is an honest established read of absence in Spine", async () => {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "debt",
      debtService: debtService({ ids: [] }), debtRead: debtRead(),
    });
    assert.strictEqual(facts.debt.read_state, "OK");
    assert.strictEqual(facts.debt.instrument_count, 0);
    assert.strictEqual(facts.debt.standing.truth_state, canonicalRead.NOT_ESTABLISHED);
  });

  await ok("a failed Debt read stays distinct from no Debt established", async () => {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "debt",
      debtService: debtService({ error: new Error("database down") }), debtRead: debtRead(),
    });
    assert.strictEqual(facts.debt.read_state, "READ_FAILED");
    assert.deepStrictEqual(facts.reads_that_failed, ["debt"]);
    assert.strictEqual(facts.debt.standing, undefined);
  });

  await ok("the compact projection preserves Debt walls without database ids", async () => {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "debt",
      debtService: debtService(), debtRead: debtRead(),
    });
    const blob = JSON.stringify(facts.debt);
    assert.strictEqual(facts.debt.instruments[0].current_position.payoff.truth_state,
      canonicalRead.NOT_ESTABLISHED);
    assert.strictEqual(facts.debt.instruments[0].next_milestone.basis, "schedule_derivation");
    assert.strictEqual(facts.debt.instruments[0].important_unknowns.length, 2);
    assert(!blob.includes(INSTRUMENT));
  });

  await ok("the answer is grounded and the prompt carries the Debt truth walls", async () => {
    const spy = {};
    const result = await ask.answer({}, model("The last observed principal is stale.", spy), {
      property_id: PROPERTY, allowed_modules: ["asset_management"],
      question: "What is the mortgage balance and maturity date?",
      debtService: debtService(), debtRead: debtRead(),
    });
    assert.strictEqual(result.outcome, "answered");
    assert.strictEqual(result.grounded_on.debt_instrument_count, 1);
    assert.strictEqual(result.grounded_on.debt_read_state, "OK");
    assert.strictEqual(result.grounded_on.debt_important_unknown_count, 2);
    assert(!spy.request.messages[0].content.includes(INSTRUMENT));
    assert(/lender-observed principal is not a payoff quote/i.test(spy.request.system));
    assert(/scheduled payment is not proof it was paid/i.test(spy.request.system));
    assert(/contractual maturity is not an exercised extension/i.test(spy.request.system));
  });

  await ok("unauthorized Debt questions reach neither reader nor model", async () => {
    let read = false;
    let composed = false;
    const result = await ask.answer({}, { messages: { async create() { composed = true; } } }, {
      property_id: PROPERTY, allowed_modules: [], question: "Who is the lender on this loan?",
      debtService: { async listInstrumentsForProperty() { read = true; } }, debtRead: debtRead(),
    });
    assert.strictEqual(result.outcome, "not_authorized");
    assert.strictEqual(read, false);
    assert.strictEqual(composed, false);
  });

  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
