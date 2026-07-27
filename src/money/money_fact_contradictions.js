// ════════════════════════════════════════════════════════════════════
//  money_fact_contradictions.js — ONE CONTRADICTION REPORT, NO SECOND COPY
//
//  Every active fact that carries a dollar figure, classified against the
//  economic-class contract. This is a REVIEW, so it deliberately creates no
//  governed row: making a second canonical copy during a review of duplicate
//  copies would be the exact mistake being reviewed.
//
//  The classification is DECLARED, not inferred. Regex over prose can find a
//  number; it cannot know whether $75–99 is a tier, a negotiation or a typo.
//  Guessing that would manufacture the certainty the report exists to deny.
//  So each known fact carries a hand-authored judgment with its reasoning,
//  and anything NOT declared is surfaced as `undeclared_money_fact` rather
//  than silently omitted — a new fee appearing tomorrow must show up here.
// ════════════════════════════════════════════════════════════════════

"use strict";

const VERDICTS = [
  "consistent_and_governed",
  "conflicting",
  "conditional_but_condition_missing",
  "prose_duplication",
  "legacy_evidence",
  "not_safe_to_quote",
];

// amount: a resolved number, or null with `unresolved` naming what is missing.
const DECLARED = {
  pricing_application_fee: {
    economic_class: "one_time_fee", amount: 50, cadence: "one_time",
    applicability: "per applicant", required: true, refundable: false,
    verdict: "consistent_and_governed",
    note: "A single unambiguous number. The cleanest fee in the set.",
    ai_quotes_today: true, canonical_owner: "Pricing & Concessions",
  },
  pricing_admin_fee: {
    economic_class: "one_time_fee", amount: 99, cadence: "one_time",
    applicability: "per unit, at move-in AND at renewal", required: true, refundable: false,
    verdict: "consistent_and_governed",
    note: "One amount, two events. Needs an event dimension, not a second amount.",
    ai_quotes_today: true, canonical_owner: "Pricing & Concessions",
  },
  pricing_amenity_fee: {
    economic_class: "one_time_fee", amount: 300, cadence: "one_time",
    renewal_amount: 250,
    applicability: "per unit at move-in; $250 at renewal", required: true, refundable: false,
    verdict: "conditional_but_condition_missing",
    note: "$300/$250 is not a conflict — it is two populations (new lease vs renewal) in one " +
          "sentence. The condition is knowable but is not carried anywhere structured, so a " +
          "consumer must parse prose to apply it. That is the missing condition.",
    ai_quotes_today: true, canonical_owner: "Pricing & Concessions",
  },
  pricing_telecom_fee: {
    economic_class: "one_time_fee", amount: null, unresolved: "range_75_to_99",
    cadence: "one_time", applicability: "at move-in", required: true, refundable: false,
    verdict: "conditional_but_condition_missing",
    note: "A $24 range with NO stated determinant. Nothing in the fact, the schema or the unit " +
          "record says what makes it $75 rather than $99. Until the determinant is named this " +
          "cannot be resolved to a number, and a governed sheet cannot publish a range as a price.",
    ai_quotes_today: true, canonical_owner: "Pricing & Concessions",
  },
  pricing_security_deposit: {
    economic_class: "deposit_required", amount: null, unresolved: "conditional_band",
    cadence: "conditional", applicability: "per lease, subject to approval", required: true, refundable: true,
    verdict: "not_safe_to_quote",
    note: "$1,000 up to one month's rent, 'subject to approval conditions'. The approval model " +
          "does not exist, so the amount is unknowable at quote time. It is also the wrong class " +
          "for pricing: a requirement is underwriting, not an offer.",
    ai_quotes_today: true, canonical_owner: "Risk / underwriting — NOT pricing",
  },
  parking_pricing: {
    economic_class: "recurring_charge", amount: 300, cadence: "monthly",
    applicability: "optional, assigned garage spot, subject to availability/waitlist",
    required: false, refundable: false,
    verdict: "not_safe_to_quote",
    note: "The AMOUNT is unambiguous; the AVAILABILITY is not, and the fact says so ('must be " +
          "confirmed with the leasing office'). Quoting $300/month implies a spot exists. There " +
          "is no parking inventory model, so availability cannot be checked before quoting.",
    ai_quotes_today: true, canonical_owner: "Recurring charges — DOES NOT EXIST",
  },
  pet_policy: {
    economic_class: "recurring_charge", amount: 30, cadence: "monthly",
    one_time_component: 300,
    applicability: "optional, per pet-owning tenancy", required: false, refundable: false,
    verdict: "conflicting",
    note: "ONE fact carries TWO economic classes: a $300 one_time_fee and $30/month " +
          "recurring_charge. It also does not state per-pet vs per-tenancy, so a two-pet " +
          "household has no determinable answer. This is the clearest case for why a generic " +
          "fee blob would be wrong.",
    ai_quotes_today: true, canonical_owner: "split: Pricing & Concessions + Recurring charges",
  },
  utilities: {
    economic_class: "recurring_charge", amount: 40, cadence: "monthly",
    applicability: "building wifi (Flume); electric and water are usage-based, unmetered here",
    required: false, refundable: false,
    verdict: "not_safe_to_quote",
    note: "The $40 wifi charge is precise. The same sentence says electric and water are " +
          "'based on usage' with no amount — so a prospect asking 'what are utilities' cannot " +
          "be given a total, and quoting the $40 alone understates the real monthly obligation.",
    ai_quotes_today: true, canonical_owner: "Recurring charges — DOES NOT EXIST",
  },
  renters_insurance: {
    economic_class: "recurring_charge", amount: 15, cadence: "monthly",
    applicability: "required coverage; $15/mo applies ONLY to the building program",
    required: true, refundable: false,
    verdict: "conditional_but_condition_missing",
    note: "Insurance is required; the $15 is not. It applies only if the resident takes the " +
          "building program instead of their own policy. Quoting $15 as the cost of a required " +
          "item states an optional price as mandatory.",
    ai_quotes_today: true, canonical_owner: "Recurring charges — DOES NOT EXIST",
  },
  unit_transfers: {
    economic_class: "one_time_fee", amount: null, unresolved: "depends_on_transfer_direction",
    cadence: "conditional",
    applicability: "$750 upgrade, $1,000 same-type/downgrade, $0 upgrading at expiration",
    required: true, refundable: false,
    verdict: "conditional_but_condition_missing",
    note: "Three amounts on three conditions, none of which are structured. Not a new-lease " +
          "quote at all — it is resident policy and does not belong in an offer.",
    ai_quotes_today: true, canonical_owner: "Leasing policy — NOT pricing",
  },
  entry_access: {
    economic_class: "one_time_fee", amount: null, unresolved: "incidental_schedule",
    cadence: "conditional",
    applicability: "$75 fob, $25 key, $25 after-hours lockout", required: false, refundable: false,
    verdict: "legacy_evidence",
    note: "Incidental operational charges. Real, but not part of an offer and not pricing's to own.",
    ai_quotes_today: true, canonical_owner: "Operations — NOT pricing",
  },
  move_in_requirements: {
    economic_class: "one_time_fee", amount: null, unresolved: "restates_four_other_facts",
    cadence: "none", applicability: "n/a", required: null, refundable: null,
    verdict: "prose_duplication",
    note: "Restates the application fee, security deposit, amenity fee and telecom fee in prose. " +
          "A SECOND quotable copy of four values it does not own, live today. If any of the four " +
          "changes, this sentence silently disagrees with it. Must reference, never restate.",
    ai_quotes_today: true, canonical_owner: "delete on migration",
  },
  move_in_credits: {
    economic_class: "concession", amount: null, unresolved: "500_500_or_300_by_population",
    cadence: "one_time_per_term",
    applicability: "$500 first responders, $500 military/veterans, $300 Penn Dental/Vet; verification required",
    required: false, refundable: false,
    verdict: "not_safe_to_quote",
    note: "This is a concession filed as trivia: an unversioned, undated, authority-less economic " +
          "promise. It is calendar-dependent, so it CANNOT be published — and it is being quoted " +
          "today anyway, through prose. The gap between what may be published and what is " +
          "actually being said is the single sharpest finding in this report.",
    ai_quotes_today: true, canonical_owner: "Concessions",
  },
};

