// ════════════════════════════════════════════════════════════════════
// AI LEASING STRATEGY — opportunity assignment, prompt contract, attribution
//
// Owns only:
//   • which validated strategy version is assigned to one leasing opportunity
//   • the sealed next-move contract injected into the existing leasing AI
//   • exact attribution of outbound AI messages to that version
//   • explicit, attributed strategy handoff history
//
// It does NOT own property facts, pricing, availability, authority,
// commitments, compliance, identity, delivery, tours, applications, leases,
// or conversation lifecycle. Those remain canonical facts elsewhere.
// ════════════════════════════════════════════════════════════════════
"use strict";

const crypto = require("crypto");

const VOICE_KEYS = Object.freeze(["tone", "message_length"]);
const MOVE_KEYS = Object.freeze([
  "default_next_move",
  "high_intent_next_move",
  "hesitation_next_move",
  "tour_offer_gate",
  "follow_up_next_move",
  "detail_depth",
  "question_rule",
]);

const MOVE_ENUMS = Object.freeze({
  default_next_move: Object.freeze([
    "discover_one_preference",
    "advance_smallest_decision",
    "resolve_material_questions",
  ]),
  high_intent_next_move: Object.freeze([
    "confirm_fit_then_offer_tour",
    "offer_tour_now",
    "confirm_constraints_then_offer_tour",
  ]),
  hesitation_next_move: Object.freeze([
    "lower_commitment",
    "isolate_blocker",
    "separate_tradeoffs",
  ]),
  tour_offer_gate: Object.freeze([
    "value_delivered",
    "clear_intent",
    "material_questions_resolved",
  ]),
  follow_up_next_move: Object.freeze([
    "gentle_context_reminder",
    "single_action_prompt",
    "open_items_summary",
  ]),
  detail_depth: Object.freeze([
    "one_relevant_detail",
    "minimum_to_advance",
    "structured_complete",
  ]),
  question_rule: Object.freeze([
    "one_open_preference",
    "only_blocking_question",
    "one_precision_question",
  ]),
});

const FORBIDDEN_POLICY_KEYS = Object.freeze([
  "price", "pricing", "rent", "availability", "facts", "authority",
  "permissions", "commitments", "compliance", "delivery", "property_id",
  "personal_history", "lived_experience",
]);

const SEALED_BOUNDARIES = Object.freeze([
  "property_facts", "pricing", "availability", "authority", "commitments",
  "compliance", "identity", "delivery",
]);

function strategyError(code, message, httpStatus = 409) {
  const err = new Error(message);
  err.code = code;
  err.httpStatus = httpStatus;
  err.publicMessage = message;
  return err;
}

function normalizeSource(source) {
  if (source == null) return null;
  const value = String(source).trim().toLowerCase();
  return value || null;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function canonicalPolicy(raw) {
  const policy = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!policy) throw strategyError("invalid_strategy_policy", "The AI leasing strategy is unavailable.", 500);

  for (const key of FORBIDDEN_POLICY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(policy, key)) {
      throw strategyError(
        "strategy_crosses_truth_boundary",
        "An AI leasing strategy cannot alter property truth or authority.",
        500
      );
    }
  }
  const allowedTop = new Set(["voice", "operating_moves", "handoff_rule"]);
  for (const key of Object.keys(policy)) {
    if (!allowedTop.has(key)) {
      throw strategyError("unsupported_strategy_policy_key", `Unsupported strategy policy key ${key}.`, 500);
    }
  }

  const voice = policy.voice && typeof policy.voice === "object" && !Array.isArray(policy.voice)
    ? policy.voice : null;
  const moves = policy.operating_moves && typeof policy.operating_moves === "object" && !Array.isArray(policy.operating_moves)
    ? policy.operating_moves : null;
  if (!voice || !moves) {
    throw strategyError("incomplete_strategy_policy", "Strategy voice and operating moves are required.", 500);
  }
  for (const key of VOICE_KEYS) {
    if (typeof voice[key] !== "string" || !voice[key].trim()) {
      throw strategyError("incomplete_strategy_voice", `Strategy voice is missing ${key}.`, 500);
    }
  }
  for (const key of Object.keys(voice)) {
    if (!VOICE_KEYS.includes(key)) {
      throw strategyError("unsupported_strategy_voice_key", `Unsupported strategy voice key ${key}.`, 500);
    }
  }
  for (const key of MOVE_KEYS) {
    const value = moves[key];
    if (!MOVE_ENUMS[key].includes(value)) {
      throw strategyError("invalid_strategy_move", `Strategy move ${key} is invalid.`, 500);
    }
  }
  for (const key of Object.keys(moves)) {
    if (!MOVE_KEYS.includes(key)) {
      throw strategyError("unsupported_strategy_move_key", `Unsupported strategy move key ${key}.`, 500);
    }
  }
  if (typeof policy.handoff_rule !== "string" || !policy.handoff_rule.trim()) {
    throw strategyError("incomplete_strategy_handoff", "Strategy handoff rule is required.", 500);
  }

  return Object.freeze({
    voice: Object.freeze({
      tone: voice.tone.trim(),
      message_length: voice.message_length.trim(),
    }),
    operating_moves: Object.freeze(Object.fromEntries(MOVE_KEYS.map((key) => [key, moves[key]]))),
    handoff_rule: policy.handoff_rule.trim(),
  });
}

