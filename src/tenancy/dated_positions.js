// ════════════════════════════════════════════════════════════════════
//  dated_positions.js — THE CANONICAL DATED PROPERTY-POSITION READ
//
//  One service. Four interpretations:
//
//      canonical dated property positions
//        → Current Rent Roll   (as_of = today)
//        → Renewals            (upcoming expirations)
//        → Future Rent Roll    (as_of = a selected date, facts only)
//        → Availability        (marketability context)
//
//  These are four READS of one truth, not four modules that each compute a
//  position. Every surface may add its own context. None may redefine
//  lease spanning, notice, successor, conflict, availability or proof basis
//  — those come from classifyPosition and arrive here already decided.
//
//  BEGINS FROM CANONICAL SPACES, never from import rows. The import cannot
//  define the row set; it attributes and disputes it. That inversion — the
//  imported document as row spine with canonical truth overlaid by
//  unit_number string equality — is exactly what this replaces.
//
//  CARRIES INDEPENDENT AXES rather than compressing everything into one
//  status. Structural position, canonical lease evidence, imported
//  occupancy claim, proof basis, conflict, availability and successor stay
//  separately readable, because collapsing them is how a disagreement
//  becomes a clean-looking number.
//
//  NO SURFACE CONCEPTS HERE. No urgency bands, no presentation strings, no
//  filters, no HTML. Those belong to the surface that needs them.
//
//  READ-ONLY. Writes nothing, stores nothing. A position at a future date
//  is DERIVED, so facts at a later date replace facts at an earlier one by
//  recomputation — never by stored cleanup.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { spacePosition, loadSpaceRows, loadPersonNames, openingBaselineAsOf } =
  require("./space_position");
//  Same imported predicate as the loader — the attrs read must describe the
//  same row set, or a retired unit contributes attributes to nothing.
const { NOT_RETIRED_SQL, retiredExclusion } = require("./inventory_retirement");
//  The interval question is a CLASSIFICATION, so it lives with every other
//  classification — pure, beside classifyPosition, sharing rangesOverlap and
//  leaseIsValid rather than importing the vocabulary out of them.
const { classifyPosition, classifyPositionForInterval,
        intervalBoundariesOrRefuse } = require("./position_classifier");

// Occupancy-axis values that mean "structurally not earning".
const NON_REVENUE_CLAIMS = new Set(["model", "down"]);

const claim = (v) => String(v || "").toLowerCase();
//  Same normalisation, named so it reads clearly inside positionBasis.
const claimOf = claim;

// ── FOUR INDEPENDENT AXES ────────────────────────────────────────────
//  A position can simultaneously be contractually occupied, have
//  inconclusive opening evidence, and have unavailable economics. Those are
//  THREE DIFFERENT FACTS. Forcing them into one mutually exclusive enum
//  makes the totals balance by destroying the ability to explain a
//  position — which is the opposite of the point.
//
//  Each axis is exclusive WITHIN ITSELF and balances on its own.

// AXIS 1 — TENANCY. What is contractually true about occupation?
//   contested               overlapping non-terminal leases; which governs
//                           is unknown, so no tenancy claim can be made.
//   contractually_occupied  an uncontested spanning lease. This holds even
//                           when the imported claim is 'unknown' — opening
//                           evidence being inconclusive does not un-occupy a
//                           position that has a real lease.
//   unresolved              no spanning lease, but the opening claim says
//                           occupied, or says nothing conclusive. NOT vacant.
//   vacant                  no spanning lease and the opening claim agrees.
/*  ── WHICH OCCUPANCY CLAIM ANSWERS FOR THIS POSITION ────────────────
 *  The per-SPACE claim accepted by the established opening position wins
 *  over the unit-level `occupancy_status` column, because it is about
 *  this bed and the column is not. On a bed-grain property the column is
 *  'unknown' for every unit, so treating it as the opening position is
 *  how 160 beds ended up with no occupancy axis at all.
 *
 *  Returns the claim AND where it came from — a read that cannot say
 *  which evidence answered is a read that cannot be argued with.  */
function occupancyClaim(p) {
  const perSpace = claim(p._opening_space_claim);
  if (perSpace) return { value: perSpace, basis: "opening_position_space_claim" };
  const unitLevel = claim(p._compat_occupancy);
  if (unitLevel) return { value: unitLevel, basis: "unit_occupancy_status" };
  return { value: "", basis: null };
}

/*  ── DOES SPINE HAVE A BASIS FOR THIS POSITION AT ALL? ──────────────
 *  A Current Rent Roll position requires an established factual BASIS.
 *  It does not require one particular KIND of source. An opening tenancy
 *  baseline is one basis type; it is not a ritual every property must
 *  pass through.
 *
 *  ⚠ THIS IS NOT A TENANCY STATE AND NOT A FIFTH BUCKET. It is the prior
 *  question: can Spine say anything authoritative about this position at
 *  all? Only positions WITH a basis get one of the four operator buckets.
 *
 *      I have evidence and it disagrees        →  Needs Review
 *      I do not have enough evidence to know   →  Not Established
 *
 *  Those are not remotely the same institutional condition, and the
 *  distinction recurs across Spine — two policy records disagreeing is
 *  not the same as no coverage evidence; two payoff balances disagreeing
 *  is not the same as no balance source.
 *
 *  ORDER IS THE CONTRACT. First match wins, and the vacancy arm is LAST
 *  so that every fact capable of refuting a vacancy is consulted before
 *  a bed can be called empty.
 *
 *  ── THE ASYMMETRY THAT SHAPES THIS ───────────────────────────────
 *  FOUR fact types can establish occupancy — a spanning operative lease,
 *  a commenced pending lease, recorded possession, an accepted per-space
 *  claim of 'occupied'. Exactly ONE can establish vacancy: an accepted
 *  per-space claim of 'vacant'. And it is the weakest of them: an
 *  accepted document claim, dated once, that nothing re-observes and
 *  nothing expires.
 *
 *  The error is not symmetric either. A stale OCCUPANCY basis over-holds
 *  a bed — lost days on market, visible and recoverable. A stale VACANCY
 *  basis offers a bed someone lives in — double-let, a resident arriving
 *  at an occupied unit. Same staleness, one recoverable cost and one
 *  that is not. So vacancy is the one arm that must survive a veto from
 *  every other fact Spine holds.  */
