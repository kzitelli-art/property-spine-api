// ════════════════════════════════════════════════════════════════════
//  application_target_authority.js — WHERE AN APPLICATION MAY BE AIMED
//
//  ONE authority answers one question, for every entry path that creates
//  or sends an application link:
//
//      May an application be aimed at this unit right now, and which
//      exact space would it land on?
//
//  ── THE GOVERNING GRAIN BOUNDARY ─────────────────────────────────────
//  The application segment is durably UNIT-GRAINED. Verified at schema:
//
//      application_invitations   property_id, unit_id   NO space_id
//      lease_applications        property_id, unit_id   NO space_id
//      lifecycle BIRTH_FIELDS    unit_id                NO space_id
//
//  Space grain begins downstream, at executed_lease_records and leases
//  (leases.space_id is NOT NULL). So the durable chain from invitation to
//  application birth CANNOT carry a space choice.
//
//      A space choice cannot be offered unless the complete durable chain
//      can preserve it.
//
//  Therefore:
//      unit with exactly one space   → supported, space derived SERVER-SIDE
//      unit with more than one space → controlled refusal, 409
//      unit with zero spaces         → unconfigured, refused
//
//  ── resolved_space_id IS A VALIDATION RECEIPT, NOT LINEAGE ───────────
//  It exists so the server can prove WHICH space it evaluated availability
//  against. It is NOT the application's space and MUST NOT be persisted as
//  though it were — not in captured JSON, notes, unit_label, event text,
//  obligation metadata, or browser state presented as durable truth. The
//  application record keeps unit grain; nothing here widens it.
//
//  ── WHY NOT "PICK THE RENTABLE ONE" ──────────────────────────────────
//  A two-space unit where only one space is currently marketable is STILL
//  ambiguous: filtering to the marketable space and taking what remains is
//  "select the first marketable space" wearing a different hat, and the
//  durable record could not distinguish it from its sibling afterwards.
//  Space COUNT is the test, not space eligibility. A unit whose second
//  space is a storage closet refuses too — refusing is a valid outcome and
//  a truthful one; guessing is neither.
//
//  ── CANONICAL AVAILABILITY, NEVER THE LEGACY MODULE ──────────────────
//  Offerability is read from availabilityRead (surfaces/availability_read),
//  the same truth the operator availability surface renders. The legacy
//  src/tenancy/availability.js projection this replaced carried a weaker
//  commitment model — it labelled every standalone future lease 'locked'
//  regardless of proof — and was DELETED in Commit E.
//
//  WRITES NOTHING.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { availabilityRead } = require("../surfaces/availability_read");

// ── THE OFFERABILITY POLICY — A CLOSED ALLOWLIST ─────────────────────
//  Only these marketing states can ever produce an offerable target.
//  Everything else — successor_pending, successor_locked, activation_pending,
//  occupied, contested, evidence_disagrees, down, not_marketable_use,
//  use_not_configured, not_ready, not_ready_confirmed, readiness_unknown,
//  unavailable, and any state this file has never heard of — refuses.
//
//  An allowlist rather than a denylist BY CONSTRUCTION: a marketing state
//  added to availability_read later must be deliberately admitted here. The
//  denylist version of this rule would silently offer it. Unknown is not
//  offerable.
const OFFERABLE_NOW = "marketable_now";
const OFFERABLE_FOR_FUTURE_MOVE_IN = new Set(["upcoming", "turnover_required"]);

// Refusal codes. Stable identifiers — the app renders from these, never from
// prose, and never re-derives the decision.
const REFUSAL = {
  NOT_AT_PROPERTY:        "not_at_property",
  UNCONFIGURED:           "application_target_unconfigured",
  MULTI_SPACE:            "space_grain_not_supported",
  NOT_OFFERABLE:          "not_offerable",
  MOVE_IN_REQUIRED:       "intended_move_in_required",
  DATE_NOT_GOVERNED:      "availability_date_not_governed",
  NOT_READY_BY_MOVE_IN:   "not_ready_by_intended_move_in",
  // Submission-time only. Distinct from MULTI_SPACE: the unit CHANGED under an
  // open invitation rather than having been an unsupported shape all along.
  BECAME_AMBIGUOUS:       "application_target_became_ambiguous",
  NO_LONGER_OFFERABLE:    "application_target_no_longer_offerable",
};

