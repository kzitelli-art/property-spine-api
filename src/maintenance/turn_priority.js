// ════════════════════════════════════════════════════════════════════
//  turn_priority.js — the shared Turn-Priority ranking (one source of truth).
//
//  THE QUESTION THIS READ ANSWERS, established by audit rather than inherited:
//
//      Of the turns physically in progress, which should be finished first,
//      and what real commitment makes it matter?
//
//  It is NOT a demand forecast, a leasing signal, or a workflow engine. It
//  ranks physical work by the commitment waiting on it.
//
//  ── WHAT CHANGED AND WHY ─────────────────────────────────────────────
//
//  1. IT READ lease_applications.status. The old tier 2 ("applicant_demand")
//     ranked a turn higher because an OPEN application referenced the unit,
//     using a hand-maintained list
//     ('submitted','tenant_signed','lease_ready','accepted_term_required').
//
//     An application holds NO inventory. position_classifier never reads
//     lease_applications at all; approval, lease_ready and
//     accepted_term_required create no space reservation. The first commitment
//     appears five governed steps later, at confirm-term, when a lease is
//     written with a space_id. So an approved application must NOT create an
//     incoming-resident deadline — it was ranking hope as though it were a
//     commitment.
//
//  2. IT COULD NOT TELL PENDING FROM LOCKED. It matched `lease_status =
//     'pending'` directly, so an unfunded lease and an executed-and-funded one
//     produced the identical top tier. The canonical rule is that LOCKED means
//     executed AND funded; a 'pending' lease_status alone never closes a
//     position.
//
//  3. IT WAS FIRST-ROW-WINS ON A MULTI-SPACE UNIT. `order by ob.due_at asc
//     limit 1` picked ONE lease from anywhere in the unit and let it set the
//     whole unit's priority, silently. On a by-bed unit, one bed's incoming
//     resident prioritised every other bed with no way to see it had happened.
//
//  ── THE UNIT/SPACE GRAIN, AND THE EXPLICIT AGGREGATION POLICY ────────
//  turnovers are UNIT-grained (turnovers.unit_id; there is no space_id).
//  Commitments are SPACE-grained (leases.space_id NOT NULL).
//
//  That gap is REAL but it is not a missing link: leases.space_id →
//  spaces.unit_id already says which space in the unit each commitment belongs
//  to. So the aggregation does not need a new durable field — it needs to be
//  STATED instead of assumed:
//
//      A unit turn covers the whole unit physically, so its priority is the
//      STRONGEST commitment across the unit's spaces — and EVERY contributing
//      commitment is named on the row, with the unit's space count beside it.
//
//  One space's successor therefore never SILENTLY prioritises the others. It
//  prioritises them visibly, and the operator can see exactly which space and
//  which lease did it.
//
//  ── ALLOWED INPUTS ───────────────────────────────────────────────────
//  canonical space-linked future commitment · canonical start date · pending
//  vs locked · physical turn state · readiness state · conflict/evidence state.
//
//  NEVER: lease_applications.status, approval, lease_ready,
//  accepted_term_required, or unit-number inference.
//
//  CLASSIFICATION: Class 1 permanent primitive (the ranking read). No writes.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { availabilityRead } = require("../surfaces/availability_read");

// ── THE EXPLICIT AGGREGATION POLICY ──────────────────────────────────
//  Ordered, and each rank is justified rather than assumed.
//
//    4 conflicted_commitment  two leases claim a space in this unit; which
//                             governs is unknown, so the turn cannot be
//                             planned from its commitment at all. Ranked top
//                             because every other answer here is unreliable
//                             until it is resolved. NO deadline is invented.
//    3 committed_start        at least one space carries a LOCKED commitment
//                             (executed AND funded). Someone is arriving.
//    2 pending_commitment     at least one space carries a PENDING commitment.
//                             A planning signal, explicitly labelled as not
//                             yet proven — never presented as committed.
//    1 raw_vacancy            no commitment on any space in the unit.
const TIER = {
  conflicted_commitment: 4,
  committed_start: 3,
  pending_commitment: 2,
  raw_vacancy: 1,
};

const ymd = (d) => {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};

/**
 * rankTurnPriority(pool, property_id)
 *   → { property_id, count, note, turns }
 */
