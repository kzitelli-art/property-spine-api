#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const reader = require("../../src/asset/compliance_document_read.js");
const contracts = require("../../src/asset/compliance_contracts.js");

const EXPECTED_ASSERTIONS = 43;
let pass = 0, fail = 0;
function ok(label, condition, detail) {
  if (condition) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const fixture = fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "compliance", "solo_4233_rental_license.txt"), "utf8")
  .replace(/\r\n/g, "\n");

console.log("COMPLIANCE DOCUMENT READER - real City specimen, no database");

const proposal = reader.propose(fixture);
ok("real specimen is recognized", proposal.recognition_state === "recognized", JSON.stringify(proposal));
ok("classification comes from the authority-issued form", proposal.source_classification === "authority_issued_credential");
ok("compliance type is narrow", proposal.proposed.compliance_type === "rental_license");
ok("issuing authority is explicit", proposal.proposed.issuing_authority === "City of Philadelphia Department of Licenses & Inspections");
ok("license number is explicit", proposal.proposed.external_credential_number === "922616");
ok("credential code is explicit", proposal.proposed.credential_code === "3202");
ok("commercial activity number is explicit", proposal.proposed.commercial_activity_number === "920786");
ok("legal entity is explicit", proposal.proposed.legal_entity_name === "4233 Chestnut LLC");
ok("property address is explicit", proposal.proposed.property_address === "4233 CHESTNUT ST, Philadelphia, PA 19104-3094");
ok("unit count is typed", proposal.proposed.unit_count === 281);
ok("unambiguous effective date is ISO", proposal.proposed.effective_from === "2026-04-30");
ok("ambiguous expiration stays blank", proposal.proposed.effective_through === null);
ok("ambiguous expiration is named", proposal.unknowns.some((u) => u.field === "effective_through" && u.reason === "ambiguous"));
ok("proposal satisfies the governed contract", contracts.validateProposal(proposal) === proposal);
ok("reader explicitly claims retrieval", proposal.capability_classes.retrieval.claim === "claimed");
ok("reader does not claim comparison", proposal.capability_classes.comparison.claim === "not_claimed");
ok("reader does not claim causal explanation", proposal.capability_classes.causal_explanation.claim === "not_claimed");

const misleadingMetadata = reader.propose(fixture, {
  filename: "totally-not-a-license.txt", folder: "99. Wrong Folder",
});
ok("wrong folder cannot block content recognition", misleadingMetadata.recognition_state === "recognized");
ok("filename cannot alter the proposed number", misleadingMetadata.proposed.external_credential_number === "922616");
ok("metadata is outside the adapter contract", reader.propose.length === 1);

const filenameOnly = reader.propose("ordinary correspondence", {
  filename: "Rental License 922616.pdf", folder: "09. Compliance",
});
ok("a convincing filename cannot classify content", filenameOnly.recognition_state === "read_no_match");
ok("filename-only input remains unclassified", filenameOnly.source_classification === "unclassified");

const productionPdfParseLayout = reader.propose(`City of Philadelphia
Department of
Licenses & Inspections
DISPLAY PROMINENTLY
if required by law
4233 Chestnut LLC
3202Rental (Residential Dwellings)
4233 Chestnut LLC
4233 CHESTNUT ST, Philadelphia, PA 19104-3094
Owner is Managing Agent: YesNumber of Units: 281
THIS LICENSE IS GRANTED TO THE PERSON AND LOCATION FOR THE PURPOSE STATED ABOVE.
LICENSE CODELICENSE NO.
3202922616
920786
5/1/20274/30/2026
License Number:
922616`);
ok("production PDF extraction layout is recognized",
  productionPdfParseLayout.recognition_state === "recognized");
ok("collapsed code and label spacing preserves the credential code",
  productionPdfParseLayout.proposed.credential_code === "3202");
ok("the explicit license-number label survives collapsed table columns",
  productionPdfParseLayout.proposed.external_credential_number === "922616");
ok("the compact table preserves the commercial activity number",
  productionPdfParseLayout.proposed.commercial_activity_number === "920786");
ok("the compact table preserves the unambiguous effective date",
  productionPdfParseLayout.proposed.effective_from === "2026-04-30");
ok("the compact table still leaves the ambiguous expiration unknown",
  productionPdfParseLayout.proposed.effective_through === null &&
  productionPdfParseLayout.unknowns.some((u) =>
    u.field === "effective_through" && u.reason === "ambiguous"));

const payment = reader.propose(`City of Philadelphia\nRental License 922616\nPAYMENT RECEIPT\nAmount Paid: $250.00\nTransaction ID: A1`);
ok("payment is identified as payment evidence", payment.source_classification === "payment_evidence");
ok("payment cannot propose issuance", payment.recognition_state === "unsupported_evidence");
ok("payment proposes no credential number", payment.proposed.external_credential_number === null);
ok("payment proposes no credential period", payment.proposed.effective_from === null && payment.proposed.effective_through === null);

const absent = reader.propose(fixture
  .replace("3202 922616 920786 5/1/2027 4/30/2026", "3202 Rental License detail unavailable")
  .replace("License Number:\n922616", "License Number:"));
ok("absent license number stays null", absent.proposed.external_credential_number === null);
ok("absent license number is explicit unknown", absent.unknowns.some((u) => u.field === "external_credential_number" && u.reason === "absent"));

ok("ambiguous numeric date is refused", reader.parseUnambiguousDate("03/04/2026") === null);
ok("second component over twelve licenses US order", reader.parseUnambiguousDate("4/30/2026") === "2026-04-30");
ok("invalid calendar date is refused", reader.parseUnambiguousDate("2/30/2026") === null);

ok("proposal has no standing field", !("standing" in proposal));
ok("proposal has no compliance conclusion", !("property_compliance" in proposal));
ok("proposal has no obligation", !("obligation" in proposal.proposed));
ok("authority boundary is explicit", JSON.stringify(proposal.does_not_establish) === JSON.stringify(contracts.DOES_NOT_ESTABLISH));
ok("there is no generic fact_type escape hatch", !JSON.stringify(proposal).includes("fact_type"));

const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "asset", "compliance_document_read.js"), "utf8");
ok("reader has no canonical write authority", !/\.query\s*\(|\binsert\s+into\b|obligation_service|standing_service/i.test(source));

console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_ASSERTIONS) {
  console.error(`Assertion census drift: expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}`);
  process.exit(2);
}
process.exit(fail ? 1 : 0);
