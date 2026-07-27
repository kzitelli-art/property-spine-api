// ════════════════════════════════════════════════════════════════════
//  economic_adapter.js — THE DARK ECONOMIC ANSWER
//
//  Extends the pricing adapter to every economic class WITHOUT collapsing
//  them. Nothing calls it. It sends nothing and writes nothing.
//
//  ── IT NEVER MANUFACTURES ONE NUMBER ─────────────────────────────────
//  There is no "move-in cost" and no "monthly cost" unless EVERY component
//  is governed, applicable and separately disclosed. A single total is where
//  a $30/month pet rent quietly becomes a $30 one-time line, an optional
//  parking space becomes mandatory, and a refundable deposit becomes income.
//  The classes stay separate all the way to the sentence.
//
//  ── PARTIAL IS AN ANSWER ─────────────────────────────────────────────
//  A missing class does not void the others. If rent is governed and the
//  recurring charges are not, the adapter quotes the rent and says the
//  recurring portion is not yet available. Refusing everything because one
//  independent class is missing would be its own dishonesty — it implies
//  nothing is known when something is.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { effectivePropertyPricing } = require("../money/effective_pricing");
const { governedCharges } = require("../money/governed_charges");
const { quotablePricing } = require("./pricing_adapter");

const STATES = ["known_and_quotable", "known_but_conditional", "known_but_optional",
                "known_but_not_yet_quotable", "unresolved", "not_applicable", "unavailable"];

/** One component of an economic answer. The shape is the contract. */
function component(c) {
  return {
    economic_class: c.economic_class,
    code: c.code,
    label: c.label || null,
    state: c.state,
    amount: c.amount ?? null,
    cadence: c.cadence ?? null,
    obligation: c.obligation ?? null,
    applicability_basis: c.applicability_basis ?? null,
    effective_from: c.effective_from ?? null,
    effective_until: c.effective_until ?? null,
    governed_source: c.governed_source ?? null,
    authority_receipt: c.authority_receipt ?? null,
    quotable_precisely: c.state === "known_and_quotable",
    unresolved_determinant: c.unresolved_determinant ?? null,
    calculation_inputs: c.calculation_inputs ?? null,
    say: c.say ?? null,
  };
}

const chargeState = (ch) => {
  if (ch.record_state === "draft") return { state: "known_but_not_yet_quotable", why: "draft_has_no_operating_effect" };
  if (!ch.effective_now) return { state: "not_applicable", why: "not_effective_on_this_date" };
  if (ch.amount == null) return { state: "unresolved", why: ch.amount_unresolved_reason };
  if (!ch.cadence) return { state: "unresolved", why: "cadence_unknown" };
  if (!ch.applicability_basis && ch.obligation === "required")
    return { state: "unresolved", why: "applicability_unknown" };
  if (ch.obligation === "conditional") return { state: "known_but_conditional", why: ch.condition_key };
  if (ch.obligation === "optional") return { state: "known_but_optional", why: ch.applicability_basis };
  return { state: "known_and_quotable", why: null };
};

/**
 * @param ctx { property_id, space_id?, unit_type_id?, lease_term_months?, intent?, as_of? }
 */