function moveDifferenceCount(a, b) {
  const pa = canonicalPolicy(a).operating_moves;
  const pb = canonicalPolicy(b).operating_moves;
  return MOVE_KEYS.reduce((n, key) => n + (pa[key] === pb[key] ? 0 : 1), 0);
}

function validateStrategySeparation(policies, { minimumMoveDifferences = 5 } = {}) {
  if (!Array.isArray(policies) || policies.length < 2) {
    throw strategyError("strategy_set_required", "At least two strategies are required for separation proof.", 400);
  }
  const normalized = policies.map((item) => ({
    strategy_key: String(item.strategy_key || "").trim(),
    policy: canonicalPolicy(item.behavior_policy),
  }));
  if (normalized.some((item) => !item.strategy_key)) {
    throw strategyError("strategy_key_required", "Each strategy needs a stable key.", 400);
  }

  const pairs = [];
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const differences = moveDifferenceCount(normalized[i].policy, normalized[j].policy);
      pairs.push({
        a: normalized[i].strategy_key,
        b: normalized[j].strategy_key,
        move_differences: differences,
        passed: differences >= minimumMoveDifferences,
      });
    }
  }
  const uniqueCritical = ["default_next_move", "tour_offer_gate", "follow_up_next_move"]
    .every((key) => new Set(normalized.map((item) => item.policy.operating_moves[key])).size === normalized.length);
  return Object.freeze({
    passed: pairs.every((pair) => pair.passed) && uniqueCritical,
    minimum_move_differences: minimumMoveDifferences,
    critical_moves_unique: uniqueCritical,
    pairs: Object.freeze(pairs.map(Object.freeze)),
  });
}

function moveLabel(code) {
  const labels = {
    discover_one_preference: "answer, then ask one open preference question",
    advance_smallest_decision: "answer, then advance the smallest concrete decision",
    resolve_material_questions: "answer, then resolve the material unanswered questions",
    confirm_fit_then_offer_tour: "when intent is strong, confirm fit before offering a tour",
    offer_tour_now: "when intent is strong, offer a tour in this turn",
    confirm_constraints_then_offer_tour: "when intent is strong, confirm constraints before offering a tour",
    lower_commitment: "when the prospect hesitates, lower the commitment required",
    isolate_blocker: "when the prospect hesitates, identify and answer the single blocker",
    separate_tradeoffs: "when the prospect hesitates, separate facts, tradeoffs, and unknowns",
    value_delivered: "offer a tour only after useful value has been delivered or the prospect asks",
    clear_intent: "offer a tour when clear intent exists or the prospect asks",
    material_questions_resolved: "offer a tour only after material questions are resolved or the prospect asks",
    gentle_context_reminder: "follow up with a gentle reminder grounded in prior context",
    single_action_prompt: "follow up with one direct next action",
    open_items_summary: "follow up by summarizing open items and the next useful step",
    one_relevant_detail: "include one relevant detail beyond the direct answer",
    minimum_to_advance: "include only the detail needed to advance the decision",
    structured_complete: "give a structured complete answer without becoming verbose",
    one_open_preference: "ask no more than one open preference question",
    only_blocking_question: "ask only the one question blocking advancement",
    one_precision_question: "ask no more than one precision question",
  };
  return labels[code] || code;
}

