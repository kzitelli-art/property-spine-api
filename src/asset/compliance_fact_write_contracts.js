"use strict";

const VERSION = "compliance.fact_confirmation.v1";
const RECEIPT_VERSION = "compliance.fact_write_receipt.v1";

const FACT_ITEM_KIND = Object.freeze({
  credential_period: "credential",
  finding_issued: "finding",
  payment_observed: "finding",
  cure_performed: "finding",
  authority_disposition: "finding",
  inspection_result: "inspection",
  requirement_applicability: "requirement",
});

const EVIDENCE_ROLE = Object.freeze({
  credential_period: "issuance",
  finding_issued: "finding",
  payment_observed: "payment",
  cure_performed: "cure",
  authority_disposition: "authority_disposition",
  inspection_result: "inspection",
  requirement_applicability: "applicability",
});

function exact(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${path} has keys [${actual.join(", ")}], expected [${expected.join(", ")}]`);
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function nullableString(value, path) {
  if (value !== null) requiredString(value, path);
}

function date(value, path) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${path} must be an ISO date`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day) throw new TypeError(`${path} must be a real calendar date`);
}

function oneOf(value, choices, path) {
  if (!choices.includes(value)) throw new TypeError(`${path} is not allowed`);
}

const VALUE_VALIDATORS = Object.freeze({
  credential_period(value, path) {
    exact(value, ["issuing_authority", "external_number", "subject_identifier", "credential_code",
      "activity_number", "legal_entity_name", "property_address", "unit_count",
      "effective_from", "effective_through"], path);
    requiredString(value.issuing_authority, `${path}.issuing_authority`);
    requiredString(value.external_number, `${path}.external_number`);
    nullableString(value.subject_identifier, `${path}.subject_identifier`);
    nullableString(value.credential_code, `${path}.credential_code`);
    nullableString(value.activity_number, `${path}.activity_number`);
    nullableString(value.legal_entity_name, `${path}.legal_entity_name`);
    requiredString(value.property_address, `${path}.property_address`);
    if (value.unit_count !== null && (!Number.isInteger(value.unit_count) || value.unit_count < 1)) {
      throw new TypeError(`${path}.unit_count must be a positive integer or null`);
    }
    date(value.effective_from, `${path}.effective_from`);
    date(value.effective_through, `${path}.effective_through`);
    if (value.effective_through < value.effective_from) throw new TypeError(`${path} period is inverted`);
  },
  finding_issued(value, path) {
    exact(value, ["issued_on", "external_reference", "summary"], path);
    date(value.issued_on, `${path}.issued_on`);
    requiredString(value.external_reference, `${path}.external_reference`);
    requiredString(value.summary, `${path}.summary`);
  },
  payment_observed(value, path) {
    exact(value, ["observed_on", "amount_cents", "currency_code", "payment_reference"], path);
    date(value.observed_on, `${path}.observed_on`);
    if (!Number.isInteger(value.amount_cents) || value.amount_cents < 0) {
      throw new TypeError(`${path}.amount_cents must be a non-negative integer`);
    }
    if (typeof value.currency_code !== "string" || !/^[A-Z]{3}$/.test(value.currency_code)) {
      throw new TypeError(`${path}.currency_code must be a three-letter uppercase code`);
    }
    nullableString(value.payment_reference, `${path}.payment_reference`);
  },
  cure_performed(value, path) {
    exact(value, ["performed_on", "summary"], path);
    date(value.performed_on, `${path}.performed_on`);
    requiredString(value.summary, `${path}.summary`);
  },
  authority_disposition(value, path) {
    exact(value, ["decided_on", "disposition", "summary"], path);
    date(value.decided_on, `${path}.decided_on`);
    oneOf(value.disposition, ["closed", "remains_open"], `${path}.disposition`);
    requiredString(value.summary, `${path}.summary`);
  },
  inspection_result(value, path) {
    exact(value, ["performed_on", "outcome", "summary"], path);
    date(value.performed_on, `${path}.performed_on`);
    oneOf(value.outcome, ["passed", "passed_with_conditions", "failed", "inconclusive"],
      `${path}.outcome`);
    requiredString(value.summary, `${path}.summary`);
  },
  requirement_applicability(value, path) {
    exact(value, ["decided_on", "applicability", "summary"], path);
    date(value.decided_on, `${path}.decided_on`);
    oneOf(value.applicability, ["applicable", "exempt", "not_applicable"],
      `${path}.applicability`);
    requiredString(value.summary, `${path}.summary`);
  },
});

