"use strict";

const {
  VERSIONS, DOES_NOT_ESTABLISH, PROPOSED_KEYS, validateProposal,
} = require("./compliance_contracts.js");

const ADAPTER = "philadelphia_rental_license_label_scan";
const ADAPTER_VERSION = "1";

const FIELD_CONCEPT = Object.freeze({
  compliance_type: "credential_identity",
  issuing_authority: "credential_identity",
  external_credential_number: "credential_identity",
  credential_code: "credential_identity",
  commercial_activity_number: "credential_identity",
  legal_entity_name: "credential_subject",
  property_address: "credential_subject",
  unit_count: "credential_subject",
  effective_from: "credential_period",
  effective_through: "credential_period",
});

function emptyProposed() {
  return Object.fromEntries(PROPOSED_KEYS.map((key) => [key, null]));
}

function unknownsFor(proposed, reasons = {}) {
  return PROPOSED_KEYS.filter((field) => proposed[field] === null).map((field) => ({
    concept: FIELD_CONCEPT[field],
    field,
    reason: reasons[field] || "absent",
  }));
}

function result(recognition_state, source_classification, proposed, reasons, reason) {
  return validateProposal({
    contract_version: VERSIONS.proposal,
    recognition_state,
    source_classification,
    proposed,
    unknowns: unknownsFor(proposed, reasons),
    does_not_establish: [...DOES_NOT_ESTABLISH],
    reason,
  });
}

function first(body, pattern) {
  const match = body.match(pattern);
  return match ? String(match[1]).trim() : null;
}

function parsePositiveInteger(raw) {
  if (!/^\d+$/.test(String(raw || "").trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validIso(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month) ||
      date.getUTCDate() !== Number(day)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Bare numeric dates are accepted only when the second component cannot be a
// month. Thus 4/30/2026 is safely M/D/Y; 5/1/2027 remains unknown.
function parseUnambiguousDate(raw) {
  const value = String(raw || "").trim();
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return validIso(match[1], match[2], match[3]);
  match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match && Number(match[2]) > 12 && Number(match[1]) <= 12) {
    return validIso(match[3], match[1], match[2]);
  }
  return null;
}

function isPaymentEvidence(body) {
  return /\b(payment receipt|payment confirmation|amount paid|transaction id)\b/i.test(body);
}

function hasRentalLicenseSignature(body) {
  const signatures = [
    /City of Philadelphia/i,
    /Department of\s+Licenses\s*&\s*Inspections/i,
    /3202\s+Rental\s*\(Residential Dwellings\)/i,
    /THIS LICENSE IS GRANTED TO THE PERSON AND LOCATION/i,
    /LICENSE CODE\s+LICENSE NO\./i,
  ];
  return signatures.filter((pattern) => pattern.test(body)).length >= 4;
}

function propose(text) {
  const body = String(text == null ? "" : text);
  const proposed = emptyProposed();

  if (isPaymentEvidence(body)) {
    return result(
      "unsupported_evidence", "payment_evidence", proposed, {},
      "This document is payment evidence. Payment does not establish issuance, cure, authority closure, standing or an obligation."
    );
  }

  if (!body.trim() || !hasRentalLicenseSignature(body)) {
    const reasons = Object.fromEntries(PROPOSED_KEYS.map((key) => [key, body.trim() ? "absent" : "not_readable"]));
    return result(
      "read_no_match", "unclassified", proposed, reasons,
      body.trim()
        ? "The document text does not carry the authority-issued rental-license signature this adapter requires."
        : "No readable text was available. The retained source remains available for review."
    );
  }

  proposed.compliance_type = "rental_license";
  proposed.issuing_authority = "City of Philadelphia Department of Licenses & Inspections";
  proposed.credential_code = first(body, /\b(3202)\s+Rental\s*\(Residential Dwellings\)/i);
  proposed.external_credential_number =
    first(body, /License Number:\s*\r?\n\s*(\d{6,})\b/i) ||
    first(body, /\b3202\s+(\d{6,})\s+\d{6,}\s+\d{1,2}\//i);
  proposed.commercial_activity_number =
    first(body, /\b3202\s+\d{6,}\s+(\d{6,})\s+\d{1,2}\//i);
  proposed.legal_entity_name =
    first(body, /DISPLAY PROMINENTLY\s*(?:\r?\nif required by law)?\s*\r?\n([^\r\n]{1,120}\bLLC)\s*$/im) ||
    first(body, /^([^\r\n]{1,120}\bLLC)\s*\r?\nBusiness Name:/im);
  proposed.property_address = first(
    body,
    /^([^\r\n]+,\s*Philadelphia,\s*PA\s+\d{5}(?:-\d{4})?)\s*$/im
  );
  proposed.unit_count = parsePositiveInteger(first(body, /Number of Units:\s*(\d+)\b/i));

  const periodRow = body.match(/\b3202\s+\d{6,}\s+\d{6,}\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/i);
  const effectiveThroughRaw = periodRow ? periodRow[1] : null;
  const effectiveFromRaw = periodRow ? periodRow[2] : null;
  proposed.effective_from = parseUnambiguousDate(effectiveFromRaw);
  proposed.effective_through = parseUnambiguousDate(effectiveThroughRaw);

  const reasons = {};
  if (effectiveFromRaw && proposed.effective_from === null) reasons.effective_from = "ambiguous";
  if (effectiveThroughRaw && proposed.effective_through === null) reasons.effective_through = "ambiguous";

  return result(
    "recognized", "authority_issued_credential", proposed, reasons,
    "Spine recognized an authority-issued rental-license form and proposed only explicitly supported values. A person must confirm or correct them before any canonical write."
  );
}

module.exports = {
  ADAPTER, ADAPTER_VERSION, propose, parseUnambiguousDate, hasRentalLicenseSignature,
};
