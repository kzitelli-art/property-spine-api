// ════════════════════════════════════════════════════════════════════
//  tour_scheduled_for.test.js
//
//  THE REGRESSION THIS EXISTS FOR
//  ------------------------------
//  recordTourEvent's TS_COL map stamped ev.event_at into leasing_tours
//  .scheduled_for whenever a 'scheduled' event was recorded. The booking
//  INSERT wrote the correct slot time; this UPDATE — same transaction,
//  milliseconds later — replaced it with the booking moment. Every tour
//  ever booked carried its creation time as its appointment time.
//
//  Source-reading could not find it and RETURNING could not see it: the
//  insert's own RETURNING reported the correct value, and updated_at
//  matched created_at because both resolved to the same transaction
//  timestamp. Only a re-read of the STORED row after the full booking
//  sequence exposes it.
//
//  So this harness asserts on EXECUTED OUTPUT — the row as it exists in
//  Postgres after the real canonical service ran — never on source text.
//
//  SAFETY
//  ------
//  Everything happens inside ONE transaction that is ALWAYS rolled back.
//  No row survives, so the shared Demo Building is never polluted and
//  there is no cleanup to get wrong. No property-wide deletes anywhere.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//
//  RUN (Render Web Shell, repo root):   node tour_scheduled_for.test.js
//  Expected AFTER the fix: 10/10.
//  Expected BEFORE the fix: assertion 1 and 2 FAIL — run it first to
//  confirm the harness can fail. A test that cannot fail is not evidence.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { Pool } = require("pg");

