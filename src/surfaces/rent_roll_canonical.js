// ════════════════════════════════════════════════════════════════════
//  rent_roll_canonical.js — CURRENT RENT ROLL (canonical read)
//
//  One of four interpretations of datedPropertyPositions. This one asks:
//  what is true TODAY? It adds totals and exception counts. It derives no
//  position fact of its own.
//
//  THE AGGREGATION CONTRACT — a position contributes to a headline economic
//  total AT MOST ONCE. Categories are mutually exclusive by precedence
//  (see dated_positions.js). Here is what each total is allowed to include:
//
//    contractual_rent_trusted   contractually_occupied ONLY. One trusted
//                               spanning lease per uncontested position.
//                               Never market_rent. Never two overlapping
//                               leases. Contested contributes ZERO.
//    contested_claims           the competing lease claims, returned
//                               separately with the rent they implicate, so
//                               the money is visible without being counted
//                               and no lease is chosen silently.
//    resolved_leasable          the denominator: leasable positions whose
//                               occupancy is actually resolved. down and
//                               non_revenue are NOT silently included;
//                               contested and evidence_disagrees are
//                               excluded and reported beside it.
//
//  economics_unavailable increments its own count and adds zero to rent —
//  a missing rent is never coerced to $0 at the row level.
//
//  WRITES NOTHING.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions } = require("../tenancy/dated_positions");

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