function positionBasis(p) {
  const claim = claimOf(p._opening_space_claim);
  const src = p._opening_claim_source || null;
  const openingRef = src ? {
    kind: "opening_position_claim",
    opening_position_id: src.opening_position_id || null,
    opening_position_as_of: src.opening_position_as_of || null,
    proposal_id: src.proposal_id || null,
    proposal_status: src.proposal_status || null,
    natural_key: src.natural_key || null,
  } : null;

  if (p.conflict_state === "conflicted") {
    return { state: "established", type: "contested_rights",
      ref: { kind: "lease_ids", ids: p.conflicting_lease_ids || [] } };
  }
  if (p.current_lease_position) {
    return { state: "established", type: "operative_lease",
      ref: { kind: "lease", id: p.current_lease_position.lease_id,
             lease_status: p.current_lease_position.lease_status } };
  }
  if (p.activation_pending_lease_position) {
    return { state: "established", type: "commenced_lease_pending_activation",
      ref: { kind: "lease", id: p.activation_pending_lease_position.lease_id,
             lease_status: p.activation_pending_lease_position.lease_status } };
  }
  //  A lease Spine holds over this bed that fits none of the buckets —
  //  'signed' being the live example. It does not establish occupancy
  //  (which statuses count is a product ruling, not this function's), but
  //  it absolutely stops the bed being called empty.
  if ((p.other_spanning_lease_positions || []).length) {
    const l = p.other_spanning_lease_positions[0];
    return { state: "established", type: "spanning_lease_outside_current_vocabulary",
      ref: { kind: "lease", id: l.lease_id, lease_status: l.lease_status } };
  }
  if (p.current_possession && p.current_possession.since) {
    return { state: "established", type: "recorded_possession",
      ref: { kind: "possession", since: p.current_possession.since } };
  }
  if (claim === "unreconciled") {
    return { state: "established", type: "opening_position_unreconciled", ref: openingRef };
  }
  if (claim === "occupied") {
    return { state: "established", type: "opening_claim_occupied", ref: openingRef };
  }
  if (claim === "vacant") {
    return { state: "established", type: "opening_claim_vacant", ref: openingRef };
  }
  /*  ── THE UNIT-LEVEL COLUMN IS CONTEXT, NEVER A BASIS ──────────────
   *  `units.occupancy_status` is unit-grain on a bed-grain product,
   *  undated, overwritten in place, and defaults to 'unknown'. The
   *  loader's own comment calls it a placeholder. A placeholder must not
   *  be the thing that offers a bed to a prospect, so it is reported as
   *  context and never establishes.  */
  const unitLevel = claimOf(p._compat_occupancy);
  if (unitLevel && unitLevel !== "unknown") {
    return { state: "not_established", type: "unit_occupancy_status_only",
      ref: { kind: "unit_occupancy_status", value: unitLevel, grain: "unit", authoritative: false } };
  }
  return { state: "not_established", type: null, ref: null };
}

function tenancyState(p) {
  if (p.conflict_state === "conflicted") return "contested";
  if (p.current_lease_position) return "contractually_occupied";
  //  ── COMMITTED BUT NOT ACTIVATED IS ITS OWN TENANCY FACT ──────────
  //  The classifier has always computed this separately
  //  (`economic_tenancy_state: 'activation_pending'`); this axis simply
  //  never had a word for it, so it fell through to `unresolved` and the
  //  Rent Roll's subtraction then sold it as Open. A bed with a commenced
  //  lease awaiting activation is spoken for. It cannot be leased to
  //  anyone else, and offering it as available is the expensive mistake.
  //
  //  This IS a tenancy fact — a contractual commitment exists — so it
  //  belongs on this axis. Evidence contradictions do NOT: see the note
  //  on rentRollBuckets below.
  if (p.activation_pending_lease_position) return "activation_pending";
  //  PER-SPACE claim only. The unit-level placeholder must not be able to
  //  produce `vacant` — see positionBasis: it is context, never a basis,
  //  and a bed offered on the strength of an undated unit-grain cache is
  //  the double-let this whole correction exists to prevent.
  /*  A lease Spine holds over this bed but cannot classify means the bed
   *  is not empty, whatever the baseline said. The bucket refuses it too;
   *  this is the second wall, because "vacant" leaking out of the tenancy
   *  axis is the value most likely to be trusted by a future reader.  */
  if ((p.other_spanning_lease_positions || []).length) return "unresolved";
  if (claim(p._opening_space_claim) === "vacant") return "vacant";
  return "unresolved";                     // 'occupied' claim, or 'unknown'
}

/*  ── THE FOUR BUCKETS A RENT ROLL SHOWS ─────────────────────────────
 *  Occupied · Activation Pending · Open · Needs Review.
 *
 *  This reads BOTH axes and collapses nothing in the record — the
 *  collapse happens here, at the moment of presentation, and the two
 *  underlying facts stay separately readable on the position.
 *
 *  109A is why that matters. A spanning April lease says Navraj Julka
 *  lives there; the accepted July rent roll says the bed was empty. Those
 *  are two true recorded facts in contradiction. `tenancy_state` still
 *  says `contractually_occupied`, because a lease really does span today;
 *  `evidence_state` says `disagrees`, because the accepted source really
 *  does contradict it. The bucket is Needs Review because Spine has no
 *  basis to choose between them — and an operator opening the bed can
 *  still see exactly which two claims are fighting.
 *
 *  ⚠ Open is a CLASSIFICATION, never a remainder. It is the only bucket
 *  that could quietly absorb a position nobody classified, so it is the
 *  one that must never be computed by subtraction.
 *
 *  Every position lands in exactly one bucket; `unclassified` exists so
 *  that if a future state escapes all four it shows up as a visible
 *  number rather than inflating Open.  */
/*  ONE position, ONE bucket. The headline and the rows call the same
 *  function, so a browser can never hold a second opinion about what Open
 *  means — it consumes this, it does not re-derive it. */
function rentRollBucketOf(p) {
  /*  ── NO BASIS, NO BUCKET ──────────────────────────────────────────
   *  Not Established is NOT a fifth kind of tenancy. It is a statement
   *  about whether Spine can establish the position at all. Manufacturing
   *  a tenancy bucket for a position Spine knows nothing about is the
   *  confident-wrong answer in its purest form — and dumping them into
   *  needs_review would be just as false, because nothing is in conflict.  */
  if (p.basis_state && p.basis_state !== "established") return null;

  /*  ── STEP 1: EVERY CONTRADICTION, BEFORE ANY CLASSIFICATION ───────
   *  ⚠ THIS ORDERING IS A SAFETY RULE, NOT A TRUTH HIERARCHY.
   *
   *  It exists so that a position with conflicting facts can never be
   *  classified as though the conflict were absent. It emphatically does
   *  NOT mean "whichever fact this function looks at first wins". An
   *  operative lease plus a later source claiming the bed vacant, with no
   *  correction and no supersession, is Needs Review — it does not become
   *  Occupied merely because the lease check sits higher in the file.
   *
   *  Where effective dates settle a sequence, the dates settle it, in
   *  evidenceState — not here, and not by ordering. Where an explicit
   *  correction or supersession settles it, that settles it. Otherwise
   *  the honest answer is that Spine cannot choose, and says so.  */
  if (p.conflict_state === "conflicted") return "needs_review";
  if (p.evidence_state === "disagrees") return "needs_review";
  if (p.evidence_state === "unreconciled") return "needs_review";
  //  A lease Spine holds over this bed whose status it cannot classify.
  //  Fail closed: an unclassifiable lease is a reason to stop, never a
  //  reason to offer the bed.
  if (p.basis_type === "spanning_lease_outside_current_vocabulary") return "needs_review";
  //  Someone is in the bed with no governing right on record. That is a
  //  recorded fact AND an anomaly — not missing evidence.
  if (p.basis_type === "recorded_possession") return "needs_review";

  /*  ── STEP 2: POSITIVE CLASSIFICATION ──────────────────────────────
   *  Reached only when nothing above is in conflict, so these are not
   *  competing with anything — they are naming what is established.  */
  if (p.tenancy_state === "contractually_occupied") return "occupied";
  if (p.tenancy_state === "activation_pending") return "activation_pending";
  /*  OCCUPANCY WITHOUT TERMS. An established opening position accepted
   *  this bed as occupied and nothing valid contradicts it. Spine knows
   *  someone occupies the bed; it does not know the rent, term or legal
   *  right governing that occupancy, and says so separately via
   *  contractual_terms_state. "Occupied" must never secretly mean "a
   *  canonical lease exists".  */
  if (p.basis_type === "opening_claim_occupied") return "occupied";
  //  Open is reached ONLY from a positive vacancy basis, and only after
  //  every contradiction and every tenancy fact above has been consulted.
  if (p.tenancy_state === "vacant") return "open";
  return "unclassified";
}

