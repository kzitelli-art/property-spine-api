// ── leasing_condition_facts.js ───────────────────────────────────────────────
// The AGGREGATE leasing-condition read backing the /operator/leasing/condition
// endpoint. It composes lower-level facts; it does NOT itself own the occupancy
// calculation. Occupancy comes from the neutral primitive:
//
//   leasing_condition_facts.js  ──▶ leasing_occupancy_facts.js  ◀── desks.js
//
// so the desk builder and this aggregate share ONE occupancy implementation
// without the desk depending on this endpoint-specific aggregate.
//
// MACHINE-READABLE (Fable correction 4): numeric occupancy ratio/pct + explicit
// basis; rent carries amount/currency/period. No display strings.
// TIME PROVENANCE (Fable correction 2): current facts computed now →
// generated_at; forward occupancy carries its OWN snapshot as_of.

const { occupancyByBasis } = require("./leasing_occupancy_facts.js");


// ── in-place rent — actual rent on active leases. Machine-readable money.
async function inPlaceRentFacts(pool, propertyId) {
  const r = (await pool.query(
    `select coalesce(sum(l.rent),0)::numeric as amount,
            count(*)::int as active_leases
       from leases l
      where l.property_id = $1 and l.lease_status = 'active'`, [propertyId])).rows[0];
  const active = Number(r && r.active_leases) || 0;
  // No active leases → honest null amount (not a misleading 0 "rent in place").
  const amount = active > 0 ? Number(r.amount) : null;
  return { amount, currency: 'USD', period: 'month' };
}

// ── forward occupancy — from the latest dated snapshot. Carries its OWN as_of.
async function forwardFromSnapshot(pool, propertyId) {
  try {
    const snap = (await pool.query(
      `select as_of, payload from leasing_snapshots
        where property_id = $1
        order by as_of desc nulls last, uploaded_at desc
        limit 1`, [propertyId])).rows[0];
    if (!snap) return null;
    const p = snap.payload || {};
    const rawPct = (p.headline && p.headline.future_occupancy && p.headline.future_occupancy.count) || null;
    const term = (p.future_rent_roll && p.future_rent_roll.period) || null;
    // Parse "63.4%" → numeric 63.4 (machine-readable); keep null if unparseable.
    let pctNum = null;
    if (rawPct != null) {
      const m = String(rawPct).match(/-?\d+(\.\d+)?/);
      if (m) pctNum = Number(m[0]);
    }
    if (pctNum == null && !term) return null;
    return { occupancy_pct: pctNum, term: term, as_of: snap.as_of || null };
  } catch (_) {
    return null;   // snapshot table/shape optional — honest null on any miss
  }
}

// ── THE canonical leasing-condition facts. Assembles the pieces above.
async function leasingConditionFacts(pool, propertyId) {
  const occ = await occupancyByBasis(pool, propertyId);
  const rent = await inPlaceRentFacts(pool, propertyId);
  const forward = await forwardFromSnapshot(pool, propertyId);

  return {
    property_id: propertyId,
    // Time provenance: current facts computed now; forward carries its own as_of.
    generated_at: new Date().toISOString(),

    current_occupancy: (occ.status === 'unavailable')
      ? {
          // Honest unavailable: leasing_basis absent/unsupported. NOT a silent
          // default to unit grain — the caller/contract sees the reason.
          status: 'unavailable', reason: occ.reason, basis: null, unit_noun: null,
          occupied: null, rentable: null, excluded: null,
          exclusions_governed: null, ratio: null, pct: null,
        }
      : {
          basis: occ.basis,                    // "unit" | "space" | "bed"
          unit_noun: occ.unit_noun,            // "units" | "spaces" | "beds"
          occupied: occ.occupied_count,
          rentable: occ.rentable_count,
          excluded: occ.excluded_count,        // non-revenue excluded from rentable
          exclusions_governed: occ.exclusions_governed,  // false for unit grain (no rule)
          exclusions_source: occ.exclusions_source || null, // "space_label" (label-derived seam) | null
          ratio: occ.occupancy_ratio,          // 0..1 | null
          pct: occ.occupancy_pct,              // numeric, one decimal | null
        },

    in_place_rent: {
      amount: rent.amount,                 // number | null
      currency: rent.currency,             // "USD"
      period: rent.period,                 // "month"
    },

    // Forward occupancy: { occupancy_pct (numeric|null), term, as_of } | null.
    // Its as_of is the SNAPSHOT date — distinct from generated_at above.
    forward_occupancy: forward,

    // Year-over-year rent trend: intentionally not computed (no prior-year
    // source). Explicit unavailable marker so the contract is self-describing.
    yoy_rent_trend: { available: false, reason: 'no_prior_year_source' },
  };
}

module.exports = {
  leasingConditionFacts,
  inPlaceRentFacts,
  forwardFromSnapshot,
  // Note: occupancyByBasis lives in ./leasing_occupancy_facts.js — the neutral
  // primitive. desks.js imports it from THERE, not through this aggregate.
};
