/* ════════════════════════════════════════════════════════════════════
   forward_leasing_read.js — THE 160-BED FORWARD LEASING LEDGER

   The operating question Mike opens a spreadsheet to answer:

       2026–27 LEASING
       144 / 160 committed · 16 remaining
       SIGNED 140    PENDING 4

   and underneath, the exact bed-by-bed ledger. This read produces both,
   from canonical dated lease truth and nothing else.

   ── WHAT IT IS, STRUCTURALLY ────────────────────────────────────────

       intervalPropertyPositions   which beds carry a governed dated
             (11b0bb1)             right overlapping the cycle
                    ↓
       COMMITMENT STATE            signed · pending · remaining ·
                                   unresolved — from lease_status, not
                                   from a flag anyone types
                    ↓
       THE LEDGER + THE HEADLINE

   There is NO forward store. No `preleased` column, no tracker status,
   no editable committed flag. A lease signed today moves this read
   because it moved `leases`; a lease cancelled today moves it the same
   way. That is the whole point, and it is what a spreadsheet cannot do.

   ── THE COMMITMENT BASIS ────────────────────────────────────────────

   A bed is committed for a cycle when a non-terminal governed lease
   OVERLAPS the cycle window. Measured against Mike's live tracker on
   2026-08-16 (docs/FORWARD_RENT_TRACE.md §1.3): 126 of 126 beds where
   Spine had evidence agreed, and ZERO beds were classified differently.
   The residue was 17 beds signed after the rent roll's as-of date —
   absent data, not disagreement.

   ⚠ IT IS THE WORKING BASIS, NOT A FROZEN ONE. Freezing it needs one
   rent roll dated after the last signing. The read carries the basis in
   its payload so no screen can show the count without it.

   ── SIGNED ≠ PENDING, AND NEITHER IS OCCUPANCY ──────────────────────

   `pending` is a real governed lease status (the tenancy anchor writes
   it) and it is NEVER folded into signed. An operator headline may add
   them — Mike's does — but the proof distinction stays underneath, so
   "how much is actually signed?" has an answer that is not the
   committed total.

   And none of this is occupancy. Occupancy is who is physically in the
   building today; this is how much of a future cycle has been sold.
   `datedPropertyPositions` answers the first. They are never added,
   subtracted, or quoted as each other.

   READ-ONLY. Authors nothing.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { intervalPropertyPositions } = require("../tenancy/dated_positions");
const { readTrackerClaims, _internal: intake } = require("./tracker_intake");

/*  Lease statuses that mean "signed" versus "not yet signed". A status
 *  Spine does not recognise is NOT quietly treated as signed — it lands
 *  in `unrecognised` and is reported, because a new status arriving from
 *  a future writer must not silently inflate a committed count. */
const SIGNED_STATUSES = new Set(["active", "current", "executed", "signed", "renewed"]);
const PENDING_STATUSES = new Set(["pending", "pending_signature", "out_for_signature"]);

/*  A TERM SHAPE IS DERIVED, NEVER STORED (docs/FORWARD_RENT_TRACE.md §1.5).
 *  Mike's `Full Year` / `Fall Only` labels reproduce from the lease end
 *  date alone — 43 of 44 bed-for-bed, with both differences explained by
 *  known defects. So Spine computes the label and does not add a column
 *  that could disagree with the dates beside it. */
function termShape(lease, cycle_start, cycle_end) {
  if (!lease || !lease.end_date) return "open_ended";
  const end = String(lease.end_date).slice(0, 10);
  const cs = String(cycle_start).slice(0, 10);
  const ce = String(cycle_end).slice(0, 10);
  //  A third of the way in is not a magic number — it is "ends nearer the
  //  start of the cycle than the end of it", which is what a fall-only
  //  term is. The threshold is REPORTED in the payload so a reader can
  //  see the rule rather than infer it from the label.
  const span = Date.parse(ce) - Date.parse(cs);
  const at = Date.parse(end) - Date.parse(cs);
  if (at <= span * 0.45) return "first_half_only";
  if (at >= span * 0.9) return "full_cycle";
  return "partial_cycle";
}

