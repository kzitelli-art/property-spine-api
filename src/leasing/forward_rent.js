/* ════════════════════════════════════════════════════════════════════
   forward_rent.js — THE ECONOMIC READING OF THE FORWARD LEASING POSITION

   It composes and stores nothing:

       Forward Leasing position   which beds, and their state
              +
       canonical lease terms      the dates, where established
              +
       established lease rent     CONTRACTUAL, where Spine has it
              +
       tracker rent claims        CLAIMED, source-backed
              +
       open-bed asking rents      ASSUMED, explicitly stated
              ↓
       a read

   ── FOUR WORDS, NEVER MIXED ─────────────────────────────────────────

     CONTRACTUAL   an amount established by governing lease evidence
     CLAIMED       a source-backed rent claim, not yet contractual truth
     ASSUMED       an explicit asking-rent assumption for an open bed
     PROJECTED     arithmetic over the three above

   $117,187 is CLAIMED committed rent. It is not proven contractual rent,
   and no label in this module may suggest it is. On the current import
   121 of 122 cycle leases carry no rent at all, so contractual rent is
   almost entirely NOT_ESTABLISHED — reported as that, never coerced to 0,
   because a zero would be a confident number that is wrong by the whole
   amount.

   ── THE LINE THIS MODULE WILL NOT CROSS ─────────────────────────────

   A DATED SCHEDULE NEEDS BOTH AN AMOUNT AND A TERM.

     amount evidence + term evidence   → it can be scheduled by month
     amount evidence, no term          → UNSCHEDULED, reported separately

   A claimed rent whose lease dates ARE established is scheduled — it
   stays claimed, but its months are real. The 16 late commitments have
   an amount and no governed term, and "Full Year" is a cohort label, not
   a term: allocating them across months would invent the exact fact the
   claim exists to admit is missing.

   NO DATED OPEN-BED FORECAST. The full-sell-out run rate is honest,
   because Mike stated an asking rent for each open bed. Placing those 16
   beds into future months would require a second assumption nobody has
   made — what term each will ultimately lease for — and silently
   assuming Full Year is exactly the invention this whole slice refuses.
   Run rate: yes. Dated committed schedule: yes. Dated open-bed forecast:
   NOT BUILT.

   ── AND NO ×12 ──────────────────────────────────────────────────────
   The monthly schedule comes from actual lease start/end dates. The
   January step-down at Skyline appears because 44 leases genuinely end in
   December, not because a `semester` label was stored anywhere.

   READ-ONLY. Authors nothing.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { forwardLeasingPosition } = require("./forward_leasing_read");
const { readAskingAssumptions } = require("./tracker_intake");

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/*  Months a lease actually governs inside the cycle. Whole months only:
 *  a partial month is still a month in which rent is owed, and inventing
 *  a proration here would be an accounting decision this module has no
 *  authority to make. Said out loud in the payload. */
