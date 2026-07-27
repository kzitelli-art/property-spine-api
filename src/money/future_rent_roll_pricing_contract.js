// ════════════════════════════════════════════════════════════════════
//  future_rent_roll_pricing_contract.js — HOW PRICING WOULD APPLY, LATER
//
//  READ-ONLY PREVIEW. It does not touch the Future Rent Roll, does not change
//  any total, and is not wired into it. It proves the RULE.
//
//  ── THE PERMANENT RULE ───────────────────────────────────────────────
//      locked contractual lease      → actual contractual economics
//      unlocked renewal position     → published renewal pricing + approved assumptions
//      unlocked new-leasing position → published new-lease pricing + approved assumptions
//
//  ── THE HALF THAT DOES NOT EXIST ─────────────────────────────────────
//  "+ approved assumptions" is doing real work in those last two lines, and
//  there are no approved assumptions. No renewal-capture rate, no
//  downtime-between-tenancies rule, no target occupancy. So an unlocked
//  position cannot be given a projected dollar even once pricing is published:
//  published pricing says what we would ASK, and an assumption says how much of
//  it we would GET. This preview returns published pricing as the ASK and
//  honest absence for the rest, rather than quietly treating ask as receipt.
//
//  ── PRICING CANNOT CREATE OCCUPANCY ──────────────────────────────────
//  The most dangerous available mistake is multiplying an asking rent by an
//  uncovered position and calling the product revenue. That turns a price
//  decision into forecast income and would flow straight into the lender
//  package. Every uncovered position here carries a projected value of null.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions } = require("../tenancy/dated_positions");
const { effectivePropertyPricing } = require("./effective_pricing");
const { governedCharges } = require("./governed_charges");

const ELIGIBLE_STATUS = "published";

