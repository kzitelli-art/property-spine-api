"use strict";

const assert = require("assert");
const documentRead = require("../src/asset/utility_document_read.js");

let pass = 0;
function ok(label, fn) {
  fn(); pass += 1;
  console.log(`  ok    ${label}`);
}

const statementText = `
Utility Provider: PECO Energy
Account Number: 12-3456-7890
Statement Number: ST-2026-0719
Service Type: Electricity
Service Address: 2116 Chestnut Street, Philadelphia PA 19103
Meter Number: MTR-998877
Service Point ID: SP-2116-COMMON
Bill Date: July 20, 2026
Service Period: June 18, 2026 - July 19, 2026
Due Date: August 8, 2026
New Charges: $18,442.17
Current Amount Due: $18,500.17
Late Fee: $58.00
Total Usage: 123,456 kWh
Reading Type: Actual
`;

console.log("\nUTILITY DOCUMENT READ - PROPOSAL WALLS\n");

ok("a labelled statement proposes the facts it actually states", () => {
  const result = documentRead.propose(statementText, "utility_statement");
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.fields.provider_name, "PECO Energy");
  assert.strictEqual(result.fields.external_account_identifier, "12-3456-7890");
  assert.strictEqual(result.fields.service_class, "electricity");
  assert.strictEqual(result.fields.bill_date, "2026-07-20");
  assert.strictEqual(result.fields.service_period_start, "2026-06-18");
  assert.strictEqual(result.fields.service_period_end, "2026-07-19");
  assert.strictEqual(result.fields.due_date, "2026-08-08");
  assert.strictEqual(result.fields.amount_billed, "18442.17");
  assert.strictEqual(result.fields.current_amount_due, "18500.17");
  assert.deepStrictEqual(result.fields.usage, { quantity: 123456, usage_unit: "kWh" });
  assert.strictEqual(result.fields.usage_basis, "observed");
});

ok("bill date and service period survive as separate concepts", () => {
  const fields = documentRead.propose(statementText, "utility_statement").fields;
  assert.strictEqual(fields.bill_date, "2026-07-20");
  assert.notStrictEqual(fields.bill_date, fields.service_period_end);
});

ok("amount billed is not collapsed into current amount due", () => {
  const fields = documentRead.propose(statementText, "utility_statement").fields;
  assert.strictEqual(fields.amount_billed, "18442.17");
  assert.strictEqual(fields.current_amount_due, "18500.17");
});

ok("a statement never proposes payment, recovery, responsibility, or unit ownership", () => {
  const result = documentRead.propose(`${statementText}\nTenant pays utilities\nPaid in full`,
    "utility_statement");
  const serialized = JSON.stringify(result.fields);
  for (const forbidden of [
    "payment", "paid", "recovery", "lease", "responsibility", "unit_id",
    "meter_kind", "provider_responsible_party", "resident",
  ]) assert(!serialized.includes(forbidden), forbidden);
});

ok("one electric bill does not propose that gas is absent or not applicable", () => {
  const serialized = JSON.stringify(
    documentRead.propose(statementText, "utility_statement").fields);
  assert(!serialized.includes("natural_gas"));
  assert(!serialized.includes("not_applicable"));
});

ok("account and meter suggestions require exact identifier matches", () => {
  const result = documentRead.propose(statementText, "utility_statement", {
    accounts: [
      { id: "account-exact", external_account_identifier: "12-3456-7890" },
      { id: "account-near", external_account_identifier: "12-3456-7899" },
    ],
    meters: [{ id: "meter-exact", meter_identifier: "MTR-998877" }],
  });
  assert.deepStrictEqual(result.associations,
    { account_id: "account-exact", meter_id: "meter-exact" });
});

ok("ambiguous numeric dates remain unknown instead of being guessed", () => {
  const result = documentRead.propose(
    "Bill Date: 03/04/2026\nService Period: 02/01/2026 - 03/01/2026",
    "utility_statement");
  assert.strictEqual(result.fields.bill_date, undefined);
  assert(result.unknown.includes("bill_date"));
  assert(result.unknown.includes("service_period_start"));
});

ok("an unreadable file and an unsupported kind are visibly different", () => {
  const empty = documentRead.propose("", "utility_statement");
  const agreement = documentRead.propose("Provider: PECO", "utility_service_agreement");
  assert.strictEqual(empty.available, false);
  assert(empty.unknown.includes("amount_billed"));
  assert.strictEqual(agreement.available, false);
  assert.deepStrictEqual(agreement.unknown, []);
});

ok("a readable statement with no known labels reports zero findings", () => {
  const result = documentRead.propose("A general letter about the property.",
    "utility_statement");
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.found_count, 0);
  assert.deepStrictEqual(result.fields, {});
});

console.log(`\n${pass} assertions passed\n`);