function buildAllocationSnapshot(rows, { source = null } = {}) {
  const candidates = [...rows]
    .map((row) => ({
      deployment_id: String(row.deployment_id),
      strategy_version_id: String(row.strategy_version_id),
      traffic_weight: Number(row.traffic_weight),
    }))
    .sort((a, b) => a.deployment_id.localeCompare(b.deployment_id));
  const cohortKeys = [...new Set(rows.map((row) => String(row.cohort_key)))];
  if (cohortKeys.length !== 1) {
    throw strategyError("mixed_allocation_cohorts", "Eligible strategies must share one evidence cohort.", 500);
  }
  return Object.freeze({
    assignment_method: "weighted_property_deployment_v2",
    cohort_key: cohortKeys[0],
    source_context: normalizeSource(source),
    candidates: Object.freeze(candidates.map(Object.freeze)),
  });
}

function allocationPolicyFingerprint(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw strategyError("allocation_snapshot_required", "AI leasing allocation evidence is unavailable.", 500);
  }
  return sha256Text(JSON.stringify(snapshot));
}

function deploymentEligibleForSource(row, source) {
  const eligible = Array.isArray(row.eligible_sources)
    ? row.eligible_sources.map(normalizeSource).filter(Boolean)
    : null;
  if (!eligible || eligible.length === 0) return true;
  const normalized = normalizeSource(source);
  return normalized != null && eligible.includes(normalized);
}

function validateDeploymentSet(rows, source = null) {
  if (!Array.isArray(rows)) {
    throw strategyError("invalid_strategy_deployments", "AI leasing strategy configuration is unavailable.", 500);
  }
  const seenProfiles = new Set();
  const eligible = [];
  for (const row of rows) {
    if (!row || row.status !== "active") continue;
    if (!row.deployment_id || !row.strategy_profile_id || !row.strategy_version_id || !row.strategy_key || !row.cohort_key) {
      throw strategyError("invalid_strategy_deployment", "An active strategy deployment is incomplete.", 500);
    }
    if (row.version_status !== "validated" || row.validation_status !== "passed") {
      throw strategyError("unvalidated_strategy_deployment", "An active strategy lacks passed behavioral validation.", 500);
    }
    const matrix = row.validation_matrix;
    if (!matrix || !["first_response", "ongoing_reply", "regenerated_reply"].every((surface) => matrix[surface] && matrix[surface].status === "passed")) {
      throw strategyError("incomplete_strategy_validation_matrix", "Every generation surface must have a passed validation artifact.", 500);
    }
    if (seenProfiles.has(row.strategy_profile_id)) {
      throw strategyError("overlapping_strategy_versions", "More than one active version exists for a strategy.", 500);
    }
    seenProfiles.add(row.strategy_profile_id);
    const weight = Number(row.traffic_weight);
    if (!Number.isInteger(weight) || weight <= 0) {
      throw strategyError("invalid_strategy_weight", "An active strategy must have a positive traffic weight.", 500);
    }
    const policy = canonicalPolicy(row.behavior_policy);
    if (!deploymentEligibleForSource(row, source)) continue;
    eligible.push(Object.freeze({ ...row, traffic_weight: weight, behavior_policy: policy }));
  }
  const cohortKeys = [...new Set(eligible.map((row) => String(row.cohort_key)))];
  if (cohortKeys.length > 1) {
    throw strategyError("mixed_allocation_cohorts", "Eligible strategies must share one evidence cohort.", 500);
  }
  if (eligible.length > 1) {
    const separation = validateStrategySeparation(eligible.map((row) => ({
      strategy_key: row.strategy_key,
      behavior_policy: row.behavior_policy,
    })));
    if (!separation.passed) {
      throw strategyError("strategies_not_operationally_distinct", "Active strategies are not operationally distinct enough to compare.", 500);
    }
  }
  return Object.freeze(eligible);
}

function deterministicPoint(seed, totalWeight) {
  if (!Number.isInteger(totalWeight) || totalWeight <= 0) {
    throw strategyError("invalid_strategy_weight_total", "AI leasing assignment has no eligible traffic weight.", 500);
  }
  const digest = crypto.createHash("sha256").update(String(seed)).digest();
  return digest.readUInt32BE(0) % totalWeight;
}

