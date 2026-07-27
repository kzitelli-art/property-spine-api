// ════════════════════════════════════════════════════════════════════
//  economic_decision_room.js — THE RULINGS, AND THE PATH AFTER EACH
//
//  One decision card per unresolved economic question, plus an atomic cutover
//  plan for all 13 monetary facts.
//
//  ── IT PRESELECTS NOTHING ────────────────────────────────────────────
//  Every `ownership_decision` is null. Options carry their consequence so the
//  choice is informed, never made. A card that arrives with an option already
//  ticked turns review into "spot the wrong one".
//
//  ── A DECISION CARD CANNOT MUTATE ANYTHING ───────────────────────────
//  This module is READ-ONLY. It composes the contradiction report, the
//  migration preview and the shadow findings; it holds no write path to
//  pricing_terms, property_governed_charges or agent_facts.
//
//  ── THE CUTOVER RULE THAT MATTERS ────────────────────────────────────
//  Retirement of the legacy source lands in the SAME release as the adapter
//  switch. Any other ordering produces one of the two states that must never
//  exist: two independently quotable owners, or a silent gap where neither
//  answers and the AI improvises.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { moneyFactContradictions } = require("./money_fact_contradictions");
const { factMigrationPreview } = require("./fact_migration_preview");
const { economicShadowReport } = require("./economic_shadow");

const nullDecision = () => ({ value: null, decided: false, decided_by: null, decided_at: null });

