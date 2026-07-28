// ════════════════════════════════════════════════════════════════════
//  work_proof.js — WHAT PROOF EACH KIND OF WORK ACTUALLY NEEDS
//
//  Class 1, permanent product primitive. PURE: no database, no I/O, no clock,
//  no network. Sibling of turn_sequence.js and the two interpreters.
//
//  ── LIGHTWEIGHT ON PURPOSE ──────────────────────────────────────────
//  One photo. Sometimes one short sentence. That is the whole requirement.
//
//  The failure mode this file is written against is not "too little proof" —
//  it is a proof form so heavy that a tech standing in a unit at 6pm stops
//  closing work honestly and starts closing it fast. A five-photo checklist
//  produces five bad photos. maintenance.js already carries the scar of a
//  gate that was satisfiable without real proof; the answer is a requirement
//  small enough that meeting it truthfully is easier than gaming it.
//
//  ── NOTHING HERE INSPECTS A PHOTO ───────────────────────────────────
//  No computer vision, no scoring, no automated approval, and none planned.
//  A photo reference is evidence a HUMAN can look at. This module checks that
//  evidence was ATTACHED, never that it is good. Claiming otherwise would be
//  the most expensive kind of confident-wrong: a machine verdict on physical
//  work nobody actually looked at.
//
//  ── AND IT NEVER CERTIFIES READINESS ────────────────────────────────
//  Satisfying proof closes ONE work item. It says nothing about the unit.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { STAGE } = require("./turn_sequence");

// Work whose completion a photo alone cannot demonstrate. A refrigerator can
// be photographed in place and still not cool; a door can be photographed shut
// and still not latch. For these, one short human sentence is required
// alongside the photo — not a form, a sentence.
const NEEDS_FUNCTIONAL_CONFIRMATION = [
  /\b(install|installed|replace|replacement|source and install)\b/i,
  /\b(refrigerator|fridge|stove|range|oven|dishwasher|microwave|washer|dryer|disposal|water heater)\b/i,
  /\b(hvac|a\/?c|air ?conditioning|furnace|heat(er|ing)?|thermostat)\b/i,
  /\b(latch|lock|leak|drip|outlet|switch|breaker|valve|faucet)\b/i,
];

const REQUIREMENTS = Object.freeze({
  [STAGE.REPAIR]: {
    photos_min: 1,
    label: "One completion photo",
    detail: "A clear photo of the finished repair or the installed item.",
  },
  [STAGE.PAINT]: {
    photos_min: 1,
    label: "One finished-area photo",
    detail: "A clear photo of the finished painted area.",
  },
  [STAGE.FINAL_CLEAN]: {
    photos_min: 1,
    label: "Final-condition photo",
    detail: "A photo showing the unit's final cleaned condition.",
  },
  [STAGE.READINESS_WALK]: {
    // BUILD 3 cannot certify readiness, so it does not define proof for the
    // walk. An item somehow staged here is refused rather than quietly
    // accepted against a requirement that does not exist.
    photos_min: null,
    label: "Not available in this build",
    detail: "The final readiness walk is not performed or certified here.",
  },
  unstaged: {
    photos_min: 1,
    label: "One completion photo",
    detail: "A clear photo showing the work finished.",
  },
});

/**
 * proofRequirementFor — what this specific item needs to close.
 * PURE. Takes a work row, returns the requirement.
 */
function proofRequirementFor(work) {
  const stage = (work && work.stage) || "unstaged";
  const base = REQUIREMENTS[stage] || REQUIREMENTS.unstaged;
  const text = String((work && work.work_text) || "");
  const needsFunctional =
    stage !== STAGE.FINAL_CLEAN &&
    NEEDS_FUNCTIONAL_CONFIRMATION.some((re) => re.test(text));

  return {
    stage: (work && work.stage) || null,
    photos_min: base.photos_min,
    needs_functional_confirmation: needsFunctional,
    label: needsFunctional ? `${base.label} + a short confirmation it works` : base.label,
    detail: needsFunctional
      ? `${base.detail} Plus one short sentence confirming it works — a photo cannot show that an appliance cools or a door latches.`
      : base.detail,
    // Said out loud so no surface has to infer it.
    not_inspected: "Proof is evidence a person can look at. Nothing here inspects or scores a photo.",
  };
}

