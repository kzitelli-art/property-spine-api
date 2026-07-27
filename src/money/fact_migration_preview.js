// ════════════════════════════════════════════════════════════════════
//  fact_migration_preview.js — 13 MONETARY FACTS → GOVERNED CHARGES
//
//  NO-WRITE. Shows, for every active money fact, exactly where it would land
//  in the governed catalog and whether it is safe to migrate at all.
//
//  Only facts already graded `consistent_and_governed` are marked safe. The
//  rest carry their blocking reason, and the reason is the SAME one the
//  contradiction report gave — the two must never diverge, or an operator
//  could read "safe to migrate" beside "not safe to quote".
//
//  NOTHING IS RETIRED HERE. A live AI fact keeps working until its governed
//  replacement is published AND proven equivalent in shadow.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { moneyFactContradictions } = require("./money_fact_contradictions");
const { checkChargePublishable } = require("./governed_charges");

// Where each fact WOULD land. Hand-authored, because a destination is a
// modelling decision and regex over prose cannot make one.
const DESTINATIONS = {
  pricing_application_fee: {
    charge_code: "fee.application", economic_class: "one_time_fee", cadence: "one_time",
    obligation: "required", incurred_on_event: "application",
    applies_to_new_lease: true, applies_to_renewal: false,
    applicability_basis: "Per applicant on a new-lease application.",
    refundable: false, amount: 50, safe: true,
  },
  pricing_admin_fee: {
    charge_code: "fee.administration", economic_class: "one_time_fee", cadence: "one_time",
    obligation: "required", incurred_on_event: "move_in",
    applies_to_new_lease: true, applies_to_renewal: true,
    applicability_basis: "Per unit, once at move-in and once at renewal.",
    refundable: false, amount: 99, safe: true,
  },
  pricing_amenity_fee: {
    charge_code: "fee.amenity", economic_class: "one_time_fee", cadence: "one_time",
    obligation: "required", incurred_on_event: "move_in",
    applies_to_new_lease: true, applies_to_renewal: true,
    applicability_basis: "Per unit at move-in ($300) and at renewal ($250).",
    refundable: false, amount: null, safe: false,
    blocked_reason: "new_lease_versus_renewal_amount_not_structured",
    blocked_detail: "One fact carries TWO amounts for two populations. The catalog can hold them as " +
      "two rows keyed to different events, but which row a quote uses must be decided, not inferred.",
  },
  pricing_telecom_fee: {
    charge_code: "fee.telecom", economic_class: "one_time_fee", cadence: "one_time",
    obligation: "required", incurred_on_event: "move_in",
    applicability_basis: "At move-in.", refundable: false, amount: null, safe: false,
    blocked_reason: "range_determinant_unknown",
    blocked_detail: "$75–99 with nothing stating what decides the amount. Storable as an " +
      "unresolved charge; never quotable precisely until a determinant is declared.",
  },
  pricing_security_deposit: {
    charge_code: "deposit.security_requirement", economic_class: "deposit_required",
    cadence: "conditional", obligation: "required",
    applicability_basis: "Per lease, subject to approval.", refundable: true, amount: null, safe: false,
    blocked_reason: "underwriting_requirement_not_separated_from_deposit_held",
    blocked_detail: "A conditional band ($1,000 to one month's rent) with no governed approval model. " +
      "It is also underwriting's to own, not pricing's.",
  },
  parking_pricing: {
    charge_code: "recurring.parking", economic_class: "recurring_charge", cadence: "monthly",
    obligation: "optional", applicability_basis: "Optional assigned garage spot, subject to availability.",
    applicability_scope: "elected_option", refundable: false, amount: 300, safe: false,
    blocked_reason: "availability_not_modelled",
    blocked_detail: "The AMOUNT is unambiguous; the availability is not, and the fact says so. " +
      "Quoting $300/month implies a spot exists, and no parking inventory model can check that.",
  },
  pet_policy: {
    charge_code: "recurring.pet_rent", economic_class: "recurring_charge", cadence: "monthly",
    obligation: "conditional", condition_key: "resident_has_pet",
    applicability_basis: "Pet-owning tenancy.", refundable: false, amount: 30, safe: false,
    blocked_reason: "fee_and_rent_not_separated_and_per_pet_unknown",
    blocked_detail: "ONE fact carries a $300 one_time_fee AND $30/month recurring_charge, and does " +
      "not say per-pet or per-tenancy. It must become TWO charges, and the multiplier must be decided.",
    would_split_into: ["fee.pet_onetime ($300, one_time_fee)", "recurring.pet_rent ($30/mo, recurring_charge)"],
  },
  utilities: {
    charge_code: "recurring.wifi", economic_class: "recurring_charge", cadence: "monthly",
    obligation: "optional", applicability_basis: "Building wifi programme (Flume).",
    refundable: false, amount: 40, safe: false,
    blocked_reason: "sibling_utilities_unmetered",
    blocked_detail: "The $40 wifi charge is precise, but the same sentence leaves electric and water " +
      "usage-based with no amount. Migrating only the wifi would understate the real obligation.",
  },
  renters_insurance: {
    charge_code: "recurring.insurance_programme", economic_class: "recurring_charge", cadence: "monthly",
    obligation: "conditional", condition_key: "resident_elects_building_programme",
    applicability_basis: "Only when the resident takes the building programme instead of their own policy.",
    refundable: false, amount: 15, safe: false,
    blocked_reason: "required_versus_optional_contradiction",
    blocked_detail: "Coverage is REQUIRED; the $15 programme is OPTIONAL. Migrating it as required " +
      "would state an optional price as mandatory.",
  },
  unit_transfers: {
    charge_code: "fee.transfer", economic_class: "one_time_fee", cadence: "conditional",
    obligation: "conditional", condition_key: "transfer_direction",
    applies_to_transfer: true, applies_to_new_lease: false,
    applicability_basis: "$750 upgrade, $1,000 same-type/downgrade, $0 upgrading at expiration.",
    refundable: false, amount: null, safe: false,
    blocked_reason: "three_amounts_on_unstructured_conditions",
    blocked_detail: "Resident policy, not a new-lease offer. Three amounts on three conditions.",
  },
  entry_access: {
    charge_code: "fee.access_incidental", economic_class: "one_time_fee", cadence: "conditional",
    obligation: "conditional", condition_key: "incidental_request",
    applicability_basis: "$75 fob, $25 key, $25 after-hours lockout.",
    refundable: false, amount: null, safe: false,
    blocked_reason: "operations_not_pricing",
    blocked_detail: "Incidental operational charges. Real, but not part of an offer.",
  },
  move_in_requirements: {
    charge_code: null, economic_class: null, safe: false,
    blocked_reason: "prose_duplication_owns_nothing",
    blocked_detail: "Restates four fee values it does not own. It gets NO governed destination: on " +
      "cutover it is rewritten to reference the governed charges, or deleted. It must never become " +
      "a charge row, because that would make the duplicate permanent.",
    retirement_action: "rewrite_to_reference_or_delete",
  },
  move_in_credits: {
    charge_code: null, economic_class: "concession", safe: false,
    blocked_reason: "concession_not_a_charge",
    blocked_detail: "$500/$500/$300 by population. A concession belongs to concession_policies and " +
      "needs dated lines, not the charge catalog. Calendar-dependent, so still unpublishable.",
    retirement_action: "migrate_to_concession_policies_after_schedule_engine",
  },
};