async function currentRentRoll(pool, { property_id, as_of = null } = {}) {
  const dp = await datedPropertyPositions(pool, { property_id, as_of });
  const today = new Date().toISOString().slice(0, 10);
  const isToday = dp.as_of === today;

  // BALANCE — visible read-only context, owned by Money. Every correction,
  // collection, charge and payment goes through Money or the Person Card;
  // nothing here acts on it. Today's balance is NOT historically accurate on
  // an earlier date, and no dated balance history exists, so a non-current
  // dated view renders it honestly unavailable rather than pretending.
  const balances = new Map();
  if (isToday) {
    const rowsB = (await pool.query(
      `select l.space_id, l.balance, l.updated_at
         from leases l
        where l.property_id=$1 and l.lease_status in ('active','commercial')
          and l.start_date <= $2::date and (l.end_date is null or l.end_date >= $2::date)`,
      [property_id, dp.as_of]
    )).rows;
    for (const b of rowsB) balances.set(String(b.space_id), b);
  }

  const rows = dp.positions.map((p) => {
    const b = balances.get(String(p.space_id));
    return {
      ...p,
      balance: isToday && b && b.balance != null ? Number(b.balance) : null,
      balance_source: isToday && b ? "leases.balance" : null,
      balance_as_of: isToday && b ? (b.updated_at || null) : null,
      balance_unavailable_reason: isToday ? (b && b.balance != null ? null : "no_balance_on_lease")
                                          : "no_dated_balance_history",
    };
  });

  const byTenancy = (s) => rows.filter((r) => r.tenancy_state === s);
  const occupied = byTenancy("contractually_occupied");
  const vacant = byTenancy("vacant");
  const unresolved = byTenancy("unresolved");
  const contested = byTenancy("contested");
  const downRows = rows.filter((r) => r.is_down);
  const noEconomics = rows.filter((r) => r.economics_state === "unavailable");
  const disagrees = rows.filter((r) => r.evidence_state === "disagrees");
  const inconclusive = rows.filter((r) => r.evidence_state === "inconclusive");

  // TRUSTED RENT — every uncontested spanning lease with populated rent,
  // whatever the opening evidence says. Opening evidence being inconclusive
  // or in disagreement does not un-occupy a position that holds a real lease.
  const contractual_rent_trusted = money(
    rows.filter((r) => r.contributes_trusted_rent).reduce((s, r) => s + Number(r.current_rent || 0), 0));

  // The disputed claims, with the rent they implicate. Never counted.
  const contestedSpaceIds = contested.map((r) => r.space_id);
  let contested_claims = { spaces: contestedSpaceIds.length, lease_claims: 0, implicated_rent: 0, claims: [] };
  if (contestedSpaceIds.length) {
    const claims = (await pool.query(
      `select l.id as lease_id, l.space_id, l.lease_status, l.start_date, l.end_date, l.rent
         from leases l
        where l.space_id = any($1::uuid[])
          and l.lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')
        order by l.space_id, l.start_date`, [contestedSpaceIds]
    )).rows;
    contested_claims = {
      spaces: contestedSpaceIds.length,
      lease_claims: claims.length,
      implicated_rent: money(claims.reduce((s, c) => s + Number(c.rent || 0), 0)),
      claims: claims.map((c) => ({
        lease_id: c.lease_id, space_id: c.space_id, lease_status: c.lease_status,
        start_date: c.start_date ? String(c.start_date).slice(0, 10) : null,
        end_date: c.end_date ? String(c.end_date).slice(0, 10) : null,
        rent: c.rent == null ? null : Number(c.rent),
      })),
    };
  }

  const inventory = rows.length;
  // Leasable excludes physically down positions. use_type is not yet a durable
  // field, so non-revenue cannot be excluded honestly — see the schema plan.
  const leasable = inventory - downRows.length;
  const occupancy_denominator = leasable - contested.length;   // contested makes no claim either way

  return {
    property_id: dp.property_id,
    as_of: dp.as_of,
    inventory,
    opening_truth: dp.opening_truth,   // no imported document supplies a headline total

    // FOUR SUMMARIES, each balancing WITHIN ITS OWN AXIS. A position appears
    // once in each — it is not divided between them.
    tenancy_summary: {
      contractually_occupied: occupied.length,
      vacant: vacant.length,
      unresolved: unresolved.length,
      contested: contested.length,
      total: rows.length,
    },
    evidence_summary: {
      confirmed: rows.filter((r) => r.evidence_state === "confirmed").length,
      disagrees: disagrees.length,
      inconclusive: inconclusive.length,
      total: rows.length,
    },
    economics_summary: {
      available: rows.filter((r) => r.economics_state === "available").length,
      unavailable: noEconomics.length,
      not_applicable: rows.filter((r) => r.economics_state === "not_applicable").length,
      total: rows.length,
    },
    proof_summary: {
      native_verified: rows.filter((r) => r.proof_basis === "native_verified").length,
      confirmed_opening_import: rows.filter((r) => r.proof_basis === "confirmed_opening_import").length,
      unproven: rows.filter((r) => r.proof_basis === "unproven").length,
      no_lease: rows.filter((r) => !r.proof_basis).length,
      total: rows.length,
    },

    totals: {
      inventory,
      leasable,
      down: downRows.length,

      // Occupancy from the TENANCY axis only. Evidence and economics do not
      // move a position in or out of it.
      contractual_occupancy: {
        occupied: occupied.length,
        of_leasable_resolved: occupancy_denominator,
        pct: occupancy_denominator ? Math.round(occupied.length / occupancy_denominator * 10000) / 100 : null,
        excluded_from_denominator: { down: downRows.length, contested: contested.length },
        reported_beside: {
          unresolved_positions: unresolved.length,
          evidence_disagrees: disagrees.length,
          evidence_inconclusive: inconclusive.length,
        },
      },

      contractual_rent_trusted,
      contractual_rent_excluded_contested: contested_claims.implicated_rent,
      positions_contributing_rent: rows.filter((r) => r.contributes_trusted_rent).length,
      occupied_without_known_rent: noEconomics.length,
    },

    contested_claims,

    exceptions: {
      evidence_disagrees: disagrees.length,
      evidence_inconclusive: inconclusive.length,
      contested: contested.length,
      economics_unavailable: noEconomics.length,
      unresolved_tenancy: unresolved.length,
      resident_not_linked: rows.filter((r) => r.lease && !r.resident).length,
    },

    rows,
  };
}

module.exports = { currentRentRoll };
