"use strict";

const assert = require("assert");
const svc = require("../../src/tenancy/economic_tenancy_service.js");

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log(`✓ ${name}`);
  }).catch((e) => {
    console.error(`✗ ${name}`);
    throw e;
  });
}
function rows(items = [], rowCount = null) { return { rows: items, rowCount: rowCount == null ? items.length : rowCount }; }

class MemoryClient {
  constructor(overrides = {}) {
    this.today = overrides.today || "2026-07-22";
    this.lease = {
      id: "lease-1", property_id: "property-1", space_id: "space-1", unit_id: "unit-1",
      unit_number: "101", tenant_ids: ["person-1"], rent: "1850.00",
      security_deposit: "1850.00", start_date: "2026-07-08", end_date: "2027-07-20",
      lease_status: "pending", executed_lease_record_id: "executed-1", executed_record_state: "verified",
      executed_document_reference: "leases/lease-1.pdf", executed_document_sha256: "abc123",
      executed_provider_name: null, executed_provider_document_id: null, executed_provider_version_id: null,
      ...overrides.lease,
    };
    this.chargeSet = overrides.chargeSet || null;
    this.charges = overrides.charges || [];
    this.events = [];
    this.updates = [];
    this.delivery = overrides.delivery || {
      id: "delivery-1", related_id: "lease-1", required_inputs: ["unit_ready", "keys_access_ready"],
      assigned_role: "property_manager", status: "open",
    };
    this.possession = overrides.possession || null;
  }

  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (q.includes("select l.*") && q.includes("from leases l")) return rows([this.lease]);
    if (q.startsWith("select current_date::text as today")) return rows([{ today: this.today }]);
    if (q.includes("from lease_move_in_charge_sets") && q.includes("status='confirmed'")) {
      return rows(this.chargeSet ? [this.chargeSet] : []);
    }
    if (q.startsWith("insert into lease_move_in_charge_sets")) {
      this.chargeSet = {
        id: "set-1", lease_id: this.lease.id, property_id: this.lease.property_id,
        executed_lease_record_id: this.lease.executed_lease_record_id,
        first_period_amount: params[3], first_period_start: params[4], first_period_end: params[5],
        required_fees: JSON.parse(params[6]), payload_hash: params[7], confirmed_by_user_id: params[8],
        event_id: params[9], calculation_note: params[10], authority_basis: JSON.parse(params[11]),
        idempotency_key: params[12], status: "confirmed", confirmed_at: "2026-07-22T12:00:00Z",
      };
      return rows([this.chargeSet]);
    }
    if (q.includes("select * from scheduled_charges") && q.includes("order by created_at asc limit 1 for update")) {
      const [leaseId, period, type] = params;
      const found = this.charges.find((c) => c.lease_id === leaseId && c.period === period && c.charge_type === type);
      return rows(found ? [found] : []);
    }
    if (q.startsWith("insert into scheduled_charges")) {
      const charge = {
        id: `charge-${this.charges.length + 1}`,
        property_id: params[0], unit_id: params[1], lease_id: params[2], person_id: params[3],
        charge_type: params[4], period: params[5], amount: params[6], amount_paid: params[7],
        due_date: params[8], status: params[9], source: "lease", source_ref: params[10],
        is_move_in_required: true, move_in_requirement_key: params[11], move_in_charge_set_id: params[12],
        display_label: params[13], created_at: "2026-07-22T12:00:00Z",
      };
      this.charges.push(charge);
      return rows([charge]);
    }
    if (q.startsWith("update scheduled_charges") && q.includes("is_move_in_required=true")) {
      const c = this.charges.find((x) => x.id === params[0]);
      Object.assign(c, { is_move_in_required: true, move_in_requirement_key: params[1], move_in_charge_set_id: params[2], display_label: c.display_label || params[3] });
      return rows([c]);
    }
    if (q.includes("from scheduled_charges c") && q.includes("payment_applications")) {
      return rows(this.charges.filter((c) => c.lease_id === params[0] && c.is_move_in_required).map((c) => ({
        ...c,
        applied_total: c.amount_paid || 0,
        cash_proven_total: c.cash_proven_total || 0,
      })));
    }
    if (q.startsWith("insert into events")) {
      const event = { id: `event-${this.events.length + 1}` };
      this.events.push({ ...event, sql, params });
      return rows([event]);
    }
    if (q.startsWith("update leases") && q.includes("lease_status='active'")) {
      this.lease = {
        ...this.lease,
        lease_status: "active",
        economic_tenancy_activated_at: "2026-07-22T12:00:00Z",
        economic_tenancy_activated_by_user_id: params[1],
        economic_tenancy_activation_event_id: params[2],
      };
      this.updates.push("lease_active");
      return rows([this.lease]);
    }
    if (q.startsWith("update units set occupancy_status='occupied'")) { this.updates.push("unit_occupied"); return rows([]); }
    if (q.startsWith("update persons set lifecycle_status='tenant'")) { this.updates.push("person_tenant"); return rows([]); }
    if (q.startsWith("select id, name from persons")) return rows([{ id: "person-1", name: "QA Resident" }]);
    if (q.includes("from obligations") && q.includes("type='move_in_delivery'")) return rows(this.delivery ? [this.delivery] : []);
    if (q.includes("from unit_events") && q.includes("event_type='move_in'")) return rows(this.possession ? [this.possession] : []);
    throw new Error(`Unhandled query: ${q}\nparams=${JSON.stringify(params)}`);
  }
}

