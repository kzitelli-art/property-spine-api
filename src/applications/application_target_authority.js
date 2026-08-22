// ════════════════════════════════════════════════════════════════════
//  application_target_authority.js — WHERE AN APPLICATION MAY BE AIMED
//
//  ONE authority answers one question, for every entry path that creates
//  or sends an application link:
//
//      May an application be aimed at this unit right now, and which
//      exact space would it land on?
//
//  ── THE GOVERNING GRAIN BOUNDARY — WIDENED AT MIGRATION 182 ──────────
//  This section previously read "the application segment is durably
//  UNIT-GRAINED", and stated its own removal condition:
//
//      A space choice cannot be offered unless the complete durable chain
//      can preserve it.
//
//  Migration 182 gave the chain that ability. Verified at schema:
//
//      application_invitations   property_id, unit_id, space_id   (nullable)
//      lease_applications        property_id, unit_id, space_id   (nullable)
//      lifecycle BIRTH_FIELDS    unit_id, space_id
//      leases                    space_id NOT NULL
//      executed_lease_records    space_id REQUIRED
//
//  So the aim now survives from invitation to executed lease as ONE fact
//  instead of being re-asserted at the end from browser state. Therefore:
//
//      unit with exactly one space   → supported, space derived SERVER-SIDE
//      unit with >1 space, space CHOSEN   → supported, choice VALIDATED
//      unit with >1 space, no space given → refused: a bed must be chosen
//      unit with zero spaces         → unconfigured, refused
//
//  The multi-space refusal did not disappear — it changed meaning. It used
//  to say "this shape is not supported"; it now says "you have not told me
//  which bed". The first was a statement about Spine, the second is a
//  statement about the request, and they are different refusals (§40.7's
//  discipline, one altitude down).
//
//  ── resolved_space_id IS NOW LINEAGE, DELIBERATELY ───────────────────
//  It was "a VALIDATION RECEIPT, NOT LINEAGE … MUST NOT be persisted as
//  though it were", because the chain could not carry it and a persisted
//  receipt would have been a bed nobody could prove was chosen. That
//  reasoning was correct and is now spent: the chain carries it, so the
//  value callers persist is the same value availability was evaluated
//  against. Callers write it to space_id; nothing derives it a second time.
//
//  What has NOT changed: the browser never supplies a space that is trusted
//  unchecked. A chosen space is validated against the unit and the property
//  here, and again by trg_lease_application_space_grain in Postgres.
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
//  A targeted invitation is supported when the canonical position is
//  marketable now, or when an active turn plan supplies an expected-ready date
//  on or before the intended move-in date.
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
//  shared code path. Migration 190 makes the governed intended move-in date
//  survive on the invitation and application, so both boundaries now reach
//  the same verdict from durable facts:
//
//      A target may not be offered unless BOTH boundaries can independently
//      reach the same verdict from durable facts alone.
//
//  `upcoming` and `turnover_required` remain truthful canonical availability
//  states. They are targets only when the active turn carries a ready date;
//  lease expiration alone still cannot manufacture one.
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
  //  RETAINED, NO LONGER EMITTED (182). The deployed app branches on this
  //  string and an app harness pins it, so removing it is a contract change
  //  the API may not make alone (Open Ruling 2 — the app leads). It stays
  //  defined and stops being reachable: after 182 a multi-space unit is not
  //  unsupported, it is unchosen, and SPACE_CHOICE_REQUIRED says so.
  //  REMOVAL CONDITION: delete when no deployed app matches this token.
  MULTI_SPACE:            "space_grain_not_supported",
  //  NEW (182). A statement about the REQUEST, not about Spine.
  SPACE_CHOICE_REQUIRED:  "space_choice_required",
  //  NEW (182). A supplied space that does not belong to the stated unit or
  //  property. Never silently corrected — a caller aiming at the wrong bed
  //  must learn that, not be redirected to a bed it did not name.
  SPACE_NOT_IN_UNIT:      "space_not_in_unit",
  NOT_OFFERABLE:          "not_offerable",
  // CAPABILITY refusal, not an availability statement. The position may be
  // perfectly real and coming available on a governed date; what is missing is
  // durable application lineage able to carry a future-dated target.
  FUTURE_NOT_SUPPORTED:   "future_application_target_not_supported",
  MOVE_IN_DATE_REQUIRED:  "application_move_in_date_required",
  MOVE_IN_DATE_INVALID:   "application_move_in_date_invalid",
  MOVE_IN_BEFORE_READY:   "application_move_in_before_expected_ready",
  READY_DATE_NOT_GOVERNED:"application_ready_date_not_governed",
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
  //  ⚠ WORDING IS A CONTRACT HERE. The deployed app matches refusal PROSE,
  //  not only codes: /more than one rentable space|not supported for this unit/
  //  routes to "Individual-space application links are not supported" — which
  //  is FALSE after 182. This sentence deliberately avoids both fragments, so
  //  an old app falls through to showing it verbatim (honest, if plain) rather
  //  than confidently saying something untrue. Do not reword it toward those
  //  phrases without moving the app first.
  [REFUSAL.SPACE_CHOICE_REQUIRED]:
    "This unit has more than one bed. Choose which bed this application is for.",
  [REFUSAL.SPACE_NOT_IN_UNIT]:
    "That bed is not part of this unit at this property.",
  [REFUSAL.NOT_OFFERABLE]:        "This unit cannot be offered right now.",
  // Describes the LINEAGE limitation. It must not say the position is
  // unavailable — it may be genuinely coming available on a governed date, and
  // saying otherwise would be a confident-wrong statement about inventory.
  [REFUSAL.FUTURE_NOT_SUPPORTED]:
    "Application links for a future availability date are not supported yet. "
    + "This unit is not available today, and an application record cannot yet "
    + "carry a future-dated target through to the lease.",
  [REFUSAL.MOVE_IN_DATE_REQUIRED]:
    "Choose the intended move-in date before sending an application for this future availability.",
  [REFUSAL.MOVE_IN_DATE_INVALID]:
    "The intended move-in date is invalid. Choose a calendar date.",
  [REFUSAL.MOVE_IN_BEFORE_READY]:
    "The intended move-in date is before the current turn plan expects this home to be ready.",
  [REFUSAL.READY_DATE_NOT_GOVERNED]:
    "This home is coming available, but no governed turn-ready date is on file yet. Set the turn target before sending an application.",
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
const isValidYmd = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

