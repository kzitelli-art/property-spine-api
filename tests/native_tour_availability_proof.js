/*
  native_tour_availability_proof.js

  Proves the one Property Spine command behind staff/dashboard/text adapters:
  exact future slots, property/host/unit walls, idempotency, and retained event
  receipts for open/block/reopen. Requires DATABASE_URL with migration 188.
*/
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const { databaseSsl } = require("../src/shared/database_ssl");
const { makeTourAvailabilityService } = require("../src/leasing/tour_availability_service");

const URL = receipt.harnessConnectionString();
const EXPECTED = 23;
const pool = new Pool({ connectionString: URL, ssl: databaseSsl(URL) });
const service = makeTourAvailabilityService({ pool });
const propertyId = crypto.randomUUID();
const propertyName = `__NATIVE_TOUR__ ${propertyId.slice(0, 8)}`;
let pass = 0;
let fail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`   PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`   FAIL  ${label}${detail ? ` (${detail})` : ""}`);
  }
}

function sundayOf(year, monthIndex, occurrence) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const day = 1 + ((7 - first.getUTCDay()) % 7) + (occurrence - 1) * 7;
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function refusal(label, expectedCode, fn) {
  let err = null;
  try { await fn(); } catch (caught) { err = caught; }
  check(label, !!err && err.code === expectedCode, err && `${err.code}: ${err.message}`);
}

async function cleanup() {
  const gone = await pool.query(
    "delete from properties where id=$1 and name like '__NATIVE_TOUR__%'",
    [propertyId]
  ).catch(() => ({ rowCount: 0 }));
  console.log(`   cleanup property removed: ${gone.rowCount}`);
}

(async () => {
  receipt.begin(__filename, { url: URL, expected: EXPECTED });
  const actor = (await pool.query("select id from users where is_active is distinct from false order by created_at limit 1")).rows[0];
  if (!actor) throw new Error("This proof needs one existing active user.");

  await pool.query("insert into properties (id,name) values ($1,$2)", [propertyId, propertyName]);
  await pool.query(
    `insert into property_team_assignments
       (property_id,user_id,role_title,allowed_modules,primary_for_modules,active)
     values ($1,$2,'Native tour proof',array['leasing'],array['leasing'],true)`,
    [propertyId, actor.id]
  );

  const starts = new Date(Date.now() + 48 * 3600000);
  const ends = new Date(starts.getTime() + 30 * 60000);

  console.log("\n-- Configuration wall --");
  await refusal("unconfigured property timezone refuses publication", "property_operating_timezone_not_configured", () =>
    service.publishSlot({ propertyId, startsAt: starts.toISOString(), endsAt: ends.toISOString(), actorUserId: actor.id })
  );
  await pool.query("update properties set operating_timezone='America/New_York' where id=$1", [propertyId]);

  console.log("\n-- Canonical publication --");
  const first = await service.publishSlot({
    propertyId,
    startsAt: starts.toISOString(),
    endsAt: ends.toISOString(),
    leasingAgentId: actor.id,
    actorUserId: actor.id,
    reason: "proof schedule",
    idempotencyKey: "publish-1",
  });
  check("a future slot is published", first.created === true && first.slot.status === "open");
  check("the property timezone is returned", first.timezone === "America/New_York");

  const replay = await service.publishSlot({
    propertyId,
    startsAt: starts.toISOString(),
    endsAt: ends.toISOString(),
    leasingAgentId: actor.id,
    actorUserId: actor.id,
    idempotencyKey: "publish-1",
  });
  check("an idempotent retry returns the same slot", replay.idempotent === true && replay.slot.id === first.slot.id);

  const duplicate = await service.publishSlot({
    propertyId,
    startsAt: starts.toISOString(),
    endsAt: ends.toISOString(),
    leasingAgentId: actor.id,
    actorUserId: actor.id,
    idempotencyKey: "publish-2",
  });
  check("the same exact slot is not duplicated under another key", duplicate.created === false && duplicate.slot.id === first.slot.id);

  const openedEvents = (await pool.query(
    "select * from tour_availability_events where slot_id=$1 and event_type='opened'",
    [first.slot.id]
  )).rows;
  check("one opened receipt exists", openedEvents.length === 1);
  check("the opened receipt names the authenticated actor", openedEvents[0].actor_user_id === actor.id);

  const futureLocal = new Date(Date.now() + 10 * 86400000);
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(futureLocal).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  const localDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const local = await service.publishSlot({
    propertyId,
    startsLocal: `${localDate}T12:00`,
    endsLocal: `${localDate}T12:30`,
    actorUserId: actor.id,
    idempotencyKey: "publish-local-1",
  });
  check("a property-local wall time is accepted without browser offset math", local.created === true);
  const localHour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(local.slot.starts_at));
  check("the local wall time resolves in the governed property timezone", localHour === "12:00", localHour);

  const nextYear = new Date().getUTCFullYear() + 1;
  const springForward = sundayOf(nextYear, 2, 2);
  await refusal("a nonexistent daylight-saving wall time is refused", "nonexistent_tour_local_time", () =>
    service.publishSlot({ propertyId, startsLocal: `${springForward}T02:30`, endsLocal: `${springForward}T03:00`, actorUserId: actor.id })
  );
  const fallBack = sundayOf(nextYear, 10, 1);
  await refusal("a repeated daylight-saving wall time is refused", "ambiguous_tour_local_time", () =>
    service.publishSlot({ propertyId, startsLocal: `${fallBack}T01:30`, endsLocal: `${fallBack}T02:00`, actorUserId: actor.id })
  );

  console.log("\n-- Property walls and validation --");
  await refusal("a host without a property leasing assignment is refused", "tour_host_property_mismatch", () =>
    service.publishSlot({
      propertyId,
      startsAt: new Date(starts.getTime() + 3600000).toISOString(),
      endsAt: new Date(ends.getTime() + 3600000).toISOString(),
      leasingAgentId: crypto.randomUUID(),
      actorUserId: actor.id,
    })
  );
  await refusal("a unit outside the property is refused", "tour_unit_property_mismatch", () =>
    service.publishSlot({
      propertyId,
      startsAt: new Date(starts.getTime() + 7200000).toISOString(),
      endsAt: new Date(ends.getTime() + 7200000).toISOString(),
      unitId: crypto.randomUUID(),
      actorUserId: actor.id,
    })
  );
  await refusal("ambiguous local timestamps are refused", "starts_at_timezone_required", () =>
    service.publishSlot({ propertyId, startsAt: "2026-09-01T10:00:00", endsAt: "2026-09-01T10:30:00-04:00", actorUserId: actor.id })
  );
  await refusal("group capacity is not falsely accepted", "unsupported_tour_capacity", () =>
    service.publishSlot({
      propertyId,
      startsAt: new Date(starts.getTime() + 10800000).toISOString(),
      endsAt: new Date(ends.getTime() + 10800000).toISOString(),
      capacity: 2,
      actorUserId: actor.id,
    })
  );

  console.log("\n-- Staff status commands --");
  const blocked = await service.changeSlotStatus({
    propertyId,
    slotId: first.slot.id,
    action: "block",
    actorUserId: actor.id,
    reason: "host unavailable",
    idempotencyKey: "block-1",
  });
  check("an open slot can be blocked", blocked.changed === true && blocked.slot.status === "blocked");
  await refusal("a blocked time cannot be republished as a duplicate", "tour_slot_already_blocked", () =>
    service.publishSlot({
      propertyId,
      startsAt: starts.toISOString(),
      endsAt: ends.toISOString(),
      leasingAgentId: actor.id,
      actorUserId: actor.id,
      idempotencyKey: "publish-after-block",
    })
  );
  const reopened = await service.changeSlotStatus({
    propertyId,
    slotId: first.slot.id,
    action: "reopen",
    actorUserId: actor.id,
    reason: "host available again",
    idempotencyKey: "reopen-1",
  });
  check("a blocked slot can be reopened", reopened.changed === true && reopened.slot.status === "open");
  const events = (await pool.query(
    "select event_type, actor_user_id from tour_availability_events where slot_id=$1 order by event_at",
    [first.slot.id]
  )).rows;
  check("history records opened, blocked, and reopened", events.map(e => e.event_type).join(",") === "opened,blocked,reopened");
  check("every status receipt keeps staff attribution", events.every(e => e.actor_user_id === actor.id));

  console.log("\n-- Canonical read --");
  const listed = await service.listSlots({
    propertyId,
    from: new Date(Date.now() + 24 * 3600000).toISOString(),
    to: new Date(Date.now() + 7 * 86400000).toISOString(),
    statuses: ["open"],
  });
  check("the native read returns the reopened slot", listed.slots.some(slot => slot.id === first.slot.id));
  const reopenedRead = listed.slots.find(slot => slot.id === first.slot.id);
  check("the read carries its latest receipt", reopenedRead && reopenedRead.latest_event_type === "reopened");

  await cleanup();
  const left = (await pool.query("select count(*)::int n from tour_availability_events where property_id=$1", [propertyId])).rows[0].n;
  check("cleanup leaves no proof receipts", left === 0);

  const exitCode = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: EXPECTED });
  await pool.end();
  process.exit(exitCode);
})().catch(async err => {
  const exitCode = receipt.died(__filename, err, pass + fail);
  try { await cleanup(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(exitCode);
});
