// ════════════════════════════════════════════════════════════════════
//  renewals_read.js — R1: THE LIVE RENEWAL-WORK COHORT (read-only)
//
//  Answers ONE question: which leases need renewal attention in the next
//  90 days? Canonical leases and expiration dates only. No fixtures, no
//  spreadsheet reconciliation, no forecast.
//
//  WRITES NOTHING, and DERIVES NOTHING THAT IS SHARED. Lease-spanning,
//  successor state, notice, conflict, availability and proof basis all
//  come from the ONE canonical dated derivation (tenancy/space_position).
//  This module adds only what is specific to the renewal WORK view:
//  urgency banding, days remaining, ordering, and conversation context.
//
//  Rev 2 (owner review, 2026-07-27) corrected two long-term defects found
//  while the slice was still small:
//
//   1. NO SUCCESSOR AWARENESS. The cohort was "any lease expiring in 90
//      days", so 49 of 92 positions that ALREADY had a next lease were
//      shown as open renewal decisions. That is the replacement rule
//      failing at its first opportunity. A position must never appear
//      more certain — or more available — than the evidence supports.
//
//   2. A THIRD NOTICE QUERY. notice_given was being re-derived here, in
//      availability.js and in space_position.js. Shared facts are derived
//      once; each surface adds context, not a new meaning.
//
//  THE THREE PERMANENT OUTCOMES for an expiring position:
//    successor_state = none    → OPEN RENEWAL DECISION (the work list)
//    successor_state = pending → SUCCESSOR PENDING, NOT LOCKED
//                                (zero locked rent, zero projected rent,
//                                 visible as unresolved exposure — never
//                                 silently removed, never counted as open)
//    successor_state = locked  → LOCKED FUTURE POSITION (leaves this door;
//                                 feeds the Future Rent Roll)
//  A date-conflicted lease is NOT a successor. It is a contested position
//  and is excluded with an explicit conflict reason, appearing in neither
//  the open nor the pending set.
//
//  'locked' uses the SAME governed rule as everywhere else — executed AND
//  funded. A 'pending' lease_status alone never closes the economic
//  position.
//
//  FACT BOUNDARIES (owner rulings) — each a place a plausible wrong answer
//  was available and is refused:
//   · current rent comes ONLY from leases.rent. Never units.market_rent,
//     which disagrees with in-place rent in 105 of 114 studios measured.
//   · notice comes ONLY from a governed notice_given unit_event. Silence
//     is 'unresolved' — NOT "waiting for a response", because we have not
//     asked.
//   · no renewed state. Separating a signed renewal from a signed new
//     lease needs lease-origin classification, which does not exist.
//   · identity absence ≠ accountability absence. A missing resident is
//     "Resident not linked". UNASSIGNED is only ever the work owner.
//
//  OWNERSHIP is a stated product fact, not a failed lookup: no renewal
//  obligation exists, so there is no candidate source. We do not call
//  resolveEligibleOwner with an empty list to be told what we know. When
//  R2 creates governed renewal obligations they carry candidates and the
//  canonical resolver replaces this constant.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { spacePosition } = require("../tenancy/space_position");

const DEFAULT_HORIZON_DAYS = 90;
const R1_OWNER_STATE = "UNASSIGNED";
const R1_OWNER_REASON = "renewal_work_not_created";

