/*
  Proves the recurring native tour policy and staff callout commands against a
  disposable migrated database. No production property is touched.
*/
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const { databaseSsl } = require("../src/shared/database_ssl");
const { makeTourAvailabilityService, readTourScheduleStanding } = require("../src/leasing/tour_availability_service");

const URL = receipt.harnessConnectionString();
const EXPECTED = 25;
const pool = new Pool({ connectionString: URL, ssl: databaseSsl(URL) });
const service = makeTourAvailabilityService({ pool });
const propertyId = crypto.randomUUID();
const tag = `__TOUR_POLICY__${propertyId.slice(0, 8)}`;
let createdReplacement = null;
let pass = 0;
let fail = 0;

const weeklyHours = {
  monday: { start: "09:00", end: "17:00" },
  tuesday: { start: "09:00", end: "17:00" },
  wednesday: { start: "09:00", end: "17:00" },
  thursday: { start: "09:00", end: "17:00" },
  friday: { start: "09:00", end: "17:00" },
  saturday: { start: "10:00", end: "15:00" },
  sunday: null,
};

function check(label, condition, detail = "") {
  if (condition) { pass += 1; console.log(`   PASS  ${label}`); }
  else { fail += 1; console.log(`   FAIL  ${label}${detail ? ` (${detail})` : ""}`); }
}

async function refusal(label, expectedCode, fn) {
  let err = null;
  try { await fn(); } catch (caught) { err = caught; }
  check(label, !!err && err.code === expectedCode, err && `${err.code}: ${err.message}`);
}

async function cleanup() {
  await pool.query("delete from properties where id=$1 and name like '__TOUR_POLICY__%'", [propertyId]).catch(() => {});
  if (createdReplacement) await pool.query("delete from users where id=$1", [createdReplacement]).catch(() => {});
}

