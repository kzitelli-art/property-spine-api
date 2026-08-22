/* Real-Postgres proof that a governed future move-in target survives the
   staff/application boundary and reproduces the same verdict at submission.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
*/
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const { seedInventory } = require("./fixtures/slice9_inventory_fixture");
const {
  resolveApplicationTarget,
  resolveSubmissionTarget,
  REFUSAL,
} = require("../src/applications/application_target_authority");

const pool = new Pool({ connectionString: CONN });
let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) {
    passed++;
    console.log("  PASS  " + message);
  } else {
    failed++;
    console.error("  FAIL  " + message);
  }
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const seeded = await seedInventory(client);
    const propertyId = seeded.property_id;
    const target = seeded.units["B-upcoming"];
    const readyDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const dayBefore = new Date(Date.parse(readyDate + "T00:00:00Z") - 86400000)
      .toISOString().slice(0, 10);

    const withoutPlan = await resolveApplicationTarget(client, {
      property_id: propertyId,
      unit_id: target.unit_id,
      intended_move_in: readyDate,
    });
    ok(withoutPlan.refusal_code === REFUSAL.READY_DATE_NOT_GOVERNED,
      "lease expiration alone does not invent a turn-ready date");

    await client.query(
      `insert into turnovers (property_id, unit_id, status, ready_date)
       values ($1,$2,'in_progress',$3)`,
      [propertyId, target.unit_id, readyDate]);

    const tooEarly = await resolveApplicationTarget(client, {
      property_id: propertyId,
      unit_id: target.unit_id,
      intended_move_in: dayBefore,
    });
    ok(tooEarly.refusal_code === REFUSAL.MOVE_IN_BEFORE_READY,
      "the application cannot target a date before the turn plan");

    const prepared = await resolveApplicationTarget(client, {
      property_id: propertyId,
      unit_id: target.unit_id,
      intended_move_in: readyDate,
    });
    ok(prepared.ok === true && prepared.offerable === true,
      "the active turn's expected-ready date is offerable");
    ok(String(prepared.resolved_space_id) === String(target.space_id),
      "the exact rentable space is preserved");

    const invitation = (await client.query(
      `insert into application_invitations
         (token_digest, property_id, unit_id, space_id, intended_move_in, status)
       values ($1,$2,$3,$4,$5,'provider_dispatched')
       returning property_id, unit_id, space_id, intended_move_in`,
      ["future-target-proof-" + Date.now(), propertyId, target.unit_id,
       target.space_id, readyDate])).rows[0];

    const submitted = await resolveSubmissionTarget(client, {
      property_id: invitation.property_id,
      unit_id: invitation.unit_id,
      space_id: invitation.space_id,
      intended_move_in: invitation.intended_move_in,
    });
    ok(submitted.ok === true && submitted.offerable === true,
      "tenant submission reproduces the persisted invitation verdict");
    ok(submitted.intended_move_in === readyDate,
      "the submitted target still carries the exact intended move-in date");
  } catch (error) {
    failed++;
    console.error("  FAIL  harness threw: " + error.message);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
    await pool.end();
  }

  console.log(`\n  application future target DB: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
