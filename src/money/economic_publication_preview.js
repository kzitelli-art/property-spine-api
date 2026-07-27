// ════════════════════════════════════════════════════════════════════
//  economic_publication_preview.js — FIVE CLASSES, FIVE LIFECYCLES
//
//  NO-WRITE. Accepts proposals for base pricing, one-time fees, recurring
//  charges, deposit requirements and advertised concessions, and reports what
//  would happen to EACH — independently.
//
//  ── THERE IS NO MASTER PUBLICATION OBJECT ────────────────────────────
//  Deliberately. The five classes are governed on different schedules by
//  different decisions: rent waits on eight owner rulings, the application fee
//  waits on one, recurring charges wait on a model that does not exist. A
//  master object would couple them, so the slowest class would hold the
//  fastest hostage — and publishing "the package" would silently publish
//  things nobody reviewed.
//
//  An incomplete class therefore never blocks a complete one from being
//  reviewed or published.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { effectiveEconomicPicture } = require("./economic_picture");
const { previewPublication } = require("./pricing_publication_preview");
const { checkChargePublishable } = require("./governed_charges");
const { compileSchedule } = require("./concession_schedule_compiler");
const { resolveActorContext } = require("../identity/actor_context");

const CLASSES = ["base_pricing", "one_time_fees", "recurring_charges",
                 "deposit_requirements", "advertised_concessions"];

