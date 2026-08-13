#!/usr/bin/env node
"use strict";

const contracts = require("../src/asset/compliance_contracts.js");
const reader = require("../src/asset/compliance_document_read.js");

const EXPECTED_ASSERTIONS = 39;
let pass = 0, fail = 0;
function ok(label, condition, detail) {
  if (condition) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
function rejects(label, fn) {
  let rejected = false;
  try { fn(); } catch (_) { rejected = true; }
  ok(label, rejected);
}

console.log("COMPLIANCE CONTRACTS - exact wires and implementation state");

ok("proposal contract is implemented", contracts.WIRE_CONTRACTS.proposal.implementation === "implemented");
ok("intake contract is implemented", contracts.WIRE_CONTRACTS.intake.implementation === "implemented");
for (const name of ["confirmation", "write_receipt", "standing", "detail"]) {
  ok(`${name} is implemented`, contracts.WIRE_CONTRACTS[name].implementation === "implemented");
}
ok("HTTP reference opening remains explicitly future",
  contracts.WIRE_CONTRACTS.reference.implementation === "future_unimplemented");

const proposal = reader.propose("ordinary correspondence");
ok("proposal validator accepts the live reader", contracts.validateProposal(proposal) === proposal);
ok("proposal names its retrieval basis", /document labels/i.test(proposal.capability_classes.retrieval.basis));
rejects("proposal cannot claim comparison without a basis", () => contracts.validateProposal({
  ...proposal,
  capability_classes: {
    ...proposal.capability_classes,
    comparison: { claim: "claimed", basis: null },
  },
}));
rejects("an unclaimed class cannot smuggle a basis", () => contracts.validateProposal({
  ...proposal,
  capability_classes: {
    ...proposal.capability_classes,
    comparison: { claim: "not_claimed", basis: "per unit" },
  },
}));
rejects("proposal refuses arbitrary fact JSON", () => contracts.validateProposal({
  ...proposal, proposed: { ...proposal.proposed, fact_type: "anything" },
}));
rejects("proposal refuses a standing claim", () => contracts.validateProposal({ ...proposal, standing: "current" }));

const confirmation = {
  contract_version: contracts.VERSIONS.confirmation,
  artifact_id: "artifact-1",
  artifact_sha256: "a".repeat(64),
  proposal_fingerprint: "b".repeat(64),
  idempotency_key: "confirm-1",
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
    effective_through: null,
  },
  correction: null,
};
ok("confirmation request is typed and exact", contracts.validateConfirmationRequest(confirmation) === confirmation);
rejects("confirmation refuses a missing artifact identity", () =>
  contracts.validateConfirmationRequest({ ...confirmation, artifact_id: null }));
rejects("confirmation refuses a malformed artifact digest", () =>
  contracts.validateConfirmationRequest({ ...confirmation, artifact_sha256: "not-a-digest" }));
ok("confirmation carries no actor identity", !("actor_id" in confirmation));
ok("confirmation carries no property authority claim", !("property_id" in confirmation));
rejects("browser cannot add property_id to confirmation", () =>
  contracts.validateConfirmationRequest({ ...confirmation, property_id: "property-other" }));

const receipt = {
  contract_version: contracts.VERSIONS.write_receipt,
  outcome: "established",
  record: { kind: "compliance_item", id: "item-1" },
  established: {
    compliance_type: "rental_license", external_credential_number: "922616",
    effective_from: "2026-04-30", effective_through: null,
  },
  next: { kind: "reread_compliance_standing" },
};
ok("write receipt requires canonical reread", contracts.validateWriteReceipt(receipt) === receipt);
rejects("write receipt refuses optimistic embedded standing", () =>
  contracts.validateWriteReceipt({ ...receipt, standing: "current" }));

const reference = {
  contract_version: contracts.VERSIONS.reference,
  role: "source_artifact",
  label: "City rental license",
  opener: { kind: "server_minted", token: "opaque-open-token" },
};
ok("reference requires a server-minted opener", contracts.validateReference(reference) === reference);
rejects("reference refuses an empty opener token", () =>
  contracts.validateReference({ ...reference, opener: { kind: "server_minted", token: null } }));
