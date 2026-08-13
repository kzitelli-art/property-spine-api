"use strict";

const contracts = require("./compliance_contracts.js");
const projection = require("./compliance_projection.js");

const COVERAGE_UNKNOWN = Object.freeze({
  state: "unknown",
  meaning: "No property-wide Compliance requirement census has been established.",
});

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

function dateValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function timestampValue(value) {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function factValue(row) {
  if (row.fact_type === "credential_period") {
    return {
      effective_from: dateValue(row.credential_effective_from),
      effective_through: dateValue(row.credential_effective_through),
    };
  }
  if (row.fact_type === "finding_issued") {
    return { issued_on: dateValue(row.finding_issued_on), summary: row.finding_summary };
  }
  if (row.fact_type === "payment_observed") {
    return {
      observed_on: dateValue(row.payment_observed_on),
      amount_cents: Number(row.payment_amount_cents),
      currency_code: row.payment_currency_code,
    };
  }
  if (row.fact_type === "cure_performed") {
    return { performed_on: dateValue(row.cure_performed_on), summary: row.cure_summary };
  }
  return {
    decided_on: dateValue(row.authority_decided_on),
    disposition: row.authority_disposition,
    summary: row.authority_summary,
  };
}

function reference(role, label, token) {
  return contracts.validateReference({
    contract_version: contracts.VERSIONS.reference,
    role,
    label,
    opener: { kind: "server_minted", token },
  });
}

async function loadSpecs(client, { property_id: propertyId, item_id: itemId, mintReference }) {
  required(propertyId, "server-derived property_id");
  if (typeof mintReference !== "function") throw new TypeError("mintReference is required");

  const params = [propertyId];
  let itemPredicate = "";
  if (itemId !== null && itemId !== undefined) {
    params.push(required(itemId, "item_id"));
    itemPredicate = " and i.id = $2";
  }
  const items = (await client.query(
    `select i.id, i.property_id, i.item_kind, i.compliance_type, i.created_at
       from compliance_items i
      where i.property_id = $1${itemPredicate}
      order by i.created_at, i.id`, params)).rows;
  if (items.length === 0) return [];

  const ids = items.map((item) => item.id);
  const facts = (await client.query(
    `select f.id, f.item_id, f.fact_type, f.established_at,
            f.supersedes_fact_id, f.correction_reason,
            f.credential_issuing_authority, f.credential_external_number,
            f.credential_legal_entity_name, f.credential_property_address,
            f.credential_effective_from, f.credential_effective_through,
            f.finding_issued_on, f.finding_summary,
            f.payment_observed_on, f.payment_amount_cents, f.payment_currency_code,
            f.cure_performed_on, f.cure_summary,
            f.authority_decided_on, f.authority_disposition, f.authority_summary
       from compliance_facts f
      where f.item_id = any($1::uuid[])
      order by f.established_at, f.id`, [ids])).rows;
  const evidence = (await client.query(
    `select e.fact_id, e.source_artifact_id, e.evidence_role, e.label
       from compliance_fact_evidence e
       join compliance_facts f on f.id = e.fact_id
      where f.item_id = any($1::uuid[])
      order by e.recorded_at, e.id`, [ids])).rows;

  const evidenceByFact = new Map();
  for (const row of evidence) {
    const token = await mintReference({
      role: "source_artifact", property_id: propertyId,
      artifact_id: row.source_artifact_id, label: row.label,
    });
    const list = evidenceByFact.get(String(row.fact_id)) || [];
    list.push({
      role: row.evidence_role,
      label: row.label,
      reference: reference("source_artifact", row.label, required(token, "reference token")),
    });
    evidenceByFact.set(String(row.fact_id), list);
  }

  return Promise.all(items.map(async (item) => {
    const rows = facts.filter((fact) => String(fact.item_id) === String(item.id));
    const canonicalFacts = rows.map((row) => ({
      contract_version: "compliance.canonical_fact.v1",
      fact_id: String(row.id),
      fact_type: row.fact_type,
      established_at: timestampValue(row.established_at),
      supersedes_fact_id: row.supersedes_fact_id && String(row.supersedes_fact_id),
      correction_reason: row.correction_reason,
      value: factValue(row),
      evidence: evidenceByFact.get(String(row.id)) || [],
    }));
    const supersededIds = new Set(rows
      .filter((row) => row.supersedes_fact_id !== null)
      .map((row) => String(row.supersedes_fact_id)));
    const identityRow = rows
      .filter((row) => row.fact_type === "credential_period" && !supersededIds.has(String(row.id)))
      .sort((left, right) =>
        dateValue(right.credential_effective_through)
          .localeCompare(dateValue(left.credential_effective_through)) ||
        timestampValue(right.established_at).localeCompare(timestampValue(left.established_at)))[0] || null;
    const suffix = identityRow && identityRow.credential_external_number
      ? ` #${identityRow.credential_external_number}` : "";
    const label = item.compliance_type === "rental_license"
      ? `Rental License${suffix}` : `${item.compliance_type}${suffix}`;
    const recordToken = await mintReference({
      role: "canonical_record", property_id: propertyId, item_id: item.id, label,
    });
    return {
      kind: item.item_kind,
      entity: {
        type: item.item_kind,
        compliance_type: item.compliance_type,
        record_id: String(item.id),
        label,
      },
      facts: canonicalFacts,
      action_condition: null,
      record_reference: reference(
        "canonical_record", label, required(recordToken, "record reference token")),
    };
  }));
}

async function readComplianceStanding(client, input = {}) {
  const specs = await loadSpecs(client, { ...input, item_id: null });
  return projection.buildStandingProjection({
    as_of: input.as_of,
    coverage: COVERAGE_UNKNOWN,
    items: specs,
  });
}

async function readComplianceDetail(client, input = {}) {
  const specs = await loadSpecs(client, input);
  if (specs.length === 0) return null;
  return projection.buildDetailProjection({
    as_of: input.as_of,
    coverage: COVERAGE_UNKNOWN,
    item: specs[0],
  });
}

module.exports = {
  COVERAGE_UNKNOWN,
  readComplianceStanding,
  readComplianceDetail,
};
