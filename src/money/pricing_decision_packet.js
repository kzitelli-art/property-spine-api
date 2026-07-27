// ════════════════════════════════════════════════════════════════════
//  pricing_decision_packet.js — THE INITIAL PRICING DECISION PACKET
//
//  The surface ownership uses to approve version one WITHOUT GUESSING.
//  Read-only and preview-only: it writes nothing and publishes nothing.
//
//  ── PRICING IS INVENTORY PACING, NOT A RENT TABLE ────────────────────
//  A rent table asks "what is a 1 Bed worth?". Pacing asks "how many 1 Beds
//  come open in 90 days, and what does that do to the number?". A type with
//  1 position opening and a type with 40 opening are not the same decision
//  even when the evidence is identical, so the packet leads with exposure and
//  puts evidence underneath it.
//
//  ── IT RECOMMENDS NOTHING ────────────────────────────────────────────
//  Every number is labelled with where it came from and how strong the claim
//  is. There is deliberately no `suggested_rent`. A legacy range and a client
//  store are not evidence for a price — presenting either as a recommendation
//  would launder an unauthored number into an authored one, which is the
//  precise failure this whole slice exists to prevent.
//
//  Derivations are BORROWED, never repeated: positions and successor state
//  come from datedPropertyPositions, marketability from availabilityRead,
//  offer state from effectivePropertyPricing. If those disagree with this
//  packet, the packet is wrong.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions } = require("../tenancy/dated_positions");
const { availabilityRead } = require("../surfaces/availability_read");
const { effectivePropertyPricing } = require("./effective_pricing");
const { moneyFactContradictions } = require("./money_fact_contradictions");
const { representability } = require("./economic_classes");

const addDays = (ymd, n) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function stats(values) {
  const v = values.filter((x) => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!v.length) return { count: 0, min: null, max: null, median: null, spread: null };
  const mid = Math.floor(v.length / 2);
  return {
    count: v.length,
    min: v[0],
    max: v[v.length - 1],
    median: v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2),
    spread: v[v.length - 1] - v[0],
  };
}

// Floor from a unit number is a DISPLAY convention, not a governed attribute.
// It is used only to test whether a spread lines up with floor, and the
// finding says so — it is never allowed to become a pricing input.
const floorOf = (unitNumber) => {
  const m = String(unitNumber || "").match(/^(\d)\d{2}$/);
  return m ? Number(m[1]) : null;
};

/** Does a value vary meaningfully across a grouping? Reported, never acted on. */
function groupBreakdown(rows, keyFn, valueFn) {
  const g = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(valueFn(r));
  }
  return [...g.entries()]
    .map(([k, vals]) => ({ key: k, ...stats(vals) }))
    .sort((a, b) => (a.key > b.key ? 1 : -1));
}

