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
const { classifyPosition, classifyPositionForInterval } = require("./position_classifier");

// Occupancy-axis values that mean "structurally not earning".
const NON_REVENUE_CLAIMS = new Set(["model", "down"]);

const claim = (v) => String(v || "").toLowerCase();

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
  if (occupancyClaim(p).value === "vacant") return "vacant";
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
  const contradicted = p.evidence_state === "disagrees"
                    || p.evidence_state === "unreconciled";
  if (p.tenancy_state === "contested" || contradicted) return "needs_review";
  if (p.tenancy_state === "contractually_occupied") return "occupied";
  if (p.tenancy_state === "activation_pending") return "activation_pending";
  //  ── OPEN NEEDS POSITIVE SUPPORT ──────────────────────────────────
  //  The old defect was "not occupied = open". This must not become
  //  "not otherwise classified = open". A bed is Open only when the dated
  //  facts positively support it: an accepted vacancy at the baseline, no
  //  governing tenancy fact spanning the date, and no unresolved
  //  contradiction — all three already established above and here.
  if (p.tenancy_state === "vacant") return "open";
  //  `unresolved` is NOT Open. No spanning lease, and opening truth that
  //  never resolved or claims someone is there — that is a question, and a
  //  question offered as available is how a bed gets double-let.
  if (p.tenancy_state === "unresolved") return "needs_review";
  return "unclassified";
}

/*  ── WHY THIS BED IS IN THIS BUCKET ─────────────────────────────────
 *  The classification and its reason are decided in the same place. A
 *  surface that renders the bucket but explains it in its own words has
 *  made itself a second interpreter, which is what the browser was doing.
 *
 *  Every reason is POSITIVE and causal. Open in particular must never
 *  read "none of the other buckets matched" — that sentence IS the defect
 *  this whole correction exists to remove. It must name the established
 *  vacancy, the absence of a governing tenancy fact, and the absence of a
 *  contradiction, because those three together are what make a bed
 *  genuinely offerable. */
function rentRollBucketReason(p, opts = {}) {
  const asOf = opts.as_of || null;
  const base = opts.baseline_as_of || null;
  const claim = occupancyClaim(p);
  const cur = p.current_lease_position;
  const pend = p.activation_pending_lease_position;
  const term = (l) => `${l.start_date || "no start"} → ${l.end_date || "no end"}`;
  const asOfText = asOf ? ` on ${asOf}` : "";
  const baseText = base ? ` at ${base}` : "";

  if (p.conflict_state === "conflicted") {
    return `Overlapping operative leases on this position (${(p.conflicting_lease_ids || []).join(", ")}) — ` +
      `which one governs is unknown, so no tenancy claim can be made.`;
  }
  if (p.evidence_state === "unreconciled") {
    return `The opening position${baseText} could not reconcile this bed: its source row was left ` +
      `unresolved rather than accepted, so there is no established claim to read forward.`;
  }
  if (p.evidence_state === "disagrees") {
    return cur
      ? `The opening position${baseText} accepted this bed as ${claim.value}, but lease ` +
        `${cur.lease_id} (${cur.lease_status}, ${term(cur)}) is in force${asOfText}. ` +
        `Spine has no basis to choose between the source and the lease record.`
      : `The opening position${baseText} accepted this bed as ${claim.value}, but no lease ` +
        `supports that${asOfText}.`;
  }
  if (cur) {
    return `Operative lease ${cur.lease_id} (${cur.lease_status}, ${term(cur)}) spans${asOfText}` +
      (claim.value === "occupied" ? `, and the opening position${baseText} agrees.` : ".");
  }
  if (pend) {
    return `Lease ${pend.lease_id} is committed (${pend.lease_status}, ${term(pend)}) and spans` +
      `${asOfText}, but economic tenancy is not activated — the bed is spoken for and cannot ` +
      `be offered to anyone else.`;
  }
  if (claim.value === "vacant") {
    return `Established vacant${baseText}, no operative lease spanning${asOfText}, ` +
      `and no unresolved contradiction.`;
  }
  //  Everything left is a QUESTION, and says which one.
  if (!claim.value || claim.value === "unknown") {
    return `No established occupancy claim for this bed${baseText} and no lease spanning` +
      `${asOfText} — Spine cannot say whether it is occupied or available.`;
  }
  return `The opening position${baseText} claims this bed is ${claim.value}, but no lease ` +
    `supports that${asOfText}.`;
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

function rentRollBuckets(positions) {
  const t = { occupied: 0, activation_pending: 0, open: 0, needs_review: 0,
              unclassified: 0, total: positions.length };
  for (const p of positions) t[rentRollBucketOf(p)]++;
  return t;
}

// AXIS 2 — EVIDENCE. Does opening truth agree with lease evidence?
//   confirmed      the claim and the lease evidence agree.
//   disagrees      they contradict: a claim of occupied with no spanning
//                  lease, or a spanning lease on a position claimed vacant.
//   inconclusive   the claim is 'unknown'. Unknown CONTRADICTS NOTHING —
//                  it is opening truth that never resolved, not a conflict.
function evidenceState(p) {
  const lease = !!p.current_lease_position;
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
  return "disagrees";
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

async function datedPropertyPositions(pool, { property_id, as_of = null } = {}) {
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
      bucket: rentRollBucketOf({ ...withDown,
        tenancy_state: tenancyState(withDown), evidence_state: evidenceState(withDown) }),
      bucket_label: RENT_ROLL_LABELS[rentRollBucketOf({ ...withDown,
        tenancy_state: tenancyState(withDown), evidence_state: evidenceState(withDown) })],
      bucket_reason: rentRollBucketReason({ ...withDown,
        tenancy_state: tenancyState(withDown), evidence_state: evidenceState(withDown) },
        { as_of: asOf, baseline_as_of: sp.opening_baseline ? sp.opening_baseline.as_of_date : null }),

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
    opening_truth: await openingTruth(pool, property_id),
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
} = {}) {
  if (!property_id) throw new Error("intervalPropertyPositions requires property_id");
  if (!requested_start) throw new Error("intervalPropertyPositions requires requested_start");
  if (requested_end && String(requested_end) < String(requested_start)) {
    const e = new Error("requested_end is before requested_start");
    e.code = "INVALID_INTERVAL";
    throw e;
  }
  const start = String(requested_start).slice(0, 10);
  const end = requested_end ? String(requested_end).slice(0, 10) : null;

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
    opening_truth: await openingTruth(pool, property_id),
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
  datedPropertyPositions, intervalPropertyPositions, openingTruth,
  tenancyState, evidenceState, economicsState, contributesTrustedRent,
  //  Exported so every surface that shows Occupied/Pending/Open/Needs
  //  Review shows the SAME four numbers. A second implementation of "what
  //  counts as Open" is how the subtraction got there in the first place.
  rentRollBuckets, rentRollBucketOf, rentRollBucketReason,
  RENT_ROLL_LABELS, occupancyClaim,
  //  Re-exported so a surface can ask which baseline answers for a date
  //  without reaching into space_position for it.
  openingBaselineAsOf,
};
