// ════════════════════════════════════════════════════════════════════
//  position_classifier.js — THE SHARED MEANING OF A RENTABLE POSITION
//
//  PURE. No database access, no I/O, no clock. It receives already-loaded
//  data and returns facts. All SQL and assembly stay in space_position.js.
//
//  This exists because four surfaces — Current Rent Roll, Renewals,
//  Availability and Future Rent Roll — are the SAME property truth viewed
//  at different dates. Each may add its own context. None may redefine
//  what these facts MEAN:
//
//      lease spanning · successor state · notice state
//      conflict state · availability state · proof basis
//
//  Extracted 2026-07-27 after `notice_given` was found being independently
//  re-derived in three places (availability.js, space_position.js and the
//  first cut of renewals_read.js) with three vocabularies for one fact.
//  Shared facts are derived once; each surface adds context, not a new
//  meaning. Being pure, this is also the first part of the position read
//  that can be tested without a database.
//
//  BEHAVIOUR-PRESERVING BY CONSTRUCTION: the logic below was moved
//  verbatim from space_position.js. Characterization tests run the
//  pre-extraction implementation and this one against the same live data
//  and assert deep equality, so "no behaviour change" is proven rather
//  than asserted.
// ════════════════════════════════════════════════════════════════════

"use strict";

/*  ONE declaration of "this lease no longer governs". lease_void_service
 *  owns the list and documents it as "statuses the overlap check already
 *  ignores"; operative_overlap.js imports it. This file used to restate
 *  it — two declarations of one vocabulary, which is how the write side
 *  and the read side come to disagree about what a retired lease is. */
const { RETIRED_STATUSES } = require("./lease_void_service.js");
const TERMINAL_LEASE_STATUSES = new Set(RETIRED_STATUSES);

/*  Statuses under which a lease establishes CURRENT economic tenancy. */
const CURRENT_ECONOMIC_STATUSES = new Set(["active", "commercial"]);

/*  ── KNOWN, ON RECORD, NOT YET ACTIVATED ──────────────────────────────
 *  A lease is on record for the bed, its start date has arrived, and the
 *  requirements for Spine to establish current tenancy have not cleared.
 *  That is Pending Activation, and it is the same condition whether the
 *  status word is 'pending' or 'signed'.
 *
 *  'signed' used to be in NEITHER list — not terminal, not current, not
 *  pending — so a signed lease spanning the date emitted nothing at all
 *  and the bed was indistinguishable from an empty one. The fix is not to
 *  add it to an allow-list of things that count as occupied; it is to
 *  recognise that we understand exactly what a signed lease is. */
const ACTIVATION_PENDING_STATUSES = new Set(["pending", "signed"]);

function normalizedStatus(lease) {
  return String(lease && lease.lease_status || "").toLowerCase();
}
function leaseIsValid(lease) {
  return !!lease && !TERMINAL_LEASE_STATUSES.has(normalizedStatus(lease));
}
/*  CANONICAL DAY KEY — 'YYYY-MM-DD' or null.
 *
 *  The only safe basis for comparing two dates in this file. Accepts the
 *  canonical string the loader produces (json_build_object serialises a
 *  Postgres `date` as 'YYYY-MM-DD'), an ISO timestamp, or a JS Date.
 *  Anything it cannot place on a calendar day returns null, and every
 *  caller must decide what null means rather than letting it compare.
 *
 *  A Date is read through its LOCAL components, never toISOString().
 *  node-postgres parses a DATE column to local midnight; west of UTC
 *  toISOString() then reports the PREVIOUS day, which is a one-day
 *  possession error that only appears in some deployments.             */