const DEMO_PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
// Far-future so it can never collide with a real seeded slot or a live demo.
const SLOT_START = "2030-03-14T15:00:00.000Z";
const SLOT_END   = "2030-03-14T15:30:00.000Z";

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
const ms = (v) => (v == null ? null : new Date(v).getTime());

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run from the Render Web Shell.");
    process.exitCode = 1;
    return;
  }

  // Build the real module with the narrowest stubs that let the canonical
  // booking service run. bookTourIntoSlot touches exactly one external dep.
  let bookTourIntoSlot;
  try {
    const leasingLeadsModule = require("../../src/leasing/leasing_leads.js");
    const router = leasingLeadsModule({
      pool: { query: async () => ({ rows: [] }) },   // module-scope pool is unused by this path
      anthropic: null,
      INGEST_MODEL: null,
      sms: { enabled: () => false, sendSms: async () => ({ sid: null }) },
      leasingLifecycle: { assertNotSoftClosedForLead: async () => {} },
      conversionServices: {},
      commitmentLedger: null,
      commBoundary: {
        reclassify: async () => {},
        sendPropertySms: async () => ({ sent: false, reason: "harness" }),
      },
    });
    bookTourIntoSlot = router._service && router._service.bookTourIntoSlot;
  } catch (e) {
    console.error("Could not build leasing_leads module:", e.message);
    process.exitCode = 1;
    return;
  }
  if (typeof bookTourIntoSlot !== "function") {
    console.error("router._service.bookTourIntoSlot is not exported — the module shape changed.");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();

  try {
    await client.query("begin");

    // ── seed, inside the doomed transaction ──────────────────────────
    const src = (await client.query(
      `insert into lead_sources (name, source_type) values ($1,'manual')
       on conflict (name) do update set name = excluded.name
       returning id`,
      ["harness_scheduled_for"])).rows[0];

    const person = (await client.query(
      `insert into persons (name, phone, primary_phone_e164, lifecycle_status, leasing_stage, source)
       values ($1,$2,$3,'prospect','inquiry',$4) returning id`,
      ["Harness Appointment Probe", "+15005550001", "+15005550001", "harness_scheduled_for"])).rows[0];

    const lead = (await client.query(
      `insert into leasing_leads (person_id, property_id, source_id, message)
       values ($1,$2,$3,$4) returning id, status`,
      [person.id, DEMO_PROPERTY_ID, src.id, "harness"])).rows[0];

    const agent = (await client.query(
      `select id from users where id = '71c21c48-3cc9-4ac0-8d39-bb05cf7f439d'`)).rows[0];

    const slot = (await client.query(
      `insert into tour_availability
         (property_id, unit_id, leasing_agent_id, starts_at, ends_at, capacity, status)
       values ($1, null, $2, $3, $4, 1, 'open') returning *`,
      [DEMO_PROPERTY_ID, agent ? agent.id : null, SLOT_START, SLOT_END])).rows[0];

    // ── the real canonical booking transaction ───────────────────────
    const { tour, alreadyBooked } = await bookTourIntoSlot(client, {
      leadId: lead.id,
      slotId: slot.id,
      via: "harness_scheduled_for",
      requireAgentBookingCapability: false,
    });

    // ── re-read the STORED row. This is the whole point. ─────────────
    const stored = (await client.query(
      `select id, scheduled_for, created_at, updated_at, status, slot_id, leasing_agent_id
         from leasing_tours where id=$1`, [tour.id])).rows[0];

    const slotAfter = (await client.query(
      `select status, booked_tour_id from tour_availability where id=$1`, [slot.id])).rows[0];

    const events = (await client.query(
      `select event_type, event_at from tour_events where tour_id=$1 order by event_at`,
      [tour.id])).rows;

    const leadAfter = (await client.query(
      `select tour_scheduled_at, status from leasing_leads where id=$1`, [lead.id])).rows[0];

    // ── assertions ───────────────────────────────────────────────────
    ok("1. stored scheduled_for equals the slot's start time",
      ms(stored.scheduled_for) === ms(slot.starts_at),
      `stored=${stored.scheduled_for}  slot=${slot.starts_at}`);

    ok("2. stored scheduled_for is NOT the row's creation time",
      ms(stored.scheduled_for) !== ms(stored.created_at),
      `scheduled_for=${stored.scheduled_for}  created_at=${stored.created_at}`);

    ok("3. the insert's RETURNING also carried the slot time",
      ms(tour.scheduled_for) === ms(slot.starts_at),
      `returning=${tour.scheduled_for}`);

    ok("4. status is 'scheduled'", stored.status === "scheduled", `status=${stored.status}`);

    ok("5. this was a fresh booking, not an idempotent replay", alreadyBooked === false);

    ok("6. the host was inherited from the slot",
      String(stored.leasing_agent_id || "") === String(slot.leasing_agent_id || ""),
      `tour=${stored.leasing_agent_id}  slot=${slot.leasing_agent_id}`);

    ok("7. the slot is flipped to booked and points at this tour",
      slotAfter && slotAfter.status === "booked" && slotAfter.booked_tour_id === tour.id,
      `slot_status=${slotAfter && slotAfter.status}`);

    const schedEvents = events.filter((e) => e.event_type === "scheduled");
    ok("8. exactly one 'scheduled' tour_event was recorded",
      schedEvents.length === 1, `count=${schedEvents.length}`);

    // The occurrence time must survive — it just belongs in the event, not the column.
    ok("9. the scheduling event's own time is now, not the appointment time",
      schedEvents.length === 1 &&
        Math.abs(ms(schedEvents[0].event_at) - Date.now()) < 5 * 60 * 1000 &&
        ms(schedEvents[0].event_at) !== ms(slot.starts_at),
      schedEvents.length ? `event_at=${schedEvents[0].event_at}` : "no event");

    ok("10. the lead's tour_scheduled_at carries the appointment time",
      ms(leadAfter.tour_scheduled_at) === ms(slot.starts_at),
      `lead.tour_scheduled_at=${leadAfter.tour_scheduled_at}`);

  } catch (e) {
    failed++;
    lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    // ALWAYS. Nothing this harness did is allowed to survive.
    try { await client.query("rollback"); } catch (_) {}
    client.release();
    await pool.end().catch(() => {});
  }

  const bar = "─".repeat(66);
  console.log(`\n${bar}\nTOUR scheduled_for — APPOINTMENT TIME REGRESSION\n${bar}`);
  console.log(lines.join("\n"));
  console.log(bar);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  if (failed === 0) {
    console.log("The stored appointment time is the slot's time. Rolled back; nothing persisted.");
  } else {
    console.log("Rolled back; nothing persisted. Fix the failures above and re-run.");
  }
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exitCode = 1;
});
