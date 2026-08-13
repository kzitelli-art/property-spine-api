"use strict";

const crypto = require("crypto");
const readerCapabilities = require("../shared/reader_capability_contract.js");

const VERSIONS = Object.freeze({
  proposal: "compliance.rental_license.proposal.v2",
  item_relationship_proposal: "compliance.item_relationship_proposal.v1",
  intake: "compliance.evidence_intake.v2",
  confirmation: "compliance.confirmation_request.v1",
  write_receipt: "compliance.write_receipt.v1",
  standing: "compliance.standing.v3",
  detail: "compliance.detail.v3",
  reference: "compliance.reference.v1",
  failure: "compliance.failure.v1",
});

const WIRE_CONTRACTS = Object.freeze({
  proposal: Object.freeze({ version: VERSIONS.proposal, implementation: "implemented" }),
  intake: Object.freeze({ version: VERSIONS.intake, implementation: "implemented" }),
  confirmation: Object.freeze({ version: VERSIONS.confirmation, implementation: "implemented" }),
  write_receipt: Object.freeze({ version: VERSIONS.write_receipt, implementation: "implemented" }),
  standing: Object.freeze({ version: VERSIONS.standing, implementation: "implemented" }),
  detail: Object.freeze({ version: VERSIONS.detail, implementation: "implemented" }),
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
  "reference_unavailable", "composition_authorization_unavailable",
]);

const CAPABILITY_NAMES = readerCapabilities.CAPABILITY_NAMES;

const V1_OPERATOR_AUTHORITY = Object.freeze({
  establish: "server_property_and_asset_compliance_entitlement",
  correct: "server_property_and_asset_compliance_entitlement",
  actor_attribution: "server_authenticated_operator",
  special_compliance_role_required: false,
});

const V1_WORK_BOUNDARY = Object.freeze({
  action_condition_owner: "compliance",
  assignment_owner: "existing_obligation_engine",
  compliance_assignment_fields: Object.freeze([]),
});

