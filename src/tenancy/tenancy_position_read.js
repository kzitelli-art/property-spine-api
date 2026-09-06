// ════════════════════════════════════════════════════════════════════
//  tenancy_position_read.js — TENANCY'S COMPACT STANDING PROJECTION
//
//  §40.6 asks each domain for a projection cheap enough to gather
//  routinely: current position, important unknowns, next milestone. This
//  is tenancy's, and it exists so an entitled person can text Spine from
//  a meeting and get where the building stands, what Spine does not know,
//  and what changes next — without knowing that any of it lives in
//  `spaces` and `leases`.
//
//  ── THE SAME TRUTH THE SCREEN READS. NOT A SECOND READER. ───────────
//  This calls datedPropertyPositions, exactly as the Rent Roll surface
//  does. It does not query leases, it does not classify, and it does not
//  decide what "occupied" means. §40 is explicit that the operator UI and
//  Ask Spine are two projections of ONE canonical read, neither derived
//  from the other — and a conversational layer that re-derived occupancy
//  would eventually disagree with the screen about the same building on
//  the same day.
//
//  The agent layer is a meter (§40.3): if this file needed logic the Rent
//  Roll does not need, that logic would be missing from the Spine. It
//  needs none. Everything below is selection and compression.
//
//  ── COMPACT, NOT THE 160-ROW PAYLOAD ────────────────────────────────
//  The UI read returns every position because a person is scanning them.
//  A sentence is not. This returns counts, unknowns and the nearest dated
//  change; detail is a second read, deliberately not offered here.
//
//  ── CURRENT AND NEXT ARE ONE MODEL AT TWO DATES ─────────────────────
//  `as_of` is a parameter of this read, never a property of the model.
//  The committed-forward half comes from the classifier's own successor /
//  future_commitment — the same objects the ledger's NEXT columns render.
//  There is no second future datastore and no second derivation.
//
//  ── THE SILENCES SURVIVE COMPRESSION ────────────────────────────────
//  A rent the source never carried is UNKNOWN, counted as unknown, and
//  never zero. NOT_ESTABLISHED (the property has told Spine nothing) and
//  READ_FAILED (Spine could not look) stay two different facts (§40.7).
//
//  ── WHAT IT CLAIMS, AND WHAT IT REFUSES TO (§40.10) ─────────────────
//  RETRIEVAL only. Not comparison — "is 1417 leasing behind?" needs a
//  basis (per bed, per season, against what) that is a model nobody
//  recorded. Not causal explanation — "why did occupancy drop?" needs
//  recorded causal linkage between a turn, a notice and a vacancy, and
//  tenancy records none. Neither may be implicitly promised.
//
//  CLASSIFICATION: Class 1 — permanent product primitive. READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions, intervalPropertyPositions, rentRollBuckets } =
  require("./dated_positions");
const readerCapabilities = require("../shared/reader_capability_contract.js");

const CONTRACT_VERSION = "tenancy_standing.v1";
const TERM_CONTRACT_VERSION = "tenancy_term_standing.v1";
const NOT_ESTABLISHED = "NOT_ESTABLISHED";

/*  ── THE TRUTH WALLS (§40.5) ────────────────────────────────────────
 *  Tenancy has a collapsing vocabulary — occupied, open, committed,
 *  leased, paying — and every one of those words merges two facts a
 *  reader needs kept apart. Declared as data so the wording layer is
 *  shown them, and so a test can be generated from the declaration
 *  rather than written from memory.  */
const TRUTH_WALLS = Object.freeze([
  "occupied ≠ paying — a position can be contractually occupied with no rent recorded at all.",
  "rent not recorded ≠ rent of zero — an amount the source never carried is unknown, never $0.",
  "open ≠ available — open means no lease spans this date. Marketability needs readiness and " +
    "turnover facts this read does not consult, and availability owns that answer.",
  "committed ≠ locked — a future commitment is pending until it is natively proven.",
  "confirmed opening import ≠ verified in Spine — accepted opening truth is not the same proof " +
    "as a lease Spine executed and funded itself.",
  "a unit ≠ a rentable position — a unit may hold several beds, and occupancy is counted per bed.",
]);

const CAPABILITIES = readerCapabilities.validate(
  readerCapabilities.retrievalOnly(
    "canonical tenancy standing — dated rentable positions, occupancy, known forward " +
    "commitments, and the opening source they were established from"));

