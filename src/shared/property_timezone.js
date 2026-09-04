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

//  FAIL CLOSED: unset is production. The override this guards must never
//  outrank the governed column merely because a deploy forgot a variable.
//  A QA rig asks for the override by setting NODE_ENV=development or test.
function isProduction() {
  return !["development", "test"].includes(String(process.env.NODE_ENV || "").toLowerCase());
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

// ONE vocabulary for an unconfigured property, so every surface refuses in the
// same words instead of inventing its own phrasing.
const TZ_UNAVAILABLE = Object.freeze({
  state: "unavailable",
  reason: "property_operating_timezone_not_configured",
});

module.exports = {
  resolvePropertyOperatingTimeZone,
  loadPropertyOperatingTimeZone,
  TZ_UNAVAILABLE,
};
