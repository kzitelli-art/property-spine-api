"use strict";

const contract = require("./contracted_service_contract.js");
const positionRead = require("./contracted_service_position_read.js");

const ASSET_MODULE = "asset_management";
const DEFAULT_TIMEOUT_MS = 5000;

function readTimeout(timeoutMs) {
  const error = new Error(`Contracted Services governed read timed out after ${timeoutMs}ms`);
  error.code = "READ_TIMED_OUT";
  return error;
}

async function withinTimeout(read, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(readTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function attentionState(standing) {
  return standing && standing.unresolved_count === 0 && standing.attention_count === 0
    ? "QUIET" : "ATTENTION_REQUIRED";
}

function serviceSelector(question) {
  const lower = String(question || "").toLowerCase();
  const aliases = [
    ["building_cleaning", /\b(?:cleaning|janitorial)\b/],
    ["elevator_maintenance", /\belevator\b/],
    ["fire_alarm_monitoring", /\b(?:fire alarm|alarm monitoring)\b/],
    ["fire_sprinkler_service", /\bsprinkler\b/],
    ["security_concierge", /\b(?:security|concierge)\b/],
    ["hvac_maintenance", /\bHVAC\b/i],
    ["waste_removal", /\b(?:trash|waste|recycling)\b/],
    ["compactor_rental", /\bcompactor\b/],
    ["pest_control", /\b(?:pest|exterminat(?:or|ion))\b/],
    ["snow_removal", /\bsnow\b/],
    ["landscaping", /\b(?:landscaping|lawn|groundskeeping)\b/],
    ["water_treatment", /\bwater treatment\b/],
    ["meter_reading", /\bmeter reading\b/],
    ["parking_operations", /\bparking\b/],
  ];
  const matched = aliases.filter(([, pattern]) => pattern.test(lower)).map(([key]) => key);
  return matched.length === 1 ? matched[0] : null;
}

function detailRequest(question) {
  const text = String(question || "").trim();
  const lower = text.toLowerCase();
  if (/\b(?:compare|versus|vs\.?|benchmark|cheaper|more expensive)\b/.test(lower)) {
    return { mode: "comparison_unavailable", service_class: serviceSelector(text) };
  }
  if (/\b(?:why|caused?|driver|because)\b/.test(lower)
      && /\b(?:cost|price|expense|spend|increase|decrease|change)\b/.test(lower)) {
    return { mode: "causal_explanation_unavailable", service_class: serviceSelector(text) };
  }
  const serviceClass = serviceSelector(text);
  if (/\b(?:renew|renewal|notice|expir|term end|termination|deadline)\b/.test(lower)) {
    return { mode: "milestone_detail", service_class: serviceClass };
  }
  if (/\b(?:price|cost|rate|invoice|budget|expense|spend|paid|payment)\b/.test(lower)) {
    return { mode: "financial_detail", service_class: serviceClass };
  }
  if (serviceClass) return { mode: "service_detail", service_class: serviceClass };
  if (/\b(?:provider|vendor|contractor)\b/.test(lower)) {
    return { mode: "provider_detail", service_class: null };
  }
  return { mode: "standing", service_class: null };
}

function withoutDatabaseIds(value) {
  if (Array.isArray(value)) return value.map(withoutDatabaseIds);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "id" || /_id$/.test(key)) continue;
    clean[key] = withoutDatabaseIds(child);
  }
  return clean;
}

function sourceReferences(value, label = "Contracted Services evidence") {
  const found = new Map();
  function visit(node, currentLabel) {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, currentLabel);
      return;
    }
    if (!node || typeof node !== "object") return;
    const sourceLabel = node.label || (node.provider && node.provider.name);
    const nextLabel = sourceLabel ? `${sourceLabel} evidence` : currentLabel;
    if (node.source_artifact_id && !found.has(String(node.source_artifact_id))) {
      found.set(String(node.source_artifact_id), {
        label: nextLabel,
        module: ASSET_MODULE,
        open: { kind: "contracted_service_evidence", id: node.source_artifact_id },
      });
    }
    for (const child of Object.values(node)) visit(child, nextLabel);
  }
  visit(value, label);
  return [...found.values()];
}

