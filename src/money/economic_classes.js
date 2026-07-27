// ════════════════════════════════════════════════════════════════════
//  economic_classes.js — THE PERMANENT ECONOMIC-CLASS CONTRACT
//
//  The thirteen live money facts exposed a structural boundary that a single
//  generic `fee_terms` blob would have erased. These seven classes are not
//  categories for display. They differ in the questions they can be asked:
//
//    · Does it recur?              base_rent and recurring_charge do.
//    · Does it come back?          deposit_required does; a fee does not.
//    · Is it a liability we hold?  deposit_held is; deposit_required is not.
//    · Is it a reduction?          concession is; credit is the posting of one.
//
//  Collapsing any two of these produces a specific, predictable wrong number:
//
//    base_rent + recurring_charge  → parking and pet rent enter the rent roll
//        as contractual rent. NOI overstates and the lender package is wrong.
//    recurring_charge + one_time_fee → a $300 one-time pet fee becomes $300
//        a month, or $30/mo pet rent becomes a single $30 charge.
//    deposit_required + deposit_held → an underwriting REQUIREMENT is booked
//        as money we are holding. That is a fabricated liability. This is the
//        distinction behind the standing ruling not to map imported `deposit`
//        values into leases.security_deposit.
//    deposit_* + one_time_fee → a refundable balance is recognised as income.
//    concession + credit → a concession is the AUTHORITY to reduce; a credit
//        is the dated posting. Merging them means either a promise with no
//        posting, or a posting nobody authorised.
//
//  THIS FILE CREATES NO SCHEMA. It is the vocabulary and the honest-answer
//  set. The recurring-charge model is deliberately NOT built here.
// ════════════════════════════════════════════════════════════════════

"use strict";

// Cadence is the property that most often gets lost, so it is named, not implied.
const CADENCE = ["monthly", "one_time", "one_time_per_term", "conditional", "none"];

const ECONOMIC_CLASSES = {
  base_rent: {
    definition: "Monthly contractual rent for the rentable position itself.",
    cadence: "monthly",
    refundable: false,
    enters_rent_roll: true,
    canonical_owner: "Pricing & Concessions (published version) → leases.rent once executed",
    representable_today: true,
    representable_how: "pricing_terms.base_rent / renewal_rent, keyed to a governed unit type.",
  },

  recurring_charge: {
    definition: "A monthly amount owed alongside rent that is not rent: parking, pet rent, wifi, insurance.",
    cadence: "monthly",
    refundable: false,
    // The consequence that matters: it is real monthly money that no current
    // surface can see, so it is absent from NOI and from the lender package.
    enters_rent_roll: false,
    canonical_owner: "Recurring charges — DOES NOT EXIST",
    representable_today: false,
    representable_how: null,
    honest_answer_today: "recurring_charge_model_not_built",
    why_not_representable:
      "No table carries a per-position recurring obligation with its own cadence, start and end. " +
      "pricing_terms.fee_terms is a blob with no cadence, so storing $30/month there would be " +
      "indistinguishable from a $30 one-time fee. agent_facts is prose and cannot be summed. " +
      "Representing it dishonestly is worse than reporting it absent.",
  },

  one_time_fee: {
    definition: "A non-refundable charge owed once at a defined event (application, move-in, renewal, transfer).",
    cadence: "one_time",
    refundable: false,
    enters_rent_roll: false,
    canonical_owner: "Pricing & Concessions",
    representable_today: "partially",
    representable_how:
      "pricing_terms.fee_terms exists but is a blob with no amount/cadence/applicability shape, " +
      "and is deliberately NOT read as authority. Today the only live source is the approved " +
      "agent_facts, which are prose: a $75–99 range cannot be resolved to a number by reading it.",
  },

  deposit_required: {
    definition: "A contractual underwriting REQUIREMENT — what an applicant must post to qualify. Not money held.",
    cadence: "conditional",
    refundable: true,
    enters_rent_roll: false,
    canonical_owner: "Risk / underwriting — NOT pricing",
    representable_today: false,
    honest_answer_today: "underwriting_requirement_not_modelled",
    why_not_representable:
      "leases.security_deposit is a HELD amount, not a requirement. Writing a requirement there " +
      "is exactly the mapping that was ruled out: it would state we hold money we may never have " +
      "received. The live fact is also a conditional band ($1,000 up to one month's rent), and a " +
      "band is not a value.",
  },

  deposit_held: {
    definition: "A dated liability: money actually received and held, refundable subject to disposition.",
    cadence: "one_time",
    refundable: true,
    enters_rent_roll: false,
    canonical_owner: "Money / ledger",
    representable_today: "structurally",
    representable_how:
      "leases.security_deposit is the correct home, but it is populated only by proven receipt. " +
      "It is currently blank across the portfolio, which is the honest state, not a gap to fill.",
  },

  concession: {
    definition: "Approved AUTHORITY to reduce otherwise-applicable economics. A rule, not a posting.",
    cadence: "one_time_per_term",
    refundable: false,
    enters_rent_roll: false,
    canonical_owner: "Pricing & Concessions",
    representable_today: "structurally",
    representable_how:
      "concession_policies carries type, value, timing_profile and required term. It cannot be " +
      "ADVERTISED, because a concession must become dated economic consequence and " +
      "computeScheduleLines is a throw-only stub.",
  },

  credit: {
    definition: "An actual posted or promised monetary adjustment on a specific tenancy at a specific date.",
    cadence: "one_time",
    refundable: false,
    enters_rent_roll: false,
    canonical_owner: "Money / ledger",
    representable_today: false,
    honest_answer_today: "schedule_line_engine_not_activated",
    why_not_representable:
      "A credit is the dated consequence of a concession. The engine that places dated lines does " +
      "not exist, so move_in_credits ($500/$500/$300) is a promise with no posting behind it — " +
      "and it is being quoted to prospects today from prose.",
  },
};

// ── the smallest permanent contract ─────────────────────────────────
// What ANY money obligation must answer, whatever class it is. A source that
// cannot answer all nine is not governable, and saying so is the point of
// this list: it is how the fee facts are graded in the contradiction report.
const MONEY_OBLIGATION_CONTRACT = [
  "economic_class",   // one of the seven above — never inferred
  "amount",           // a resolved number, or an explicit unresolved reason
  "cadence",          // monthly | one_time | one_time_per_term | conditional | none
  "applicability",    // which positions/populations it applies to
  "required",         // required | optional
  "refundable",       // refundable | non_refundable
  "effective_from",   // when it starts applying
  "authority",        // who approved it, on what basis
  "canonical_owner",  // which service owns it after migration
];

const CLASS_NAMES = Object.keys(ECONOMIC_CLASSES);

/** Which classes can be represented honestly with tables that exist TODAY. */
function representability() {
  return CLASS_NAMES.map((k) => ({
    economic_class: k,
    representable_today: ECONOMIC_CLASSES[k].representable_today,
    canonical_owner: ECONOMIC_CLASSES[k].canonical_owner,
    honest_answer_today: ECONOMIC_CLASSES[k].honest_answer_today || null,
    blocker: ECONOMIC_CLASSES[k].why_not_representable || null,
  }));
}

module.exports = { ECONOMIC_CLASSES, MONEY_OBLIGATION_CONTRACT, CLASS_NAMES, CADENCE, representability };
