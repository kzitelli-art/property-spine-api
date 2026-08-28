"use strict";

const assert = require("assert");
const utility = require("../../src/asset/utility_service.js");

const PROPERTY = "property-a";
const ACCOUNT = "account-a";
const SERVICE = "service-a";
const METER = "meter-a";
const ARTIFACT = "artifact-a";
const USER = "user-a";

let passed = 0;
async function ok(label, fn) {
  await fn(); passed += 1; console.log(`  ok    ${label}`);
}

function client({ serviceMapped = true, meterMapped = true } = {}) {
  let sequence = 0;
  const calls = [];
  return {
    calls,
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (/select \* from utility_provider_accounts/i.test(text)) {
        return { rows: [{ id: ACCOUNT, property_id: PROPERTY }] };
      }
      if (/select scope_type, scope_id from source_artifacts/i.test(text)) {
        return { rows: [{ scope_type: "property", scope_id: PROPERTY }] };
      }
      if (/insert into utility_statements/i.test(text)) {
        sequence += 1; return { rows: [{ id: `statement-${sequence}`, account_id: ACCOUNT }] };
      }
      if (/select \* from utility_services/i.test(text)) {
        return { rows: [{ id: SERVICE, property_id: PROPERTY }] };
      }
      if (/from utility_account_services/i.test(text)) {
        return { rows: serviceMapped ? [{ id: "account-service-a" }] : [] };
      }
      if (/select \* from utility_meters/i.test(text)) {
        return { rows: [{ id: METER, property_id: PROPERTY }] };
      }
      if (/from utility_account_meters/i.test(text)) {
        return { rows: meterMapped ? [{ id: "account-meter-a" }] : [] };
      }
      if (/insert into utility_statement_usage/i.test(text)) {
        return { rows: [{ id: "usage-a" }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

function input(meterId = METER) {
  return {
    property_id: PROPERTY, account_id: ACCOUNT, statement_identifier: "2026-07",
    bill_date: "2026-08-01", service_period_start: "2026-07-01",
    service_period_end: "2026-07-31", currency_code: "USD",
    amount_billed_cents: 12500, source_artifact_id: ARTIFACT, user_id: USER,
    usage: [{ service_id: SERVICE, meter_id: meterId, quantity: 42,
      usage_unit: "kWh", usage_basis: "observed" }],
  };
}

async function rejects(fn, pattern) {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error, "operation unexpectedly succeeded");
  assert(pattern.test(`${error.code || ""} ${error.message || ""}`), error.message);
}

async function main() {
  console.log("\nUTILITY CANONICAL WRITER - STATEMENT MAP WALLS\n");
  await ok("mapped account, service, and meter accept statement usage", async () => {
    const result = await utility.recordStatement(client(), input());
    assert.strictEqual(result.usage.length, 1);
  });
  await ok("an unmapped service cannot enter account statement usage", async () => {
    const db = client({ serviceMapped: false });
    await rejects(() => utility.recordStatement(db, input()),
      /BAD_INPUT.*service is not mapped/i);
    assert(!db.calls.some((sql) => /insert into utility_statements/i.test(sql)));
  });
  await ok("an unmapped meter cannot enter account statement usage", async () => {
    const db = client({ meterMapped: false });
    await rejects(() => utility.recordStatement(db, input()),
      /BAD_INPUT.*meter is not mapped/i);
    assert(!db.calls.some((sql) => /insert into utility_statements/i.test(sql)));
  });
  await ok("usage may remain meter-unknown without inventing a mapping", async () => {
    const result = await utility.recordStatement(client(), input(null));
    assert.strictEqual(result.usage.length, 1);
  });
  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
