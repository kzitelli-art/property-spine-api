#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const contracts = require("../../src/asset/compliance_contracts.js");
const facts = require("../../src/asset/compliance_fact_contracts.js");
const semantics = require("../../src/asset/compliance_semantics.js");
const solo = require("../fixtures/compliance/solo_license_periods.js");

const EXPECTED_ASSERTIONS = 24;
let pass = 0, fail = 0;
function ok(label, condition) {
  if (condition) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label); }
}
function rejects(label, fn) {
  let rejected = false;
  try { fn(); } catch (_) { rejected = true; }
  ok(label, rejected);
}

console.log("COMPLIANCE OWNER RULINGS - authority, continuity, correction, work boundary");

const authority = contracts.V1_OPERATOR_AUTHORITY;
ok("authorized property operator may establish",
  authority.establish === "server_property_and_asset_compliance_entitlement");
ok("the same authorized population may correct", authority.correct === authority.establish);
ok("no special Compliance administrator role is required",
  authority.special_compliance_role_required === false);
ok("canonical attribution names the authenticated operator",
  authority.actor_attribution === "server_authenticated_operator");

const confirmation = {
  contract_version: contracts.VERSIONS.confirmation,
  artifact_id: "artifact-1",
  artifact_sha256: "a".repeat(64),
  proposal_fingerprint: "b".repeat(64),
  idempotency_key: "confirm-license-period",
  confirmed: {
    compliance_type: "rental_license",
    issuing_authority: "City authority",
    external_credential_number: "922616",
    credential_code: "3202",
    commercial_activity_number: "920786",
    legal_entity_name: "4233 Chestnut LLC",
    property_address: "4233 CHESTNUT ST",
    unit_count: 281,
    effective_from: "2026-04-30",
    effective_through: "2027-05-01",
  },
  correction: null,
};
ok("confirmation contains no authoritative client actor", !("actor_id" in confirmation));
ok("confirmation contains no authoritative client property", !("property_id" in confirmation));
rejects("client actor injection is refused", () =>
  contracts.validateConfirmationRequest({ ...confirmation, actor_id: "user-elsewhere" }));
rejects("client property injection is refused", () =>
  contracts.validateConfirmationRequest({ ...confirmation, property_id: "property-elsewhere" }));

const corrected = {
  ...solo.priorPeriod,
  fact_id: "corrected-license-period",
  established_at: "2026-08-13T15:00:00Z",
  supersedes_fact_id: solo.priorPeriod.fact_id,
  correction_reason: "Corrected from the authority-issued credential.",
};
ok("a correction with predecessor and reason validates", facts.validateFact(corrected) === corrected);
rejects("a correction without reason is refused", () =>
  facts.validateFact({ ...corrected, correction_reason: null }));
const history = semantics.buildEffectiveHistory([solo.priorPeriod, corrected]);
ok("correction preserves the predecessor in history", history.entries.length === 2);
ok("correction preserves the predecessor's provenance",
  history.entries[0].fact.evidence[0].reference.opener.token ===
    solo.priorPeriod.evidence[0].reference.opener.token);
ok("correction excludes the predecessor from effective facts",
  !history.effective_facts.some((fact) => fact.fact_id === solo.priorPeriod.fact_id));

const relationship = {
  contract_version: contracts.VERSIONS.item_relationship_proposal,
  state: "proposed",
  candidate: {
    item_id: "canonical-license-item",
    item_kind: "credential",
    compliance_type: "rental_license",
    label: "Rental License #922616",
  },
  basis: {
    subject_match: true,
    authority_match: true,
    item_kind_match: true,
    external_identifier_match: true,
  },
  does_not_establish: [...contracts.ITEM_RELATIONSHIP_DOES_NOT_ESTABLISH],
};
ok("existing-item continuity may be proposed",
  contracts.validateItemRelationshipProposal(relationship) === relationship);
ok("identifier recognition remains only proposal basis",
  relationship.basis.external_identifier_match && relationship.state === "proposed");
ok("relationship proposal explicitly does not resolve the canonical item",
  relationship.does_not_establish.includes("canonical_item_resolution"));
rejects("identifier recognition cannot declare an established relationship", () =>
  contracts.validateItemRelationshipProposal({ ...relationship, state: "established" }));
rejects("a subject mismatch cannot propose continuity", () =>
  contracts.validateItemRelationshipProposal({
    ...relationship, basis: { ...relationship.basis, subject_match: false },
  }));
rejects("the browser cannot add property authority to the relationship proposal", () =>
  contracts.validateItemRelationshipProposal({ ...relationship, property_id: "property-elsewhere" }));

const actionCondition = {
  state: "established",
  action: "Submit authority response",
  due_on: "2026-09-01",
  obligation_id: "obligation-1",
};
ok("an action condition requires the existing obligation link",
  facts.validateActionCondition(actionCondition) === actionCondition);
rejects("an unlinked action condition cannot bypass the obligation engine", () =>
  facts.validateActionCondition({ ...actionCondition, obligation_id: null }));
ok("Compliance owns the action condition, not assignment",
  contracts.V1_WORK_BOUNDARY.action_condition_owner === "compliance");
ok("the existing obligation engine owns assignment",
  contracts.V1_WORK_BOUNDARY.assignment_owner === "existing_obligation_engine");
const complianceSource = [
  "compliance_contracts.js", "compliance_fact_contracts.js", "compliance_semantics.js",
  "compliance_projection.js",
].map((file) => fs.readFileSync(path.join(__dirname, "../../src/asset", file), "utf8")).join("\n");
ok("Compliance declares no assignment shortcut",
  contracts.V1_WORK_BOUNDARY.compliance_assignment_fields.length === 0 &&
  !/\b(owner_id|assigned_to|assigned_user_id)\b/.test(complianceSource));

console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_ASSERTIONS) {
  console.error(`Assertion census drift: expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}`);
  process.exit(2);
}
process.exit(fail ? 1 : 0);