// Hand-authored because a ruling's options and consequences are modelling
// judgments, not something derivable from prose.
const CARDS = {
  application_fee: {
    fact_key: "pricing_application_fee", economic_class: "one_time_fee",
    question: "Approve the persisted draft: $50, one-time, required, per applicant, new-lease application.",
    proposal: { amount: 50, cadence: "one_time", obligation: "required",
                basis: "per applicant", applies_to: ["new_lease"] },
    contradiction: null,
    canonical_owner: "Pricing & Concessions (governed charge fee.application)",
    options: [
      { ruling: "approve_as_proposed", consequence: "fee.application publishes; pricing_application_fee retires in the same release; the AI quotes $50 from the governed row." },
      { ruling: "modify_amount_or_basis", consequence: "The draft is superseded by a new draft and re-reviewed. Nothing publishes until the replacement is approved." },
      { ruling: "reject", consequence: "The draft is retired; agent_facts remains the permanent owner and the AI keeps quoting prose." },
    ],
  },
  administration_fee: {
    fact_key: "pricing_admin_fee", economic_class: "one_time_fee",
    question: "Approve the persisted draft: $99, one-time, required, per unit, new lease AND renewal.",
    proposal: { amount: 99, cadence: "one_time", obligation: "required",
                basis: "per unit", applies_to: ["new_lease", "renewal"] },
    contradiction: "RENEWAL APPLICABILITY NEEDS EXPLICIT CONFIRMATION. The prose says 'once at " +
      "move-in and at renewal'. If that is two separate $99 assessments, a renewing resident pays " +
      "it again — which is a materially different offer from a one-off.",
    canonical_owner: "Pricing & Concessions (governed charge fee.administration)",
    options: [
      { ruling: "approve_both_events", consequence: "$99 is assessed at move-in AND at each renewal." },
      { ruling: "approve_new_lease_only", consequence: "$99 at move-in only; the renewal clause is dropped and the prose fact must be corrected." },
      { ruling: "split_into_two_charges", consequence: "Two governed rows with distinct codes and possibly distinct amounts." },
      { ruling: "reject", consequence: "agent_facts remains the owner." },
    ],
  },
  telecom: {
    fact_key: "pricing_telecom_fee", economic_class: "one_time_fee",
    question: "What decides whether the telecom charge is $75 or $99?",
    contradiction: "A $24 range with NO stated determinant. Nothing in the fact, the schema or the " +
      "unit record says what varies.",
    canonical_owner: "Pricing & Concessions, once the determinant is declared",
    options: [
      { ruling: "single_amount", consequence: "One governed one_time_fee; precisely quotable immediately." },
      { ruling: "varies_by_package", consequence: "Needs a package dimension the model does not have; blocked until built." },
      { ruling: "varies_by_unit_or_type", consequence: "Becomes a unit_type-scoped charge; representable today." },
      { ruling: "varies_by_provider_or_lease_date", consequence: "Needs a determinant field; blocked until built." },
      { ruling: "office_quoted", consequence: "Stored as unresolved with an explicit reason; the AI hands off rather than quoting." },
    ],
    also_resolve: ["Is it one-time or recurring? The prose says 'due at move-in', implying one-time."],
    behaviour_until_resolved: "No precise governed quote. The legacy prose remains live and the " +
      "governed row would store an explicit unresolved reason.",
  },
  amenity_fee: {
    fact_key: "pricing_amenity_fee", economic_class: "one_time_fee",
    question: "Confirm $300 at move-in and $250 at renewal as two structured rows.",
    contradiction: "One fact carries TWO amounts for two populations, unstructured. A consumer must " +
      "parse prose to know which applies.",
    canonical_owner: "Pricing & Concessions",
    options: [
      { ruling: "two_rows_300_new_250_renewal", consequence: "Both precisely quotable, each keyed to its event." },
      { ruling: "single_amount", consequence: "One row; the renewal clause is dropped and the prose corrected." },
      { ruling: "different_amounts", consequence: "New draft, re-reviewed." },
    ],
    also_resolve: ["Per unit or per resident?", "Assessed at signing or at move-in?",
                   "Refundable?", "Who may waive it?"],
  },
  pet_economics: {
    fact_key: "pet_policy", economic_class: "one_time_fee + recurring_charge",
    question: "Split the pet economics into a one-time fee and a monthly rent, and state the multiplier.",
    contradiction: "ONE fact carries a $300 one_time_fee AND $30/month recurring_charge, and does " +
      "not say per-pet or per-tenancy. A two-pet household has no determinable answer today.",
    canonical_owner: "fee.pet_onetime → Pricing; recurring.pet_rent → Recurring charges (not built)",
    options: [
      { ruling: "per_tenancy_flat", consequence: "$300 + $30/mo regardless of pet count; both representable, the recurring one still blocked on the recurring model." },
      { ruling: "per_pet", consequence: "Needs a pet-count dimension; blocked until built." },
      { ruling: "per_pet_with_maximum", consequence: "Needs pet count AND a cap; blocked until built." },
    ],
    also_resolve: ["Maximum pets?", "Required documentation?", "Breed or weight exceptions?",
                   "Who may waive the fee?"],
  },
  parking: {
    fact_key: "parking_pricing", economic_class: "recurring_charge",
    question: "Is $300/month parking optional, and can every resident buy it?",
    contradiction: "The AMOUNT is unambiguous; AVAILABILITY is not, and the fact says so. Quoting " +
      "$300/month implies a spot exists, and no parking inventory model can check that.",
    canonical_owner: "Recurring charges — MODEL DOES NOT EXIST",
    options: [
      { ruling: "optional_subject_to_availability", consequence: "Quotable only with the availability caveat; a precise 'yes you can have one' still needs inventory." },
      { ruling: "optional_unlimited", consequence: "Precisely quotable once the recurring model exists." },
      { ruling: "required_for_some_units", consequence: "Needs a unit-scoped conditional charge; representable, but the condition must be declared." },
    ],
    also_resolve: ["Per vehicle or per space?", "Effective period?"],
  },
  wifi: {
    fact_key: "utilities", economic_class: "recurring_charge",
    question: "Is the $40/month wifi required, optional, or property-provided?",
    contradiction: "The $40 is precise, but the same sentence leaves electric and water usage-based " +
      "with no amount. Quoting $40 alone understates the real monthly obligation.",
    canonical_owner: "Recurring charges — MODEL DOES NOT EXIST",
    options: [
      { ruling: "required_property_provided", consequence: "A required recurring charge on every tenancy." },
      { ruling: "optional_service", consequence: "Optional; must never appear inside a universal monthly figure." },
      { ruling: "bundled_in_rent", consequence: "Not a separate charge at all; the prose is corrected." },
    ],
    also_resolve: ["Should electric and water be separated from this fact entirely?"],
  },
  insurance: {
    fact_key: "renters_insurance", economic_class: "recurring_charge",
    question: "Insurance is required — is the $15/month programme required, conditional, or optional?",
    contradiction: "Coverage is REQUIRED; the $15 programme is NOT — it applies only if the resident " +
      "declines to bring their own policy. Quoting $15 as the cost of a required item states an " +
      "optional price as mandatory.",
    canonical_owner: "Recurring charges — MODEL DOES NOT EXIST",
    options: [
      { ruling: "conditional_on_declining_own_policy", consequence: "A conditional recurring charge with condition_key = resident_elects_building_programme. The AI states the condition every time." },
      { ruling: "required_for_all", consequence: "Contradicts 'residents may bring their own policy'; the prose must change too." },
      { ruling: "optional_service", consequence: "Optional; excluded from any monthly figure." },
    ],
  },
  security_deposit: {
    fact_key: "pricing_security_deposit", economic_class: "deposit_required",
    question: "Is the deposit a fixed amount, a formula, or an underwriting band — and who owns it?",
    contradiction: "$1,000 up to one month's rent, 'subject to approval conditions', with no governed " +
      "approval model. The amount is unknowable at quote time, and a requirement is underwriting's, " +
      "not pricing's.",
    canonical_owner: "Risk / underwriting — NOT pricing",
    options: [
      { ruling: "fixed_amount", consequence: "Precisely quotable as a deposit_required row." },
      { ruling: "formula_on_rent", consequence: "Representable once the formula and its determinant are declared." },
      { ruling: "underwriting_band", consequence: "Stays unresolved for quoting; the AI hands off. This is the honest status quo." },
    ],
    also_resolve: ["Confirm it stays SEPARATE from deposit_held, which is money actually received."],
  },
  move_in_requirements: {
    fact_key: "move_in_requirements", economic_class: null,
    question: "Approve rewriting this to describe the process without restating dollar amounts.",
    contradiction: "It restates the application fee, security deposit, amenity fee and telecom fee in " +
      "prose. FOUR duplicated monetary statements it does not own. If any of the four changes, this " +
      "sentence silently disagrees.",
    duplicated_values: ["application fee", "security deposit", "amenity fee", "telecom fee"],
    canonical_owner: "Leasing process prose — owns NO monetary value",
    options: [
      { ruling: "rewrite_without_amounts", consequence: "It describes the $0-balance requirement and the document list; amounts come from their governed owners." },
      { ruling: "delete", consequence: "The process description is lost; the other facts remain." },
      { ruling: "keep_as_is", consequence: "The duplication becomes permanent and will drift." },
    ],
  },
  move_in_credits: {
    fact_key: "move_in_credits", economic_class: "concession",
    question: "Is this an advertised concession or an actual transaction credit — and on what authority?",
    contradiction: "An unversioned, undated, authority-less economic promise being quoted today from " +
      "prose. Calendar-dependent, so it cannot be published as a concession until a proration basis " +
      "is declared.",
    canonical_owner: "Concessions (concession_policies) or Money (posted credit)",
    options: [
      { ruling: "advertised_concession", consequence: "Needs a timing profile and proration basis; publishable once declared." },
      { ruling: "posted_transaction_credit", consequence: "Not advertised at all; applied after execution by Money. The AI stops mentioning it." },
      { ruling: "discontinue", consequence: "The fact retires; the AI stops offering it." },
    ],
    also_resolve: ["Amount per population ($500/$500/$300)?", "Qualifying action and verification?",
                   "Effective dates?", "Who authorises it?"],
  },
};

