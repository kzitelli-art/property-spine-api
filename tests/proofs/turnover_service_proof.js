"use strict";

const path = require("path");
const { Pool } = require("pg");
const { seedInventory } = require("../fixtures/slice9_inventory_fixture");
const { makeTurnoverService } = require("../../src/maintenance/turnover_service");
const { rankTurnPriority } = require("../../src/maintenance/turn_priority");
const receipt = require("../_run_receipt");

// This proof writes transaction-scoped fixtures. Rollback is defense in depth,
// not permission to aim an automated harness at production.
const DATABASE = receipt.harnessConnectionString();

let passed = 0, failed = 0;
const ok = (condition, label) => {
  if (condition) { passed++; console.log("PASS " + label); }
  else { failed++; console.log("FAIL " + label); }
};

const ssl = /localhost|127\.0\.0\.1/.test(DATABASE)
  ? false : { rejectUnauthorized: false };

(async () => {
  const pool = new Pool({ connectionString: DATABASE, ssl });
  const client = await pool.connect();
  const spawned = [];
  const walks = [];
  const possessionCalls = [];
  const service = makeTurnoverService({
    spawnObligationFromEvent: async (_db, input) => {
      spawned.push(input);
      return { id: "obligation-proof", ...input };
    },
    recordEffectivePossession: async (_db, input) => {
      possessionCalls.push(input);
      return { created: true };
    },
    unitTriageService: {
      spawnInitialWalk: async (_db, input) => {
        walks.push(input);
        return { id: "walk-proof", assigned_user_id: null };
      },
    },
  });

  try {
    await client.query("begin");
    const seeded = await seedInventory(client, { prefix: "turnover-service-proof" });
    const propertyId = seeded.property_id;
    const unitId = seeded.units["A-marketable"].unit_id;

    const out = await service.openTurnover(client, {
      property_id: propertyId,
      unit_id: unitId,
      needs: [" paint ", "paint", "clean"],
      expected_ready_date: "2026-09-15",
      actor_user_id: seeded.user_id,
    });

    ok(out.turnover && out.turnover.status === "in_progress", "one active turnover is written");
    ok(out.turnover.needs.length === 2, "needs are normalized without inventing scope");
    ok(spawned.length === 1 && spawned[0].source_event_id === out.event.id,
      "the move-out obligation is born from the same event");
    ok(walks.length === 1 && walks[0].source_event_id === out.event.id,
      "the initial walk is born from the same event");
    ok(String(walks[0].exclude_user_id) === String(seeded.user_id),
      "the manager who confirms move-out is not silently assigned the walk");
    ok(possessionCalls.length === 0, "turn-only capture invents no possession end");

    const event = (await client.query("select note from events where id=$1", [out.event.id])).rows[0];
    const note = typeof event.note === "string" ? JSON.parse(event.note) : event.note;
    ok(String(note.confirmed_by_user_id) === String(seeded.user_id),
      "the durable event carries the authenticated actor");

    const ranked = await rankTurnPriority(client, propertyId);
    ok(ranked.turns.some((turn) => String(turn.unit_id) === String(unitId)),
      "the new move-out immediately enters the canonical maintenance queue");

    let duplicate = null;
    try {
      await service.openTurnover(client, { property_id: propertyId, unit_id: unitId });
    } catch (error) { duplicate = error; }
    ok(duplicate && duplicate.code === "TURNOVER_ALREADY_ACTIVE",
      "replay cannot create a second active turnover");

    let wrongProperty = null;
    try {
      await service.openTurnover(client, { property_id: seeded.other_property_id || "00000000-0000-0000-0000-000000000001", unit_id: unitId });
    } catch (error) { wrongProperty = error; }
    ok(wrongProperty && wrongProperty.code === "WRONG_PROPERTY",
      "a property-scoped caller cannot reach another property's unit");

    const otherUnit = seeded.units["J-future-locked"].unit_id;
    const otherLease = (await client.query(
      "select l.id from leases l join spaces s on s.id=l.space_id where s.unit_id=$1 limit 1",
      [otherUnit]
    )).rows[0];
    let wrongLease = null;
    try {
      await service.openTurnover(client, {
        property_id: propertyId,
        unit_id: seeded.units["G-occupied"].unit_id,
        outgoing_lease_id: otherLease.id,
      });
    } catch (error) { wrongLease = error; }
    ok(wrongLease && wrongLease.code === "LEASE_UNIT_MISMATCH",
      "an outgoing lease cannot be attached to the wrong unit");

    let badDate = null;
    try {
      await service.openTurnover(client, {
        property_id: propertyId,
        unit_id: seeded.units["G-occupied"].unit_id,
        expected_ready_date: "2026-02-30",
      });
    } catch (error) { badDate = error; }
    ok(badDate && badDate.code === "INVALID_DATE", "an impossible ready date is refused");
  } catch (error) {
    failed++;
    console.error(error.stack || error.message);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
    await pool.end();
  }

  console.log(`\n${passed} turnover-service assertions passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
