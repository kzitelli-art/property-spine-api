"use strict";

const { loadPropertyOperatingTimeZone } = require("../shared/property_timezone");
const { federalHolidayClosure } = require("../shared/us_federal_holidays");

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function commandError(httpStatus, publicMessage, code) {
  const err = new Error(publicMessage);
  err.httpStatus = httpStatus;
  err.publicMessage = publicMessage;
  err.code = code;
  return err;
}

function asInstant(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw commandError(400, `${field} is required.`, `${field}_required`);
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw commandError(400, `${field} must be an ISO timestamp with a timezone.`, `invalid_${field}`);
  }
  // A bare local timestamp is ambiguous at DST boundaries. Require an explicit
  // offset or Z and keep the property timezone solely for display/operating days.
  if (!/(?:z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    throw commandError(400, `${field} must include a timezone offset.`, `${field}_timezone_required`);
  }
  return instant;
}

function asLocalWallTime(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value.trim())) {
    throw commandError(400, `${field} must be a property-local date and time.`, `invalid_${field}`);
  }
  return value.trim().slice(0, 16);
}

async function resolveLocalWindow(client, { startsLocal, endsLocal, timezone }) {
  let row;
  try {
    row = (await client.query(
      `select ($1::timestamp at time zone $3) as starts_at,
              ($2::timestamp at time zone $3) as ends_at,
              to_char((($1::timestamp at time zone $3) at time zone $3), 'YYYY-MM-DD"T"HH24:MI') as starts_roundtrip,
              to_char((($2::timestamp at time zone $3) at time zone $3), 'YYYY-MM-DD"T"HH24:MI') as ends_roundtrip,
              (((($1::timestamp at time zone $3) - interval '1 hour') at time zone $3)::timestamp = $1::timestamp
                or ((($1::timestamp at time zone $3) + interval '1 hour') at time zone $3)::timestamp = $1::timestamp) as starts_ambiguous,
              (((($2::timestamp at time zone $3) - interval '1 hour') at time zone $3)::timestamp = $2::timestamp
                or ((($2::timestamp at time zone $3) + interval '1 hour') at time zone $3)::timestamp = $2::timestamp) as ends_ambiguous`,
      [startsLocal, endsLocal, timezone]
    )).rows[0];
  } catch (err) {
    if (err && ["22007", "22008"].includes(err.code)) {
      throw commandError(400, "The property-local tour date or time is invalid.", "invalid_tour_local_window");
    }
    throw err;
  }
  if (row.starts_roundtrip !== startsLocal || row.ends_roundtrip !== endsLocal) {
    throw commandError(409, "That local time does not exist because the clock changes then. Choose another time.", "nonexistent_tour_local_time");
  }
  if (row.starts_ambiguous || row.ends_ambiguous) {
    throw commandError(409, "That local time occurs twice because the clock changes then. Choose another time or provide an explicit offset.", "ambiguous_tour_local_time");
  }
  return { starts: new Date(row.starts_at), ends: new Date(row.ends_at) };
}

function normalizeCapacity(value) {
  const capacity = value == null ? 1 : Number(value);
  if (!Number.isInteger(capacity) || capacity !== 1) {
    throw commandError(400, "Tour slots currently support capacity 1.", "unsupported_tour_capacity");
  }
  return capacity;
}

function asLocalDate(value, field = "local_date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw commandError(400, `${field} must be YYYY-MM-DD.`, `invalid_${field}`);
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw commandError(400, `${field} is not a real calendar date.`, `invalid_${field}`);
  }
  return value;
}

function clockMinutes(value, field) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) {
    throw commandError(400, `${field} must be HH:MM.`, `invalid_${field}`);
  }
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) {
    throw commandError(400, `${field} is not a valid time.`, `invalid_${field}`);
  }
  return hour * 60 + minute;
}

function minuteClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function normalizeDuration(value) {
  const duration = Number(value == null ? 60 : value);
  if (!Number.isInteger(duration) || duration < 15 || duration > 240) {
    throw commandError(400, "Tour duration must be 15 to 240 whole minutes.", "invalid_tour_duration");
  }
  return duration;
}

function normalizeHorizon(value) {
  const horizon = Number(value == null ? 45 : value);
  if (!Number.isInteger(horizon) || horizon < 7 || horizon > 180) {
    throw commandError(400, "Tour schedule horizon must be 7 to 180 days.", "invalid_tour_horizon");
  }
  return horizon;
}

function normalizeMinimumNotice(value) {
  const notice = Number(value == null ? 120 : value);
  if (!Number.isInteger(notice) || notice < 0 || notice > 10080) {
    throw commandError(400, "Tour minimum notice must be 0 to 10,080 whole minutes.", "invalid_tour_minimum_notice");
  }
  return notice;
}

