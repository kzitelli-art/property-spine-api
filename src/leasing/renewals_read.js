// ════════════════════════════════════════════════════════════════════
//  renewals_read.js — R1: THE LIVE RENEWAL-WORK COHORT (read-only)
//
//  Answers ONE question: which leases need renewal attention in the next
//  90 days? Canonical leases and expiration dates only. No fixtures, no
//  spreadsheet reconciliation, no forecast.
//
//  WRITES NOTHING. There is no renewals table and there must not be one —
//  the cohort is DERIVED from leases / spaces / units / unit_events every
//  time it is read. (Same discipline as availability.js and
//  space_position.js: no parallel inventory, no hand-maintained list.)
//
//  SERVER-AUTHORED, APP NEVER RE-DERIVES: notice state, ordering, day
//  counts and proof basis are computed HERE, once. The renderer displays
//  the decision; it never reproduces the precedence client-side. This is
//  the rule the previous Renewals door broke by computing its buckets in
//  index.html from an imported rent-roll snapshot.
//
//  FACT BOUNDARIES (owner rulings, 2026-07-27) — each of these is a place
//  a plausible-looking wrong answer was available and is refused:
//   · current rent comes ONLY from leases.rent. Never units.market_rent —
//     that column is a different concept and disagrees with in-place rent
//     in 105 of 114 studios measured.
//   · notice comes ONLY from a governed notice_given unit_event. Silence
//     is 'unresolved', which is NOT "waiting for a response" — we have not
//     asked. There are currently ZERO notice_given events in the database,
//     so every row is honestly 'unresolved'.
//   · no renewed state. Distinguishing a signed renewal from a signed new
//     lease requires lease-origin classification, which does not exist.
//     Inventing the bucket would be a confident wrong. R1 is the OPEN
//     renewal-work cohort, not completed-renewal history.
//   · identity absence and accountability absence are DIFFERENT absences.
//     A missing resident is 'Resident not linked'. UNASSIGNED is reserved
//     for the accountable work owner and is never used for identity.
//
//  OWNERSHIP — an explicit product fact, not a failed lookup. No renewal
//  obligation exists yet, so there is no candidate source. We do NOT call
//  resolveEligibleOwner with an empty candidate list 92 times to be told
//  what we already know. We state it: UNASSIGNED, because renewal work has
//  not been created. When R2 creates governed renewal obligations, those
//  obligations carry candidates and the canonical resolver replaces this
//  constant — the shape of the field does not change.
//
//  OUT OF SCOPE (R1): renewal decisions, offers, pricing writes,
//  lease-origin inference, historical renewal rates, forward economic
//  schedules, Commitment Ledger activation, Future Rental projection, and
//  pending-lease / application / lead / tour analytics.
// ════════════════════════════════════════════════════════════════════

"use strict";

// The lease must be GOVERNING today to be renewable. Pending leases are
// deliberately outside R1: a pending lease is not yet contractual truth
// (space_position.js holds the same line), and R1 shows work on real
// current tenancies, not on activation backlog.
const GOVERNING_LEASE_STATUSES = ["active", "commercial"];

const DEFAULT_HORIZON_DAYS = 90;

// Ownership is a stated fact in R1, not a resolution outcome.
const R1_OWNER_STATE = "UNASSIGNED";
const R1_OWNER_REASON = "renewal_work_not_created";

