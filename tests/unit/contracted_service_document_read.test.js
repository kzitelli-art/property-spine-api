"use strict";

const assert = require("assert");
const reader = require("../../src/asset/contracted_service_document_read.js");

let passed = 0;
function ok(label, fn) {
  fn(); passed += 1; console.log(`  ok    ${label}`);
}

console.log("\nCONTRACTED SERVICES DOCUMENT RECOGNITION - PROPOSAL WALL\n");

ok("cleaning agreement facts remain offered when signature fields are blank", () => {
  const result = reader.propose(`
    CLEANING SERVICES AGREEMENT
    Contractor: Angel Cleaning Services LLC
    Customer: Chestnut Owner LLC
    Service Scope: Building cleaning and janitorial services
    Start Date: January 1, 2026
    End Date: December 31, 2026
    Service will be performed Monday through Friday.
    Fee: $6,800.00 per month
    Either party may terminate upon 45 days written notice.
    Contractor Signature: ____________________
    Customer Signature: ____________________
    Date: ____________________
  `, "contracted_service_agreement");
  assert.strictEqual(result.fields.document_kind, "agreement");
  assert.strictEqual(result.fields.execution_state, "unsigned");
  assert.strictEqual(result.fields.provider_name, "Angel Cleaning Services LLC");
  assert.strictEqual(result.fields.service_class, "building_cleaning");
  assert.strictEqual(result.term.term_authority, "offered");
  assert.strictEqual(result.term.commencement_date, "2026-01-01");
  assert.strictEqual(result.term.initial_end_date, "2026-12-31");
  assert.strictEqual(result.term.notice_days, 45);
  assert.strictEqual(result.price_components[0].amount_cents, 680000);
  assert.strictEqual(result.price_components[0].price_basis, "monthly");
});

ok("trash renewal language exposes a clock without claiming the outcome", () => {
  const result = reader.propose(`
    WASTE REMOVAL SERVICE CONTRACT
    Vendor: Philly-Wide Disposal LLC
    Effective Date: January 1, 2024
    Initial End Date: December 31, 2026
    Price: $2,000.00 monthly
    This agreement automatically renews for successive 3 year periods unless either party
    gives 90 days prior written notice.
    Authorized Signature: ____________________
  `, "contracted_service_agreement");
  assert.strictEqual(result.fields.service_class, "waste_removal");
  assert.strictEqual(result.term.automatic_renewal, true);
  assert.strictEqual(result.term.renewal_period_months, 36);
  assert.strictEqual(result.term.notice_days, 90);
  assert(!("renewal_outcome" in result.term));
});

ok("installation-triggered terms retain the trigger and duration without inventing dates", () => {
  const result = reader.propose(`
    RESIDENT AMENITY AGREEMENT
    Provider: PrintWithMe, LLC
    The initial term begins on the Installation Date and continues for one (1) year.
    The agreement automatically renews for successive 1 year periods.
    Customer Signature: ____________________
  `, "contracted_service_agreement");
  assert.strictEqual(result.term.term_kind, "fixed");
  assert(/installation date/i.test(result.term.commencement_trigger));
  assert.strictEqual(result.term.initial_term_months, 12);
  assert.strictEqual(result.term.commencement_date, null);
  assert.strictEqual(result.term.initial_end_date, null);
});

ok("anniversary prose retains a numeric duration", () => {
  const result = reader.propose(`
    PACKAGE LOCKER AMENDMENT
    Provider: Amazon.com Services LLC
    The term begins upon installation and activation and continues until the day before
    the fifth anniversary of installation and activation.
  `, "contracted_service_amendment");
  assert.strictEqual(result.term.initial_term_months, 60);
  assert(/installation and activation/i.test(result.term.commencement_trigger));
});

ok("landscaping price ranges remain variable descriptions", () => {
  const result = reader.propose(`
    LANDSCAPING PROPOSAL
    Contractor: Wolf Landscaping
    Services Provided: Landscaping and groundskeeping every biweekly visit
    Pricing: $300-$400 per visit depending on seasonal scope
    This proposal is invalid unless signed.
    Signature: ____________________
  `, "contracted_service_proposal");
  assert.strictEqual(result.fields.document_kind, "proposal");
  assert.strictEqual(result.fields.execution_state, "unsigned");
  assert.strictEqual(result.term.term_authority, "offered");
  assert.strictEqual(result.price_components[0].price_basis, "variable");
  assert.strictEqual(result.price_components[0].amount_cents, null);
  assert(/\$300-\$400/.test(result.price_components[0].description));
});

ok("executed-looking elevator text still cannot execute itself", () => {
  const result = reader.propose(`
    ELEVATOR MAINTENANCE AGREEMENT
    Service Provider: Fujitec America, Inc.
    Effective Date: November 11, 2024
    Commencement Date: January 1, 2025
    Initial End Date: January 1, 2026
    Quarterly elevator maintenance service: $150.00 per month
    This agreement automatically renews for 5 year periods.
    Written notice must be delivered no later than 90 days before expiration.
    Authorized by: Jamie Manager
  `, "contracted_service_agreement");
  assert.strictEqual(result.fields.execution_state, "unverified");
  assert.strictEqual(result.signature_evidence, "execution_not_established_from_text");
  assert.strictEqual(result.term.term_authority, "offered");
  assert.strictEqual(result.term.renewal_period_months, 60);
  assert.strictEqual(result.term.notice_days, 90);
});

ok("an unexecuted proposal filename class cannot become a contract", () => {
  const result = reader.propose(`
    OTIS ELEVATOR SERVICE PROPOSAL
    Provider: Otis Elevator Company
    Service Scope: Elevator maintenance
    Proposed Fee: $725.00 per month
    Customer Signature: ____________________
  `, "contracted_service_proposal");
  assert.strictEqual(result.fields.document_kind, "proposal");
  assert.strictEqual(result.fields.execution_state, "unsigned");
  assert.strictEqual(result.term.term_authority, "offered");
});

ok("invoice evidence warns that it does not prove agreement or payment", () => {
  const result = reader.propose(`
    INVOICE
    Vendor: Example Pest Control
    Service: Pest control
    Invoice total: $250.00
  `, "contracted_service_invoice");
  assert.strictEqual(result.fields.document_kind, "invoice");
  assert(result.warnings.some((warning) => /does not establish an agreement/i.test(warning)));
  assert(!result.fields.amount_paid_cents);
});

ok("unreadable evidence preserves unknowns", () => {
  const result = reader.propose("", "contracted_service_agreement");
  assert.strictEqual(result.available, false);
  assert.strictEqual(result.authority, "proposal_only");
  assert(result.unknown.includes("execution_state"));
});

console.log(`\n${passed} assertions passed\n`);
