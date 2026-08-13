"use strict";

const complianceContracts = require("./compliance_contracts.js");

const FACT_VERSION = "compliance.canonical_fact.v1";
const FACT_TYPES = Object.freeze([
  "credential_period",
  "finding_issued",
  "payment_observed",
  "cure_performed",
  "authority_disposition",
]);
const EVIDENCE_ROLES = Object.freeze([
  "issuance", "finding", "payment", "cure", "authority_disposition", "supporting",
]);

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
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function nullableString(value, path) {
  if (value !== null) requiredString(value, path);
}

function isoDate(value, path) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${path} must be an ISO date`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day) {
    throw new TypeError(`${path} must be a real calendar date`);
  }
}

function isoTimestamp(value, path) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${path} must be an ISO UTC timestamp`);
  }
}

function validateEvidence(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty array`);
  }
  value.forEach((entry, index) => {
    exact(entry, ["role", "label", "reference"], `${path}[${index}]`);
    if (!EVIDENCE_ROLES.includes(entry.role)) {
      throw new TypeError(`${path}[${index}].role is not allowed`);
    }
    requiredString(entry.label, `${path}[${index}].label`);
    complianceContracts.validateReference(entry.reference);
  });
}

const VALUE_VALIDATORS = Object.freeze({
  credential_period(value, path) {
    exact(value, ["effective_from", "effective_through"], path);
    isoDate(value.effective_from, `${path}.effective_from`);
    isoDate(value.effective_through, `${path}.effective_through`);
    if (value.effective_from > value.effective_through) {
      throw new TypeError(`${path} cannot end before it begins`);
    }
  },
  finding_issued(value, path) {
    exact(value, ["issued_on", "summary"], path);
    isoDate(value.issued_on, `${path}.issued_on`);
    requiredString(value.summary, `${path}.summary`);
  },
  payment_observed(value, path) {
    exact(value, ["observed_on", "amount_cents", "currency_code"], path);
    isoDate(value.observed_on, `${path}.observed_on`);
    if (!Number.isInteger(value.amount_cents) || value.amount_cents < 0) {
      throw new TypeError(`${path}.amount_cents must be a non-negative integer`);
    }
    if (typeof value.currency_code !== "string" || !/^[A-Z]{3}$/.test(value.currency_code)) {
      throw new TypeError(`${path}.currency_code must be a three-letter uppercase code`);
    }
  },
  cure_performed(value, path) {
    exact(value, ["performed_on", "summary"], path);
    isoDate(value.performed_on, `${path}.performed_on`);
    requiredString(value.summary, `${path}.summary`);
  },
  authority_disposition(value, path) {
    exact(value, ["decided_on", "disposition", "summary"], path);
    isoDate(value.decided_on, `${path}.decided_on`);
    if (!["closed", "remains_open"].includes(value.disposition)) {
      throw new TypeError(`${path}.disposition is not allowed`);
    }
    requiredString(value.summary, `${path}.summary`);
  },
});

function validateFact(value, path = "fact") {
  exact(value, [
    "contract_version", "fact_id", "fact_type", "established_at",
    "supersedes_fact_id", "correction_reason", "value", "evidence",
  ], path);
  if (value.contract_version !== FACT_VERSION) throw new TypeError(`${path} version mismatch`);
  requiredString(value.fact_id, `${path}.fact_id`);
  if (!FACT_TYPES.includes(value.fact_type)) throw new TypeError(`${path}.fact_type is not allowed`);
  isoTimestamp(value.established_at, `${path}.established_at`);
  nullableString(value.supersedes_fact_id, `${path}.supersedes_fact_id`);
  nullableString(value.correction_reason, `${path}.correction_reason`);
  if ((value.supersedes_fact_id === null) !== (value.correction_reason === null)) {
    throw new TypeError(`${path} correction target and reason must be declared together`);
  }
  VALUE_VALIDATORS[value.fact_type](value.value, `${path}.value`);
  validateEvidence(value.evidence, `${path}.evidence`);
  return value;
}

function validateFactList(value, path = "facts") {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  value.forEach((fact, index) => validateFact(fact, `${path}[${index}]`));
  return value;
}

function validateActionCondition(value, path = "action_condition") {
  exact(value, ["state", "action", "due_on", "obligation_id"], path);
  if (value.state !== "established") throw new TypeError(`${path}.state must be established`);
  requiredString(value.action, `${path}.action`);
  isoDate(value.due_on, `${path}.due_on`);
  requiredString(value.obligation_id, `${path}.obligation_id`);
  return value;
}

module.exports = {
  FACT_VERSION,
  FACT_TYPES,
  EVIDENCE_ROLES,
  validateFact,
  validateFactList,
  validateActionCondition,
};