function ymd(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function renewalsCohort(pool, { property_id, horizon_days = DEFAULT_HORIZON_DAYS } = {}) {
  if (!property_id) throw new Error("renewalsCohort requires property_id");
  const horizon = Number.isFinite(Number(horizon_days)) ? Number(horizon_days) : DEFAULT_HORIZON_DAYS;

  const { rows } = await pool.query(
    `select
        l.id                as lease_id,
        l.rent              as current_rent,
        l.end_date          as expires_on,
        (l.end_date::date - current_date)::int as days_until_expiration,
        s.id                as space_id,
        s.space_label,
        u.id                as unit_id,
        u.unit_number,
        -- PRIMARY RESIDENT: the first linked tenant. tenant_ids may be empty
        -- (imported leases without a person bridge) — that is an identity
        -- absence and must render as "Resident not linked", never UNASSIGNED.
        (l.tenant_ids)[1]   as person_id,
        p.name              as resident_name,
        coalesce(array_length(l.tenant_ids, 1), 0) as resident_count,
        -- PERSON CARD CONTEXT: the existing conversation for this person at
        -- THIS property. Absent is fine; the row still opens the card.
        (select c.id from conversations c
          where c.person_id = (l.tenant_ids)[1] and c.property_id = l.property_id
          order by c.created_at limit 1) as conversation_id,
        -- NOTICE: the ONLY governed producer is a scheduled notice_given
        -- unit_event on THIS space (notice.js / Availability Slice A).
        exists (
          select 1 from unit_events ue
           where ue.space_id = s.id
             and ue.event_type = 'notice_given'
             and ue.status = 'scheduled'
        ) as has_notice,
        -- PROOF BASIS: carried even though the first UI keeps it quiet.
        -- A verified executed-lease record is native proof; a confirmed
        -- historical import is accepted opening truth; anything else is
        -- unproven and must be visible as such rather than assumed good.
        (er.id is not null) as has_verified_execution,
        l.source_type,
        l.confidence
       from leases l
       join spaces s on s.id = l.space_id
       join units  u on u.id = s.unit_id
       left join persons p on p.id = (l.tenant_ids)[1]
       left join executed_lease_records er
         on er.lease_id = l.id and er.record_state = 'verified'
      where l.property_id = $1
        and l.lease_status = any($2::text[])
        and l.end_date is not null
        and l.end_date >= current_date
        and l.end_date <  current_date + $3::int`,
    [property_id, GOVERNING_LEASE_STATUSES, horizon]
  );

  const cohort = rows.map((r) => {
    const proof_basis = r.has_verified_execution
      ? "native_verified"
      : (r.source_type === "historical_snapshot" && r.confidence === "confirmed")
        ? "confirmed_opening_import"
        : "unproven";

    return {
      lease_id: r.lease_id,
      space_id: r.space_id,
      unit_id: r.unit_id,
      unit_number: r.unit_number,
      space_label: r.space_label || null,
      person_id: r.person_id || null,
      resident_name: r.resident_name || null,   // null ⇒ "Resident not linked"
      resident_count: r.resident_count,
      conversation_id: r.conversation_id || null,
      current_rent: r.current_rent == null ? null : Number(r.current_rent), // null ⇒ "Current rent unavailable"
      expires_on: ymd(r.expires_on),
      days_until_expiration: r.days_until_expiration,
      notice_state: r.has_notice ? "on_notice" : "unresolved",
      // URGENCY BAND — DISJOINT, not cumulative. The operator groups by
      // "what must be handled first", and overlapping bands would double-
      // count the same lease in two groups.
      band: r.days_until_expiration < 30 ? "d0_30"
          : r.days_until_expiration < 60 ? "d31_60"
          : "d61_90",
      owner_user_id: null,
      owner_state: R1_OWNER_STATE,
      owner_reason: R1_OWNER_REASON,
      proof_basis,
    };
  });

  // ORDER (server-authored, never re-sorted client-side): unresolved before
  // on_notice — unresolved is where nothing has happened yet and the work
  // actually sits. Soonest expiration first inside each state; lease_id is
  // the stable tie-break so equal dates never shuffle between reads.
  cohort.sort((a, b) => {
    const stateRank = (x) => (x.notice_state === "unresolved" ? 0 : 1);
    return stateRank(a) - stateRank(b)
      || a.days_until_expiration - b.days_until_expiration
      || String(a.lease_id).localeCompare(String(b.lease_id));
  });

  const inBand = (b) => cohort.filter((r) => r.band === b).length;
  const unresolved = cohort.filter((r) => r.notice_state === "unresolved").length;
  const withOwner = cohort.filter((r) => r.owner_user_id).length;

  return {
    property_id,
    horizon_days: horizon,
    count: cohort.length,
    // Disjoint bands, summing to count. These drive both the quiet headline
    // breakdown and the row grouping, so one number can never disagree with
    // the other.
    breakdown: {
      d0_30: inBand("d0_30"),
      d31_60: inBand("d31_60"),
      d61_90: inBand("d61_90"),
    },
    states: {
      unresolved,
      on_notice: cohort.length - unresolved,
    },
    // PAGE-LEVEL TRUTH. When every row shares a state, that is one fact about
    // the property, not 92 warnings. The renderer states it once here and
    // shows a row badge only where a row DIFFERS. Computed server-side so the
    // page and the rows can never disagree about what is uniform.
    uniform: {
      all_unresolved: cohort.length > 0 && unresolved === cohort.length,
      no_owner_anywhere: cohort.length > 0 && withOwner === 0,
      owner_reason: cohort.length > 0 && withOwner === 0 ? R1_OWNER_REASON : null,
    },
    rows: cohort,
  };
}

module.exports = { renewalsCohort, GOVERNING_LEASE_STATUSES, DEFAULT_HORIZON_DAYS };
