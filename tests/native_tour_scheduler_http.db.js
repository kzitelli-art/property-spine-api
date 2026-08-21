#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const { databaseSsl } = require("../src/shared/database_ssl");
const staffSessions = require("../src/identity/staff_session_service");
const { makeTourAvailabilityService } = require("../src/leasing/tour_availability_service");

const URL = receipt.harnessConnectionString();
const EXPECTED = 20;
const pool = new Pool({ connectionString: URL, ssl: databaseSsl(URL) });
const propertyId = crypto.randomUUID();
const propertyName = `__NATIVE_TOUR_HTTP__ ${propertyId.slice(0, 8)}`;
let server = null;
let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
}

function localMinute(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

async function cleanup() {
  await pool.query("delete from staff_sessions where property_id=$1", [propertyId]).catch(() => {});
  const gone = await pool.query(
    "delete from properties where id=$1 and name like '__NATIVE_TOUR_HTTP__%'",
    [propertyId]
  ).catch(() => ({ rowCount: 0 }));
  console.log(`  cleanup property removed: ${gone.rowCount}`);
}

async function request(base, method, path, token = null, body = null, idempotencyKey = null) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-staff-session"] = token;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

(async () => {
  receipt.begin(__filename, { url: URL, expected: EXPECTED });
  const actor = (await pool.query(
    "select id from users where is_active=true and status='active' order by created_at limit 1"
  )).rows[0];
  if (!actor) throw new Error("This proof needs one active staff user.");

  await pool.query(
    "insert into properties (id,name,operating_timezone) values ($1,$2,'America/New_York')",
    [propertyId, propertyName]
  );
  await pool.query(
    `insert into property_team_assignments
       (property_id,user_id,role_title,allowed_modules,primary_for_modules,active)
     values ($1,$2,'Native scheduler proof',array['leasing'],array['leasing'],true)`,
    [propertyId, actor.id]
  );
  const session = await staffSessions.issueStaffSession(pool, {
    userId: actor.id,
    propertyId,
    purpose: "bootstrap_invite",
  });

  const tourAvailabilityService = makeTourAvailabilityService({ pool });
  const router = require("../src/identity/operator")({
    pool,
    agentService: {},
    tourAvailabilityService,
  });
  const app = express();
  app.use(express.json());
  app.use("/", router);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const starts = new Date(Date.now() + 72 * 3600000);
  const ends = new Date(starts.getTime() + 30 * 60000);
  const payload = {
    property_id: crypto.randomUUID(),
    starts_local: localMinute(starts, "America/New_York"),
    ends_local: localMinute(ends, "America/New_York"),
    reason: "HTTP proof",
  };

  const anonymous = await request(base, "POST", "/operator/leasing/tour-slots", null, payload);
  ok("no staff session is refused", anonymous.status === 401, JSON.stringify(anonymous.body));

  const published = await request(base, "POST", "/operator/leasing/tour-slots", session.session_token, payload, "http-publish-1");
  ok("signed-in leasing staff can publish a property-local tour time", published.status === 201 && published.body.created === true, JSON.stringify(published.body));
  const slotId = published.body.slot && published.body.slot.id;
  const stored = (await pool.query("select property_id,created_by,status from tour_availability where id=$1", [slotId])).rows[0];
  ok("body property spoofing cannot escape the session property", stored && stored.property_id === propertyId);
  ok("the slot records the authenticated staff user", stored && stored.created_by === actor.id);
  const opened = (await pool.query("select actor_user_id,event_type from tour_availability_events where slot_id=$1", [slotId])).rows[0];
  ok("the publication receipt records the same staff user", opened && opened.actor_user_id === actor.id && opened.event_type === "opened");

  const replay = await request(base, "POST", "/operator/leasing/tour-slots", session.session_token, payload, "http-publish-1");
  ok("a retried staff command returns the original slot", replay.status === 200 && replay.body.idempotent === true && replay.body.slot.id === slotId);
  const count = (await pool.query("select count(*)::int n from tour_availability where property_id=$1", [propertyId])).rows[0].n;
  ok("the retry creates no duplicate slot", count === 1, `count=${count}`);

  const listed = await request(base, "GET", "/operator/leasing/tour-slots?status=open", session.session_token);
  ok("the signed-in staff read returns the native slot", listed.status === 200 && listed.body.slots.some(slot => slot.id === slotId));
  ok("the read carries only session property scope", listed.body.slots.every(slot => slot.property_id === propertyId));
  ok("the same scheduler read returns only eligible tour hosts", listed.body.eligible_hosts.length === 1 && listed.body.eligible_hosts[0].id === actor.id);

  const schedule = await request(base, "POST", "/operator/leasing/tour-schedule", session.session_token, {
    property_id: crypto.randomUUID(),
    weekly_hours: {
      monday: { start: "09:00", end: "17:00" }, tuesday: { start: "09:00", end: "17:00" },
      wednesday: { start: "09:00", end: "17:00" }, thursday: { start: "09:00", end: "17:00" },
      friday: { start: "09:00", end: "17:00" }, saturday: { start: "10:00", end: "15:00" }, sunday: null,
    },
    slot_duration_minutes: 60,
    minimum_notice_minutes: 120,
    holiday_calendar: "us_federal_observed",
    default_host_user_id: actor.id,
    horizon_days: 7,
  }, "http-policy-1");
  ok("staff can publish one native weekly policy", schedule.status === 200 && schedule.body.generated_count > 0, JSON.stringify(schedule.body));
  ok("policy scope and attribution stay server-derived", schedule.body.policy.property_id === propertyId
    && schedule.body.policy.updated_by_user_id === actor.id);
  const policyRead = await request(base, "GET", "/operator/leasing/tour-slots?status=open", session.session_token);
  ok("the slot read returns the same weekly policy", policyRead.body.schedule_policy.minimum_notice_minutes === 120
    && policyRead.body.schedule_policy.default_host_user_id === actor.id);
  const day = (await pool.query(
    `select to_char(starts_at at time zone 'America/New_York','YYYY-MM-DD') local_date
       from tour_availability where property_id=$1 and status='open'
        and (starts_at at time zone 'America/New_York')::date<>$2::date
       order by starts_at limit 1`,
    [propertyId, payload.starts_local.slice(0, 10)]
  )).rows[0].local_date;
  const closedDay = await request(base, "POST", "/operator/leasing/tour-schedule/adjust-day", session.session_token, {
    local_date: day, action: "close_open", reason: "staff callout",
  }, "http-close-day-1");
  ok("staff can close a day's remaining open times atomically", closedDay.status === 200
    && closedDay.body.changed_count > 0 && closedDay.body.booked_unchanged === 0, JSON.stringify(closedDay.body));
  const dayReceipt = (await pool.query(
    "select actor_user_id from tour_availability_commands where id=$1", [closedDay.body.command_id]
  )).rows[0];
  ok("the day-level receipt records the signed-in staff user", dayReceipt && dayReceipt.actor_user_id === actor.id);

  const blocked = await request(base, "POST", `/operator/leasing/tour-slots/${slotId}/block`, session.session_token, { reason: "unavailable" }, "http-block-1");
  ok("staff can block an open time", blocked.status === 200 && blocked.body.slot.status === "blocked");
  const reopened = await request(base, "POST", `/operator/leasing/tour-slots/${slotId}/reopen`, session.session_token, { reason: "available" }, "http-reopen-1");
  ok("staff can reopen a blocked time", reopened.status === 200 && reopened.body.slot.status === "open");
  const eventTypes = (await pool.query(
    "select event_type from tour_availability_events where slot_id=$1 order by event_at",
    [slotId]
  )).rows.map(row => row.event_type).join(",");
  ok("the HTTP path retains the full change history", eventTypes === "opened,blocked,reopened", eventTypes);

  const crossProperty = await request(base, "POST", `/operator/leasing/tour-slots/${crypto.randomUUID()}/block`, session.session_token, {});
  ok("an unknown or cross-property slot id is refused", crossProperty.status === 404);

  await pool.query("update property_team_assignments set allowed_modules='{}' where property_id=$1 and user_id=$2", [propertyId, actor.id]);
  const noModule = await request(base, "GET", "/operator/leasing/tour-slots", session.session_token);
  ok("a live loss of leasing access is enforced on the next request", noModule.status === 403, JSON.stringify(noModule.body));

  server.close();
  await cleanup();
  const exitCode = receipt.complete({ harness: __filename, passed, failed, expectedAtLeast: EXPECTED });
  await pool.end();
  process.exit(exitCode);
})().catch(async err => {
  const exitCode = receipt.died(__filename, err, passed + failed);
  try { if (server) server.close(); } catch (_) {}
  try { await cleanup(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(exitCode);
});
