"use strict";

const crypto = require("crypto");
const readerCapabilities = require("../shared/reader_capability_contract.js");

const VERSIONS = Object.freeze({
  proposal: "compliance.rental_license.proposal.v2",
  intake: "compliance.evidence_intake.v2",
  confirmation: "compliance.confirmation_request.v1",
  write_receipt: "compliance.write_receipt.v1",
  standing: "compliance.standing.v2",
  detail: "compliance.detail.v2",
  reference: "compliance.reference.v1",
  failure: "compliance.failure.v1",
});

const WIRE_CONTRACTS = Object.freeze({
  proposal: Object.freeze({ version: VERSIONS.proposal, implementation: "implemented" }),
  intake: Object.freeze({ version: VERSIONS.intake, implementation: "implemented" }),
  confirmation: Object.freeze({ version: VERSIONS.confirmation, implementation: "future_unimplemented" }),
  write_receipt: Object.freeze({ version: VERSIONS.write_receipt, implementation: "future_unimplemented" }),
  standing: Object.freeze({ version: VERSIONS.standing, implementation: "future_unimplemented" }),
  detail: Object.freeze({ version: VERSIONS.detail, implementation: "future_unimplemented" }),
  reference: Object.freeze({ version: VERSIONS.reference, implementation: "future_unimplemented" }),
  failure: Object.freeze({ version: VERSIONS.failure, implementation: "implemented" }),
});

const DOES_NOT_ESTABLISH = Object.freeze([
  "canonical_compliance_truth",
  "requirement_applicability",
  "credential_standing",
  "property_wide_compliance",
  "operational_attention",
  "renewal_obligation",
]);

const PROPOSED_KEYS = Object.freeze([
  "compliance_type", "issuing_authority", "external_credential_number",
  "credential_code", "commercial_activity_number", "legal_entity_name",
  "property_address", "unit_count", "effective_from", "effective_through",
]);

const UNKNOWN_FIELDS = Object.freeze({
  credential_identity: Object.freeze([
    "compliance_type", "issuing_authority", "external_credential_number",
    "credential_code", "commercial_activity_number",
  ]),
  credential_subject: Object.freeze(["legal_entity_name", "property_address", "unit_count"]),
  credential_period: Object.freeze(["effective_from", "effective_through"]),
});

const FAILURE_CODES = Object.freeze([
  "recognition_failed", "proposal_stale", "artifact_out_of_scope",
  "confirmation_conflict", "standing_unavailable", "detail_unavailable",
  "reference_unavailable",
]);

const CAPABILITY_NAMES = readerCapabilities.CAPABILITY_NAMES;

function exact(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new TypeError(`${path} has keys [${actual.join(", ")}], expected [${expected.join(", ")}]`);
  }
}

function oneOf(value, values, path) {
  if (!values.includes(value)) throw new TypeError(`${path} is not an allowed value`);
}

function nullableString(value, path) {
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`${path} must be null or a non-empty string`);
  }
}

