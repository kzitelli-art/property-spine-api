"use strict";

const assert = require("assert");
const detailRead = require("../src/asset/utility_ask_detail.js");

const PROPERTY_A = "property-a";
const PROPERTY_B = "property-b";

function rowSet(propertyId = PROPERTY_A) {
  return {
    utility_services: [
      { id: "service-electric", property_id: propertyId,
        service_class: "electricity", service_label: null },
    ],
    utility_service_declarations: [
      { id: "declaration-electric", property_id: propertyId,
        service_id: "service-electric", applicability: "present",
        effective_from: "2026-01-01", source_artifact_id: "artifact-a" },
    ],
    utility_providers: [
      { id: "provider-peco", provider_name: "PECO" },
    ],
    utility_service_providers: [
      { id: "service-provider", property_id: propertyId,
        service_id: "service-electric", provider_id: "provider-peco",
        effective_from: "2026-01-01", source_artifact_id: "artifact-a" },
    ],
    utility_arrangements: [
      { id: "arrangement-electric", property_id: propertyId,
        service_id: "service-electric", effective_from: "2026-01-01",
        physical_arrangement: "internal_submeters",
        provider_bill_recipient: "property", provider_responsible_party: "property",
        economic_responsibility: "shared", resident_recovery_method: "actual_submeter_usage",
        resident_payment_recipient: "property", source_artifact_id: "artifact-a" },
    ],
    utility_provider_accounts: [
      { id: "account-secret", property_id: propertyId, provider_id: "provider-peco",
        external_account_identifier: "PECO-123456789", effective_from: "2026-01-01",
        source_artifact_id: "artifact-a" },
    ],
    utility_account_services: [
      { id: "account-service", property_id: propertyId, account_id: "account-secret",
        service_id: "service-electric", effective_from: "2026-01-01" },
    ],
    utility_service_points: [
      { id: "point-unit", property_id: propertyId, service_id: "service-electric",
        point_kind: "unit", location_label: "Unit 506", effective_from: "2026-01-01" },
    ],
    utility_meters: [
      { id: "submeter-secret", property_id: propertyId, provider_id: null,
        meter_kind: "internal_submeter", meter_identifier: "SUBMETER-998877",
        effective_from: "2026-01-01", source_artifact_id: "artifact-a" },
    ],
    utility_meter_service_points: [
      { id: "meter-point", property_id: propertyId, meter_id: "submeter-secret",
        service_point_id: "point-unit", effective_from: "2026-01-01" },
    ],
    utility_account_service_points: [
      { id: "account-point", property_id: propertyId, account_id: "account-secret",
        service_point_id: "point-unit", effective_from: "2026-01-01" },
    ],
    utility_account_meters: [],
    utility_statements: [],
    utility_statement_usage: [],
  };
}

function database(rows, { fail = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (fail && /from\s+utility_/i.test(sql)) throw new Error("utility database unavailable");
      const match = String(sql).match(/from\s+(utility_[a-z_]+)/i);
      return { rows: match ? (rows[match[1]] || []) : [] };
    },
  };
}

let passed = 0;
async function ok(label, fn) {
  await fn(); passed += 1; console.log(`  ok    ${label}`);
}

