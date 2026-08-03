// ════════════════════════════════════════════════════════════════════
//  appointment_attribution.js — THE ONE PLACE AN APPOINTMENT IS BOUND TO
//  AN OPPORTUNITY.
//
//  Every writer that creates or continues an appointment asks this module for
//  the opportunity UUID. Nothing else may resolve one.
//
//  ── WHAT THIS REPLACES ───────────────────────────────────────────────
//  completeTourService resolved the opportunity like this:
//
//      select id from leasing_conversions
//       where person_id=$1 and property_id=$2 and status='active' limit 1
//
//  Same person + same property + current active conversion + limit 1 — four
//  items from the forbidden list in one query, in three places. It produced a
//  value, not lineage: only for completed tours, only in JSON metadata, and
//  wrong the moment a person had two opportunities.
//
//  ── THE RULE ─────────────────────────────────────────────────────────
//  An appointment is attributed ONLY from an opportunity UUID the caller
//  already holds because the workflow is opportunity-bound. There is no
//  lookup, no search, no nearest match. If the workflow does not carry one,
//  the appointment stays NULL — explicitly unattributed. It is not filled in
//  later by inference, because inference from lead, person, property or time is
//  forbidden. It MAY be resolved later by an explicit, proven, attributed
//  correction. NULL means "not attributable from the evidence available", not
//  "unattributable forever".
//
//  ── WHAT IT VALIDATES ────────────────────────────────────────────────
//  · the opportunity exists
//  · it belongs to the SAME property as the appointment (writer-enforced,
//    because a composite FK would need a new unique key on leasing_conversions
//    that this cut may not add — see the migration contract)
//  · it does not contradict an attribution the row already carries
//
//  REQUIRES the attribution bridge. No runtime schema detection, no fallback.
//  WRITES NOTHING ITSELF — it returns a verdict the caller applies.
// ════════════════════════════════════════════════════════════════════

"use strict";

const REFUSAL = Object.freeze({
  NOT_FOUND:       "opportunity_not_found",
  WRONG_PROPERTY:  "opportunity_not_at_property",
  CONFLICT:        "conflicting_opportunity_attribution",
});

const TEXT = Object.freeze({
  [REFUSAL.NOT_FOUND]:      "That opportunity does not exist.",
  [REFUSAL.WRONG_PROPERTY]: "That opportunity belongs to another property.",
  [REFUSAL.CONFLICT]:       "This appointment is already attributed to a different opportunity. Attribution is never silently reassigned.",
});

/**
 * resolveAttribution(q, { property_id, opportunity_id, existing_conversion_id })
 *
 * @param opportunity_id  the UUID the opportunity-bound workflow already holds.
 *                        null/undefined ⇒ legitimately unattributed.
 * @param existing_conversion_id  what the row already carries, when continuing
 *                        or correcting one. A different incoming value is a
 *                        conflict, never an overwrite.
 */
async function resolveAttribution(q, {
  property_id, opportunity_id = null, existing_conversion_id = null,
} = {}) {
  if (!property_id) throw new Error("resolveAttribution requires a server-derived property_id");

  // ── NO OPPORTUNITY IN HAND ────────────────────────────────────────
  //  A truthful outcome, not a failure. A walk-in with no conversation, or an
  //  external calendar row imported before any opportunity existed, is
  //  UNATTRIBUTED and stays that way.
  if (!opportunity_id) {
    return {
      ok: true, attributed: false, conversion_id: existing_conversion_id || null,
      basis: existing_conversion_id ? "preserved" : "unattributed",
      refusal_code: null,
    };
  }

  if (existing_conversion_id && String(existing_conversion_id) !== String(opportunity_id)) {
    return { ok: false, attributed: false, conversion_id: existing_conversion_id,
             basis: "conflict", refusal_code: REFUSAL.CONFLICT,
             refusal_reason: TEXT[REFUSAL.CONFLICT], httpStatus: 409 };
  }

  const opp = (await q.query(
    `select id, property_id from leasing_conversions where id = $1`, [opportunity_id])).rows[0];

  if (!opp) {
    return { ok: false, attributed: false, conversion_id: null, basis: null,
             refusal_code: REFUSAL.NOT_FOUND, refusal_reason: TEXT[REFUSAL.NOT_FOUND],
             httpStatus: 404 };
  }
  if (String(opp.property_id) !== String(property_id)) {
    return { ok: false, attributed: false, conversion_id: null, basis: null,
             refusal_code: REFUSAL.WRONG_PROPERTY, refusal_reason: TEXT[REFUSAL.WRONG_PROPERTY],
             httpStatus: 403 };
  }

  return { ok: true, attributed: true, conversion_id: String(opp.id),
           basis: "explicit_link", refusal_code: null };
}

/**
 * inheritAttribution(q, predecessor)
 *
 * A reschedule successor CONTINUES an attempt; it does not begin one. It
 * therefore inherits the predecessor's attribution verbatim — no re-resolution,
 * no re-validation against current state, no opportunity lookup.
 *
 * THIS IS THE LINE ATTRIBUTION USED TO DIE ON. The successor insert copied
 * lead_id, property_id, unit_id, leasing_agent_id, slot_id, scheduled_for,
 * status and rescheduled_from — and not conversion_id. A chain that began
 * attributed became unattributed at its second occurrence, silently.
 */
function inheritAttribution(predecessor) {
  return {
    conversion_id: (predecessor && predecessor.conversion_id) || null,
    basis: predecessor && predecessor.conversion_id ? "chain_inheritance" : "unattributed",
  };
}

module.exports = { resolveAttribution, inheritAttribution, REFUSAL, TEXT };