async function pricingDecisionPacket(pool, { property_id, as_of = null, horizon_days = 90 } = {}) {
  if (!property_id) throw new Error("pricingDecisionPacket requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const future = addDays(asOf, horizon_days);

  // ── borrowed canonical derivations ────────────────────────────────
  const [today, ahead, avail, pricing, contradictions] = await Promise.all([
    datedPropertyPositions(pool, { property_id, as_of: asOf }),
    datedPropertyPositions(pool, { property_id, as_of: future }),
    availabilityRead(pool, { property_id, as_of: asOf, horizon_days }),
    effectivePropertyPricing(pool, { property_id, as_of: asOf }),
    moneyFactContradictions(pool, { property_id }),
  ]);

  const aheadBySpace = new Map(ahead.positions.map((p) => [String(p.space_id), p]));
  const availBySpace = new Map((avail.rows || []).map((r) => [String(r.space_id), r]));

  // ── structural attributes + legacy evidence, per position ─────────
  const attrs = new Map((await pool.query(
    `select s.id as space_id, u.unit_number, u.square_feet, u.market_rent,
            u.unit_type_id, u.bedrooms, u.bathrooms, s.use_type
       from spaces s join units u on u.id = s.unit_id
      where u.property_id = $1`, [property_id]
  )).rows.map((r) => [String(r.space_id), r]));

  // Executed native rents: the only rents in the system that were both
  // executed and funded. These are the strongest evidence available, and on
  // this property there are none — which is itself the finding.
  const nativeRents = (await pool.query(
    `select u.unit_type_id, l.rent, l.start_date
       from leases l join spaces s on s.id = l.space_id join units u on u.id = s.unit_id
      where u.property_id = $1 and l.rent is not null
        and l.economic_tenancy_activated_at is not null
      order by l.start_date desc`, [property_id]
  )).rows;

  const byType = new Map();
  const ensure = (id) => {
    const k = String(id);
    if (!byType.has(k)) byType.set(k, { positions: [], native: [] });
    return byType.get(k);
  };
  for (const p of today.positions) {
    const a = attrs.get(String(p.space_id)) || {};
    ensure(a.unit_type_id).positions.push({ ...p, _a: a });
  }
  for (const n of nativeRents) ensure(n.unit_type_id).native.push(n);

  // ── one decision row per governed unit type ───────────────────────
  const rows = pricing.unit_types.map((ty) => {
    const bucket = byType.get(String(ty.unit_type_id)) || { positions: [], native: [] };
    const ps = bucket.positions;
    const residential = ps.filter((p) => (p._a.use_type || null) === "residential");

    const lockedNow = residential.filter((p) => p.tenancy_state === "contractually_occupied");
    const lockedAhead = residential.filter((p) => {
      const f = aheadBySpace.get(String(p.space_id));
      return f && f.tenancy_state === "contractually_occupied";
    });
    const pendingSuccessors = residential.filter((p) => p.successor && p.successor.state === "pending");
    const marketableNow = residential.filter((p) => {
      const r = availBySpace.get(String(p.space_id));
      return r && r.marketing_state === "marketable_now";
    });

    // "Uncovered" is the pacing number: residential positions with no
    // contractual cover at the horizon. It is deliberately NOT called
    // "vacant" — a position can be uncovered and unmarketable at once.
    const uncoveredAhead = residential.length - lockedAhead.length;

    const inPlace = stats(lockedNow.map((p) => p.current_rent));
    const nativeStats = stats(bucket.native.map((n) => n.rent));
    const legacy = stats(residential.map((p) => p._a.market_rent));

    const applicable = ty.offer_state !== "not_applicable_to_residential_pricing";

    const missing = [];
    if (applicable) {
      missing.push("new_lease_rent", "renewal_rent", "lease_terms");
      if (!nativeStats.count) missing.push("native_executed_evidence");
    }

    return {
      unit_type_id: ty.unit_type_id,
      code: ty.code,
      label: ty.label,
      offer_state: ty.offer_state,
      requires_pricing_decision: ty.requires_pricing_decision,

      // ── INVENTORY PACING — the decision context, stated first ──
      pacing: {
        total_positions: ps.length,
        residential_positions: residential.length,
        contractually_locked_today: lockedNow.length,
        contractually_locked_at_horizon: lockedAhead.length,
        pending_successors: pendingSuccessors.length,
        uncovered_at_horizon: uncoveredAhead,
        marketable_now: marketableNow.length,
        horizon_days,
        horizon_date: future,
        exposure_note: !applicable ? null
          : uncoveredAhead === 0
            ? "Fully covered at the horizon. A price here sets the renewal posture, not absorption."
            : `${uncoveredAhead} of ${residential.length} positions carry no contractual cover at ${future}.`,
      },

      // ── EVIDENCE, each labelled with its own claim strength ──
      evidence: {
        in_place_contractual_rent: {
          ...inPlace, claim: "proven_executed_lease",
          note: "What was agreed, sometimes years ago. Evidence for a judgment, never the judgment.",
        },
        native_executed_rent: nativeStats.count ? { ...nativeStats, claim: "native_verified" } : {
          count: 0, claim: "none",
          note: "No lease on this type has been both executed and funded through the system. " +
                "The strongest possible evidence does not exist yet.",
        },
        legacy_market_rent: {
          ...legacy, claim: "unproven",
          disposition: "evidence_only_never_an_offer",
          note: "units.market_rent — no author, no date, no approval. Shown so the spread is " +
                "visible, not so it can be adopted.",
        },
        client_store_new_lease_candidate: null,
        client_store_renewal_candidate: null,
        client_store_status: "unavailable_server_side",
        client_store_note:
          "window.__pricingStore is a browser object with no server row. It is now structurally " +
          "retired on signed-in surfaces and returns zero types, so there is no candidate to " +
          "carry forward — and a value that only ever existed in one operator's tab could not " +
          "have been one.",
      },

      // ── CANDIDATES — what a version would have to state ──
      candidate_lease_terms: { value: null, status: "not_decided", provenance: null },
      candidate_advertised_concessions: {
        value: [], status: "blocked",
        reason: "schedule_line_engine_not_activated",
      },

      existing_recurring_charges: contradictions.facts
        .filter((f) => f.economic_class === "recurring_charge")
        .map((f) => ({ fact_key: f.fact_key, amount: f.amount, cadence: f.cadence, verdict: f.verdict })),
      existing_one_time_fees: contradictions.facts
        .filter((f) => f.economic_class === "one_time_fee")
        .map((f) => ({ fact_key: f.fact_key, amount: f.amount, unresolved: f.unresolved || null, verdict: f.verdict })),

      missing_decisions: missing,
      provenance: {
        pacing: "datedPropertyPositions (today and horizon) + availabilityRead",
        in_place_rent: "leases.rent on contractually occupied positions",
        native_rent: "leases with economic_tenancy_activated_at set",
        legacy: "units.market_rent",
        fees: "agent_facts (transitional external)",
      },
    };
  });

  // ── spread analysis, for every type that has one ──────────────────
  const spreadAnalysis = pricing.unit_types
    .filter((ty) => ty.offer_state !== "not_applicable_to_residential_pricing")
    .map((ty) => {
      const bucket = byType.get(String(ty.unit_type_id)) || { positions: [] };
      const residential = bucket.positions.filter((p) => (p._a.use_type || null) === "residential");
      const legacy = stats(residential.map((p) => p._a.market_rent));
      if (!legacy.count || legacy.spread === 0) {
        return { unit_type_id: ty.unit_type_id, label: ty.label, ...legacy, explained_by: legacy.count ? "no_spread" : "no_data", breakdowns: null };
      }

      const bySqft = groupBreakdown(residential,
        (p) => (p._a.square_feet == null ? null : Math.round(p._a.square_feet / 50) * 50),
        (p) => p._a.market_rent);
      const byFloor = groupBreakdown(residential, (p) => floorOf(p._a.unit_number), (p) => p._a.market_rent);
      const byLeaseYear = groupBreakdown(residential,
        (p) => (p.lease && p.lease.start_date ? String(p.lease.start_date).slice(0, 4) : null),
        (p) => p._a.market_rent);

      // Discreteness is the honest observation available without a model: a
      // spread made of three exact values is a COHORT structure; a spread made
      // of many distinct values is not. This does not claim to know why.
      const distinct = [...new Set(residential.map((p) => Number(p._a.market_rent)).filter(Number.isFinite))].sort((a, b) => a - b);
      const histogram = distinct.map((v) => ({
        value: v, positions: residential.filter((p) => Number(p._a.market_rent) === v).length,
      }));

      return {
        unit_type_id: ty.unit_type_id, label: ty.label, ...legacy,
        distinct_values: distinct.length,
        histogram,
        breakdowns: { by_square_feet: bySqft, by_floor: byFloor, by_lease_start_year: byLeaseYear },
        // Furnished vs unfurnished is ALREADY a separate governed type, so it
        // cannot be the explanation for a spread inside one type.
        furnished_split_possible: false,
        interpretation_rule:
          "Correlation is reported, never converted into a pricing rule. A determinant must be " +
          "declared by an owner before it can price anything.",
      };
    });

  const applicableTypes = rows.filter((r) => r.offer_state !== "not_applicable_to_residential_pricing");

  return {
    property_id, as_of: asOf, horizon_days, horizon_date: future,
    disposition: "read_only_preview_no_rows_written",

    headline: {
      governed_types: rows.length,
      types_requiring_decision: rows.filter((r) => r.requires_pricing_decision).length,
      types_not_applicable: rows.length - applicableTypes.length,
      residential_positions: applicableTypes.reduce((s, r) => s + r.pacing.residential_positions, 0),
      uncovered_at_horizon: applicableTypes.reduce((s, r) => s + r.pacing.uncovered_at_horizon, 0),
      marketable_now: applicableTypes.reduce((s, r) => s + r.pacing.marketable_now, 0),
      pending_successors: applicableTypes.reduce((s, r) => s + r.pacing.pending_successors, 0),
      unclassified_positions: pricing.completeness.unclassified_positions,
    },

    unit_types: rows,
    spread_analysis: spreadAnalysis,
    money_facts: contradictions,
    economic_classes: representability(),

    // Explicitly absent, so nobody mistakes silence for "no market evidence
    // was relevant". The decision and authority model must be stable before
    // observations are allowed to influence it.
    market_evidence: {
      status: "unavailable",
      reason: "governed_market_observations_not_built",
      detail: "No governed market observation model exists. Competitor rents and survey " +
              "observations may inform judgment upstream, but none may become pricing, and none " +
              "are read here.",
    },

    proof: {
      derivations_borrowed: ["datedPropertyPositions", "availabilityRead", "effectivePropertyPricing"],
      recommends_nothing: true,
      never_reads: ["window.__pricingStore", "rent_survey_observations"],
    },
  };
}

module.exports = { pricingDecisionPacket, stats, floorOf };
