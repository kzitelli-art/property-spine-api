// ════════════════════════════════════════════════════════════════════
//  pricing_adapter.js — THE AI's ONLY ROUTE TO PRICING
//
//  DARK BY CONSTRUCTION. Nothing calls this yet, and when it is called it
//  can only answer from a published governed version. Until one exists it
//  returns an honest handoff — which is the correct behaviour, not a
//  placeholder.
//
//  The AI is a CONSUMER of the Pricing & Concessions truth sheet, never a
//  holder of pricing. Today the agent quotes units.market_rent directly at
//  agent.js:294 — a legacy per-unit column that disagreed with the sheet on
//  unit 530 by $237 and went to nine real phones. This adapter is what
//  replaces that, and it is written so it CANNOT repeat it:
//
//    · never reads units.market_rent
//    · never reads the client-side pricing store
//    · never treats a rent-survey observation as authority
//    · never infers a unit type from a label, code or square footage
//    · never quotes a concession whose economics cannot be computed
//    · quotes fees from the ONE approved transitional source
//
//  When it cannot answer it says so and hands off. An honest handoff is a
//  better outcome than a confident wrong price said to a real prospect.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { effectivePropertyPricing } = require("../money/effective_pricing");

const HANDOFF = (reason, detail) => ({
  quotable: false, reason, detail,
  say: "I want to give you an exact number rather than guess — let me confirm the current pricing with the leasing office and come straight back to you.",
});

/**
 * Resolve quotable pricing for a conversation.
 *  ctx: { property_id, space_id?, unit_type_id?, lease_term_months?, intent? }
 *       intent: 'new_lease' | 'renewal'   (default new_lease)
 */
async function quotablePricing(pool, ctx = {}, opts = {}) {
  const { property_id, space_id = null, unit_type_id = null,
          lease_term_months = null, intent = "new_lease" } = ctx;
  // opts.picture lets the publication PREVIEW run this exact function against
  // a proposed sheet. The seam is here rather than in the caller so there is
  // one refusal path, not a copy of it: a preview that reimplemented these
  // rules would prove nothing about what the live path will say.
  const preloaded = opts.picture || null;

  if (!property_id) return HANDOFF("no_property_context", "The conversation is not bound to a property.");

  // ── resolve the governed type from the REAL position, never a label ──
  let typeId = unit_type_id;
  let resolvedFrom = unit_type_id ? "requested_type" : null;
  if (!typeId && space_id) {
    const r = (await pool.query(
      `select u.unit_type_id from spaces s join units u on u.id=s.unit_id
        where s.id=$1 and u.property_id=$2`, [space_id, property_id])).rows[0];
    typeId = r ? r.unit_type_id : null;
    resolvedFrom = "rentable_position";
  }
  if (!typeId) {
    return HANDOFF("unit_type_unresolved",
      space_id ? "That position has no governed unit type, so type-based pricing cannot be applied to it."
               : "No unit type or rentable position was supplied.");
  }

  const pricing = preloaded || await effectivePropertyPricing(pool, { property_id });

  // TYPE APPLICABILITY IS TESTED BEFORE VERSION PRESENCE, deliberately. A
  // non-residential type has no residential pricing whether or not a version
  // exists, so answering "no version is published" there would imply that
  // publishing one would produce a price for it. Its legacy numeric value is
  // evidence, and a zero must never reach a prospect as an authorized offer.
  const type = pricing.unit_types.find((t) => String(t.unit_type_id) === String(typeId));
  if (!type) return HANDOFF("unit_type_not_in_property", "That unit type does not belong to this property.");
  if (type.offer_state === "not_applicable_to_residential_pricing")
    return HANDOFF("not_applicable_to_residential_pricing",
      `${type.label} is not residential inventory and has no residential pricing.`);

  if (!pricing.published_version) {
    return HANDOFF("no_published_pricing_version",
      "No governed pricing version is published and effective for this property.");
  }

  if (type.offer_state === "not_offered")
    return HANDOFF("type_not_offered", `${type.label} is not currently offered.`);
  if (type.offer_state === "pricing_unavailable" || type.offer_state === "not_addressed")
    return HANDOFF("type_pricing_unavailable", `Pricing for ${type.label} is not available in the published version.`);

  const terms = type.terms || [];
  const chosen = lease_term_months
    ? terms.find((t) => Number(t.lease_term_months) === Number(lease_term_months))
    : terms[0];
  if (!chosen) {
    return HANDOFF("term_not_published",
      lease_term_months ? `No published pricing for a ${lease_term_months}-month term on ${type.label}.`
                        : `No published lease term for ${type.label}.`);
  }

  // NEW LEASE vs RENEWAL are different prices and are never interchanged.
  const rent = intent === "renewal" ? chosen.renewal_rent : chosen.new_lease_rent;
  if (rent == null) {
    return HANDOFF(intent === "renewal" ? "renewal_rent_unavailable" : "new_lease_rent_unavailable",
      `The published version does not state a ${intent === "renewal" ? "renewal" : "new-lease"} rent for ${type.label}.`);
  }

  return {
    quotable: true,
    intent,
    unit_type: { unit_type_id: type.unit_type_id, label: type.label, resolved_from: resolvedFrom },
    lease_term_months: chosen.lease_term_months,
    rent: Number(rent),
    // Only concessions whose economics are computable. When none are
    // advertisable the agent says nothing about concessions at all — it does
    // not hedge, and it does not invent.
    concessions: (pricing.concessions.advertised || []),
    concessions_unavailable: pricing.concessions.concessions_unavailable || null,
    // The one approved fee source during transition.
    fees: pricing.fees.facts.map((f) => ({ fact_key: f.fact_key, text: f.text })),
    fee_source: pricing.fees.source,
    proof: {
      version_id: pricing.published_version.version_id,
      effective_from: pricing.published_version.effective_from,
      published_by: pricing.published_version.published_by,
      basis: "published_pricing_version",
    },
  };
}

module.exports = { quotablePricing, HANDOFF };