(async () => {
  receipt.begin(__filename, { url: URL, expected: EXPECTED });
  const actor = (await pool.query(
    "select id from users where is_active=true and status='active' order by created_at limit 1"
  )).rows[0];
  if (!actor) throw new Error("This proof needs one active user.");
  const replacement = (await pool.query(
    "select id, name from users where id<>$1 and is_active=true and status='active' order by created_at limit 1",
    [actor.id]
  )).rows[0] || (await pool.query(
    `insert into users (name,role,is_active,status,account_kind)
     values ($1,'leasing_agent',true,'active','human_staff') returning id, name`,
    [`${tag} replacement`]
  )).rows[0];
  if (String(replacement.id) !== String(actor.id)) {
    const created = (await pool.query("select name from users where id=$1", [replacement.id])).rows[0];
    if (created && created.name === `${tag} replacement`) createdReplacement = replacement.id;
  }

  await pool.query(
    "insert into properties (id,name,operating_timezone) values ($1,$2,'America/New_York')",
    [propertyId, tag]
  );
  for (const userId of [actor.id, replacement.id]) {
    await pool.query(
      `insert into property_team_assignments
         (property_id,user_id,role_title,allowed_modules,primary_for_modules,active)
       values ($1,$2,'Tour host',array['leasing'],array['leasing'],true)`,
      [propertyId, userId]
    );
  }

  console.log("\n-- Skyline-shaped weekly policy --");
  const published = await service.publishSchedulePolicy({
    propertyId,
    weeklyHours,
    slotDurationMinutes: 60,
    minimumNoticeMinutes: 120,
    holidayCalendar: "us_federal_observed",
    defaultHostUserId: actor.id,
    horizonDays: 10,
    fromLocalDate: "2027-06-28",
    actorUserId: actor.id,
    reason: "owner-confirmed Skyline tour policy",
    idempotencyKey: "policy-1",
  });
  check("the ten-day window publishes the expected 61 slots", published.generated_count === 61, String(published.generated_count));
  check("the observed Independence Day closure is reported", published.holiday_closures.some(row => row.local_date === "2027-07-05"));
  check("the policy stores 60-minute blocks and 2-hour notice",
    published.policy.slot_duration_minutes === 60 && published.policy.minimum_notice_minutes === 120);
  check("the policy stores the default host", published.policy.default_host_user_id === actor.id);

  const rows = (await pool.query(
    `select id, leasing_agent_id, starts_at, ends_at,
            to_char(starts_at at time zone 'America/New_York','YYYY-MM-DD') local_date,
            extract(epoch from (ends_at-starts_at))/60 duration
       from tour_availability where property_id=$1 order by starts_at`,
    [propertyId]
  )).rows;
  check("every generated time is exactly 60 minutes", rows.every(row => Number(row.duration) === 60));
  check("every generated time is assigned to the default host", rows.every(row => row.leasing_agent_id === actor.id));
  check("Saturday carries five openings", rows.filter(row => row.local_date === "2027-07-03").length === 5);
  check("the observed Monday holiday carries no openings", rows.filter(row => row.local_date === "2027-07-05").length === 0);

  const replay = await service.publishSchedulePolicy({
    propertyId,
    weeklyHours,
    slotDurationMinutes: 60,
    minimumNoticeMinutes: 120,
    holidayCalendar: "us_federal_observed",
    defaultHostUserId: actor.id,
    horizonDays: 10,
    fromLocalDate: "2027-06-28",
    actorUserId: actor.id,
    idempotencyKey: "policy-1",
  });
  check("policy publication replay returns the original receipt", replay.idempotent === true && replay.command_id === published.command_id);
  check("policy replay creates no duplicate times", Number((await pool.query(
    "select count(*)::int n from tour_availability where property_id=$1", [propertyId]
  )).rows[0].n) === 61);

  console.log("\n-- Default assignment and callout adjustments --");
  const insideNotice = new Date(Date.now() + 90 * 60000);
  const outsideNotice = new Date(Date.now() + 180 * 60000);
  await service.publishSlot({
    propertyId,
    startsAt: insideNotice.toISOString(),
    endsAt: new Date(insideNotice.getTime() + 60 * 60000).toISOString(),
    actorUserId: actor.id,
    idempotencyKey: "inside-notice",
  });
  await service.publishSlot({
    propertyId,
    startsAt: outsideNotice.toISOString(),
    endsAt: new Date(outsideNotice.getTime() + 60 * 60000).toISOString(),
    actorUserId: actor.id,
    idempotencyKey: "outside-notice",
  });
  const scheduleStanding = await readTourScheduleStanding(pool, { propertyId, limit: 24 });
  check("the canonical schedule read carries the established policy", scheduleStanding.read_state === "ESTABLISHED"
    && scheduleStanding.policy.default_host_name != null);
  check("the canonical schedule read excludes openings inside two-hour notice",
    !scheduleStanding.next_open_times.some(slot => new Date(slot.starts_at).getTime() === insideNotice.getTime()));
  check("the canonical schedule read includes openings outside two-hour notice",
    scheduleStanding.next_open_times.some(slot => new Date(slot.starts_at).getTime() === outsideNotice.getTime()));

  const manual = await service.publishSlot({
    propertyId,
    startsLocal: "2027-08-02T10:00",
    endsLocal: "2027-08-02T11:00",
    actorUserId: actor.id,
    idempotencyKey: "manual-default-host",
  });
  check("a manual time inherits the policy's default host", manual.slot.leasing_agent_id === actor.id);

  const bookedFixture = rows.find(row => row.local_date === "2027-06-29");
  await pool.query("update tour_availability set status='booked' where id=$1", [bookedFixture.id]);
  const closed = await service.adjustDay({
    propertyId,
    localDate: "2027-06-29",
    action: "close_open",
    actorUserId: actor.id,
    reason: "staff callout",
    idempotencyKey: "close-day-1",
  });
  check("a callout closes the seven remaining open times", closed.changed_count === 7, String(closed.changed_count));
  check("the booked tour remains scheduled and is reported", closed.booked_unchanged === 1 && (await pool.query(
    "select status from tour_availability where id=$1", [bookedFixture.id]
  )).rows[0].status === "booked");
  const afterCallout = await readTourScheduleStanding(pool, { propertyId, limit: 24 });
  check("the same schedule read exposes booked tours still needing coverage",
    afterCallout.coverage_attention.some(row => row.local_date === "2027-06-29" && row.booked_unchanged === 1));

  const reassigned = await service.adjustDay({
    propertyId,
    localDate: "2027-06-30",
    action: "reassign_open",
    newHostUserId: replacement.id,
    actorUserId: actor.id,
    reason: "coverage change",
    idempotencyKey: "reassign-day-1",
  });
  check("a coverage change reassigns all eight open times", reassigned.changed_count === 8, String(reassigned.changed_count));
  check("every changed time names the replacement host", (await pool.query(
    `select count(*)::int n from tour_availability
      where property_id=$1 and (starts_at at time zone 'America/New_York')::date='2027-06-30'::date
        and status='open' and leasing_agent_id=$2`,
    [propertyId, replacement.id]
  )).rows[0].n === 8);
  const afterReassignment = await readTourScheduleStanding(pool, { propertyId, limit: 24 });
  check("Ask Spine's schedule read names the replacement host",
    afterReassignment.future_adjustments.some(row => row.local_date === "2027-06-30"
      && row.new_host_name === replacement.name));
  const commandEvents = Number((await pool.query(
    "select count(*)::int n from tour_availability_events where command_id=$1",
    [reassigned.command_id]
  )).rows[0].n);
  check("the day command retains one event receipt per changed time", commandEvents === 8, String(commandEvents));
  const closeReplay = await service.adjustDay({
    propertyId, localDate: "2027-06-29", action: "close_open", actorUserId: actor.id, idempotencyKey: "close-day-1",
  });
  check("a repeated callout command is idempotent", closeReplay.idempotent === true && closeReplay.changed_count === 7);
  await refusal("a host without active leasing access is refused", "tour_host_property_mismatch", () =>
    service.adjustDay({ propertyId, localDate: "2027-07-01", action: "reassign_open", newHostUserId: crypto.randomUUID(), actorUserId: actor.id })
  );
  await refusal("a weekly window must divide into whole tour blocks", "tour_hours_do_not_fit_duration", () =>
    service.publishSchedulePolicy({ propertyId, weeklyHours: { monday: { start: "09:00", end: "09:30" } }, slotDurationMinutes: 60, actorUserId: actor.id })
  );

  await cleanup();
  check("cleanup removes the policy and all schedule receipts", Number((await pool.query(
    "select count(*)::int n from tour_availability_commands where property_id=$1", [propertyId]
  )).rows[0].n) === 0);

  const exitCode = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: EXPECTED });
  await pool.end();
  process.exit(exitCode);
})().catch(async err => {
  const exitCode = receipt.died(__filename, err, pass + fail);
  try { await cleanup(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(exitCode);
});