// Operator-facing sentences. No internal codes in operator copy; the code
// travels beside the sentence for the client to branch on.
const REFUSAL_TEXT = {
  [REFUSAL.NOT_AT_PROPERTY]:      "That unit is not at this property.",
  [REFUSAL.UNCONFIGURED]:         "This unit has no rentable space configured, so an application cannot be aimed at it yet.",
  [REFUSAL.MULTI_SPACE]:          "Individual-space application links are not supported for this unit yet.",
  [REFUSAL.NOT_OFFERABLE]:        "This unit cannot be offered right now.",
  [REFUSAL.MOVE_IN_REQUIRED]:     "This unit is not available today. Add an intended move-in date to offer it forward.",
  [REFUSAL.DATE_NOT_GOVERNED]:    "This unit has no governed availability date, so it cannot be offered for a future move-in.",
  [REFUSAL.NOT_READY_BY_MOVE_IN]: "This unit is not available by the intended move-in date.",
  [REFUSAL.BECAME_AMBIGUOUS]:     "This unit was changed to hold more than one rentable space after the application link was sent, so the application can no longer be attributed to a single space.",
  [REFUSAL.NO_LONGER_OFFERABLE]:  "This unit is no longer available, so this application link can no longer be used.",
};

function refuse(code, extra = {}) {
  return {
    ok: false,
    offerable: false,
    targeted: true,
    resolved_space_id: null,
    resolution_basis: null,
    refusal_code: code,
    refusal_reason: REFUSAL_TEXT[code] || null,
    ...extra,
  };
}

// Dates arrive as ISO strings from canonical availability, but an
// intended_move_in supplied by a caller may be a Date. Normalize both — a
// Date stringified and sliced yields 'Sat Aug 22', which compares wrong
// against a real ISO date rather than failing loudly.
const ymd = (d) => {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};

/**
 * Resolve where an application may be aimed.
 *
 * @param q            pool OR an open transaction client. The canonical read
 *                     chain uses only .query(), so a caller inside a
 *                     transaction gets a target resolved against the SAME
 *                     snapshot as the write it is about to make.
 * @param property_id  SERVER-DERIVED property scope. Never a browser value.
 * @param unit_id      null ⇒ untargeted (see below).
 * @param intended_move_in  optional YYYY-MM-DD; enables forward offers.
 * @param require_offerable when false, resolve the space and REPORT
 *                     offerability without refusing on it. Grain refusals
 *                     (multi-space, unconfigured, not-at-property) still
 *                     refuse — they are structural, not a policy opinion.
 */