const asDate = (d) => (d ? String(d).slice(0, 10) : null);

/*  The nearest dated change tenancy actually knows about. Not a forecast:
 *  every candidate is a recorded lease boundary. Where nothing is
 *  recorded the milestone is null — a silence, not a zero.  */
function nextMilestone(positions, asOf) {
  const events = [];
  for (const p of positions) {
    const commitment =
      p.successor && p.successor.state !== "none" ? p.successor
        : (p.future_commitment && p.future_commitment.state !== "none" ? p.future_commitment : null);
    if (commitment && commitment.start_date && asDate(commitment.start_date) > asOf) {
      events.push({ on: asDate(commitment.start_date), what: "a committed position begins",
                    proven: commitment.state === "locked" });
    }
    if (p.lease && p.lease.end_date && asDate(p.lease.end_date) >= asOf) {
      events.push({ on: asDate(p.lease.end_date), what: "a current lease ends", proven: true });
    }
  }
  if (!events.length) return null;
  events.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  const on = events[0].on;
  const sameDay = events.filter((e) => e.on === on);
  return {
    on,
    //  Counted, not listed. A milestone naming forty units would stop being
    //  a milestone and start being a report.
    positions_affected: sameDay.length,
    what: sameDay.length === 1 ? sameDay[0].what : "leases end and committed positions begin",
    all_proven: sameDay.every((e) => e.proven),
  };
}

/*  readTenancyStanding — the whole domain, in one small object.
 *
 *  property_id  server-derived by the caller. Never from a question.
 *  as_of        the date the standing is taken at; defaults to today.
 */