async function futureRentRollPricingPreview(pool, { property_id, as_of = null, horizon_date = null } = {}) {
  if (!property_id) throw new Error("futureRentRollPricingPreview requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const at = horizon_date || asOf;

  const [positions, pricingAtDate, chargesAtDate] = await Promise.all([
    datedPropertyPositions(pool, { property_id, as_of: at }),
    // Effective pricing is resolved AT THE PROJECTION DATE, not today. A
    // future-dated version therefore applies only inside its own period, and
    // today's quote is unaffected by a version that has not started.
    effectivePropertyPricing(pool, { property_id, as_of: at }),
    governedCharges(pool, { property_id, as_of: at }),
  ]);

  const typeById = new Map(pricingAtDate.unit_types.map((t) => [String(t.unit_type_id), t]));
  const attrs = new Map((await pool.query(
    `select s.id space_id, u.unit_type_id, s.use_type from spaces s
       join units u on u.id=s.unit_id where u.property_id=$1`, [property_id])).rows
    .map((r) => [String(r.space_id), r]));

  const rows = positions.positions.map((p) => {
    const a = attrs.get(String(p.space_id)) || {};
    const type = a.unit_type_id ? typeById.get(String(a.unit_type_id)) : null;

    // ── 1. LOCKED FACTS ARE NEVER REPRICED ────────────────────────
    if (p.tenancy_state === "contractually_occupied" && p.current_rent != null) {
      return {
        space_id: p.space_id, unit_number: p.unit_number,
        disposition: "locked_contractual",
        basis: "executed_lease",
        projected_rent: Number(p.current_rent),
        pricing_applied: false,
        reason: "A signed lease states its own economics. Published pricing does not touch it.",
      };
    }

    // ── 2. CONTESTED AND PENDING GET NOTHING ──────────────────────
    if (p.conflict_state === "conflicted") {
      return { space_id: p.space_id, unit_number: p.unit_number, disposition: "contested",
        basis: null, projected_rent: null, pricing_applied: false,
        reason: "Overlapping lease claims. A contested position has no single truth to price." };
    }
    if (p.successor && p.successor.state === "pending") {
      return { space_id: p.space_id, unit_number: p.unit_number, disposition: "pending_successor",
        basis: null, projected_rent: null, pricing_applied: false,
        reason: "A successor exists but is not locked. Pricing it would double-count against the " +
                "successor's own economics once it locks." };
    }

    // ── 3. UNCLASSIFIED GETS NO TYPE ASSUMPTION ───────────────────
    if (!a.unit_type_id) {
      return { space_id: p.space_id, unit_number: p.unit_number, disposition: "unclassified",
        basis: null, projected_rent: null, pricing_applied: false,
        reason: "No governed unit type, so no type-based pricing can be applied to it." };
    }
    if ((a.use_type || null) !== "residential") {
      return { space_id: p.space_id, unit_number: p.unit_number, disposition: "not_residential",
        basis: null, projected_rent: null, pricing_applied: false,
        reason: "Outside residential pricing." };
    }

    // ── 4. UNCOVERED: the ASK is known, the RECEIPT is not ─────────
    const isRenewal = !!(p.notice_state && p.notice_state !== "none") || p.tenancy_state === "contractually_occupied";
    const kind = isRenewal ? "unlocked_renewal" : "unlocked_new_leasing";
    if (!pricingAtDate.published_version) {
      return { space_id: p.space_id, unit_number: p.unit_number, disposition: kind,
        basis: null, projected_rent: null, pricing_applied: false,
        reason: "no_published_pricing_version_effective_at_this_date" };
    }
    const terms = (type && type.terms) || [];
    const ask = terms.length
      ? (isRenewal ? terms[0].renewal_rent : terms[0].new_lease_rent)
      : null;

    return {
      space_id: p.space_id, unit_number: p.unit_number, disposition: kind,
      basis: ask == null ? null : "published_pricing_ask",
      published_ask: ask == null ? null : Number(ask),
      // THE POINT: an ask is not a receipt.
      projected_rent: null,
      pricing_applied: false,
      reason: ask == null
        ? "The published version does not state a rent for this type and intent."
        : "assumption_set_not_built — published pricing states what would be ASKED. Converting " +
          "that into projected revenue needs a renewal-capture or absorption assumption, and none " +
          "is approved. Pricing alone cannot create occupancy.",
    };
  });

  const count = (d) => rows.filter((r) => r.disposition === d).length;
  return {
    property_id, as_of: asOf, projection_date: at,
    disposition: "read_only_contract_preview_not_wired_into_future_rent_roll",
    eligible_version_status: ELIGIBLE_STATUS,
    published_version_at_date: pricingAtDate.published_version
      ? pricingAtDate.published_version.version_id : null,

    rows,
    summary: {
      total: rows.length,
      locked_contractual: count("locked_contractual"),
      unlocked_renewal: count("unlocked_renewal"),
      unlocked_new_leasing: count("unlocked_new_leasing"),
      pending_successor: count("pending_successor"),
      contested: count("contested"),
      unclassified: count("unclassified"),
      not_residential: count("not_residential"),
      repriced_locked_positions: rows.filter((r) => r.disposition === "locked_contractual" && r.pricing_applied).length,
      positions_given_projected_pricing: rows.filter((r) => r.projected_rent != null && r.disposition !== "locked_contractual").length,
    },

    // ── THE ECONOMIC STACK, kept in separate lines ─────────────────
    //   base contractual rent
    // + recurring contractual charges
    // − dated concession lines
    // = scheduled recurring economics
    // One-time fees, deposits and credits stay OUT of that sum, because each
    // would misstate recurring economics in a different direction.
    economic_stack: {
      base_contractual_rent: {
        source: "executed leases for locked positions; published pricing is an ASK, never revenue",
        locked_total: rows.filter((r) => r.disposition === "locked_contractual")
          .reduce((s, r) => s + Number(r.projected_rent || 0), 0),
      },
      recurring_contractual_charges: {
        governed_count: (chargesAtDate.recurring_charges || []).length,
        required_and_quotable: (chargesAtDate.recurring_charges || [])
          .filter((c) => c.obligation === "required" && c.quotable_precisely).length,
        included_in_projection: 0,
        reason: (chargesAtDate.recurring_charges || []).length === 0
          ? "no_governed_recurring_charge_published"
          : "optional_and_conditional_charges_are_never_assumed",
        rule: "A recurring charge stays SEPARATELY IDENTIFIABLE from base rent. An optional charge " +
              "is never assumed onto a position, and a conditional charge applies only when its " +
              "condition is governed AND true — neither is knowable for an unlocked position.",
      },
      dated_concession_lines: {
        included: 0,
        reason: "no_published_concession",
        rule: "A concession reduces economics ONLY through dated lines produced by the compiler. " +
              "Effective rent is derived from those lines, never asserted beside them.",
      },
      scheduled_recurring_economics: {
        value: null,
        reason: "requires_approved_assumptions_for_unlocked_positions",
      },
      // Deliberately OUTSIDE the recurring sum.
      excluded_from_recurring: {
        one_time_fees: { count: (chargesAtDate.one_time_fees || []).length,
          treatment: "transaction economics — never annualized into rent" },
        deposit_required: { count: (chargesAtDate.deposit_requirements || []).length,
          treatment: "contractual requirement — contributes ZERO revenue" },
        deposit_held: { treatment: "Money liability — contributes ZERO revenue, and is not in this catalog" },
        one_time_credit: { treatment: "dated economic adjustment — never a rent reduction" },
      },
    },

    assumptions: {
      status: "unavailable",
      reason: "approved_assumption_set_not_built",
      required_before_projection: [
        "renewal_capture_rate", "downtime_between_tenancies", "absorption_pace",
      ],
      detail: "Each is a separate approved decision. Until they exist, an uncovered position " +
              "projects to null rather than to an asking rent.",
    },

    invariants_asserted: [
      "a locked lease is never repriced",
      "a pending successor receives zero projected pricing",
      "a contested position receives zero projected pricing",
      "an unclassified position receives no type-based assumption",
      "pricing is resolved AT the projection date, so a future-dated version does not affect today",
      "only a published version is eligible — a draft is invisible to this preview",
      "pricing alone cannot create occupancy",
    ],
  };
}

module.exports = { futureRentRollPricingPreview, ELIGIBLE_STATUS };