function dateKey(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  /*  ── THE ACCEPTED GRAMMAR: ANCHORED, AND RANGE-CHECKED ───────────
   *
   *  Two corrections live here, each earned by a value that slipped past
   *  the version before it.
   *
   *  1. ANCHORED AT BOTH ENDS. This was once a PREFIX match, so
   *     '2026-09-20garbage' and '2026-09-20Tgarbage' keyed as 2026-09-20
   *     and were answered. A valid calendar prefix is not evidence that
   *     the whole value is a date.
   *
   *  2. SHAPE IS NOT RANGE. Anchoring alone still accepted
   *     '2026-09-20T99:99Z', '2026-09-20T23:59:99Z' and
   *     '…T13:45:00+99:00' — digit-shaped clock fields that are not
   *     times. Every component supplied is now captured and checked.
   *
   *  Exactly two string forms are supported, and no others:
   *
   *      YYYY-MM-DD
   *      YYYY-MM-DDTHH:MM[:SS[.frac]][Z|±HH[:]MM|±HH]
   *
   *  with hour 00-23, minute 00-59, second 00-59, and an offset within the
   *  real ISO 8601 span of -12:00 … +14:00 (Kiribati is +14:00, and +14:00
   *  admits no minutes). No locale forms — '09/20/2026' is a date only
   *  under DateStyle MDY, and an answer that depends on a database session
   *  setting is not a governed answer. No trailing characters, no
   *  whitespace, no half-written timestamp.
   *
   *  THE DATE IS THE ONE WRITTEN. The offset is VALIDATED but never
   *  APPLIED: a timestamp carrying an offset denotes an instant whose
   *  calendar day differs by zone, so re-projecting it would make the
   *  answer depend on a zone policy nobody declared — the same hazard as
   *  DateStyle, one level down. Nothing here parses the value as a Date to
   *  derive the day; only the written Y-M-D is used, and Date.UTC appears
   *  solely to validate that those three written fields name a real day. */
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):?(\d{2})|([+-])(\d{2}))?)?$/
    .exec(String(value));
  if (!m) return null;

  const inRange = (v, lo, hi) => v === undefined || (Number(v) >= lo && Number(v) <= hi);
  if (!inRange(m[4], 0, 23)) return null;   // hour
  if (!inRange(m[5], 0, 59)) return null;   // minute
  if (!inRange(m[6], 0, 59)) return null;   // second, when supplied

  /*  A time-of-day at all requires BOTH hour and minute; the pattern only
   *  matches them together, so this is a belt-and-braces read of intent.  */
  if ((m[4] === undefined) !== (m[5] === undefined)) return null;

  //  Offset, in either supported spelling (±HH:MM / ±HHMM, or ±HH).
  const offSign = m[7] || m[10];
  const offHour = m[8] !== undefined ? m[8] : m[11];
  const offMin  = m[9] !== undefined ? m[9] : "00";
  if (offSign) {
    const oh = Number(offHour), om = Number(offMin);
    if (!Number.isInteger(oh) || !Number.isInteger(om)) return null;
    if (om < 0 || om > 59) return null;
    const total = oh * 60 + om;
    //  -12:00 … +14:00 — the actual ISO 8601 / tzdata span, declared rather
    //  than assumed, so a reader can see what "supported" means.
    if (offSign === "+" && total > 14 * 60) return null;
    if (offSign === "-" && total > 12 * 60) return null;
  }

  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/*  THE ONE TEMPORAL KEY EVERY ARM OF classifyPosition CONSUMES.
 *
 *  Absent asOf stays allowed and undated — both production entries default
 *  the date before calling, so this branch is reached only by a direct
 *  caller, and refusing it would break them for no gain.
 *
 *  A PRESENT asOf THAT IS NOT A DAY IS REFUSED, and that is the whole
 *  correction. It used to fall back to null and mean "apply no bound",
 *  which silently reinstated the future-event leak the temporal boundary
 *  closes. Measured on the real read path, resident in possession since
 *  2026-09-15, asked about 2026-09-20:
 *
 *      as_of=2026-09-20   possession delivered · econ active
 *      as_of=2026-9-20    possession PENDING   · econ active
 *      as_of=09/20/2026   possession PENDING   · econ FORWARD
 *
 *  The last line is why this refuses rather than guesses. `forward` on an
 *  occupied bed is availability_state committed_future — Spine offering a
 *  bed someone lives in, with a story attached. Postgres accepts all three
 *  as ::date, so the openingBaselineAsOf cast upstream lets them through;
 *  nothing else was checking.
 *
 *  NOT ACCEPTED-AND-NORMALISED, on purpose. '2026-9-20' is unambiguous, but
 *  '09/20/2026' is only a date under DateStyle MDY — under DMY the same
 *  request means a different day. An answer that depends on a database
 *  session setting is not a governed answer.                              */
