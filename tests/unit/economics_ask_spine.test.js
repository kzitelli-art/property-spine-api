#!/usr/bin/env node
"use strict";

const assert = require("assert");
const ask = require("../../src/agent/ask_spine_answer.js");
const economics = require("../../src/money/economic_picture.js");

const PROPERTY = "property-skyline";
let passed = 0;

async function proves(label, check) {
  await check();
  passed += 1;
  console.log(`  ok    ${label}`);
}

function type(terms) {
  return {
    unit_type_id: "secret-type-id",
    code: "2BR",
    label: "2 Bedroom",
    offer_state: "offered",
    marketable_positions: 24,
    terms,
  };
}

function picture(typeProjection) {
  return {
    property_id: PROPERTY,
    as_of: "2026-08-20",
    base_rent: {
      economic_class: "base_rent",
      published_version: { version_id: "secret-version-id", effective_from: "2026-08-20" },
      completeness: "governed",
      types: [typeProjection],
    },
    one_time_fees: {
      completeness: "governed", unresolved_reason: null,
      published: [{ id: "secret-fee-id", charge_code: "fee.application", amount: 50,
                    obligation: "required", quotable_precisely: true }],
      drafts: [{ id: "secret-draft-id", charge_code: "fee.administration", amount: 200 }],
    },
    recurring_charges: { completeness: "unresolved", unresolved_reason: "not_established", published: [] },
    deposit_requirements: { completeness: "unresolved", unresolved_reason: "conditional", published: [] },
    advertised_concessions: { completeness: "unresolved", advertised: [] },
    combined_monthly_total: {
      amount: null, withheld: true,
      withheld_because: ["base_rent:lease_term_not_selected"],
    },
    combined_move_in_total: { amount: null, withheld: true, withheld_because: ["deposit_required:unresolved"] },
    contradictions: [],
    missing_determinants: [{ fact_key: "pricing_security_deposit", missing: "amount" }],
    completeness: { overall: "partial", independently_governed: true },
  };
}

function model(spy) {
  return { messages: { async create(request) {
    spy.request = request;
    return { content: [{ type: "text", text: JSON.stringify({
      outcome: "answered",
      answer: "The 10-month term is $825 and the 12-month term is $850. Which term do you want?",
    }) }] };
  } } };
}

function modelFacts(request) {
  return JSON.parse(request.messages[0].content
    .replace(/^QUESTION SUBJECT:[^\n]+\nFACTS:\n/, "")
    .replace(/\n\nOPERATOR ASKED:[\s\S]*$/, ""));
}