function monthsBetween(cycle_start, cycle_end) {
  const out = [];
  const [ys, ms] = cycle_start.split("-").map(Number);
  const [ye, me] = cycle_end.split("-").map(Number);
  let y = ys, m = ms;
  while (y < ye || (y === ye && m <= me)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
const monthKey = (iso) => String(iso).slice(0, 7);

/*  Does this lease govern this month at all? Inclusive on both ends —
 *  a lease ending 2026-12-28 governs December and not January, which is
 *  where Skyline's step-down comes from. */
function governsMonth(lease, ym) {
  if (!lease.term_start) return false;
  const s = monthKey(lease.term_start);
  const e = lease.term_end ? monthKey(lease.term_end) : "9999-12";
  return ym >= s && ym <= e;
}

/*  ── A BOUNDARY MONTH IS NOT AN EARNED AMOUNT ────────────────────────
 *  `$815/mo` plus `starts 2026-08-03` does NOT establish what August
 *  earns. Neither does `ends 2027-07-26` establish a full July. The
 *  monthly rate and the term dates are both real and they are still not
 *  a charge: proration, the billing convention, concessions and the
 *  first/last-month treatment are all Money's, and none of them is
 *  recorded here.
 *
 *  So a month in which a contributing lease STARTS or ENDS part-way
 *  through is flagged. The rate is still shown — it is the run rate the
 *  active terms support — and the earned amount for that month is
 *  reported NOT_ESTABLISHED rather than silently prorated or silently
 *  presented as a full month's revenue. */
function isBoundaryFor(lease, ym) {
  if (!lease.term_start) return false;
  const startsHere = monthKey(lease.term_start) === ym &&
    Number(String(lease.term_start).slice(8, 10)) > 1;
  if (startsHere) return true;
  if (!lease.term_end) return false;
  if (monthKey(lease.term_end) !== ym) return false;
  //  Last day of that month, computed rather than assumed — a term ending
  //  on the 31st of a 31-day month is a whole month and not a boundary.
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Number(String(lease.term_end).slice(8, 10)) < last;
}

async function forwardRent(pool, {
  property_id, cycle_start, cycle_end, cycle_label = null,
} = {}) {
  const position = await forwardLeasingPosition(pool, {
    property_id, cycle_start, cycle_end, cycle_label,
  });

  //  ── the stated asking-rent assumptions, from the CURRENT source ──
  let asking = { source: null, assumptions: [] };
  let askingState = "ok";
  try {
    asking = await readAskingAssumptions(pool, { property_id, cycle_label });
  } catch (_) { askingState = "READ_FAILED"; }
  const askBySubject = new Map(
    (asking.assumptions || []).map((a) => [String(a.subject || "").trim().toLowerCase(), a]));

  const rows = position.ledger || [];
  const committed = rows.filter((r) => r.operating_state === "signed" || r.operating_state === "pending");
  /*  THE SAME OPEN SET THE SURFACE CALLS REMAINING — the tracker's, not
   *  Spine's leftover. 416A is on Mike's open list and reads CHECK, so
   *  filtering on operating_state alone returned 15 beds and priced 15,
   *  quietly disagreeing with the position shown one panel above it. */
  const openBeds = rows.filter((r) => r.operating_state === "remaining" || r.claim_state === "open");

  // ── BUCKET 1 · CONTRACTUAL ────────────────────────────────────────
  const contractualRows = committed.filter((r) => r.contracted_rent != null);
  const contractual = money(contractualRows.reduce((a, r) => a + r.contracted_rent, 0));

  // ── BUCKET 2 · CLAIMED ────────────────────────────────────────────
  const signedClaims = rows.filter((r) => r.claim_state === "signed" && r.claim_rent != null);
  const pendingClaims = rows.filter((r) => r.claim_state === "pending" && r.claim_rent != null);
  const signedClaimed = money(signedClaims.reduce((a, r) => a + r.claim_rent, 0));
  const pendingClaimed = money(pendingClaims.reduce((a, r) => a + r.claim_rent, 0));

  //  Claims Spine could not attach to a bed still carry an amount, and
  //  dropping them would understate the tracked figure by exactly the
  //  amount the malformed rows represent.
  const unattached = ((position.operating_position || {}).unattached_claims) || [];
  const unattachedSigned = money(unattached
    .filter((u) => /signed/i.test(u.tracker_status || "")).reduce((a, u) => a + (u.claimed_rent || 0), 0));
  const unattachedPending = money(unattached
    .filter((u) => /pending/i.test(u.tracker_status || "")).reduce((a, u) => a + (u.claimed_rent || 0), 0));

  // ── BUCKET 3 · ASSUMED ────────────────────────────────────────────
  //  Grouped by the bed's own unit type, matched to a STATED assumption.
  //  A type with no stated asking rent contributes NOTHING and is named:
  //  a missing assumption is not $0, and filling it with a mean of the
  //  others would manufacture the number this bucket exists to keep
  //  explicit.
  const byType = new Map();
  for (const r of openBeds) {
    //  The TRACKER's type first: the canonical unit_type is null until a
    //  reviewed mapping receipt exists, and the assumption's subject is
    //  written in the tracker's vocabulary ("2 BR, 1 BA").
    const t = (r.claim_unit_type || r.unit_type || "unknown");
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(r);
  }
  const assumptionLines = [];
  const unpricedTypes = [];
  for (const [type, beds] of byType) {
    const a = askBySubject.get(String(type).trim().toLowerCase());
    if (!a) { unpricedTypes.push({ unit_type: type, beds: beds.length }); continue; }
    assumptionLines.push({
      unit_type: type, beds: beds.length, asking_rent: money(a.amount),
      monthly: money(beds.length * a.amount),
      basis: a.basis || "asking rent stated by the operating tracker",
      source_row: a.source_row || null,
    });
  }
  const assumed = money(assumptionLines.reduce((a, l) => a + l.monthly, 0));

  // ── THE DATED SCHEDULE ────────────────────────────────────────────
  //  Only positions with BOTH an amount and an established term.
  const months = monthsBetween(String(cycle_start).slice(0, 10), String(cycle_end).slice(0, 10));
  const schedule = months.map((ym) => ({
    month: ym, contractual: 0, signed_claim: 0, pending_claim: 0, scheduled_total: 0,
    positions: 0,
    //  See isBoundaryFor(). A boundary month shows a RATE, not an earned
    //  amount, and says so.
    boundary_positions: 0,
    earned_rent_state: "run_rate",
  }));
  const idx = new Map(schedule.map((s, i) => [s.month, i]));

  const scheduled = [], unscheduled = [];
  for (const r of committed) {
    const amount = r.contracted_rent != null ? r.contracted_rent : r.claim_rent;
    const klass = r.contracted_rent != null ? "contractual"
      : (r.claim_state === "pending" ? "pending_claim" : "signed_claim");
    if (amount == null) {
      unscheduled.push({ space_id: r.space_id, unit_number: r.unit_number, space_label: r.space_label,
        reason: "no rent established or claimed for this position", amount: null, klass: null });
      continue;
    }
    if (!r.term_start) {
      /*  THE 16. An amount with no governed term. It is reported, with
       *  its money, and it never enters a month. */
      unscheduled.push({ space_id: r.space_id, unit_number: r.unit_number, space_label: r.space_label,
        reason: "contractual term not established", amount: money(amount), klass,
        cohort_label: r.claim_cohort || null });
      continue;
    }
    scheduled.push({ space_id: r.space_id, amount: money(amount), klass });
    for (const s of schedule) {
      if (!governsMonth(r, s.month)) continue;
      s[klass] = money(s[klass] + amount);
      s.scheduled_total = money(s.scheduled_total + amount);
      s.positions += 1;
      if (isBoundaryFor(r, s.month)) {
        s.boundary_positions += 1;
        s.earned_rent_state = "NOT_ESTABLISHED";
      }
    }
  }

  const unscheduledTotal = money(unscheduled.reduce((a, u) => a + (u.amount || 0), 0));

  return {
    property_id,
    cycle: position.cycle,

    /*  The vocabulary, in the payload, so no screen and no sentence has
     *  to remember which bucket a figure came from. */
    vocabulary: {
      contractual: "an amount established by governing lease evidence",
      claimed: "a source-backed rent claim from the operating tracker, not yet contractual truth",
      assumed: "an explicit asking-rent assumption for a bed that is still open",
      projected: "arithmetic over the three above — not a forecast",
    },

    committed_rent: {
      //  What Spine can actually stand behind, and how little that is.
      contractual: contractual,
      contractual_positions: contractualRows.length,
      //  With NO committed positions there is nothing established: the old
      //  first test was 0 === 0, so an empty cycle reported "established".
      contractual_state: committed.length === 0 ? "NOT_ESTABLISHED"
        : (contractualRows.length === committed.length ? "established"
        : (contractualRows.length === 0 ? "NOT_ESTABLISHED" : "partially_established")),
      contractual_missing_positions: committed.length - contractualRows.length,

      /*  ── ONE DECOMPOSITION, NO RESIDUE, NO OVERLAP ──────────────────
       *  "142 committed positions carry no established rent" sat under a
       *  headline reading 144, and the two could not be reconciled by a
       *  person looking at the screen. The gap was real and boring: 142 is
       *  the count of committed LEDGER ROWS, and two of the tracker's 144
       *  commitments are the malformed-identity claims that never attached
       *  to a bed. Both numbers were right and neither said which question
       *  it answered.
       *
       *  So the decomposition is stated once, it sums to the committed
       *  count the headline shows, and every commitment lands in exactly
       *  one bucket. If it ever fails to add up, `reconciles` says so
       *  rather than letting a footnote drift again. */
      decomposition: (() => {
        /*  ⚠ THE DENOMINATOR IS THE HEADLINE'S, and getting that wrong is
         *  what produced the ambiguity in the first place.
         *
         *  Mike's question is "how many of these 144 have contractual rent
         *  established?" — so the set being partitioned is the TRACKER's
         *  committed commitments, which is what the headline counts. The
         *  first version partitioned SPINE's committed ledger rows instead
         *  and compared the total to the tracker's headline: at Skyline
         *  both happen to cover every bed so it reconciled by luck, and on
         *  a tracker covering part of a property it reported 129 against a
         *  headline of 4.
         *
         *  Positions Spine holds a lease for that the tracker does not
         *  claim are REAL and are not in the 144. They get their own line
         *  rather than being dropped — dropping them would be the same
         *  residue problem pointing the other way. */
        const trackerCommitted = rows.filter(
          (r) => r.claim_state === "signed" || r.claim_state === "pending");
        const est = trackerCommitted.filter((r) => r.contracted_rent != null).length;
        const claimedOnly = trackerCommitted.filter(
          (r) => r.contracted_rent == null && r.claim_rent != null).length;
        const missing = trackerCommitted.filter(
          (r) => r.contracted_rent == null && r.claim_rent == null).length;
        const unattachedCount = unattached.length;
        const total = est + claimedOnly + missing + unattachedCount;
        const headline = (position.operating_position || {}).per_tracker_committed;
        //  Spine says committed, the tracker never mentioned it.
        const leasedNotClaimed = committed.filter(
          (r) => r.claim_state !== "signed" && r.claim_state !== "pending").length;
        return {
          committed: headline == null ? total : headline,
          contractual_rent_established: est,
          rent_claimed_only: claimedOnly,
          rent_missing: missing,
          //  Counted separately because they are commitments Spine cannot
          //  place on a bed — not because they are less real.
          claims_not_attached_to_a_bed: unattachedCount,
          sums_to: total,
          reconciles: headline == null || total === headline,
          committed_without_a_tracker_claim: leasedNotClaimed,
          note: "Every commitment the tracker counts appears in exactly one bucket, and the " +
                "buckets sum to the committed figure in the headline. " +
                (leasedNotClaimed
                  ? leasedNotClaimed + " further positions carry a governed lease the tracker " +
                    "does not mention; they are outside this decomposition and are listed here " +
                    "rather than dropped."
                  : "Every governed lease for this cycle is also claimed by the tracker."),
        };
      })(),

      //  What Mike is operating on.
      signed_rent_claims: money(signedClaimed + unattachedSigned),
      pending_rent_claims: money(pendingClaimed + unattachedPending),
      tracked_committed_rent: money(signedClaimed + unattachedSigned + pendingClaimed + unattachedPending),
      claims_not_attached_to_a_bed: money(unattachedSigned + unattachedPending),
      basis: "CLAIMED — from the operating tracker. Not proven contractual rent.",
    },

    open_bed_assumption: {
      read_state: askingState,
      source: asking.source,
      lines: assumptionLines,
      monthly: assumed,
      //  An open bed whose type has no stated asking rent contributes
      //  nothing and says so. Never averaged in.
      unpriced: unpricedTypes,
      complete: unpricedTypes.length === 0 && askingState === "ok",
      basis: "ASSUMED — asking rents stated by the operating tracker for beds still open.",
    },

    full_sell_out_run_rate: {
      monthly: money(signedClaimed + unattachedSigned + pendingClaimed + unattachedPending + assumed),
      basis: "PROJECTED — tracked committed rent plus the stated asking-rent assumption on " +
             "open beds. A monthly RUN RATE at full sell-out, not a dated forecast.",
      //  Said in the payload because the workbook does exactly this.
      not_annualisable: "Do not multiply by 12. Terms differ — at Skyline 44 beds end in " +
             "December — so an annual figure must come from the dated schedule, not this number.",
    },

    dated_schedule: {
      //  ⚠ THE NAME IS PART OF THE HONESTY. This is not a rent roll, not
      //  recognised revenue, and not GPR. It is the monthly RATE the
      //  active governed terms support.
      title: "Forward rent schedule — scheduled rent run-rate by active term",
      months: schedule,
      basis: "Positions with BOTH an amount and an established term. A claimed rent whose " +
             "lease dates are established IS scheduled — it stays claimed, its months are real.",
      boundary_doctrine:
        "Full-month rate shown where the governed term supports the whole period. " +
        "BOUNDARY-MONTH EARNED RENT IS NOT ESTABLISHED unless contractual billing evidence " +
        "exists: a $815/mo lease starting 2026-08-03 does not establish what August earns, " +
        "and one ending 2027-07-26 does not establish a full July. Proration, billing " +
        "convention, concessions and first/last-month treatment are Money's and are not " +
        "recorded here.",
      boundary_months: schedule.filter((s) => s.earned_rent_state === "NOT_ESTABLISHED")
        .map((s) => s.month),
      //  NOT BUILT, and said so rather than left to be inferred from an
      //  empty column.
      open_beds_not_forecast: "The " + openBeds.length + " open beds are NOT placed into months. " +
             "That would require assuming what term each will lease for, which nobody has stated.",
    },

    unscheduled_rent_claims: {
      count: unscheduled.length,
      monthly: unscheduledTotal,
      reason_breakdown: unscheduled.reduce((m, u) => { m[u.reason] = (m[u.reason] || 0) + 1; return m; }, {}),
      positions: unscheduled,
    },

    coverage: {
      committed_positions: committed.length,
      scheduled_commitments: scheduled.length,
      unscheduled_commitments: unscheduled.length,
      rent_established: contractualRows.length,
      rent_claimed: committed.filter((r) => r.contracted_rent == null && r.claim_rent != null).length,
      rent_missing: committed.filter((r) => r.contracted_rent == null && r.claim_rent == null).length,
      complete: unscheduled.length === 0 &&
                committed.filter((r) => r.contracted_rent == null).length === 0,
    },

    forward_leasing: position.headline,
    operating_position: position.operating_position,

    does_not_establish: [
      "Proven contractual rent. Almost every figure above is CLAIMED or ASSUMED, and the " +
      "buckets say which.",
      "Any dated forecast for the open beds. A run rate is not a schedule.",
      "Gross potential rent, NOI, NCF, debt service or valuation. None of those is built.",
      "Pace against a prior cycle — the historical commitment clock was never recorded.",
    ],
  };
}

module.exports = { forwardRent, _internal: { monthsBetween, governsMonth } };