async function readTenancyStanding(pool, { property_id, as_of = null } = {}) {
  if (!property_id) throw new Error("readTenancyStanding requires property_id");
  const dp = await datedPropertyPositions(pool, { property_id, as_of });
  const positions = dp.positions || [];

  const base = {
    contract_version: CONTRACT_VERSION,
    capability_classes: CAPABILITIES,
    //  §40.8 is unsolved repo-wide and is CARRIED, not quietly assumed
    //  solved because this read happens to be single-property.
    composition_authorization: "unsolved_cross_domain",
    as_of: dp.as_of,
    truth_walls: TRUTH_WALLS,
  };

  //  NOT_ESTABLISHED is the PROPERTY's silence and must never be dressed as
  //  a healthy empty building (§40.7). A property with no inventory has not
  //  told Spine anything yet; that is a different fact from "nobody lives
  //  here", and collapsing them is how a confident wrong answer gets made.
  if (!positions.length) {
    return {
      ...base,
      standing: { truth_state: NOT_ESTABLISHED,
        why: "no rentable position is recorded for this property in Spine" },
      established_from: null,
      position: null,
      unknowns: null,
      next_milestone: null,
      does_not_establish: [
        "Anything about occupancy, rent or commitments — tenancy has no inventory " +
        "recorded at this property, so there is nothing to be occupied.",
      ],
    };
  }

  /*  ── ONE CLASSIFICATION, TWO PROJECTIONS ──────────────────────────
   *  §40 requires the screen and Ask Spine to be two projections of the
   *  same truth — not two verdicts. This read used to compute
   *  `open = positions.filter(p => p.tenancy_state !== "contractually_occupied")`:
   *  Open by subtraction, the exact defect removed from the Rent Roll,
   *  still live here. An entitled person texting Spine from a meeting was
   *  told that committed beds, contested beds and beds Spine holds no fact
   *  about were all available.
   *
   *  The buckets are now DECIDED upstream in dated_positions and tallied,
   *  never re-derived. If the sentence and the screen ever disagree again,
   *  it will be because the data differs — not because two files hold two
   *  opinions about what Open means.  */
  const tally = rentRollBuckets(positions);
  const occupied = positions.filter((p) => p.bucket === "occupied");
  const open = positions.filter((p) => p.bucket === "open");
  const committed = positions.filter((p) =>
    (p.successor && p.successor.state !== "none") ||
    (p.future_commitment && p.future_commitment.state !== "none"));
  const lockedForward = committed.filter((p) => {
    const c = (p.successor && p.successor.state !== "none") ? p.successor : p.future_commitment;
    return c && c.state === "locked";
  });
  const units = new Set(positions.map((p) => String(p.unit_id)));

  //  THE UNKNOWNS ARE THE POINT. A projection reporting only counts would
  //  let a confident sentence be built on top of 120 positions whose
  //  economics Spine cannot state.
  const rentUnknown = occupied.filter((p) => !p.lease || p.lease.rent == null);
  const evidenceUnresolved = positions.filter((p) => p.evidence_state === "inconclusive");
  const contested = positions.filter((p) => p.conflict_state === "conflicted");
  const importedOnly = occupied.filter((p) => p.proof_basis === "confirmed_opening_import");
  const residentUnlinked = occupied.filter((p) => p.lease && !p.resident);

  const src = dp.opening_truth && dp.opening_truth.latest_confirmed_source;

  return {
    ...base,
    /*  The same three-valued state the Rent Roll reports, from the same
     *  tally. A property with inventory but no basis for any position is
     *  not ESTABLISHED merely because rows exist.  */
    standing: tally.established === tally.total
      ? { truth_state: "ESTABLISHED",
          why: `${positions.length} rentable positions are recorded across ${units.size} units` }
      : (tally.established > 0
        ? { truth_state: "PARTIALLY_ESTABLISHED",
            why: `${tally.established} of ${positions.length} rentable positions have an ` +
                 `established basis; ${tally.not_established} do not` }
        : { truth_state: NOT_ESTABLISHED,
            why: `${positions.length} rentable positions are recorded, but Spine holds no ` +
                 `authoritative fact establishing any of them at this date` }),

    established_from: src ? {
      source_file: src.source_file || null,
      source_as_of: src.source_as_of_date || null,
      confidence: src.confidence || null,
    } : null,

    //  WHERE THE BUILDING STANDS. Counts, never a percentage: a percentage
    //  is a judgement about performance and this read claims retrieval.
    position: {
      units: units.size,
      rentable_positions: positions.length,
      occupied: tally.occupied,
      //  A CLASSIFICATION, never a remainder.
      open: tally.open,
      //  Spoken for and not offerable — never folded into Open.
      activation_pending: tally.activation_pending,
      //  Facts that conflict. Different from having no facts at all.
      needs_review: tally.needs_review,
      //  Positions Spine holds no authoritative fact about. NOT a tenancy
      //  state, which is why it sits outside the four.
      not_established: tally.not_established,
      established: tally.established,
      positions_with_a_known_next: committed.length,
      forward_commitments_natively_proven: lockedForward.length,
      leasing_grain: positions.length > units.size ? "bed" : "unit",
    },

    //  WHAT SPINE DOES NOT KNOW, in numbers a sentence can carry.
    unknowns: {
      occupied_positions_with_no_recorded_rent: rentUnknown.length,
      positions_with_unresolved_occupancy_evidence: evidenceUnresolved.length,
      positions_with_overlapping_lease_claims: contested.length,
      occupied_positions_proven_only_by_the_opening_import: importedOnly.length,
      //  Now reachable in practice: an import whose person did not resolve
      //  records the lease with no tenant rather than attaching a guess.
      occupied_positions_with_no_linked_resident: residentUnlinked.length,
      //  Confirmed source rows the chosen baseline holds that NO position
      //  reads. The activation counted them as established; the positions
      //  say not established. Named here so the two numbers can be
      //  reconciled by a person instead of silently disagreeing.
      confirmed_source_rows_not_attached_to_a_position: (dp.opening_claims_unattached || {}).promoted || 0,
      held_source_rows_not_attached_to_a_position: (dp.opening_claims_unattached || {}).held || 0,
    },
    //  By the key the source gave each row — a label, never a record id.
    unattached_source_rows: (dp.opening_claims_unattached || {}).source_rows || [],

    next_milestone: nextMilestone(positions, dp.as_of),

    //  Said out loud so the wording layer cannot be asked to imply it.
    does_not_establish: [
      "Whether an open position can be marketed or leased — that is availability, " +
      "and it needs readiness and turnover facts this read does not consult.",
      "Any rent the source this property was established from did not carry.",
      "Any comparison to another property, another period or a market — no basis is recorded.",
      "Why occupancy is where it is — tenancy records no causal linkage.",
    ],
  };
}