function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function isoDate(value, path, nullable = true) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${path} must be an ISO date${nullable ? " or null" : ""}`);
  }
}

function retrievalCapabilityReceipt(basis) {
  return readerCapabilities.retrievalOnly(basis);
}

function validateCapabilityClasses(value, path) {
  return readerCapabilities.validate(value, path);
}

function validateUnknown(item, index) {
  exact(item, ["concept", "field", "reason"], `proposal.unknowns[${index}]`);
  oneOf(item.concept, Object.keys(UNKNOWN_FIELDS), `proposal.unknowns[${index}].concept`);
  oneOf(item.field, UNKNOWN_FIELDS[item.concept], `proposal.unknowns[${index}].field`);
  oneOf(item.reason, ["absent", "ambiguous", "not_readable"], `proposal.unknowns[${index}].reason`);
}

function validateProposal(value) {
  exact(value, [
    "contract_version", "recognition_state", "source_classification",
    "capability_classes", "proposed", "unknowns", "does_not_establish", "reason",
  ], "proposal");
  if (value.contract_version !== VERSIONS.proposal) throw new TypeError("proposal version mismatch");
  oneOf(value.recognition_state,
    ["recognized", "read_no_match", "unsupported_evidence"], "proposal.recognition_state");
  oneOf(value.source_classification,
    ["authority_issued_credential", "payment_evidence", "unclassified"],
    "proposal.source_classification");
  validateCapabilityClasses(value.capability_classes, "proposal.capability_classes");
  exact(value.proposed, PROPOSED_KEYS, "proposal.proposed");
  for (const key of PROPOSED_KEYS) {
    if (key === "unit_count") {
      if (value.proposed[key] !== null &&
          (!Number.isInteger(value.proposed[key]) || value.proposed[key] < 1)) {
        throw new TypeError("proposal.proposed.unit_count must be a positive integer or null");
      }
    } else if (key === "effective_from" || key === "effective_through") {
      isoDate(value.proposed[key], `proposal.proposed.${key}`);
    } else nullableString(value.proposed[key], `proposal.proposed.${key}`);
  }
  if (!Array.isArray(value.unknowns)) throw new TypeError("proposal.unknowns must be an array");
  value.unknowns.forEach(validateUnknown);
  if (JSON.stringify(value.does_not_establish) !== JSON.stringify(DOES_NOT_ESTABLISH)) {
    throw new TypeError("proposal authority boundary mismatch");
  }
  if (typeof value.reason !== "string" || !value.reason) throw new TypeError("proposal.reason is required");
  return value;
}

function validateIntake(value) {
  exact(value, ["contract_version", "artifact", "proposal", "proposal_basis", "failure"], "intake");
  if (value.contract_version !== VERSIONS.intake) throw new TypeError("intake version mismatch");
  exact(value.artifact, ["id", "sha256", "artifact_kind", "deduplicated"], "intake.artifact");
  for (const key of ["id", "sha256", "artifact_kind"])
    nullableString(value.artifact[key], `intake.artifact.${key}`);
  if (typeof value.artifact.deduplicated !== "boolean")
    throw new TypeError("intake.artifact.deduplicated must be boolean");
  if (value.failure !== null) {
    if (value.proposal !== null || value.proposal_basis !== null)
      throw new TypeError("failed intake cannot carry a proposal or proposal basis");
    validateFailure(value.failure);
  } else {
    validateProposal(value.proposal);
    exact(value.proposal_basis, ["adapter", "adapter_version", "fingerprint"], "intake.proposal_basis");
    for (const key of ["adapter", "adapter_version", "fingerprint"])
      nullableString(value.proposal_basis[key], `intake.proposal_basis.${key}`);
  }
  return value;
}

function validateReference(value) {
  exact(value, ["contract_version", "role", "label", "opener"], "reference");
  if (value.contract_version !== VERSIONS.reference) throw new TypeError("reference version mismatch");
  oneOf(value.role, ["canonical_record", "source_artifact"], "reference.role");
  requiredString(value.label, "reference.label");
  exact(value.opener, ["kind", "token"], "reference.opener");
  if (value.opener.kind !== "server_minted") throw new TypeError("reference opener must be server_minted");
  requiredString(value.opener.token, "reference.opener.token");
  return value;
}

function validateFailure(value) {
  exact(value, ["contract_version", "code", "message", "retryable", "artifact"], "failure");
  if (value.contract_version !== VERSIONS.failure) throw new TypeError("failure version mismatch");
  oneOf(value.code, FAILURE_CODES, "failure.code");
  requiredString(value.message, "failure.message");
  if (typeof value.retryable !== "boolean") throw new TypeError("failure.retryable must be boolean");
  if (value.artifact !== null) {
    exact(value.artifact, ["id", "retained"], "failure.artifact");
    requiredString(value.artifact.id, "failure.artifact.id");
    if (value.artifact.retained !== true) throw new TypeError("a returned failure artifact must be retained");
  }
  return value;
}

function validateConfirmationRequest(value) {
  exact(value, [
    "contract_version", "artifact_id", "artifact_sha256", "proposal_fingerprint",
    "idempotency_key", "confirmed", "correction",
  ], "confirmation");
  if (value.contract_version !== VERSIONS.confirmation) throw new TypeError("confirmation version mismatch");
  for (const key of ["artifact_id", "artifact_sha256", "proposal_fingerprint", "idempotency_key"])
    requiredString(value[key], `confirmation.${key}`);
  exact(value.confirmed, PROPOSED_KEYS, "confirmation.confirmed");
  for (const key of PROPOSED_KEYS) {
    if (key === "unit_count") {
      if (value.confirmed[key] !== null && !Number.isInteger(value.confirmed[key]))
        throw new TypeError("confirmation.confirmed.unit_count must be an integer or null");
    } else if (key === "effective_from" || key === "effective_through") {
      isoDate(value.confirmed[key], `confirmation.confirmed.${key}`);
    } else nullableString(value.confirmed[key], `confirmation.confirmed.${key}`);
  }
  if (value.correction !== null) {
    exact(value.correction, ["supersedes_fact_id", "reason"], "confirmation.correction");
    requiredString(value.correction.supersedes_fact_id, "confirmation.correction.supersedes_fact_id");
    requiredString(value.correction.reason, "confirmation.correction.reason");
  }
  return value;
}

function validateWriteReceipt(value) {
  exact(value, ["contract_version", "outcome", "record", "established", "next"], "write_receipt");
  if (value.contract_version !== VERSIONS.write_receipt) throw new TypeError("write receipt version mismatch");
  oneOf(value.outcome, ["established", "idempotent_replay"], "write_receipt.outcome");
  exact(value.record, ["kind", "id"], "write_receipt.record");
  if (value.record.kind !== "compliance_item") throw new TypeError("write receipt record kind mismatch");
  requiredString(value.record.id, "write_receipt.record.id");
  exact(value.established,
    ["compliance_type", "external_credential_number", "effective_from", "effective_through"],
    "write_receipt.established");
  requiredString(value.established.compliance_type, "write_receipt.established.compliance_type");
  requiredString(value.established.external_credential_number,
    "write_receipt.established.external_credential_number");
  isoDate(value.established.effective_from, "write_receipt.established.effective_from");
  isoDate(value.established.effective_through, "write_receipt.established.effective_through");
  exact(value.next, ["kind"], "write_receipt.next");
  if (value.next.kind !== "reread_compliance_standing") throw new TypeError("write receipt next mismatch");
  return value;
}

function validateStandingItem(value, path = "standing.items[]") {
  exact(value, ["entity", "standing", "why", "evidence", "unresolved", "next", "attention", "references"], path);
  exact(value.entity, ["type", "compliance_type", "record_id", "label"], `${path}.entity`);
  if (value.entity.type !== "credential") throw new TypeError(`${path}.entity.type mismatch`);
  for (const key of ["compliance_type", "record_id", "label"]) requiredString(value.entity[key], `${path}.entity.${key}`);
  exact(value.standing, ["code", "as_of"], `${path}.standing`);
  oneOf(value.standing.code, ["current", "expired", "no_current_period_established", "conflicted", "unknown"], `${path}.standing.code`);
  isoDate(value.standing.as_of, `${path}.standing.as_of`, false);
  exact(value.why, ["basis", "effective_from", "effective_through"], `${path}.why`);
  oneOf(value.why.basis, ["established_credential_period", "no_established_period", "conflicting_established_periods", "standing_unavailable"], `${path}.why.basis`);
  isoDate(value.why.effective_from, `${path}.why.effective_from`);
  isoDate(value.why.effective_through, `${path}.why.effective_through`);
  if (!Array.isArray(value.evidence) || !Array.isArray(value.unresolved) || !Array.isArray(value.references))
    throw new TypeError(`${path} evidence, unresolved and references must be arrays`);
  value.evidence.forEach((e, i) => {
    exact(e, ["role", "artifact_id", "label"], `${path}.evidence[${i}]`);
    oneOf(e.role, ["issuance", "supporting"], `${path}.evidence[${i}].role`);
    requiredString(e.artifact_id, `${path}.evidence[${i}].artifact_id`);
    requiredString(e.label, `${path}.evidence[${i}].label`);
  });
  value.unresolved.forEach((u, i) => {
    exact(u, ["code", "detail"], `${path}.unresolved[${i}]`);
    requiredString(u.code, `${path}.unresolved[${i}].code`);
    requiredString(u.detail, `${path}.unresolved[${i}].detail`);
  });
  if (value.next !== null) {
    exact(value.next, ["date", "action", "state"], `${path}.next`);
    isoDate(value.next.date, `${path}.next.date`, false);
    requiredString(value.next.action, `${path}.next.action`);
    oneOf(value.next.state, ["date_only", "action_established"], `${path}.next.state`);
  }
  exact(value.attention, ["state", "obligation_id"], `${path}.attention`);
  oneOf(value.attention.state, ["none_established", "action_established"], `${path}.attention.state`);
  nullableString(value.attention.obligation_id, `${path}.attention.obligation_id`);
  value.references.forEach(validateReference);
}

function validateStanding(value) {
  exact(value, ["contract_version", "capability_classes", "as_of", "coverage", "items", "references"], "standing");
  if (value.contract_version !== VERSIONS.standing) throw new TypeError("standing version mismatch");
  isoDate(value.as_of, "standing.as_of", false);
  validateCapabilityClasses(value.capability_classes, "standing.capability_classes");
  exact(value.coverage, ["state", "meaning"], "standing.coverage");
  oneOf(value.coverage.state, ["unknown", "partial", "established"], "standing.coverage.state");
  requiredString(value.coverage.meaning, "standing.coverage.meaning");
  if (!Array.isArray(value.items) || !Array.isArray(value.references)) throw new TypeError("standing lists required");
  value.items.forEach((item, i) => validateStandingItem(item, `standing.items[${i}]`));
  value.references.forEach(validateReference);
  return value;
}

function validateDetail(value) {
  exact(value, ["contract_version", "capability_classes", "as_of", "item", "history", "references"], "detail");
  if (value.contract_version !== VERSIONS.detail) throw new TypeError("detail version mismatch");
  isoDate(value.as_of, "detail.as_of", false);
  validateCapabilityClasses(value.capability_classes, "detail.capability_classes");
  validateStandingItem(value.item, "detail.item");
  if (!Array.isArray(value.history) || !Array.isArray(value.references)) throw new TypeError("detail lists required");
  value.history.forEach((event, i) => {
    exact(event, ["event", "effective_from", "effective_through", "supersedes_fact_id", "reason", "evidence"], `detail.history[${i}]`);
    oneOf(event.event, ["period_established", "fact_corrected"], `detail.history[${i}].event`);
    isoDate(event.effective_from, `detail.history[${i}].effective_from`);
    isoDate(event.effective_through, `detail.history[${i}].effective_through`);
    nullableString(event.supersedes_fact_id, `detail.history[${i}].supersedes_fact_id`);
    nullableString(event.reason, `detail.history[${i}].reason`);
    if (!Array.isArray(event.evidence)) throw new TypeError(`detail.history[${i}].evidence must be an array`);
    event.evidence.forEach(validateReference);
  });
  value.references.forEach(validateReference);
  return value;
}

function proposalFingerprint(artifactSha256, proposal) {
  validateProposal(proposal);
  return crypto.createHash("sha256")
    .update(`compliance_rental_license_v1\n${artifactSha256}\n${JSON.stringify(proposal)}`)
    .digest("hex");
}

module.exports = {
  VERSIONS, WIRE_CONTRACTS, DOES_NOT_ESTABLISH, PROPOSED_KEYS, UNKNOWN_FIELDS,
  FAILURE_CODES, CAPABILITY_NAMES, retrievalCapabilityReceipt, validateCapabilityClasses,
  validateProposal, validateIntake, validateConfirmationRequest, validateWriteReceipt,
  validateStanding, validateDetail, validateReference, validateFailure,
  proposalFingerprint,
};