// ── WHICH BED — ISOLATED SO IT CAN BE PROVEN DIRECTLY (182) ──────────
//  Same treatment evaluateOfferability already gets, and for the same
//  reason: this is the decision 182 changed, and it must be testable
//  without standing up availability_read and the dated-positions chain
//  behind it. Grain is "which bed"; offerability is "may it be offered".
//  They were one block and are now two, which is also why a grain refusal
//  can be returned before any availability work happens at all.
//
//  Returns { ok:true, space_id, resolution_basis } or { ok:false, refusal }.
async function resolveGrain(q, { property_id, unit_id, chosen_space_id, space_count }) {
  if (chosen_space_id) {
    //  VALIDATE, NEVER TRUST. A bed supplied by a browser is a request; the
    //  server confirms it belongs to this unit at this property before it can
    //  become lineage. Postgres refuses it again at write time.
    const s = (await q.query(
      `select s.id from spaces s
         join units u on u.id = s.unit_id
        where s.id = $1 and s.unit_id = $2 and u.property_id = $3`,
      [chosen_space_id, unit_id, property_id]
    )).rows[0];
    if (!s) {
      return { ok: false, refusal: refuse(REFUSAL.SPACE_NOT_IN_UNIT, {
        property_id, unit_id, resolved_space_id: null,
        rentable_space_count: space_count, httpStatus: 409,
      }) };
    }
    return { ok: true, space_id: s.id, resolution_basis: "chosen_space" };
  }

  if (space_count === 1) {
    //  SOLE SPACE — DERIVED SERVER-SIDE, NEVER SUPPLIED. Unchanged from
    //  before 182. A whole-unit property never chooses a bed and never sees a
    //  bed picker; the mapping is a total function and the server still
    //  performs it. The only difference is that callers may now persist what
    //  was already derived.
    const sole = (await q.query(
      `select id from spaces where unit_id = $1`, [unit_id]
    )).rows[0].id;
    return { ok: true, space_id: sole, resolution_basis: "sole_space_unit" };
  }

  //  THE REFUSAL THAT REPLACED "NOT SUPPORTED". The unit can carry an
  //  application at a bed; this request did not say which one. Refusing is
  //  still the right answer — "pick the marketable one" remains rejected for
  //  exactly the reason it always was.
  return { ok: false, refusal: refuse(REFUSAL.SPACE_CHOICE_REQUIRED, {
    property_id, unit_id, rentable_space_count: space_count, httpStatus: 409,
  }) };
}