function ymd(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function daysBetween(fromYmd, toYmd) {
  const a = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const b = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}
function band(days) {
  return days < 30 ? "d0_30" : days < 60 ? "d31_60" : "d61_90";
}

async function renewalsCohort(pool, { property_id, horizon_days = DEFAULT_HORIZON_DAYS, as_of = null } = {}) {
  if (!property_id) throw new Error("renewalsCohort requires property_id");
  const horizon = Number.isFinite(Number(horizon_days)) ? Number(horizon_days) : DEFAULT_HORIZON_DAYS;

  // THE SHARED TRUTH. Everything positional comes from here.
  // as_of is passed EXPLICITLY rather than relying on the default: the shared
  // derivation is dated, and the same call must serve a future horizon later
  // without the caller's date silently coming from the server clock.
  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const sp = await spacePosition(pool, { property_id, as_of: asOf });
  const horizonEnd = ymd(new Date(new Date(`${asOf}T00:00:00Z`).getTime() + horizon * 86400000));

  // Presentation-only context: the Person Card thread for this resident at
  // this property. Not a shared fact — nothing else classifies on it.
  // DETERMINISTIC AND MEANINGFUL: the most recently active conversation, not
  // min(id), which was an arbitrary tie-break dressed as a choice. A resident
  // with several threads should open the one they are actually in. id is the
  // final tie-break so the result is stable between reads.
  const convRows = (await pool.query(
    `select distinct on (person_id) person_id, id::text as conversation_id
       from conversations
      where property_id=$1 and person_id is not null
      order by person_id, last_message_at desc nulls last, created_at desc, id desc`,
    [property_id]
  )).rows;
  const convByPerson = new Map(convRows.map((r) => [String(r.person_id), r.conversation_id]));

  const expiring = [];
  for (const p of sp.positions) {
    const cur = p.current_lease_position;
    if (!cur || !cur.end_date) continue;
    const ends = ymd(cur.end_date);
    if (!ends || ends < asOf || ends >= horizonEnd) continue;

    const tenant = (cur.tenants || [])[0] || null;
    const days = daysBetween(asOf, ends);
    expiring.push({
      lease_id: cur.lease_id,
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,
      space_label: p.space_label || null,
      person_id: tenant ? tenant.person_id : null,
      resident_name: tenant ? (tenant.name || null) : null,   // null ⇒ "Resident not linked"
      resident_count: (cur.tenants || []).length,
      conversation_id: tenant ? (convByPerson.get(String(tenant.person_id)) || null) : null,
      current_rent: cur.rent == null ? null : Number(cur.rent),  // null ⇒ "Current rent unavailable"
      expires_on: ends,
      days_until_expiration: days,
      band: band(days),
      notice_state: p.notice_state === "on_notice" ? "on_notice" : "unresolved",
      conflict_state: p.conflict_state,
      successor_state: p.conflict_state === "conflicted" ? "none" : p.successor.state,
      successor_lease_id: p.conflict_state === "conflicted" ? null : p.successor.lease_id,
      successor_proof_basis: p.conflict_state === "conflicted" ? null : p.successor.proof_basis,
      owner_user_id: null,
      owner_state: R1_OWNER_STATE,
      owner_reason: R1_OWNER_REASON,
      proof_basis: cur.proof_basis,
    });
  }

  // Ordering (server-authored): unresolved before on_notice, soonest first,
  // lease_id as a stable tie-break so equal dates never shuffle between reads.
  const order = (rows) => rows.sort((a, b) => {
    const rank = (x) => (x.notice_state === "unresolved" ? 0 : 1);
    return rank(a) - rank(b)
      || a.days_until_expiration - b.days_until_expiration
      || String(a.lease_id).localeCompare(String(b.lease_id));
  });

  // A position lands in EXACTLY ONE bucket.
  const conflicted = order(expiring.filter((r) => r.conflict_state === "conflicted"));
  const rest = expiring.filter((r) => r.conflict_state !== "conflicted");
  const open = order(rest.filter((r) => r.successor_state === "none"));
  const successorPending = order(rest.filter((r) => r.successor_state === "pending"));
  const lockedSuccessor = rest.filter((r) => r.successor_state === "locked");

  const inBand = (b) => open.filter((r) => r.band === b).length;
  const unresolved = open.filter((r) => r.notice_state === "unresolved").length;

  return {
    property_id,
    as_of: asOf,
    horizon_days: horizon,
    horizon_end: horizonEnd,

    // THE PRIMARY WORK LIST — open renewal decisions only.
    count: open.length,
    breakdown: { d0_30: inBand("d0_30"), d31_60: inBand("d31_60"), d61_90: inBand("d61_90") },
    states: { unresolved, on_notice: open.length - unresolved },
    rows: open,

    // SECONDARY CONTEXT — visible, never mixed into the work list, and
    // contributing zero locked and zero projected rent.
    successor_pending: {
      count: successorPending.length,
      note: "A successor lease exists but is not executed and funded. Not a locked position, and not an open renewal decision.",
      rows: successorPending,
    },
    locked_future: {
      count: lockedSuccessor.length,
      note: "Executed and funded successor. Leaves renewal work and feeds the Future Rent Roll.",
    },
    conflicted: {
      count: conflicted.length,
      reason: "overlapping_operative_lease",
      note: "Two non-terminal leases overlap on this position; which lease governs is unknown. Excluded from both open and pending.",
      rows: conflicted,
    },

    totals: { expiring_in_horizon: expiring.length },

    // PAGE-LEVEL TRUTH. When every open row shares a state that is ONE fact
    // about the property, not N warnings. Computed here so the page and the
    // rows can never disagree about what is uniform.
    uniform: {
      all_unresolved: open.length > 0 && unresolved === open.length,
      no_owner_anywhere: open.length > 0 && open.every((r) => !r.owner_user_id),
      owner_reason: open.length > 0 ? R1_OWNER_REASON : null,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
//  SLICE 6 — THE COMPLETE OPERATING RAIL
//
//  renewalsCohortEnriched() takes the R1 cohort above (the successor-aware
//  population — unchanged) and joins each OPEN row to the canonical operating
//  facts, then runs the pure renewal_lifecycle machine to author stage,
//  operating state, waiting party, blocker, due state, economics view, and
//  the single primary action.
//
//  It reads only canonical sources:
//    · renewal_cases        — the append-only operating record (active row)
//    · lease_offers         — scope='renewal' (offer status / sent / expires)
//    · obligations          — module='leasing', related_type='renewal'
//                             (accountable owner, due_at)
//  Governed renewal economics do NOT exist yet (Slice 8); every row therefore
//  reports proposed_rent=null and economics_source=null honestly. The wiring
//  is in place so that when Slice 8 lands, the same projection fills.
//
//  The home card and the destination BOTH read this one function, so their
//  counts can never disagree (the spec's count rule).
// ════════════════════════════════════════════════════════════════════

const { renewalLifecycle } = require("./renewal_lifecycle");

async function renewalsCohortEnriched(pool, opts = {}) {
  if (!opts || !opts.property_id) throw new Error("renewalsCohortEnriched requires property_id");
  const base = await renewalsCohort(pool, opts);
  const asOf = base.as_of;
  const property_id = base.property_id;
  const openRows = base.rows;

  if (openRows.length === 0) {
    return {
      ...base,
      rows: [],
      counts: emptyCounts(),
    };
  }

  const leaseIds = openRows.map((r) => r.lease_id).filter(Boolean);

  // ── Active renewal case per current lease (latest, non-terminal) ──
  const caseRows = leaseIds.length
    ? (await pool.query(
        `select current_lease_id, renewal_stage, operating_state, waiting_on,
                blocker_code, decision_status, notice_status, terminal_state,
                obligation_id, renewal_lease_id
           from renewal_cases
          where property_id = $1
            and current_lease_id = any($2::uuid[])
            and superseded_by is null
            and terminal_state is null`,
        [property_id, leaseIds]
      )).rows
    : [];
  const caseByLease = new Map(caseRows.map((r) => [String(r.current_lease_id), r]));

  // ── Renewal-scoped offers, latest per lease (scope_ref carries lease id) ──
  const offerRows = leaseIds.length
    ? (await pool.query(
        `select distinct on (scope_ref) scope_ref, status, communicated_at, expires_at
           from lease_offers
          where property_id = $1
            and scope = 'renewal'
            and scope_ref = any($2::text[])
          order by scope_ref, coalesce(communicated_at, created_at) desc`,
        [property_id, leaseIds.map(String)]
      )).rows
    : [];
  const offerByLease = new Map(offerRows.map((r) => [String(r.scope_ref), r]));

  // ── Accountable owner + due from the renewal obligation ──
  const oblRows = leaseIds.length
    ? (await pool.query(
        `select related_id, assigned_user_id, assigned_role, due_at, status
           from obligations
          where property_id = $1
            and module = 'leasing'
            and related_type = 'renewal'
            and related_id = any($2::uuid[])`,
        // related_id is the renewal_case id; we also map by lease via the case
        [property_id, caseRows.map((c) => c.obligation_id).filter(Boolean)]
      )).rows
    : [];
  const oblById = new Map(oblRows.map((r) => [String(r.related_id), r]));

  const enriched = openRows.map((r) => {
    const rc = caseByLease.get(String(r.lease_id)) || null;
    const offer = offerByLease.get(String(r.lease_id)) || null;
    const obl = rc && rc.obligation_id ? oblById.get(String(rc.obligation_id)) : null;

    const ownerUserId = obl ? obl.assigned_user_id : (rc && rc.obligation_id ? null : null);
    const dueAt = obl && obl.due_at ? ymd(obl.due_at) : null;

    const life = renewalLifecycle(
      {
        days_until_expiration: r.days_until_expiration,
        renewal_case: rc,
        offer: offer
          ? { status: offer.status, sent_at: ymd(offer.communicated_at), expires_at: ymd(offer.expires_at) }
          : null,
        owner: ownerUserId ? { user_id: ownerUserId } : null,
        due_at: dueAt,
        current_rent: r.current_rent,
        // Slice 8 governed economics — not yet authored anywhere:
        governed_proposed_rent: null,
        economics_source: null,
        economics_as_of: null,
      },
      asOf
    );

    return {
      ...r,
      // ownership is now a real fact, not the R1 constant
      owner_user_id: ownerUserId || null,
      owner_state: ownerUserId ? "assigned" : "UNASSIGNED",
      assignment_state: ownerUserId ? "assigned" : "unassigned",
      responsibility_role: obl ? obl.assigned_role : null,
      // server-authored lifecycle
      ...life,
    };
  });

  const counts = deriveCounts(enriched, asOf);

  return {
    ...base,
    rows: enriched,
    // The reconciled home + destination counts (same projection, one source).
    counts,
    // keep uniform, but recompute no_owner_anywhere against real ownership
    uniform: {
      ...base.uniform,
      no_owner_anywhere: enriched.length > 0 && enriched.every((r) => !r.owner_user_id),
    },
  };
}

function emptyCounts() {
  return {
    total_active: 0, due_today: 0, overdue: 0, unassigned: 0,
    waiting: 0, blocked: 0, offer_sent: 0, decision_required: 0,
  };
}

function deriveCounts(rows) {
  const c = emptyCounts();
  c.total_active = rows.length;
  for (const r of rows) {
    if (r.due_state === "due_today") c.due_today++;
    if (r.due_state === "overdue") c.overdue++;
    if (!r.owner_user_id) c.unassigned++;
    if (r.operating_state === "waiting") c.waiting++;
    if (r.operating_state === "blocked") c.blocked++;
    if (r.offer_status === "sent") c.offer_sent++;
    if (r.renewal_stage === "decision_required") c.decision_required++;
  }
  return c;
}

module.exports = { renewalsCohort, renewalsCohortEnriched, DEFAULT_HORIZON_DAYS };