function normalizeWeeklyHours(value, duration) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw commandError(400, "weekly_hours must name each open weekday.", "invalid_tour_weekly_hours");
  }
  const unknown = Object.keys(value).filter(key => !WEEKDAYS.includes(key));
  if (unknown.length) {
    throw commandError(400, `Unknown weekday: ${unknown[0]}.`, "invalid_tour_weekday");
  }
  const out = {};
  let openDays = 0;
  for (const day of WEEKDAYS) {
    const window = value[day];
    if (window == null || window === false) { out[day] = null; continue; }
    if (typeof window !== "object" || Array.isArray(window)) {
      throw commandError(400, `${day} must have start and end times.`, "invalid_tour_weekly_hours");
    }
    const start = clockMinutes(window.start, `${day}.start`);
    const end = clockMinutes(window.end, `${day}.end`);
    if (end <= start || (end - start) % duration !== 0) {
      throw commandError(400, `${day} must contain whole ${duration}-minute tour blocks.`, "tour_hours_do_not_fit_duration");
    }
    out[day] = { start: minuteClock(start), end: minuteClock(end) };
    openDays += 1;
  }
  if (!openDays) throw commandError(400, "At least one tour day must be open.", "tour_schedule_has_no_open_days");
  return out;
}

function addLocalDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function policyCandidates({ fromLocalDate, horizonDays, weeklyHours, durationMinutes, holidayCalendar }) {
  const candidates = [];
  const holidayClosures = [];
  for (let offset = 0; offset < horizonDays; offset += 1) {
    const localDate = addLocalDays(fromLocalDate, offset);
    const day = WEEKDAYS[new Date(`${localDate}T12:00:00Z`).getUTCDay()];
    const window = weeklyHours[day];
    if (!window) continue;
    const holiday = holidayCalendar === "us_federal_observed" ? federalHolidayClosure(localDate) : null;
    if (holiday) { holidayClosures.push({ local_date: localDate, holiday }); continue; }
    const start = clockMinutes(window.start, `${day}.start`);
    const end = clockMinutes(window.end, `${day}.end`);
    for (let minute = start; minute + durationMinutes <= end; minute += durationMinutes) {
      candidates.push({
        starts_local: `${localDate}T${minuteClock(minute)}`,
        ends_local: `${localDate}T${minuteClock(minute + durationMinutes)}`,
      });
    }
  }
  return { candidates, holidayClosures };
}

async function resolveLocalCandidates(client, candidates, timezone) {
  if (!candidates.length) return [];
  let rows;
  try {
    rows = (await client.query(
      `with input as (
         select starts_local, ends_local, ordinal
           from unnest($1::text[], $2::text[]) with ordinality
                as item(starts_local, ends_local, ordinal)
       ), resolved as (
         select input.*,
                starts_local::timestamp at time zone $3 as starts_at,
                ends_local::timestamp at time zone $3 as ends_at
           from input
       )
       select starts_local, ends_local, starts_at, ends_at,
              to_char(starts_at at time zone $3, 'YYYY-MM-DD"T"HH24:MI') as starts_roundtrip,
              to_char(ends_at at time zone $3, 'YYYY-MM-DD"T"HH24:MI') as ends_roundtrip,
              ((((starts_at - interval '1 hour') at time zone $3)::timestamp = starts_local::timestamp)
                or (((starts_at + interval '1 hour') at time zone $3)::timestamp = starts_local::timestamp)) as starts_ambiguous,
              ((((ends_at - interval '1 hour') at time zone $3)::timestamp = ends_local::timestamp)
                or (((ends_at + interval '1 hour') at time zone $3)::timestamp = ends_local::timestamp)) as ends_ambiguous
         from resolved
        order by ordinal`,
      [candidates.map(item => item.starts_local), candidates.map(item => item.ends_local), timezone]
    )).rows;
  } catch (err) {
    if (err && ["22007", "22008"].includes(err.code)) {
      throw commandError(400, "The weekly tour policy contains an invalid local time.", "invalid_tour_policy_window");
    }
    throw err;
  }
  const invalid = rows.find(row => (
    row.starts_roundtrip !== row.starts_local
    || row.ends_roundtrip !== row.ends_local
    || row.starts_ambiguous
    || row.ends_ambiguous
  ));
  if (invalid) {
    throw commandError(
      409,
      `The tour policy produces an unavailable clock-change time at ${invalid.starts_local}.`,
      "tour_policy_clock_change_conflict"
    );
  }
  return rows.map(row => ({ starts_at: row.starts_at, ends_at: row.ends_at }));
}

