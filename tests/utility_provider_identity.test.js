"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const utility = require("../src/asset/utility_service.js");
const projection = require("../src/asset/utility_projection.js");

const PROPERTY_A = "property-a";
const PROPERTY_B = "property-b";
const USER = "user-a";

function providerClient() {
  const providers = [];
  return {
    providers,
    async query(sql, params) {
      const text = String(sql);
      if (/select id from properties/i.test(text)) {
        return { rows: [PROPERTY_A, PROPERTY_B].includes(params[0]) ? [{ id: params[0] }] : [] };
      }
      if (/insert into utility_providers/i.test(text)) {
        const normalized = String(params[0]).trim().toLowerCase();
        if (providers.some((provider) => provider.provider_name.toLowerCase() === normalized)) {
          return { rows: [] };
        }
        const row = { id: `provider-${providers.length + 1}`, provider_name: String(params[0]).trim(),
          source_artifact_id: params[1], provenance_note: params[2] };
        providers.push(row);
        return { rows: [row] };
      }
      if (/select \* from utility_providers/i.test(text)) {
        const normalized = String(params[0]).trim().toLowerCase();
        return { rows: providers.filter((provider) =>
          provider.provider_name.toLowerCase() === normalized) };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

function snapshot(propertyId, providerId, suffix, pointLabel) {
  const serviceId = `service-${propertyId}`;
  const accountId = `account-${propertyId}`;
  const pointId = `point-${propertyId}`;
  return {
    property_id: propertyId,
    services: [{ id: serviceId, property_id: propertyId,
      service_class: "electricity", service_label: null }],
    declarations: [{ id: `declaration-${propertyId}`, property_id: propertyId,
      service_id: serviceId, applicability: "present", effective_from: "2026-01-01",
      provenance_note: "confirmed" }],
    providers: [{ id: providerId, provider_name: "PECO" }],
    service_providers: [{ id: `relationship-${propertyId}`, property_id: propertyId,
      service_id: serviceId, provider_id: providerId, effective_from: "2026-01-01",
      provenance_note: "statement" }],
    arrangements: [{ id: `arrangement-${propertyId}`, property_id: propertyId,
      service_id: serviceId, physical_arrangement: "individual_provider_meters",
      provider_bill_recipient: "property", provider_responsible_party: "property",
      economic_responsibility: "property", resident_recovery_method: "none_property_absorbs",
      resident_payment_recipient: "not_applicable", effective_from: "2026-01-01",
      provenance_note: "confirmed" }],
    accounts: [{ id: accountId, property_id: propertyId, provider_id: providerId,
      external_account_identifier: `PECO-${suffix}`, effective_from: "2026-01-01",
      provenance_note: "statement" }],
    account_services: [{ id: `account-service-${propertyId}`, property_id: propertyId,
      account_id: accountId, service_id: serviceId, effective_from: "2026-01-01" }],
    service_points: [{ id: pointId, property_id: propertyId, service_id: serviceId,
      point_kind: "common_area", location_label: pointLabel, effective_from: "2026-01-01",
      provenance_note: "schedule" }],
    meters: [], meter_service_points: [],
    account_service_points: [{ id: `account-point-${propertyId}`, property_id: propertyId,
      account_id: accountId, service_point_id: pointId, effective_from: "2026-01-01" }],
    account_meters: [], statements: [], statement_usage: [],
  };
}

let passed = 0;
function ok(label, fn) { fn(); passed += 1; console.log(`  ok    ${label}`); }

async function main() {
  console.log("\nUTILITY PROVIDER IDENTITY - HOSTILE PROOF\n");
  const db = providerClient();
  const providerA = await utility.establishProvider(db, {
    property_id: PROPERTY_A, provider_name: "PECO",
    provenance_note: "named on Property A statement", user_id: USER,
  });
  const providerB = await utility.establishProvider(db, {
    property_id: PROPERTY_B, provider_name: " peco ",
    provenance_note: "named on Property B statement", user_id: USER,
  });

  ok("the same normalized PECO name resolves to one provider identity", () => {
    assert.strictEqual(providerA.id, providerB.id);
    assert.strictEqual(db.providers.length, 1);
  });
  ok("the writer does not return another property's identity provenance", () => {
    assert.deepStrictEqual(Object.keys(providerB).sort(), ["id", "provider_name"]);
  });

  const positionA = projection.project(snapshot(PROPERTY_A, providerA.id, "1111", "A common area"),
    { as_of: "2026-08-13" });
  const positionB = projection.project(snapshot(PROPERTY_B, providerA.id, "2222", "B common area"),
    { as_of: "2026-08-13" });
  const electricA = positionA.detail.services.find((service) => service.service_class === "electricity");
  const electricB = positionB.detail.services.find((service) => service.service_class === "electricity");

  ok("both property relationships point to the one PECO identity", () => {
    assert.deepStrictEqual(electricA.providers.map((provider) => provider.name), ["PECO"]);
    assert.deepStrictEqual(electricB.providers.map((provider) => provider.name), ["PECO"]);
  });
  ok("accounts and service points remain independent by property", () => {
    assert.strictEqual(electricA.accounts[0].account_identifier_masked.endsWith("1111"), true);
    assert.strictEqual(electricB.accounts[0].account_identifier_masked.endsWith("2222"), true);
    assert.deepStrictEqual(electricA.accounts[0].serves.map((point) => point.label), ["A common area"]);
    assert.deepStrictEqual(electricB.accounts[0].serves.map((point) => point.label), ["B common area"]);
    assert(!JSON.stringify(positionA).includes("2222"));
    assert(!JSON.stringify(positionB).includes("1111"));
  });

  const ddl = fs.readFileSync(path.join(__dirname, "..", "docs",
    "UTILITIES_CANONICAL_SCHEMA_DRAFT.sql"), "utf8");
  const providerBlock = ddl.match(/create table utility_providers \([\s\S]*?\n\);/i)[0];
  ok("provider identity carries neither property nor vendor/payee semantics", () => {
    assert(!/property_id|vendor_id|payee/i.test(providerBlock));
    assert(/provider_name/i.test(providerBlock));
  });

  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