(async () => {
  await test("first-period amount is explicit and positive", async () => {
    const db = new MemoryClient();
    await assert.rejects(
      () => svc.confirmMoveInChargeSet(db, {
        lease_id: "lease-1", first_period_start: "2026-07-08", first_period_end: "2026-07-31",
        required_fees: [], confirmed_by_user_id: "user-1", calculation_note: "Proration verified against executed lease.",
      }),
      (e) => e.body && e.body.error === "first_period_amount_invalid"
    );
    await assert.rejects(
      () => svc.confirmMoveInChargeSet(db, {
        lease_id: "lease-1", first_period_amount: 0,
        first_period_start: "2026-07-08", first_period_end: "2026-07-31",
        required_fees: [], confirmed_by_user_id: "user-1", calculation_note: "Proration verified against executed lease.",
      }),
      (e) => e.body && e.body.error === "first_period_amount_invalid"
    );
  });

  await test("required fees must be explicitly reviewed, including empty", async () => {
    const db = new MemoryClient();
    await assert.rejects(
      () => svc.confirmMoveInChargeSet(db, {
        lease_id: "lease-1", first_period_amount: 1432.26,
        first_period_start: "2026-07-08", first_period_end: "2026-07-31",
        confirmed_by_user_id: "user-1", calculation_note: "Proration verified against executed lease.",
      }),
      (e) => e.body && e.body.error === "required_fees_invalid"
    );
  });

  await test("confirmed charge set creates first-period and deposit claims", async () => {
    const db = new MemoryClient();
    const result = await svc.confirmMoveInChargeSet(db, {
      lease_id: "lease-1", first_period_amount: 1432.26,
      first_period_start: "2026-07-08", first_period_end: "2026-07-31",
      required_fees: [], confirmed_by_user_id: "user-1", calculation_note: "Proration verified against executed lease.", idempotency_key: "idem-1",
    });
    assert.equal(result.idempotent, false);
    assert.deepEqual(db.charges.map((c) => c.charge_type), ["first_month", "deposit"]);
    assert.equal(db.charges[0].amount, 1432.26);
    assert.equal(db.charges[1].amount, 1850);
    assert.equal(result.funds.cleared, false);
  });

  await test("same normalized charge set is idempotent", async () => {
    const db = new MemoryClient();
    const spec = {
      lease_id: "lease-1", first_period_amount: 1432.26,
      first_period_start: "2026-07-08", first_period_end: "2026-07-31",
      required_fees: [], confirmed_by_user_id: "user-1", calculation_note: "Proration verified against executed lease.", idempotency_key: "idem-1",
    };
    await svc.confirmMoveInChargeSet(db, spec);
    const replay = await svc.confirmMoveInChargeSet(db, spec);
    assert.equal(replay.idempotent, true);
    assert.equal(db.charges.length, 2);
  });

  await test("same idempotency key with different terms refuses", async () => {
    const db = new MemoryClient();
    await svc.confirmMoveInChargeSet(db, {
      lease_id: "lease-1", first_period_amount: 1432.26,
      first_period_start: "2026-07-08", first_period_end: "2026-07-31",
      required_fees: [], confirmed_by_user_id: "user-1", calculation_note: "Proration verified against executed lease.", idempotency_key: "idem-1",
    });
    await assert.rejects(
      () => svc.confirmMoveInChargeSet(db, {
        lease_id: "lease-1", first_period_amount: 1500,
        first_period_start: "2026-07-08", first_period_end: "2026-07-31",
        required_fees: [], confirmed_by_user_id: "user-1", calculation_note: "Proration verified against executed lease.", idempotency_key: "idem-1",
      }),
      (e) => e.body && e.body.error === "idempotency_conflict"
    );
  });

  await test("economic tenancy refuses before lease start", async () => {
    const db = new MemoryClient({ today: "2026-07-01", lease: { start_date: "2026-07-08" } });
    await assert.rejects(
      () => svc.attemptEconomicTenancyActivation(db, { lease_id: "lease-1", activated_by_user_id: "user-1" }),
      (e) => e.body && e.body.error === "lease_not_commenced"
    );
  });

  await test("economic tenancy refuses while required funds are outstanding", async () => {
    const db = new MemoryClient({
      chargeSet: { id: "set-1", status: "confirmed", required_fees: [], first_period_start: "2026-07-08", first_period_end: "2026-07-31" },
      charges: [
        { id: "c1", lease_id: "lease-1", is_move_in_required: true, move_in_requirement_key: "first_month", charge_type: "first_month", amount: 1000, amount_paid: 500, status: "partially_paid" },
        { id: "c2", lease_id: "lease-1", is_move_in_required: true, move_in_requirement_key: "deposit", charge_type: "deposit", amount: 1850, amount_paid: 1850, status: "paid" },
      ],
    });
    await assert.rejects(
      () => svc.attemptEconomicTenancyActivation(db, { lease_id: "lease-1", activated_by_user_id: "user-1" }),
      (e) => e.body && e.body.error === "move_in_funds_outstanding"
    );
    assert.equal(db.lease.lease_status, "pending");
  });

  await test("fully applied charges activate economic tenancy without possession", async () => {
    const db = new MemoryClient({
      chargeSet: { id: "set-1", status: "confirmed", required_fees: [], first_period_start: "2026-07-08", first_period_end: "2026-07-31" },
      charges: [
        { id: "c1", lease_id: "lease-1", is_move_in_required: true, move_in_requirement_key: "first_month", charge_type: "first_month", amount: 1000, amount_paid: 1000, status: "paid" },
        { id: "c2", lease_id: "lease-1", is_move_in_required: true, move_in_requirement_key: "deposit", charge_type: "deposit", amount: 1850, amount_paid: 1850, status: "paid" },
      ],
    });
    const result = await svc.attemptEconomicTenancyActivation(db, {
      lease_id: "lease-1", activated_by_user_id: "user-1", actor_name: "Operator",
    });
    assert.equal(result.activated, true);
    assert.equal(db.lease.lease_status, "active");
    assert(db.updates.includes("unit_occupied"));
    assert(!db.events.some((event) => String(event.sql).includes("unit_events")));
  });

  await test("active tenancy with no possession composes unit-readiness next action", async () => {
    const db = new MemoryClient({
      lease: { lease_status: "active", economic_tenancy_activated_at: "2026-07-22T12:00:00Z" },
      chargeSet: { id: "set-1", status: "confirmed", required_fees: [], first_period_start: "2026-07-08", first_period_end: "2026-07-31" },
      charges: [
        { id: "c1", lease_id: "lease-1", is_move_in_required: true, move_in_requirement_key: "first_month", charge_type: "first_month", amount: 1000, amount_paid: 1000, status: "paid" },
        { id: "c2", lease_id: "lease-1", is_move_in_required: true, move_in_requirement_key: "deposit", charge_type: "deposit", amount: 1850, amount_paid: 1850, status: "paid" },
      ],
    });
    const state = await svc.composeMoveInState(db, "lease-1");
    assert.equal(state.state, "unit_not_ready");
    assert.equal(state.current_rent_roll_tenancy, true);
    assert.equal(state.possession, null);
    assert.equal(state.primary_action.code, "complete_unit_readiness");
  });

  await test("active tenancy keeps money reversal visible without deactivation", async () => {
    const db = new MemoryClient({
      lease: { lease_status: "active" },
      chargeSet: { id: "set-1", status: "confirmed", required_fees: [], first_period_start: "2026-07-08", first_period_end: "2026-07-31" },
      charges: [
        { id: "c1", lease_id: "lease-1", is_move_in_required: true, move_in_requirement_key: "first_month", charge_type: "first_month", amount: 1000, amount_paid: 0, status: "claimed" },
        { id: "c2", lease_id: "lease-1", is_move_in_required: true, move_in_requirement_key: "deposit", charge_type: "deposit", amount: 1850, amount_paid: 1850, status: "paid" },
      ],
    });
    const state = await svc.composeMoveInState(db, "lease-1");
    assert.equal(state.state, "active_money_exception");
    assert.equal(state.current_rent_roll_tenancy, true);
    assert(state.blockers.some((b) => b.code === "move_in_funds_reversed_or_reopened"));
  });

  console.log(`\n${passed}/${passed} economic-tenancy tests passed`);
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