const ITEM_RELATIONSHIP_DOES_NOT_ESTABLISH = Object.freeze([
  "canonical_item_resolution",
  "canonical_compliance_truth",
  "credential_standing",
]);

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
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day) {
    throw new TypeError(`${path} must be a real calendar date`);
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
    requiredString(value.artifact[key], `intake.artifact.${key}`);
  if (!/^[0-9a-f]{64}$/.test(value.artifact.sha256))
    throw new TypeError("intake.artifact.sha256 must be a lowercase SHA-256 digest");
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
  if (!/^[0-9a-f]{64}$/.test(value.artifact_sha256))
    throw new TypeError("confirmation.artifact_sha256 must be a lowercase SHA-256 digest");
  if (!/^[0-9a-f]{64}$/.test(value.proposal_fingerprint))
    throw new TypeError("confirmation.proposal_fingerprint must be a lowercase SHA-256 digest");
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

function validateItemRelationshipProposal(value) {
  exact(value, ["contract_version", "state", "candidate", "basis", "does_not_establish"],
    "item_relationship_proposal");
  if (value.contract_version !== VERSIONS.item_relationship_proposal) {
    throw new TypeError("item relationship proposal version mismatch");
  }
  if (value.state !== "proposed") {
    throw new TypeError("item relationship remains a proposal until server-validated confirmation");
  }
  exact(value.candidate, ["item_id", "item_kind", "compliance_type", "label"],
    "item_relationship_proposal.candidate");
  requiredString(value.candidate.item_id, "item_relationship_proposal.candidate.item_id");
  oneOf(value.candidate.item_kind, ["credential", "finding"],
    "item_relationship_proposal.candidate.item_kind");
  requiredString(value.candidate.compliance_type,
    "item_relationship_proposal.candidate.compliance_type");
  requiredString(value.candidate.label, "item_relationship_proposal.candidate.label");
  exact(value.basis,
    ["subject_match", "authority_match", "item_kind_match", "external_identifier_match"],
    "item_relationship_proposal.basis");
  for (const key of Object.keys(value.basis)) {
    if (typeof value.basis[key] !== "boolean") {
      throw new TypeError(`item_relationship_proposal.basis.${key} must be boolean`);
    }
  }
  if (!value.basis.subject_match || !value.basis.authority_match || !value.basis.item_kind_match) {
    throw new TypeError("an existing-item proposal requires matching subject, authority and item kind");
  }
  if (JSON.stringify(value.does_not_establish) !==
      JSON.stringify(ITEM_RELATIONSHIP_DOES_NOT_ESTABLISH)) {
    throw new TypeError("item relationship proposal authority boundary mismatch");
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
  oneOf(value.entity.type, ["credential", "finding"], `${path}.entity.type`);
  for (const key of ["compliance_type", "record_id", "label"]) requiredString(value.entity[key], `${path}.entity.${key}`);
  exact(value.standing, ["code", "as_of"], `${path}.standing`);
  oneOf(value.standing.code, [
    "current", "expired", "not_yet_effective", "no_current_period_established", "not_established",
    "open", "cure_recorded_awaiting_authority", "authority_closed", "conflicted",
    "unknown",
  ], `${path}.standing.code`);
  isoDate(value.standing.as_of, `${path}.standing.as_of`, false);
  exact(value.why, ["basis", "effective_from", "effective_through"], `${path}.why`);
  oneOf(value.why.basis, [
    "established_credential_period", "future_credential_period",
    "credential_history_without_covering_period", "conflicting_established_periods",
    "insufficient_canonical_facts", "finding_issued_without_closure",
    "cure_without_authority_closure", "authority_disposition_closed",
    "authority_disposition_remains_open", "conflicting_finding_facts",
    "conflicting_authority_dispositions", "no_established_period", "standing_unavailable",
  ], `${path}.why.basis`);
  isoDate(value.why.effective_from, `${path}.why.effective_from`);
  isoDate(value.why.effective_through, `${path}.why.effective_through`);
  if (!Array.isArray(value.evidence) || !Array.isArray(value.unresolved) || !Array.isArray(value.references))
    throw new TypeError(`${path} evidence, unresolved and references must be arrays`);
  value.evidence.forEach((e, i) => {
    exact(e, ["role", "label", "reference"], `${path}.evidence[${i}]`);
    oneOf(e.role, [
      "issuance", "finding", "payment", "cure", "authority_disposition", "supporting",
    ], `${path}.evidence[${i}].role`);
    requiredString(e.label, `${path}.evidence[${i}].label`);
    validateReference(e.reference);
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
  oneOf(value.attention.state,
    ["none_established", "action_established", "upcoming", "action_required", "overdue"],
    `${path}.attention.state`);
  nullableString(value.attention.obligation_id, `${path}.attention.obligation_id`);
  if (value.attention.state === "none_established" && value.attention.obligation_id !== null) {
    throw new TypeError(`${path}.attention cannot carry an obligation without established attention`);
  }
  if (value.attention.state !== "none_established" && value.attention.obligation_id === null) {
    throw new TypeError(`${path}.attention requires a linked obligation`);
  }
  value.references.forEach(validateReference);
}

function validateStanding(value) {
  exact(value, ["contract_version", "capability_classes", "composition_authorization", "as_of", "coverage", "items", "references"], "standing");
  if (value.contract_version !== VERSIONS.standing) throw new TypeError("standing version mismatch");
  isoDate(value.as_of, "standing.as_of", false);
  validateCapabilityClasses(value.capability_classes, "standing.capability_classes");
  if (value.composition_authorization !== "unsolved_cross_domain")
    throw new TypeError("standing cross-domain composition authorization is not governed");
  exact(value.coverage, ["state", "meaning"], "standing.coverage");
  oneOf(value.coverage.state, ["unknown", "partial", "established"], "standing.coverage.state");
  requiredString(value.coverage.meaning, "standing.coverage.meaning");
  if (!Array.isArray(value.items) || !Array.isArray(value.references)) throw new TypeError("standing lists required");
  value.items.forEach((item, i) => validateStandingItem(item, `standing.items[${i}]`));
  value.references.forEach(validateReference);
  return value;
}

function validateDetail(value) {
  exact(value, ["contract_version", "capability_classes", "composition_authorization", "as_of", "item", "history", "references"], "detail");
  if (value.contract_version !== VERSIONS.detail) throw new TypeError("detail version mismatch");
  isoDate(value.as_of, "detail.as_of", false);
  validateCapabilityClasses(value.capability_classes, "detail.capability_classes");
  if (value.composition_authorization !== "unsolved_cross_domain")
    throw new TypeError("detail cross-domain composition authorization is not governed");
  validateStandingItem(value.item, "detail.item");
  if (!Array.isArray(value.history) || !Array.isArray(value.references)) throw new TypeError("detail lists required");
  value.history.forEach((event, i) => {
    exact(event, ["event", "effective_from", "effective_through", "supersedes_fact_id", "reason", "evidence"], `detail.history[${i}]`);
    oneOf(event.event, [
      "period_established", "finding_issued", "payment_observed", "cure_performed",
      "authority_disposition", "fact_corrected",
    ], `detail.history[${i}].event`);
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
    .update(`${VERSIONS.proposal}\n${artifactSha256}\n${JSON.stringify(proposal)}`)
    .digest("hex");
}

module.exports = {
  VERSIONS, WIRE_CONTRACTS, DOES_NOT_ESTABLISH, PROPOSED_KEYS, UNKNOWN_FIELDS,
  FAILURE_CODES, CAPABILITY_NAMES, V1_OPERATOR_AUTHORITY, V1_WORK_BOUNDARY,
  ITEM_RELATIONSHIP_DOES_NOT_ESTABLISH,
  retrievalCapabilityReceipt, validateCapabilityClasses,
  validateProposal, validateIntake, validateConfirmationRequest, validateWriteReceipt,
  validateItemRelationshipProposal,
  validateStanding, validateDetail, validateReference, validateFailure,
  proposalFingerprint,
};
