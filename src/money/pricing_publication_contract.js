// ════════════════════════════════════════════════════════════════════
//  pricing_publication_contract.js — WHAT MAKES A VERSION PUBLISHABLE
//
//  Publication is a governed act. A version does not become property-wide
//  published truth because one row exists — silence about a marketable type
//  is not a price, and a partial sheet that hides its gaps is worse than no
//  sheet at all.
//
//  This module is a PURE checker: it takes an already-loaded picture and
//  returns the blockers. No database, no writes, no publishing. It exists
//  separately from the ledger so the same rules can be shown to an operator
//  BEFORE they press publish, and asserted in a harness without a DB.
//
//  FAILS CLOSED. Every unmet condition is a blocker; publication requires
//  an empty blocker list.
// ════════════════════════════════════════════════════════════════════

"use strict";

// Which concession timing profiles have a PROVEN calendar implementation.
// Empty by design: computeScheduleLines is still a throw-only stub, so no
// profile can place dated lines. When the real calendar lands, its proven
// profiles list here and nowhere else.
const IMPLEMENTED_TIMING_PROFILES = [];

// A fee waiver is one-time and month-agnostic: it needs no dated schedule,
// so it is publishable without the calendar. Free rent and fixed rent
// credits place dated lines and are not.
const CALENDAR_FREE_CONCESSIONS = new Set(["fee_waiver"]);

const VALID_TERMS = (m) => Number.isInteger(m) && m >= 1 && m <= 36;
const OFFER_STATES = new Set(["offered", "not_offered", "pricing_unavailable"]);

/**
 * @param picture {
 *   property_id, effective_from, effective_until,
 *   publisher: { person_id, can_publish },
 *   existing_published: [{ version_id, effective_from, effective_until }],
 *   marketable_types: [{ unit_type_id, label, marketable_positions }],
 *   terms: [{ unit_type_id, property_id, lease_term_months, base_rent,
 *             renewal_rent, offer_state, legacy_unit_type_text }],
 *   concessions: [{ concession_type, timing_profile, fee_category }],
 *   fee_sources: { governed_count, external_count },
 * }
 * @returns { publishable, blockers[], receipt }
 */