/**
 * Read every active money-bearing fact and grade it. READ-ONLY, writes nothing.
 */
async function moneyFactContradictions(pool, { property_id } = {}) {
  if (!property_id) throw new Error("moneyFactContradictions requires property_id");

  const rows = (await pool.query(
    `select fact_key, rendered_text, source_type, confirmed_at, effective_until
       from agent_facts
      where property_id=$1 and status='active' and rendered_text ~ '[$][0-9]'
      order by fact_key`, [property_id]
  )).rows;

  const facts = rows.map((r) => {
    const d = DECLARED[r.fact_key];
    if (!d) {
      // Never silently drop an ungraded money fact. A fee added tomorrow must
      // appear here as unreviewed rather than vanish into a passing report.
      return {
        fact_key: r.fact_key, source_type: r.source_type, text: r.rendered_text,
        verdict: "not_safe_to_quote", economic_class: null, amount: null,
        unresolved: "undeclared_money_fact",
        note: "This fact carries money and has not been reviewed. It is quotable today and " +
              "nobody has graded it.",
        ai_quotes_today: true, canonical_owner: null, reviewed: false,
      };
    }
    return { fact_key: r.fact_key, source_type: r.source_type, text: r.rendered_text, reviewed: true, ...d };
  });

  // A declared fact that no longer exists live is also worth knowing.
  const live = new Set(rows.map((r) => r.fact_key));
  const declared_but_absent = Object.keys(DECLARED).filter((k) => !live.has(k));

  const by = (v) => facts.filter((f) => f.verdict === v).length;
  return {
    property_id,
    facts,
    declared_but_absent,
    summary: {
      total: facts.length,
      unreviewed: facts.filter((f) => !f.reviewed).length,
      consistent_and_governed: by("consistent_and_governed"),
      conflicting: by("conflicting"),
      conditional_but_condition_missing: by("conditional_but_condition_missing"),
      prose_duplication: by("prose_duplication"),
      legacy_evidence: by("legacy_evidence"),
      not_safe_to_quote: by("not_safe_to_quote"),
      quoted_today_but_not_safe: facts.filter((f) => f.ai_quotes_today && f.verdict === "not_safe_to_quote").length,
      recurring_charges_with_no_model: facts.filter((f) => f.economic_class === "recurring_charge").length,
    },
    // Stated on the response so a consumer cannot mistake this for a source.
    disposition: "review_only_no_governed_copy_created",
  };
}

module.exports = { moneyFactContradictions, DECLARED, VERDICTS };
