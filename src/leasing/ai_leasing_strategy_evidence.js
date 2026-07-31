// ════════════════════════════════════════════════════════════════════
// AI LEASING STRATEGY EVIDENCE — conservative comparison rules
//
// Consumes opportunity-level rows assembled only by the canonical projection.
// It does not infer missing outcomes or claim causality.
// ════════════════════════════════════════════════════════════════════
"use strict";

const DEFAULT_MIN_QUALIFIED_LEADS = 30;
const DEFAULT_MAX_GUARDRAIL_RATE_INCREASE = 0.02;

const OUTCOME_KEYS = Object.freeze([
  "prospect_replied",
  "tour_booked",
  "tour_held",
  "application_started",
  "application_submitted",
  "lease_signed",
  "human_handoff",
  "opt_out",
  "complaint",
]);
const REQUIRED_GUARDRAILS = Object.freeze(["human_handoff", "opt_out"]);
const OPTIONAL_GUARDRAILS = Object.freeze(["complaint"]);

function evidenceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validateEvidenceValue(value, key) {
  if (![true, false, null].includes(value)) {
    throw evidenceError("invalid_evidence_value", `${key} must be true, false, or null when unsupported.`);
  }
}

function validateEvidenceRow(row) {
  if (!row || typeof row !== "object") throw evidenceError("invalid_evidence_row", "Strategy evidence row is invalid.");
  const required = [
    "leasing_lead_id", "conversation_id", "property_id", "cohort_key",
    "strategy_version_id", "assignment_basis", "assignment_policy_fingerprint",
    "analysis_population", "as_of", "observation_window_days",
  ];
  for (const key of required) {
    if (row[key] == null || String(row[key]).trim() === "") {
      throw evidenceError("incomplete_evidence_row", `Strategy evidence row is missing ${key}.`);
    }
  }
  if (row.qualified !== true) {
    throw evidenceError("unqualified_evidence_row", "Only canonically qualified opportunities belong in the denominator.");
  }
  if (row.analysis_population !== "initial_opportunity_assignment_itt_v2") {
    throw evidenceError("unsupported_analysis_population", "Evidence must remain in the initial opportunity assignment population.");
  }
  for (const key of OUTCOME_KEYS) validateEvidenceValue(row[key], key);
  return row;
}

function rate(successes, observed) {
  return observed > 0 ? successes / observed : null;
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || successes < 0 || total < 0 || successes > total) {
    throw evidenceError("invalid_rate_inputs", "Rate inputs are invalid.");
  }
  if (total === 0) return { low: null, high: null };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function emptySummary() {
  return {
    status: "no_evidence",
    qualified_leads: 0,
    counts: Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0])),
    observed_denominators: Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0])),
    rates: Object.fromEntries(OUTCOME_KEYS.map((key) => [key, null])),
    intervals: Object.fromEntries(OUTCOME_KEYS.map((key) => [key, { low: null, high: null }])),
    unsupported_metrics: [...OUTCOME_KEYS],
  };
}

function summarizeStrategyEvidence(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return emptySummary();
  const first = validateEvidenceRow(rows[0]);
  const identity = {
    property_id: String(first.property_id),
    cohort_key: String(first.cohort_key),
    strategy_version_id: String(first.strategy_version_id),
    assignment_basis: String(first.assignment_basis),
    assignment_policy_fingerprint: String(first.assignment_policy_fingerprint),
    analysis_population: String(first.analysis_population),
    as_of: String(first.as_of),
    observation_window_days: Number(first.observation_window_days),
  };
  const seen = new Set();
  const counts = Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0]));
  const observed = Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0]));

  for (const raw of rows) {
    const row = validateEvidenceRow(raw);
    if (
      String(row.property_id) !== identity.property_id ||
      String(row.cohort_key) !== identity.cohort_key ||
      String(row.strategy_version_id) !== identity.strategy_version_id ||
      String(row.assignment_basis) !== identity.assignment_basis ||
      String(row.assignment_policy_fingerprint) !== identity.assignment_policy_fingerprint ||
      String(row.analysis_population) !== identity.analysis_population ||
      String(row.as_of) !== identity.as_of ||
      Number(row.observation_window_days) !== identity.observation_window_days
    ) {
      throw evidenceError("mixed_evidence_group", "One summary cannot mix properties, cohorts, strategies, routing regimes, populations, or observation windows.");
    }
    const leadId = String(row.leasing_lead_id);
    if (seen.has(leadId)) throw evidenceError("duplicate_opportunity_evidence", "A leasing opportunity appears more than once in the denominator.");
    seen.add(leadId);
    for (const key of OUTCOME_KEYS) {
      if (row[key] !== null) {
        observed[key] += 1;
        if (row[key] === true) counts[key] += 1;
      }
    }
  }

  const rates = {};
  const intervals = {};
  for (const key of OUTCOME_KEYS) {
    rates[key] = rate(counts[key], observed[key]);
    intervals[key] = wilsonInterval(counts[key], observed[key]);
  }
  return Object.freeze({
    status: "evidence_available",
    ...identity,
    qualified_leads: seen.size,
    counts: Object.freeze(counts),
    observed_denominators: Object.freeze(observed),
    rates: Object.freeze(rates),
    intervals: Object.freeze(intervals),
    unsupported_metrics: Object.freeze(OUTCOME_KEYS.filter((key) => observed[key] === 0)),
  });
}

function intervalsSeparateHigher(candidate, baseline, metric) {
  const a = candidate.intervals[metric];
  const b = baseline.intervals[metric];
  return a && b && a.low != null && b.high != null && a.low > b.high;
}

