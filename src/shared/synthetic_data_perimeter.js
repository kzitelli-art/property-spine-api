// ════════════════════════════════════════════════════════════════════
//  synthetic_data_perimeter.js — WHERE SYNTHETIC DATA MAY LEGALLY LAND
//
//  ── AUTHENTICATION IS THE WRONG QUESTION ─────────────────────────────
//  Three routes inject a fixture rent roll — units, spaces, leases,
//  persons, dated ledger evidence — from a config key:
//
//      POST /admin/seed-snapshot/:key?      (seed_endpoint.js)
//      POST /snapshot/:property/upload      (snapshot_loader.js)
//      POST /snapshot/:property/load        (snapshot_loader.js)
//
//  Build 1A-2 first "fixed" the seed route by requiring a super-admin
//  session. That was necessary and it is not sufficient:
//
//      Authentication answers WHO MAY CALL the tool.
//      It does not answer WHERE SYNTHETIC DATA MAY LEGALLY LAND.
//
//  A correctly authenticated super admin, or anyone holding the shared
//  operator key, could still land a fixture baseline on a real operating
//  property — and the property was chosen by substring match. That is the
//  §17 failure: demo data may exist, demo PATHS may not become an
//  alternate production business path.
//
//  ── THE PERIMETER, FAIL-CLOSED ON EVERY LIMB ─────────────────────────
//      1. synthetic writes must be explicitly enabled for this deployment
//      2. an allowlist of permitted targets must be configured
//      3. the RESOLVED target must be a member of it
//
//  Absent, empty or malformed config means NOTHING is seedable. The
//  allowlist is server-pinned: no caller supplies it, and no resolver can
//  add to it, so fuzzy resolution becomes incapable of selecting a
//  production property rather than merely unlikely to.
//
//  ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────
//  `POST /operator/rent-roll/import` — the canonical signed-in rent-roll
//  import, whose property scope comes from the staff session and which
//  accepts no client property id. That route is not synthetic: it carries
//  a real operator's real sourced document, records dated ledger evidence,
//  and deliberately refuses to manufacture durable people or leases from
//  names in a report. It is a likely ACTIVATION primitive and is
//  deliberately outside this perimeter. Do not fold the two together.
//
//  CLASSIFICATION: Class 2 config perimeter.
//  REMOVAL CONDITION: retire with the fixture-seeding routes themselves,
//  once demo/QA data is provisioned by a governed activation run instead
//  of a config-keyed fixture loader. Removing the env vars first is not
//  removal — it is a silent shutdown, and the refusals below say so.
// ════════════════════════════════════════════════════════════════════

"use strict";

//  Explicit opt-in for the deployment. DEMO_MODE is the existing signal
//  seed_endpoint already reads; SYNTHETIC_SEED_ENABLED exists so a QA
//  deployment can enable seeding without claiming to be a demo.
function syntheticWritesEnabled() {
  const demo = String(process.env.DEMO_MODE || "").toLowerCase() === "true";
  const qa = String(process.env.SYNTHETIC_SEED_ENABLED || "").toLowerCase() === "true";
  return demo || qa;
}

//  Server-pinned allowlist of property UUIDs that may receive synthetic
//  data. Same Class-2 shape as activation_perimeter's allowlist, and the
//  same fail-closed rule: absent/empty/malformed = nothing permitted.
function syntheticTargetIds() {
  const raw = process.env.SYNTHETIC_SEED_PROPERTY_IDS;
  if (!raw || typeof raw !== "string") return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * May synthetic data land on this property, in this deployment?
 *
 * @param propertyId  the RESOLVED target. Never a caller-supplied id, and
 *                    never a config key — resolve first, then ask.
 * @returns { allowed, reason, receipt }
 */
function syntheticTargetAllowed(propertyId) {
  if (!syntheticWritesEnabled()) {
    return { allowed: false, reason: "synthetic_writes_disabled",
      receipt: "Synthetic seeding is not enabled on this deployment. Set DEMO_MODE=true " +
               "or SYNTHETIC_SEED_ENABLED=true only where fixture data belongs." };
  }
  const allowed = syntheticTargetIds();
  if (allowed.size === 0) {
    return { allowed: false, reason: "no_synthetic_target_configured",
      receipt: "No synthetic seed target is configured. Set SYNTHETIC_SEED_PROPERTY_IDS " +
               "to the demo/QA property ids that may receive fixture data." };
  }
  if (!propertyId) {
    return { allowed: false, reason: "target_not_resolved",
      receipt: "No property was resolved, so no target could be checked." };
  }
  if (!allowed.has(String(propertyId))) {
    //  The load-bearing refusal. Deliberately does NOT name the allowlist
    //  back to the caller: the answer to "may I write here" is no, and the
    //  configured demo set is not the caller's business.
    return { allowed: false, reason: "target_not_a_demo_property",
      receipt: "That property is not a configured demo/QA target. Synthetic rent-roll " +
               "data may not be written to an operating property." };
  }
  return { allowed: true, reason: null, receipt: "Permitted demo/QA target." };
}

/** The refusal body a route returns. 403: the caller may be perfectly
 *  authenticated and still have no business writing fixtures here. */
function syntheticRefusal(check) {
  return { error: check.receipt, reason: check.reason,
           receipt: "Authentication answers who may call this tool. It does not answer " +
                    "where synthetic data may land." };
}

module.exports = {
  syntheticTargetAllowed, syntheticRefusal,
  syntheticWritesEnabled, syntheticTargetIds,
};
