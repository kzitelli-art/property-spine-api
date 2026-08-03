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

// ── THE OFFERABILITY POLICY — ONE STATE, BOTH BOUNDARIES ─────────────
//  A targeted application invitation is supported ONLY when the canonical
//  marketing state is marketable_now.
//
//  ── WHY FORWARD TARGETING WAS WITHDRAWN (owner ruling) ──────────────
//  Preparation previously admitted `upcoming` and `turnover_required` when a
//  supplied intended_move_in fell on or after a governed available_from.
//  That date is a REQUEST PARAMETER and reaches no durable row —
//  application_invitations has no column for it — so submission could not
//  reproduce the decision preparation had made. Submission therefore applied a
//  WEAKER standard than preparation in three of six cases, and
//  turnover_required was unreachable at preparation yet permitted at
//  submission.
//
//  Two boundaries applying different standards is the defect, whatever the
//  shared code path. Closing it truthfully needs the governed date to survive
//  on the invitation — new durable lineage, therefore a migration, which this
//  cut forbids. So the promise is withdrawn rather than half-kept:
//
//      A target may not be offered unless BOTH boundaries can independently
//      reach the same verdict from durable facts alone.
//
//  `upcoming` and `turnover_required` REMAIN truthful canonical availability
//  states. They are not flattened into `unavailable` and nothing about the
//  availability read changes. They are simply not valid APPLICATION targets
//  under the present durable application contract — a lineage limitation, not
//  a statement about the position.
//
//  An allowlist rather than a denylist BY CONSTRUCTION: a marketing state
//  added to availability_read later must be deliberately admitted here.
//  Unknown is not offerable.
const OFFERABLE_NOW = "marketable_now";

// Truthful availability states that cannot carry an application target today.
// Named so the refusal can explain itself instead of falling into the generic
// not_offerable bucket, which would misdescribe why.
const FUTURE_DATED_STATES = new Set(["upcoming", "turnover_required"]);

// Refusal codes. Stable identifiers — the app renders from these, never from
// prose, and never re-derives the decision.
const REFUSAL = {
  NOT_AT_PROPERTY:        "not_at_property",
  UNCONFIGURED:           "application_target_unconfigured",
  MULTI_SPACE:            "space_grain_not_supported",
  NOT_OFFERABLE:          "not_offerable",
  // CAPABILITY refusal, not an availability statement. The position may be
  // perfectly real and coming available on a governed date; what is missing is
  // durable application lineage able to carry a future-dated target.
  FUTURE_NOT_SUPPORTED:   "future_application_target_not_supported",
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
  // Describes the LINEAGE limitation. It must not say the position is
  // unavailable — it may be genuinely coming available on a governed date, and
  // saying otherwise would be a confident-wrong statement about inventory.
  [REFUSAL.FUTURE_NOT_SUPPORTED]:
    "Application links for a future availability date are not supported yet. "
    + "This unit is not available today, and an application record cannot yet "
    + "carry a future-dated target through to the lease.",
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

// available_from is still CARRIED on the result — it is truthful context an
// operator surface may render. It no longer GOVERNS anything.
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
 * @param require_offerable when false, resolve the space and REPORT
 *                     offerability without refusing on it. Grain refusals
 *                     (multi-space, unconfigured, not-at-property) still
 *                     refuse — they are structural, not a policy opinion.
 */
async function resolveApplicationTarget(q, {
  property_id,
  unit_id = null,
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

  const verdict = evaluateOfferability(row);

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
function evaluateOfferability(row) {
  const state = row.marketing_state;

  if (state === OFFERABLE_NOW) return { offerable: true, refusal_code: null };

  // A truthful future-dated availability state. The refusal is about what the
  // application record can carry, NOT about the position.
  if (FUTURE_DATED_STATES.has(state)) {
    return { offerable: false, refusal_code: REFUSAL.FUTURE_NOT_SUPPORTED };
  }

  return { offerable: false, refusal_code: REFUSAL.NOT_OFFERABLE };
}

// ── SUBMISSION-TIME REVALIDATION ─────────────────────────────────────
//  THE SAME AUTHORITY, THE SAME RULE. Preparation and first submission now
//  reach an identical verdict from durable facts alone, with no request-time
//  context either boundary could lose.
//
//  Submission may be STRICTER than preparation, because the target can change
//  after preparation — a unit that was marketable_now may since have been
//  taken, split into two spaces, or had its space removed. It can never be
//  WEAKER, which is exactly the defect this replaces.
//
//  AMBIGUITY KEEPS ITS OWN CODE. A unit split into two spaces since
//  preparation is not "unsupported" the way a two-space unit is at preparation
//  time — it CHANGED under an open invitation, and the operator needs to be
//  told that rather than that the shape was never allowed.
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

  if (target.marketing_state !== OFFERABLE_NOW) {
    // TWO DIFFERENT FACTS, TWO DIFFERENT CODES.
    //
    //  A future-dated state was never a supportable target, so saying it is
    //  "no longer offerable" would falsely imply it CHANGED. It reports the
    //  same capability refusal preparation gives — which is also what makes
    //  the two boundaries verifiably identical.
    //
    //  Every other non-marketable state DID change under an open invitation:
    //  the unit was taken, went down, became contested. That is a genuine
    //  no-longer-offerable.
    const code = FUTURE_DATED_STATES.has(target.marketing_state)
      ? REFUSAL.FUTURE_NOT_SUPPORTED
      : REFUSAL.NO_LONGER_OFFERABLE;
    return {
      ...target,
      ok: false,
      offerable: false,
      refusal_code: code,
      refusal_reason: REFUSAL_TEXT[code],
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
  FUTURE_DATED_STATES,
};