/*  ── WHY THIS BED IS IN THIS BUCKET ─────────────────────────────────
 *  STRUCTURED FIRST, PROSE SECOND. The sentence is for a person; the code
 *  and the refs are the contract. A surface that had to regex English to
 *  find out what happened would be reverse-engineering business meaning
 *  from copy — the explanation would quietly become the API, and rewording
 *  it would be a breaking change nobody could see.
 *
 *      bucket_reason_code   what happened, as a governed token
 *      bucket_reason        the same thing, sayable
 *      supporting_refs      the records that support the classification
 *      conflicting_refs     the records that fight it, when any do
 *
 *  Ask Spine reads the code and the refs. The glass reads the sentence.
 *  Tests assert the code. Nobody parses prose.
 *
 *  Only the codes the existing classifier actually requires. This is not
 *  the place to invent a taxonomy for conditions Spine cannot yet record.
 *
 *  Every reason is POSITIVE and causal. Open in particular must never read
 *  "none of the other buckets matched" — that sentence IS the defect this
 *  correction exists to remove. It names the established vacancy, the
 *  absence of a governing tenancy fact, and the absence of a contradiction,
 *  because those three together are what make a bed genuinely offerable. */
const REASON = Object.freeze({
  OVERLAPPING_OPERATIVE_LEASES: "OVERLAPPING_OPERATIVE_LEASES",
  OPENING_VACANCY_CONFLICTS_WITH_OPERATIVE_LEASE: "OPENING_VACANCY_CONFLICTS_WITH_OPERATIVE_LEASE",
  OPENING_OCCUPANCY_ACCEPTED_TERMS_UNKNOWN: "OPENING_OCCUPANCY_ACCEPTED_TERMS_UNKNOWN",
  POST_BASELINE_OPERATIVE_LEASE_GOVERNS_DATE: "POST_BASELINE_OPERATIVE_LEASE_GOVERNS_DATE",
  SPANNING_LEASE_STATUS_UNRECOGNISED: "SPANNING_LEASE_STATUS_UNRECOGNISED",
  POSSESSION_WITHOUT_GOVERNING_LEASE: "POSSESSION_WITHOUT_GOVERNING_LEASE",
  OPENING_POSITION_UNRECONCILED: "OPENING_POSITION_UNRECONCILED",
  OPERATIVE_LEASE_SPANS_DATE: "OPERATIVE_LEASE_SPANS_DATE",
  COMMENCED_LEASE_NOT_ACTIVATED: "COMMENCED_LEASE_NOT_ACTIVATED",
  ESTABLISHED_VACANT_NO_LATER_BLOCKER: "ESTABLISHED_VACANT_NO_LATER_BLOCKER",
  NO_AUTHORITATIVE_BASIS: "NO_AUTHORITATIVE_BASIS",
});

const ref = (kind, id, extra = {}) => (id ? { kind, id, ...extra } : null);