function selectWeightedDeployment(rows, seed) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + Number(row.traffic_weight || 0), 0);
  let point = deterministicPoint(seed, total);
  for (const row of rows) {
    if (point < row.traffic_weight) return row;
    point -= row.traffic_weight;
  }
  throw strategyError("strategy_selection_failed", "AI leasing assignment could not be resolved.", 500);
}

function strategyEnvelope(row) {
  if (!row) return null;
  const policy = canonicalPolicy(row.behavior_policy);
  return Object.freeze({
    assignment_event_id: row.assignment_event_id || null,
    leasing_lead_id: row.leasing_lead_id || null,
    conversation_id: row.conversation_id || null,
    deployment_id: row.deployment_id || null,
    assignment_policy_fingerprint: row.assignment_policy_fingerprint || null,
    validation_matrix: row.validation_matrix && typeof row.validation_matrix === "object" ? Object.freeze(row.validation_matrix) : null,
    strategy: Object.freeze({
      key: row.strategy_key,
      interface_name: row.interface_name,
      interface_title: row.interface_title,
      version: Number(row.version_number),
      version_id: row.strategy_version_id,
      prompt_contract_version: row.prompt_contract_version,
      behavior: policy,
    }),
    cohort_key: row.cohort_key || null,
    assignment_basis: row.assignment_basis || null,
    sealed_boundaries: SEALED_BOUNDARIES,
  });
}

function validatedEnvelopeForRuntime(envelope, { surface, model, promptRevision }) {
  if (!envelope) return null;
  if (!["first_response", "ongoing_reply", "regenerated_reply"].includes(surface)) {
    throw strategyError("invalid_generation_surface", "Generation surface is invalid.", 500);
  }
  const entry = envelope.validation_matrix && envelope.validation_matrix[surface];
  if (!entry || entry.status !== "passed") return null;
  if (String(entry.model) !== String(model) || String(entry.prompt_revision) !== String(promptRevision)) return null;
  return envelope;
}

function buildStrategyDirective(envelope) {
  if (!envelope || !envelope.strategy) {
    throw strategyError("strategy_envelope_required", "The AI leasing strategy is unavailable.", 500);
  }
  const policy = canonicalPolicy(envelope.strategy.behavior);
  const m = policy.operating_moves;
  return [
    "COMMUNICATION STRATEGY — a next-move contract, not a personality costume:",
    "Every safety, fair-housing, truth, tour-authority, no-promise, and formatting rule outranks this contract.",
    `Voice: ${policy.voice.tone}; ${policy.voice.message_length}.`,
    `Default move: ${moveLabel(m.default_next_move)}.`,
    `Clear-intent move: ${moveLabel(m.high_intent_next_move)}.`,
    `Hesitation move: ${moveLabel(m.hesitation_next_move)}.`,
    `Tour gate: ${moveLabel(m.tour_offer_gate)}.`,
    `Follow-up move: ${moveLabel(m.follow_up_next_move)}.`,
    `Detail rule: ${moveLabel(m.detail_depth)}.`,
    `Question rule: ${moveLabel(m.question_rule)}.`,
    `Handoff rule: ${policy.handoff_rule}`,
    "Do not blend this strategy with another strategy. Choose the move that fits this turn and keep the message brief.",
    "Hard boundary: use only canonical Property Spine facts and authority. Hand off rather than guess.",
  ].join("\n");
}

async function loadActiveDeployments(client, { propertyId, source = null }) {
  if (!client || typeof client.query !== "function") throw new TypeError("loadActiveDeployments requires a database client");
  if (!propertyId) throw strategyError("property_required", "Property scope is required.", 400);
  const result = await client.query(
    `select d.id as deployment_id, d.property_id,
            d.strategy_profile_id, d.strategy_version_id,
            d.status, d.traffic_weight, d.eligible_sources, d.cohort_key,
            p.strategy_key, p.interface_name, p.interface_title, p.description,
            v.version_number, v.behavior_policy, v.prompt_contract_version,
            v.status as version_status,
            vr.validation_status, vr.validation_matrix
       from property_ai_leasing_strategy_deployments d
       join ai_leasing_strategy_profiles p
         on p.id = d.strategy_profile_id and p.status = 'active'
       join ai_leasing_strategy_versions v
         on v.id = d.strategy_version_id
        and v.strategy_profile_id = d.strategy_profile_id
       join lateral (
         select case when count(*) = 3 and bool_and(latest.status = 'passed')
                     then 'passed' else 'failed' end as validation_status,
                jsonb_object_agg(latest.generation_surface, jsonb_build_object(
                  'validation_run_id', latest.id,
                  'status', latest.status,
                  'model', latest.model,
                  'prompt_revision', latest.prompt_revision
                )) as validation_matrix
           from (
             select distinct on (generation_surface)
                    id, generation_surface, status, model, prompt_revision
               from ai_leasing_strategy_validation_runs
              where strategy_version_id = v.id
              order by generation_surface, completed_at desc, id desc
           ) latest
       ) vr on true
      where d.property_id = $1 and d.status = 'active'
      order by p.strategy_key asc`,
    [propertyId]
  );
  return validateDeploymentSet(result.rows, source);
}

