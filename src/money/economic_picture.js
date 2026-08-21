// ════════════════════════════════════════════════════════════════════
//  economic_picture.js — ONE COMPOSITION, NOT A NEW SOURCE
//
//  Composes published base pricing, renewal pricing, one-time fees, recurring
//  charges, deposit requirements, advertised concessions and the transitional
//  legacy facts that are still live.
//
//  ── IT COPIES NOTHING ────────────────────────────────────────────────
//  There is deliberately no "master economic version". Each component keeps
//  its own governed source, its own effective dates and its own authority
//  receipt, because they are published independently and on different days.
//  A master version would freeze a snapshot that the underlying rows then
//  drift away from — and the snapshot would look authoritative while being
//  stale.
//
//  ── A TOTAL IS THE EXCEPTION, NOT THE OUTPUT ─────────────────────────
//  A combined figure is returned ONLY when every included component is
//  governed, its cadence known, its applicability resolved, its
//  required-vs-optional status preserved, and a component breakdown is
//  supplied alongside it. Otherwise the parts are returned and the total is
//  withheld with the exact reason. A partial picture is useful; a fabricated
//  total is not.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { effectivePropertyPricing } = require("./effective_pricing");
const { governedCharges } = require("./governed_charges");
const { moneyFactContradictions } = require("./money_fact_contradictions");

const COMPLETENESS = ["governed", "partial", "unresolved", "unavailable", "not_applicable"];

function componentState(c) {
  if (c.unavailable) return "unavailable";
  if (c.amount == null && c.unresolved_reason) return "unresolved";
  if (c.amount == null) return "unresolved";
  return "governed";
}

function typePricingProjection(type) {
  const term_economics = (type.terms || []).map((term) => ({
    lease_term_months: term.lease_term_months,
    new_lease_rent: term.new_lease_rent,
    renewal_rent: term.renewal_rent,
    immediate_move_in_rent: term.immediate_move_in_rent,
  }));
  const selected = term_economics.length === 1 ? term_economics[0] : null;
  const term_selection = term_economics.length > 1 ? "required"
    : term_economics.length === 1 ? "not_required" : "unavailable";

  return {
    unit_type_id: type.unit_type_id,
    code: type.code,
    label: type.label,
    offer_state: type.offer_state,
    new_lease_rent: selected ? selected.new_lease_rent : null,
    renewal_rent: selected ? selected.renewal_rent : null,
    terms: term_economics.map((term) => term.lease_term_months),
    term_economics,
    term_selection,
    unresolved_reason: term_economics.length > 1 ? "lease_term_not_selected"
      : term_economics.length === 0 ? "no_offered_term" : null,
    marketable_positions: type.marketable_positions,
    quotable: !!(selected && selected.new_lease_rent != null),
  };
}

