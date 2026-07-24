// ════════════════════════════════════════════════════════════════════
//  property_timezone.js — the ONE property operating-timezone resolver.
//
//  A property's "today" / offered local times are its OPERATIONAL timezone,
//  not UTC and not a hidden Eastern assumption baked into a route. Until
//  properties carries a real timezone column (the seam), the source of truth is
//  an explicit allowlist (production Demo Building) plus the
//  PROPERTY_OPERATING_TZ_JSON env map for QA rigs. An UNCONFIGURED property
//  gets an HONEST NULL — never an invented day, never a silent default. Callers
//  must refuse (no offer, no booking, no "today" rendering) on null.
//
//  Both operator.js (dashboard "today" rendering) and leasingleads.js (agent
//  tour-offer local times) resolve through THIS module, so there is a single
//  operating-timezone truth rather than two copies of the same intended map.
// ════════════════════════════════════════════════════════════════════
const BUILTIN_ALLOWLIST = {
  "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe": "America/New_York", // Property Spine Demo Building
};

function envMap() {
  try { return JSON.parse(process.env.PROPERTY_OPERATING_TZ_JSON || "{}"); }
  catch (_) { return {}; }
}

// Returns an IANA timezone string, or null when the property is unconfigured.
// The env map is read at CALL TIME (not module load) so QA rigs can set it
// before invoking without import-order surprises.
function resolvePropertyOperatingTimeZone(propertyId) {
  if (!propertyId) return null;
  const map = Object.assign({}, BUILTIN_ALLOWLIST, envMap());
  return map[String(propertyId)] || null;
}

module.exports = { resolvePropertyOperatingTimeZone };