/**
 * evaluateProof — does this claim meet its requirement?
 * PURE. Returns { satisfied, shortfall } and NEVER throws.
 *
 * Only a `completed` outcome can satisfy anything. unable_to_complete and
 * needs_followup leave the work open by definition, so proof is irrelevant to
 * them — asking a tech for a completion photo of work they could not do would
 * be a form demanding a lie.
 */
function evaluateProof(work, claim) {
  const req = proofRequirementFor(work);
  const outcome = claim && claim.outcome;

  if (outcome !== "completed") {
    return {
      satisfied: false,
      shortfall: null,
      requirement: req,
      note: "Only a completed claim can satisfy proof. This outcome leaves the work open.",
    };
  }

  if (req.photos_min === null) {
    return {
      satisfied: false,
      shortfall: "This stage cannot be completed in this build.",
      requirement: req,
    };
  }

  const photos = Array.isArray(claim.proof_photos) ? claim.proof_photos.filter(Boolean) : [];
  const confirmation = String((claim && claim.functional_confirmation) || "").trim();
  const missing = [];

  if (photos.length < req.photos_min) {
    missing.push(req.photos_min === 1 ? "a completion photo" : `${req.photos_min} photos`);
  }
  // A confirmation must be a sentence, not a keystroke. Two characters is
  // somebody satisfying a gate, not somebody confirming a thing works.
  if (req.needs_functional_confirmation && confirmation.length < 3) {
    missing.push("a short confirmation that it works");
  }

  return missing.length
    ? { satisfied: false, shortfall: `Missing ${missing.join(" and ")}.`, requirement: req }
    : { satisfied: true, shortfall: null, requirement: req };
}

// Plain-language labels for the closed unable-to-complete vocabulary. The
// server decides the words the operator reads.
const UNABLE_REASONS = Object.freeze({
  part_or_appliance_unavailable: "Part or appliance unavailable",
  specialist_required: "Specialist required",
  additional_damage_found: "Additional damage found",
  access_issue: "Could not get access",
  incorrect_scope: "Scope is wrong",
  insufficient_time: "Not enough time",
  other: "Other",
});
const UNABLE_REASON_VALUES = Object.freeze(Object.keys(UNABLE_REASONS));

// What each stall proposes next. It PROPOSES — nothing here dispatches
// anything, orders a part, or contacts a vendor, and the copy must never
// suggest otherwise. maintenance.js already returns a fabricated "Tenant
// notified (demo)" receipt elsewhere in this system; that is the shape of
// wrongness this avoids.
const UNABLE_NEXT_ACTION = Object.freeze({
  part_or_appliance_unavailable: "Source the part or appliance. Nothing has been ordered.",
  specialist_required: "Decide who performs this work. No vendor has been contacted.",
  additional_damage_found: "Re-scope this item — the work is larger than recorded.",
  access_issue: "Arrange access and re-attempt.",
  incorrect_scope: "Correct the scope. This item may need to be withdrawn or replaced.",
  insufficient_time: "Re-commit to a new time.",
  other: "A person must review this and decide the next step.",
});

const OUTCOMES = Object.freeze({
  COMPLETED: "completed",
  UNABLE: "unable_to_complete",
  FOLLOWUP: "needs_followup",
});
const OUTCOME_VALUES = Object.freeze(Object.values(OUTCOMES));

const COMMITMENT_SOURCES = Object.freeze([
  "operator_entered", "proposed_from_text", "scope_default", "none",
]);

module.exports = {
  proofRequirementFor, evaluateProof,
  REQUIREMENTS, UNABLE_REASONS, UNABLE_REASON_VALUES, UNABLE_NEXT_ACTION,
  OUTCOMES, OUTCOME_VALUES, COMMITMENT_SOURCES,
};