async function lockOpportunityContext(client, { conversationId, leasingLeadId, propertyId }) {
  const row = (await client.query(
    `select c.id as conversation_id, c.property_id, c.person_id,
            l.id as leasing_lead_id, l.status as leasing_lead_status
       from conversations c
       join leasing_leads l
         on l.id = $2
        and l.property_id = c.property_id
        and l.person_id = c.person_id
      where c.id = $1
      for update of c, l`,
    [conversationId, leasingLeadId]
  )).rows[0];
  if (!row) throw strategyError("opportunity_context_not_found", "Conversation and leasing opportunity do not match.", 404);
  if (String(row.property_id) !== String(propertyId)) {
    throw strategyError("opportunity_out_of_scope", "That leasing opportunity is not in this property.", 403);
  }
  return row;
}

async function currentAssignment(client, { leasingLeadId }) {
  return (await client.query(
    `select c.assignment_event_id, c.leasing_lead_id, c.conversation_id,
            c.person_id, c.property_id, c.deployment_id,
            c.strategy_profile_id, c.strategy_version_id,
            c.assignment_basis, c.assignment_policy_fingerprint,
            c.source_context, c.cohort_key, c.assigned_at,
            p.strategy_key, p.interface_name, p.interface_title, p.description,
            v.version_number, v.behavior_policy, v.prompt_contract_version
       from leasing_lead_ai_strategy_current c
       join ai_leasing_strategy_profiles p on p.id = c.strategy_profile_id
       join ai_leasing_strategy_versions v on v.id = c.strategy_version_id
      where c.leasing_lead_id = $1`,
    [leasingLeadId]
  )).rows[0] || null;
}

async function loadConversationStrategyEnvelope(client, { conversationId, leasingLeadId, propertyId }) {
  if (!client || typeof client.query !== "function") throw new TypeError("loadConversationStrategyEnvelope requires a database client");
  if (!conversationId || !leasingLeadId || !propertyId) {
    throw strategyError("strategy_scope_required", "Conversation, leasing opportunity, and property are required.", 400);
  }
  await lockOpportunityContext(client, { conversationId, leasingLeadId, propertyId });
  const assignment = await currentAssignment(client, { leasingLeadId });
  if (!assignment) return null;
  if (String(assignment.conversation_id) !== String(conversationId)) {
    throw strategyError("strategy_assignment_conversation_mismatch", "The opportunity strategy belongs to a different conversation.", 409);
  }
  return strategyEnvelope(assignment);
}

async function nextEventSequence(client, leasingLeadId) {
  const row = (await client.query(
    `select coalesce(max(event_sequence), 0)::int + 1 as next_sequence
       from conversation_ai_leasing_strategy_events
      where leasing_lead_id = $1`,
    [leasingLeadId]
  )).rows[0];
  return Number(row.next_sequence);
}