function rentRollExplain(p, opts = {}) {
  const asOf = opts.as_of || null;
  const base = opts.baseline_as_of || null;
  const claim = occupancyClaim(p);
  const src = p._opening_claim_source || null;
  const cur = p.current_lease_position;
  const pend = p.activation_pending_lease_position;
  const term = (l) => `${l.start_date || "no start"} → ${l.end_date || "no end"}`;
  const onDate = asOf ? ` on ${asOf}` : "";
  const atBase = base ? ` at ${base}` : "";

  //  The records the opening baseline used to answer for this bed.
  const openingRefs = [
    ref("opening_position", src && src.opening_position_id, { as_of: src && src.opening_position_as_of }),
    ref("proposal", src && src.proposal_id, { status: src && src.proposal_status, natural_key: src && src.natural_key }),
  ].filter(Boolean);

  if (p.conflict_state === "conflicted") {
    return {
      code: REASON.OVERLAPPING_OPERATIVE_LEASES,
      sentence: `Overlapping operative leases on this position — which one governs is unknown, ` +
        `so no tenancy claim can be made.`,
      supporting_refs: openingRefs,
      conflicting_refs: (p.conflicting_lease_ids || []).map((id) => ref("lease", id)).filter(Boolean),
    };
  }
  if (p.evidence_state === "unreconciled") {
    return {
      code: REASON.OPENING_POSITION_UNRECONCILED,
      sentence: `The opening position${atBase} could not reconcile this bed: its source row was ` +
        `left unresolved rather than accepted, so there is no established claim to read forward.`,
      supporting_refs: [],
      conflicting_refs: openingRefs,
    };
  }
  if (p.basis_type === "spanning_lease_outside_current_vocabulary") {
    const l = (p.other_spanning_lease_positions || [])[0] || {};
    return {
      code: REASON.SPANNING_LEASE_STATUS_UNRECOGNISED,
      sentence: `Spine holds lease ${l.lease_id} over this bed spanning${onDate}, but its ` +
        `status "${l.lease_status}" is one Spine cannot classify — so it will not say the ` +
        `bed is occupied and will not offer it as available.`,
      supporting_refs: [ref("lease", l.lease_id, { lease_status: l.lease_status })].filter(Boolean),
      conflicting_refs: [],
    };
  }
  if (p.basis_type === "recorded_possession") {
    return {
      code: REASON.POSSESSION_WITHOUT_GOVERNING_LEASE,
      sentence: `Possession of this bed is recorded from ` +
        `${(p.current_possession && p.current_possession.since) || "an unstated date"}, but no ` +
        `lease governs it${onDate}.`,
      supporting_refs: [],
      conflicting_refs: [],
    };
  }
  if (p.evidence_state === "governed_by_later_fact") {
    return {
      code: REASON.POST_BASELINE_OPERATIVE_LEASE_GOVERNS_DATE,
      sentence: `The opening position${atBase} recorded this bed vacant, and that remains true ` +
        `for${atBase}. Lease ${cur.lease_id} began ${cur.start_date}, after it, so the lease is ` +
        `the fact that governs${onDate}. A sequence, not a disagreement — and the baseline is ` +
        `not corrected or erased by it.`,
      supporting_refs: [ref("lease", cur.lease_id, { lease_status: cur.lease_status }), ...openingRefs].filter(Boolean),
      conflicting_refs: [],
    };
  }
  if (p.evidence_state === "uncorroborated") {
    return {
      code: REASON.OPENING_OCCUPANCY_ACCEPTED_TERMS_UNKNOWN,
      sentence: `The opening position${atBase} accepted this bed as occupied and nothing ` +
        `contradicts that. Spine holds no lease for it, so the rent, term and legal right ` +
        `governing the occupancy are not established.`,
      supporting_refs: openingRefs,
      conflicting_refs: [],
    };
  }
  if (p.evidence_state === "disagrees") {
    return cur ? {
      code: REASON.OPENING_VACANCY_CONFLICTS_WITH_OPERATIVE_LEASE,
      sentence: `The opening position${atBase} records this bed as ${claim.value}, but lease ` +
        `${cur.lease_id} (${cur.lease_status}, ${term(cur)}) is in force${onDate}. Spine has no ` +
        `basis to choose between the source and the lease record.`,
      supporting_refs: openingRefs,
      conflicting_refs: [ref("lease", cur.lease_id, { lease_status: cur.lease_status })].filter(Boolean),
    } : {
      //  Reached only for a non-'occupied' claim that a lease contradicts;
      //  the accepted-occupied case is handled above as uncorroborated.
      code: REASON.OPENING_OCCUPANCY_ACCEPTED_TERMS_UNKNOWN,
      sentence: `The opening position${atBase} records this bed as ${claim.value}, but no lease ` +
        `supports that${onDate}.`,
      supporting_refs: [],
      conflicting_refs: openingRefs,
    };
  }
  if (cur) {
    return {
      code: REASON.OPERATIVE_LEASE_SPANS_DATE,
      sentence: `Operative lease ${cur.lease_id} (${cur.lease_status}, ${term(cur)}) spans${onDate}` +
        (claim.value === "occupied" ? `, and the opening position${atBase} agrees.` : "."),
      supporting_refs: [ref("lease", cur.lease_id, { lease_status: cur.lease_status }), ...openingRefs].filter(Boolean),
      conflicting_refs: [],
    };
  }
  if (pend) {
    return {
      code: REASON.COMMENCED_LEASE_NOT_ACTIVATED,
      sentence: `Lease ${pend.lease_id} is committed (${pend.lease_status}, ${term(pend)}) and ` +
        `spans${onDate}, but economic tenancy is not activated — the bed is spoken for and ` +
        `cannot be offered to anyone else.`,
      supporting_refs: [ref("lease", pend.lease_id, { lease_status: pend.lease_status }), ...openingRefs].filter(Boolean),
      conflicting_refs: [],
    };
  }
  if (claim.value === "vacant") {
    return {
      code: REASON.ESTABLISHED_VACANT_NO_LATER_BLOCKER,
      sentence: `Established vacant${atBase}, no operative lease spanning${onDate}, and no ` +
        `unresolved contradiction.`,
      supporting_refs: openingRefs,
      conflicting_refs: [],
    };
  }
  //  ── LACK OF KNOWLEDGE IS NOT A CONTRADICTION ─────────────────────
  //  No lease, no accepted claim, nothing in conflict. Spine simply holds
  //  no authoritative fact about this bed. That is NOT Needs Review, which
  //  means two recorded facts are fighting.
  return {
    code: REASON.NO_AUTHORITATIVE_BASIS,
    sentence: `Spine holds no authoritative fact establishing this bed${onDate}: no operative ` +
      `lease, and no accepted occupancy or vacancy claim${base ? ` from the ${base} opening position` : ""}.`,
    supporting_refs: [],
    conflicting_refs: [],
  };
}

/*  The operator vocabulary, decided server-side. Internal words
 *  (`contractually_occupied`, `unreconciled`) never reach the glass. */
const RENT_ROLL_LABELS = Object.freeze({
  occupied: "Occupied",
  activation_pending: "Pending Activation",
  open: "Open",
  needs_review: "Needs Review",
  unclassified: "Unclassified",
});

/*  What an operator reads when a position has NO basis. Deliberately not
 *  in RENT_ROLL_LABELS: it is not one of the four, and putting it there
 *  would invite a surface to render it as a fifth tenancy bucket.
 *  "NOT_ESTABLISHED" is canonical/API vocabulary; this is the glass. */
const NOT_ESTABLISHED_LABEL = "Occupancy Unconfirmed";

/*  The four operator states, over the positions that HAVE a basis.
 *  `not_established` sits beside them, deliberately outside the four: it
 *  is not a tenancy state, so it is not a tenancy bucket. `total` is every
 *  rentable position, and the four plus not_established plus unclassified
 *  must equal it — which is what makes the arithmetic checkable. */
function rentRollBuckets(positions) {
  const t = { occupied: 0, activation_pending: 0, open: 0, needs_review: 0,
              not_established: 0, unclassified: 0,
              established: 0, total: positions.length };
  for (const p of positions) {
    /*  TALLY THE DECISION, do not re-make it. A caller may hand us the
     *  canonical positions or a surface's projection of them; either way
     *  the bucket was decided once, upstream. Re-deriving here would be a
     *  second interpreter — and it silently WAS one: the Rent Roll passed
     *  projected rows that had dropped `basis_state`, so every
     *  basis-less bed was re-bucketed as needs_review instead of counted
     *  as not_established.  */
    const b = Object.prototype.hasOwnProperty.call(p, "bucket")
      ? p.bucket : rentRollBucketOf(p);
    if (b === null || b === undefined) { t.not_established++; continue; }
    t.established++;
    //  Only the four are counted by name. `t[b]++` on an unexpected value
    //  would either mint a new key nobody reads or produce NaN in a
    //  headline — a number that is wrong in a way no assertion about the
    //  four would catch.
    if (b === "occupied" || b === "activation_pending"
        || b === "open" || b === "needs_review") t[b]++;
    else t.unclassified++;
  }
  return t;
}