async function effectiveEconomicPicture(pool, {
  property_id, as_of = null, unit_type_id = null, space_id = null, event_context = null,
} = {}) {
  if (!property_id) throw new Error("effectiveEconomicPicture requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  // Each source is read INDEPENDENTLY and a failure in one never voids
  // another — the classes are separately governed, so they fail separately.
  const read = async (fn) => { try { return { ok: true, value: await fn() }; }
                               catch (e) { return { ok: false, error: e.message }; } };
  const [pricingR, chargesR, factsR] = await Promise.all([
    read(() => effectivePropertyPricing(pool, { property_id, as_of: asOf })),
    read(() => governedCharges(pool, { property_id, as_of: asOf, include_drafts: true })),
    read(() => moneyFactContradictions(pool, { property_id })),
  ]);

  const pricing = pricingR.ok ? pricingR.value : null;
  const charges = chargesR.ok ? chargesR.value : null;
  const facts = factsR.ok ? factsR.value : null;

  // ── BASE RENT + RENEWAL ───────────────────────────────────────────
  const typeRows = pricing ? pricing.unit_types.filter((t) =>
    !unit_type_id || String(t.unit_type_id) === String(unit_type_id)) : [];
  const base_rent = {
    economic_class: "base_rent",
    source: "property_pricing_versions",
    published_version: pricing ? pricing.published_version : null,
    effective_from: pricing && pricing.published_version ? pricing.published_version.effective_from : null,
    authority_receipt: pricing && pricing.published_version
      ? { published_by: pricing.published_version.published_by,
          basis: pricing.published_version.authority_basis } : null,
    unavailable: !pricingR.ok,
    unresolved_reason: !pricingR.ok ? "economic_read_failed"
      : pricing.published_version ? null : "no_published_pricing_version",
    types: typeRows.map(typePricingProjection),
    completeness: !pricingR.ok ? "unavailable"
      : pricing.published_version ? (pricing.completeness.complete ? "governed" : "partial")
      : "unresolved",
  };

  // ── CHARGE CLASSES ────────────────────────────────────────────────
  const chargeBlock = (list, cls) => ({
    economic_class: cls,
    source: "property_governed_charges",
    unavailable: !chargesR.ok,
    unresolved_reason: !chargesR.ok ? "economic_read_failed"
      : (list || []).length === 0 ? "no_governed_charge_published_in_this_class" : null,
    // Drafts are carried SEPARATELY and never counted as governed, so a
    // surface can show them without a consumer mistaking them for live.
    published: (list || []).filter((c) => c.record_state === "active"),
    drafts: (list || []).filter((c) => c.record_state === "draft"),
    completeness: !chargesR.ok ? "unavailable"
      : !(list || []).some((c) => c.record_state === "active") ? "unresolved"
      : (list || []).filter((c) => c.record_state === "active").every((c) => c.quotable_precisely)
        ? "governed" : "partial",
  });

  const one_time_fees = chargeBlock(charges && charges.one_time_fees, "one_time_fee");
  const recurring_charges = chargeBlock(charges && charges.recurring_charges, "recurring_charge");
  const deposit_requirements = chargeBlock(charges && charges.deposit_requirements, "deposit_required");

  // ── CONCESSIONS ───────────────────────────────────────────────────
  const advertised_concessions = {
    economic_class: "concession",
    source: "concession_policies",
    unavailable: !pricingR.ok,
    advertised: pricing ? (pricing.concessions.advertised || []) : [],
    unresolved_reason: !pricingR.ok ? "economic_read_failed"
      : (pricing.concessions.concessions_unavailable || null),
    completeness: !pricingR.ok ? "unavailable"
      : (pricing.concessions.advertised || []).length ? "governed" : "unresolved",
  };

  // ── TRANSITIONAL LEGACY FACTS still live ──────────────────────────
  const legacy = {
    source: "agent_facts",
    ownership: "transitional_external",
    still_live: true,
    note: "These remain the ONLY live quotable source until each is retired in the same release " +
          "that publishes its governed replacement.",
    facts: facts ? facts.facts.map((f) => ({
      fact_key: f.fact_key, economic_class: f.economic_class, amount: f.amount,
      cadence: f.cadence, verdict: f.verdict, unresolved: f.unresolved || null,
      quotable_by_ai_today: f.ai_quotes_today,
    })) : [],
    unavailable: !factsR.ok,
  };

  const contradictions = facts
    ? facts.facts.filter((f) => f.verdict !== "consistent_and_governed")
        .map((f) => ({ fact_key: f.fact_key, verdict: f.verdict, detail: f.note,
                       missing_determinant: f.unresolved || null }))
    : [];
  const missing_determinants = contradictions
    .filter((c) => c.missing_determinant).map((c) => ({ fact_key: c.fact_key, missing: c.missing_determinant }));

  // ── TOTALS: the exception, with a breakdown or nothing ────────────
  const monthlyComponents = [];
  const selectedType = base_rent.types.length === 1 ? base_rent.types[0] : null;
  if (base_rent.completeness === "governed" && selectedType && selectedType.quotable) {
    monthlyComponents.push({ code: "rent.base", amount: selectedType.new_lease_rent,
                             obligation: "required",
                             lease_term_months: selectedType.terms[0] });
  }
  for (const c of recurring_charges.published) {
    if (c.obligation === "required" && c.quotable_precisely)
      monthlyComponents.push({ code: c.charge_code, amount: c.amount, obligation: "required" });
  }
  const monthlyBlockers = [];
  if (base_rent.completeness !== "governed") monthlyBlockers.push(`base_rent:${base_rent.completeness}`);
  if (typeRows.length !== 1) monthlyBlockers.push("base_rent:unit_type_not_selected");
  else if (selectedType && selectedType.term_selection === "required")
    monthlyBlockers.push("base_rent:lease_term_not_selected");
  else if (selectedType && !selectedType.quotable)
    monthlyBlockers.push("base_rent:not_quotable");
  if (recurring_charges.completeness !== "governed")
    monthlyBlockers.push(`recurring_charge:${recurring_charges.completeness}`);
  for (const c of recurring_charges.published)
    if (c.obligation !== "required") monthlyBlockers.push(`${c.charge_code}:${c.obligation}_not_assumed`);

  const combined_monthly_total = monthlyBlockers.length === 0 && monthlyComponents.length > 0
    ? { amount: Math.round(monthlyComponents.reduce((s, c) => s + Number(c.amount), 0) * 100) / 100,
        breakdown: monthlyComponents,
        rule: "Every component is governed, required, cadence-known and disclosed above." }
    : { amount: null, withheld: true, withheld_because: monthlyBlockers,
        rule: "A combined monthly figure requires EVERY component governed, cadence known, " +
              "applicability resolved, required-vs-optional preserved, and a breakdown supplied. " +
              "Otherwise the parts stand alone." };

  const combined_move_in_total = { amount: null, withheld: true,
    withheld_because: [`one_time_fee:${one_time_fees.completeness}`,
                       `deposit_required:${deposit_requirements.completeness}`],
    rule: "A move-in total mixes fees, deposits and first rent. Deposits stay SEPARATELY " +
          "identified inside it, never folded into a single number." };

  const blocks = { base_rent, one_time_fees, recurring_charges, deposit_requirements, advertised_concessions };
  const states = Object.values(blocks).map((b) => b.completeness);
  return {
    property_id, as_of: asOf, unit_type_id, space_id, event_context,
    disposition: "composition_read_no_new_source_of_truth",

    base_rent, one_time_fees, recurring_charges, deposit_requirements, advertised_concessions,
    legacy_transitional: legacy,
    contradictions, missing_determinants,

    combined_monthly_total, combined_move_in_total,

    completeness: {
      by_class: Object.fromEntries(Object.entries(blocks).map(([k, v]) => [k, v.completeness])),
      overall: states.every((s) => s === "governed") ? "governed"
        : states.some((s) => s === "unavailable") ? "partial_with_unavailable"
        : states.some((s) => s === "governed") ? "partial" : "unresolved",
      independently_governed: true,
      note: "Each class is published on its own schedule with its own authority. This read composes " +
            "them; it does not version them together.",
    },

    proof: {
      copies_nothing: true,
      never_reads: ["units.market_rent", "window.__pricingStore", "rent_survey_observations"],
      classes_preserved: ["base_rent", "one_time_fee", "recurring_charge",
                          "deposit_required", "concession"],
    },
  };
}

module.exports = { effectiveEconomicPicture, typePricingProjection, COMPLETENESS, componentState };
