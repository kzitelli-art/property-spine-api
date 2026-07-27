// ════════════════════════════════════════════════════════════════════
//  economic_shadow.js — CURRENT LIVE ANSWER vs GOVERNED ECONOMIC PICTURE
//
//  25 scenarios across every economic class. SENDS NOTHING, WRITES NOTHING,
//  MUTATES NOTHING. It reads both sides and reports the disagreement.
//
//  ── WHY THE DIFFERENCE IS NOT JUST DOLLARS ───────────────────────────
//  Two answers can agree on the number and still disagree dangerously: a
//  $30 that is monthly on one side and one-time on the other, a charge that
//  is optional on one side and universal on the other, a range quoted as a
//  point. Those are cadence, applicability and precision disagreements, and
//  a dollar-only comparison would call them identical.
//
//  The live side is MODELLED from the two sources agent.js actually reads —
//  units.market_rent and the approved fact set — and every row says so.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { effectiveEconomicPicture } = require("./economic_picture");
const { moneyFactContradictions } = require("./money_fact_contradictions");
const { liveAnswerForType } = require("./shadow_quote_simulator");
const { compileSchedule } = require("./concession_schedule_compiler");

const FACT_SCENARIOS = [
  ["application_fee", "pricing_application_fee"],
  ["administration_fee", "pricing_admin_fee"],
  ["amenity_fee", "pricing_amenity_fee"],
  ["telecom_charge", "pricing_telecom_fee"],
  ["parking", "parking_pricing"],
  ["pet_fee_and_rent", "pet_policy"],
  ["wifi", "utilities"],
  ["insurance", "renters_insurance"],
  ["deposit_requirement", "pricing_security_deposit"],
  ["move_in_requirements", "move_in_requirements"],
  ["move_in_credits", "move_in_credits"],
];

const CONCESSION_SCENARIOS = [
  ["one_time_fee_waiver", { timing_profile: "one_time_fee_waiver", concession_type: "fee_waiver",
    fee_category: "telecom", fee_resolved: false, posting_date: "2026-10-01" }],
  ["flat_dated_credit", { timing_profile: "flat_dated_credit", value: 500,
    lease_start: "2026-10-01", lease_end: "2027-09-30", posting_date: "2026-11-01",
    base_rent: 1500, lease_term_months: 12 }],
  ["fixed_monthly_discount", { timing_profile: "fixed_monthly_discount", value: 100,
    duration_months: 3, lease_start: "2026-10-01", lease_end: "2027-09-30",
    base_rent: 1500, lease_term_months: 12 }],
  ["free_rent_period", { timing_profile: "free_rent_period", free_from: "2026-10-15",
    free_until: "2026-12-01", lease_start: "2026-10-15", lease_end: "2027-10-14",
    base_rent: 1500, lease_term_months: 12 }],
];

const row = (r) => ({
  scenario: r.scenario,
  current_answer: r.current_answer ?? null,
  current_source: r.current_source ?? null,
  current_says: r.current_says ?? null,
  governed_answer: r.governed_answer ?? null,
  governed_source: r.governed_source ?? null,
  governed_state: r.governed_state ?? null,
  dollar_difference: r.dollar_difference ?? null,
  cadence_difference: r.cadence_difference ?? null,
  applicability_difference: r.applicability_difference ?? null,
  required_vs_optional_difference: r.required_vs_optional_difference ?? null,
  source_difference: r.source_difference ?? null,
  unsupported_precision: r.unsupported_precision ?? null,
  duplicate_ownership: r.duplicate_ownership ?? null,
  governed_disposition: r.governed_disposition,   // partial | refused | unavailable | governed
  cannot_survive_cutover_because: r.cannot_survive_cutover_because ?? null,
});

