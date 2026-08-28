#!/usr/bin/env node
"use strict";

const capabilities = require("../../src/shared/reader_capability_contract.js");
const insuranceDocument = require("../../src/asset/insurance_document_read.js");
const insurancePosition = require("../../src/asset/insurance_position_read.js");
const insuranceStanding = require("../../src/asset/insurance_standing.js");
const taxDocument = require("../../src/asset/tax_document_read.js");
const taxPosition = require("../../src/asset/tax_position_read.js");
const taxRules = require("../../src/asset/philadelphia_tax_rules.js");

const EXPECTED_ASSERTIONS = 26;
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
function retrievalOnly(label, receipt) {
  ok(`${label}: retrieval is claimed`, receipt.retrieval.claim === "claimed");
  ok(`${label}: retrieval basis is named`,
    typeof receipt.retrieval.basis === "string" && receipt.retrieval.basis.length > 10);
  ok(`${label}: comparison and cause are not claimed`,
    receipt.comparison.claim === "not_claimed" && receipt.comparison.basis === null
    && receipt.causal_explanation.claim === "not_claimed"
    && receipt.causal_explanation.basis === null);
}

console.log("ASSET READER CAPABILITIES - retrieval is not comparison or cause");

const base = capabilities.retrievalOnly("canonical facts and a governed as-of rule");
ok("shared vocabulary has exactly three classes",
  Object.keys(base).sort().join() === "causal_explanation,comparison,retrieval");
ok("shared receipt validates", capabilities.validate(base) === base);
ok("shared receipt is immutable", Object.isFrozen(base) && Object.values(base).every(Object.isFrozen));
rejects("a missing class is refused", () => capabilities.validate({ retrieval: base.retrieval }));
rejects("comparison cannot be claimed without its basis", () => capabilities.validate({
  ...base, comparison: { claim: "claimed", basis: null },
}));
rejects("an unclaimed class cannot carry a hidden basis", () => capabilities.validate({
  ...base, comparison: { claim: "not_claimed", basis: "per unit" },
}));

const insuranceProposal = insuranceDocument.propose("Policy Number: ABC-123");
retrievalOnly("insurance proposal", insuranceProposal.capability_classes);

const taxProposal = taxDocument.propose("OPA Number: 881566975", "tax_bill");
retrievalOnly("tax proposal", taxProposal.capability_classes);
ok("unsupported tax evidence still declares what the reader attempted",
  capabilities.validate(taxDocument.propose("certificate", "tax_clearance_certificate")
    .capability_classes));
ok("an empty insurance read does not lose its capability receipt",
  capabilities.validate(insuranceDocument.propose("").capability_classes));
ok("proposal bases name their own domains",
  /insurance/.test(insuranceProposal.capability_classes.retrieval.basis)
  && /tax/.test(taxProposal.capability_classes.retrieval.basis));

const standing = insuranceStanding.standingOf({ coverages: [], asOf: "2026-08-13" });
retrievalOnly("insurance standing", standing.capability_classes);

const emptyDb = { query: async () => ({ rows: [] }) };
(async () => {
  const insurance = await insurancePosition.readPosition(emptyDb,
    { property_id: "property-1", period: "2026-08" });
  retrievalOnly("insurance position", insurance.capability_classes);

  const participation = await insurancePosition.readParticipation(emptyDb,
    { property_id: "property-1", period: "2026-08" });
  ok("insurance participation carries the same explicit contract",
    capabilities.validate(participation.capability_classes) === participation.capability_classes);

  const taxes = await taxPosition.readTaxPosition(emptyDb,
    { property_id: "property-1", as_of: "2026-08-13", rules: taxRules });
  retrievalOnly("tax position", taxes.capability_classes);
  ok("tax derivation remains retrieval, not causal explanation",
    /governed jurisdiction rules/.test(taxes.capability_classes.retrieval.basis));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_ASSERTIONS) {
    console.error(`Assertion census drift: expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}`);
    process.exit(2);
  }
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
