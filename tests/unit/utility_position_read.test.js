"use strict";

const assert = require("assert");
const read = require("../../src/asset/utility_position_read.js");

const PROPERTY = "property-a";
let pass = 0;
function ok(label, fn) { fn(); pass++; console.log(`  ok    ${label}`); }

function fakeClient(rowsByTable, calls) {
  return {
    async query(sql, params) {
      const match = sql.match(/from\s+(utility_[a-z_]+)/i);
      if (!match) throw new Error(`unexpected SQL: ${sql}`);
      calls.push({ table: match[1], sql, params });
      return { rows: rowsByTable[match[1]] || [] };
    },
  };
}

async function main() {
  console.log("\nUTILITIES GOVERNED READ - DB ADAPTER CONTRACT\n");
  const calls = [];
  const rows = {
    utility_services: [{ id: "svc-electric", property_id: PROPERTY,
      service_class: "electricity", service_label: null }],
    utility_service_declarations: [{ id: "dec-electric", property_id: PROPERTY,
      service_id: "svc-electric", applicability: "present", effective_from: "2026-01-01",
      provenance_note: "confirmed" }],
    utility_providers: [{ id: "provider-peco", provider_name: "PECO" }],
    utility_service_providers: [{ id: "sp-1", property_id: PROPERTY,
      service_id: "svc-electric", provider_id: "provider-peco", effective_from: "2026-01-01",
      provenance_note: "statement" }],
    utility_arrangements: [{ id: "arr-1", property_id: PROPERTY,
      service_id: "svc-electric", physical_arrangement: "non_metered",
      provider_bill_recipient: "resident", provider_responsible_party: "resident",
      economic_responsibility: "resident", resident_recovery_method: "resident_direct_to_provider",
      resident_payment_recipient: "provider", effective_from: "2026-01-01",
      provenance_note: "confirmed" }],
  };
  const client = fakeClient(rows, calls);
  const position = await read.readPosition(client,
    { property_id: PROPERTY, as_of: "2026-08-13" });

  ok("every canonical table is read exactly once", () => {
    assert.strictEqual(calls.length, Object.keys(read.TABLES).length);
    assert.deepStrictEqual(calls.map((c) => c.table).sort(),
      Object.values(read.TABLES).sort());
  });
  ok("every SELECT derives provider or row scope in SQL and binds only server property", () => {
    for (const call of calls) {
      if (call.table === "utility_providers") {
        assert(/utility_service_providers[\s\S]*sp\.property_id = \$1/i.test(call.sql), call.sql);
        assert(/utility_provider_accounts[\s\S]*a\.property_id = \$1/i.test(call.sql), call.sql);
        assert(/utility_meters[\s\S]*m\.property_id = \$1/i.test(call.sql), call.sql);
      } else {
        assert(/where property_id = \$1/i.test(call.sql), call.sql);
      }
      assert.deepStrictEqual(call.params, [PROPERTY]);
    }
  });
  ok("standing is compact and keeps gas NOT_ESTABLISHED", () => {
    const gas = position.standing.services.find((s) => s.service_class === "natural_gas");
    assert.strictEqual(gas.applicability.truth_state, "NOT_ESTABLISHED");
    assert(!Object.prototype.hasOwnProperty.call(position.standing, "accounts"));
  });
  ok("detail exposes the property service map", () => {
    const electric = position.detail.services.find((s) => s.service_class === "electricity");
    assert.deepStrictEqual(electric.providers.map((p) => p.name), ["PECO"]);
    assert.strictEqual(electric.arrangement.provider_responsible_party, "resident");
  });
  ok("opening read names unresolved questions", () => {
    assert(position.opening.unresolved.some((g) =>
      g.service === "natural_gas" && g.concept === "service_applicability"));
  });

  let missing = null;
  try { await read.readStanding(client, {}); } catch (e) { missing = e; }
  ok("missing property authority is refused before a query", () => {
    assert(missing);
    assert(/requires property_id/.test(missing.message));
  });

  const foreignRows = { ...rows,
    utility_provider_accounts: [{ id: "foreign-account", property_id: "property-b",
      provider_id: "provider-peco", external_account_identifier: "FOREIGN-9999",
      effective_from: "2026-01-01" }] };
  let foreign = null;
  try {
    await read.readDetail(fakeClient(foreignRows, []), { property_id: PROPERTY });
  } catch (e) { foreign = e; }
  ok("a foreign-property adapter row is refused rather than entering detail", () => {
    assert(foreign);
    assert.strictEqual(foreign.code, "PROPERTY_SCOPE_VIOLATION");
  });

  console.log(`\n${pass} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