async function main() {
  console.log("\nUTILITY ASK DETAIL - GOVERNED RETRIEVAL\n");

  await ok("broad Utility questions use standing only", async () => {
    const result = await detailRead.readForQuestion(database(rowSet()), {
      property_id: PROPERTY_A, allowed_modules: ["asset_management"],
      question: "How do utilities work here?",
    });
    assert.strictEqual(result.mode, "standing");
    assert.strictEqual(result.detail, null);
  });

  await ok("an account suffix resolves the governed property account", async () => {
    const result = await detailRead.readForQuestion(database(rowSet()), {
      property_id: PROPERTY_A, allowed_modules: ["asset_management"],
      question: "What does account ending 6789 serve?",
    });
    assert.strictEqual(result.mode, "account_detail");
    assert.strictEqual(result.detail.selector.match_count, 1);
    assert.strictEqual(result.detail.accounts[0].account_identifier_masked.endsWith("6789"), true);
    assert.deepStrictEqual(result.detail.accounts[0].serves.map((point) => point.label), ["Unit 506"]);
  });

  await ok("model detail has response-local references and no database IDs", async () => {
    const result = await detailRead.readForQuestion(database(rowSet()), {
      property_id: PROPERTY_A, allowed_modules: ["asset_management"],
      question: "How many PECO accounts do we have?",
    });
    const serialized = JSON.stringify(result.detail);
    assert(serialized.includes("UTILITY-ACCOUNT-1"));
    for (const secret of ["account-secret", "service-electric", "provider-peco", "artifact-a"])
      assert(!serialized.includes(secret), secret);
    assert(!serialized.includes("PECO-123456789"));
  });

  await ok("a submeter stays a meter and never becomes a provider account", async () => {
    const result = await detailRead.readForQuestion(database(rowSet()), {
      property_id: PROPERTY_A, allowed_modules: ["asset_management"],
      question: "What is submetered?",
    });
    assert.strictEqual(result.detail.accounts.length, 0);
    assert.strictEqual(result.detail.meters[0].kind, "internal_submeter");
    assert.deepStrictEqual(result.detail.meters[0].serves.map((point) => point.label), ["Unit 506"]);
  });

  await ok("NOT_ESTABLISHED services survive detail", async () => {
    const result = await detailRead.readForQuestion(database(rowSet()), {
      property_id: PROPERTY_A, allowed_modules: ["asset_management"],
      question: "Which meters are common area?",
    });
    const gas = result.detail.services.find((service) => service.service_class === "natural_gas");
    assert.strictEqual(gas.applicability.truth_state, "NOT_ESTABLISHED");
  });

  await ok("entitlement is checked before any Utility retrieval", async () => {
    const db = database(rowSet());
    const result = await detailRead.readForQuestion(db, {
      property_id: PROPERTY_A, allowed_modules: ["maintenance"],
      question: "What does account ending 6789 serve?",
    });
    assert.strictEqual(result.read_state, "NOT_ENTITLED");
    assert.strictEqual(db.queries.length, 0);
  });

  await ok("a foreign-property account is refused rather than entering context", async () => {
    const foreign = rowSet(PROPERTY_B);
    const db = database(foreign);
    let error = null;
    try {
      await detailRead.readForQuestion(db, {
        property_id: PROPERTY_A, allowed_modules: ["asset_management"],
        question: "What does account ending 6789 serve?",
      });
    } catch (caught) { error = caught; }
    assert(error);
    assert.strictEqual(error.code, "PROPERTY_SCOPE_VIOLATION");
  });

  await ok("a detail read failure throws and cannot become an empty account list", async () => {
    const db = database(rowSet(), { fail: true });
    let error = null;
    try {
      await detailRead.readForQuestion(db, {
        property_id: PROPERTY_A, allowed_modules: ["asset_management"],
        question: "How many PECO accounts do we have?",
      });
    } catch (caught) { error = caught; }
    assert(error);
  });

  await ok("a timed-out detail read remains distinct from empty truth", async () => {
    const db = { query: async () => new Promise(() => {}) };
    let error = null;
    try {
      await detailRead.readForQuestion(db, {
        property_id: PROPERTY_A, allowed_modules: ["asset_management"],
        question: "How many PECO accounts do we have?", timeout_ms: 5,
      });
    } catch (caught) { error = caught; }
    assert(error);
    assert.strictEqual(error.code, "READ_TIMED_OUT");
  });

  await ok("a successful complete standing read can report QUIET", async () => {
    assert.strictEqual(detailRead.attentionState({ unresolved_count: 0 }), "QUIET");
    assert.strictEqual(detailRead.attentionState({ unresolved_count: 1 }), "ATTENTION_REQUIRED");
  });

  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