async function economicShadowReport(pool, { property_id, other_property_id = null } = {}) {
  if (!property_id) throw new Error("economicShadowReport requires property_id");

  const picture = await effectiveEconomicPicture(pool, { property_id });
  const money = await moneyFactContradictions(pool, { property_id });
  const rows = [];

  // ── 1 & 2. asking + renewal rent by governed residential type ────
  for (const t of picture.base_rent.types) {
    if (t.offer_state === "not_applicable_to_residential_pricing") continue;
    const live = await liveAnswerForType(pool, property_id, t.unit_type_id);
    for (const [scenario, governed] of [["new_lease_asking_rent", t.new_lease_rent],
                                        ["renewal_rent", t.renewal_rent]]) {
      rows.push(row({
        scenario: `${scenario}:${t.label}`,
        current_answer: live.answer, current_source: live.source, current_says: live.would_say,
        governed_answer: governed, governed_source: governed != null ? "property_pricing_versions" : null,
        governed_state: governed != null ? "known_and_quotable" : "known_but_not_yet_quotable",
        dollar_difference: live.answer != null && governed != null
          ? Math.round((governed - live.answer) * 100) / 100 : null,
        source_difference: `live=${live.source} governed=property_pricing_versions`,
        unsupported_precision: live.spread > 0
          ? { kind: "single_row_from_an_unexplained_spread", spread: live.spread,
              candidates: live.candidates,
              detail: `The live answer is one unit out of ${live.candidates} spanning $${live.spread}, ` +
                      `chosen by SORT ORDER rather than by a pricing decision.` }
          : null,
        governed_disposition: governed != null ? "governed" : "refused",
        cannot_survive_cutover_because: governed == null
          ? "No published pricing version, so the governed side has nothing to say. The live answer " +
            "would simply stop — which is why rent cannot cut over before version one is published."
          : null,
      }));
    }
  }

  // ── 3–15. every monetary fact ────────────────────────────────────
  const byKey = new Map(money.facts.map((f) => [f.fact_key, f]));
  const governedByCode = new Map();
  for (const blk of [picture.one_time_fees, picture.recurring_charges, picture.deposit_requirements]) {
    for (const c of [...(blk.published || []), ...(blk.drafts || [])]) governedByCode.set(c.charge_code, c);
  }
  const CODE_FOR = {
    pricing_application_fee: "fee.application", pricing_admin_fee: "fee.administration",
    pricing_amenity_fee: "fee.amenity", pricing_telecom_fee: "fee.telecom",
    parking_pricing: "recurring.parking", pet_policy: "recurring.pet_rent",
    utilities: "recurring.wifi", renters_insurance: "recurring.insurance_programme",
    pricing_security_deposit: "deposit.security_requirement",
  };

  for (const [scenario, key] of FACT_SCENARIOS) {
    const f = byKey.get(key);
    const g = governedByCode.get(CODE_FOR[key]);
    if (!f) { rows.push(row({ scenario, governed_disposition: "unavailable",
      cannot_survive_cutover_because: "the live fact no longer exists" })); continue; }

    const govAmount = g && g.record_state === "active" && g.quotable_precisely ? g.amount : null;
    rows.push(row({
      scenario,
      current_answer: f.amount ?? null, current_source: "agent_facts", current_says: f.text,
      governed_answer: govAmount,
      governed_source: g ? "property_governed_charges" : null,
      governed_state: !g ? "known_but_not_yet_quotable"
        : g.record_state === "draft" ? "draft_no_operating_effect"
        : g.quotable_precisely ? "known_and_quotable" : "unresolved",
      dollar_difference: f.amount != null && govAmount != null
        ? Math.round((govAmount - f.amount) * 100) / 100 : null,
      cadence_difference: g && f.cadence && g.cadence !== f.cadence
        ? `live=${f.cadence} governed=${g.cadence}` : null,
      applicability_difference: g && g.applicability_basis !== (f.applicability || null)
        ? `live="${f.applicability || "unstated"}" governed="${g.applicability_basis}"` : null,
      required_vs_optional_difference: g && f.required != null && ((f.required && g.obligation !== "required")
        || (!f.required && g.obligation === "required"))
        ? `live=${f.required ? "required" : "optional"} governed=${g.obligation}` : null,
      source_difference: g ? "agent_facts vs property_governed_charges" : "agent_facts only",
      unsupported_precision: f.unresolved
        ? { kind: "unresolved_value_quoted_as_prose", detail: f.unresolved } : null,
      // Both sides quotable at once is the state that must never ship.
      duplicate_ownership: (f.ai_quotes_today && g && g.record_state === "active" && g.quotable_precisely)
        ? { severity: "blocking", detail: `${key} would be quotable from agent_facts AND ${g.charge_code} ` +
            `at the same time. Retirement must land in the same release as publication.` }
        : null,
      governed_disposition: !g ? "refused" : g.record_state === "draft" ? "partial"
        : g.quotable_precisely ? "governed" : "partial",
      cannot_survive_cutover_because: f.verdict === "consistent_and_governed"
        ? (g ? null : "no governed replacement exists yet")
        : `the live fact is graded ${f.verdict}: ${f.unresolved || f.note}`,
    }));
  }

  // ── 16–19. concession profiles ───────────────────────────────────
  for (const [scenario, input] of CONCESSION_SCENARIOS) {
    const r = compileSchedule(input);
    rows.push(row({
      scenario: `concession:${scenario}`,
      current_answer: null, current_source: "none",
      current_says: "The live agent cannot offer a concession — no concession is published.",
      governed_answer: r.ok ? r.total_credit : null,
      governed_source: r.ok ? "concession_schedule_compiler" : null,
      governed_state: r.ok ? "reproducible_dated_lines" : "refused",
      source_difference: "live has no concession source at all",
      governed_disposition: r.ok ? "governed" : "refused",
      cannot_survive_cutover_because: r.ok
        ? "Compiles to dated lines, but NO concession is published, so nothing is advertised."
        : `refused: ${r.code}`,
    }));
  }

  // ── 20–23. the four named positions ──────────────────────────────
  const namedPositions = (await pool.query(
    `select u.unit_number, u.unit_type_id, u.operating_use, u.is_down, s.use_type
       from units u join spaces s on s.unit_id = u.id
      where u.property_id=$1 and u.unit_number in ('101','214','530')`, [property_id])).rows;
  for (const u of namedPositions) {
    const label = u.unit_number === "101" ? "unclassified_unit_101"
      : u.unit_number === "214" ? "model_unit_214" : "activation_pending_unit_530";
    rows.push(row({
      scenario: label,
      current_answer: null, current_source: "units.market_rent",
      current_says: "The live path would consider this unit if it appeared available.",
      governed_answer: null, governed_source: null,
      governed_state: !u.unit_type_id ? "not_applicable"
        : (u.operating_use && u.operating_use !== "standard") ? "not_applicable"
        : "known_but_not_yet_quotable",
      governed_disposition: "refused",
      cannot_survive_cutover_because: !u.unit_type_id
        ? "No governed unit type — it can receive no type economics at all."
        : (u.operating_use && u.operating_use !== "standard")
          ? `Held out of inventory by operating designation '${u.operating_use}'.`
          : "Excluded by availability, not by economics — economic information does not make it offerable.",
    }));
  }
  const comm = picture.base_rent.types.find((t) => t.offer_state === "not_applicable_to_residential_pricing");
  rows.push(row({ scenario: "commercial_space",
    current_answer: 0, current_source: "units.market_rent",
    current_says: "The legacy column carries $0 for the commercial space.",
    governed_answer: null, governed_source: null, governed_state: "not_applicable",
    governed_disposition: "refused",
    unsupported_precision: { kind: "legacy_zero_would_read_as_a_price",
      detail: "A numeric 0 in the legacy column is not a free unit; it is an absent decision." },
    cannot_survive_cutover_because: "Not residential inventory — it has no residential pricing decision." }));

  // ── 24. another property ─────────────────────────────────────────
  if (other_property_id) {
    const other = await effectiveEconomicPicture(pool, { property_id: other_property_id });
    rows.push(row({ scenario: "another_property",
      current_answer: null, current_source: "units.market_rent",
      governed_answer: null, governed_source: "property_pricing_versions",
      governed_state: other.base_rent.unresolved_reason || "no_published_pricing_version",
      governed_disposition: "refused",
      cannot_survive_cutover_because:
        "That property has no governed economics and nobody holds authority on it. Cutover is " +
        "per-property; Demo Building's readiness confers nothing elsewhere." }));
  }

  // ── 25. failed economic read ─────────────────────────────────────
  const deadPool = { query: async () => { throw new Error("simulated economic read failure"); } };
  const dead = await effectiveEconomicPicture(deadPool, { property_id });
  rows.push(row({ scenario: "failed_economic_read",
    current_answer: null, current_source: "units.market_rent",
    current_says: "The live path would still answer from whatever it last read.",
    governed_answer: null, governed_source: null,
    governed_state: dead.completeness.overall,
    governed_disposition: "unavailable",
    cannot_survive_cutover_because:
      "A failed governed read returns UNAVAILABLE for every class rather than falling back to a " +
      "cached or sample number. That is the correct behaviour and it is the difference from the " +
      "live path." }));

  const n = (f) => rows.filter(f).length;
  return {
    property_id, mode: "shadow", sent_anything: false,
    guarantees: ["no outbound message", "no comm_event", "no conversation mutated",
                 "no person, obligation, offer or lease economic line created",
                 "no pricing version or charge published"],
    live_path_note: "The live side is MODELLED from the two sources agent.js reads " +
                    "(units.market_rent ordered ascending, and the approved fact set).",
    comparisons: rows,
    summary: {
      compared: rows.length,
      dollar_disagreements: n((r) => r.dollar_difference != null && r.dollar_difference !== 0),
      cadence_disagreements: n((r) => r.cadence_difference),
      applicability_disagreements: n((r) => r.applicability_difference),
      required_vs_optional_disagreements: n((r) => r.required_vs_optional_difference),
      unsupported_precision: n((r) => r.unsupported_precision),
      duplicate_ownership_blocking: n((r) => r.duplicate_ownership),
      governed_refused: n((r) => r.governed_disposition === "refused"),
      governed_partial: n((r) => r.governed_disposition === "partial"),
      governed_ready: n((r) => r.governed_disposition === "governed"),
      cannot_survive_cutover: n((r) => r.cannot_survive_cutover_because),
    },
  };
}

module.exports = { economicShadowReport, FACT_SCENARIOS, CONCESSION_SCENARIOS };