function checkPublishable(picture) {
  const p = picture || {};
  const blockers = [];
  const add = (code, detail) => blockers.push({ code, detail });

  // 1. AUTHORITY. Publishing is not a shape, it is a permission.
  if (!p.publisher || !p.publisher.person_id) add("no_publisher", "A human must publish. No publisher identified.");
  else if (!p.publisher.can_publish)
    add("publisher_lacks_authority", "The named publisher holds no owner/asset-manager assignment or publish grant on this property.");

  // 2. DATES.
  if (!p.effective_from) add("no_effective_from", "A version must state when it takes effect.");
  if (p.effective_from && p.effective_until && String(p.effective_until) < String(p.effective_from))
    add("effective_until_before_from", "effective_until precedes effective_from.");

  // 3. NO OVERLAPPING PUBLISHED PERIOD. Two published versions covering one
  //    day means the property has two asking rents, which is not a sheet.
  for (const ex of p.existing_published || []) {
    const aStart = String(p.effective_from || ""), aEnd = String(p.effective_until || "9999-12-31");
    const bStart = String(ex.effective_from || ""), bEnd = String(ex.effective_until || "9999-12-31");
    if (aStart <= bEnd && bStart <= aEnd)
      add("overlapping_published_version",
        `Version ${ex.version_id} already covers ${bStart}..${bEnd}, which overlaps this period.`);
  }

  // 4. EVERY MARKETABLE TYPE ADDRESSED. This is the rule that makes a
  //    partial sheet honest: omission is not permitted, only explicit
  //    'not_offered' or 'pricing_unavailable'.
  const byType = new Map();
  for (const t of p.terms || []) {
    const k = String(t.unit_type_id);
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(t);
  }
  for (const mt of p.marketable_types || []) {
    const rows = byType.get(String(mt.unit_type_id)) || [];
    if (!rows.length)
      add("marketable_type_not_addressed",
        `${mt.label} has ${mt.marketable_positions} marketable position(s) and is not addressed. Mark it offered, not offered, or pricing unavailable.`);
  }

  // 5. TERMS AND RENTS.
  for (const t of p.terms || []) {
    if (!t.unit_type_id)
      add("term_without_governed_type", "A pricing term must reference a governed property unit type, never a text label.");
    if (t.property_id && p.property_id && String(t.property_id) !== String(p.property_id))
      add("cross_property_term", "A pricing term references another property's unit type.");
    if (!OFFER_STATES.has(t.offer_state))
      add("invalid_offer_state", `offer_state must be one of ${[...OFFER_STATES].join(", ")}.`);
    if (t.offer_state === "offered") {
      if (!VALID_TERMS(Number(t.lease_term_months)))
        add("invalid_lease_term", `lease_term_months must be an integer 1..36 (got ${t.lease_term_months}).`);
      if (t.base_rent == null)
        add("offered_without_new_lease_rent", "An offered type must state a new-lease rent or be marked pricing unavailable.");
      if (t.renewal_rent === undefined)
        add("renewal_pricing_not_addressed", "Renewal pricing must be explicitly provided or explicitly unavailable.");
    }
    // 6. NO SILENT PROMOTION of a legacy value.
    if (t.promoted_from === "units.market_rent")
      add("market_rent_promotion", "A legacy units.market_rent value cannot be promoted into published pricing.");
    if (t.promoted_from === "client_store")
      add("client_store_promotion", "The client-side pricing store cannot be promoted into published pricing.");
    if (t.legacy_unit_type_text && !t.unit_type_id)
      add("legacy_text_as_key", "The legacy unit_type text is provenance, not a lookup key.");
  }

  // 7. CONCESSIONS ONLY THROUGH IMPLEMENTED PROFILES.
  for (const c of p.concessions || []) {
    const calendarFree = CALENDAR_FREE_CONCESSIONS.has(c.concession_type);
    if (!calendarFree && !IMPLEMENTED_TIMING_PROFILES.includes(c.timing_profile))
      add("concession_timing_profile_not_implemented",
        `A ${c.concession_type} concession on '${c.timing_profile}' cannot be advertised: its economic consequence cannot be computed yet.`);
    if (c.concession_type === "fee_waiver" && !c.fee_category)
      add("fee_waiver_without_category", "A fee waiver must name the fee it waives.");
  }

  // 8. ONE FEE SOURCE.
  const f = p.fee_sources || {};
  if ((f.governed_count || 0) > 0 && (f.external_count || 0) > 0)
    add("two_fee_sources",
      "Fees exist in both pricing_terms and the approved fact set. Two independently quotable fee values must never coexist.");

  // 9. REVIEWABLE RECEIPT.
  if (!p.receipt_reviewed)
    add("no_reviewed_receipt", "A version requires a reviewable before/after receipt approved by a human.");

  return {
    publishable: blockers.length === 0,
    blockers,
    receipt: {
      property_id: p.property_id || null,
      effective_from: p.effective_from || null,
      effective_until: p.effective_until || null,
      marketable_types: (p.marketable_types || []).length,
      terms: (p.terms || []).length,
      concessions: (p.concessions || []).length,
      checked: [
        "publisher_authority", "effective_dates", "no_overlapping_published_version",
        "every_marketable_type_addressed", "valid_terms_and_rents",
        "no_legacy_value_promotion", "implemented_concession_profiles",
        "single_fee_source", "reviewed_receipt",
      ],
    },
  };
}

module.exports = {
  checkPublishable,
  IMPLEMENTED_TIMING_PROFILES,
  CALENDAR_FREE_CONCESSIONS,
  OFFER_STATES,
};