async function resolveApplicationTarget(q, {
  property_id,
  unit_id = null,
  intended_move_in = null,
  require_offerable = true,
} = {}) {
  if (!property_id) throw new Error("resolveApplicationTarget requires a server-derived property_id");

  // ── UNTARGETED ────────────────────────────────────────────────────
  //  An honest result, NOT an invitation to make every path untargeted.
  //  Callers that require a unit keep refusing a missing one; this branch
  //  exists only for a workflow that already supports an untargeted
  //  application truthfully. No such production path exists today.
  if (!unit_id) {
    return {
      ok: true,
      targeted: false,
      property_id,
      unit_id: null,
      resolved_space_id: null,
      resolution_basis: "untargeted",
      rentable_space_count: null,
      marketing_state: null,
      available_from: null,
      availability_confidence: null,
      offerable: false,          // there is nothing to offer — not a refusal
      refusal_code: null,
      refusal_reason: null,
    };
  }

  // ── PROPERTY WALL + SPACE GRAIN, IN ONE READ ──────────────────────
  //  LEFT JOIN so a unit with zero spaces still returns a row: "no spaces"
  //  and "no such unit" are different facts and must not collapse into one
  //  not-found.
  const u = (await q.query(
    `select u.id, u.property_id, count(s.id)::int as space_count
       from units u
       left join spaces s on s.unit_id = u.id
      where u.id = $1
      group by u.id, u.property_id`,
    [unit_id]
  )).rows[0];

  if (!u || String(u.property_id) !== String(property_id)) {
    return refuse(REFUSAL.NOT_AT_PROPERTY, {
      property_id, unit_id, rentable_space_count: null, httpStatus: 404,
    });
  }

  if (u.space_count === 0) {
    return refuse(REFUSAL.UNCONFIGURED, {
      property_id, unit_id, rentable_space_count: 0, httpStatus: 409,
    });
  }

  if (u.space_count > 1) {
    // THE CONTROLLED REFUSAL. Not a bug, not a missing selection the operator
    // could make — the durable chain cannot preserve a space choice, so the
    // honest answer is that this shape is not supported yet.
    return refuse(REFUSAL.MULTI_SPACE, {
      property_id, unit_id, rentable_space_count: u.space_count, httpStatus: 409,
    });
  }

  // ── SOLE SPACE — DERIVED SERVER-SIDE, NEVER SUPPLIED ──────────────
  const space_id = (await q.query(
    `select id from spaces where unit_id = $1`, [unit_id]
  )).rows[0].id;

  // ── CANONICAL AVAILABILITY FOR THAT EXACT SPACE ───────────────────
  const avail = await availabilityRead(q, { property_id });
  const row = (avail.rows || []).find((r) => String(r.space_id) === String(space_id));

  if (!row) {
    // The space exists but the canonical read did not classify it. That is a
    // read gap, not evidence of availability. Refuse rather than assume.
    return refuse(REFUSAL.NOT_OFFERABLE, {
      property_id, unit_id, resolved_space_id: space_id,
      rentable_space_count: 1, marketing_state: null,
      available_from: null, availability_confidence: null, httpStatus: 409,
    });
  }

  const base = {
    property_id,
    unit_id,
    resolved_space_id: space_id,          // VALIDATION RECEIPT — never lineage
    resolution_basis: "sole_space_unit",
    targeted: true,
    rentable_space_count: 1,
    unit_number: row.unit_number,
    space_label: row.space_label,
    position_kind: row.position_kind,
    marketing_state: row.marketing_state,
    blocking_reason: row.blocking_reason,
    available_from: ymd(row.available_from),
    availability_confidence: row.availability_confidence,
  };

  const verdict = evaluateOfferability(row, intended_move_in);

  if (!verdict.offerable && require_offerable) {
    return {
      ...base,
      ok: false,
      offerable: false,
      refusal_code: verdict.refusal_code,
      refusal_reason: REFUSAL_TEXT[verdict.refusal_code] || null,
      httpStatus: 409,
    };
  }

  return {
    ...base,
    ok: true,
    offerable: verdict.offerable,
    refusal_code: verdict.offerable ? null : verdict.refusal_code,
    refusal_reason: verdict.offerable ? null : (REFUSAL_TEXT[verdict.refusal_code] || null),
  };
}