function asOfKeyOrRefuse(asOf) {
  if (asOf === null || asOf === undefined) return null;
  const key = dateKey(asOf);
  if (key === null) {
    const e = new Error(
      `as_of must be a calendar date as YYYY-MM-DD; received ${JSON.stringify(String(asOf))}`);
    e.code = "INVALID_AS_OF";
    throw e;
  }
  return key;
}

function datesSpan(lease, asOf) {
  return !!(lease && lease.start_date && lease.start_date <= asOf && (!lease.end_date || lease.end_date >= asOf));
}
function isFuture(lease, asOf) {
  return !!(lease && lease.start_date && lease.start_date > asOf);
}
function tenantList(lease, personNames) {
  return (lease.tenant_ids || []).filter(Boolean).map((person_id) => ({
    person_id,
    name: personNames && personNames.has(String(person_id)) ? personNames.get(String(person_id)) : null,
  }));
}

// Two non-terminal leases on one space whose date ranges intersect. An open
// end_date runs forever. This is the ONE definition of a contested position.
function rangesOverlap(a, b) {
  if (!a || !b || !a.start_date || !b.start_date) return false;
  const aEnd = a.end_date ? String(a.end_date) : "9999-12-31";
  const bEnd = b.end_date ? String(b.end_date) : "9999-12-31";
  return String(a.start_date) <= bEnd && String(b.start_date) <= aEnd;
}

// HOW WE KNOW A LEASE IS TRUE — one answer, shared by every surface.
//   native_verified          executed through Spine AND required move-in
//                            funds cleared. The governed locked rule.
//   confirmed_opening_import accepted as the property's opening contractual
//                            truth from a governed source.
//   unproven                 anything else. Never counts as locked.
// Deliberately NOT collapsed: an imported lease is real operating truth, but
// it did not pass proof steps it never passed, and that stays visible.
// THE governed locked rule, written ONCE. proofBasis and
// classifyFutureCommitment both ask it, so "executed AND funded" cannot drift
// into two subtly different tests — which it briefly had.
function isNativelyProven(lease) {
  return !!(lease && lease.executed_verified && lease.move_in_funds_cleared);
}

function proofBasis(lease) {
  if (!lease) return null;
  if (isNativelyProven(lease)) return "native_verified";
  if (lease.source_type === "historical_snapshot" && lease.confidence === "confirmed") return "confirmed_opening_import";
  return "unproven";
}

// ── ONE FUTURE-COMMITMENT CLASSIFICATION ─────────────────────────────
//  Used for BOTH shapes of future commitment:
//    · a successor after a current/governing lease
//    · a standalone future lease on an otherwise vacant position
//
//  Before this existed only the successor path carried proof. A standalone
//  future lease produced successor.state === 'none' (the successor block
//  requires a governing lease with an end_date), so availability_read fell
//  through to an unconditional committed_future → successor_locked. An
//  unfunded pending future lease on a vacant position was therefore suppressed
//  from marketing correctly and then LABELLED LOCKED — a state stronger than
//  the proof the lease actually carried.
//
//  LOCKED is the same governed rule everywhere: executed AND funded. A
//  'pending' lease_status alone never closes a position, and absence of a
//  required move-in charge set is NOT funded (see space_position.js).
//
//  proof_basis is carried, never collapsed. A confirmed opening import is real
//  operating truth that may suppress marketing, but it did not pass native
//  execution and funding, and callers must be able to tell the difference.
//  ── IT CARRIES WHO AND WHAT, NOT ONLY WHEN ──────────────────────────
//  This returned the commitment's DATE and PROOF but not its tenants,
//  term end or rent, so any surface wanting to say "Next: Emily Chen ·
//  starts 8/1/27 · $875" had to go back to `leases` and work out which row
//  was the successor a second time. That is a second derivation of a fact
//  the classifier had already decided, and two derivations of one fact
//  drift.
//
//  So the commitment carries the same shaped payload the current lease
//  does. `personNames` is threaded in for the same reason it is threaded
//  into the current lease — names are data the caller already loaded, and
//  the classifier stays pure.
//
//  end_date and rent are carried as they are, NULL included: a future
//  lease whose rent the source never stated must read as unknown, never
//  as $0 (§5, §39).
function classifyFutureCommitment(lease, personNames) {
  if (!lease) {
    return { state: "none", lease_id: null, start_date: null, end_date: null,
             rent: null, tenants: [], proof_basis: null, locked: false };
  }
  const locked = isNativelyProven(lease);
  return {
    state: locked ? "locked" : "pending",
    lease_id: lease.id,
    start_date: lease.start_date || null,
    end_date: lease.end_date || null,
    rent: lease.rent == null ? null : Number(lease.rent),
    tenants: tenantList(lease, personNames),
    proof_basis: proofBasis(lease),
    locked,
  };
}

