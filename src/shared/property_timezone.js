// ════════════════════════════════════════════════════════════════════
//  property_timezone.js — the ONE property operating-timezone resolver.
//
//  A property's "today", its offered local times, and its quiet hours are its
//  OPERATIONAL timezone — not UTC, and not a hidden Eastern assumption baked
//  into a route.
//
//  ── SLICE 9, RULING 1 (2026-08-01) ───────────────────────────────────
//  The source of truth is now properties.operating_timezone (migration 123).
//  The hardcoded production property-UUID allowlist that used to live here is
//  REMOVED — its single real value was migrated into the column by 123.
//  Hidden production configuration is not preserved indefinitely as a
//  fallback; that is precisely how a "temporary" allowlist becomes permanent
//  shadow config that outranks a governed column nobody thinks to look at.
//
//  Resolver order:
//      properties.operating_timezone
//        → explicit QA/test override (NON-PRODUCTION ONLY)
//        → null
//
//  An UNCONFIGURED property gets an HONEST NULL — never an invented day,
//  never a silent default. Callers must refuse: no tour offer, no booking, no
//  "today" rendering, no proactive send, no dated metric.
//
//  ── WHY THE OVERRIDE IS NON-PRODUCTION ONLY ──────────────────────────
//  PROPERTY_OPERATING_TZ_JSON exists so a QA rig can operate a scratch
//  property without running a migration. Honoured in production it would be
//  exactly the shadow configuration this change removes, and an env var would
//  silently outrank a governed column. It is ignored when NODE_ENV is
//  'production'.
// ════════════════════════════════════════════════════════════════════
"use strict";

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

// Read at CALL TIME (not module load) so QA rigs can set it before invoking
// without import-order surprises.
function envMap() {
  if (isProduction()) return {};
  try { return JSON.parse(process.env.PROPERTY_OPERATING_TZ_JSON || "{}"); }
  catch (_) { return {}; }
}

// NON-PRODUCTION OVERRIDE ONLY. Returns null in production, always. Retained
// for callers that genuinely have no pool; it is not the source of truth.
function resolvePropertyOperatingTimeZone(propertyId) {
  if (!propertyId) return null;
  return envMap()[String(propertyId)] || null;
}

// THE AUTHORITATIVE RESOLVER. The governed column wins; the non-production
// override only fills a gap the column leaves. Never invents a zone.
async function loadPropertyOperatingTimeZone(pool, propertyId) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool is required");
  if (!propertyId) return null;
  const row = (await pool.query(
    "select operating_timezone from properties where id=$1", [propertyId]
  )).rows[0];
  const configured = row && row.operating_timezone ? String(row.operating_timezone).trim() : null;
  return configured || resolvePropertyOperatingTimeZone(propertyId);
}


/*  ── WHAT "TODAY" MEANS FOR A BUILDING ──────────────────────────────
 *  The canonical dated reads defaulted an absent as_of with
 *
 *      new Date().toISOString().slice(0, 10)
 *
 *  which is the UTC calendar day. UTC runs 4–5 hours ahead of
 *  America/New_York, so from roughly 8pm Philadelphia time onward
 *  "today's rent roll" silently answered for TOMORROW — across lease
 *  commencements, expirations, notice dates and the August 1 turnover,
 *  which is exactly when a student-housing building changes hands.
 *
 *  Migration 123 already records each property's operating timezone and
 *  this module already resolves it. The dated reads simply never asked.
 *
 *  NOT A REFUSAL. An unconfigured property still gets an answer — the
 *  UTC day, as before — but the answer now SAYS which basis produced it,
 *  so "why does this read disagree with the board at 9pm" is answerable
 *  instead of invisible. Refusing here would take today's rent roll away
 *  from every property that has not set a zone, which is a bigger harm
 *  than the one being fixed.  */
function ymdInZone(instant, timeZone) {
  //  en-CA formats as YYYY-MM-DD, which is the shape every date column
  //  and every caller already expects.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}

/*  The operating date for one property, and the basis that produced it.
 *    { date, basis: 'property_local' | 'utc_fallback', timezone }  */
async function propertyOperatingToday(pool, propertyId, now = new Date()) {
  let tz = null;
  try { tz = await loadPropertyOperatingTimeZone(pool, propertyId); }
  catch (_) { tz = null; }          //  a read that cannot resolve is not a crash
  if (tz) {
    try {
      return { date: ymdInZone(now, tz), basis: "property_local", timezone: tz };
    } catch (_) {
      //  A stored zone Intl rejects is a data problem, not a reason to
      //  fail the rent roll. Fall through and say the basis was UTC.
    }
  }
  return { date: ymdInZone(now, "UTC"), basis: "utc_fallback", timezone: null };
}

// ONE vocabulary for an unconfigured property, so every surface refuses in the
// same words instead of inventing its own phrasing.
const TZ_UNAVAILABLE = Object.freeze({
  state: "unavailable",
  reason: "property_operating_timezone_not_configured",
});

module.exports = {
  resolvePropertyOperatingTimeZone,
  loadPropertyOperatingTimeZone,
  propertyOperatingToday,
  ymdInZone,
  TZ_UNAVAILABLE,
};