// ── THE POLICY, ISOLATED SO IT CAN BE PROVEN DIRECTLY ────────────────
//  marketable_now      offerable now.
//  upcoming            offerable ONLY for a supplied intended move-in, and
//                      ONLY when a governed available_from is on or before it.
//  turnover_required   same rule. In practice availableFrom() returns null for
//                      this state by design — "a turn record alone does not
//                      create a reliable availability date" — so it refuses
//                      with availability_date_not_governed rather than being
//                      special-cased into unreachability here. If a governed
//                      turnover completion date ever lands, this branch starts
//                      working without a policy rewrite.
//  everything else     refused, including states this file does not know.
function evaluateOfferability(row, intended_move_in) {
  const state = row.marketing_state;

  if (state === OFFERABLE_NOW) return { offerable: true, refusal_code: null };

  if (!OFFERABLE_FOR_FUTURE_MOVE_IN.has(state)) {
    return { offerable: false, refusal_code: REFUSAL.NOT_OFFERABLE };
  }

  if (!intended_move_in) {
    return { offerable: false, refusal_code: REFUSAL.MOVE_IN_REQUIRED };
  }

  const from = ymd(row.available_from);
  if (!from) {
    return { offerable: false, refusal_code: REFUSAL.DATE_NOT_GOVERNED };
  }

  // String compare is correct and timezone-free for YYYY-MM-DD.
  if (from <= ymd(intended_move_in)) {
    return { offerable: true, refusal_code: null };
  }
  return { offerable: false, refusal_code: REFUSAL.NOT_READY_BY_MOVE_IN };
}

// ── SUBMISSION-TIME REVALIDATION ─────────────────────────────────────
//  An invitation can sit open while inventory changes underneath it. Before a
//  lease_application is born from a public token, the target it was prepared
//  against must still hold.
//
//  THE SAME CLOSED ALLOWLIST, ONE TEST SHORT — and the difference is
//  deliberate, not an oversight:
//
//    preparation   marketable_now | (upcoming | turnover_required WITH a
//                  supplied intended_move_in on or after a governed
//                  available_from)
//    submission    marketable_now | upcoming | turnover_required
//
//  intended_move_in is NOT persisted on application_invitations, and this
//  slice adds no migration. Re-running the date test at submission would
//  therefore refuse every legitimate forward offer, because the date it needs
//  was never stored. The forward offer was already governed at preparation;
//  what submission must still catch is inventory that has since been
//  COMMITTED TO SOMEONE ELSE or become un-attributable. So the same allowlist
//  is applied without the test whose input does not exist.
//
//  This is one allowlist used twice, not a second ladder.
//
//  AMBIGUITY GETS ITS OWN CODE. A unit that has been split into two spaces
//  since preparation is not "unsupported" the way a two-space unit is at
//  preparation time — it CHANGED under an open invitation, and the operator
//  needs to be told that rather than being told the shape was never allowed.
async function resolveSubmissionTarget(q, { property_id, unit_id } = {}) {
  const target = await resolveApplicationTarget(q, {
    property_id, unit_id, require_offerable: false,
  });

  if (!target.ok) {
    if (target.refusal_code === REFUSAL.MULTI_SPACE) {
      return {
        ...target,
        refusal_code: REFUSAL.BECAME_AMBIGUOUS,
        refusal_reason: REFUSAL_TEXT[REFUSAL.BECAME_AMBIGUOUS],
        httpStatus: 409,
      };
    }
    return target;
  }

  if (!target.targeted) return target;   // untargeted invitation: nothing to revalidate

  const submittable = target.marketing_state === OFFERABLE_NOW
    || OFFERABLE_FOR_FUTURE_MOVE_IN.has(target.marketing_state);

  if (!submittable) {
    return {
      ...target,
      ok: false,
      offerable: false,
      refusal_code: REFUSAL.NO_LONGER_OFFERABLE,
      refusal_reason: REFUSAL_TEXT[REFUSAL.NO_LONGER_OFFERABLE],
      httpStatus: 409,
    };
  }
  return { ...target, ok: true };
}

module.exports = {
  resolveApplicationTarget,
  resolveSubmissionTarget,
  evaluateOfferability,
  REFUSAL,
  REFUSAL_TEXT,
  OFFERABLE_NOW,
  OFFERABLE_FOR_FUTURE_MOVE_IN,
};