// AXIS 2 — EVIDENCE. Does opening truth agree with lease evidence?
//   confirmed      the claim and the lease evidence agree.
//   disagrees      they contradict: a claim of occupied with no spanning
//                  lease, or a spanning lease on a position claimed vacant.
//   inconclusive   the claim is 'unknown'. Unknown CONTRADICTS NOTHING —
//                  it is opening truth that never resolved, not a conflict.
function evidenceState(p) {
  const leaseObj = p.current_lease_position;
  const lease = !!leaseObj;
  const c = occupancyClaim(p).value;
  //  A bed the opening position could not reconcile has no settled claim
  //  to agree or disagree WITH. It is not inconclusive either — that word
  //  means "opening truth never resolved"; this one did resolve, into an
  //  open question a person owns.
  if (c === "unreconciled") return "unreconciled";
  if (!c || c === "unknown") return "inconclusive";
  if (NON_REVENUE_CLAIMS.has(c)) return "confirmed";       // model/down is a use statement
  if (lease && c === "occupied") return "confirmed";
  if (!lease && c === "vacant") return "confirmed";

  /*  ── ABSENCE OF A LEASE IS ABSENCE OF EVIDENCE ────────────────────
   *  An accepted opening claim that a bed is occupied, with no lease on
   *  record, used to read `disagrees` — which quietly turned MISSING
   *  CONTRACTUAL DOCUMENTATION into CONTRADICTORY TENANCY EVIDENCE.
   *  Nothing contradicts the claim; Spine simply has no lease for it.
   *
   *  The opening-position establishment was itself the governed act that
   *  accepted the occupancy. That is sufficient authority for the fact it
   *  established — someone occupies this bed — and no authority at all
   *  for terms it never established. See contractualTermsState.  */
  if (!lease && c === "occupied") return "uncorroborated";

  /*  ── A SEQUENCE IS NOT A CONTRADICTION ────────────────────────────
   *  A baseline that recorded this bed vacant on 31 July does not fight a
   *  lease that STARTED on 5 August. Those two facts are about different
   *  days and both are true.
   *
   *  ⚠ THE LATER FACT GOVERNS THE LATER DATE. It does NOT supersede the
   *  baseline, and the baseline was not wrong: 31 July still reads vacant
   *  for 31 July. "Governs" and "supersedes" are different words on
   *  purpose — supersession is a governed corrective act, and nothing
   *  corrective happened here. Time passed.
   *
   *  Treating that as a conflict would put every ordinary new lease since
   *  the baseline into Needs Review — and would make Spine unable to
   *  record that anything ever happened after an opening position.
   *
   *  It IS a contradiction when the lease was already in force AT the
   *  baseline date and the baseline still called the bed empty. That is
   *  Skyline 109A: an April lease spanning 31 July, and a 31 July source
   *  saying vacant. Two claims about the same day.  */
  const baselineAsOf = p._opening_claim_source
    && p._opening_claim_source.opening_position_as_of;
  if (lease && c === "vacant" && baselineAsOf && leaseObj.start_date
      && String(leaseObj.start_date) > String(baselineAsOf)) {
    return "governed_by_later_fact";
  }
  return "disagrees";
}

/*  Occupancy and its TERMS are separate establishments. Spine may know
 *  that someone occupies a bed without knowing the rent, term or legal
 *  right governing that occupancy — and must not imply the second from
 *  the first. "Occupied" may never secretly mean "a canonical lease
 *  exists".  */
function contractualTermsState(p) {
  if (p.current_lease_position) return "established";
  if (claim(p._opening_space_claim) === "occupied") return "not_established";
  return "not_applicable";
}

// AXIS 3 — ECONOMICS COMPLETENESS. Independent of whether it is occupied.
//   available      a spanning lease with populated contractual rent.
//   unavailable    a spanning lease whose rent is missing. The position is
//                  still occupied; the rent is simply not known, and is
//                  never coerced to $0 at the row level.
//   not_applicable no spanning lease, so there is no contractual rent to have.
function economicsState(p) {
  const lease = p.current_lease_position;
  if (!lease) return "not_applicable";
  return (lease.rent == null || Number(lease.rent) === 0) ? "unavailable" : "available";
}

// AXIS 4 — proof_basis, already decided by the classifier.

// TRUSTED RENT ELIGIBILITY — the single rule.
//   Sum the populated contractual rent of every UNCONTESTED spanning lease,
//   regardless of whether opening evidence agrees, disagrees or is
//   inconclusive. Exclude only: contested claims, positions with no spanning
//   lease, and spanning leases whose rent is unavailable.
function contributesTrustedRent(p) {
  return tenancyState(p) === "contractually_occupied" && economicsState(p) === "available";
}

// Opening truth is an EXTENSIBLE receipt. A property may take many governed
// sources over its life; the contract must not collapse that history into
// "one batch and one document".
async function openingTruth(pool, property_id) {
  //  ⚠ THE DATE IS CAST IN SQL, ON PURPOSE.
  //  This selected the raw `date` column and then did
  //  String(b.source_as_of_date).slice(0, 10) — which is correct for a
  //  string and wrong for what node-pg actually returns, a Date. The
  //  slice took the first ten characters of "Fri Jul 31 2026 00:00:00
  //  GMT+0000" and produced "Fri Jul 31": no year, unsortable, and
  //  rendered straight to an operator by index.html ("· as of Fri Jul
  //  31"). Nothing threw, and every count around it was right.
  //
  //  to_char, not a JS conversion: `new Date(...).toISOString()` on a
  //  DATE column is the classic off-by-one, because node-pg builds the
  //  Date at LOCAL midnight and toISOString reads it back in UTC. The
  //  database already knows what day it is; ask it for the string.
  const rows = (await pool.query(
    `select id, source_type, source_file,
            to_char(source_as_of_date, 'YYYY-MM-DD') as source_as_of_date,
            confidence, status, leasing_model, loaded_at, notes
       from import_batches where property_id=$1
      order by source_as_of_date desc nulls last, loaded_at desc`, [property_id]
  )).rows;
  const sources = rows.map((b) => ({
    batch_id: b.id,
    source_type: b.source_type,
    source_file: b.source_file || null,
    source_as_of_date: b.source_as_of_date || null,   // already YYYY-MM-DD text
    confidence: b.confidence || null,
    status: b.status || null,
    leasing_model: b.leasing_model || null,
    attribution: { loaded_at: b.loaded_at, notes: b.notes || null },
  }));
  return {
    sources,
    latest_confirmed_source: sources.find((s) => s.status === "committed" && s.source_type !== "rent_roll_reconciliation") || null,
    latest_reconciliation: sources.find((s) => s.source_type === "rent_roll_reconciliation") || null,
  };
}

/*  ── THE SAME TWO ANSWERS, WITHOUT THE RECEIPT ───────────────────────
 *
 *  §40.6 asks a domain to answer its standing projection "without walking
 *  its full payment, amendment or event history". openingTruth() above is
 *  a history walk by that definition: every rent-roll import ever run
 *  against the property, unbounded, growing with each import forever.
 *
 *  It is on the standing path. readTenancyStanding — the registered Ask
 *  Spine projection, contract `tenancy_standing.v1` — reaches it through
 *  datedPropertyPositions and then reads exactly ONE field of the result,
 *  `latest_confirmed_source`, to populate `established_from`.
 *
 *  ⚠ THE OBVIOUS FIX IS THE WRONG ONE. Putting a LIMIT on openingTruth
 *  would truncate a receipt an operator reads. `sources` is a DETAIL
 *  contract with four live consumers — rent_roll_unit_view,
 *  future_rent_roll_facts, rent_roll_institutional, rent_roll_canonical —
 *  and tests/rent_roll_canonical_proof.js asserts the array is non-empty
 *  and that EVERY element keeps its attribution. The header above says the
 *  contract out loud: the history must not collapse into one batch and one
 *  document. Bounding it is the same mistake as putting a LIMIT on "the
 *  coverages on this property" (§5).
 *
 *  So this is §40.6's actual shape — STANDING **plus** DETAIL, never
 *  standing instead of detail. openingTruth() is untouched and remains the
 *  detail read. This answers the standing path with two bounded statements.
 *
 *  ── WHAT THIS BOUNDS, AND WHAT IT HONESTLY DOES NOT ─────────────────
 *  It bounds the ROW SET: two rows instead of every batch, so neither the
 *  transfer nor the JS mapping grows with import history. It does NOT make
 *  the statement O(1) — there is no index on
 *  (property_id, source_as_of_date, loaded_at), so Postgres still sorts the
 *  property's batches to find the top row. Saying otherwise would be the
 *  over-claim this repository keeps paying for. The growth that mattered
 *  for §40.6 — the payload gathered on every question — is gone; the sort
 *  is a smaller, separate cost and an index is a schema change, which this
 *  thread is not taking.
 *
 *  ── THE ORDERING IS COPIED, NOT REINVENTED ──────────────────────────
 *  `order by source_as_of_date desc nulls last, loaded_at desc` is repeated
 *  verbatim from the walk above, because the answer must be the row the
 *  unbounded read would have found — including the loaded_at tie-break on
 *  two batches sharing an as_of_date, and `nulls last` on a batch with no
 *  as_of_date that was loaded most recently. Both are proved equal to the
 *  unbounded read in tests/opening_truth_standing_bound.db.js.
 *
 *  CLASS 1 — permanent product primitive.
 */