/**
 * Resolve where an application may be aimed.
 *
 * @param q            pool OR an open transaction client. The canonical read
 *                     chain uses only .query(), so a caller inside a
 *                     transaction gets a target resolved against the SAME
 *                     snapshot as the write it is about to make.
 * @param property_id  SERVER-DERIVED property scope. Never a browser value.
 * @param unit_id      null ⇒ untargeted, UNLESS space_id is given, in which
 *                     case the unit is DERIVED from the space (182).
 * @param space_id     the exact bed this application is aimed at. Optional.
 *                     Supplied by an operator choosing among a unit's beds; it
 *                     is VALIDATED against the unit and the property here and
 *                     never trusted as given. Absent on a single-space unit
 *                     means "derive it", which is the pre-182 behaviour and is
 *                     unchanged. Absent on a multi-space unit is a refusal.
 * @param require_offerable when false, resolve the space and REPORT
 *                     offerability without refusing on it. Grain refusals
 *                     (unchosen space, unconfigured, not-at-property) still
 *                     refuse — they are structural, not a policy opinion.
 */
async function resolveApplicationTarget(q, {
  property_id,
  unit_id = null,
  space_id: chosen_space_id = null,
  intended_move_in = null,
  require_offerable = true,
} = {}) {
  if (!property_id) throw new Error("resolveApplicationTarget requires a server-derived property_id");
  const normalizedIntendedMoveIn = ymd(intended_move_in);
  if (intended_move_in != null && !isValidYmd(normalizedIntendedMoveIn)) {
    return refuse(REFUSAL.MOVE_IN_DATE_INVALID, {
      property_id, unit_id, resolved_space_id: null, httpStatus: 400,
    });
  }

  // ── A BED IMPLIES ITS UNIT (182) ──────────────────────────────────
  //  The server derives the parent rather than letting a caller assert both
  //  and trusting whichever it read first. A caller that supplies both still
  //  gets them checked against each other below.
  if (chosen_space_id && !unit_id) {
    const owner = (await q.query(
      `select unit_id from spaces where id = $1`, [chosen_space_id]
    )).rows[0];
    if (!owner) {
      return refuse(REFUSAL.SPACE_NOT_IN_UNIT, {
        property_id, unit_id: null, resolved_space_id: null,
        rentable_space_count: null, httpStatus: 404,
      });
    }
    unit_id = owner.unit_id;
  }

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

  const grain = await resolveGrain(q, {
    property_id, unit_id, chosen_space_id, space_count: u.space_count,
  });
  if (!grain.ok) return grain.refusal;
  const { space_id, resolution_basis } = grain;

  // ── CANONICAL AVAILABILITY FOR THAT EXACT SPACE ───────────────────
  const avail = await availabilityRead(q, { property_id });
  const row = (avail.rows || []).find((r) => String(r.space_id) === String(space_id));

  if (!row) {
    // The space exists but the canonical read did not classify it. That is a
    // read gap, not evidence of availability. Refuse rather than assume.
    return refuse(REFUSAL.NOT_OFFERABLE, {
      property_id, unit_id, resolved_space_id: space_id,
      rentable_space_count: u.space_count, marketing_state: null,
      available_from: null, availability_confidence: null, httpStatus: 409,
    });
  }

  const base = {
    property_id,
    unit_id,
    //  LINEAGE as of 182 — callers persist this as space_id. It is the same
    //  value availability was evaluated against, so the bed that was checked
    //  and the bed that is recorded cannot diverge.
    resolved_space_id: space_id,
    resolution_basis,                     // 'chosen_space' | 'sole_space_unit'
    targeted: true,
    rentable_space_count: u.space_count,
    unit_number: row.unit_number,
    space_label: row.space_label,
    position_kind: row.position_kind,
    marketing_state: row.marketing_state,
    blocking_reason: row.blocking_reason,
    available_from: ymd(row.available_from),
    availability_confidence: row.availability_confidence,
    intended_move_in: normalizedIntendedMoveIn,
    turnover: row.turnover || null,
  };

  const verdict = evaluateOfferability(row, { intended_move_in: normalizedIntendedMoveIn });

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
function evaluateOfferability(row, { intended_move_in = null } = {}) {
  const state = row.marketing_state;

  if (state === OFFERABLE_NOW) return { offerable: true, refusal_code: null };

  if (FUTURE_DATED_STATES.has(state)) {
    const available = ymd(row.available_from);
    const target = ymd(intended_move_in);
    if (!available || !["expected", "confirmed"].includes(row.availability_confidence)) {
      return { offerable: false, refusal_code: REFUSAL.READY_DATE_NOT_GOVERNED };
    }
    if (!target) return { offerable: false, refusal_code: REFUSAL.MOVE_IN_DATE_REQUIRED };
    if (target < available) return { offerable: false, refusal_code: REFUSAL.MOVE_IN_BEFORE_READY };
    return { offerable: true, refusal_code: null };
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
//  ── WHAT 182 CHANGED HERE, AND WHY IT IS A REAL IMPROVEMENT ─────────
//  An invitation that carries a bed is no longer made ambiguous by its unit
//  gaining a space. That was the whole content of BECAME_AMBIGUOUS: the unit
//  changed shape under an open invitation and nothing on the invitation could
//  say which space it had meant. Now it can, so the question does not arise
//  and the applicant's link keeps working — which is the correct outcome for
//  someone who chose bed B before the landlord split bed A in two.
//
//  The refusal is RETAINED for invitations with no bed on them: those are
//  genuinely ambiguous, and the pre-182 reasoning applies to them unchanged.
async function resolveSubmissionTarget(q, {
  property_id, unit_id, space_id = null, intended_move_in = null,
} = {}) {
  const target = await resolveApplicationTarget(q, {
    property_id, unit_id, space_id, intended_move_in, require_offerable: false,
  });

  if (!target.ok) {
    //  MULTI_SPACE is no longer emitted by resolveApplicationTarget; an
    //  unchosen bed now returns SPACE_CHOICE_REQUIRED. Both map to the same
    //  submission-time meaning — this link cannot be attributed to a space —
    //  and MULTI_SPACE stays in the test so a reintroduction is still caught.
    if (target.refusal_code === REFUSAL.MULTI_SPACE
        || target.refusal_code === REFUSAL.SPACE_CHOICE_REQUIRED) {
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

  const verdict = evaluateOfferability(target, { intended_move_in });
  if (!verdict.offerable) {
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
      ? verdict.refusal_code
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
  resolveGrain,
  resolveSubmissionTarget,
  evaluateOfferability,
  REFUSAL,
  REFUSAL_TEXT,
  OFFERABLE_NOW,
  FUTURE_DATED_STATES,
};