/*  ══ THE TERM STANDING PROJECTION ═══════════════════════════════════
 *  The same compression, asked about a SPAN instead of a date. Same
 *  domain, same file, deliberately NOT a new module — the interval
 *  question is a second temporal reading of Tenancy, not a fifth domain,
 *  and a new `*_read.js` would make the coverage gate invent one.
 *
 *  ⚠ THE WALL THIS PROJECTION EXISTS TO HOLD.
 *  `partially_conflicted` does NOT mean "partly available for this term".
 *  For the term being asked about, the position does not fit. Its free
 *  sub-spans are useful context for a DIFFERENT term; they are not
 *  permission to offer this one. Every consumer — screen and sentence —
 *  gets that wall with the facts.  */
const TERM_TRUTH_WALLS = Object.freeze([
  "contractually free ≠ marketable — this read consults no readiness, turnover, " +
    "possession or out-of-service state, and cannot say a position may be shown or offered.",
  "partly blocked ≠ partly available for this term — it does NOT fit the term asked " +
    "for. Its free spans are context for another term, never permission to offer this one.",
  "blocked ≠ occupied today — a term can be wholly blocked by a lease that has not started.",
  "unresolved ≠ free — Spine could not answer for this position, which is not a yes.",
  "an unproven right is still a right — proof strength is reported so a human can weigh it, " +
    "never so the read can override it.",
  "free for this term ≠ free next term — the answer is a function of the dates asked about.",
]);

const TERM_CAPABILITIES = readerCapabilities.validate(
  readerCapabilities.retrievalOnly(
    "canonical contractual position for a requested term — which rentable positions carry a " +
    "governed dated right that conflicts with it, and where the conflicts fall"));

/*  readTenancyTermStanding — "what is left to lease for this term", small.
 *
 *  property_id      server-derived by the caller. Never from a question.
 *  requested_start  required. There is NO default interval and there must
 *  requested_end    not be one — see the route for why.
 */
async function readTenancyTermStanding(pool, { property_id, requested_start, requested_end } = {}) {
  if (!property_id) throw new Error("readTenancyTermStanding requires property_id");
  if (!requested_start || !requested_end) {
    const e = new Error("readTenancyTermStanding requires requested_start and requested_end");
    e.code = "INTERVAL_REQUIRED";
    throw e;
  }
  const iv = await intervalPropertyPositions(pool, { property_id, requested_start, requested_end });

  const base = {
    contract_version: TERM_CONTRACT_VERSION,
    capability_classes: TERM_CAPABILITIES,
    composition_authorization: "unsolved_cross_domain",
    term: { requested_start: iv.requested_start, requested_end: iv.requested_end },
    truth_walls: TERM_TRUTH_WALLS,
  };

  if (!iv.count) {
    return {
      ...base,
      standing: { truth_state: NOT_ESTABLISHED,
        why: "no rentable position is recorded for this property in Spine" },
      position: null, unknowns: null,
      does_not_establish: iv.does_not_establish,
    };
  }

  const t = iv.totals;
  return {
    ...base,
    standing: { truth_state: "ESTABLISHED",
      why: `${t.contractually_free} of ${iv.count} rentable positions can support the whole term` },
    //  COUNTS, NEVER A PERCENTAGE. "62% preleased" is a judgement about
    //  performance; stating the position is this read's whole job.
    position: {
      rentable_positions: iv.count,
      units: t.units,
      can_support_the_whole_term: t.contractually_free,
      //  ONE number for "does not fit", because for THIS term committed and
      //  partially_conflicted mean the same thing to someone trying to lease
      //  it. The split is available below for the operator who needs it.
      blocked_for_part_or_all_of_it: t.term_blocked + t.term_partially_blocked,
      wholly_blocked: t.term_blocked,
      partly_blocked: t.term_partially_blocked,
    },
    unknowns: {
      positions_spine_could_not_answer_for: t.unresolved,
      positions_taken_only_by_an_unproven_right: iv.positions.filter((p) =>
        p.interval_state !== "contractually_free"
        && p.colliding_rights.length
        && p.colliding_rights.every((r) => r.proof_basis === "unproven")).length,
      //  Carried because operating readiness for a FUTURE date is not
      //  governed anywhere yet. Saying nothing here would imply it is.
      positions_whose_future_physical_readiness_is_not_established: t.contractually_free,
    },
    does_not_establish: iv.does_not_establish,
  };
}

module.exports = {
  readTenancyStanding, TRUTH_WALLS, CONTRACT_VERSION, NOT_ESTABLISHED,
  readTenancyTermStanding, TERM_TRUTH_WALLS, TERM_CONTRACT_VERSION,
};
