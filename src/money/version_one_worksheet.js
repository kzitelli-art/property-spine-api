// ════════════════════════════════════════════════════════════════════
//  version_one_worksheet.js — THE OWNERSHIP DECISION SHEET
//
//  Read-only. Generated from the canonical packet, and deliberately EMPTY
//  where ownership must decide.
//
//  ── IT DOES NOT PRE-FILL ─────────────────────────────────────────────
//  Every `owner_decision` field comes back null. A worksheet that arrives
//  with plausible numbers already in the boxes is not a decision surface —
//  it is a recommendation wearing a form, and the reviewer's job silently
//  becomes "spot the wrong one" instead of "decide". The evidence sits
//  beside each blank so the decision is informed, never pre-made.
//
//  It also cannot populate a governed draft. It returns a shape a human
//  fills in; saveDraft still requires may_prepare_pricing and a real
//  proposal. There is no path from this file into pricing_terms.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { pricingDecisionPacket } = require("./pricing_decision_packet");

const BLANK = { value: null, decided: false, decided_by: null, decided_at: null };

async function versionOneWorksheet(pool, { property_id, as_of = null, horizon_days = 90 } = {}) {
  if (!property_id) throw new Error("versionOneWorksheet requires property_id");
  const packet = await pricingDecisionPacket(pool, { property_id, as_of, horizon_days });

  const types = packet.unit_types
    .filter((t) => t.offer_state !== "not_applicable_to_residential_pricing")
    .map((t) => {
      const ev = t.evidence, g = t.pacing;
      const spread = (packet.spread_analysis || []).find((s) => String(s.unit_type_id) === String(t.unit_type_id));
      const mode = spread && spread.histogram && spread.histogram.length
        ? spread.histogram.slice().sort((a, b) => b.positions - a.positions)[0] : null;
      return {
        unit_type_id: t.unit_type_id, code: t.code, label: t.label,

        // ── decisions ownership must make. All blank, by design. ──
        offered_status: { ...BLANK, options: ["offered", "not_offered", "pricing_unavailable"] },
        new_lease_rent: { ...BLANK },
        renewal_rent: { ...BLANK, note: "Explicit value, or explicitly unavailable. Silence is refused at publication." },
        lease_terms: { ...BLANK, note: "One or more integers, 1–36 months." },
        effective_date: { ...BLANK },
        owner_decision: { ...BLANK, note: "Free-text rationale retained on the review receipt." },

        // ── evidence, beside the blank rather than inside it ──
        evidence_summary: {
          in_place_median: ev.in_place_contractual_rent.median,
          in_place_count: ev.in_place_contractual_rent.count,
          in_place_range: ev.in_place_contractual_rent.count
            ? [ev.in_place_contractual_rent.min, ev.in_place_contractual_rent.max] : null,
          native_executed_count: ev.native_executed_rent.count,
          native_executed_median: ev.native_executed_rent.median || null,
          legacy_range: [ev.legacy_market_rent.min, ev.legacy_market_rent.max],
          legacy_disposition: "evidence_only_never_an_offer",
          legacy_modal_value: mode ? mode.value : null,
          legacy_modal_positions: mode ? mode.positions : null,
          legacy_other_prices: spread ? Math.max(0, spread.distinct_values - 1) : 0,
          legacy_positions_disagreeing: spread && mode ? spread.count - mode.positions : 0,
        },
        exposure_at_horizon: {
          residential_positions: g.residential_positions,
          locked_today: g.contractually_locked_today,
          locked_at_horizon: g.contractually_locked_at_horizon,
          uncovered_at_horizon: g.uncovered_at_horizon,
          pending_successors: g.pending_successors,
          marketable_now: g.marketable_now,
        },
        missing_or_contradictory: [
          ...(t.missing_decisions || []),
          ev.native_executed_rent.count === 0 ? "no_native_executed_evidence_exists" : null,
          spread && spread.distinct_values > 1
            ? `legacy_evidence_disagrees_with_itself(${spread.distinct_values}_values)` : null,
        ].filter(Boolean),
      };
    });

  // Property-level rulings that are not per-type.
  const money = packet.money_facts;
  const factNote = (k) => {
    const f = (money.facts || []).find((x) => x.fact_key === k);
    return f ? { current_text: f.text, verdict: f.verdict, unresolved: f.unresolved || null } : null;
  };

  const rulings = [
    { key: "studio_outliers", question:
        "Studio: 75 of 108 positions carry $1,450. Are the other prices real, or data errors?",
      evidence: (packet.spread_analysis.find((s) => s.label === "Studio") || {}).histogram || null,
      decision: { ...BLANK } },
    { key: "one_bed_outlier", question:
        "1 Bed: 73 of 102 carry $1,800, with a single $1,200. Real or error?",
      evidence: (packet.spread_analysis.find((s) => s.label === "1 Bed") || {}).histogram || null,
      decision: { ...BLANK } },
    { key: "furnished_one_bed_evidence", question:
        "Furnished 1 Bed: 10 of 16 at $2,000 across 6 distinct prices on 16 positions. Is the furnished premium a tier or noise?",
      evidence: (packet.spread_analysis.find((s) => s.label === "Furnished 1 Bed") || {}).histogram || null,
      decision: { ...BLANK } },
    { key: "three_bed_two_bath_spread", question:
        "3 Bed / 2 Bath: in-place median $3,300 against a flat legacy $3,900 — the largest gap in the building, on 6 positions.",
      evidence: null, decision: { ...BLANK } },
    { key: "telecom_determinant", question:
        "Telecom fee is stated as $75–99 with no determinant. What decides the amount, or is it office-quoted?",
      evidence: factNote("pricing_telecom_fee"), decision: { ...BLANK } },
    { key: "pet_fee_versus_pet_rent", question:
        "One fact carries a $300 one-time fee AND $30/month pet rent, and does not say per-pet or per-tenancy.",
      evidence: factNote("pet_policy"), decision: { ...BLANK } },
    { key: "amenity_new_lease_versus_renewal", question:
        "Amenity fee is $300 at move-in and $250 at renewal. Confirm both, and that the condition becomes structured rather than prose.",
      evidence: factNote("pricing_amenity_fee"), decision: { ...BLANK } },
    { key: "publisher_identity", question:
        "Who publishes version one? The person must hold an owner or asset-manager assignment AND be linked to a login.",
      evidence: { portfolio_publish_capable_assignments: 1,
        detail: "One assignment portfolio-wide (owner on Demo Building), held by a demo lead person row " +
                "with no linked login. No signed-in operator can currently publish." },
      decision: { ...BLANK } },
    { key: "initial_effective_date", question: "From what date does version one take effect?",
      evidence: null, decision: { ...BLANK } },
  ];

  return {
    property_id, as_of: packet.as_of, horizon_days: packet.horizon_days,
    disposition: "read_only_worksheet_no_draft_populated",
    types,
    rulings,
    blocked_by: {
      publication: "no_linked_login_holds_publish_authority",
      detail: "Identity reconciliation must complete before a version can be published. " +
              "Preparing and reviewing a draft are blocked by the same gate.",
    },
    rules: [
      "Every decision field is blank. Nothing is pre-filled or recommended.",
      "Legacy market_rent is shown as evidence and can never be adopted as an offer.",
      "A renewal decision must be explicit; silence is refused at publication.",
      "This worksheet cannot populate a governed draft.",
    ],
  };
}

module.exports = { versionOneWorksheet };