async function economicPublicationPreview(pool, {
  property_id, user_id = null, proposal = {}, as_of = null,
} = {}) {
  if (!property_id) throw new Error("economicPublicationPreview requires property_id");

  const picture = await effectiveEconomicPicture(pool, { property_id, as_of });
  const actor = user_id ? await resolveActorContext(pool, { user_id, property_id }) : null;
  const may = (v) => !!(actor && actor.capabilities && actor.capabilities[v]);

  const components = {};

  // ── BASE PRICING — its own contract, unchanged ─────────────────
  const pricingProposal = proposal.base_pricing || null;
  const pricingPrev = pricingProposal
    ? await previewPublication(pool, { property_id, proposal: pricingProposal })
    : null;
  components.base_pricing = {
    economic_class: "base_rent",
    proposed: !!pricingProposal,
    draft_completeness: picture.base_rent.completeness,
    review_state: pricingPrev ? (pricingPrev.receipt ? "previewed" : "none") : "no_proposal",
    required_authority: "may_publish_pricing",
    actor_holds_authority: may("may_publish_pricing"),
    missing_decisions: pricingPrev ? pricingPrev.missing_unit_types.map((m) => m.label) : ["all eight type rents"],
    contradictions: [],
    effective_period_overlap: pricingPrev ? pricingPrev.effective_date_overlap : [],
    publishable: pricingPrev ? pricingPrev.would_publish : false,
    blockers: pricingPrev ? pricingPrev.blockers.map((b) => b.code) : ["no_proposal_supplied"],
    ai_quote_preview: pricingPrev ? pricingPrev.quote_preview : [],
    legacy_retirement_required: [],
    before_after_ownership: { before: "units.market_rent (unproven legacy)", after: "property_pricing_versions" },
  };

  // ── ONE-TIME FEES — each row independently ─────────────────────
  const feeRows = [...(picture.one_time_fees.drafts || []),
                   ...(proposal.one_time_fees || [])];
  components.one_time_fees = {
    economic_class: "one_time_fee",
    proposed: feeRows.length,
    draft_completeness: picture.one_time_fees.completeness,
    review_state: feeRows.length ? "drafts_awaiting_ownership_approval" : "none",
    required_authority: "may_publish_pricing",
    actor_holds_authority: may("may_publish_pricing"),
    rows: feeRows.map((c) => {
      const check = checkChargePublishable({ ...c, property_id, amount: c.amount,
        applies_to_new_lease: (c.applies_to || []).includes("new_lease"),
        applies_to_renewal: (c.applies_to || []).includes("renewal"),
        applies_to_transfer: (c.applies_to || []).includes("transfer") },
        { property_id, actor_may_publish: may("may_publish_pricing") });
      return {
        charge_code: c.charge_code, amount: c.amount, record_state: c.record_state,
        publishable: check.publishable, blockers: check.blockers.map((b) => b.code),
        legacy_retirement_required: c.source_provenance && /migration_candidate_from:/.test(c.source_provenance)
          ? c.source_provenance.split("migration_candidate_from:")[1] : null,
        ownership_approval_required: true,
        note: "A draft cannot publish on a preview. Ownership must approve the amount and basis first.",
      };
    }),
    missing_decisions: ["explicit ownership approval of $50 and $99"],
    publishable: false,
    blockers: ["ownership_approval_not_given"],
    before_after_ownership: { before: "agent_facts prose", after: "property_governed_charges" },
  };

  // ── RECURRING CHARGES ──────────────────────────────────────────
  components.recurring_charges = {
    economic_class: "recurring_charge",
    proposed: (proposal.recurring_charges || []).length,
    draft_completeness: picture.recurring_charges.completeness,
    review_state: "blocked",
    required_authority: "may_publish_pricing",
    actor_holds_authority: may("may_publish_pricing"),
    missing_decisions: ["parking optionality/inventory", "pet fee-vs-rent split and multiplier",
                        "wifi required/optional", "insurance conditionality"],
    contradictions: picture.contradictions.filter((c) =>
      ["parking_pricing", "pet_policy", "utilities", "renters_insurance"].includes(c.fact_key)),
    publishable: false,
    blockers: ["recurring_charge_model_not_built", "four_unresolved_determinants"],
    before_after_ownership: { before: "agent_facts prose", after: "property_governed_charges (recurring)" },
  };

  // ── DEPOSIT REQUIREMENTS ───────────────────────────────────────
  components.deposit_requirements = {
    economic_class: "deposit_required",
    proposed: (proposal.deposit_requirements || []).length,
    draft_completeness: picture.deposit_requirements.completeness,
    review_state: "blocked",
    required_authority: "may_publish_pricing (display) + underwriting owner (decision)",
    actor_holds_authority: may("may_publish_pricing"),
    missing_decisions: ["fixed amount, formula or underwriting band", "the determinant", "the owner"],
    publishable: false,
    blockers: ["underwriting_requirement_not_separated_from_deposit_held"],
    creates_deposit_held: false,
    creates_deposit_held_note:
      "Publishing a deposit REQUIREMENT creates no deposit_held row. deposit_held is money actually " +
      "received and lives on the lease; the catalog cannot represent it at all.",
    before_after_ownership: { before: "agent_facts prose", after: "underwriting (not pricing)" },
  };

  // ── ADVERTISED CONCESSIONS ─────────────────────────────────────
  const concRows = (proposal.advertised_concessions || []).map((c) => {
    const compiled = compileSchedule(c);
    return {
      timing_profile: c.timing_profile,
      compiles: compiled.ok,
      dated_lines: compiled.ok ? compiled.lines.length : 0,
      total_credit: compiled.ok ? compiled.total_credit : null,
      effective_rent: compiled.ok ? compiled.effective_rent : null,
      refusal: compiled.ok ? null : compiled.code,
      publishable: false,
      blocker: compiled.ok ? "no_concession_authority_exercised" : compiled.code,
    };
  });
  components.advertised_concessions = {
    economic_class: "concession",
    proposed: concRows.length,
    draft_completeness: picture.advertised_concessions.completeness,
    review_state: concRows.length ? "compiled_for_review" : "none",
    required_authority: "may_publish_pricing + may_manage_concession_authority",
    actor_holds_authority: may("may_publish_pricing") && may("may_manage_concession_authority"),
    rows: concRows,
    missing_decisions: ["a declared proration basis for any calendar-dependent profile"],
    publishable: false,
    blockers: concRows.some((r) => !r.compiles)
      ? ["profile_produces_no_reproducible_dated_lines"] : ["no_concession_approved"],
    requires_reproducible_dated_lines: true,
    before_after_ownership: { before: "agent_facts prose (move_in_credits)", after: "concession_policies" },
  };

  // ── THE INDEPENDENCE PROOFS ────────────────────────────────────
  const independence = {
    rent_publishes_without_fees:
      "components.base_pricing carries its own blockers and its own authority check; nothing in it " +
      "references the fee rows.",
    fee_publishes_without_rent:
      "components.one_time_fees is evaluated per row against checkChargePublishable, which never " +
      "reads a pricing version.",
    recurring_cannot_alter_base_rent:
      "base_rent lives in pricing_terms; the charge catalog forbids the class outright.",
    deposit_required_cannot_create_deposit_held:
      "deposit_held has no catalog row and no code path here.",
    fee_publication_cannot_activate_a_waiver:
      "a waiver is a concession_policies row compiled by the schedule compiler; publishing a fee " +
      "writes nothing there and the compiler still refuses a waiver over an unresolved fee.",
    concession_needs_reproducible_lines:
      "every concession row above reports compiles/dated_lines; a profile that cannot produce lines " +
      "carries a refusal code and is unpublishable.",
    incomplete_class_does_not_block_a_complete_one:
      "each component reports its own publishable/blockers; there is no aggregate gate.",
    ai_stays_on_current_sources:
      "this preview writes nothing and the adapter reads only published rows, so the live path is " +
      "unchanged until an explicit cutover.",
  };

  return {
    property_id, as_of: picture.as_of,
    disposition: "no_write_multi_class_publication_preview",
    master_publication_object: null,
    master_note: "There is no master publication object, by design. Coupling five independently " +
      "governed classes would let the slowest hold the fastest hostage, and publishing 'the " +
      "package' would silently publish things nobody reviewed.",
    actor: actor && actor.ok
      ? { acting_person: actor.person.display_name, capabilities: actor.capabilities }
      : { acting_person: null, denied: actor ? actor.failure_reason : "no_user_supplied" },
    components,
    independently_publishable_today: CLASSES.filter((k) => components[k] && components[k].publishable),
    independence,
    writes_nothing: true,
  };
}

module.exports = { economicPublicationPreview, CLASSES };