async function assertPropertyTimezone(client, propertyId) {
  const timezone = await loadPropertyOperatingTimeZone(client, propertyId);
  if (!timezone) {
    throw commandError(
      422,
      "This property needs an operating timezone before tour times can be published.",
      "property_operating_timezone_not_configured"
    );
  }
  return timezone;
}

async function loadEligibleTourHosts(client, propertyId) {
  return (await client.query(
    `select distinct u.id, u.name, u.role
       from property_team_assignments pta
       join users u on u.id=pta.user_id
      where pta.property_id=$1 and pta.active=true
        and 'leasing'=any(coalesce(pta.allowed_modules, '{}'))
        and u.is_active=true and u.status='active'
      order by u.name, u.id`,
    [propertyId]
  )).rows;
}

async function loadSchedulePolicy(client, propertyId) {
  return (await client.query(
    `select policy.*, host.name as default_host_name
       from tour_schedule_policies policy
       left join users host on host.id=policy.default_host_user_id
      where policy.property_id=$1 and policy.active=true`,
    [propertyId]
  )).rows[0] || null;
}

async function loadPriorCommand(client, { propertyId, idempotencyKey, commandType }) {
  if (!idempotencyKey) return null;
  const prior = (await client.query(
    `select * from tour_availability_commands
      where property_id=$1 and idempotency_key=$2`,
    [propertyId, idempotencyKey]
  )).rows[0];
  if (prior && prior.command_type !== commandType) {
    throw commandError(409, "That idempotency key was already used for a different schedule command.", "tour_command_idempotency_conflict");
  }
  return prior || null;
}

async function readTourScheduleStanding(db, { propertyId, limit = 12 }) {
  if (!db || typeof db.query !== "function") throw new TypeError("tour schedule standing requires a database client");
  if (!propertyId) throw commandError(400, "propertyId is required.", "property_id_required");
  const timezone = await loadPropertyOperatingTimeZone(db, propertyId);
  if (!timezone) {
    return {
      property_id: propertyId,
      read_state: "NOT_CONFIGURED",
      operating_timezone: null,
      policy: null,
      next_open_times: [],
      future_adjustments: [],
      coverage_attention: [],
    };
  }
  const policy = await loadSchedulePolicy(db, propertyId);
  if (!policy) {
    return {
      property_id: propertyId,
      read_state: "NOT_CONFIGURED",
      operating_timezone: timezone,
      policy: null,
      next_open_times: [],
      future_adjustments: [],
      coverage_attention: [],
    };
  }
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 12, 24));
  const [openRows, adjustments] = await Promise.all([
    db.query(
      `select slot.starts_at, slot.ends_at,
              to_char(slot.starts_at at time zone $2, 'YYYY-MM-DD"T"HH24:MI') as starts_local,
              to_char(slot.ends_at at time zone $2, 'YYYY-MM-DD"T"HH24:MI') as ends_local,
              host.name as host_name
        from tour_availability slot
         left join users host on host.id=slot.leasing_agent_id
        where slot.property_id=$1 and slot.status='open'
          and slot.starts_at >= now() + ($4::int * interval '1 minute')
        order by slot.starts_at
        limit $3`,
      [propertyId, timezone, boundedLimit, policy.minimum_notice_minutes]
    ),
    db.query(
      `select command.command_type, command.local_date::text, command.result,
              command.reason, command.recorded_at, replacement.name as new_host_name
         from tour_availability_commands command
         left join users replacement
           on replacement.id=nullif(command.result->>'new_host_user_id', '')::uuid
        where command.property_id=$1 and command.local_date is not null
          and command.local_date >= (now() at time zone $2)::date
        order by command.local_date, command.recorded_at desc
        limit 20`,
      [propertyId, timezone]
    ),
  ]);
  const futureAdjustments = adjustments.rows.map(row => ({
    command_type: row.command_type,
    local_date: row.local_date,
    changed_count: Number(row.result?.changed_count || 0),
    booked_unchanged: Number(row.result?.booked_unchanged || 0),
    new_host_name: row.new_host_name || null,
    reason: row.reason || null,
    recorded_at: row.recorded_at,
  }));
  return {
    property_id: propertyId,
    read_state: "ESTABLISHED",
    operating_timezone: timezone,
    policy: {
      weekly_hours: policy.weekly_hours,
      slot_duration_minutes: policy.slot_duration_minutes,
      minimum_notice_minutes: policy.minimum_notice_minutes,
      holiday_calendar: policy.holiday_calendar,
      default_host_name: policy.default_host_name || null,
      horizon_days: policy.horizon_days,
      updated_at: policy.updated_at,
    },
    next_open_times: openRows.rows,
    future_adjustments: futureAdjustments,
    coverage_attention: futureAdjustments.filter(row => row.booked_unchanged > 0),
  };
}