const OPENING_TRUTH_COLUMNS =
  `id, source_type, source_file,
   to_char(source_as_of_date, 'YYYY-MM-DD') as source_as_of_date,
   confidence, status, leasing_model, loaded_at, notes`;
const OPENING_TRUTH_ORDER = `order by source_as_of_date desc nulls last, loaded_at desc`;

const shapeSource = (b) => (b ? {
  batch_id: b.id,
  source_type: b.source_type,
  source_file: b.source_file || null,
  source_as_of_date: b.source_as_of_date || null,
  confidence: b.confidence || null,
  status: b.status || null,
  leasing_model: b.leasing_model || null,
  attribution: { loaded_at: b.loaded_at, notes: b.notes || null },
} : null);

async function openingTruthStanding(pool, property_id) {
  const [confirmed, reconciliation] = await Promise.all([
    pool.query(
      `select ${OPENING_TRUTH_COLUMNS}
         from import_batches
        where property_id=$1
          and status = 'committed'
          and source_type <> 'rent_roll_reconciliation'
        ${OPENING_TRUTH_ORDER}
        limit 1`, [property_id]),
    //  NO status filter here, deliberately — the walk above does not apply
    //  one to the reconciliation, and this must answer identically.
    pool.query(
      `select ${OPENING_TRUTH_COLUMNS}
         from import_batches
        where property_id=$1
          and source_type = 'rent_roll_reconciliation'
        ${OPENING_TRUTH_ORDER}
        limit 1`, [property_id]),
  ]);
  return {
    /*  NULL, NOT []. An empty array is a claim — "this property has taken
     *  no governed source" — and it would be a false one on every property
     *  that has taken several. The standing read does not gather the
     *  receipt, so it says it did not gather the receipt (§5, §40.7:
     *  NOT_ESTABLISHED and "not read here" are different silences).
     *  openingTruth() is the read that answers this. */
    sources: null,
    sources_omitted: "standing projection — the full receipt is a detail read (openingTruth)",
    latest_confirmed_source: shapeSource(confirmed.rows[0]),
    latest_reconciliation: shapeSource(reconciliation.rows[0]),
  };
}

/*  `opening_truth_scope` is "detail" for every operator surface and
 *  "standing" only for the compact projection. It DEFAULTS to detail, so a
 *  caller that says nothing keeps the full receipt — a new option must
 *  never quietly shorten an existing read. */
