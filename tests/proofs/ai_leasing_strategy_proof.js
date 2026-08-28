"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const strategy = require("../../src/leasing/ai_leasing_strategy");
const validation = require("../../src/leasing/ai_leasing_strategy_behavior_validation");
const evidence = require("../../src/leasing/ai_leasing_strategy_evidence");
const projection = require("../../src/leasing/ai_leasing_strategy_evidence_projection");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.stack || e}`); process.exitCode = 1; }
}
function throwsCode(fn, code) { assert.throws(fn, (e) => e && e.code === code); }

const policies = {
  maya: {
    voice: { tone: "warm and patient", message_length: "brief" },
    operating_moves: {
      default_next_move: "discover_one_preference",
      high_intent_next_move: "confirm_fit_then_offer_tour",
      hesitation_next_move: "lower_commitment",
      tour_offer_gate: "value_delivered",
      follow_up_next_move: "gentle_context_reminder",
      detail_depth: "one_relevant_detail",
      question_rule: "one_open_preference",
    },
    handoff_rule: "Hand off uncertainty.",
  },
  james: {
    voice: { tone: "clear and direct", message_length: "short" },
    operating_moves: {
      default_next_move: "advance_smallest_decision",
      high_intent_next_move: "offer_tour_now",
      hesitation_next_move: "isolate_blocker",
      tour_offer_gate: "clear_intent",
      follow_up_next_move: "single_action_prompt",
      detail_depth: "minimum_to_advance",
      question_rule: "only_blocking_question",
    },
    handoff_rule: "Hand off exceptions.",
  },
  claire: {
    voice: { tone: "calm and structured", message_length: "complete but brief" },
    operating_moves: {
      default_next_move: "resolve_material_questions",
      high_intent_next_move: "confirm_constraints_then_offer_tour",
      hesitation_next_move: "separate_tradeoffs",
      tour_offer_gate: "material_questions_resolved",
      follow_up_next_move: "open_items_summary",
      detail_depth: "structured_complete",
      question_rule: "one_precision_question",
    },
    handoff_rule: "Hand off detail beyond evidence.",
  },
};

function deployment(key, overrides = {}) {
  return {
    deployment_id: `dep-${key}`,
    property_id: "property-a",
    strategy_profile_id: `profile-${key}`,
    strategy_version_id: `version-${key}-2`,
    status: "active",
    traffic_weight: 100,
    eligible_sources: null,
    cohort_key: "website",
    strategy_key: key,
    interface_name: key[0].toUpperCase() + key.slice(1),
    interface_title: "Title",
    description: "Description",
    version_number: 2,
    behavior_policy: policies[key],
    prompt_contract_version: "ai_leasing_strategy_v2",
    version_status: "validated",
    validation_status: "passed",
    validation_matrix: {
      first_response: { status: "passed", model: "ingest-model", prompt_revision: "leasing-first-response-v2" },
      ongoing_reply: { status: "passed", model: "agent-model", prompt_revision: "stage-a-v8" },
      regenerated_reply: { status: "passed", model: "agent-model", prompt_revision: "stage-a-v8" },
    },
    ...overrides,
  };
}

function makeReplay(policy, n = 52, mutate = null) {
  const moves = validation.expectedMovesForPolicy(policy);
  return Array.from({ length: n }, (_, i) => {
    const expected = moves[i % moves.length];
    const row = {
      scenario_id: `scenario-${i + 1}`,
      expected_move: expected,
      actual_move: expected,
      tour_gate_adherent: true,
      detail_depth_adherent: true,
      question_rule_adherent: true,
      unsupported_fact: false,
      safety_violation: false,
      shared_rule_violation: false,
      blind_review_pass: i % 10 !== 0,
    };
    return mutate ? mutate(row, i) || row : row;
  });
}

function evidenceRows({ strategyVersion, total, held, handoffs = 0, optOuts = 0, complaint = null }) {
  return Array.from({ length: total }, (_, i) => ({
    leasing_lead_id: `lead-${strategyVersion}-${i}`,
    conversation_id: `conversation-${Math.floor(i / 2)}`,
    property_id: "property-a",
    cohort_key: "website",
    strategy_version_id: strategyVersion,
    assignment_basis: "weighted_property_deployment_v2",
    assignment_policy_fingerprint: "a".repeat(64),
    analysis_population: "initial_opportunity_assignment_itt_v2",
    as_of: "2026-09-01T00:00:00.000Z",
    observation_window_days: 30,
    qualified: true,
    prospect_replied: i < Math.floor(total * 0.8),
    tour_booked: i < Math.max(held, Math.floor(total * 0.5)),
    tour_held: i < held,
    application_started: null,
    application_submitted: i < Math.floor(held * 0.5),
    lease_signed: null,
    human_handoff: i < handoffs,
    opt_out: i < optOuts,
    complaint,
  }));
}

(async () => {
  await test("V2 policies are structured next-move contracts", () => {
    for (const p of Object.values(policies)) assert(strategy.canonicalPolicy(p).operating_moves);
  });
  await test("old adjective-only flat policy is rejected", () => {
    throwsCode(() => strategy.canonicalPolicy({ tone: "warm" }), "unsupported_strategy_policy_key");
  });
  await test("truth and authority keys remain forbidden", () => {
    throwsCode(() => strategy.canonicalPolicy({ ...policies.maya, pricing: "discount" }), "strategy_crosses_truth_boundary");
  });
  await test("invalid next-move enum is rejected", () => {
    const p = JSON.parse(JSON.stringify(policies.maya));
    p.operating_moves.tour_offer_gate = "always_push_tour";
    throwsCode(() => strategy.canonicalPolicy(p), "invalid_strategy_move");
  });
  await test("three seed strategies differ across every operating move", () => {
    const report = strategy.validateStrategySeparation(Object.entries(policies).map(([strategy_key, behavior_policy]) => ({ strategy_key, behavior_policy })));
    assert.strictEqual(report.passed, true);
    assert(report.pairs.every((p) => p.move_differences === 7));
  });
  await test("critical moves are unique, not cosmetic", () => {
    const report = strategy.validateStrategySeparation(Object.entries(policies).map(([strategy_key, behavior_policy]) => ({ strategy_key, behavior_policy })));
    assert.strictEqual(report.critical_moves_unique, true);
  });
  await test("near-duplicate strategies fail separation", () => {
    const almost = JSON.parse(JSON.stringify(policies.maya));
    almost.voice.tone = "slightly warmer";
    const report = strategy.validateStrategySeparation([
      { strategy_key: "a", behavior_policy: policies.maya },
      { strategy_key: "b", behavior_policy: almost },
    ]);
    assert.strictEqual(report.passed, false);
  });
  await test("directive gives imperative next moves", () => {
    const text = strategy.buildStrategyDirective({ strategy: { behavior: policies.james } });
    assert(text.includes("offer a tour in this turn"));
    assert(text.includes("one direct next action"));
    assert(text.includes("Do not blend this strategy"));
  });
  await test("directive preserves shared truth boundary", () => {
    const text = strategy.buildStrategyDirective({ strategy: { behavior: policies.claire } });
    assert(text.includes("Hard boundary"));
    assert(text.includes("Hand off rather than guess"));
  });
  await test("active deployment requires validated version and passed replay", () => {
    assert.strictEqual(strategy.validateDeploymentSet([deployment("maya")]).length, 1);
    assert.throws(() => strategy.validateDeploymentSet([deployment("maya", { validation_status: "failed" })]));
    assert.throws(() => strategy.validateDeploymentSet([deployment("maya", { version_status: "draft" })]));
  });
  await test("runtime identity must match the validated surface exactly", () => {
    const envelope = strategy.strategyEnvelope(deployment("maya", {
      assignment_event_id: "event-1", leasing_lead_id: "lead-1", conversation_id: "conv-1",
    }));
    assert(strategy.validatedEnvelopeForRuntime(envelope, { surface: "ongoing_reply", model: "agent-model", promptRevision: "stage-a-v8" }));
    assert.strictEqual(strategy.validatedEnvelopeForRuntime(envelope, { surface: "ongoing_reply", model: "new-model", promptRevision: "stage-a-v8" }), null);
    assert.strictEqual(strategy.validatedEnvelopeForRuntime(envelope, { surface: "first_response", model: "ingest-model", promptRevision: "wrong" }), null);
  });
  await test("multi-strategy active deployment rechecks separation", () => {
    assert.strictEqual(strategy.validateDeploymentSet([deployment("maya"), deployment("james"), deployment("claire")]).length, 3);
  });
  await test("weighted selection remains deterministic", () => {
    const rows = [deployment("maya", { traffic_weight: 40 }), deployment("james", { traffic_weight: 60 })];
    assert.strictEqual(strategy.selectWeightedDeployment(rows, "same").strategy_key, strategy.selectWeightedDeployment(rows, "same").strategy_key);
  });
  await test("allocation snapshot is reproducible and opportunity-era versioned", () => {
    const snap = strategy.buildAllocationSnapshot([deployment("maya"), deployment("james")], { source: "Website" });
    assert.strictEqual(snap.assignment_method, "weighted_property_deployment_v2");
    assert.strictEqual(snap.source_context, "website");
    assert.match(strategy.allocationPolicyFingerprint(snap), /^[0-9a-f]{64}$/);
  });

  await test("clean 52-case replay passes", () => {
    const out = validation.summarizeBehaviorReplay({ behaviorPolicy: policies.maya, cases: makeReplay(policies.maya) });
    assert.strictEqual(out.status, "passed");
    assert.strictEqual(out.unsupported_fact_count, 0);
    assert(Object.values(out.expected_move_coverage).every((n) => n > 0));
  });
  await test("fewer than 50 cases cannot validate", () => {
    const out = validation.summarizeBehaviorReplay({ behaviorPolicy: policies.maya, cases: makeReplay(policies.maya, 49) });
    assert.strictEqual(out.status, "failed");
    assert.strictEqual(out.checks.minimum_scenarios, false);
  });
  await test("weak move adherence cannot validate", () => {
    const out = validation.summarizeBehaviorReplay({
      behaviorPolicy: policies.james,
      cases: makeReplay(policies.james, 52, (r, i) => { if (i < 9) r.actual_move = "wrong_move"; return r; }),
    });
    assert.strictEqual(out.status, "failed");
    assert.strictEqual(out.checks.move_adherence, false);
  });
  await test("tour-gate drift fails validation even when next-move labels match", () => {
    const out = validation.summarizeBehaviorReplay({
      behaviorPolicy: policies.james,
      cases: makeReplay(policies.james, 52, (r, i) => { if (i < 6) r.tour_gate_adherent = false; return r; }),
    });
    assert.strictEqual(out.status, "failed");
    assert.strictEqual(out.checks.tour_gate, false);
  });
  await test("one unsupported fact fails validation", () => {
    const out = validation.summarizeBehaviorReplay({
      behaviorPolicy: policies.claire,
      cases: makeReplay(policies.claire, 52, (r, i) => { if (i === 3) r.unsupported_fact = true; return r; }),
    });
    assert.strictEqual(out.status, "failed");
    assert.strictEqual(out.checks.unsupported_facts, false);
  });
  await test("one safety violation fails validation", () => {
    const out = validation.summarizeBehaviorReplay({
      behaviorPolicy: policies.maya,
      cases: makeReplay(policies.maya, 52, (r, i) => { if (i === 1) r.safety_violation = true; return r; }),
    });
    assert.strictEqual(out.status, "failed");
  });
  await test("missing expected-move coverage fails validation", () => {
    const oneMove = validation.expectedMovesForPolicy(policies.maya)[0];
    const rows = makeReplay(policies.maya).map((r) => ({ ...r, expected_move: oneMove, actual_move: oneMove }));
    assert.strictEqual(validation.summarizeBehaviorReplay({ behaviorPolicy: policies.maya, cases: rows }).status, "failed");
  });

  await test("evidence denominator is opportunity id, not conversation id", () => {
    const rows = evidenceRows({ strategyVersion: "maya-v2", total: 40, held: 20 });
    const summary = evidence.summarizeStrategyEvidence(rows);
    assert.strictEqual(summary.qualified_leads, 40);
    assert(new Set(rows.map((r) => r.conversation_id)).size < 40);
  });
  await test("duplicate opportunity is rejected even with different conversation", () => {
    const rows = evidenceRows({ strategyVersion: "maya-v2", total: 2, held: 1 });
    rows[1].leasing_lead_id = rows[0].leasing_lead_id;
    rows[1].conversation_id = "different";
    throwsCode(() => evidence.summarizeStrategyEvidence(rows), "duplicate_opportunity_evidence");
  });
  await test("unsupported outcomes remain null with zero observed denominator", () => {
    const summary = evidence.summarizeStrategyEvidence(evidenceRows({ strategyVersion: "maya-v2", total: 40, held: 20 }));
    assert.strictEqual(summary.rates.application_started, null);
    assert.strictEqual(summary.observed_denominators.application_started, 0);
    assert(summary.unsupported_metrics.includes("lease_signed"));
  });
  await test("held-tour comparison can produce review-only signal", () => {
    const a = evidence.summarizeStrategyEvidence(evidenceRows({ strategyVersion: "maya-v2", total: 120, held: 75, handoffs: 3, optOuts: 1 }));
    const b = evidence.summarizeStrategyEvidence(evidenceRows({ strategyVersion: "james-v2", total: 120, held: 35, handoffs: 3, optOuts: 1 }));
    const out = evidence.compareStrategyEvidence(a, b);
    assert.strictEqual(out.status, "directional_signal_for_review");
    assert.strictEqual(out.automatic_reallocation_allowed, false);
    assert(out.guardrails.missing_optional.includes("complaint"));
  });
  await test("required guardrail regression blocks a better primary metric", () => {
    const a = evidence.summarizeStrategyEvidence(evidenceRows({ strategyVersion: "maya-v2", total: 120, held: 75, handoffs: 20, optOuts: 1 }));
    const b = evidence.summarizeStrategyEvidence(evidenceRows({ strategyVersion: "james-v2", total: 120, held: 35, handoffs: 2, optOuts: 1 }));
    assert.strictEqual(evidence.compareStrategyEvidence(a, b).status, "guardrail_blocked");
  });
  await test("unsupported primary outcome cannot produce a winner", () => {
    const a = evidence.summarizeStrategyEvidence(evidenceRows({ strategyVersion: "maya-v2", total: 120, held: 75 }));
    const b = evidence.summarizeStrategyEvidence(evidenceRows({ strategyVersion: "james-v2", total: 120, held: 35 }));
    assert.strictEqual(evidence.compareStrategyEvidence(a, b, { primaryMetric: "lease_signed" }).status, "unsupported_metric");
  });
  await test("different observation windows are not comparable", () => {
    const ar = evidenceRows({ strategyVersion: "maya-v2", total: 40, held: 20 });
    const br = evidenceRows({ strategyVersion: "james-v2", total: 40, held: 10 });
    br.forEach((r) => { r.observation_window_days = 45; });
    assert.strictEqual(evidence.compareStrategyEvidence(evidence.summarizeStrategyEvidence(ar), evidence.summarizeStrategyEvidence(br)).status, "not_comparable");
  });

  await test("projection requires confirmed delivered exposure", () => {
    assert(projection.CANONICAL_EVIDENCE_SQL.includes("provider_status, ce.sms_status"));
    assert(projection.CANONICAL_EVIDENCE_SQL.includes("= 'delivered'"));
    assert(projection.CANONICAL_EVIDENCE_SQL.includes("no_delivered_strategy_exposure"));
  });
  await test("projection starts from initial opportunity assignment", () => {
    assert(projection.CANONICAL_EVIDENCE_SQL.includes("distinct on (e.leasing_lead_id)"));
    assert(projection.CANONICAL_EVIDENCE_SQL.includes("e.event_type = 'assigned'"));
  });
  await test("projection excludes non-production records", () => {
    assert(projection.CANONICAL_EVIDENCE_SQL.includes("record_class is distinct from 'production'"));
  });
  await test("application outcomes require direct leasing lead linkage", () => {
    assert(projection.CANONICAL_EVIDENCE_SQL.includes("la.leasing_lead_id"));
    assert(!projection.CANONICAL_EVIDENCE_SQL.includes("la.person_id ="));
  });
  await test("projection marks unsupported outcomes honestly", () => {
    const row = projection.rowToEvidence({
      leasing_lead_id: "lead-1", conversation_id: "conv-1", property_id: "property-a",
      cohort_key: "website", strategy_version_id: "maya-v2",
      assignment_basis: "weighted_property_deployment_v2", assignment_policy_fingerprint: "a".repeat(64),
      qualified: true, first_delivered_at: "2026-07-01T00:00:00Z",
      prospect_replied_at: null, tour_booked_at: null, tour_held_at: null,
      application_submitted_at: null, human_handoff_at: null, opt_out_at: null,
    }, { asOf: "2026-09-01T00:00:00.000Z", observationWindowDays: 30 });
    assert.strictEqual(row.application_started, null);
    assert.strictEqual(row.lease_signed, null);
    assert.strictEqual(row.complaint, null);
  });

  const migration = fs.readFileSync(path.join(__dirname, "../../migrations/120_ai_leasing_strategy_foundation.sql"), "utf8");
  await test("migration activates no property", () => {
    assert(!/insert\s+into\s+property_ai_leasing_strategy_deployments/i.test(migration));
  });
  await test("seed versions remain draft until replay passes", () => {
    assert(migration.includes("'ai_leasing_strategy_v2', 'draft'"));
    assert(migration.includes("require_validated_ai_strategy_deployment"));
  });
  await test("passed replay is structurally strict", () => {
    for (const text of ["scenario_count >= 50", "move_adherence_rate >= 0.85", "tour_gate_adherence_rate >= 0.90", "detail_adherence_rate >= 0.90", "question_rule_adherence_rate >= 0.90", "unsupported_fact_count = 0", "safety_violation_count = 0", "shared_rule_violation_count = 0"]) assert(migration.includes(text));
  });
  await test("deployment gate requires all three generation surfaces", () => {
    assert(migration.includes("count(distinct generation_surface)"));
    assert(migration.includes("('first_response','ongoing_reply','regenerated_reply')"));
  });
  await test("assignment rows are opportunity scoped", () => {
    assert(migration.includes("leasing_lead_id               uuid not null"));
    assert(migration.includes("unique (leasing_lead_id, event_sequence)"));
    assert(migration.includes("references leasing_leads(id, property_id, person_id)"));
  });
  await test("application lineage is direct and nullable for history", () => {
    assert(migration.includes("alter table lease_applications add column if not exists leasing_lead_id uuid"));
    assert(migration.includes("fk_lease_application_leasing_lead"));
  });
  await test("message attribution pins opportunity and strategy", () => {
    assert(migration.includes("ai_leasing_message_attributions"));
    assert(migration.includes("leasing_lead_id       uuid not null"));
  });

  console.log(`\n${passed} hardened foundation checks passed.`);
  if (process.exitCode) process.exit(process.exitCode);
})();
