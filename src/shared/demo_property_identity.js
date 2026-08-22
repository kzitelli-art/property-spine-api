// ════════════════════════════════════════════════════════════════════
//  demo_property_identity.js — ONE PLACE THAT KNOWS WHICH ROW IS DEMO
//
//  Before this file the identity was declared FIVE times — twice inside
//  one file — and held in agreement by human comments:
//
//      seed_endpoint.js      const DEMO_PROP_NAME = "…"
//      operator.js           const DEMO_PROP_NAME = "…"
//      demo_reset.js         …  // MUST match /demo/intake + operator.js
//      leasingleads.js:825   …  // MUST match operator.js DEMO_PROP_NAME
//      leasingleads.js:1024  …  // MUST match /demo/intake + operator.js
//
//  A comment is not an enforcement mechanism. Four of those five then
//  resolved the property with `order by created_at asc limit 1`, and the
//  fifth — an AUTHORIZATION WALL — with no limit at all, taking rows[0].
//  Production holds THREE rows named "Property Spine Demo Building", so
//  every one of them was picking one of three by creation order.
//
//  ── WHAT THIS MODULE PROMISES ────────────────────────────────────────
//  It answers with certainty or it refuses. It never picks.
//
//  Resolution order, strongest first:
//
//      DEMO_PROPERTY_ID          an explicit id IS identity. No lookup.
//      DEMO_PROPERTY_CANONICAL_KEY   resolver's canonical_key branch,
//                                backed by uq_properties_canonical_key
//      the name                  resolver's exact-name branch, which
//                                REFUSES when more than one row matches
//
//  The last branch still involves the ambiguous name, and that is the
//  honest state of things — but it now REFUSES instead of silently
//  taking the oldest. That difference holds whether or not anyone ever
//  configures the two above it.
//
//  ── §18 CLASSIFICATION — CLASS 2 ─────────────────────────────────────
//  REPLACEMENT CONDITION: `properties.canonical_key` is populated for
//  the demo row. Migration 011 added the column with
//  `uq_properties_canonical_key UNIQUE` — the identity guarantee this
//  wants has existed since then and nothing has used it for this row.
//  Migration 150 stamps rows without one as
//  `predates_canonical_identity_requirement`, so the absence is recorded
//  rather than accidental.
//
//  HOW THE CONDITION IS NOTICED: `resolveDemoProperty` reports `via`, and
//  `tests/gate_property_name_resolution.js` asserts on it. When the key
//  is populated and configured, `via` becomes "canonical_key" and this
//  file's fallback is dead code that can be deleted. A removal condition
//  with no mechanism that notices it is a promise, not a control (§18).
//
//  This module makes NO database write. Populating canonical_key is a
//  write, and it is a human's to run deliberately — the one-line
//  statement is in the Q5 receipt, deliberately not executed here.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { resolvePropertyIdentity } = require("../identity/property_resolution_service.js");

//  THE ONE DECLARATION. Every caller imports it; nobody re-types it.
const DEMO_PROPERTY_NAME = "Property Spine Demo Building";

const envValue = (k) => {
  const v = process.env[k];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/**
 * Resolve the demo property, or refuse.
 *
 * @param db  pool or checked-out client
 * @returns { status, property_id, via, candidates, receipt }
 *          status is 'resolved' only when the row is identified with
 *          certainty. Every other status carries a sayable receipt and
 *          MUST be treated as a refusal by the caller.
 */
async function resolveDemoProperty(db) {
  //  1. An explicit id IS identity — there is nothing to resolve.
  //     Still verified to exist, so a stale env var refuses loudly
  //     rather than pointing every demo write at a missing row.
  const configuredId = envValue("DEMO_PROPERTY_ID");
  if (configuredId) {
    const r = await db.query(
      "select id, name, coalesce(display_name, name) as display_name from properties where id = $1",
      [configuredId]);
    if (r.rows.length === 1) {
      return { status: "resolved", property_id: r.rows[0].id, via: "configured_id",
               row: r.rows[0], candidates: [],
               receipt: `Resolved by the configured demo property id.` };
    }
    return { status: "unresolved", property_id: null, via: null, row: null, candidates: [],
             receipt: `DEMO_PROPERTY_ID is set to ${configuredId}, and no property has that id.` };
  }

  //  2. canonical_key — identity with a UNIQUE constraint behind it.
  const key = envValue("DEMO_PROPERTY_CANONICAL_KEY");
  if (key) {
    const res = await resolvePropertyIdentity(db, { canonical_key: key });
    if (res.status === "resolved") return { ...res, row: null };
  }

  //  3. The name. Ambiguous in production TODAY — three rows share it —
  //     so this branch exists to REFUSE, not to choose. Compare the
  //     retired form: `order by created_at asc limit 1`.
  const res = await resolvePropertyIdentity(db, { name_exact: DEMO_PROPERTY_NAME });
  return { ...res, row: null };
}

/**
 * The full row, for callers that need name/display_name and not just an
 * id. Returns null when identity was not established — the caller then
 * refuses, exactly as it would on a missing property.
 */
async function resolveDemoPropertyRow(db) {
  const res = await resolveDemoProperty(db);
  if (res.status !== "resolved") return { res, row: null };
  if (res.row) return { res, row: res.row };
  const r = await db.query(
    "select id, name, coalesce(display_name, name) as display_name from properties where id = $1",
    [res.property_id]);
  return { res, row: r.rows[0] || null };
}

module.exports = { DEMO_PROPERTY_NAME, resolveDemoProperty, resolveDemoPropertyRow };