// ── THE CLASSIFIER ───────────────────────────────────────────────────
//  row          one loaded space: { space_id, unit_id, unit_number,
//               space_label, leases[], possession_events[], notice_date,
//               turn_status, compat_occupancy }
//  asOf         'YYYY-MM-DD'
//  personNames  Map(person_id → name) — data, already loaded
function classifyPosition(row, { asOf, personNames } = {}) {
  /*  ONE KEY, COMPUTED ONCE, CONSUMED BY EVERY TEMPORAL ARM BELOW.
   *  No arm compares the raw argument: the lease arms (current /
   *  activation-pending / future / other-spanning / conflict) and the
   *  possession filter all read `asOfKey`. A second normalisation site is
   *  how the two axes drifted apart in the first place — the possession
   *  filter was bounded while datesSpan next door still compared a raw
   *  string, so one request could answer `active` and `pending` at once. */
  const asOfKey = asOfKeyOrRefuse(asOf);
  const leases = (row.leases || []).filter(leaseIsValid);
  const current = leases.find((lease) => CURRENT_ECONOMIC_STATUSES.has(normalizedStatus(lease)) && datesSpan(lease, asOfKey)) || null;
  const activationPending = leases.find((lease) =>
    ACTIVATION_PENDING_STATUSES.has(normalizedStatus(lease)) && datesSpan(lease, asOfKey)) || null;
  const future = leases.find((lease) => isFuture(lease, asOfKey)) || null;

  /*  ── A SPANNING LEASE WHOSE STATUS WE DO NOT UNDERSTAND ───────────
   *  A DIAGNOSTIC, and a fail-closed one. Not a home for statuses we do
   *  understand: 'signed' belongs in activation_pending above, because a
   *  signed lease on record whose start date has arrived is exactly the
   *  Pending Activation condition.
   *
   *  leases.lease_status has no CHECK constraint, so the vocabulary is
   *  open and the next status somebody writes lands here by default. What
   *  must never happen is that it lands in Open — a lease Spine holds
   *  over a bed, whose meaning it cannot classify, is a reason to stop,
   *  not a reason to offer the bed. */
  const otherSpanning = leases.filter((lease) =>
    datesSpan(lease, asOfKey)
    && !CURRENT_ECONOMIC_STATUSES.has(normalizedStatus(lease))
    && !ACTIVATION_PENDING_STATUSES.has(normalizedStatus(lease)));

  /*  ── A POSITION AT as_of D MAY ONLY USE EVENTS EFFECTIVE BY D ──────
   *
   *  This filter is the temporal boundary of the possession axis, and it
   *  is the ONE place that owns it. Until it existed, `ins`/`outs` below
   *  took the GLOBALLY latest possession events and `asOf` never entered
   *  the computation — it governed the lease arms (datesSpan / isFuture)
   *  and the opening baseline (openingBaselineAsOf bounds itself with
   *  `as_of_date <= $2::date`) while possession ran unbounded.
   *
   *  Observed, not inferred, on real Postgres — a move_in effective
   *  2026-09-15 read at as_of 2026-08-24 returned:
   *
   *      current_possession { since: "2026-09-15" }
   *      possession_state   "delivered"
   *
   *  Possession claimed to have begun 22 days AFTER the date asked about.
   *  That is confident-wrong (§5), not a rounding error: it is the system
   *  narrating a tenancy that had not started.
   *
   *  ONE FILTER, BOTH DIRECTIONS. It sits before the move_in/move_out
   *  split on purpose. The mirror defect is a move_out effective after
   *  asOf ending possession early in a historical answer, and bounding
   *  the shared list closes both. Filtering only `ins` would fix the
   *  louder half and leave the quieter half, which is worse — a bed
   *  reported empty while someone lived in it.
   *
   *  IT DOES NOT BELONG IN THE LOADER. loadSpaceRows is shared by the
   *  single-date read and the interval reader, which need DIFFERENT
   *  bounds; pushing the filter down there is how a second filtered
   *  loader gets born. classifyPositionForInterval is unaffected either
   *  way — it reads leases only and never touches possession events.
   *
   *  NOT String(Date). A JS Date stringifies to weekday form
   *  ("Tue Sep 15 2026"), which compares lexically against 'YYYY-MM-DD'
   *  as garbage — silently, and in a direction nobody predicts. Every
   *  side of every comparison here is a canonical YYYY-MM-DD key.       */
  const allEvents = row.possession_events || [];
  /*  asOfKey is null ONLY when asOf was absent — a present-but-unusable
   *  one was refused at the top. Undated keeps its old undated behaviour;
   *  it can no longer be reached by a malformed date.                   */
  const events = asOfKey === null ? allEvents : allEvents.filter((e) => {
    const k = dateKey(e && e.effective_date);
    /*  AN UNUSABLE EVENT DATE IS NOT CURRENT POSSESSION. Spine cannot
     *  place it in time, so it cannot say it had happened by asOf. It is
     *  dropped rather than admitted — honest blank over confident wrong. */
    return k !== null && k <= asOfKey;
  });
  const ins = events.filter((e) => e.event_type === "move_in");
  const outs = events.filter((e) => e.event_type === "move_out");
  const lastIn = ins.length ? ins[ins.length - 1] : null;
  const lastOut = outs.length ? outs[outs.length - 1] : null;
  const possessed = !!lastIn && (!lastOut || lastOut.effective_date < lastIn.effective_date ||
    (lastOut.effective_date === lastIn.effective_date && String(lastOut.created_at) < String(lastIn.created_at)));
  const turning = row.turn_status === "in_progress";

  let availability_state = "unavailable";
  let available_from = null;
  if (current) {
    availability_state = row.notice_date ? "on_notice" : "unavailable";
    available_from = row.notice_date || null;
  } else if (activationPending) {
    availability_state = "committed_activation_pending";
  } else if (possessed) {
    availability_state = "unavailable";
  } else if (turning) {
    availability_state = "vacant_turning";
  } else if (future) {
    availability_state = "committed_future";
    available_from = future.start_date;
  } else {
    availability_state = "ready_now";
    /*  The canonical key when dated; the original argument when undated, so
     *  the undated shape (an absent value, not null) is unchanged.       */
    available_from = asOfKey === null ? asOf : asOfKey;
  }

  let next_required_action = null;
  let reason = null;
  if (activationPending) {
    next_required_action = "economic_tenancy_activation_required";
    reason = `Lease commenced ${activationPending.start_date}, but economic tenancy is not active — confirm and collect required move-in charges before current rent-roll activation.`;
  } else if (current && !possessed) {
    next_required_action = "possession_outstanding";
    reason = `Lease is active from ${current.start_date}; resident is current on the rent-roll axis, but keys/access handoff has not been recorded.`;
  } else if (future && possessed) {
    next_required_action = "review_early_possession";
    reason = `Possession was recorded before the committed lease start ${future.start_date}.`;
  } else if (future && turning) {
    next_required_action = "turn_before_committed_start";
    reason = `Committed for ${future.start_date}, but the unit turn is still in progress.`;
  } else if (!current && !activationPending && !future && possessed) {
    next_required_action = "possession_without_current_lease";
    reason = "Someone is in possession with no active current lease on the space.";
  }

  const shapeLease = (lease) => lease ? {
    lease_id: lease.id,
    lease_status: lease.lease_status,
    start_date: lease.start_date,
    end_date: lease.end_date || null,
    rent: lease.rent == null ? null : Number(lease.rent),
    tenants: tenantList(lease, personNames),
    proof_basis: proofBasis(lease),
  } : null;

  /*  ── CONFLICT: A CONTESTED POSITION *ON THIS DATE* ─────────────────
   *  Which lease governs is unknown, so it must never be silently
   *  resolved to the first match.
   *
   *  ⚠ THIS USED TO ASK THE WRONG QUESTION, AND PRODUCTION CAUGHT IT.
   *  It ran over every non-retired lease on the bed and asked whether any
   *  two overlapped EACH OTHER — `asOf` never entered the computation.
   *  Every other axis on this position is date-scoped (`current` and
   *  `activationPending` use datesSpan, `future` uses isFuture); this one
   *  was not. So two leases that overlapped in April made the bed read
   *  contested in August, long after the earlier one had ended.
   *
   *  On Skyline that showed up as beds the Rent Roll called Needs Review
   *  for OVERLAPPING_OPERATIVE_LEASES while the canonical writer's own
   *  wall saw exactly ONE operative lease on the same bed and date. Both
   *  were right about different questions. The July activation truthfully
   *  recorded two operative leases THEN; the reader was reporting that
   *  July condition on an August date.
   *
   *      CURRENT CONFLICT @ D
   *        = >= 2 DISTINCT operative leases
   *          that BOTH span D
   *          on the same canonical bed
   *
   *  Historical overlap stays historical truth. It does not make today's
   *  bed contested — and it is not erased either: the leases are still
   *  loaded, still readable, and a read taken at a date they both span
   *  still reports the conflict. The rule is date-scoped, not amnesiac.
   *
   *  Restricting the population to leases that span D also means this
   *  agrees with operative_overlap.competingOperativeLeases by
   *  construction — the writer refuses to CREATE exactly the state the
   *  reader now refuses to hide. One definition of a contested bed. */
  const spanning = leases.filter((lease) => datesSpan(lease, asOfKey));
  const conflicting = [];
  for (let i = 0; i < spanning.length; i++) {
    for (let j = i + 1; j < spanning.length; j++) {
      /*  DEFENSIVE, and it has already mattered once. The loader
       *  aggregates leases through a LEFT JOIN to executed_lease_records,
       *  whose lease_id index is not unique — two verified evidence rows
       *  for one lease emit that lease twice. Two array slots holding the
       *  SAME lease trivially "overlap", and `new Set` then collapses the
       *  pair to a single id, so the position reads contested with ONE
       *  conflicting lease. A lease can never conflict with itself. */
      if (String(spanning[i].id) === String(spanning[j].id)) continue;
      if (rangesOverlap(spanning[i], spanning[j])) {
        conflicting.push(spanning[i].id, spanning[j].id);
      }
    }
  }
  /*  A conflict needs TWO sides. One distinct id is not a contest, it is
   *  a bug upstream, and reporting it as a contest is how that bug stayed
   *  invisible. */
  const distinctConflicting = [...new Set(conflicting)];
  const conflict_ids = distinctConflicting.length >= 2 ? distinctConflicting : [];

  // SUCCESSOR of the lease governing as_of: the earliest non-terminal lease
  // starting at or after it ends, that does NOT overlap it (an overlapping
  // lease is a conflict, not a succession).
  const governing = current || activationPending || null;
  let successor = { state: "none", lease_id: null, proof_basis: null, locked: false };
  if (governing && governing.end_date) {
    const next = leases
      .filter((l) => l.id !== governing.id
        && l.start_date && String(l.start_date) >= String(governing.end_date)
        && !rangesOverlap(l, governing))
      .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))[0] || null;
    if (next) {
      // LOCKED uses the SAME governed rule as everywhere else: executed AND
      // funded. A 'pending' lease_status alone never closes the position.
      successor = classifyFutureCommitment(next, personNames);
    }
  }

  return {
    space_id: row.space_id,
    unit_id: row.unit_id,
    unit_number: row.unit_number,
    space_label: row.space_label,
    current_lease_position: shapeLease(current),
    activation_pending_lease_position: shapeLease(activationPending),
    future_lease_position: shapeLease(future),
    current_possession: possessed ? {
      since: lastIn.effective_date,
      event_recorded_at: lastIn.created_at,
      source: lastIn.source || null,
      details: lastIn.payload || {},
    } : null,
    economic_tenancy_state: current ? "active" : activationPending ? "activation_pending" : future ? "forward" : "none",
    possession_state: possessed ? "delivered" : "pending",
    physical_readiness: turning ? "turning" : "ready",
    availability_state,
    available_from,
    reason,
    next_required_action,
    notice_state: row.notice_date ? "on_notice" : "none",
    notice_date: row.notice_date || null,
    conflict_state: conflict_ids.length ? "conflicted" : "clear",
    conflicting_lease_ids: conflict_ids,
    successor,
    // THE STANDALONE FUTURE COMMITMENT. Same helper, same governed locked rule.
    // availability_read consumes this instead of assuming committed_future
    // implies locked, so no availability state can be stronger than its proof.
    future_commitment: classifyFutureCommitment(future, personNames),
    /*  Valid leases spanning asOf that fit none of the buckets above.
     *  Never occupancy on their own; they exist so a reader can refuse to
     *  call a bed empty while Spine holds a lease over it. */
    other_spanning_lease_positions: otherSpanning.map(shapeLease),
    _compat_occupancy: row.compat_occupancy,
    //  The per-SPACE claim the chosen opening baseline accepted, when there
    //  is one, WITH the proposal that supplied it. Carried beside the
    //  unit-level column rather than replacing it, so "which evidence
    //  answered this" stays readable instead of one silently shadowing the
    //  other — and so a reader can point at the record, not just repeat
    //  its verdict.
    _opening_space_claim: (row.opening_space_claim && row.opening_space_claim.claim) || null,
    _opening_claim_source: row.opening_space_claim || null,
  };
}

