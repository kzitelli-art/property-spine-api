"use strict";

const contracts = require("../../../src/asset/compliance_contracts.js");
const facts = require("../../../src/asset/compliance_fact_contracts.js");

function sourceReference(label, token) {
  return {
    contract_version: contracts.VERSIONS.reference,
    role: "source_artifact",
    label,
    opener: { kind: "server_minted", token },
  };
}

// Period values are transcribed from the two authority-issued Solo specimens.
const priorPeriod = {
  contract_version: facts.FACT_VERSION,
  fact_id: "solo-license-period-2026",
  fact_type: "credential_period",
  established_at: "2026-08-13T14:00:00Z",
  supersedes_fact_id: null,
  correction_reason: null,
  value: { effective_from: "2025-05-02", effective_through: "2026-05-01" },
  evidence: [{
    role: "issuance",
    label: "Rental License Exp May 2026",
    reference: sourceReference("Rental License Exp May 2026", "solo-license-2026-source"),
  }],
};

const successorPeriod = {
  contract_version: facts.FACT_VERSION,
  fact_id: "solo-license-period-2027",
  fact_type: "credential_period",
  established_at: "2026-08-13T14:01:00Z",
  supersedes_fact_id: null,
  correction_reason: null,
  value: { effective_from: "2026-04-30", effective_through: "2027-05-01" },
  evidence: [{
    role: "issuance",
    label: "Rental License Exp May 2027",
    reference: sourceReference("Rental License Exp May 2027", "solo-license-2027-source"),
  }],
};

module.exports = { priorPeriod, successorPeriod, sourceReference };