function standingForModel(standing) {
  return withoutDatabaseIds({
    contract_version: standing.contract_version,
    as_of: standing.as_of,
    setup_state: standing.setup_state,
    coverage_review: standing.coverage_review,
    requirement_count: standing.requirement_count,
    engagement_count: standing.engagement_count,
    governed_engagement_count: standing.governed_engagement_count,
    attention_count: standing.attention_count,
    unmatched_document_count: standing.unmatched_document_count,
    unmatched_financial_observation_count: standing.unmatched_financial_observation_count,
    next_milestone: standing.next_milestone,
    engagements: standing.engagements,
    unresolved_count: standing.unresolved_count,
    unresolved: standing.unresolved,
    does_not_establish: standing.does_not_establish,
    capabilities: standing.capabilities,
  });
}

function selectedEngagements(detail, request, question) {
  let rows = detail.engagements || [];
  if (request.service_class) {
    rows = rows.filter((row) => row.service_class === request.service_class);
  }
  if (request.mode === "provider_detail") {
    const lower = String(question || "").toLowerCase();
    const named = rows.filter((row) => row.provider && row.provider.name
      && lower.includes(String(row.provider.name).toLowerCase()));
    if (named.length) rows = named;
  }
  return rows;
}

function detailForModel(detail, request, question) {
  const engagements = selectedEngagements(detail, request, question);
  const common = engagements.map((row) => ({
    service_class: row.service_class,
    label: row.label,
    engagement_label: row.engagement_label,
    provider: row.provider ? row.provider.name : null,
    execution_standing: row.execution_standing,
    term_standing: row.term_standing,
    scope: row.scope,
    payment: row.payment,
    service_completion: row.service_completion,
  }));
  if (request.mode === "milestone_detail") {
    return withoutDatabaseIds({
      engagements: common.map((row) => ({
        service_class: row.service_class, label: row.label, provider: row.provider,
        execution_standing: row.execution_standing,
        term_standing: row.term_standing,
      })),
    });
  }
  if (request.mode === "financial_detail") {
    return withoutDatabaseIds({
      engagements: engagements.map((row) => ({
        service_class: row.service_class,
        label: row.label,
        provider: row.provider ? row.provider.name : null,
        governing_price_components: row.term_standing.current
          ? row.term_standing.current.prices : [],
        financial_observations: row.financial_observations,
        payment: row.payment,
      })),
      unmatched_financial_observations: (detail.unmatched_financial_observations || [])
        .filter((row) => !request.service_class || row.service_class === request.service_class),
      truth_wall: "Contract price, accounting observation, invoice, and payment are distinct facts.",
    });
  }
  return withoutDatabaseIds({ engagements: common });
}

function unsupportedResult(request) {
  const capability = request.mode === "comparison_unavailable" ? "comparison" : "causal_explanation";
  return {
    mode: request.mode,
    read_state: "CAPABILITY_NOT_ESTABLISHED",
    attention_state: "ATTENTION_REQUIRED",
    standing: null,
    detail: {
      capability,
      claimed: false,
      clearing_condition: contract.CAPABILITIES[capability].clearing_condition,
    },
    references: [],
  };
}

async function readForQuestion(client, {
  property_id, allowed_modules, question, as_of = null,
  timeout_ms = DEFAULT_TIMEOUT_MS,
} = {}) {
  const request = detailRequest(question);
  if (!(allowed_modules || []).includes(ASSET_MODULE)) {
    return { mode: request.mode, read_state: "NOT_ENTITLED",
      standing: null, detail: null, references: [] };
  }
  if (["comparison_unavailable", "causal_explanation_unavailable"].includes(request.mode)) {
    return unsupportedResult(request);
  }
  const position = await withinTimeout(
    () => positionRead.readPosition(client, { property_id, as_of }), timeout_ms);
  return {
    mode: request.mode,
    read_state: "READ_SUCCEEDED",
    attention_state: attentionState(position.standing),
    standing: standingForModel(position.standing),
    detail: request.mode === "standing"
      ? null : detailForModel(position.detail, request, question),
    references: sourceReferences(request.mode === "standing"
      ? position.standing.engagements : selectedEngagements(position.detail, request, question)),
  };
}

module.exports = {
  ASSET_MODULE,
  detailRequest,
  withoutDatabaseIds,
  sourceReferences,
  standingForModel,
  detailForModel,
  withinTimeout,
  attentionState,
  readForQuestion,
};
