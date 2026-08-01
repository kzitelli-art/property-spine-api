// ════════════════════════════════════════════════════════════════════
//  operating_window.js — the ONE property-local reporting window.
//
//  Slice 9 ruling 1C. Tour Demand, Lead Demand and every conversion funnel
//  resolve their window HERE. Three surfaces each constructing "the month of
//  August at this property" is three chances to disagree about when August
//  starts, and the disagreement only shows up near midnight and on DST days —
//  which is to say, in the numbers nobody re-checks.
//
//  ── HALF-OPEN, ALWAYS ────────────────────────────────────────────────
//      [window_start_utc, window_end_utc)
//  A closed upper bound double-counts an event landing exactly on midnight
//  in two adjacent windows. The end instant is the START of the day AFTER
//  the local end date, so "Aug 1 – Aug 31" covers through Aug 31 23:59:59.999
//  local and stops before Sep 1 00:00 local.
//
//  ── DST-AWARE BY CONSTRUCTION ────────────────────────────────────────
//  Local→UTC conversion is done by Postgres (`AT TIME ZONE`), not by adding
//  a fixed offset in Node. A spring-forward day is 23 hours long and an
//  autumn day is 25; arithmetic that assumes 24 silently mis-buckets one
//  event per transition per property.
//
//  ── NO UTC FALLBACK ──────────────────────────────────────────────────
//  A property with no operating timezone has no operating day. It does not
//  get UTC's. The window resolves to state 'unavailable' with the one shared
//  reason code, and the caller must render that rather than a number.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { loadPropertyOperatingTimeZone, TZ_UNAVAILABLE } = require("./property_timezone");

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(message, code) {
  const e = new Error(message);
  e.httpStatus = 400; e.code = code; e.publicMessage = message;
  return e;
}

/**
 * Resolve a property-local reporting window to real UTC instants.
 *
 *   { property_id, start_local, end_local, as_of }
 *     start_local / end_local : 'YYYY-MM-DD', INCLUSIVE local dates
 *     as_of                   : ISO instant; defaults to now
 *
 * Returns either
 *   { state: 'ok', operating_timezone, window_start_local, window_end_local,
 *     window_start_utc, window_end_utc, as_of_utc }
 * or
 *   { state: 'unavailable', reason: 'property_operating_timezone_not_configured', ... }
 */
async function resolveOperatingWindow(pool, { property_id, start_local, end_local, as_of = null } = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool is required");
  if (!property_id) throw badRequest("property_id is required", "property_id_required");
  if (!YMD.test(String(start_local || ""))) throw badRequest("start_local must be YYYY-MM-DD", "bad_start_local");
  if (!YMD.test(String(end_local || ""))) throw badRequest("end_local must be YYYY-MM-DD", "bad_end_local");
  if (String(end_local) < String(start_local)) {
    throw badRequest("end_local must not precede start_local", "window_inverted");
  }

  const asOfUtc = as_of ? new Date(as_of) : new Date();
  if (Number.isNaN(asOfUtc.getTime())) throw badRequest("as_of must be a valid instant", "bad_as_of");

  const tz = await loadPropertyOperatingTimeZone(pool, property_id);
  if (!tz) {
    return {
      state: TZ_UNAVAILABLE.state,
      reason: TZ_UNAVAILABLE.reason,
      property_id,
      operating_timezone: null,
      window_start_local: start_local,
      window_end_local: end_local,
      window_start_utc: null,
      window_end_utc: null,
      as_of_utc: asOfUtc.toISOString(),
    };
  }

  // Postgres owns the conversion so DST is handled by the tz database rather
  // than by arithmetic here. The upper bound is the start of the day AFTER
  // end_local, making the interval half-open.
  const row = (await pool.query(
    `select ($1::date::timestamp at time zone $3) as start_utc,
            (($2::date + 1)::timestamp at time zone $3) as end_utc`,
    [start_local, end_local, tz]
  )).rows[0];

  return {
    state: "ok",
    property_id,
    operating_timezone: tz,
    window_start_local: start_local,
    window_end_local: end_local,
    window_start_utc: new Date(row.start_utc).toISOString(),
    window_end_utc: new Date(row.end_utc).toISOString(),
    as_of_utc: asOfUtc.toISOString(),
  };
}

// Convenience: the property's CURRENT local month. Used by surfaces that open
// on "this month" without the browser deciding what month it is at the
// property — which it cannot know.
async function currentMonthWindow(pool, { property_id, as_of = null } = {}) {
  const tz = await loadPropertyOperatingTimeZone(pool, property_id);
  const asOfUtc = as_of ? new Date(as_of) : new Date();
  if (!tz) {
    return resolveOperatingWindow(pool, {
      property_id, start_local: "2000-01-01", end_local: "2000-01-01",
      as_of: asOfUtc.toISOString(),
    });
  }
  const today = (await pool.query(
    "select ($1::timestamptz at time zone $2)::date::text as d", [asOfUtc.toISOString(), tz]
  )).rows[0].d;
  const start = today.slice(0, 8) + "01";
  const end = (await pool.query(
    "select ((date_trunc('month', $1::date) + interval '1 month - 1 day')::date)::text as d", [start]
  )).rows[0].d;
  return resolveOperatingWindow(pool, { property_id, start_local: start, end_local: end, as_of: asOfUtc.toISOString() });
}

module.exports = { resolveOperatingWindow, currentMonthWindow };