async function assignConversationStrategy(client, {
  conversationId,
  leasingLeadId,
  propertyId,
  source = null,
  assignmentKey = null,
  actorUserId = null,
}) {
  if (!client || typeof client.query !== "function") throw new TypeError("assignConversationStrategy requires a database client");
  if (!conversationId || !leasingLeadId || !propertyId) {
    throw strategyError("assignment_scope_required", "Conversation, leasing opportunity, and property are required.", 400);
  }
  const ctx = await lockOpportunityContext(client, { conversationId, leasingLeadId, propertyId });
  const existing = await currentAssignment(client, { leasingLeadId });
  if (existing) {
    if (String(existing.conversation_id) !== String(conversationId)) {
      throw strategyError("opportunity_already_assigned_elsewhere", "That leasing opportunity is already assigned in another conversation.", 409);
    }
    return { assigned: true, created: false, assignment: existing, envelope: strategyEnvelope(existing) };
  }

  const deployments = await loadActiveDeployments(client, { propertyId, source });
  if (deployments.length === 0) return { assigned: false, created: false, reason: "no_active_strategy_deployment" };

  const seed = assignmentKey || `${propertyId}:${leasingLeadId}`;
  const selected = selectWeightedDeployment(deployments, seed);
  const allocationSnapshot = buildAllocationSnapshot(deployments, { source });
  const fingerprint = allocationPolicyFingerprint(allocationSnapshot);
  const sequence = await nextEventSequence(client, leasingLeadId);
  const idempotencyKey = `initial:${leasingLeadId}`;
  const inserted = (await client.query(
    `insert into conversation_ai_leasing_strategy_events
       (conversation_id, leasing_lead_id, person_id, property_id,
        event_sequence, event_type, deployment_id,
        strategy_profile_id, strategy_version_id,
        assignment_basis, assignment_key_hash, allocation_snapshot,
        assignment_policy_fingerprint, source_context, cohort_key,
        actor_user_id, idempotency_key)
     values ($1,$2,$3,$4,$5,'assigned',$6,$7,$8,
             'weighted_property_deployment_v2',$9,$10::jsonb,$11,$12,$13,$14,$15)
     on conflict (leasing_lead_id, idempotency_key) do nothing
     returning id`,
    [
      conversationId, leasingLeadId, ctx.person_id, propertyId, sequence,
      selected.deployment_id, selected.strategy_profile_id, selected.strategy_version_id,
      sha256Text(seed), JSON.stringify(allocationSnapshot), fingerprint,
      normalizeSource(source), selected.cohort_key, actorUserId, idempotencyKey,
    ]
  )).rows[0];
  const assignment = await currentAssignment(client, { leasingLeadId });
  if (!assignment) throw strategyError("assignment_not_recorded", "AI leasing strategy assignment was not recorded.", 500);
  return { assigned: true, created: !!inserted, assignment, envelope: strategyEnvelope(assignment) };
}