async function main() {
  console.log("\nECONOMICS -> ASK SPINE\n");

  await proves("one published term remains directly quotable", async () => {
    const view = economics.typePricingProjection(type([
      { lease_term_months: 12, new_lease_rent: 850, renewal_rent: 850,
        immediate_move_in_rent: null },
    ]));
    assert.strictEqual(view.new_lease_rent, 850);
    assert.strictEqual(view.term_selection, "not_required");
    assert.strictEqual(view.quotable, true);
  });

  const multiTerm = economics.typePricingProjection(type([
    { lease_term_months: 10, new_lease_rent: 825, renewal_rent: 825,
      immediate_move_in_rent: null },
    { lease_term_months: 12, new_lease_rent: 850, renewal_rent: 850,
      immediate_move_in_rent: null },
  ]));

  await proves("multiple terms stay a menu and never flatten to the first rent", async () => {
    assert.strictEqual(multiTerm.new_lease_rent, null);
    assert.strictEqual(multiTerm.renewal_rent, null);
    assert.strictEqual(multiTerm.quotable, false);
    assert.strictEqual(multiTerm.term_selection, "required");
    assert.strictEqual(multiTerm.unresolved_reason, "lease_term_not_selected");
    assert.deepStrictEqual(multiTerm.term_economics.map((term) => term.lease_term_months), [10, 12]);
  });

  await proves("pricing, fee, and lease-price language routes to Economics", async () => {
    assert.strictEqual(ask.questionSubject("What published pricing is in force?"), "economics");
    assert.strictEqual(ask.questionSubject("What is the utility fee?"), "economics");
    assert.strictEqual(ask.questionSubject("What is the application fee?"), "economics");
    assert.strictEqual(ask.questionSubject("What is the lease price for a 2 bedroom?"), "economics");
  });

  await proves("standing questions and real cross-domain questions are not swallowed", async () => {
    assert.notStrictEqual(ask.questionSubject("What is our average in-place rent?"), "economics");
    assert.strictEqual(ask.questionSubject("What is pricing and current occupancy?"),
      "composition_unavailable");
    assert.strictEqual(ask.questionSubject("What is the utility fee and who is the provider?"),
      "composition_unavailable");
  });

  await proves("bare pricing yields to a more specific governed domain", async () => {
    assert.strictEqual(ask.questionSubject("What is the cleaning service pricing?"),
      "contracted_service");
    assert.strictEqual(ask.questionSubject("What is the loan pricing?"), "debt");
  });

  await proves("entitlement is checked before the economic reader runs", async () => {
    let calls = 0;
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["maintenance"], subject: "economics",
      question: "What is published pricing?",
      economicReader: { async effectiveEconomicPicture() { calls += 1; } },
    });
    assert.strictEqual(calls, 0);
    assert.strictEqual(facts.economics, undefined);
  });

  await proves("answer refuses unentitled economics before reader and model", async () => {
    let reads = 0, modelCalls = 0;
    const out = await ask.answer({}, { messages: { async create() { modelCalls += 1; } } }, {
      property_id: PROPERTY, allowed_modules: ["maintenance"],
      question: "What published pricing is in force?",
      economicReader: { async effectiveEconomicPicture() { reads += 1; } },
    });
    assert.strictEqual(out.outcome, "not_authorized");
    assert.strictEqual(reads, 0);
    assert.strictEqual(modelCalls, 0);
  });

  await proves("Ask Spine uses the canonical picture and sends no database ids or drafts", async () => {
    const read = { calls: [], async effectiveEconomicPicture(_db, args) {
      this.calls.push(args);
      return picture(multiTerm);
    } };
    const spy = {};
    const out = await ask.answer({}, model(spy), {
      property_id: PROPERTY, allowed_modules: ["asset_management"],
      question: "What is the asking rent for a 2 bedroom?", economicReader: read,
    });
    const facts = modelFacts(spy.request);
    assert.deepStrictEqual(read.calls, [{ property_id: PROPERTY }]);
    assert.strictEqual(facts.question_subject, "economics");
    assert.strictEqual(facts.economics.base_rent.types[0].term_selection, "required");
    assert.deepStrictEqual(facts.economics.base_rent.types[0].terms, [10, 12]);
    assert.strictEqual(JSON.stringify(facts).includes("secret-"), false);
    assert.strictEqual(JSON.stringify(facts).includes("fee.administration"), false);
    assert.strictEqual(out.grounded_on.economics_read_state, "OK");
    assert.strictEqual(out.grounded_on.economics_monthly_total_withheld, true);
  });

  await proves("a failed economic read is named and never becomes no pricing", async () => {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["leasing"], subject: "economics",
      question: "What is published pricing?",
      economicReader: { async effectiveEconomicPicture() { throw new Error("down"); } },
    });
    assert.strictEqual(facts.economics.read_state, "READ_FAILED");
    assert.deepStrictEqual(facts.reads_that_failed, ["economics"]);
  });

  await proves("the narrator is explicitly forbidden to select or add economics", async () => {
    const prompt = ask.systemPrompt("economics");
    assert.match(prompt, /never choose the first/i);
    assert.match(prompt, /Quote only charges in `published`/);
    assert.match(prompt, /never add it yourself/i);
  });

  await proves("a composition refusal names published pricing as a supported separate read", async () => {
    const out = await ask.answer({}, null, {
      property_id: PROPERTY,
      allowed_modules: ["leasing", "asset_management"],
      question: "What is pricing and current occupancy?",
    });
    assert.strictEqual(out.outcome, "composition_unavailable");
    assert.match(out.answer, /Published Pricing and Charges/);
  });

  console.log(`\n${passed} economics Ask Spine proofs passed.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