const GROUPS = {
  ready_after_ownership_approval: ["pricing_application_fee", "pricing_admin_fee"],
  blocked_by_missing_determinant: ["pricing_telecom_fee", "pricing_amenity_fee", "unit_transfers", "entry_access"],
  blocked_by_missing_model: ["parking_pricing", "pet_policy", "utilities", "renters_insurance"],
  blocked_by_concession_authority: ["move_in_credits"],
  blocked_by_underwriting_decision: ["pricing_security_deposit"],
  prose_only_no_monetary_owner: ["move_in_requirements"],
};

function cutoverPlan(fact, card, migRow) {
  const group = Object.keys(GROUPS).find((g) => GROUPS[g].includes(fact.fact_key)) || "unclassified";
  const ready = group === "ready_after_ownership_approval";
  return {
    fact_key: fact.fact_key,
    group,
    current_live_source: "agent_facts",
    governed_replacement: migRow && migRow.proposed_governed_destination
      ? migRow.proposed_governed_destination.charge_code : null,
    ownership_ruling_required: card ? card.question : "no ruling drafted",
    publication_receipt: ready
      ? "publishCharge receipt naming session_user_id, acting_person_id and authority_basis"
      : "not reachable until the ruling lands",
    shadow_acceptance_criteria: ready
      ? "zero dollar, cadence, applicability and required-vs-optional disagreement on this fact"
      : "not applicable yet",
    adapter_change: ready
      ? "the economic adapter reads the governed charge for this code instead of the fact"
      : "none",
    legacy_retirement: ready
      ? `set agent_facts.${fact.fact_key} status='retired' IN THE SAME RELEASE as the adapter switch`
      : "none — the fact stays live",
    rollback_trigger: ready
      ? "any shadow disagreement after publication, or a governed read failure — revert the adapter " +
        "and reinstate the fact together, never separately"
      : "n/a",
    post_cutover_invariant: ready
      ? "exactly ONE quotable owner for this value, proven by the duplicate-ownership check reading zero"
      : "the fact remains the sole owner",
  };
}