/*  ── THE CLAIM OVERLAY ───────────────────────────────────────────────
 *  Mike's operating position and Spine's proven position are BOTH real
 *  and they are not the same number. Showing only the canonical count
 *  pretends Spine knows less than the operator; manufacturing leases to
 *  match pretends it knows more than the evidence. So the read carries
 *  three layers and never adds them into one:
 *
 *      144  signed / pending per the current operating tracker
 *      128  tied to canonical lease truth
 *       16  awaiting contractual tie / review
 *
 *  A claim NEVER moves `headline` — that is canonical, from `leases`.
 *  The claim layer is its own object with its own vocabulary, so no
 *  consumer can accidentally read a spreadsheet row as a governed
 *  position. */
async function forwardLeasingPosition(pool, {
  property_id, cycle_start, cycle_end, cycle_label = null,
  include_claims = true,
} = {}) {
  if (!property_id) throw new Error("forwardLeasingPosition requires property_id");
  if (!cycle_start || !cycle_end) {
    const e = new Error("forwardLeasingPosition requires cycle_start and cycle_end");
    e.code = "CYCLE_REQUIRED";
    throw e;
  }

  const iv = await intervalPropertyPositions(pool, {
    property_id, requested_start: cycle_start, requested_end: cycle_end,
  });

  const ledger = [];
  const unrecognised = [];
  for (const p of iv.positions) {
    //  The governing right for THIS cycle. `colliding_rights` is exactly
    //  the set of non-terminal leases overlapping the window — the basis,
    //  already computed by the classifier. Not re-derived here.
    const rights = p.colliding_rights || [];
    const signed = rights.filter((l) => SIGNED_STATUSES.has(String(l.lease_status || "").toLowerCase()));
    const pending = rights.filter((l) => PENDING_STATUSES.has(String(l.lease_status || "").toLowerCase()));
    const other = rights.filter((l) =>
      !SIGNED_STATUSES.has(String(l.lease_status || "").toLowerCase()) &&
      !PENDING_STATUSES.has(String(l.lease_status || "").toLowerCase()));
    other.forEach((l) => unrecognised.push({
      space_id: p.space_id, unit_number: p.unit_number, space_label: p.space_label,
      lease_status: l.lease_status,
    }));

    let commitment_state;
    if (p.interval_state === "unresolved") commitment_state = "unresolved";
    else if (signed.length) commitment_state = "signed";
    else if (pending.length) commitment_state = "pending";
    else if (other.length) commitment_state = "unresolved";      // never "signed" by default
    else commitment_state = "remaining";

    //  The governing lease, when there is exactly one. More than one
    //  non-terminal right overlapping a cycle is not an economics
    //  question, it is a conflict, and it is reported as one.
    const governing = signed[0] || pending[0] || null;
    const contended = (signed.length + pending.length) > 1;

    ledger.push({
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,
      space_label: p.space_label,
      commitment_state,
      //  ⚠ RENT IS NULL WHEN UNKNOWN, NEVER 0 AND NEVER MARKET RENT.
      //  On the 07/31 import 121 of 122 cycle leases carry no rent,
      //  because a rent roll reports what is being COLLECTED on its
      //  as-of date and an August lease collects nothing in July.
      //  Coercing that to 0 would understate committed rent by the
      //  whole amount and look like a real number.
      contracted_rent: governing && governing.rent != null && Number(governing.rent) !== 0
        ? Number(governing.rent) : null,
      rent_state: !governing ? "not_applicable"
        : (governing.rent != null && Number(governing.rent) !== 0 ? "established" : "NOT_ESTABLISHED"),
      resident: governing && governing.tenants && governing.tenants.length
        ? governing.tenants.map((t) => t.name).filter(Boolean).join(", ") || null : null,
      term_start: governing ? governing.start_date : null,
      term_end: governing ? governing.end_date : null,
      term_shape: governing ? termShape(governing, cycle_start, cycle_end) : null,
      proof_basis: governing ? governing.proof_basis : null,
      contract_position: p.interval_state,
      contended,
      conflicting_lease_ids: p.conflicting_lease_ids || [],
    });
  }

  //  ── overlay the claim layer, labelled ──
  let claims = [];
  if (include_claims) {
    try {
      claims = await readTrackerClaims(pool, { property_id, cycle_label });
    } catch (e) {
      //  FAIL-SOFT BUT NEVER SILENT (§40.7). An empty claim layer and a
      //  claim layer that could not be read are different silences, and
      //  a screen that renders them identically tells an operator the
      //  tracker agrees when Spine simply could not look.
      claims = null;
    }
  }
  /*  ⚠ AN UNATTACHABLE CLAIM IS NOT AN ABSENT CLAIM.
   *
   *  The first version keyed the overlay on payload.space_id and let
   *  everything else fall out of the read. The two identity-conflict
   *  claims have no space_id — that is the whole point of them — so the
   *  overlay reported 139 signed / 3 pending instead of 140 / 4, dropped
   *  $700 and $1,100 of claimed rent, and printed `needs_review: 0` while
   *  five claims sat in needs_review.
   *
   *  Silently smaller, and internally consistent, which is the dangerous
   *  kind of wrong. So the tracker's OWN position is counted from every
   *  claim row, and the ones Spine cannot attach to a bed are surfaced as
   *  their own bucket with their reasons. */
  const byBed = new Map();
  const unattached = [];
  /*  ── AN UNRESOLVED IDENTITY TAINTS THE BEDS IT COULD MEAN ──────────
   *  A malformed claim names a unit and two possible ordinals. The bed it
   *  did NOT land on must not quietly become "remaining": absence of
   *  resolved evidence is not evidence of availability, and that is the
   *  exact failure this whole slice exists to eliminate.
   *
   *  Bed 405B is the live case. Row 141's Unit cell says 405B and its Room
   *  cell says A, so nothing attaches to 405B — and reading that as an
   *  open bed would invent a vacancy out of a typo. It is unresolved. */
  const taintedBeds = new Map();
  for (const c of claims || []) {
    const p = c.payload_json || {};
    if (p.reconciliation === "identity_conflict" && p.unit) {
      for (const ord of [p.ordinal_from_unit_cell, p.ordinal_from_room_cell]) {
        if (ord) taintedBeds.set(`${p.unit}#${ord}`, c);
      }
    }
  }
  for (const c of claims || []) {
    const p = c.payload_json || {};
    if (p.space_id) byBed.set(String(p.space_id), c);
    else unattached.push({
      claim_id: c.id, natural_key: c.natural_key, status: c.status,
      reason: c.status_reason,
      tracker_status: p.tracker_status || null,
      raw_unit: p.raw_unit || null,
      claimed_rent: p.monthly_rent == null ? null : Number(p.monthly_rent),
    });
  }
  //  Counted from the claims themselves, never from what attached.
  const allClaims = (claims || []).map((c) => c.payload_json || {});
  const trackerSigned = allClaims.filter((p) => p.signed).length;
  const trackerPending = allClaims.filter((p) => p.pending).length;
  const trackerSignedRent = allClaims.filter((p) => p.signed)
    .reduce((a, p) => a + (p.monthly_rent || 0), 0);
  const trackerPendingRent = allClaims.filter((p) => p.pending)
    .reduce((a, p) => a + (p.monthly_rent || 0), 0);
  const reviewClaims = (claims || []).filter((c) => c.status === "needs_review" || c.status === "blocked");
  const bedKeyOf = (row) => `${String(row.unit_number).replace(/^\d{3,4}-(?=\d)/, "")}#` +
    String(row.space_label || "").replace(/\D/g, "");
  for (const row of ledger) {
    const c = byBed.get(String(row.space_id));
    const p = c ? (c.payload_json || {}) : null;
    //  Tainted only when nothing resolved landed here — a bed that DID
    //  attach a claim is answered, whatever else the source got wrong.
    const tainted = !c && taintedBeds.get(bedKeyOf(row));
    row.identity_exception = tainted ? {
      claim_id: tainted.id,
      reason: "A tracker row names this bed ambiguously, so nothing could be attached to it. " +
              "Unresolved is not open — a human resolves the source row.",
    } : null;
    //  PROOF LEVEL — what Spine can stand behind for this bed, said out
    //  loud on every row. "Lease tied" is canonical; "Tracker claim" is
    //  an operating claim awaiting the executed lease; "Needs review" is
    //  a human decision Spine refuses to make for them.
    row.claim_state = p ? (p.signed ? "signed" : p.pending ? "pending" : "open") : null;
    row.claim_rent = p && p.monthly_rent != null ? Number(p.monthly_rent) : null;
    row.claim_resident = p ? (p.resident_name || null) : null;
    row.claim_cohort = p ? (p.cohort_label || null) : null;
    /*  The tracker's own unit type. The canonical `unit_type` is null until
     *  a reviewed mapping receipt exists (migration 100), so without this
     *  every open bed matched no asking-rent assumption and the whole
     *  open-bed bucket silently came out $0 — a plausible-looking total
     *  that was wrong by $13,345. */
    row.claim_unit_type = p ? (p.unit_type || null) : null;
    row.claim_new_or_renewal = p ? (p.new_or_renewal || null) : null;
    row.claim_status = c ? c.status : null;
    row.claim_reason = c ? c.status_reason : null;
    /*  ⚠ A REVIEW CLAIM OUTRANKS A CANONICAL TIE, and the order is the
     *  whole requirement. The first version tested `commitment_state`
     *  first, so bed 416A — where Spine holds a lease and the tracker
     *  says the bed is OPEN — rendered SIGNED · LEASE TIED and the
     *  disagreement vanished into Spine's side of it.
     *
     *  That is the failure this surface exists to prevent. A bed where
     *  the two sources contradict each other is not signed and not
     *  remaining; it is a question, and it must read as one. */
    row.proof =
      row.identity_exception ? "needs_review"
        : (c && (c.status === "needs_review" || c.status === "blocked")) ? "needs_review"
          : row.commitment_state === "unresolved" ? "needs_review"
            : row.commitment_state === "signed" || row.commitment_state === "pending" ? "lease_tied"
              : p && (p.signed || p.pending) ? "tracker_claim"
                : "none";
    //  The operating state Mike recognises: canonical where Spine has a
    //  lease, the tracker's claim where it does not, and CHECK wherever
    //  the two disagree or a human is owed a decision.
    /*  ── STATE AND PROOF ARE DIFFERENT AXES, AND ONLY ONE KIND OF
     *     REVIEW MOVES THE STATE ────────────────────────────────────────
     *  STATE answers what Mike is operating. PROOF answers how well Spine
     *  can stand behind it. A rent disagreement is an ECONOMIC dispute —
     *  111A and 305A are signed to the operator and signed in the lease,
     *  and the two sources merely disagree about the amount. Those stay
     *  SIGNED · NEEDS REVIEW.
     *
     *  What genuinely makes a bed a question is a disagreement about the
     *  COMMITMENT itself: the tracker says open and a canonical lease says
     *  committed (416A), the position is contested, or the identity could
     *  not be resolved at all (405B). Only those read CHECK.
     *
     *  The first version made `proof === needs_review` imply CHECK, which
     *  demoted two correctly-signed beds over an amount. */
    const stateDisputed =
      !!row.identity_exception ||
      row.commitment_state === "unresolved" ||
      (p && p.reconciliation === "open_but_leased") ||
      (c && c.status === "blocked");
    row.operating_state =
      stateDisputed ? "check"
        : row.commitment_state === "signed" ? "signed"
          : row.commitment_state === "pending" ? "pending"
            : row.claim_state === "signed" ? "signed"
              : row.claim_state === "pending" ? "pending"
                : "remaining";
  }

  const count = (s) => ledger.filter((r) => r.commitment_state === s).length;
  const signedRows = ledger.filter((r) => r.commitment_state === "signed");
  const pendingRows = ledger.filter((r) => r.commitment_state === "pending");
  const sum = (rows) => rows.reduce((a, r) => a + (r.contracted_rent || 0), 0);
  const missing = (rows) => rows.filter((r) => r.rent_state === "NOT_ESTABLISHED").length;

  const positions = ledger.length;
  const committed = count("signed") + count("pending");

  return {
    property_id,
    cycle: { label: cycle_label, start: String(cycle_start).slice(0, 10), end: String(cycle_end).slice(0, 10) },

    /*  THE BASIS TRAVELS WITH THE NUMBER. A committed count is not a
     *  fact until it says what committed means (§40.10). No screen and
     *  no sentence may show the headline without this. */
    commitment_basis: {
      rule: "a non-terminal governed lease overlapping the cycle window",
      status: "WORKING — not frozen",
      evidence: "reproduced Mike's live tracker on every bed where Spine had evidence " +
                "(126/126 agree, 0 classified differently); 17 beds untested because they " +
                "were signed after the rent roll's as-of date",
      freezes_when: "one rent roll dated after the last signing resolves the untested beds",
    },

    headline: {
      positions,
      signed: count("signed"),
      pending: count("pending"),
      committed,
      remaining: count("remaining"),
      unresolved: count("unresolved"),
      committed_pct: positions ? Number(((100 * committed) / positions).toFixed(1)) : null,
    },

    economics: {
      //  Four numbers, never merged. "How much is actually signed" must
      //  not be answerable only as the committed total.
      signed_rent: sum(signedRows),
      pending_rent: sum(pendingRows),
      committed_rent: sum(signedRows) + sum(pendingRows),
      //  …and the honesty beside them. A rent total computed from rows
      //  where most rents are unknown is not a small error, it is a
      //  different number, so the count of unknowns rides along and a
      //  consumer that ignores it is publishing a fiction.
      rent_not_established: missing(signedRows) + missing(pendingRows),
      rent_established: signedRows.length + pendingRows.length - (missing(signedRows) + missing(pendingRows)),
      complete: (missing(signedRows) + missing(pendingRows)) === 0,
    },

    /*  THREE LAYERS, NEVER SUMMED. `headline` is canonical. This is the
     *  operating position Mike recognises, with the proof level attached
     *  so the screen can say WHY each bed is where it is. */
    operating_position: claims === null ? {
      read_state: "READ_FAILED",
      note: "The claim layer could not be read. This is NOT the same as no claims existing, " +
            "and it must not render as agreement.",
    } : {
      read_state: "ok",
      claims_present: (claims || []).length,
      //  THE TRACKER'S OWN POSITION, from every claim row — not only the
      //  ones Spine could attach to a bed.
      per_tracker_signed: trackerSigned,
      per_tracker_pending: trackerPending,
      per_tracker_committed: trackerSigned + trackerPending,
      tied_to_canonical_lease: ledger.filter((r) => r.proof === "lease_tied").length,
      awaiting_contractual_tie: ledger.filter((r) => r.proof === "tracker_claim").length,
      needs_review: reviewClaims.length,
      /*  MIKE'S REMAINING, which is the tracker's open set — not Spine's
       *  leftover. 416A is on his open list AND reads CHECK, so counting
       *  only operating_state==='remaining' returned 15 and the headline
       *  stopped adding to 160. A disputed bed is still a bed he is trying
       *  to lease; it is the ROW that must show the dispute, not the total
       *  that must hide the bed. */
      remaining: ledger.filter((r) => r.claim_state === "open" || r.operating_state === "remaining").length,
      //  Named, never dropped. Each of these is a bed the tracker counts
      //  and Spine cannot place, so the two totals legitimately differ and
      //  the difference is explained rather than absorbed.
      unattached_claims: unattached,
      //  Beds a malformed source row could have meant, which therefore
      //  cannot be called open. Named so the exception is inspectable.
      identity_exceptions: ledger.filter((r) => r.identity_exception)
        .map((r) => ({ space_id: r.space_id, unit_number: r.unit_number, space_label: r.space_label })),
      //  ⚠ A TRACKER RENT IS A CLAIM, NOT CONTRACTED RENT. Labelled so
      //  no caller can quote it as governed economics because Mike typed
      //  it into Excel.
      tracked_signed_rent_claims: trackerSignedRent,
      tracked_pending_rent_claims: trackerPendingRent,
      rent_basis: "CLAIMED — from the operating tracker, not established contractual rent",
    },

    term_shapes: ledger.reduce((m, r) => {
      if (r.term_shape) m[r.term_shape] = (m[r.term_shape] || 0) + 1;
      return m;
    }, {}),

    //  Reported, never absorbed. A lease status this read does not
    //  recognise must not become "signed" by falling through a default.
    unrecognised_lease_statuses: unrecognised,

    ledger,

    does_not_establish: [
      "Physical occupancy. This is how much of a future cycle has been sold, not who is " +
      "in the building today — datedPropertyPositions answers that, and the two are never " +
      "added, subtracted or quoted as each other.",
      "Whether a remaining bed can be marketed, shown or offered. That is operating " +
      "availability and it is availability_read's answer.",
      "Projected gross rent. Committed rent is contracted truth; filling open beds at an " +
      "asking rent is an assumption and belongs to a separate, explicit composition.",
      "Pace against a prior cycle. When each bed BECAME committed is not recorded for any " +
      "imported population and cannot be reconstructed — see LEASING_CYCLE_AND_PACE_TRACE §5.",
    ],
  };
}

module.exports = { forwardLeasingPosition, _internal: { termShape, SIGNED_STATUSES, PENDING_STATUSES } };
