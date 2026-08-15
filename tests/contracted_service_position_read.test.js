"use strict";

const assert = require("assert");
const positionRead = require("../src/asset/contracted_service_position_read.js");

const PROPERTY = "00000000-0000-0000-0000-000000000001";

function fakeDb(overrides = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      for (const [pattern, rows] of Object.entries(overrides)) {
        if (sql.includes(pattern)) return { rows };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  await assert.rejects(() => positionRead.readSnapshot(fakeDb(), {}),
    /requires property_id/);

  const db = fakeDb({
    "contracted_service_engagements where": [{
      id: "eng-1", property_id: PROPERTY, service_class: "elevator_maintenance",
      provider_id: "provider-1", effective_from: "2026-01-01",
    }],
    "select p.id, p.provider_name": [{ id: "provider-1", provider_name: "Fujitec" }],
    "select o.id, o.property_id": [],
  });
  const snapshot = await positionRead.readSnapshot(db, { property_id: PROPERTY });
  assert.strictEqual(snapshot.property_id, PROPERTY);
  assert.strictEqual(snapshot.engagements.length, 1);
  assert.strictEqual(snapshot.providers[0].provider_name, "Fujitec");
  assert(Object.values(positionRead.TABLES).every((table) => db.calls.some((call) =>
    call.sql.includes(`from ${table} where property_id = $1`)
      && call.values.length === 1 && call.values[0] === PROPERTY)));
  assert(db.calls.some((call) => /contracted_service_engagements e[\s\S]*e\.property_id = \$1/i.test(call.sql)));
  assert(db.calls.some((call) => /contracted_service_financial_observations f[\s\S]*f\.property_id = \$1/i.test(call.sql)));

  const foreign = fakeDb({
    "contracted_service_terms where": [{
      id: "term-foreign", property_id: "00000000-0000-0000-0000-000000000002",
    }],
  });
  await assert.rejects(() => positionRead.readSnapshot(foreign, { property_id: PROPERTY }),
    (error) => error.code === "PROPERTY_SCOPE_VIOLATION");

  const ownership = fakeDb({
    "contracted_service_decision_links where": [{
      id: "link-1", property_id: PROPERTY, engagement_id: "eng-1",
      obligation_id: "obligation-1", term_id: "term-1",
    }],
    "select o.id, o.property_id": [{
      id: "obligation-1", property_id: PROPERTY,
      assigned_user_id: "00000000-0000-0000-0000-000000000010", status: "open",
    }],
    "select id, name, email from users": [{
      id: "00000000-0000-0000-0000-000000000010", name: "Asset Manager",
    }],
  });
  const owned = await positionRead.readSnapshot(ownership, { property_id: PROPERTY });
  assert.strictEqual(owned.obligations.length, 1);
  assert.strictEqual(owned.users[0].name, "Asset Manager");
  assert(ownership.calls.some((call) => /exists[\s\S]*contracted_service_decision_links/i.test(call.sql)));

  console.log("contracted service position read tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