function validateConfirmation(value) {
  exact(value, ["contract_version", "artifact_id", "artifact_sha256", "idempotency_key",
    "source_reviewed", "item", "fact", "correction"], "confirmation");
  if (value.contract_version !== VERSION) throw new TypeError("confirmation version mismatch");
  for (const key of ["artifact_id", "artifact_sha256", "idempotency_key"]) {
    requiredString(value[key], `confirmation.${key}`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.artifact_sha256)) {
    throw new TypeError("confirmation.artifact_sha256 must be a lowercase SHA-256 digest");
  }
  if (value.source_reviewed !== true) throw new TypeError("confirmation.source_reviewed must be true");
  exact(value.item, ["existing_item_id", "item_kind", "compliance_type"], "confirmation.item");
  nullableString(value.item.existing_item_id, "confirmation.item.existing_item_id");
  oneOf(value.item.item_kind, Object.values(FACT_ITEM_KIND), "confirmation.item.item_kind");
  requiredString(value.item.compliance_type, "confirmation.item.compliance_type");
  exact(value.fact, ["fact_type", "value"], "confirmation.fact");
  if (!VALUE_VALIDATORS[value.fact.fact_type]) throw new TypeError("confirmation.fact.fact_type is not allowed");
  if (FACT_ITEM_KIND[value.fact.fact_type] !== value.item.item_kind) {
    throw new TypeError("confirmation fact type does not belong to the declared item kind");
  }
  VALUE_VALIDATORS[value.fact.fact_type](value.fact.value, "confirmation.fact.value");
  if (value.correction !== null) {
    exact(value.correction, ["supersedes_fact_id", "reason"], "confirmation.correction");
    requiredString(value.correction.supersedes_fact_id, "confirmation.correction.supersedes_fact_id");
    requiredString(value.correction.reason, "confirmation.correction.reason");
    if (value.item.existing_item_id === null) throw new TypeError("a correction requires an existing item");
  }
  return value;
}

function validateReceipt(value) {
  exact(value, ["contract_version", "outcome", "record", "established", "next"], "receipt");
  if (value.contract_version !== RECEIPT_VERSION) throw new TypeError("receipt version mismatch");
  oneOf(value.outcome, ["established", "idempotent_replay"], "receipt.outcome");
  exact(value.record, ["kind", "id"], "receipt.record");
  if (value.record.kind !== "compliance_item") throw new TypeError("receipt record kind mismatch");
  requiredString(value.record.id, "receipt.record.id");
  exact(value.established, ["item_kind", "compliance_type", "fact_type"], "receipt.established");
  oneOf(value.established.item_kind, Object.values(FACT_ITEM_KIND), "receipt.established.item_kind");
  requiredString(value.established.compliance_type, "receipt.established.compliance_type");
  oneOf(value.established.fact_type, Object.keys(FACT_ITEM_KIND), "receipt.established.fact_type");
  exact(value.next, ["kind"], "receipt.next");
  if (value.next.kind !== "reread_compliance_standing") throw new TypeError("receipt next mismatch");
  return value;
}

module.exports = {
  VERSION, RECEIPT_VERSION, FACT_ITEM_KIND, EVIDENCE_ROLE,
  validateConfirmation, validateReceipt,
};
