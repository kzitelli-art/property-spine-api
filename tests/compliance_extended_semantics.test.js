#!/usr/bin/env node
"use strict";

const writeContracts = require("../src/asset/compliance_fact_write_contracts.js");
const factContracts = require("../src/asset/compliance_fact_contracts.js");
const semantics = require("../src/asset/compliance_semantics.js");

let passed = 0;
let failed = 0;
function ok(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
function refuses(label, fn) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  ok(label, !!error, error && error.message);
}

function reference(label) {
  return {
    contract_version: "compliance.reference.v1",
    role: "source_artifact",
    label,
    opener: { kind: "server_minted", token: `token-${label}` },
  };
}

function fact(id, factType, value, role, date = "2026-08-13T12:00:00.000Z") {
  return factContracts.validateFact({
    contract_version: factContracts.FACT_VERSION,
    fact_id: id,
    fact_type: factType,
    established_at: date,
    supersedes_fact_id: null,
    correction_reason: null,
    value,
    evidence: [{ role, label: `${id}.pdf`, reference: reference(id) }],
  });
}

console.log("COMPLIANCE EXTENSION - exact facts and preserved distinctions");

const inspection = fact("inspection-1", "inspection_result", {
  performed_on: "2023-10-16",
  outcome: "passed",
  summary: "Professional engineer recorded the exterior walls and appurtenances as SAFE.",
}, "inspection");
ok("completed inspection is a typed canonical fact", inspection.fact_type === "inspection_result");
const inspectionStanding = semantics.deriveInspectionStanding([inspection], "2026-08-13");
ok("a passed inspection derives passed", inspectionStanding.code === "passed");
ok("inspection result does not invent the next inspection date", inspectionStanding.next === null);
ok("inspection result declares cadence unresolved",
  inspectionStanding.unresolved.some((entry) => entry.code === "next_inspection_not_established"));

const applicability = fact("requirement-1", "requirement_applicability", {
  decided_on: "2023-05-08",
  applicability: "exempt",
  summary: "The authority confirmed the 4233 property row is exempt and no certificate will issue.",
}, "applicability");
const requirementStanding = semantics.deriveRequirementStanding([applicability], "2026-08-13");
ok("authority exemption derives exempt", requirementStanding.code === "exempt");
ok("exemption is distinct from a certificate period",
  applicability.fact_type !== "credential_period");
ok("exemption does not establish recurrence",
  requirementStanding.unresolved.some((entry) => entry.code === "requirement_cadence_not_established"));

const confirmation = {
  contract_version: writeContracts.VERSION,
  artifact_id: "artifact-1",
  artifact_sha256: "a".repeat(64),
  idempotency_key: "inspection-confirmation-1",
  source_reviewed: true,
  item: { existing_item_id: null, item_kind: "inspection", compliance_type: "facade_inspection" },
  fact: { fact_type: "inspection_result", value: inspection.value },
  correction: null,
};
ok("typed inspection confirmation validates", writeContracts.validateConfirmation(confirmation) === confirmation);
refuses("fact type cannot cross its item kind", () => writeContracts.validateConfirmation({
  ...confirmation,
  item: { ...confirmation.item, item_kind: "finding" },
}));
refuses("source review must be explicit", () => writeContracts.validateConfirmation({
  ...confirmation, source_reviewed: false,
}));
refuses("client actor cannot enter the exact confirmation", () => writeContracts.validateConfirmation({
  ...confirmation, actor_user_id: "actor-1",
}));
refuses("client property cannot enter the exact confirmation", () => writeContracts.validateConfirmation({
  ...confirmation, property_id: "property-1",
}));
refuses("Compliance cannot smuggle assignment into the fact", () => writeContracts.validateConfirmation({
  ...confirmation,
  fact: { ...confirmation.fact, assigned_to: "operator-1" },
}));

const elevator = {
  ...confirmation,
  idempotency_key: "elevator-001",
  item: { existing_item_id: null, item_kind: "credential",
    compliance_type: "elevator_certificate_of_operation" },
  fact: { fact_type: "credential_period", value: {
    issuing_authority: "Pennsylvania Department of Labor & Industry",
    external_number: "E1093958",
    subject_identifier: "Equipment 001",
    credential_code: null,
    activity_number: "Permit 202001096",
    legal_entity_name: "4233 Chestnut Partners LLC",
    property_address: "4233 Chestnut St, Philadelphia, PA",
    unit_count: null,
    effective_from: "2025-06-28",
    effective_through: "2027-07-31",
  } },
};
ok("equipment certificate has a typed subject identifier",
  writeContracts.validateConfirmation(elevator).fact.value.subject_identifier === "Equipment 001");
ok("a second equipment identifier can remain a distinct item",
  writeContracts.validateConfirmation({
    ...elevator,
    idempotency_key: "elevator-003",
    fact: { ...elevator.fact, value: { ...elevator.fact.value,
      external_number: "E1093959", subject_identifier: "Equipment 003" } },
  }).fact.value.subject_identifier === "Equipment 003");

const payment = {
  ...confirmation,
  idempotency_key: "payment-71334222",
  item: { existing_item_id: "finding-item-1", item_kind: "finding", compliance_type: "code_violation" },
  fact: { fact_type: "payment_observed", value: {
    observed_on: "2025-12-30", amount_cents: 19000,
    currency_code: "USD", payment_reference: "90259307",
  } },
};
ok("payment is a typed lifecycle observation", writeContracts.validateConfirmation(payment) === payment);
ok("payment fact remains distinct from cure", payment.fact.fact_type !== "cure_performed");
ok("payment fact remains distinct from authority closure",
  payment.fact.fact_type !== "authority_disposition");

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