async function rankTurnPriority(pool, property_id) {
  // Physical turn state — unit-grained, and the row set this read ranks.
  const turns = (await pool.query(
    `select t.id as turnover_id, t.unit_id, t.status, t.ready_date, t.needs,
            t.moveout_photos, t.deposit_review, u.unit_number as unit_label
       from turnovers t
       left join units u on u.id = t.unit_id
      where t.property_id = $1 and t.status = 'in_progress'`,
    [property_id])).rows;

  if (!turns.length) {
    return { property_id, count: 0, note: NOTE, turns: [] };
  }

  // ONE canonical availability read carries, per space: the future commitment
  // (state / lease_id / start_date / proof_basis), the conflict state and the
  // readiness axis. Nothing here re-derives any of them.
  const avail = await availabilityRead(pool, { property_id });
  const spacesByUnit = new Map();
  for (const row of avail.rows) {
    const k = String(row.unit_id);
    if (!spacesByUnit.has(k)) spacesByUnit.set(k, []);
    spacesByUnit.get(k).push(row);
  }

  const ranked = turns.map((t) => {
    const spaces = spacesByUnit.get(String(t.unit_id)) || [];

    // EVERY space that carries a commitment is a contributor. None is dropped,
    // and none is chosen by ordering.
    const contributing = spaces
      .filter((s) => s.future_commitment && s.future_commitment.state !== "none")
      .map((s) => ({
        space_id: s.space_id,
        space_label: s.space_label,
        state: s.future_commitment.state,          // 'pending' | 'locked'
        lease_id: s.future_commitment.lease_id,
        start_date: ymd(s.future_commitment.start_date),
        proof_basis: s.future_commitment.proof_basis,
      }));

    const conflicted = spaces.filter((s) => s.conflict_state === "conflicted");
    const locked = contributing.filter((c) => c.state === "locked");
    const pending = contributing.filter((c) => c.state === "pending");

    // Earliest GOVERNED start date among the contributors that set the tier.
    // A contributor with no start_date contributes no date — it is never
    // replaced with a guess.
    const earliest = (list) => {
      const dates = list.map((c) => c.start_date).filter(Boolean).sort();
      return dates.length ? dates[0] : null;
    };

    let tier_key, deadline, priority_label, reason;

    if (conflicted.length) {
      tier_key = "conflicted_commitment";
      deadline = null;                              // unknowable, so unstated
      priority_label = "Lease commitment conflict";
      reason = `Overlapping lease claims on ${conflicted.length === 1 ? "a space" : `${conflicted.length} spaces`} in this unit. `
             + "Which lease governs is unknown, so this turn cannot be planned from its commitment until that is resolved.";
    } else if (locked.length) {
      tier_key = "committed_start";
      deadline = earliest(locked);
      priority_label = deadline ? `Committed move-in ${deadline}` : "Committed move-in — date unknown";
      const who = locked.length > 1 ? `${locked.length} spaces in this unit are` : "This unit is";
      reason = deadline
        ? `${who} committed to a future resident — executed and funded — starting ${deadline}. Finishing this releases a committed position.`
        : `${who} committed to a future resident — executed and funded — but no start date is recorded, so the deadline is unknown.`;
    } else if (pending.length) {
      tier_key = "pending_commitment";
      deadline = earliest(pending);
      priority_label = deadline ? `Pending lease starts ${deadline}` : "Pending lease — start date unknown";
      reason = deadline
        ? `A future lease is attached, starting ${deadline}, but it is not yet both executed and funded. Plan for it; it is not a commitment yet.`
        : "A future lease is attached but it is not yet both executed and funded, and no start date is recorded.";
    } else {
      tier_key = "raw_vacancy";
      deadline = null;
      priority_label = "No incoming lease attached";
      reason = "Turn frees available supply — no lease is attached to any space in this unit yet.";
    }

    return {
      turnover_id: t.turnover_id,
      unit_id: t.unit_id,
      unit_label: t.unit_label,
      status: t.status,
      ready_date: ymd(t.ready_date),
      needs: t.needs,
      gates: { moveout_photos: t.moveout_photos, deposit_review: t.deposit_review },

      demand_tier: TIER[tier_key],       // numeric ONLY for sort; never shown as a score
      demand_tier_key: tier_key,         // the machine label
      priority_label,                    // compact operator language

      // ── THE DEADLINE, HONESTLY ──────────────────────────────────
      //  deadline_known is explicit so a null date reads as "nobody recorded
      //  one", never as "no deadline".
      commitment_start_date: deadline,
      deadline_known: deadline !== null,

      // ── WHICH SPACES DROVE THIS, NAMED ──────────────────────────
      //  The whole point of the unit/space aggregation being explicit. On a
      //  single-space unit this is one entry; on a by-bed unit the operator
      //  can see exactly which bed's lease set the unit's priority.
      rentable_space_count: spaces.length,
      contributing_commitments: contributing,
      commitment_conflict: conflicted.length > 0,

      reason,                            // plain-language, shown verbatim
    };
  });

  ranked.sort((a, b) => {
    if (b.demand_tier !== a.demand_tier) return b.demand_tier - a.demand_tier;
    const ad = a.commitment_start_date || "9999-12-31";
    const bd = b.commitment_start_date || "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ar = a.ready_date || "9999-12-31", br = b.ready_date || "9999-12-31";
    return ar < br ? -1 : ar > br ? 1 : 0;
  });

  return { property_id, count: ranked.length, note: NOTE, turns: ranked };
}

const NOTE =
  "In-progress turns ranked by the commitment waiting on each: an unresolved "
  + "overlapping claim first, then a lease that is executed and funded, then a "
  + "future lease that is neither yet, then raw vacancy. The order is a tier, "
  + "not a score. An application alone never ranks a turn — it holds no space. "
  + "Where a unit has more than one space, every commitment that contributed is "
  + "named on the row.";

module.exports = { rankTurnPriority, TIER };