// ════════════════════════════════════════════════════════════════════
//  THE INTERVAL QUESTION — Slice 2's whole foundation
//
//    Does this rentable position carry a governed dated right that
//    conflicts with the requested interval?
//
//  ONE QUESTION. It does NOT decide whether the position is ready to
//  show, physically ready, down, marketable, priced, or something we
//  should offer a prospect. Those are OPERATING availability and they
//  live in availability_read.js, where `vacant ≠ ready ≠ marketable` is
//  already the permanent rule. Composition happens ABOVE both reads:
//
//      CONTRACTUAL AVAILABILITY   dated lease/right truth      ← here
//                 +
//      OPERATING AVAILABILITY     readiness · down · turnover
//                 ↓
//      OFFERABLE POSITION
//
//  The states are named `contractually_free`, never `available`, for
//  exactly that reason: a generic `available` is a word the next reader
//  has to remember the meaning of, and the meaning they will guess is
//  "can I lease this to someone", which this read does not answer.
//  A position can truthfully be contractually free AND physically not
//  ready AND down; flattening those into one false destroys the reason.
//
//  ── WHY IT NEEDS NO NEW PREDICATE ───────────────────────────────────
//  rangesOverlap already IS the interval predicate — it exists above to
//  detect two leases colliding, and this is the same test with one side
//  being a requested span instead of a second lease. leaseIsValid already
//  decides which rights count, and fails closed. proofBasis already
//  decides how strongly each is known. Slice 2 invents no policy; it asks
//  the existing model a second temporal question.
//
//  PURE. Same as everything else in this file.
// ════════════════════════════════════════════════════════════════════