async function handoffConversationStrategy(client, {
  conversationId,
  leasingLeadId,
  propertyId,
  targetStrategyVersionId,
  reason,
  actorUserId,
  idempotencyKey,
}) {
  if (!client || typeof client.query !== "function") throw new TypeError("handoffConversationStrategy requires a database client");
  if (!conversationId || !leasingLeadId || !propertyId || !targetStrategyVersionId) {
    throw strategyError("handoff_scope_required", "Conversation, opportunity, property, and target strategy are required.", 400);
  }
  if (!reason || !String(reason).trim()) throw strategyError("handoff_reason_required", "State why the strategy is changing.", 400);
  if (!actorUserId) throw strategyError("handoff_actor_required", "A signed-in operator must authorize the handoff.", 403);
  if (!idempotencyKey || !String(idempotencyKey).trim()) throw strategyError("handoff_idempotency_required", "A handoff idempotency key is required.", 400);

  const ctx = await lockOpportunityContext(client, { conversationId, leasingLeadId, propertyId });
  const current = await currentAssignment(client, { leasingLeadId });
  if (!current) throw strategyError("no_current_strategy", "This opportunity has no strategy to hand off.", 409);
  if (String(current.strategy_version_id) === String(targetStrategyVersionId)) {
    return { changed: false, assignment: current, envelope: strategyEnvelope(current) };
  }

  const target = (await client.query(
    `select d.id as deployment_id, d.property_id,
            d.strategy_profile_id, d.strategy_version_id,
            d.status, d.traffic_weight, d.eligible_sources, d.cohort_key,
            p.strategy_key, p.interface_name, p.interface_title, p.description,
            v.version_number, v.behavior_policy, v.prompt_contract_version,
            v.status as version_status,
            vr.validation_status, vr.validation_matrix
       from property_ai_leasing_strategy_deployments d
       join ai_leasing_strategy_profiles p on p.id = d.strategy_profile_id and p.status = 'active'
       join ai_leasing_strategy_versions v on v.id = d.strategy_version_id and v.strategy_profile_id = d.strategy_profile_id
       join lateral (
         select case when count(*) = 3 and bool_and(latest.status = 'passed')
                     then 'passed' else 'failed' end as validation_status,
                jsonb_object_agg(latest.generation_surface, jsonb_build_object(
                  'validation_run_id', latest.id, 'status', latest.status,
                  'model', latest.model, 'prompt_revision', latest.prompt_revision
                )) as validation_matrix
           from (
             select distinct on (generation_surface) id, generation_surface, status, model, prompt_revision
               from ai_leasing_strategy_validation_runs
              where strategy_version_id = v.id
              order by generation_surface, completed_at desc, id desc
           ) latest
       ) vr on true
      where d.property_id = $1 and d.strategy_version_id = $2 and d.status = 'active'`,
    [propertyId, targetStrategyVersionId]
  )).rows[0];
  if (!target || target.version_status !== "validated" || target.validation_status !== "passed") {
    throw strategyError("target_strategy_not_deployed", "That validated strategy is not active at this property.", 409);
  }
  canonicalPolicy(target.behavior_policy);
  const sequence = await nextEventSequence(client, leasingLeadId);
  const fingerprint = sha256Text(`explicit_operator_handoff_v2:${propertyId}:${target.deployment_id}`);
  await client.query(
    `insert into conversation_ai_leasing_strategy_events
       (conversation_id, leasing_lead_id, person_id, property_id,
        event_sequence, event_type, deployment_id,
        strategy_profile_id, strategy_version_id,
        previous_strategy_profile_id, previous_strategy_version_id,
        assignment_basis, assignment_policy_fingerprint,
        source_context, cohort_key, reason, actor_user_id, idempotency_key)
     values ($1,$2,$3,$4,$5,'handed_off',$6,$7,$8,$9,$10,
             'explicit_operator_handoff',$11,$12,$13,$14,$15,$16)
     on conflict (leasing_lead_id, idempotency_key) do nothing`,
    [
      conversationId, leasingLeadId, ctx.person_id, propertyId, sequence,
      target.deployment_id, target.strategy_profile_id, target.strategy_version_id,
      current.strategy_profile_id, current.strategy_version_id,
      fingerprint, current.source_context, current.cohort_key,
      String(reason).trim(), actorUserId, String(idempotencyKey).trim(),
    ]
  );
  const assignment = await currentAssignment(client, { leasingLeadId });
  if (!assignment) throw strategyError("handoff_not_recorded", "Strategy handoff was not recorded.", 500);
  return {
    changed: String(assignment.strategy_version_id) !== String(current.strategy_version_id),
    assignment,
    envelope: strategyEnvelope(assignment),
  };
}