rejects("reference refuses a raw URL", () => contracts.validateReference({ ...reference, url: "https://example.test" }));

const item = {
  entity: { type: "credential", compliance_type: "rental_license", record_id: "item-1", label: "Rental License #922616" },
  standing: { code: "current", as_of: "2026-08-13" },
  why: { basis: "established_credential_period", effective_from: "2026-04-30", effective_through: "2027-05-01" },
  evidence: [{ role: "issuance", label: "City license", reference }],
  unresolved: [{ code: "renewal_not_established", detail: "An expiration date is not a renewal obligation." }],
  next: { date: "2027-05-01", action: "License period ends", state: "date_only" },
  attention: { state: "none_established", obligation_id: null },
  references: [reference],
};
const standing = {
  contract_version: contracts.VERSIONS.standing,
  capability_classes: contracts.retrievalCapabilityReceipt(
    "canonical Compliance standing and its recorded derivation basis"),
  composition_authorization: "unsolved_cross_domain",
  as_of: "2026-08-13",
  coverage: { state: "unknown", meaning: "No requirement census has been established." },
  items: [item],
  references: [reference],
};
ok("standing separates coverage from credential standing", contracts.validateStanding(standing) === standing);
ok("unknown census is represented without an empty-good inference", standing.coverage.state === "unknown");
ok("standing separates date from action", standing.items[0].next.state === "date_only");
ok("standing separates attention from standing", standing.items[0].attention.state === "none_established");
ok("standing claims retrieval only", standing.capability_classes.retrieval.claim === "claimed" &&
  standing.capability_classes.comparison.claim === "not_claimed" &&
  standing.capability_classes.causal_explanation.claim === "not_claimed");
ok("standing flags cross-domain composition as unsolved",
  standing.composition_authorization === "unsolved_cross_domain");
ok("standing evidence exposes a server reference, not an artifact id",
  !("artifact_id" in standing.items[0].evidence[0])
  && standing.items[0].evidence[0].reference.opener.kind === "server_minted");
rejects("standing refuses an invented composition authorization", () => contracts.validateStanding({
  ...standing, composition_authorization: "endpoint_authorized",
}));
rejects("standing refuses an impossible calendar date", () => contracts.validateStanding({
  ...standing, as_of: "2026-02-30",
}));
rejects("standing refuses arbitrary why inputs", () => contracts.validateStanding({
  ...standing, items: [{ ...item, why: { ...item.why, inputs: { guessed: true } } }],
}));

const detail = {
  contract_version: contracts.VERSIONS.detail,
  capability_classes: contracts.retrievalCapabilityReceipt(
    "canonical Compliance record, evidence and correction history"),
  composition_authorization: "unsolved_cross_domain",
  as_of: "2026-08-13",
  item,
  history: [{
    event: "period_established", effective_from: "2026-04-30", effective_through: "2027-05-01",
    supersedes_fact_id: null, reason: "Confirmed from authority-issued credential", evidence: [reference],
  }],
  references: [reference],
};
ok("detail contract carries typed history", contracts.validateDetail(detail) === detail);
rejects("detail refuses an undeclared capability class", () => contracts.validateDetail({
  ...detail,
  capability_classes: { ...detail.capability_classes, forecasting: { claim: "claimed", basis: "trend" } },
}));
ok("comparison remains absent rather than silently inferred", detail.capability_classes.comparison.claim === "not_claimed");

const failure = {
  contract_version: contracts.VERSIONS.failure,
  code: "recognition_failed",
  message: "Source retained; recognition failed.",
  retryable: true,
  artifact: { id: "artifact-1", retained: true },
};
ok("failure can prove retention", contracts.validateFailure(failure) === failure);
rejects("failure cannot claim a returned artifact was discarded", () =>
  contracts.validateFailure({ ...failure, artifact: { id: "artifact-1", retained: false } }));

console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_ASSERTIONS) {
  console.error(`Assertion census drift: expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}`);
  process.exit(2);
}
process.exit(fail ? 1 : 0);
