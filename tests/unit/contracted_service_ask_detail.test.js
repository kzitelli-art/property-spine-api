"use strict";

const assert = require("assert");
const positionRead = require("../../src/asset/contracted_service_position_read.js");
const ask = require("../../src/asset/contracted_service_ask_detail.js");

let passed = 0;
async function ok(label, fn) {
  await fn(); passed += 1; console.log(`  ok    ${label}`);
}

const position = {
  standing: {
    contract_version: "contracted_service.v1", as_of: "2026-08-14",
    setup_state: "partially_established", coverage_review: { reviewed_as_of: "2026-08-01" },
    requirement_count: 2, engagement_count: 2, governed_engagement_count: 1,
    attention_count: 1, unmatched_financial_observation_count: 0,
    next_milestone: { engagement_id: "engagement-elevator", label: "Elevator maintenance",
      milestone: { kind: "notice_decision", date: "2026-10-03" } },
    engagements: [
      { id: "engagement-elevator", service_class: "elevator_maintenance",
        label: "Elevator maintenance", provider: { id: "provider-a", name: "Fujitec" },
        execution_standing: "EXECUTED_GOVERNING", term_state: "ATTENTION",
        source_artifact_id: "artifact-a" },
      { id: "engagement-cleaning", service_class: "building_cleaning",
        label: "Building cleaning", provider: { id: "provider-b", name: "Angel Cleaning" },
        execution_standing: "OFFERED_OR_UNSIGNED", term_state: "NOT_ESTABLISHED" },
    ],
    unresolved_count: 2, unresolved: [], does_not_establish: [], capabilities: {},
  },
  detail: {
    engagements: [
      {
        id: "engagement-elevator", service_class: "elevator_maintenance",
        label: "Elevator maintenance", provider: { id: "provider-a", name: "Fujitec" },
        execution_standing: "EXECUTED_GOVERNING",
        term_standing: {
          state: "ATTENTION", milestone: { kind: "notice_decision", date: "2026-10-03" },
          accountable_owner: { user_id: "user-a", label: "Pat Operator" },
          current: { id: "term-a", prices: [{ id: "price-a", basis: "monthly",
            amount_cents: 15000, source_artifact_id: "artifact-a" }] },
        },
        scope: { id: "scope-a", summary: "Quarterly elevator service" },
        financial_observations: [{ id: "obs-a", kind: "accounting_line", amount_cents: 180000 }],
        payment: { truth_state: "NOT_ESTABLISHED" },
        service_completion: { truth_state: "NOT_ESTABLISHED" },
      },
      {
        id: "engagement-cleaning", service_class: "building_cleaning",
        label: "Building cleaning", provider: { id: "provider-b", name: "Angel Cleaning" },
        execution_standing: "OFFERED_OR_UNSIGNED",
        term_standing: { state: "NOT_ESTABLISHED", current: null },
        scope: null, financial_observations: [],
        payment: { truth_state: "NOT_ESTABLISHED" },
        service_completion: { truth_state: "NOT_ESTABLISHED" },
      },
    ],
    unmatched_financial_observations: [], unresolved: [],
  },
};

async function main() {
  const original = positionRead.readPosition;
  positionRead.readPosition = async () => position;
  try {
    console.log("\nCONTRACTED SERVICES ASK DETAIL - QUESTION-BOUND READS\n");

    await ok("service questions return only the named service", async () => {
      const result = await ask.readForQuestion({}, {
        property_id: "property-a", allowed_modules: ["asset_management"],
        question: "Who handles the elevator and what is covered?",
      });
      assert.strictEqual(result.mode, "service_detail");
      assert.strictEqual(result.detail.engagements.length, 1);
      assert.strictEqual(result.detail.engagements[0].provider, "Fujitec");
      assert(!JSON.stringify(result).includes("engagement-elevator"));
    });

    await ok("renewal questions expose the governed milestone and owner", async () => {
      const result = await ask.readForQuestion({}, {
        property_id: "property-a", allowed_modules: ["asset_management"],
        question: "When is the elevator renewal decision due?",
      });
      assert.strictEqual(result.mode, "milestone_detail");
      assert.strictEqual(result.detail.engagements[0].term_standing.milestone.date, "2026-10-03");
      assert.strictEqual(result.detail.engagements[0].term_standing.accountable_owner.label,
        "Pat Operator");
    });

    await ok("cost questions keep price, observation, and payment separate", async () => {
      const result = await ask.readForQuestion({}, {
        property_id: "property-a", allowed_modules: ["asset_management"],
        question: "What does elevator service cost and was it paid?",
      });
      const row = result.detail.engagements[0];
      assert.strictEqual(row.governing_price_components[0].amount_cents, 15000);
      assert.strictEqual(row.financial_observations[0].amount_cents, 180000);
      assert.strictEqual(row.payment.truth_state, "NOT_ESTABLISHED");
      assert(/distinct facts/i.test(result.detail.truth_wall));
    });

    await ok("comparison is refused until its normalization basis is governed", async () => {
      const result = await ask.readForQuestion({}, {
        property_id: "property-a", allowed_modules: ["asset_management"],
        question: "Is cleaning more expensive than the other buildings?",
      });
      assert.strictEqual(result.read_state, "CAPABILITY_NOT_ESTABLISHED");
      assert.strictEqual(result.detail.capability, "comparison");
      assert.strictEqual(result.detail.claimed, false);
    });

    await ok("causal cost explanations are not invented", async () => {
      const result = await ask.readForQuestion({}, {
        property_id: "property-a", allowed_modules: ["asset_management"],
        question: "Why did snow removal expense increase?",
      });
      assert.strictEqual(result.read_state, "CAPABILITY_NOT_ESTABLISHED");
      assert.strictEqual(result.detail.capability, "causal_explanation");
    });

    await ok("module entitlement is enforced before reading", async () => {
      const result = await ask.readForQuestion({}, {
        property_id: "property-a", allowed_modules: [], question: "Who cleans the building?",
      });
      assert.strictEqual(result.read_state, "NOT_ENTITLED");
    });
  } finally {
    positionRead.readPosition = original;
  }
  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