async function recordAiMessageAttribution(client, {
  commEventId,
  conversationId,
  leasingLeadId,
  propertyId,
  assignmentEventId,
  agentRunId = null,
  authorshipScope = "full_message",
  humanModified = false,
  authoredAt,
}) {
  if (!client || typeof client.query !== "function") throw new TypeError("recordAiMessageAttribution requires a database client");
  if (!commEventId || !conversationId || !leasingLeadId || !propertyId || !assignmentEventId || !authoredAt) {
    throw strategyError("message_attribution_required", "Message, conversation, opportunity, property, assignment, and authored time are required.", 400);
  }
  if (!["full_message", "ai_draft_source"].includes(authorshipScope)) {
    throw strategyError("invalid_authorship_scope", "AI message authorship scope is invalid.", 400);
  }
  if ((authorshipScope === "ai_draft_source") !== (humanModified === true)) {
    throw strategyError("authorship_scope_mismatch", "Human-modified messages must be attributed only to their AI draft source.", 400);
  }

  const event = (await client.query(
    `select id, conversation_id, leasing_lead_id, property_id, event_type,
            strategy_profile_id, strategy_version_id
       from conversation_ai_leasing_strategy_events where id = $1`,
    [assignmentEventId]
  )).rows[0];
  if (!event || !["assigned", "handed_off"].includes(event.event_type)) {
    throw strategyError("assignment_event_not_found", "The message strategy assignment is unavailable.", 409);
  }
  if (
    String(event.conversation_id) !== String(conversationId) ||
    String(event.leasing_lead_id) !== String(leasingLeadId) ||
    String(event.property_id) !== String(propertyId)
  ) {
    throw strategyError("assignment_event_out_of_scope", "The message assignment is not in this opportunity.", 403);
  }

  const message = (await client.query(
    `select id, conversation_id, property_id, direction, sender_role, occurred_at
       from comm_events where id = $1`,
    [commEventId]
  )).rows[0];
  if (!message) throw strategyError("comm_event_not_found", "Communication record not found.", 404);
  if (String(message.conversation_id) !== String(conversationId) || String(message.property_id) !== String(propertyId)) {
    throw strategyError("comm_event_out_of_scope", "That communication is not in this conversation.", 403);
  }
  if (message.direction !== "outbound") throw strategyError("comm_event_not_outbound", "Only outbound communications may carry strategy attribution.", 409);

  if (agentRunId) {
    const run = (await client.query(
      `select id, conversation_id, ai_leasing_strategy_assignment_event_id,
              ai_leasing_strategy_leasing_lead_id, ai_leasing_strategy_applied
         from agent_runs where id = $1`,
      [agentRunId]
    )).rows[0];
    if (!run || String(run.conversation_id) !== String(conversationId)) {
      throw strategyError("agent_run_out_of_scope", "The AI generation run is not in this conversation.", 403);
    }
    if (!run.ai_leasing_strategy_applied) throw strategyError("strategy_not_applied", "That generation did not apply a strategy.", 409);
    if (
      String(run.ai_leasing_strategy_assignment_event_id) !== String(assignmentEventId) ||
      String(run.ai_leasing_strategy_leasing_lead_id) !== String(leasingLeadId)
    ) {
      throw strategyError("agent_run_assignment_mismatch", "The AI generation used a different opportunity assignment.", 409);
    }
    if (!["agent", "ai"].includes(message.sender_role)) {
      throw strategyError("comm_event_not_ai_drafted", "That communication was not produced from an AI draft.", 409);
    }
  } else if (message.sender_role !== "ai") {
    throw strategyError("comm_event_not_ai_authored", "A direct AI message must use the AI sender role.", 409);
  }

  const inserted = (await client.query(
    `insert into ai_leasing_message_attributions
       (comm_event_id, conversation_id, leasing_lead_id, property_id,
        assignment_event_id, strategy_profile_id, strategy_version_id,
        agent_run_id, authorship_scope, human_modified, authored_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (comm_event_id) do nothing returning id`,
    [
      commEventId, conversationId, leasingLeadId, propertyId,
      assignmentEventId, event.strategy_profile_id, event.strategy_version_id,
      agentRunId, authorshipScope, humanModified === true, authoredAt,
    ]
  )).rows[0];
  const attribution = (await client.query(
    `select id, comm_event_id, conversation_id, leasing_lead_id, property_id,
            assignment_event_id, strategy_profile_id, strategy_version_id,
            agent_run_id, attribution_basis, authorship_scope, human_modified,
            authored_at, recorded_at
       from ai_leasing_message_attributions where comm_event_id = $1`,
    [commEventId]
  )).rows[0];
  if (!attribution) throw strategyError("message_attribution_not_recorded", "AI message attribution was not recorded.", 500);
  if (
    String(attribution.assignment_event_id) !== String(assignmentEventId) ||
    String(attribution.leasing_lead_id) !== String(leasingLeadId) ||
    String(attribution.agent_run_id || "") !== String(agentRunId || "") ||
    attribution.authorship_scope !== authorshipScope ||
    attribution.human_modified !== (humanModified === true)
  ) {
    throw strategyError("message_attribution_conflict", "That message already carries different strategy authorship evidence.", 409);
  }
  return { created: !!inserted, attribution };
}

module.exports = {
  VOICE_KEYS,
  MOVE_KEYS,
  MOVE_ENUMS,
  FORBIDDEN_POLICY_KEYS,
  SEALED_BOUNDARIES,
  canonicalPolicy,
  moveDifferenceCount,
  validateStrategySeparation,
  moveLabel,
  deploymentEligibleForSource,
  validateDeploymentSet,
  sha256Text,
  buildAllocationSnapshot,
  allocationPolicyFingerprint,
  deterministicPoint,
  selectWeightedDeployment,
  strategyEnvelope,
  validatedEnvelopeForRuntime,
  buildStrategyDirective,
  loadActiveDeployments,
  lockOpportunityContext,
  currentAssignment,
  loadConversationStrategyEnvelope,
  assignConversationStrategy,
  handoffConversationStrategy,
  recordAiMessageAttribution,
};
