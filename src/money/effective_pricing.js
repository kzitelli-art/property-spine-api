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
            count(*) filter (where s.use_type = 'residential')::int residential_positions,
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
    const inv = invByType.get(String(ty.id)) || { positions: 0, residential_positions: 0, marketable_positions: 0 };

    // A type with NO residential positions is outside residential pricing
    // entirely. It is not "unpriced" and it is certainly not offered at the
    // legacy value its rows happen to carry — the commercial space carries
    // market_rent = 0, and a numeric zero must never be able to surface as an
    // authorized offer. It owes no decision and is said to owe none.
    const residentialApplicable = inv.residential_positions > 0;

    const rows = (termsByType.get(String(ty.id)) || []).filter((t) => !t.override_scope);
    const offered = rows.filter((t) => t.offer_state === "offered");
    const state = !residentialApplicable ? "not_applicable_to_residential_pricing"
      : !version ? "no_published_version"
      : rows.length === 0 ? "not_addressed"
      : offered.length ? "offered"
      : rows[0].offer_state;   // not_offered | pricing_unavailable
    return {
      unit_type_id: ty.id,
      code: ty.code,
      label: ty.label,
      positions: inv.positions,
      residential_positions: inv.residential_positions,
      marketable_positions: inv.marketable_positions,
      requires_pricing_decision: residentialApplicable && inv.marketable_positions > 0,
      // The legacy value on a non-residential type is EVIDENCE, never an
      // offer, and is not carried into this response at all.
      legacy_value_disposition: residentialApplicable ? null : "legacy_evidence_only",
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


// ════════════════════════════════════════════════════════════════════
//  resolveSpaceEconomics — THE AUTHORIZED ASKING ECONOMICS FOR ONE BED
//
//  Migration 182 made an application carry an exact space. This answers the
//  question that immediately follows it: given THAT bed, what is Spine
//  authorized to ask for it?
//
//  ── IT IS NOT A SECOND PRICING SOURCE ───────────────────────────────
//  It lives in this file deliberately. `effectivePropertyPricing` is the
//  permanent owner of advertised economics, and the override columns
//  (override_scope, override_ref) are read NOWHERE else in the repo. A
//  resolver in another module would be a second thing that believes it knows
//  the asking rent, which is the failure this file's own header forbids.
//
//  ── THE PRECEDENCE MIGRATION 101 ANTICIPATED ────────────────────────
//  101 shipped the columns and said so in as many words:
//
//      "The eventual model is: property pricing version → unit-type default
//       → optional later override → inventory cohort or specific space.
//       This migration does NOT build cohort or space overrides. It only
//       avoids making them impossible."
//
//  This is that resolution, and nothing more. No table, no column, no new
//  vocabulary — the schema already carried the shape.
//
//      space override      most specific  (override_scope='space')
//      inventory cohort                   (override_scope='inventory_cohort')
//      unit-type default   least specific (override_scope is null)
//
//  ── WHAT IT REFUSES TO DO ───────────────────────────────────────────
//   · never reads units.market_rent — a legacy column that disagreed with
//     in-place rent in 105 of 114 studios measured, and is not authorised.
//   · never borrows a sibling bed's price. Two beds in one unit share a
//     price only because they share a TYPE and neither carries an override.
//     Absent pricing is NOT_ESTABLISHED, never the bed next door.
//   · never invents a term. A caller asking for a term nobody published gets
//     a refusal naming the terms that ARE published.
//   · never returns a number without saying what authorised it.
// ════════════════════════════════════════════════════════════════════
async function resolveSpaceEconomics(pool, {
  property_id, space_id, lease_term_months = null, as_of = null,
} = {}) {
  if (!property_id) throw new Error("resolveSpaceEconomics requires a server-derived property_id");
  if (!space_id) throw new Error("resolveSpaceEconomics requires a space_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  const unresolved = (reason, detail, extra = {}) => ({
    property_id, space_id, as_of: asOf,
    resolved: false, reason, detail,
    rent: null, authority: null,
    ...extra,
  });

  // ── THE BED, ITS UNIT AND ITS GOVERNED TYPE ───────────────────────
  //  One read. property_id is checked HERE rather than trusted: a bed at
  //  another property must never resolve economics under this property's
  //  published version.
  const bed = (await pool.query(
    `select s.id space_id, s.space_label, s.use_type,
            u.id unit_id, u.unit_number, u.unit_type_id,
            u.property_id,
            put.code unit_type_code, put.label unit_type_label
       from spaces s
       join units u on u.id = s.unit_id
       left join property_unit_types put on put.id = u.unit_type_id
      where s.id = $1`, [space_id]
  )).rows[0];

  if (!bed) return unresolved("space_not_found", "No such rentable space.");
  if (String(bed.property_id) !== String(property_id)) {
    return unresolved("space_not_at_property",
      "That space is not at this property, so this property's published pricing does not govern it.");
  }

  const identity = {
    unit_id: bed.unit_id, unit_number: bed.unit_number,
    space_label: bed.space_label,
    unit_type_id: bed.unit_type_id,
    unit_type_code: bed.unit_type_code, unit_type_label: bed.unit_type_label,
  };

  //  A position with no governed type cannot receive type-based pricing, and
  //  the completeness block of effectivePropertyPricing already counts these
  //  as `unclassified_positions`. Saying so is the honest answer; picking the
  //  property's only type would be a guess wearing a lookup's clothes.
  if (!bed.unit_type_id) {
    return unresolved("unit_type_not_established",
      "This position carries no governed unit type, so no type-based price applies to it.",
      { identity });
  }

  // ── THE PUBLISHED VERSION IN FORCE ON THIS DATE ───────────────────
  const version = (await pool.query(
    `select id, effective_from, effective_until, published_at, authority_basis
       from property_pricing_versions
      where property_id=$1 and status='published'
        and effective_from <= $2::date
        and (effective_until is null or effective_until >= $2::date)
      order by effective_from desc limit 1`, [property_id, asOf]
  )).rows[0] || null;

  if (!version) {
    return unresolved("no_published_pricing_version",
      "No governed pricing version is published and effective for this property on this date.",
      { identity });
  }

  // ── EVERY CANDIDATE ROW FOR THIS BED, AT EVERY SCOPE ──────────────
  //  A space override names the bed; a cohort override names a cohort the
  //  bed belongs to; a type default names the type. All three are read in
  //  one statement so precedence is applied to a single consistent set.
  const candidates = (await pool.query(
    `select id, lease_term_months, base_rent, renewal_rent, immediate_move_in_rent,
            offer_state, override_scope, override_ref
       from pricing_terms
      where pricing_version_id = $1
        and unit_type_id = $2
        and (override_scope is null
             or (override_scope = 'space' and override_ref = $3))
      order by lease_term_months`,
    [version.id, bed.unit_type_id, space_id]
  )).rows;

  //  'inventory_cohort' is a DECLARED scope with no cohort membership model
  //  in the schema yet. It is neither read nor silently ignored: a cohort row
  //  reaching this bed's type is reported as unresolvable rather than skipped,
  //  because skipping it would quietly answer with the type default while a
  //  narrower authorised row existed.
  const cohortRows = (await pool.query(
    `select count(*)::int n from pricing_terms
      where pricing_version_id=$1 and unit_type_id=$2 and override_scope='inventory_cohort'`,
    [version.id, bed.unit_type_id]
  )).rows[0].n;
  if (cohortRows > 0) {
    return unresolved("inventory_cohort_override_not_resolvable",
      "This type carries an inventory-cohort pricing override, and cohort membership is not modelled, "
      + "so Spine cannot tell whether it applies to this bed. Resolve the cohort before quoting.",
      { identity, published_version_id: version.id });
  }

  if (!candidates.length) {
    return unresolved("unit_type_not_addressed",
      "The published pricing version does not address this unit type.",
      { identity, published_version_id: version.id });
  }

  // ── TERM ──────────────────────────────────────────────────────────
  //  A term is CHOSEN, never defaulted to 12. Twelve is the commonest lease
  //  and that is exactly why defaulting to it is dangerous: it would quote a
  //  term the operator never selected and the version may never have
  //  published. With no term supplied the answer is the published menu.
  const publishedTerms = [...new Set(candidates.map((c) => c.lease_term_months))].sort((a, b) => a - b);
  if (lease_term_months == null) {
    return unresolved("lease_term_not_selected",
      "A lease term must be selected before an asking rent can be authorised.",
      { identity, published_version_id: version.id, published_terms: publishedTerms });
  }
  const forTerm = candidates.filter((c) => Number(c.lease_term_months) === Number(lease_term_months));
  if (!forTerm.length) {
    return unresolved("lease_term_not_published",
      `No published pricing for a ${lease_term_months}-month term on this unit type.`,
      { identity, published_version_id: version.id, published_terms: publishedTerms });
  }

  // ── PRECEDENCE: the narrowest authorised row wins ─────────────────
  const spaceRow = forTerm.find((c) => c.override_scope === "space");
  const typeRow = forTerm.find((c) => c.override_scope === null);
  const chosen = spaceRow || typeRow;
  if (!chosen) {
    return unresolved("no_applicable_pricing_row",
      "No pricing row at any applicable scope governs this bed for that term.",
      { identity, published_version_id: version.id, published_terms: publishedTerms });
  }

  //  offer_state is a published statement, not an absence. `not_offered` and
  //  `pricing_unavailable` are answers the version gave on purpose, and they
  //  are reported as themselves rather than flattened into "no price".
  if (chosen.offer_state !== "offered") {
    return unresolved("not_offered",
      chosen.offer_state === "pricing_unavailable"
        ? "The published version states that pricing is unavailable for this unit type."
        : "The published version states that this unit type is not offered.",
      { identity, published_version_id: version.id, offer_state: chosen.offer_state,
        published_terms: publishedTerms });
  }
  if (chosen.base_rent == null) {
    return unresolved("published_row_carries_no_rent",
      "The published row for this type and term carries no base rent.",
      { identity, published_version_id: version.id, published_terms: publishedTerms });
  }

  // ── DEPOSIT AND FEES — the one live source, per-bed aware ──────────
  //  agent_facts is the transitional owner of fee and deposit quoting, and it
  //  carries an optional space_id. A bed-specific approved fact therefore
  //  outranks the property-level one; both are reported so a reader can see
  //  which applied and why. This file still does not OWN them, and says so.
  const facts = (await pool.query(
    `select fact_key, rendered_text, source_type, confirmed_at, space_id
       from agent_facts
      where property_id=$1 and status='active'
        and (space_id is null or space_id = $2)
        and fact_key = any($3::text[])
        and (effective_until is null or effective_until > now())`,
    [property_id, space_id, TRANSITIONAL_FEE_FACT_KEYS]
  )).rows;
  const byKey = new Map();
  for (const f of facts) {
    const prior = byKey.get(f.fact_key);
    if (!prior || (prior.space_id == null && f.space_id != null)) byKey.set(f.fact_key, f);
  }
  const factOut = (key) => {
    const f = byKey.get(key);
    if (!f) return { established: false, text: null, scope: null };
    return {
      established: true, text: f.rendered_text,
      scope: f.space_id ? "space" : "property",
      source_type: f.source_type, confirmed_at: f.confirmed_at,
    };
  };

  // ── CONCESSIONS APPLICABLE TO THIS BED ────────────────────────────
  //  Same rule the property read applies: a concession may not be advertised
  //  unless its economic consequence is computable. Scope is honoured, and
  //  `bed_type` is a declared scope with no bed-type model, so it is reported
  //  as inapplicable rather than assumed to apply.
  const { IMPLEMENTED_TIMING_PROFILES } = require("./pricing_publication_contract");
  const policies = (await pool.query(
    `select * from concession_policies
      where pricing_version_id=$1 and active=true and lease_type='new'`, [version.id]
  )).rows;
  const advertisable = [];
  const withheld = [];
  for (const p of policies) {
    const scopeApplies =
      p.scope === "property" ? true
      : p.scope === "unit_type" ? String(p.scope_ref) === String(bed.unit_type_code)
      : p.scope === "unit" ? String(p.scope_ref) === String(bed.unit_number)
      : false;                                   // 'bed_type' — no model, never assumed
    if (!scopeApplies) continue;
    if (p.required_term_months != null && Number(p.required_term_months) !== Number(lease_term_months)) continue;
    const computable = CALENDAR_FREE_CONCESSIONS.has(p.concession_type)
      || IMPLEMENTED_TIMING_PROFILES.includes(p.timing_profile);
    (computable ? advertisable : withheld).push({
      concession_type: p.concession_type,
      value: p.value == null ? null : Number(p.value),
      fee_category: p.fee_category,
      scope: p.scope,
      reason: computable ? null : "timing_profile_not_implemented",
    });
  }

  return {
    property_id, space_id, as_of: asOf,
    resolved: true, reason: null, detail: null,
    identity,
    lease_term_months: Number(lease_term_months),
    published_terms: publishedTerms,
    rent: {
      new_lease_rent: Number(chosen.base_rent),
      renewal_rent: chosen.renewal_rent == null ? null : Number(chosen.renewal_rent),
      immediate_move_in_rent: chosen.immediate_move_in_rent == null ? null : Number(chosen.immediate_move_in_rent),
    },
    //  WHAT AUTHORISED THE NUMBER. A rent with no stated basis is a number a
    //  surface can render and nobody can defend.
    authority: {
      published_version_id: version.id,
      authority_basis: version.authority_basis || null,
      published_at: version.published_at,
      pricing_term_id: chosen.id,
      //  'space_override' means THIS BED is priced differently from its type.
      //  'unit_type_default' means it shares its type's published price — which
      //  is a governed statement, not an inherited guess.
      basis: spaceRow ? "space_override" : "unit_type_default",
    },
    deposit: factOut("pricing_security_deposit"),
    fees: {
      source: "agent_facts",
      ownership: "transitional_external",
      application_fee: factOut("pricing_application_fee"),
      amenity_fee: factOut("pricing_amenity_fee"),
      admin_fee: factOut("pricing_admin_fee"),
      telecom_fee: factOut("pricing_telecom_fee"),
    },
    concessions: { advertisable, withheld },
    proof: {
      never_reads: ["units.market_rent", "window.__pricingStore", "rent_survey_observations"],
      never_borrows: "a sibling bed's price",
    },
  };
}

module.exports = { effectivePropertyPricing, resolveSpaceEconomics, TRANSITIONAL_FEE_FACT_KEYS, CALENDAR_FREE_CONCESSIONS };