async function factMigrationPreview(pool, { property_id } = {}) {
  if (!property_id) throw new Error("factMigrationPreview requires property_id");
  const contradictions = await moneyFactContradictions(pool, { property_id });

  const facts = contradictions.facts.map((f) => {
    const d = DESTINATIONS[f.fact_key] || null;
    const consistent = f.verdict === "consistent_and_governed";
    // The two reports must never diverge: a fact can only be safe to migrate
    // if the contradiction report also called it governed.
    const safe = !!(d && d.safe && consistent);
    const proposed = d && d.charge_code ? {
      charge_code: d.charge_code, economic_class: d.economic_class, cadence: d.cadence,
      obligation: d.obligation, amount: d.amount ?? null,
      amount_unresolved_reason: d.amount == null ? d.blocked_reason : null,
      applicability_basis: d.applicability_basis || null,
      applicability_scope: d.applicability_scope || "property",
      condition_key: d.condition_key || null,
      incurred_on_event: d.incurred_on_event || null,
      applies_to_new_lease: d.applies_to_new_lease !== false,
      applies_to_renewal: !!d.applies_to_renewal,
      applies_to_transfer: !!d.applies_to_transfer,
      refundable: d.refundable ?? null,
      would_split_into: d.would_split_into || null,
    } : null;

    // Run the real publication contract over the proposal, so "safe" is not
    // an opinion — it is the same check publication would apply.
    const contract = proposed
      ? checkChargePublishable({ ...proposed, property_id, effective_from: "2026-01-01" },
          { property_id, actor_may_publish: true })
      : { publishable: false, blockers: [{ code: "no_governed_destination" }] };

    return {
      fact_key: f.fact_key,
      current_source: "agent_facts",
      current_wording: f.text,
      economic_class: (d && d.economic_class) || f.economic_class || null,
      amount: f.amount ?? null,
      cadence: f.cadence || null,
      applicability: (d && d.applicability_basis) || f.applicability || null,
      contradictions: f.verdict === "consistent_and_governed" ? [] : [f.verdict],
      contradiction_detail: f.note,
      proposed_governed_destination: proposed,
      contract_blockers: contract.blockers.map((b) => b.code),
      safe_to_migrate: safe && contract.publishable,
      blocked_reason: safe ? null : ((d && d.blocked_reason) || f.verdict),
      blocked_detail: safe ? null : (d && d.blocked_detail) || null,
      retirement_action: safe
        ? "retire_fact_in_the_SAME_commit_that_publishes_its_governed_row"
        : (d && d.retirement_action) || "leave_live_until_blocker_resolved",
    };
  });

  return {
    property_id,
    disposition: "no_write_migration_preview",
    facts,
    summary: {
      total: facts.length,
      safe_to_migrate: facts.filter((f) => f.safe_to_migrate).length,
      blocked: facts.filter((f) => !f.safe_to_migrate).length,
      no_governed_destination: facts.filter((f) => !f.proposed_governed_destination).length,
    },
    rules: [
      "Only facts graded consistent_and_governed by the contradiction report can be safe.",
      "Every proposal is run through the REAL publication contract, so 'safe' is not an opinion.",
      "No fact is retired here. A live AI fact keeps working until its governed replacement is " +
        "published AND proven equivalent in shadow.",
      "move_in_requirements gets no destination at all — a charge row would make the duplicate permanent.",
    ],
  };
}

module.exports = { factMigrationPreview, DESTINATIONS };