const FOREVER = "9999-12-31";
const dayAfter = (ymd) => {
  const d = new Date(String(ymd) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const dayBefore = (ymd) => {
  const d = new Date(String(ymd) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/*  The sub-spans of [start, end] that no colliding right covers.
 *  Closed intervals throughout: end_date is the LAST day a lease governs,
 *  which is the convention datesSpan already uses (end_date >= asOf) and
 *  the one rangesOverlap already enforces. An open end runs forever.       */
function freeSpans(start, end, rights) {
  const reqEnd = end || FOREVER;
  const blocks = rights
    .map((r) => ({ from: String(r.start_date), to: r.end_date ? String(r.end_date) : FOREVER }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const spans = [];
  let cursor = String(start);
  for (const b of blocks) {
    if (b.to < cursor) continue;               // entirely behind us
    if (b.from > cursor) {
      const gapEnd = dayBefore(b.from < reqEnd ? b.from : dayAfter(reqEnd));
      if (gapEnd >= cursor) spans.push({ from: cursor, to: gapEnd > reqEnd ? reqEnd : gapEnd });
    }
    if (b.to >= reqEnd) return spans;           // nothing left after this one
    if (b.to >= cursor) cursor = dayAfter(b.to);
  }
  if (cursor <= reqEnd) spans.push({ from: cursor, to: end ? reqEnd : null });
  return spans;
}

/*  classifyPositionForInterval — the whole Slice 2 primitive.
 *
 *  row          one loaded space, exactly as loadSpaceRows returns it
 *  start_date   requested interval start, 'YYYY-MM-DD'
 *  end_date     requested interval end, 'YYYY-MM-DD', or null for open-ended
 *
 *  Four states, and each says what it is FOR:
 *    contractually_free       no valid right overlaps the requested term
 *    term_blocked             a valid right covers the ENTIRE term
 *    term_partially_blocked   a valid right overlaps PART of it — the free
 *                             sub-spans are reported, because "this bed is
 *                             yours Aug 1 – Dec 31" is the operating answer
 *    unresolved               Spine cannot answer: competing claims that
 *                             touch this term, and which governs is
 *                             unknown. NEVER silently resolved to the first
 *                             matching lease.
 *
 *  ⚠ WHY NOT `partially_conflicted`, WHICH THIS SHIPPED AS FIRST.
 *  `conflict` already means something specific in this file:
 *  rangesOverlap between two LEASES, a contested position where which
 *  right governs is unknown. That is an evidence dispute and it is a
 *  problem. An ordinary lease overlapping part of a requested term is not
 *  a problem at all — it is the normal state of a leased building. Naming
 *  both "conflicted" made a routine fact sound like a defect and made the
 *  genuine defect sound routine. `blocked` says what it is: the term is
 *  blocked, wholly or partly, by a right that is doing its job.
 */
function classifyPositionForInterval(row, { start_date, end_date = null, personNames } = {}) {
  if (!start_date) throw new Error("classifyPositionForInterval requires start_date");
  if (end_date && String(end_date) < String(start_date)) {
    const e = new Error("requested_end is before requested_start");
    e.code = "INVALID_INTERVAL";
    throw e;
  }
  const requested = { start_date: String(start_date), end_date: end_date ? String(end_date) : null };
  const leases = (row.leases || []).filter(leaseIsValid);

  //  THE ONE TEST. Same predicate the conflict detector uses.
  const colliding = leases.filter((l) => rangesOverlap(requested, l));

  //  A CONTEST ONLY MATTERS IF IT TOUCHES THIS INTERVAL. Two leases that
  //  overlap each other in 2029 do not stop Spine answering about 2026,
  //  and reporting `unresolved` for them would be a different kind of
  //  wrong — a refusal Spine has no basis for.
  const contested = [];
  for (let i = 0; i < colliding.length; i++) {
    for (let j = i + 1; j < colliding.length; j++) {
      if (rangesOverlap(colliding[i], colliding[j])) contested.push(colliding[i].id, colliding[j].id);
    }
  }
  const contestedIds = [...new Set(contested)];

  //  Carried whole and unflattened: WHICH rights collide, and how strongly
  //  each is known. A collision with an `unproven` right is still a
  //  collision — the position is spoken for — but it is a weaker claim
  //  than a native_verified one, and only a human may decide to write over
  //  it, through the governing writer. This read never decides that.
  const shape = (l) => ({
    lease_id: l.id,
    lease_status: l.lease_status,
    start_date: l.start_date,
    end_date: l.end_date || null,
    proof_basis: proofBasis(l),
    tenants: tenantList(l, personNames),
  });

  let interval_state;
  let free_spans = [];
  if (contestedIds.length) {
    interval_state = "unresolved";
  } else if (!colliding.length) {
    interval_state = "contractually_free";
    free_spans = [{ from: requested.start_date, to: requested.end_date }];
  } else {
    free_spans = freeSpans(requested.start_date, requested.end_date, colliding);
    interval_state = free_spans.length ? "term_partially_blocked" : "term_blocked";
  }

  return {
    space_id: row.space_id,
    unit_id: row.unit_id,
    unit_number: row.unit_number,
    space_label: row.space_label,
    requested,
    interval_state,
    colliding_rights: colliding.map(shape),
    free_spans,
    //  Contest state SCOPED TO THIS INTERVAL, deliberately not the
    //  position-wide conflict_state the dated read reports.
    conflict_state: contestedIds.length ? "conflicted" : "clear",
    conflicting_lease_ids: contestedIds,
  };
}

module.exports = {
  classifyPosition,
  classifyPositionForInterval,
  freeSpans,
  classifyFutureCommitment,
  isNativelyProven,
  // shared vocabulary, exported so no caller redefines it
  TERMINAL_LEASE_STATUSES,
  CURRENT_ECONOMIC_STATUSES,
  ACTIVATION_PENDING_STATUSES,
  leaseIsValid,
  datesSpan,
  isFuture,
  normalizedStatus,
  rangesOverlap,
  proofBasis,
  tenantList,
};
