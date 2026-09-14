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
//    occupancy population       non-down, non-contested positions. Unresolved
//                               positions remain in this set without being
//                               called vacant. Evidence is a separate axis.
//                               The numerator counts occupied within this same
//                               set; full tenancy and rent totals remain intact.
//
//  economics_unavailable increments its own count and adds no rent — an
//  unavailable amount is never coerced to $0, including an all-unknown
//  property total.
//
//  WRITES NOTHING.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions } = require("../tenancy/dated_positions");

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

/*  ── A DATE IS A DATE, WHATEVER THE DRIVER HANDED BACK ───────────────
 *  `String(date).slice(0, 10)` is correct for a string and WRONG for a JS
 *  Date: node-postgres returns `date` columns as Date objects unless a type
 *  parser is configured, and none is — so `String(d)` is
 *  "Sat Aug 01 2026 00:00:00 GMT+0000" and the slice yields "Sat Aug 01".
 *  Through the live API a lender read a weekday where a date belonged.
 *
 *  Deliberately NOT a global pg type parser: that would change how every
 *  date in the process is decoded, for every consumer, to fix a rendering
 *  bug in two fields. One helper, used in both places, changes exactly
 *  what is wrong. Uses the UTC calendar date — these are `date` columns
 *  with no time or zone, and a local-time slice can move them a day.   */