function compareGuardrails(candidate, baseline, maxIncrease) {
  const details = {};
  let requiredAvailable = true;
  for (const metric of [...REQUIRED_GUARDRAILS, ...OPTIONAL_GUARDRAILS]) {
    const candidateRate = candidate.rates[metric];
    const baselineRate = baseline.rates[metric];
    const supported = candidateRate != null && baselineRate != null;
    const required = REQUIRED_GUARDRAILS.includes(metric);
    if (required && !supported) requiredAvailable = false;
    details[metric] = {
      required,
      supported,
      candidate_rate: candidateRate,
      baseline_rate: baselineRate,
      max_allowed_increase: maxIncrease,
      passed: supported ? candidateRate <= baselineRate + maxIncrease : null,
    };
  }
  return {
    required_available: requiredAvailable,
    passed: requiredAvailable && REQUIRED_GUARDRAILS.every((metric) => details[metric].passed === true) &&
      OPTIONAL_GUARDRAILS.every((metric) => details[metric].passed !== false),
    missing_optional: OPTIONAL_GUARDRAILS.filter((metric) => !details[metric].supported),
    details,
  };
}

function compareStrategyEvidence(a, b, {
  primaryMetric = "tour_held",
  minQualifiedLeads = DEFAULT_MIN_QUALIFIED_LEADS,
  maxGuardrailRateIncrease = DEFAULT_MAX_GUARDRAIL_RATE_INCREASE,
} = {}) {
  if (!a || !b || a.status !== "evidence_available" || b.status !== "evidence_available") {
    return { status: "insufficient_evidence", reason: "evidence_unavailable" };
  }
  if (!OUTCOME_KEYS.includes(primaryMetric) || REQUIRED_GUARDRAILS.includes(primaryMetric) || OPTIONAL_GUARDRAILS.includes(primaryMetric)) {
    throw evidenceError("invalid_primary_metric", "Primary metric must be a positive leasing-funnel outcome.");
  }
  if (a.rates[primaryMetric] == null || b.rates[primaryMetric] == null) {
    return { status: "unsupported_metric", reason: "primary_metric_not_canonically_supported", primary_metric: primaryMetric };
  }
  if (!Number.isInteger(minQualifiedLeads) || minQualifiedLeads <= 0) {
    throw evidenceError("invalid_minimum_evidence", "Minimum qualified leads must be a positive integer.");
  }
  if (typeof maxGuardrailRateIncrease !== "number" || maxGuardrailRateIncrease < 0 || maxGuardrailRateIncrease > 1) {
    throw evidenceError("invalid_guardrail_tolerance", "Guardrail tolerance must be between zero and one.");
  }
  if (
    a.property_id !== b.property_id || a.cohort_key !== b.cohort_key ||
    a.assignment_basis !== b.assignment_basis ||
    a.assignment_policy_fingerprint !== b.assignment_policy_fingerprint ||
    a.analysis_population !== b.analysis_population ||
    a.as_of !== b.as_of || a.observation_window_days !== b.observation_window_days
  ) {
    return { status: "not_comparable", reason: "property_cohort_routing_population_or_window_differs" };
  }
  if (a.strategy_version_id === b.strategy_version_id) return { status: "not_comparable", reason: "same_strategy_version" };
  if (a.qualified_leads < minQualifiedLeads || b.qualified_leads < minQualifiedLeads) {
    return {
      status: "insufficient_evidence", reason: "minimum_qualified_leads_not_met",
      minimum_required: minQualifiedLeads,
      observed: { [a.strategy_version_id]: a.qualified_leads, [b.strategy_version_id]: b.qualified_leads },
    };
  }

  let candidate;
  let baseline;
  if (intervalsSeparateHigher(a, b, primaryMetric)) { candidate = a; baseline = b; }
  else if (intervalsSeparateHigher(b, a, primaryMetric)) { candidate = b; baseline = a; }
  else return { status: "no_directional_signal", reason: "primary_metric_intervals_overlap", primary_metric: primaryMetric };

  const guardrails = compareGuardrails(candidate, baseline, maxGuardrailRateIncrease);
  if (!guardrails.required_available) {
    return { status: "guardrail_unavailable", primary_metric: primaryMetric, guardrails };
  }
  if (!guardrails.passed) {
    return {
      status: "guardrail_blocked", primary_metric: primaryMetric,
      favored_strategy_version_id: candidate.strategy_version_id,
      compared_strategy_version_id: baseline.strategy_version_id,
      guardrails,
    };
  }
  return {
    status: guardrails.missing_optional.length ? "directional_signal_for_review" : "directional_signal",
    interpretation: "associated_not_causal",
    primary_metric: primaryMetric,
    favored_strategy_version_id: candidate.strategy_version_id,
    compared_strategy_version_id: baseline.strategy_version_id,
    favored_rate: candidate.rates[primaryMetric],
    compared_rate: baseline.rates[primaryMetric],
    favored_interval: candidate.intervals[primaryMetric],
    compared_interval: baseline.intervals[primaryMetric],
    qualified_leads: { favored: candidate.qualified_leads, compared: baseline.qualified_leads },
    guardrails,
    automatic_reallocation_allowed: false,
  };
}

module.exports = {
  DEFAULT_MIN_QUALIFIED_LEADS,
  DEFAULT_MAX_GUARDRAIL_RATE_INCREASE,
  OUTCOME_KEYS,
  REQUIRED_GUARDRAILS,
  OPTIONAL_GUARDRAILS,
  validateEvidenceRow,
  rate,
  wilsonInterval,
  summarizeStrategyEvidence,
  compareStrategyEvidence,
};