async function assertOptionalScope(client, { propertyId, unitId, leasingAgentId }) {
  if (unitId) {
    const unit = (await client.query(
      "select id from units where id=$1 and property_id=$2",
      [unitId, propertyId]
    )).rows[0];
    if (!unit) throw commandError(409, "That unit is not part of this property.", "tour_unit_property_mismatch");
  }

  if (leasingAgentId) {
    const assignment = (await client.query(
      `select 1
         from property_team_assignments pta
         join users u on u.id=pta.user_id
        where pta.property_id=$1 and pta.user_id=$2 and pta.active=true
          and 'leasing'=any(coalesce(pta.allowed_modules, '{}'))
          and u.is_active=true and u.status='active'
        limit 1`,
      [propertyId, leasingAgentId]
    )).rows[0];
    if (!assignment) {
      throw commandError(409, "That tour host does not have active leasing access at this property.", "tour_host_property_mismatch");
    }
  }
}

function makeTourAvailabilityService({ pool }) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("makeTourAvailabilityService requires { pool }");
  }

  async function publishSlot({
    propertyId,
    startsAt,
    endsAt,
    startsLocal = null,
    endsLocal = null,
    unitId = null,
    leasingAgentId = null,
    capacity = 1,
    actorUserId = null,
    actorType = "human_staff",
    reason = null,
    idempotencyKey = null,
  }) {
    if (!propertyId) throw commandError(400, "propertyId is required.", "property_id_required");
    const localMode = startsLocal != null || endsLocal != null;
    const normalizedStartsLocal = localMode ? asLocalWallTime(startsLocal, "starts_local") : null;
    const normalizedEndsLocal = localMode ? asLocalWallTime(endsLocal, "ends_local") : null;
    let starts = localMode ? null : asInstant(startsAt, "starts_at");
    let ends = localMode ? null : asInstant(endsAt, "ends_at");
    const normalizedCapacity = normalizeCapacity(capacity);

    const client = await pool.connect();
    try {
      await client.query("begin");
      const timezone = await assertPropertyTimezone(client, propertyId);
      if (localMode) {
        ({ starts, ends } = await resolveLocalWindow(client, {
          startsLocal: normalizedStartsLocal,
          endsLocal: normalizedEndsLocal,
          timezone,
        }));
      }
      let effectiveLeasingAgentId = leasingAgentId;
      if (!effectiveLeasingAgentId) {
        const policy = await loadSchedulePolicy(client, propertyId);
        effectiveLeasingAgentId = policy?.default_host_user_id || null;
      }
      if (ends <= starts) throw commandError(400, "The tour end must be after its start.", "invalid_tour_slot_window");
      if (starts <= new Date()) throw commandError(409, "Tour availability must start in the future.", "tour_slot_not_future");
      await assertOptionalScope(client, { propertyId, unitId, leasingAgentId: effectiveLeasingAgentId });

      if (idempotencyKey) {
        const prior = (await client.query(
          `select av.*
             from tour_availability_events e
             join tour_availability av on av.id=e.slot_id
            where e.property_id=$1 and e.idempotency_key=$2
            limit 1`,
          [propertyId, idempotencyKey]
        )).rows[0];
        if (prior) {
          await client.query("rollback");
          return { slot: prior, timezone, created: false, idempotent: true };
        }
      }

      // Serialize publication within a property so two retries cannot create the
      // same exact slot before either can see the other's row.
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`tour_availability:${propertyId}`]);
      const existing = (await client.query(
        `select * from tour_availability
          where property_id=$1
            and starts_at=$2 and ends_at=$3
            and unit_id is not distinct from $4::uuid
            and leasing_agent_id is not distinct from $5::uuid
            and status in ('open','booked','blocked')
          order by created_at asc
          limit 1`,
        [propertyId, starts.toISOString(), ends.toISOString(), unitId, effectiveLeasingAgentId]
      )).rows[0];
      if (existing) {
        if (existing.status === "blocked") {
          throw commandError(409, "That exact tour time is blocked. Reopen the existing time instead.", "tour_slot_already_blocked");
        }
        await client.query("rollback");
        return { slot: existing, timezone, created: false, idempotent: false };
      }

      const slot = (await client.query(
        `insert into tour_availability
           (property_id, unit_id, leasing_agent_id, starts_at, ends_at, capacity, status, created_by)
         values ($1,$2,$3,$4,$5,$6,'open',$7)
         returning *`,
        [propertyId, unitId, effectiveLeasingAgentId, starts.toISOString(), ends.toISOString(), normalizedCapacity, actorUserId]
      )).rows[0];
      await client.query(
        `insert into tour_availability_events
           (property_id, slot_id, event_type, before_status, after_status,
            actor_user_id, actor_type, reason, idempotency_key)
         values ($1,$2,'opened',null,'open',$3,$4,$5,$6)`,
        [propertyId, slot.id, actorUserId, actorType, reason, idempotencyKey]
      );
      await client.query("commit");
      return { slot, timezone, created: true, idempotent: false };
    } catch (err) {
      try { await client.query("rollback"); } catch (_) {}
      if (err && err.code === "23505" && idempotencyKey) {
        const prior = (await pool.query(
          `select av.*
             from tour_availability_events e
             join tour_availability av on av.id=e.slot_id
            where e.property_id=$1 and e.idempotency_key=$2
            limit 1`,
          [propertyId, idempotencyKey]
        )).rows[0];
        if (prior) return { slot: prior, timezone: await assertPropertyTimezone(pool, propertyId), created: false, idempotent: true };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function listSlots({ propertyId, from = null, to = null, statuses = null, limit = 250 }) {
    if (!propertyId) throw commandError(400, "propertyId is required.", "property_id_required");
    const timezone = await assertPropertyTimezone(pool, propertyId);
    const schedulePolicy = await loadSchedulePolicy(pool, propertyId);
    const allowedStatuses = new Set(["open", "booked", "blocked", "cancelled"]);
    const selected = Array.isArray(statuses) && statuses.length ? statuses.map(String) : ["open", "booked", "blocked"];
    if (selected.some(status => !allowedStatuses.has(status))) {
      throw commandError(400, "Unknown tour availability status.", "invalid_tour_slot_status");
    }
    const fromInstant = from ? asInstant(from, "from") : new Date();
    const defaultHorizonDays = Number(schedulePolicy?.horizon_days) || 45;
    const toInstant = to ? asInstant(to, "to") : new Date(fromInstant.getTime() + defaultHorizonDays * 86400000);
    if (toInstant <= fromInstant) throw commandError(400, "to must be after from.", "invalid_tour_slot_range");
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 250, 500));
    const [slotResult, eligibleHosts] = await Promise.all([pool.query(
      `select av.*, u.unit_number, host.name as leasing_agent_name,
              latest.event_type as latest_event_type,
              latest.event_at as latest_event_at,
              latest.actor_user_id as latest_actor_user_id
         from tour_availability av
         left join units u on u.id=av.unit_id and u.property_id=av.property_id
         left join users host on host.id=av.leasing_agent_id
         left join lateral (
           select e.event_type, e.event_at, e.actor_user_id
             from tour_availability_events e
            where e.slot_id=av.id
            order by e.event_at desc
            limit 1
         ) latest on true
        where av.property_id=$1
          and av.starts_at >= $2 and av.starts_at < $3
          and av.status=any($4::text[])
        order by av.starts_at, av.id
        limit $5`,
      [propertyId, fromInstant.toISOString(), toInstant.toISOString(), selected, boundedLimit]
    ), loadEligibleTourHosts(pool, propertyId)]);
    return {
      property_id: propertyId,
      operating_timezone: timezone,
      from: fromInstant.toISOString(),
      to: toInstant.toISOString(),
      slots: slotResult.rows,
      eligible_hosts: eligibleHosts,
      schedule_policy: schedulePolicy,
    };
  }

  async function getSchedulePolicy({ propertyId, client = null }) {
    if (!propertyId) throw commandError(400, "propertyId is required.", "property_id_required");
    const db = client || pool;
    const timezone = await loadPropertyOperatingTimeZone(db, propertyId);
    return { property_id: propertyId, operating_timezone: timezone, policy: await loadSchedulePolicy(db, propertyId) };
  }

  async function publishSchedulePolicy({
    propertyId,
    weeklyHours,
    slotDurationMinutes = 60,
    minimumNoticeMinutes = 120,
    holidayCalendar = "none",
    defaultHostUserId = null,
    horizonDays = 45,
    fromLocalDate = null,
    actorUserId = null,
    actorType = "human_staff",
    reason = null,
    idempotencyKey = null,
  }) {
    if (!propertyId) throw commandError(400, "propertyId is required.", "property_id_required");
    const duration = normalizeDuration(slotDurationMinutes);
    const minimumNotice = normalizeMinimumNotice(minimumNoticeMinutes);
    const horizon = normalizeHorizon(horizonDays);
    const normalizedHours = normalizeWeeklyHours(weeklyHours, duration);
    if (!new Set(["none", "us_federal_observed"]).has(holidayCalendar)) {
      throw commandError(400, "Unknown tour holiday calendar.", "invalid_tour_holiday_calendar");
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const timezone = await assertPropertyTimezone(client, propertyId);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`tour_availability:${propertyId}`]);
      const prior = await loadPriorCommand(client, { propertyId, idempotencyKey, commandType: "policy_published" });
      if (prior) {
        const policy = await loadSchedulePolicy(client, propertyId);
        await client.query("rollback");
        return { ...prior.result, policy, command_id: prior.id, idempotent: true };
      }
      await assertOptionalScope(client, { propertyId, unitId: null, leasingAgentId: defaultHostUserId });

      const today = (await client.query(
        "select to_char(now() at time zone $1, 'YYYY-MM-DD') as local_date",
        [timezone]
      )).rows[0].local_date;
      const startsOn = fromLocalDate == null ? today : asLocalDate(fromLocalDate, "from_local_date");
      if (startsOn < today) {
        throw commandError(409, "Tour schedule publication cannot begin in the past.", "tour_schedule_starts_in_past");
      }

      await client.query(
        `insert into tour_schedule_policies
           (property_id, weekly_hours, slot_duration_minutes, minimum_notice_minutes, holiday_calendar,
            default_host_user_id, horizon_days, active, updated_by_user_id, updated_at)
         values ($1,$2::jsonb,$3,$4,$5,$6,$7,true,$8,now())
         on conflict (property_id) do update
           set weekly_hours=excluded.weekly_hours,
               slot_duration_minutes=excluded.slot_duration_minutes,
               minimum_notice_minutes=excluded.minimum_notice_minutes,
               holiday_calendar=excluded.holiday_calendar,
               default_host_user_id=excluded.default_host_user_id,
               horizon_days=excluded.horizon_days,
               active=true,
               updated_by_user_id=excluded.updated_by_user_id,
               updated_at=now()`,
        [propertyId, JSON.stringify(normalizedHours), duration, minimumNotice, holidayCalendar, defaultHostUserId, horizon, actorUserId]
      );

      const input = {
        weekly_hours: normalizedHours,
        slot_duration_minutes: duration,
        minimum_notice_minutes: minimumNotice,
        holiday_calendar: holidayCalendar,
        default_host_user_id: defaultHostUserId,
        horizon_days: horizon,
        from_local_date: startsOn,
      };
      const command = (await client.query(
        `insert into tour_availability_commands
           (property_id, command_type, input, actor_user_id, actor_type, reason, idempotency_key)
         values ($1,'policy_published',$2::jsonb,$3,$4,$5,$6)
         returning *`,
        [propertyId, JSON.stringify(input), actorUserId, actorType, reason, idempotencyKey]
      )).rows[0];

      const { candidates, holidayClosures } = policyCandidates({
        fromLocalDate: startsOn,
        horizonDays: horizon,
        weeklyHours: normalizedHours,
        durationMinutes: duration,
        holidayCalendar,
      });
      const resolved = await resolveLocalCandidates(client, candidates, timezone);
      const inserted = resolved.length ? (await client.query(
        `with input as (
           select starts_at, ends_at
             from unnest($1::timestamptz[], $2::timestamptz[]) as item(starts_at, ends_at)
         )
         insert into tour_availability
           (property_id, unit_id, leasing_agent_id, starts_at, ends_at, capacity, status, created_by)
         select $3, null, $4, input.starts_at, input.ends_at, 1, 'open', $5
           from input
          where input.starts_at >= now() + ($6::int * interval '1 minute')
            and not exists (
              select 1 from tour_availability existing
               where existing.property_id=$3
                 and existing.starts_at=input.starts_at
                 and existing.ends_at=input.ends_at
                 and existing.unit_id is null
                 and existing.status in ('open','booked','blocked')
            )
         returning *`,
        [resolved.map(item => item.starts_at), resolved.map(item => item.ends_at), propertyId, defaultHostUserId, actorUserId, minimumNotice]
      )).rows : [];

      if (inserted.length) {
        await client.query(
          `insert into tour_availability_events
             (property_id, slot_id, command_id, event_type, before_status, after_status,
              before_host_user_id, after_host_user_id, actor_user_id, actor_type, reason)
           select $1, slot_id, $2, 'opened', null, 'open', null, $3, $4, $5, $6
             from unnest($7::uuid[]) as item(slot_id)`,
          [propertyId, command.id, defaultHostUserId, actorUserId, actorType, reason, inserted.map(slot => slot.id)]
        );
      }

      const result = {
        generated_count: inserted.length,
        existing_count: resolved.length - inserted.length,
        holiday_closures: holidayClosures,
        horizon_from: startsOn,
        horizon_through: addLocalDays(startsOn, horizon - 1),
      };
      await client.query(
        "update tour_availability_commands set result=$2::jsonb where id=$1",
        [command.id, JSON.stringify(result)]
      );
      const policy = await loadSchedulePolicy(client, propertyId);
      await client.query("commit");
      return { ...result, policy, command_id: command.id, idempotent: false };
    } catch (err) {
      try { await client.query("rollback"); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function adjustDay({
    propertyId,
    localDate,
    action,
    newHostUserId = null,
    actorUserId = null,
    actorType = "human_staff",
    reason = null,
    idempotencyKey = null,
  }) {
    if (!propertyId) throw commandError(400, "propertyId is required.", "property_id_required");
    const date = asLocalDate(localDate);
    if (!new Set(["close_open", "reassign_open"]).has(action)) {
      throw commandError(400, "action must close or reassign the day's open tour times.", "invalid_tour_day_action");
    }
    if (action === "reassign_open" && !newHostUserId) {
      throw commandError(400, "A replacement tour host is required.", "tour_replacement_host_required");
    }
    const commandType = action === "close_open" ? "day_closed" : "day_reassigned";
    const client = await pool.connect();
    try {
      await client.query("begin");
      const timezone = await assertPropertyTimezone(client, propertyId);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`tour_availability:${propertyId}`]);
      const prior = await loadPriorCommand(client, { propertyId, idempotencyKey, commandType });
      if (prior) {
        await client.query("rollback");
        return { ...prior.result, command_id: prior.id, idempotent: true };
      }
      const today = (await client.query(
        "select to_char(now() at time zone $1, 'YYYY-MM-DD') as local_date",
        [timezone]
      )).rows[0].local_date;
      if (date < today) {
        throw commandError(409, "Past tour days cannot be adjusted.", "tour_day_is_past");
      }
      if (action === "reassign_open") {
        await assertOptionalScope(client, { propertyId, unitId: null, leasingAgentId: newHostUserId });
      }

      const input = { local_date: date, action, new_host_user_id: newHostUserId };
      const command = (await client.query(
        `insert into tour_availability_commands
           (property_id, command_type, local_date, input, actor_user_id, actor_type, reason, idempotency_key)
         values ($1,$2,$3::date,$4::jsonb,$5,$6,$7,$8)
         returning *`,
        [propertyId, commandType, date, JSON.stringify(input), actorUserId, actorType, reason, idempotencyKey]
      )).rows[0];

      const datePredicate = "property_id=$1 and (starts_at at time zone $2)::date=$3::date";
      let changed;
      if (action === "close_open") {
        changed = (await client.query(
          `with selected as (
             select id, leasing_agent_id
               from tour_availability
              where ${datePredicate} and status='open'
              for update
           )
           update tour_availability slot
              set status='blocked', updated_at=now()
             from selected
            where slot.id=selected.id
           returning slot.*, selected.leasing_agent_id as before_host_user_id`,
          [propertyId, timezone, date]
        )).rows;
      } else {
        changed = (await client.query(
          `with selected as (
             select id, leasing_agent_id
               from tour_availability
              where ${datePredicate} and status='open'
                and leasing_agent_id is distinct from $4::uuid
              for update
           )
           update tour_availability slot
              set leasing_agent_id=$4, updated_at=now()
             from selected
            where slot.id=selected.id
           returning slot.*, selected.leasing_agent_id as before_host_user_id`,
          [propertyId, timezone, date, newHostUserId]
        )).rows;
      }

      if (changed.length) {
        const eventType = action === "close_open" ? "blocked" : "reassigned";
        const afterStatus = action === "close_open" ? "blocked" : "open";
        await client.query(
          `insert into tour_availability_events
             (property_id, slot_id, command_id, event_type, before_status, after_status,
              before_host_user_id, after_host_user_id, actor_user_id, actor_type, reason)
           select $1, slot_id, $2, $3, 'open', $4, before_host_user_id,
                  after_host_user_id, $5, $6, $7
             from unnest($8::uuid[], $9::uuid[], $10::uuid[])
                  as item(slot_id, before_host_user_id, after_host_user_id)`,
          [
            propertyId,
            command.id,
            eventType,
            afterStatus,
            actorUserId,
            actorType,
            reason,
            changed.map(slot => slot.id),
            changed.map(slot => slot.before_host_user_id),
            changed.map(slot => slot.leasing_agent_id),
          ]
        );
      }
      const bookedUnchanged = Number((await client.query(
        `select count(*)::int as count
           from tour_availability
          where ${datePredicate} and status='booked'`,
        [propertyId, timezone, date]
      )).rows[0].count);
      const result = {
        local_date: date,
        action,
        changed_count: changed.length,
        booked_unchanged: bookedUnchanged,
        new_host_user_id: action === "reassign_open" ? newHostUserId : null,
      };
      await client.query(
        "update tour_availability_commands set result=$2::jsonb where id=$1",
        [command.id, JSON.stringify(result)]
      );
      await client.query("commit");
      return { ...result, command_id: command.id, idempotent: false };
    } catch (err) {
      try { await client.query("rollback"); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function changeSlotStatus({
    propertyId,
    slotId,
    action,
    actorUserId = null,
    actorType = "human_staff",
    reason = null,
    idempotencyKey = null,
  }) {
    if (!propertyId || !slotId) throw commandError(400, "propertyId and slotId are required.", "tour_slot_identity_required");
    if (!new Set(["block", "reopen"]).has(action)) {
      throw commandError(400, "action must be block or reopen.", "invalid_tour_slot_action");
    }
    const beforeRequired = action === "block" ? "open" : "blocked";
    const afterStatus = action === "block" ? "blocked" : "open";
    const eventType = action === "block" ? "blocked" : "reopened";
    const client = await pool.connect();
    try {
      await client.query("begin");
      const timezone = await assertPropertyTimezone(client, propertyId);
      // Publication uses this same property lock. Keeping status changes on the
      // same lock prevents a reopen racing a republish into duplicate open rows.
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`tour_availability:${propertyId}`]);
      if (idempotencyKey) {
        const prior = (await client.query(
          `select av.*
             from tour_availability_events e
             join tour_availability av on av.id=e.slot_id
            where e.property_id=$1 and e.idempotency_key=$2
            limit 1`,
          [propertyId, idempotencyKey]
        )).rows[0];
        if (prior) {
          await client.query("rollback");
          return { slot: prior, timezone, changed: false, idempotent: true };
        }
      }
      const slot = (await client.query(
        "select * from tour_availability where id=$1 and property_id=$2 for update",
        [slotId, propertyId]
      )).rows[0];
      if (!slot) throw commandError(404, "No tour slot at this property has that id.", "tour_slot_not_found");
      // A concurrent retry can pass the first receipt read before the original
      // command commits, then wait here. Re-read after the slot lock so it
      // converges on that original receipt instead of reporting a false 409.
      if (idempotencyKey) {
        const priorAfterLock = (await client.query(
          `select av.*
             from tour_availability_events e
             join tour_availability av on av.id=e.slot_id
            where e.property_id=$1 and e.idempotency_key=$2
            limit 1`,
          [propertyId, idempotencyKey]
        )).rows[0];
        if (priorAfterLock) {
          await client.query("rollback");
          return { slot: priorAfterLock, timezone, changed: false, idempotent: true };
        }
      }
      if (slot.status !== beforeRequired) {
        throw commandError(409, `Only ${beforeRequired} tour slots can be ${eventType}.`, "invalid_tour_slot_transition");
      }
      if (action === "reopen") {
        const duplicate = (await client.query(
          `select id
             from tour_availability
            where property_id=$1 and id<>$2
              and starts_at=$3 and ends_at=$4
              and unit_id is not distinct from $5::uuid
              and leasing_agent_id is not distinct from $6::uuid
              and status in ('open','booked')
            limit 1`,
          [propertyId, slotId, slot.starts_at, slot.ends_at, slot.unit_id, slot.leasing_agent_id]
        )).rows[0];
        if (duplicate) {
          throw commandError(409, "That exact tour time is already open or booked.", "tour_slot_duplicate_on_reopen");
        }
      }
      const updated = (await client.query(
        "update tour_availability set status=$3, updated_at=now() where id=$1 and property_id=$2 returning *",
        [slotId, propertyId, afterStatus]
      )).rows[0];
      await client.query(
        `insert into tour_availability_events
           (property_id, slot_id, event_type, before_status, after_status,
            actor_user_id, actor_type, reason, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [propertyId, slotId, eventType, beforeRequired, afterStatus, actorUserId, actorType, reason, idempotencyKey]
      );
      await client.query("commit");
      return { slot: updated, timezone, changed: true, idempotent: false };
    } catch (err) {
      try { await client.query("rollback"); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ publishSlot, listSlots, getSchedulePolicy, publishSchedulePolicy, adjustDay, changeSlotStatus });
}

module.exports = { makeTourAvailabilityService, readTourScheduleStanding, commandError };