async function datedPropertyPositions(pool, { property_id, as_of = null, opening_truth_scope = "detail" } = {}) {
  if (!property_id) throw new Error("datedPropertyPositions requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  const sp = await spacePosition(pool, { property_id, as_of: asOf });

  // is_down lives on units and is not owned by the classifier. Loaded here so
  // every consumer sees the same physical-service fact.
  const down = new Set((await pool.query(
    `select id from units where property_id=$1 and coalesce(is_down,false)=true`, [property_id]
  )).rows.map((r) => String(r.id)));

  // STRUCTURAL ATTRIBUTES — square footage and the GOVERNED classification
  // (migration 100). Loaded here rather than in space_position so that the
  // classifier's output stays byte-identical to its characterization baseline.
  // unit_type resolves through property_unit_types: a source code is
  // provenance, never a type, so an unmapped unit reports null and every
  // surface renders it as not configured.
  const attrs = new Map((await pool.query(
    `select s.id as space_id, u.square_feet, s.use_type, s.position_kind,
            put.code as unit_type_code, put.label as unit_type_label
       from spaces s
       join units u on u.id = s.unit_id
       left join property_unit_types put on put.id = u.unit_type_id
      where u.property_id = $1
        and ${NOT_RETIRED_SQL("u")}`, [property_id]
  )).rows.map((r) => [String(r.space_id), r]));

  const positions = sp.positions.map((p) => {
    const withDown = { ...p, is_down: down.has(String(p.unit_id)) };
    const lease = p.current_lease_position;
    const resident = lease && lease.tenants && lease.tenants[0] ? lease.tenants[0] : null;
    return {
      // durable identity — never unit_number
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,        // display only
      space_label: p.space_label,
      // GOVERNED first, derived only as a fallback: once position_kind is
      // populated it is the answer; until then the shape of the data is.
      // A single-space unit is labelled '(whole unit)' in the source — that
      // sentinel is truthy but it is NOT a bed label, and treating it as one
      // made every position on a by-unit property report as a bed.
      position_kind: (attrs.get(String(p.space_id)) || {}).position_kind
        || (p.space_label && !/whole\s*unit/i.test(p.space_label) ? "bed" : "unit"),
      square_feet: (attrs.get(String(p.space_id)) || {}).square_feet ?? null,
      // null until a reviewed mapping receipt creates the governed row.
      unit_type: (attrs.get(String(p.space_id)) || {}).unit_type_label || null,
      unit_type_code: (attrs.get(String(p.space_id)) || {}).unit_type_code || null,
      use_type: (attrs.get(String(p.space_id)) || {}).use_type || null,

      // FOUR INDEPENDENT AXES. Each balances within itself. A position may be
      // occupied AND inconclusive AND missing economics — three facts, three
      // fields, never collapsed into one status.
      tenancy_state: tenancyState(withDown),
      evidence_state: evidenceState(withDown),
      economics_state: economicsState(withDown),
      contributes_trusted_rent: contributesTrustedRent(withDown),

      /*  ── THE OPERATOR CLASSIFICATION, DECIDED HERE ─────────────────
       *  Not in the Rent Roll surface. Ask Spine does not go through that
       *  surface, and neither does any future reader — computing the
       *  bucket there would force every one of them to re-derive it,
       *  which is the same second-interpreter defect the browser had.
       *
       *  It is computed from the CLASSIFIER shape, which is what is in
       *  scope here. The first version of this lived in the surface and
       *  was handed the already-projected row: `_opening_space_claim` and
       *  `current_lease_position` do not survive that projection, so every
       *  reason came out as "no established occupancy claim" — including
       *  for beds that were plainly Open. Wrong, and confidently so. */
      ...(() => {
        const basis = positionBasis(withDown);
        /*  basis_TYPE travels with basis_STATE. Passing only the state
         *  silently disabled every basis_type guard in rentRollBucketOf —
         *  an accepted-occupied bed fell to `unclassified`, and a lease
         *  with a status Spine cannot classify fell all the way through to
         *  OPEN. The adversarial cases caught both; nothing else would
         *  have, because the totals still added up.  */
        const axes = { ...withDown, basis_state: basis.state, basis_type: basis.type,
          tenancy_state: tenancyState(withDown), evidence_state: evidenceState(withDown) };
        const why = rentRollExplain(axes,
          { as_of: asOf, baseline_as_of: sp.opening_baseline ? sp.opening_baseline.as_of_date : null });
        const b = rentRollBucketOf(axes);
        return {
          //  THE PRIOR QUESTION, answered first and separately.
          basis_state: basis.state,
          basis_type: basis.type,
          basis_ref: basis.ref,
          //  Occupancy and its TERMS are separate establishments.
          contractual_terms_state: contractualTermsState(axes),
          bucket: b,
          bucket_label: b ? RENT_ROLL_LABELS[b] : null,
          bucket_reason_code: why.code,
          bucket_reason: why.sentence,
          supporting_refs: why.supporting_refs,
          conflicting_refs: why.conflicting_refs,
        };
      })(),

      imported_occupancy_claim: p._compat_occupancy || null,
      //  The claim that actually answered, and where it came from. Without
      //  the basis a reader cannot tell an accepted per-bed vacancy from
      //  the unit-level placeholder that means nothing.
      occupancy_claim: occupancyClaim(p).value || null,
      occupancy_claim_basis: occupancyClaim(p).basis,
      lease: lease ? {
        lease_id: lease.lease_id,
        start_date: lease.start_date,
        end_date: lease.end_date,
        rent: lease.rent == null ? null : Number(lease.rent),
      } : null,
      resident: resident ? { person_id: resident.person_id, name: resident.name || null } : null,
      current_rent: lease && lease.rent != null ? Number(lease.rent) : null,
      proof_basis: lease ? lease.proof_basis : null,
      notice_state: p.notice_state,
      // THE DATE, not only the state. The classifier has carried notice_date
      // since it was written; this projection dropped it, so every consumer
      // could say a position was on notice and none could say from when —
      // which is the half an operator has to act on. Additive.
      notice_date: p.notice_date || null,
      successor: p.successor,
      // THE STANDALONE FUTURE COMMITMENT, carried forward. Without it
      // availability_read had no proof for a future lease on a vacant position
      // — `successor` is only populated when a governing lease exists — so it
      // mapped committed_future straight to locked. Carrying the canonical
      // object here is what lets availability answer pending vs locked without
      // re-querying leases or growing a second commitment ladder.
      future_commitment: p.future_commitment,
      // Activation-pending PROVENANCE. The projection already reported the
      // state; without the source lease a consumer could not say WHICH lease
      // commenced or how it is proven, and availability would have had to
      // re-query leases to find out. shapeLease already carries proof_basis.
      activation_pending_lease_position: p.activation_pending_lease_position,
      //  Carried for inspection: a reader (or a trace) must be able to see
      //  WHICH lease governs and under what status without re-querying
      //  `leases` and deciding a second time.
      current_lease_position: p.current_lease_position,
      other_spanning_lease_positions: p.other_spanning_lease_positions || [],
      conflict_state: p.conflict_state,
      conflicting_lease_ids: p.conflicting_lease_ids,

      // canonical physical / configuration facts
      is_down: withDown.is_down,
      physical_readiness: p.physical_readiness,
      possession_state: p.possession_state,
      current_possession: p.current_possession,
      availability_state: p.availability_state,
      available_from: p.available_from,

      next_required_action: p.next_required_action,
      reason: p.reason,
    };
  });

  return {
    property_id,
    as_of: asOf,
    count: positions.length,
    //  A READ THAT EXCLUDES ROWS SAYS SO. The loader drops retired
    //  inventory, and a silently shortened row set is the same defect class
    //  as a gate that scans less than it asserts. `conflict: true` means
    //  tenancy is attached to inventory this read is hiding — an Exposure,
    //  never a tidy zero.
    retired_excluded: await retiredExclusion(pool, property_id),
    opening_truth: opening_truth_scope === "standing"
      ? await openingTruthStanding(pool, property_id)
      : await openingTruth(pool, property_id),
    /*  WHICH BASELINE ANSWERED FOR THIS DATE, or null.
     *
     *  Null is a PROPERTY-level fact: no opening tenancy position has been
     *  established effective on or before this date, so there is no
     *  Current Rent Roll to state. It is NOT one review exception per bed.
     *  A property that has never been established does not thereby acquire
     *  283 individual tenancy conflicts — it has one unmet precondition,
     *  and saying so is the honest blank (§5, and the NOT_ESTABLISHED
     *  silence of §40.7).
     *
     *  Surfaces must branch on this BEFORE presenting buckets. */
    opening_baseline: sp.opening_baseline,
    positions,
  };
}

// ════════════════════════════════════════════════════════════════════
//  intervalPropertyPositions — THE SAME MODEL, ASKED ABOUT A SPAN
//
//  datedPropertyPositions answers "what is true on this DATE".
//  This answers "what does the recorded right-set permit over this
//  INTERVAL". They are two temporal parameterizations of ONE model, over
//  the same spaces, the same leases and the same governed vocabulary —
//  not two systems, and there is no forward store for either to drift
//  from. A signed future lease changes this answer because it changed
//  `leases`; there is no Forward Leasing writer and there must not be.
//
//  ── WHAT IT OWNS, AND THE LINE IT DOES NOT CROSS ────────────────────
//  It owns CONTRACTUAL availability: dated rights, and whether they
//  conflict with what is being asked for. It does NOT own operating or
//  physical availability — readiness, down state, turnover, possession,
//  operating designation, use type, marketability. Those stay in
//  availability_read.js, where `vacant ≠ ready ≠ marketable` already is
//  the permanent rule, and the two compose ABOVE both reads:
//
//      CONTRACTUAL AVAILABILITY  +  OPERATING AVAILABILITY
//                          ↓
//                  OFFERABLE POSITION
//
//  is_down and use_type are CARRIED here as context an operator needs
//  beside the answer — never folded into interval_state. A position that
//  is contractually free and out of service is two true facts, and
//  collapsing them into one false destroys the reason.
//
//  ── PARKED, DELIBERATELY ────────────────────────────────────────────
//  No named cycles or seasons — the durable primitive is a pair of dates
//  and a named period is configuration resolved to dates ABOVE this read.
//  No pace, no preleased %, no comparison to another period or property,
//  no pricing, no prospect placement. Each is a later, separate decision.
//
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════
async function intervalPropertyPositions(pool, {
  property_id, requested_start = null, requested_end = null,
  //  Defaults to detail, exactly like datedPropertyPositions — see the note
  //  on openingTruthStanding. A caller that says nothing keeps the receipt.
  opening_truth_scope = "detail",
} = {}) {
  if (!property_id) throw new Error("intervalPropertyPositions requires property_id");
  /*  ONE OWNER FOR THE BOUNDARY CONTRACT — see intervalBoundariesOrRefuse.
   *
   *  This replaces a raw-string ordering compare followed by
   *  String(value).slice(0, 10) on each boundary. That slice was the whole
   *  defect: it converted an invalid value into a valid-looking day BEFORE
   *  anything could refuse it, so '2026-09-20garbage' became 2026-09-20 and
   *  an impossible '2026-99-99' end was echoed straight back inside an
   *  ESTABLISHED term contract. Ordering was also decided on raw input, so
   *  2026-09-20 → 2026-09-3 answered a REVERSED term while a legitimate
   *  same-day term written with a timestamp start was refused.
   *
   *  Normalisation and ordering both now belong to the primitive, and the
   *  canonical pair is what everything downstream sees — including the
   *  requested_start/requested_end this service reports back.            */
  const { start, end } = intervalBoundariesOrRefuse(requested_start, requested_end);

  //  THE SAME ROWS THE RENT ROLL READS. Not a second query.
  //  Evidence for an interval is judged AT requested_start (see the note
  //  below), so the baseline is the one effective on/before that date —
  //  not whichever row happens to be marked established today.
  const baseline = await openingBaselineAsOf(pool, property_id, start);
  const rows = await loadSpaceRows(pool, property_id, baseline ? baseline.id : null);
  const personNames = await loadPersonNames(pool, rows);

  const down = new Set((await pool.query(
    `select id from units where property_id=$1 and coalesce(is_down,false)=true`, [property_id]
  )).rows.map((r) => String(r.id)));

  const attrs = new Map((await pool.query(
    `select s.id as space_id, u.square_feet, s.use_type, s.position_kind,
            put.code as unit_type_code, put.label as unit_type_label
       from spaces s
       join units u on u.id = s.unit_id
       left join property_unit_types put on put.id = u.unit_type_id
      where u.property_id = $1
        and ${NOT_RETIRED_SQL("u")}`, [property_id]
  )).rows.map((r) => [String(r.space_id), r]));

  const positions = rows.map((row) => {
    const iv = classifyPositionForInterval(row, { start_date: start, end_date: end, personNames });

    /*  ⚠ EVIDENCE: `disagrees` BLOCKS THE ANSWER. `inconclusive` DOES NOT.
     *
     *  The trace proposed that inconclusive opening evidence should read
     *  `unresolved`. Building it showed that is wrong twice over. The
     *  classifier's own comment says it: "unknown CONTRADICTS NOTHING — it
     *  is opening truth that never resolved, not a conflict." And on real
     *  Skyline every unit imports with occupancy_status 'unknown', so the
     *  rule would have made all 160 positions unresolved and the read
     *  useless — honest-looking and worthless.
     *
     *  What genuinely blocks the answer is `disagrees`: the opening source
     *  claims the position is occupied and no lease says so. Someone may be
     *  in there that Spine has no recorded right for, and calling that
     *  contractually free would be a confident wrong answer.
     *
     *  Evidence is judged AT requested_start — the day the position would
     *  be handed over — using the same classifier and the same
     *  evidenceState the Rent Roll uses. Not a second definition.  */
    const atStart = classifyPosition(row, { asOf: start, personNames });
    const evidence = evidenceState({ ...atStart, is_down: down.has(String(row.unit_id)) });

    let state = iv.interval_state;
    let because = iv.conflict_state === "conflicted" ? "overlapping_claims" : null;
    /*  `unreconciled` blocks the answer for the same reason `disagrees`
     *  does, and it must be named explicitly here. Adding the value to
     *  evidenceState without adding it to this gate would have offered
     *  Skyline's six unreconciled beds as contractually free — a NEW way
     *  to double-let a bed, introduced by the change that exists to stop
     *  exactly that. The as-of read and the forward read answer to the
     *  same evidence or they are two different products.  */
    if ((evidence === "disagrees" || evidence === "unreconciled")
        && state === "contractually_free") {
      state = "unresolved";
      //  Two different situations, two different reasons. "disagrees" is a
      //  contradiction between claim and lease; "unreconciled" is an
      //  opening claim that was never settled at all. Collapsing them
      //  would tell whoever chases this the wrong thing to go look at.
      because = evidence === "unreconciled"
        ? "opening_position_unreconciled" : "opening_evidence_disagrees";
    }

    const a = attrs.get(String(row.space_id)) || {};
    return {
      ...iv,
      interval_state: state,
      unresolved_because: state === "unresolved" ? because : null,

      //  CONTEXT, CARRIED AND NEVER FOLDED IN. An operator composing this
      //  with marketability needs these beside the contractual answer; this
      //  read has no opinion about them.
      evidence_state: evidence,
      is_down: down.has(String(row.unit_id)),
      use_type: a.use_type || null,
      position_kind: a.position_kind
        || (row.space_label && !/whole\s*unit/i.test(row.space_label) ? "bed" : "unit"),
      square_feet: a.square_feet ?? null,
      unit_type: a.unit_type_label || null,
      unit_type_code: a.unit_type_code || null,
    };
  });

  const inState = (s) => positions.filter((p) => p.interval_state === s).length;
  return {
    property_id,
    requested_start: start,
    requested_end: end,
    count: positions.length,
    //  Same contract as datedPropertyPositions: a read that excludes rows
    //  says so, and says whether anything is attached to what it hid.
    retired_excluded: await retiredExclusion(pool, property_id),
    opening_truth: opening_truth_scope === "standing"
      ? await openingTruthStanding(pool, property_id)
      : await openingTruth(pool, property_id),
    totals: {
      contractually_free: inState("contractually_free"),
      //  ⚠ THESE KEYS ARE A CONTRACT and were renamed once, deliberately,
      //  while this read had two consumers. `committed` /
      //  `partially_conflicted` made an ordinary lease overlap sound like
      //  the evidence dispute `conflict_state` already names. Both repos
      //  moved together; the app is pinned by the browser proof.
      term_blocked: inState("term_blocked"),
      term_partially_blocked: inState("term_partially_blocked"),
      unresolved: inState("unresolved"),
      units: new Set(positions.map((p) => String(p.unit_id))).size,
    },
    //  Said out loud in the payload, so no consumer has to remember it and
    //  no screen can imply it.
    does_not_establish: [
      "Whether any of these positions can be marketed, shown or offered — that is " +
      "operating availability (readiness, turnover, possession, down state, operating " +
      "designation) and it is availability_read's answer, not this one.",
      "Any price, market rent or concession for the requested interval.",
      "Which prospect may have which position.",
      "How this interval compares to another period, property or market — no basis is recorded.",
    ],
    positions,
  };
}

module.exports = {
  datedPropertyPositions, intervalPropertyPositions, openingTruth, openingTruthStanding,
  tenancyState, evidenceState, economicsState, contributesTrustedRent,
  //  Exported so every surface that shows Occupied/Pending/Open/Needs
  //  Review shows the SAME four numbers. A second implementation of "what
  //  counts as Open" is how the subtraction got there in the first place.
  rentRollBuckets, rentRollBucketOf, rentRollExplain, REASON, positionBasis,
  contractualTermsState,
  RENT_ROLL_LABELS, NOT_ESTABLISHED_LABEL, occupancyClaim,
  //  Re-exported so a surface can ask which baseline answers for a date
  //  without reaching into space_position for it.
  openingBaselineAsOf,
};
