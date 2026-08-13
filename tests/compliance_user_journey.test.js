#!/usr/bin/env node
"use strict";

const contracts = require("../src/asset/compliance_contracts.js");

const EXPECTED_ASSERTIONS = 23;
let pass = 0, fail = 0;
function ok(label, condition, detail) {
  if (condition) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const sourceReference = {
  contract_version: contracts.VERSIONS.reference,
  role: "source_artifact",
  label: "City rental license",
  opener: { kind: "server_minted", token: "open-source-opaque-token" },
};
const recordReference = {
  contract_version: contracts.VERSIONS.reference,
  role: "canonical_record",
  label: "Rental License #922616",
  opener: { kind: "server_minted", token: "open-record-opaque-token" },
};
const item = {
  entity: {
    type: "credential", compliance_type: "rental_license",
    record_id: "compliance-record-1", label: "Rental License #922616",
  },
  standing: { code: "current", as_of: "2026-08-13" },
  why: {
    basis: "established_credential_period",
    effective_from: "2026-04-30", effective_through: "2027-05-01",
  },
  evidence: [{ role: "issuance", label: "City rental license", reference: sourceReference }],
  unresolved: [{
    code: "renewal_not_established",
    detail: "An expiration date is not an established renewal obligation.",
  }],
  next: { date: "2027-05-01", action: "License period ends", state: "date_only" },
  attention: { state: "none_established", obligation_id: null },
  references: [recordReference, sourceReference],
};
const standing = {
  contract_version: contracts.VERSIONS.standing,
  capability_classes: contracts.retrievalCapabilityReceipt(
    "canonical Compliance standing and recorded derivation basis"),
  composition_authorization: "unsolved_cross_domain",
  as_of: "2026-08-13",
  coverage: {
    state: "unknown",
    meaning: "No complete census of property requirements has been established.",
  },
  items: [item],
  references: [recordReference, sourceReference],
};

console.log("COMPLIANCE USER JOURNEY - question-first contract, no conversational write");

ok("the governed standing receipt validates", contracts.validateStanding(standing) === standing);
ok("the receipt claims retrieval", standing.capability_classes.retrieval.claim === "claimed");
ok("the receipt does not claim comparison", standing.capability_classes.comparison.claim === "not_claimed");
ok("the receipt does not claim causal explanation",
  standing.capability_classes.causal_explanation.claim === "not_claimed");
ok("standing is explicitly as-of dated", standing.as_of === "2026-08-13");
ok("unknown requirement census is not presented as complete", standing.coverage.state === "unknown");

ok("'Is our rental license current?' is answerable", item.standing.code === "current");
ok("'Why?' is answerable from a recorded derivation basis",
  item.why.basis === "established_credential_period");
ok("'What evidence?' is answerable", item.evidence.length === 1 && item.evidence[0].role === "issuance");
ok("'When does it expire?' is answerable", item.why.effective_through === "2027-05-01");
ok("'Show me the license' has a source reference",
  item.references.some((r) => r.role === "source_artifact"));
ok("the canonical record is independently openable",
  item.references.some((r) => r.role === "canonical_record"));
ok("'What needs action?' reads attention, not standing", item.attention.state === "none_established");
ok("expiration remains a date-only next event", item.next.state === "date_only");
ok("the unresolved renewal distinction travels with the answer",
  item.unresolved.some((u) => u.code === "renewal_not_established"));

ok("every opener is server minted",
  standing.references.every((r) => r.opener.kind === "server_minted"));
ok("evidence carries no raw artifact id", !("artifact_id" in item.evidence[0]));
ok("the composer must not treat its one-property route as composition authority",
  standing.composition_authorization === "unsolved_cross_domain");

const compositionFailure = {
  contract_version: contracts.VERSIONS.failure,
  code: "composition_authorization_unavailable",
  message: "This answer would combine domains without a governed composition authorization.",
  retryable: false,
  artifact: null,
};
ok("cross-domain composition has an honest failure state",
  contracts.validateFailure(compositionFailure) === compositionFailure);

const confirmation = {
  contract_version: contracts.VERSIONS.confirmation,
  artifact_id: "artifact-1",
  artifact_sha256: "a".repeat(64),
  proposal_fingerprint: "b".repeat(64),
  idempotency_key: "confirm-license-922616",
  confirmed: {
    compliance_type: "rental_license",
    issuing_authority: "City of Philadelphia Department of Licenses & Inspections",
    external_credential_number: "922616",
    credential_code: "3202",
    commercial_activity_number: "920786",
    legal_entity_name: "4233 Chestnut LLC",
    property_address: "4233 CHESTNUT ST, Philadelphia, PA 19104-3094",
    unit_count: 281,
    effective_from: "2026-04-30",
    effective_through: "2027-05-01",
  },
  correction: null,
};
ok("confirmation request validates", contracts.validateConfirmationRequest(confirmation) === confirmation);
ok("browser confirmation carries no property authority", !("property_id" in confirmation));
ok("browser confirmation carries no actor authority", !("actor_id" in confirmation));
ok("all six natural questions map to domain-owned fields",
  !!(item.standing.code && item.why.basis && item.evidence.length
     && item.why.effective_through && item.references.length && item.attention.state));

console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_ASSERTIONS) {
  console.error(`Assertion census drift: expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}`);
  process.exit(2);
}
process.exit(fail ? 1 : 0);
