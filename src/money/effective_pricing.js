// ════════════════════════════════════════════════════════════════════
//  effective_pricing.js — THE PRICING & CONCESSIONS TRUTH SHEET
//
//  The permanent OWNER of advertised economics. The AI, the leasing team,
//  Renewals, offers and the Future Rent Roll are CONSUMERS. None of them
//  may hold pricing of its own, and none may reach around this read.
//
//      market evidence  →  management judgment  →  PUBLISHED PRICING
//        →  discretion band  →  leasing decision  →  executed economics
//
//  This file owns exactly one link in that chain: published pricing as
//  authorised operating truth. A competitor rent, a survey observation or
//  an agent's objection may inform the judgment upstream. None of them may
//  become pricing here.
//
//  ── HARD RULES ──────────────────────────────────────────────────────
//   · units.market_rent is NEVER asking rent. It is a legacy per-unit
//     column that disagrees with in-place rent in 105 of 114 studios
//     measured, and it is not authorised pricing.
//   · The client-side __pricingStore is never a source.
//   · A published version may be PARTIAL, but never SILENTLY partial:
//     every marketable type must be addressed, and a type that is not
//     priced must say 'not_offered' or 'pricing_unavailable' out loud.
//   · A concession may not be advertised unless its economic consequence
//     can actually be computed. Today no timing profile is implemented, so
//     calendar-dependent concessions are unavailable by construction.
//   · Fees keep ONE live quoting source during transition (the approved
//     agent_facts), exposed here as explicitly external. Two independently
//     quotable fee values must never exist.
//
//  READ-ONLY. Publication lives in the ledger; this file never writes.
// ════════════════════════════════════════════════════════════════════

"use strict";

// The five approved fee facts the AI quotes today. Named here so the pricing
// read can EXPOSE them without OWNING them — the transitional boundary is
// explicit rather than implied by their absence.
const TRANSITIONAL_FEE_FACT_KEYS = [
  "pricing_application_fee",
  "pricing_amenity_fee",
  "pricing_admin_fee",
  "pricing_telecom_fee",
  "pricing_security_deposit",
];

// Concession vocabulary lives in the ledger (062). A fee waiver needs no
// dated schedule and is therefore publishable today; free rent and fixed
// rent credits place dated lines and cannot be advertised until the schedule
// engine exists.
const CALENDAR_FREE_CONCESSIONS = new Set(["fee_waiver"]);

