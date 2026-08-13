"use strict";

const utilityPosition = require("./utility_position_read.js");

const ASSET_MODULE = "asset_management";

function detailRequest(question) {
  const text = String(question || "").trim();
  const lower = text.toLowerCase();
  const account = /\b(?:account|accounts|acct)\b/.test(lower);
  const meter = /\b(?:meter|meters|metered|submeter|submeters|submetered)\b/.test(lower);
  const topology = meter || /\bindividually\s+metered\b/.test(lower);
  if (!account && !topology) return { mode: "standing", account_suffix: null };

  let accountSuffix = null;
  if (account) {
    const explicit = text.match(
      /(?:ending(?:\s+in)?|ends?(?:\s+in)?|[*xX\u2022]{2,})[\s:#-]*([0-9]{4})\b/);
    const nearby = text.match(/\b(?:account|acct)[^\n]{0,30}?([0-9]{4})\b/i);
    accountSuffix = (explicit && explicit[1]) || (nearby && nearby[1]) || null;
  }
  return { mode: account ? "account_detail" : "meter_detail", account_suffix: accountSuffix };
}

function withoutDatabaseIds(value) {
  if (Array.isArray(value)) return value.map(withoutDatabaseIds);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "id" || /_id$/.test(key)
        || (/_identifier$/.test(key) && !/_masked$/.test(key))) continue;
    clean[key] = withoutDatabaseIds(child);
  }
  return clean;
}

function standingForModel(standing) {
  return withoutDatabaseIds({
    contract_version: standing.contract_version,
    as_of: standing.as_of,
    setup_state: standing.setup_state,
    established_services: standing.established_services,
    not_applicable_services: standing.not_applicable_services,
    unresolved_services: standing.unresolved_services,
    unresolved_count: standing.unresolved_count,
    services: standing.services,
    next_due_statement: standing.next_due_statement,
    unresolved: standing.unresolved,
    does_not_establish: standing.does_not_establish,
    capabilities: standing.capabilities,
  });
}

function sourceReferences(value, label = "Utility evidence") {
  const found = new Map();
  function visit(node, currentLabel) {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, currentLabel);
      return;
    }
    if (!node || typeof node !== "object") return;
    const nextLabel = node.label ? `${node.label} Utility evidence` : currentLabel;
    if (node.source_artifact_id && !found.has(String(node.source_artifact_id))) {
      found.set(String(node.source_artifact_id), {
        label: nextLabel,
        module: ASSET_MODULE,
        open: { kind: "utility_evidence", id: node.source_artifact_id },
      });
    }
    for (const child of Object.values(node)) visit(child, nextLabel);
  }
  visit(value, label);
  return [...found.values()];
}

function statementForModel(statement) {
  if (!statement) return null;
  return withoutDatabaseIds({
    bill_date: statement.bill_date,
    service_period_start: statement.service_period_start,
    service_period_end: statement.service_period_end,
    due_date: statement.due_date,
    currency_code: statement.currency_code,
    amount_billed_cents: statement.amount_billed_cents,
    current_amount_due_cents: statement.current_amount_due_cents,
    late_fee_cents: statement.late_fee_cents,
    usage: statement.usage,
  });
}

function detailForModel(detail, request) {
  const allAccounts = detail.accounts || [];
  const selectedAccounts = request.mode === "account_detail"
    ? allAccounts.filter((account) => !request.account_suffix
      || String(account.account_identifier_masked || "").endsWith(request.account_suffix))
    : [];

  const accountRefs = new Map(selectedAccounts.map((account, index) =>
    [account.id, `UTILITY-ACCOUNT-${index + 1}`]));
  const metersById = new Map();
  for (const service of detail.services || []) {
    for (const meter of service.meters || []) metersById.set(meter.id, meter);
  }
  for (const account of selectedAccounts) {
    for (const meter of account.meters || []) {
      if (!metersById.has(meter.id)) metersById.set(meter.id, meter);
    }
  }
  const selectedMeters = request.mode === "meter_detail"
    ? [...metersById.values()]
    : [...new Map(selectedAccounts.flatMap((account) => account.meters || [])
      .map((meter) => [meter.id, metersById.get(meter.id) || meter])).values()];
  const meterRefs = new Map(selectedMeters.map((meter, index) =>
    [meter.id, `UTILITY-METER-${index + 1}`]));

  const accounts = selectedAccounts.map((account) => ({
    reference: accountRefs.get(account.id),
    provider: account.provider || null,
    account_identifier_masked: account.account_identifier_masked,
    service_address: account.service_address || null,
    billing_cadence: account.billing_cadence || null,
    serves: withoutDatabaseIds(account.serves || []),
    meters: (account.meters || []).map((meter) => ({
      reference: meterRefs.get(meter.id) || null,
      kind: meter.kind,
      identifier_masked: meter.identifier_masked,
    })),
    latest_statement: statementForModel(account.latest_statement),
  }));

  const meters = selectedMeters.map((meter) => ({
    reference: meterRefs.get(meter.id),
    kind: meter.kind,
    identifier_masked: meter.identifier_masked,
    serves: withoutDatabaseIds(meter.serves || []),
  }));

  const services = (detail.services || []).map((service) => ({
    service_class: service.service_class,
    label: service.label,
    applicability: withoutDatabaseIds(service.applicability),
    providers: (service.providers || []).map((provider) => provider.name),
    physical_arrangement: service.arrangement
      ? service.arrangement.physical_arrangement || null : null,
    resident_recovery_method: service.arrangement
      ? service.arrangement.resident_recovery_method || null : null,
    account_references: (service.accounts || [])
      .map((account) => accountRefs.get(account.id)).filter(Boolean),
    meter_references: (service.meters || [])
      .map((meter) => meterRefs.get(meter.id)).filter(Boolean),
    provider_payment: withoutDatabaseIds(service.payment),
  }));

  return {
    read_state: "READ_SUCCEEDED",
    mode: request.mode,
    selector: request.account_suffix
      ? { account_ending: request.account_suffix, match_count: accounts.length }
      : null,
    accounts,
    meters,
    services,
    unresolved: withoutDatabaseIds(detail.unresolved || []),
  };
}

async function readForQuestion(client, {
  property_id, allowed_modules, question, as_of = null,
} = {}) {
  const request = detailRequest(question);
  if (!(allowed_modules || []).includes(ASSET_MODULE)) {
    return { mode: request.mode, read_state: "NOT_ENTITLED",
      standing: null, detail: null, references: [] };
  }

  if (request.mode === "standing") {
    const standing = await utilityPosition.readStanding(client, { property_id, as_of });
    return {
      mode: request.mode,
      read_state: "READ_SUCCEEDED",
      standing: standingForModel(standing),
      detail: null,
      references: sourceReferences(standing.services || []),
    };
  }

  const position = await utilityPosition.readPosition(client, { property_id, as_of });
  return {
    mode: request.mode,
    read_state: "READ_SUCCEEDED",
    standing: standingForModel(position.standing),
    detail: detailForModel(position.detail, request),
    references: sourceReferences(position.detail),
  };
}

module.exports = {
  ASSET_MODULE,
  detailRequest,
  withoutDatabaseIds,
  standingForModel,
  detailForModel,
  sourceReferences,
  readForQuestion,
};