const isoDate = (v) => {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

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
  const termsNotEstablished = byTenancy("occupied_terms_not_established");
  const activationPending = byTenancy("activation_pending");
  const contested = byTenancy("contested");
  const downRows = rows.filter((r) => r.is_down);
  const noEconomics = rows.filter((r) => r.economics_state === "unavailable");
  const disagrees = rows.filter((r) => r.evidence_state === "disagrees");
  const inconclusive = rows.filter((r) => r.evidence_state === "inconclusive");

  // TRUSTED RENT — every uncontested spanning lease with populated rent,
  // whatever the opening evidence says. Opening evidence being inconclusive
  // or in disagreement does not un-occupy a position that holds a real lease.
  const rentBearing = rows.filter((r) => r.contributes_trusted_rent);
  const contractual_rent_trusted = rentBearing.length
    ? money(rentBearing.reduce((s, r) => s + Number(r.current_rent), 0))
    : null;

  /*  ── UNVERIFIED REVENUE HAS A MAGNITUDE, AND IT IS COUNTED NOWHERE ──
   *  A position the operator accepted as occupied with terms unknown
   *  carries no lease, so it contributes nothing to trusted rent — that is
   *  correct and does not change here. But the source DID assert a rent for
   *  it, and a read that shows only a count cannot say "$X claimed, $0
   *  verified". The count without the magnitude is the same silence as no
   *  line at all.
   *
   *  This mirrors `contested_claims.implicated_rent` exactly: VISIBLE
   *  WITHOUT BEING COUNTED. It never enters contractual_rent_trusted,
   *  occupancy, or any NOI figure, and the row carries it as `claimed_rent`
   *  beside `current_rent` rather than inside it.
   *
   *  NULL WHEN THE SOURCE CARRIED NO RENT — never 0. An unknown Exposure is
   *  a valid Exposure and is never zero (§5); writing 0 would turn "we do
   *  not know what they pay" into "they pay nothing", which is the one
   *  reading a lender must never be handed. Those positions are counted
   *  separately so the gap in the claimed figure is itself visible.      */
  const claimProposalIds = [...new Set(termsNotEstablished
    .map((r) => r.basis_ref && r.basis_ref.proposal_id).filter(Boolean).map(String))];
  const claimedRentByProposal = new Map();
  if (claimProposalIds.length) {
    const claimed = (await pool.query(
      `select id, normalized_json->>'rent' as rent
         from proposed_records where id = any($1::uuid[])`, [claimProposalIds])).rows;
    for (const c of claimed) {
      claimedRentByProposal.set(String(c.id),
        c.rent == null || c.rent === "" ? null : Number(c.rent));
    }
  }
  const claimedRentFor = (r) => {
    if (r.tenancy_state !== "occupied_terms_not_established") return null;
    const id = r.basis_ref && r.basis_ref.proposal_id;
    if (!id) return null;
    const v = claimedRentByProposal.get(String(id));
    return v == null || Number.isNaN(v) ? null : v;
  };
  for (const r of rows) r.claimed_rent = claimedRentFor(r);
  const claimedRows = termsNotEstablished.filter((r) => r.claimed_rent != null);
  const claimed_rent_unverified = claimedRows.length
    ? money(claimedRows.reduce((sum, r) => sum + Number(r.claimed_rent), 0))
    : null;

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
        start_date: isoDate(c.start_date),
        end_date: isoDate(c.end_date),
        rent: c.rent == null ? null : Number(c.rent),
      })),
    };
  }

  const inventory = rows.length;
  // Leasable excludes physically down positions. use_type is not yet a durable
  // field, so non-revenue cannot be excluded honestly — see the schema plan.
  const leasableRows = rows.filter((r) => !r.is_down);
  const leasable = leasableRows.length;
  const occupancyRows = leasableRows.filter((r) => r.tenancy_state !== "contested");
  const occupancy_denominator = occupancyRows.length;
  const occupancy_numerator = occupancyRows.filter((r) => r.tenancy_state === "contractually_occupied").length;

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
      /*  OCCUPIED, TERMS NOT ESTABLISHED — its own bucket, because it is
       *  its own fact. Folding it into `unresolved` told a lender "we do
       *  not know whether anyone lives there" about beds the operator had
       *  explicitly accepted as occupied.  */
      occupied_terms_not_established: termsNotEstablished.length,
      unresolved: unresolved.length,
      /*  A LENDER ADDS THE COLUMN. Without this bucket the five numbers
       *  summed to 146 of 160 and fourteen positions were simply missing:
       *  a commenced lease awaiting economic activation is a tenancy fact
       *  with no bucket. The header promises each summary balances within
       *  its own axis; it now does, and the proof asserts the sum.     */
      activation_pending: activationPending.length,
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

      // Occupied tenancy within the same leasable, uncontested population as
      // the denominator. Full tenancy_summary and contractual rent above are
      // independent of physical holds. Evidence and economics do not change it.
      // LANGUAGE: this is CONFIRMED contractual occupancy. Unresolved positions
      // remain in the denominator, and the wording must never imply they are
      // confirmed vacant — they are simply not yet established either way.
      confirmed_contractual_occupancy: {
        occupied: occupancy_numerator,
        of_leasable_resolved: occupancy_denominator,
        pct: occupancy_denominator ? Math.round(occupancy_numerator / occupancy_denominator * 10000) / 100 : null,
        excluded_from_denominator: { down: downRows.length, contested: leasable - occupancy_denominator },
        reported_beside: {
          //  Both are inside the denominator and neither is vacant. They
          //  are reported apart because they send an operator to do
          //  different work: one needs terms, the other needs settling.
          occupied_terms_not_established: termsNotEstablished.length,
          unresolved_positions: unresolved.length,
          evidence_disagrees: disagrees.length,
          evidence_inconclusive: inconclusive.length,
        },
      },

      contractual_rent_trusted,
      /*  BESIDE trusted rent, never inside it. This is the line between
       *  verifiable and unverifiable revenue: what the source claims for
       *  positions Spine accepted as occupied but holds no instrument for.
       *  It is counted in no occupancy figure and no NOI.               */
      claimed_rent_unverified,
      positions_with_claimed_rent_unverified: claimedRows.length,
      //  Accepted occupancy whose source named no rent at all. Not zero —
      //  unknown, and visible as its own number so the gap in the figure
      //  above cannot be mistaken for completeness.
      positions_claimed_without_rent: termsNotEstablished.length - claimedRows.length,
      contractual_rent_excluded_contested: contested_claims.implicated_rent,
      positions_contributing_rent: rentBearing.length,
      occupied_without_known_rent: noEconomics.length,
    },

    contested_claims,

    exceptions: {
      evidence_disagrees: disagrees.length,
      evidence_inconclusive: inconclusive.length,
      contested: contested.length,
      economics_unavailable: noEconomics.length,
      unresolved_tenancy: unresolved.length,
      occupied_terms_not_established: termsNotEstablished.length,
      resident_not_linked: rows.filter((r) => r.lease && !r.resident).length,
    },

    rows,
  };
}

module.exports = { currentRentRoll };