async function effectivePropertyPricing(pool, { property_id, as_of = null } = {}) {
  if (!property_id) throw new Error("effectivePropertyPricing requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  // ── the governed type vocabulary for this property ────────────────
  const types = (await pool.query(
    `select id, code, label, sort_order from property_unit_types
      where property_id=$1 order by sort_order nulls last, label`, [property_id]
  )).rows;

  // Which governed types actually have marketable inventory? A type with no
  // position is not a pricing decision anybody owes.
  const inventory = (await pool.query(
    `select u.unit_type_id, count(*)::int positions,
            count(*) filter (where coalesce(u.is_down,false)=false
              and coalesce(u.operating_use,'standard')='standard'
              and s.use_type = 'residential')::int marketable_positions
       from spaces s join units u on u.id=s.unit_id
      where u.property_id=$1 group by 1`, [property_id]
  )).rows;
  const invByType = new Map(inventory.map((r) => [String(r.unit_type_id), r]));
  const unclassifiedPositions = (invByType.get("null") || {}).positions || 0;

  // ── the active published version ──────────────────────────────────
  const version = (await pool.query(
    `select id, status, effective_from, effective_until, published_by_person_id,
            published_at, authority_basis, supersedes_version_id, note
       from property_pricing_versions
      where property_id=$1 and status='published'
        and effective_from <= $2::date
        and (effective_until is null or effective_until >= $2::date)
      order by effective_from desc limit 1`, [property_id, asOf]
  )).rows[0] || null;

  let publisher = null;
  if (version && version.published_by_person_id) {
    publisher = (await pool.query("select id, name from persons where id=$1",
      [version.published_by_person_id])).rows[0] || null;
  }

  const terms = version ? (await pool.query(
    `select pt.*, put.code as unit_type_code, put.label as unit_type_label
       from pricing_terms pt
       left join property_unit_types put on put.id = pt.unit_type_id
      where pt.pricing_version_id=$1
      order by put.sort_order nulls last, pt.lease_term_months`, [version.id]
  )).rows : [];

  const policies = version ? (await pool.query(
    `select * from concession_policies where pricing_version_id=$1 and active=true`, [version.id]
  )).rows : [];

  // ── FEES: one live source, exposed as external ────────────────────
  const feeFacts = (await pool.query(
    `select fact_key, rendered_text, source_type, confirmed_at
       from agent_facts
      where property_id=$1 and status='active' and space_id is null
        and fact_key = any($2::text[])
        and (effective_until is null or effective_until > now())
      order by fact_key`, [property_id, TRANSITIONAL_FEE_FACT_KEYS]
  )).rows;

  // ── per-type resolution ───────────────────────────────────────────
  const termsByType = new Map();
  for (const t of terms) {
    const k = String(t.unit_type_id);
    if (!termsByType.has(k)) termsByType.set(k, []);
    termsByType.get(k).push(t);
  }

  const unit_types = types.map((ty) => {
    const inv = invByType.get(String(ty.id)) || { positions: 0, marketable_positions: 0 };
    const rows = (termsByType.get(String(ty.id)) || []).filter((t) => !t.override_scope);
    const offered = rows.filter((t) => t.offer_state === "offered");
    const state = !version ? "no_published_version"
      : rows.length === 0 ? "not_addressed"
      : offered.length ? "offered"
      : rows[0].offer_state;   // not_offered | pricing_unavailable
    return {
      unit_type_id: ty.id,
      code: ty.code,
      label: ty.label,
      positions: inv.positions,
      marketable_positions: inv.marketable_positions,
      requires_pricing_decision: inv.marketable_positions > 0,
      offer_state: state,
      terms: offered.map((t) => ({
        lease_term_months: t.lease_term_months,
        new_lease_rent: t.base_rent == null ? null : Number(t.base_rent),
        renewal_rent: t.renewal_rent == null ? null : Number(t.renewal_rent),
        immediate_move_in_rent: t.immediate_move_in_rent == null ? null : Number(t.immediate_move_in_rent),
        // fee_terms is NOT read as authority during transition — fees have one
        // live source and it is the fee facts below.
        fee_terms_present: t.fee_terms != null,
      })),
    };
  });

  // ── CONCESSIONS: advertised only when computable ──────────────────
  const { IMPLEMENTED_TIMING_PROFILES } = require("./pricing_publication_contract");
  const advertised = [];
  const blocked = [];
  for (const p of policies) {
    const calendarFree = CALENDAR_FREE_CONCESSIONS.has(p.concession_type);
    const ready = calendarFree || IMPLEMENTED_TIMING_PROFILES.includes(p.timing_profile);
    (ready ? advertised : blocked).push({
      concession_type: p.concession_type,
      value: p.value == null ? null : Number(p.value),
      fee_category: p.fee_category,
      timing_profile: p.timing_profile,
      required_term_months: p.required_term_months,
      reason: ready ? null : "timing_profile_not_implemented",
    });
  }

  const marketableTypes = unit_types.filter((t) => t.requires_pricing_decision);
  const unaddressed = marketableTypes.filter((t) => t.offer_state === "not_addressed" || t.offer_state === "no_published_version");

  return {
    property_id,
    as_of: asOf,

    published_version: version ? {
      version_id: version.id,
      status: version.status,
      effective_from: version.effective_from ? String(version.effective_from).slice(0, 10) : null,
      effective_until: version.effective_until ? String(version.effective_until).slice(0, 10) : null,
      published_at: version.published_at,
      published_by: publisher ? { person_id: publisher.id, name: publisher.name } : null,
      authority_basis: version.authority_basis || null,
      supersedes_version_id: version.supersedes_version_id || null,
      note: version.note || null,
    } : null,

    // Honest absence, named. Not an empty object pretending to be pricing.
    absence: version ? null : {
      reason: "no_published_pricing_version",
      detail: "No governed pricing version is published and effective for this property on this date.",
    },

    unit_types,

    concessions: advertised.length ? { advertised }
      : {
          advertised: [],
          concessions_unavailable: blocked.length ? "timing_profile_not_implemented"
                                                  : "schedule_line_engine_not_activated",
          blocked,
          detail: "A concession becomes dated economic schedule lines, not a loose flag. No timing profile is implemented, so a calendar-dependent concession cannot be advertised without its economic consequence being computable.",
        },

    // ONE live fee source, explicitly marked as not owned here.
    fees: {
      source: "agent_facts",
      ownership: "transitional_external",
      owner_note: "Fees are quoted from the approved property fact set. Pricing & Concessions does not own them yet, and pricing_terms.fee_terms is NOT read as authority — two independently quotable fee values must never exist.",
      facts: feeFacts.map((f) => ({
        fact_key: f.fact_key, text: f.rendered_text,
        source_type: f.source_type, confirmed_at: f.confirmed_at,
      })),
    },

    completeness: {
      has_published_version: !!version,
      governed_types: types.length,
      types_requiring_decision: marketableTypes.length,
      types_addressed: marketableTypes.length - unaddressed.length,
      types_unaddressed: unaddressed.map((t) => ({ unit_type_id: t.unit_type_id, label: t.label, marketable_positions: t.marketable_positions })),
      unclassified_positions: unclassifiedPositions,
      complete: !!version && unaddressed.length === 0,
    },

    proof: {
      basis: version ? "published_version" : "none",
      never_reads: ["units.market_rent", "window.__pricingStore", "rent_survey_observations"],
    },
  };
}

module.exports = { effectivePropertyPricing, TRANSITIONAL_FEE_FACT_KEYS, CALENDAR_FREE_CONCESSIONS };