async function economicAnswer(pool, ctx = {}) {
  const { property_id, unit_type_id = null, space_id = null,
          lease_term_months = null, intent = "new_lease", as_of = null } = ctx;

  if (!property_id) {
    return { answerable: false, reason: "no_property_context",
             say: "I'm not able to look that up — let me get the leasing office to confirm.", components: [] };
  }

  // ── each class resolves INDEPENDENTLY. One failure never voids another. ──
  const components = [];
  let pricingErr = null, chargeErr = null;
  let pricing = null, charges = null;
  try { pricing = await effectivePropertyPricing(pool, { property_id, as_of }); }
  catch (e) { pricingErr = e.message; }
  try { charges = await governedCharges(pool, { property_id, as_of }); }
  catch (e) { chargeErr = e.message; }

  // ── base rent + renewal rent ──────────────────────────────────────
  if (pricingErr) {
    components.push(component({ economic_class: "base_rent", code: "rent.base",
      state: "unavailable", governed_source: "effective_pricing",
      say: "I can't read pricing right now, so I don't want to quote a rent." }));
  } else {
    const noPool = { query: async () => { throw new Error("adapter must not query here"); } };
    for (const want of ["new_lease", "renewal"]) {
      if (intent && intent !== "both" && want !== intent) continue;
      const q = await quotablePricing(noPool,
        { property_id, unit_type_id, space_id, lease_term_months, intent: want },
        { picture: pricing });
      components.push(component({
        economic_class: "base_rent",
        code: want === "renewal" ? "rent.renewal" : "rent.base",
        label: want === "renewal" ? "Renewal rent" : "Asking rent",
        state: q.quotable ? "known_and_quotable"
          : q.reason === "not_applicable_to_residential_pricing" ? "not_applicable"
          : q.reason === "no_published_pricing_version" ? "known_but_not_yet_quotable"
          : "unresolved",
        amount: q.quotable ? q.rent : null,
        cadence: "monthly", obligation: "required",
        applicability_basis: q.quotable ? `${q.unit_type.label}, ${q.lease_term_months}-month term` : null,
        effective_from: pricing.published_version ? pricing.published_version.effective_from : null,
        governed_source: q.quotable ? "property_pricing_versions" : null,
        authority_receipt: q.quotable ? q.proof : null,
        unresolved_determinant: q.quotable ? null : q.reason,
        calculation_inputs: q.quotable ? { lease_term_months: q.lease_term_months } : null,
        say: q.quotable ? null : q.say,
      }));
    }
  }

  // ── one-time fees, recurring charges, deposit requirement ─────────
  if (chargeErr) {
    for (const k of ["one_time_fee", "recurring_charge", "deposit_required"]) {
      components.push(component({ economic_class: k, code: k, state: "unavailable",
        governed_source: "property_governed_charges",
        say: "I can't read the current charges, so I don't want to quote them." }));
    }
  } else {
    const push = (ch) => {
      const st = chargeState(ch);
      components.push(component({
        economic_class: ch.economic_class, code: ch.charge_code, label: ch.display_label,
        state: st.state, amount: st.state === "unresolved" ? null : ch.amount,
        cadence: ch.cadence, obligation: ch.obligation,
        applicability_basis: ch.applicability_basis,
        effective_from: ch.effective_from, effective_until: ch.effective_until,
        governed_source: "property_governed_charges",
        authority_receipt: ch.published_by ? { published_by: ch.published_by, at: ch.published_at } : null,
        unresolved_determinant: st.why,
        calculation_inputs: ch.condition_key ? { condition_key: ch.condition_key } : null,
      }));
    };
    (charges.one_time_fees || []).forEach(push);
    (charges.recurring_charges || []).forEach(push);
    (charges.deposit_requirements || []).forEach(push);

    // Honest absence per class, so silence is never read as "nothing is owed".
    for (const [cls, list, code] of [
      ["one_time_fee", charges.one_time_fees, "fees"],
      ["recurring_charge", charges.recurring_charges, "recurring"],
      ["deposit_required", charges.deposit_requirements, "deposit"],
    ]) {
      if (!list || !list.length) {
        components.push(component({ economic_class: cls, code, state: "known_but_not_yet_quotable",
          governed_source: "property_governed_charges",
          unresolved_determinant: "no_governed_charge_published_in_this_class",
          say: cls === "recurring_charge"
            ? "Recurring charges are governed outside this version and are not yet available for precise quoting."
            : "I don't have a governed figure for that yet — the leasing office can confirm." }));
      }
    }
  }

  // ── advertised concessions ────────────────────────────────────────
  const adv = pricing && pricing.concessions ? (pricing.concessions.advertised || []) : [];
  components.push(component({
    economic_class: "concession", code: "concession.advertised",
    state: adv.length ? "known_and_quotable" : "known_but_not_yet_quotable",
    amount: null, cadence: "one_time_per_term", obligation: "optional",
    governed_source: adv.length ? "concession_policies" : null,
    unresolved_determinant: adv.length ? null
      : (pricing && pricing.concessions && pricing.concessions.concessions_unavailable) || "no_advertised_concession",
    say: adv.length ? null : "There's no advertised special I can confirm right now.",
  }));

  // ── the combined total, and why it is usually withheld ────────────
  const monthly = components.filter((c) =>
    c.cadence === "monthly" && c.state === "known_and_quotable" && c.obligation === "required");
  const monthlyBlockers = components.filter((c) =>
    c.cadence === "monthly" && c.state !== "known_and_quotable" && c.state !== "not_applicable");
  const combined_monthly = monthlyBlockers.length === 0 && monthly.length > 0
    ? { amount: Math.round(monthly.reduce((s, c) => s + Number(c.amount), 0) * 100) / 100,
        components: monthly.map((c) => c.code) }
    : { amount: null, withheld_because: monthlyBlockers.map((c) => `${c.code}:${c.state}`),
        rule: "A combined monthly figure is produced ONLY when every monthly component is governed, " +
              "required, applicable and separately disclosed. Otherwise the parts are given and the " +
              "total is withheld." };

  const known = components.filter((c) => c.state === "known_and_quotable").length;
  return {
    answerable: known > 0,
    property_id, as_of: pricing ? pricing.as_of : as_of,
    intent,
    components,
    combined_monthly,
    combined_move_in: { amount: null,
      withheld_because: "one_time_fees_and_deposit_requirement_are_not_all_governed",
      rule: "A move-in total mixes fees, deposits and first rent. It is produced only when every " +
            "component is governed AND separately disclosed alongside it." },
    partial_answer_note:
      "Each economic class resolves independently. A missing class does not void the others — " +
      "refusing everything because one is missing would imply nothing is known when something is.",
    proof: {
      sends_nothing: true, writes_nothing: true,
      never_reads: ["units.market_rent", "window.__pricingStore", "rent_survey_observations"],
      classes_never_collapsed: ["base_rent", "recurring_charge", "one_time_fee",
                               "deposit_required", "deposit_held", "concession", "credit"],
    },
  };
}

module.exports = { economicAnswer, STATES, chargeState };
