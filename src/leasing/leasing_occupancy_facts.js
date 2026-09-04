const { spanningLeaseSql } = require("../tenancy/position_classifier");
const SPAN = spanningLeaseSql("l");
// ── leasing_occupancy_facts.js ───────────────────────────────────────────────
// THE ONE neutral, lower-level occupancy calculation. It is deliberately NOT an
// endpoint aggregate — it is a primitive that higher-level readers depend on:
//
//   desks.js                    ──▶ leasing_occupancy_facts.js
//   leasing_condition_facts.js  ──▶ leasing_occupancy_facts.js
//
// This keeps the longstanding desk builder from depending on a newer
// endpoint-specific aggregate. One implementation, correct dependency direction.
//
// GRAIN-AWARE: occupancy respects the property's canonical basis
// (properties.leasing_basis):
//   - 'unit'        → occupied units  ÷ rentable units
//   - 'space'|'bed' → occupied spaces ÷ rentable spaces
// The basis is returned explicitly. Percentages/ratios are numeric (no display
// strings) — presentation belongs to callers.
//
// UNKNOWN BASIS FAILS HONESTLY: an absent or unrecognized leasing_basis does NOT
// silently default to unit grain. It returns a status:'unavailable' occupancy
// with an explicit reason, so a misconfigured property surfaces as unknown
// rather than as a confidently-wrong unit number.
//
// RENTABLE EXCLUSIONS (governed, per grain):
//   - SPACE/BED grain: non-revenue spaces (model/down/offline) are excluded from
//     rentable via the space_label. This is the ALREADY-ESTABLISHED read-model
//     behavior (management-read). NOTE: it is LABEL-DERIVED, not a normalized
//     status column — a future normalization seam. Documented, not silently
//     changed.
//   - UNIT grain: NO exclusions are applied. All units count as rentable and
//     exclusions_governed=false. We do NOT infer a governed exclusion rule from
//     the mere existence of a column named status/unit_status/availability_status
//     — schema shape is not domain semantics, and occupancy must not silently
//     change when a column appears. When a canonical unit inventory-status field
//     and its allowed exclusion values are formally established, that rule is
//     wired EXPLICITLY here in reviewed code with its own tests — never
//     auto-activated.

// Label rule for non-revenue SPACES only (established, label-derived, and a known
// future normalization seam). Never applied to units.
const NON_REVENUE_SPACE_LABEL = /model|down|offline/i;

// Canonical vocabulary for a basis. Beds are a space grain; the noun differs.
function unitNounForBasis(basis) {
  if (basis === 'space') return 'spaces';
  if (basis === 'bed') return 'beds';
  return 'units';
}

async function occupancyByBasis(pool, propertyId) {
  const propRow = (await pool.query(
    `select leasing_basis from properties where id = $1`, [propertyId])).rows[0];
  const rawBasis = (propRow && propRow.leasing_basis != null)
    ? String(propRow.leasing_basis).toLowerCase().trim() : null;

  // Resolve to a KNOWN basis, or fail honestly. No silent default to unit.
  let basis = null;
  if (rawBasis === 'unit' || rawBasis === 'by_unit') basis = 'unit';
  else if (rawBasis === 'space' || rawBasis === 'by_space') basis = 'space';
  else if (rawBasis === 'bed' || rawBasis === 'by_bed') basis = 'bed';

  if (basis === null) {
    // Unknown / absent / unsupported basis → unavailable, with the reason.
    return {
      status: 'unavailable',
      reason: (rawBasis == null) ? 'leasing_basis_not_set' : 'leasing_basis_unsupported',
      raw_basis: rawBasis,
      basis: null, unit_noun: null,
      occupied_count: null, rentable_count: null,
      excluded_count: null, exclusions_governed: null,
      occupancy_ratio: null, occupancy_pct: null,
    };
  }

  const isSpaceGrain = (basis === 'space' || basis === 'bed');

  if (isSpaceGrain) {
    // Space/bed grain: one row per space; rentable excludes non-revenue spaces
    // (LABEL-DERIVED — established read-model behavior; future normalization seam).
    const rows = (await pool.query(
      `select s.id as space_id, s.space_label,
              exists (select 1 from leases l
                        where l.space_id = s.id and l.lease_status = 'active' and ${SPAN}) as occupied
         from spaces s
         join units u on u.id = s.unit_id
        where u.property_id = $1`, [propertyId])).rows;
    let rentable = 0, occupied = 0, excluded = 0;
    for (const r of rows) {
      const label = r.space_label || '';
      if (NON_REVENUE_SPACE_LABEL.test(label)) { excluded += 1; continue; }
      rentable += 1;
      if (r.occupied) occupied += 1;
    }
    const ratio = rentable > 0 ? occupied / rentable : null;
    return {
      status: 'ok',
      basis, unit_noun: unitNounForBasis(basis),
      occupied_count: occupied, rentable_count: rentable,
      excluded_count: excluded,
      exclusions_governed: true,                 // space rule is established...
      exclusions_source: 'space_label',          // ...but label-derived (seam).
      occupancy_ratio: ratio,
      occupancy_pct: ratio == null ? null : Math.round(ratio * 1000) / 10,
    };
  }

  // Unit grain. NO exclusions — all units are rentable. We do not inspect the
  // schema for a status column; occupancy does not change when a column appears.
  const r = (await pool.query(
    `select
       (select count(*)::int from units where property_id = $1) as rentable_units,
       (select count(distinct s.unit_id)::int
          from leases l join spaces s on s.id = l.space_id
         where l.property_id = $1 and l.lease_status = 'active' and ${SPAN}) as occupied_units`,
    [propertyId])).rows[0];
  const rentable = Number(r && r.rentable_units) || 0;
  const occupied = Number(r && r.occupied_units) || 0;
  const ratio = rentable > 0 ? occupied / rentable : null;
  return {
    status: 'ok',
    basis, unit_noun: unitNounForBasis(basis),
    occupied_count: occupied, rentable_count: rentable,
    excluded_count: 0,
    exclusions_governed: false,   // no canonical unit inventory-status rule established
    exclusions_source: null,
    occupancy_ratio: ratio,
    occupancy_pct: ratio == null ? null : Math.round(ratio * 1000) / 10,
  };
}

module.exports = { occupancyByBasis, unitNounForBasis };