async function economicDecisionRoom(pool, { property_id, include_shadow = true } = {}) {
  if (!property_id) throw new Error("economicDecisionRoom requires property_id");

  const [money, mig, shadow] = await Promise.all([
    moneyFactContradictions(pool, { property_id }),
    factMigrationPreview(pool, { property_id }),
    include_shadow ? economicShadowReport(pool, { property_id }) : Promise.resolve(null),
  ]);
  const migByKey = new Map(mig.facts.map((f) => [f.fact_key, f]));
  const factByKey = new Map(money.facts.map((f) => [f.fact_key, f]));

  // Shadow findings, attached to the fact they concern — so a ruling is read
  // beside its product consequence rather than in the abstract.
  const shadowByFact = new Map();
  if (shadow) {
    for (const c of shadow.comparisons) {
      const key = Object.entries({
        application_fee: "pricing_application_fee", administration_fee: "pricing_admin_fee",
        amenity_fee: "pricing_amenity_fee", telecom_charge: "pricing_telecom_fee",
        parking: "parking_pricing", pet_fee_and_rent: "pet_policy", wifi: "utilities",
        insurance: "renters_insurance", deposit_requirement: "pricing_security_deposit",
        move_in_requirements: "move_in_requirements", move_in_credits: "move_in_credits",
      }).find(([s]) => c.scenario === s);
      if (key) shadowByFact.set(key[1], c);
    }
  }

  const cards = Object.entries(CARDS).map(([id, card]) => {
    const f = factByKey.get(card.fact_key) || {};
    const sh = shadowByFact.get(card.fact_key) || null;
    return {
      card_id: id,
      fact_key: card.fact_key,
      current_claim: f.text || null,
      source: "agent_facts",
      economic_class: card.economic_class,
      contradiction: card.contradiction,
      question: card.question,
      proposal: card.proposal || null,
      also_resolve: card.also_resolve || [],
      duplicated_values: card.duplicated_values || null,
      behaviour_until_resolved: card.behaviour_until_resolved || null,

      // ── the product consequence, from the shadow report ──
      affected_live_ai_answer: sh ? {
        what_the_ai_says_today: sh.current_says,
        why_unsafe: sh.cannot_survive_cutover_because,
        unsupported_precision: sh.unsupported_precision,
        what_the_governed_adapter_would_say_today: sh.governed_answer != null
          ? `$${sh.governed_answer}` : "It would hand off — no governed value exists yet.",
        what_a_ruling_would_unlock: card.options && card.options[0]
          ? card.options[0].consequence : null,
      } : null,
      affected_operating_surfaces: ["Economic Terms surface", "dark economic adapter",
                                    "Future Rent Roll economic preview"],

      available_rulings: card.options || [],
      recommended_canonical_owner: card.canonical_owner,
      ownership_decision: nullDecision(),
    };
  });

  const plans = money.facts.map((f) =>
    cutoverPlan(f, Object.values(CARDS).find((c) => c.fact_key === f.fact_key) || null,
                migByKey.get(f.fact_key)));

  return {
    property_id,
    disposition: "read_only_decision_room_no_governed_term_mutated",
    cards,
    cutover_plans: plans,
    cutover_groups: Object.fromEntries(Object.entries(GROUPS).map(([g, keys]) =>
      [g, plans.filter((p) => keys.includes(p.fact_key)).map((p) => p.fact_key)])),
    cutover_sequence: [
      "governed term approved by ownership",
      "term published with an authority receipt",
      "shadow comparison passes with zero disagreement",
      "live adapter switches to the governed source",
      "legacy fact retires IN THE SAME RELEASE",
      "one-source invariant passes (duplicate-ownership check reads zero)",
    ],
    cutover_rule: "Retirement lands in the SAME release as the adapter switch. Any other ordering " +
      "produces two independently quotable owners, or a silent gap where neither answers.",
    shadow_summary: shadow ? shadow.summary : null,
    rules: [
      "No ruling is preselected. Every ownership_decision is null.",
      "A decision card holds no write path to pricing, charges or facts.",
      "The two draft fee rows remain non-operational until ownership approves them.",
    ],
  };
}

module.exports = { economicDecisionRoom, CARDS, GROUPS, cutoverPlan };
