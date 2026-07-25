"use strict";

const assert = require("assert");
const buildDelivery = require("../src/comms/delivery.js");
const { spacePosition } = require("../src/tenancy/space_position.js");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}`); throw e; }
}
const result = (rows = []) => ({ rows, rowCount: rows.length });

(async () => {
  await test("delivery cannot complete before actual possession", async () => {
    let completed = false;
    const client = {
      async query(sql) {
        const q = sql.replace(/\s+/g, " ").toLowerCase();
        if (q.includes("from obligations") && q.includes("status in ('open','in_progress')")) {
          return result([{ id: "delivery-1", required_inputs: [], status: "open" }]);
        }
        if (q.includes("from unit_events") && q.includes("event_type='move_in'")) return result([]);
        throw new Error(`unhandled ${q}`);
      },
    };
    const delivery = buildDelivery({
      satisfyObligation: async () => {},
      completeObligation: async () => { completed = true; },
    });
    const out = await delivery.completeDeliveryIfReady(client, { lease_id: "lease-1", completed_by: "user-1" });
    assert.equal(out.completed, false);
    assert.equal(out.reason, "possession_outstanding");
    assert.equal(completed, false);
  });

  await test("delivery completes after gates and possession", async () => {
    let completedBy = null;
    const client = {
      async query(sql) {
        const q = sql.replace(/\s+/g, " ").toLowerCase();
        if (q.includes("from obligations") && q.includes("status in ('open','in_progress')")) {
          return result([{ id: "delivery-1", required_inputs: [], status: "open" }]);
        }
        if (q.includes("from unit_events") && q.includes("event_type='move_in'")) {
          return result([{ id: "possession-1", space_id: "space-1", effective_date: "2026-07-22" }]);
        }
        throw new Error(`unhandled ${q}`);
      },
    };
    const delivery = buildDelivery({
      satisfyObligation: async () => {},
      completeObligation: async (_client, spec) => { completedBy = spec.completed_by; },
    });
    const out = await delivery.completeDeliveryIfReady(client, { lease_id: "lease-1", completed_by: "user-1" });
    assert.equal(out.completed, true);
    assert.equal(out.possession_event_id, "possession-1");
    assert.equal(completedBy, "user-1");
  });

  await test("delivery still refuses while readiness gates remain", async () => {
    const client = {
      async query(sql) {
        const q = sql.replace(/\s+/g, " ").toLowerCase();
        if (q.includes("from obligations") && q.includes("status in ('open','in_progress')")) {
          return result([{ id: "delivery-1", required_inputs: ["keys_access_ready"], status: "open" }]);
        }
        throw new Error(`unhandled ${q}`);
      },
    };
    const delivery = buildDelivery({ satisfyObligation: async () => {}, completeObligation: async () => { throw new Error("must not complete"); } });
    const out = await delivery.completeDeliveryIfReady(client, { lease_id: "lease-1" });
    assert.equal(out.reason, "hard gates remain");
    assert.deepEqual(out.remaining, ["keys_access_ready"]);
  });

  function positionPool(spaceRows, people = []) {
    let count = 0;
    return {
      async query(sql) {
        count++;
        if (String(sql).includes("from spaces s")) return result(spaceRows);
        if (String(sql).includes("from persons")) return result(people);
        throw new Error(`unhandled position query ${count}`);
      },
    };
  }
  const baseRow = {
    space_id: "space-1", unit_id: "unit-1", unit_number: "101", space_label: "A",
    possession_events: [], notice_date: null, turn_status: null, compat_occupancy: "vacant",
  };

  await test("commenced pending lease is activation-pending, never current", async () => {
    const pool = positionPool([{ ...baseRow, leases: [{
      id: "lease-1", lease_status: "pending", start_date: "2026-07-08", end_date: "2027-07-20",
      rent: 1850, tenant_ids: ["person-1"],
    }] }], [{ id: "person-1", name: "QA Resident" }]);
    const out = await spacePosition(pool, { property_id: "property-1", as_of: "2026-07-22" });
    const p = out.positions[0];
    assert.equal(p.current_lease_position, null);
    assert.equal(p.activation_pending_lease_position.lease_id, "lease-1");
    assert.equal(p.availability_state, "committed_activation_pending");
    assert.equal(p.next_required_action, "economic_tenancy_activation_required");
  });

  await test("active lease is current while possession remains pending", async () => {
    const pool = positionPool([{ ...baseRow, leases: [{
      id: "lease-1", lease_status: "active", start_date: "2026-07-08", end_date: "2027-07-20",
      rent: 1850, tenant_ids: ["person-1"],
    }] }], [{ id: "person-1", name: "QA Resident" }]);
    const out = await spacePosition(pool, { property_id: "property-1", as_of: "2026-07-22" });
    const p = out.positions[0];
    assert.equal(p.current_lease_position.lease_id, "lease-1");
    assert.equal(p.current_lease_position.tenants[0].person_id, "person-1");
    assert.equal(p.current_possession, null);
    assert.equal(p.next_required_action, "possession_outstanding");
    assert.equal(out.summary.current_economic_tenancies, 1);
    assert.equal(out.summary.possession_pending, 1);
  });

  await test("physical possession is layered on active economic tenancy", async () => {
    const pool = positionPool([{ ...baseRow,
      leases: [{ id: "lease-1", lease_status: "active", start_date: "2026-07-08", end_date: "2027-07-20", rent: 1850, tenant_ids: ["person-1"] }],
      possession_events: [{ event_type: "move_in", effective_date: "2026-07-22", created_at: "2026-07-22T15:00:00Z", source: "keys_handed_over", payload: { actor_user_id: "user-1" } }],
    }], [{ id: "person-1", name: "QA Resident" }]);
    const out = await spacePosition(pool, { property_id: "property-1", as_of: "2026-07-22" });
    const p = out.positions[0];
    assert.equal(p.current_lease_position.lease_id, "lease-1");
    assert.equal(p.current_possession.since, "2026-07-22");
    assert.equal(p.current_possession.details.actor_user_id, "user-1");
    assert.equal(p.next_required_action, null);
    assert.equal(out.summary.possessed, 1);
  });

  await test("future pending lease remains future commitment", async () => {
    const pool = positionPool([{ ...baseRow, leases: [{
      id: "lease-2", lease_status: "pending", start_date: "2026-08-01", end_date: "2027-07-31",
      rent: 1900, tenant_ids: ["person-2"],
    }] }], [{ id: "person-2", name: "Future Resident" }]);
    const out = await spacePosition(pool, { property_id: "property-1", as_of: "2026-07-22" });
    const p = out.positions[0];
    assert.equal(p.future_lease_position.lease_id, "lease-2");
    assert.equal(p.activation_pending_lease_position, null);
    assert.equal(p.availability_state, "committed_future");
  });

  console.log(`\n${passed}/${passed} move-in runtime behavior tests passed`);
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
