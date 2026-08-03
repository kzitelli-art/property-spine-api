// ════════════════════════════════════════════════════════════════════
//  dated_position_rows.js — SLICE 10B. THE CANONICAL DATED POSITION ROW.
//
//  One row per canonical leaseable position (spaces.id) on a selected date.
//  This is a ROW engine. It publishes no property occupancy percentage and no
//  unqualified rent total, because two of the inputs those totals need are not
//  yet governable everywhere: the denominator depends on classification that
//  may be unpopulated, and rent may rest on a legacy amount that cannot prove
//  itself on a future date. Rows stay truthful; totals wait.
//
//  BUILT ON THE EXISTING MACHINERY, NOT BESIDE IT. datedPropertyPositions
//  already resolves lease spanning, successor state, notice, possession,
//  conflict and availability. This adds four things it does not do:
//
//    1. DENOMINATOR CLASS from the governed spaces.use_type authority.
//    2. CONFLICT INTEGRITY — a contested position stops naming a governing
//       lease. The prior read detected the conflict and then still returned
//       the first matching lease and its rent.
//    3. ECONOMICS PRECEDENCE — dated economic lines first, legacy leases.rent
//       only as a qualified fallback, each row naming its own authority.
//    4. PER-AXIS COVERAGE — occupancy, rent, denominator and action each
//       report their own completeness, so one missing axis never erases a
//       fact that remains independently proven.
//
//  WRITES NOTHING. No per-row queries: economics is fetched once for the
//  whole property and indexed in memory.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions } = require("./dated_positions");
const { loadPropertyOperatingTimeZone, TZ_UNAVAILABLE } = require("../shared/property_timezone");

// ── WHAT "TODAY" MEANS (owner ruling, Slice 10B) ────────────────────
//  An explicit as_of is a property-local calendar date. A missing as_of is
//  today IN THE PROPERTY'S OWN OPERATING TIMEZONE — never server UTC, never
//  browser local, never a hardcoded Eastern default.
//
//  The prior read defaulted to new Date().toISOString().slice(0,10), which is
//  UTC today. For a property west of UTC that is tomorrow for several hours
//  every night, so a dated surface would silently answer for the wrong day.
//
//  A property with no governed operating timezone has no operating day, and
//  therefore no answer. It refuses in the shared vocabulary rather than
//  borrowing someone else's midnight.
function todayInZone(zone) {
  //  en-CA renders ISO-shaped YYYY-MM-DD, and formatToParts avoids relying on
  //  locale string order.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ── DENOMINATOR CLASS ───────────────────────────────────────────────
//  Governed by spaces.use_type (migration 100), which states that use_type
//  "Governs leasable denominators and residential-vs-commercial treatment".
//  availability_read.js already treats {residential, commercial} as the
//  marketable set; the same two are the revenue set here, reported
//  separately rather than merged, because the distinction is the point.
//
//  'other' and NULL are NOT quietly folded into revenue. An unclassified
//  position is unknown, and one unknown withholds the property rate — which
//  is why the rate is not published by this engine at all.
const REVENUE_USE_TYPES = new Set(["residential", "commercial"]);

function denominatorClass(use_type) {
  if (use_type === "non_revenue") return "non_revenue";
  if (REVENUE_USE_TYPES.has(use_type)) return "revenue";
  return "unknown";              // 'other', null, or never classified
}

// ── ECONOMICS ───────────────────────────────────────────────────────
//  Precedence, governed:
//    1. an applicable dated economic line          → dated_economic_line
//    2. no dated line, an admitted leases.rent     → legacy_lease_rent (qualified)
//    3. neither                                    → missing
//    4. more than one applicable dated base_rent   → conflict, no amount
//    5. units.market_rent                          → NEVER. Not read here at all.
//
//  A month is the grain the schedule speaks in (lease_economic_lines.
//  effective_month), so the applicable line is the one whose month contains
//  the selected date. Concession credits and fee waivers in that same month
//  net against base rent; one-time fees do not, because a one-time fee is not
//  monthly rent.
const RENT_AUTHORITY = Object.freeze({
  DATED: "dated_economic_line",
  LEGACY: "legacy_lease_rent",
  MISSING: "missing",
  CONFLICT: "conflict",
});

const monthOf = (isoDay) => String(isoDay).slice(0, 7);

// ── EVIDENCE STATE, one named vocabulary ────────────────────────────
//  What supports this row's contractual conclusion. Deliberately NOT a
//  confidence score: a score invites a consumer to threshold it, and a
//  threshold is an opinion about someone's lease. These are source facts.
const EVIDENCE_STATE = Object.freeze({
  SUPPORTED: "contractually_supported",   // a governed dated schedule
  QUALIFIED_LEGACY: "qualified_legacy",   // the lease's own amount, inside the month it can prove
  INCOMPLETE: "incomplete",               // nothing governed reaches this date
  CONFLICTING: "conflicting",             // competing governed facts, no winner selectable
  UNTRACKABLE: "untrackable",             // lineage cannot resolve to one position
  UNAVAILABLE: "unavailable",             // the source could not be read at all
});

// ── RESULT STATE, at the response level ─────────────────────────────
//  These must never collapse into a generic empty answer. "No positions on
//  this property" and "this property has no operating day" are different
//  facts, and a consumer that cannot tell them apart will say the wrong thing.
const RESULT_STATE = Object.freeze({
  QUALIFYING: "qualifying_result_exists",
  NONE: "no_qualifying_result",
  UNAVAILABLE: "unavailable",
  AUTHORITY_MISSING: "authority_missing",
});

function evidenceStateFor(conflicted, rentAuthority, legacyQualification) {
  if (conflicted) return EVIDENCE_STATE.CONFLICTING;
  if (rentAuthority === RENT_AUTHORITY.CONFLICT) return EVIDENCE_STATE.CONFLICTING;
  if (rentAuthority === RENT_AUTHORITY.DATED) return EVIDENCE_STATE.SUPPORTED;
  if (rentAuthority === RENT_AUTHORITY.LEGACY) {
    return legacyQualification === "within_initial_month"
      ? EVIDENCE_STATE.QUALIFIED_LEGACY : EVIDENCE_STATE.INCOMPLETE;
  }
  return EVIDENCE_STATE.INCOMPLETE;
}

//  CLASSIFICATION PROVENANCE. dated_positions carries use_type but not who
//  classified it or when, and provenance is half the point of a governed
//  classification — a class with no author is an assertion. Loaded here in one
//  property-wide query rather than by extending a read four surfaces share.
async function loadClassification(pool, { property_id }) {
  const { rows } = await pool.query(
    `select s.id as space_id, s.classified_by_user_id, s.classified_at, s.classification_source
       from spaces s join units u on u.id = s.unit_id
      where u.property_id = $1`, [property_id]);
  return new Map(rows.map((r) => [String(r.space_id), r]));
}

//  ONE query for the whole property. Indexed by space, then by month.
async function loadEconomics(pool, { property_id, month }) {
  const { rows } = await pool.query(
    `select s.space_id, s.id as schedule_id, s.application_id, s.source_offer_id,
            l.id as line_id, l.line_type, l.amount, to_char(l.effective_month,'YYYY-MM') as ym
       from lease_economic_schedules s
       join lease_economic_lines   l on l.schedule_id = s.id
      where s.property_id = $1
        and s.status in ('locked','active')
        and to_char(l.effective_month,'YYYY-MM') = $2`,
    [property_id, month]
  );
  const bySpace = new Map();
  for (const r of rows) {
    const k = String(r.space_id);
    if (!bySpace.has(k)) bySpace.set(k, { base: [], credits: [], lineage: [] });
    const b = bySpace.get(k);
    //  LINEAGE, not just the number. "Which lease created this rent change?"
    //  is answerable only if the row names the schedule and line that produced
    //  the amount, and the application/offer that schedule came from.
    b.lineage.push({ schedule_id: r.schedule_id, line_id: r.line_id, line_type: r.line_type,
                     effective_month: r.ym, application_id: r.application_id,
                     source_offer_id: r.source_offer_id });
    if (r.line_type === "base_rent") b.base.push(Number(r.amount));
    else if (r.line_type === "concession_credit" || r.line_type === "fee_waiver") b.credits.push(Number(r.amount));
    // recurring_fee and one_time_fee are deliberately not monthly contract rent
  }
  return bySpace;
}

//  THE LEGACY QUALIFICATION. leases.rent is one undated number. It can be
//  trusted for the month the lease STARTS in — that is the amount the lease
//  began at — and cannot prove itself for any later month, because a dated
//  step would live in a schedule this lease does not have. So a fallback used
//  beyond the start month is still returned, but the row is partial and says
//  why. That is weaker than the dated rail and is labelled as such; it is not
//  a peer authority.
function legacyQualification(lease, asOf) {
  if (!lease || !lease.start_date) return "unqualified_no_start";
  return monthOf(lease.start_date) === monthOf(asOf) ? "within_initial_month" : "beyond_provable_period";
}

function economicsForRow(p, econ, asOf) {
  const lease = p.governing_lease;                     // already conflict-cleared
  if (p.conflict_state === "conflicted") {
    return { contractual_rent: null, rent_authority: RENT_AUTHORITY.CONFLICT,
             rent_note: "Incompatible leases cover this date, so no contractual rent can be attributed.",
             legacy_qualification: null, rent_lineage: [],
             blockers: [{ code: "conflicting_leases", affects: ["occupancy", "rent"],
                          detail: "More than one non-terminal lease covers this date." }] };
  }
  const e = econ.get(String(p.space_id));
  if (e && e.base.length > 1) {
    return { contractual_rent: null, rent_authority: RENT_AUTHORITY.CONFLICT,
             rent_note: "More than one base rent applies in this month; no amount is selected.",
             legacy_qualification: null, rent_lineage: e.lineage,
             blockers: [{ code: "conflicting_economic_lines", affects: ["rent"],
                          detail: "More than one base rent is effective in this month." }] };
  }
  if (e && e.base.length === 1) {
    const net = e.base[0] + e.credits.reduce((a, b) => a + b, 0);   // credits are negative by constraint
    return { contractual_rent: Math.round(net * 100) / 100, rent_authority: RENT_AUTHORITY.DATED,
             rent_note: e.credits.length ? "Dated schedule, net of concessions effective this month." : "Dated schedule.",
             legacy_qualification: null, rent_lineage: e.lineage, blockers: [] };
  }
  if (lease && lease.rent != null && Number(lease.rent) !== 0) {
    const q = legacyQualification(lease, asOf);
    return { contractual_rent: Number(lease.rent), rent_authority: RENT_AUTHORITY.LEGACY,
             rent_note: q === "within_initial_month"
               ? "No dated schedule exists; the lease's own amount covers its opening month."
               : "No dated schedule exists. The lease carries a single undated amount, which cannot prove a later month's rent.",
             legacy_qualification: q, rent_lineage: [{ lease_id: lease.lease_id, basis: "legacy_lease_rent" }],
             blockers: q === "within_initial_month" ? []
               : [{ code: "undated_rent_beyond_opening_month", affects: ["rent"],
                    detail: "The amount is the lease's single undated rent and cannot prove this month." }] };
  }
  return { contractual_rent: null, rent_authority: RENT_AUTHORITY.MISSING,
           rent_note: "No contractual rent is recorded for this position on this date.",
           legacy_qualification: null, rent_lineage: [],
           blockers: [{ code: "no_contractual_rent_recorded", affects: ["rent"],
                        detail: "Neither a dated schedule nor a lease amount exists for this position." }] };
}

// ── EXACT EXISTING ACTIONS ──────────────────────────────────────────
//  ONE lineage is admitted in this phase, and only because it is exact:
//
//      obligation.related_id (where related_type='lease') → leases.space_id
//
//  There is NO obligations.lease_id column. The obligation rail carries object
//  lineage through the generic (related_id, related_type) pair, and
//  related_type='lease' is already written by activation.js and read by
//  move_in_queue.js — so this is the established path, not a new one.
//
//  leases.space_id is NOT NULL, so a lease resolves to exactly one canonical
//  position. obligations.unit_id also exists but is UNIT grain and is
//  deliberately not used: a unit with more than one space cannot resolve to
//  one position without inference, which is forbidden. That is relational traversal, not inference. Correlation through
//  a resident name, a unit number, a leasing agent, a last editor or similar
//  dates is forbidden and is not attempted anywhere below.
//
//  An obligation is shown ONLY when every one of these holds:
//    · the obligation's property is the authenticated property;
//    · the lease's property is the SAME property (both walls, not one);
//    · the lease resolves to exactly one space;
//    · that lease is one THIS row actually references — the governing lease,
//      or one of its conflicting leases. An obligation about some other lease
//      on the same space is not the same unresolved condition;
//    · the obligation is still active under the governed lifecycle.
const ACTIVE_OBLIGATION_STATUSES = new Set(["open", "in_progress", "escalated"]);

//  GOVERNED DESTINATIONS ONLY. A destination is returned when a canonical
//  operator route demonstrably exists for that obligation type in this
//  codebase. Where none exists the contract says so with null and discloses
//  the limitation — it does not invent a route or emit prose like
//  "go review the lease".
const GOVERNED_DESTINATIONS = Object.freeze({
  resolve_inbound_opportunity: {
    surface: "operator_obligations",
    route_key: "operator.obligations.inbound_decision",
  },
});

//  DUE STATE. No Forward-Rent-Roll-specific ladder: the only due vocabulary in
//  the obligation rail today is is_overdue (due_at < now()). This states the
//  minimum honest distinctions on top of it, and "today" is the PROPERTY's
//  today, consistent with every other date in this engine.
//  FROZEN. Exported so a renderer or a future governed tool consumes the
//  vocabulary rather than reconstructing it from labels.
const DUE_STATE = Object.freeze({
  OVERDUE: "overdue", DUE_TODAY: "due_today", NOT_DUE: "not_due",
  NO_DUE_DATE: "no_due_date", TERMINAL: "terminal",
});

// ── THE FIVE COMPUTED ACTION STRINGS, CLASSIFIED ────────────────────
//  position_classifier.js emits these next_required_action values. None is an
//  obligation: no id, no owner, no due state, no closing act, no destination.
//  The structured obligation projection is the authority; these strings are
//  not upgraded into actions merely because they sound operational.
//
//  A sixth value, confirm_physical_readiness, is invented at the read in
//  snapshot_loader.js:490 when the classifier returned nothing. It is an
//  unsupported_instruction and does not appear here at all.
const ACTION_STRING_CLASSIFICATION = Object.freeze({
  economic_tenancy_activation_required: {
    states_fact: true, implies_assigned_work: true,
    classification: "noncanonical_recommendation",
    replacement: "removed from the action contract; the condition remains in the row position state",
  },
  possession_outstanding: {
    states_fact: true, implies_assigned_work: true,
    classification: "noncanonical_recommendation",
    replacement: "removed from the action contract; possession state remains readable",
  },
  review_early_possession: {
    states_fact: true, implies_assigned_work: true,
    classification: "unsupported_instruction",
    replacement: "removed; review names no closing act and no obligation type matches it",
  },
  turn_before_committed_start: {
    states_fact: true, implies_assigned_work: true,
    classification: "noncanonical_recommendation",
    replacement: "removed; a real turn obligation would project through the obligation rail like any other",
  },
  possession_without_current_lease: {
    states_fact: true, implies_assigned_work: false,
    classification: "plain_explanation",
    replacement: "retained as explanation only; it states a sourced condition and claims no assigned work",
  },
});
const EXPLANATORY_ACTION_STRINGS = new Set(
  Object.entries(ACTION_STRING_CLASSIFICATION)
    .filter(function (e) { return e[1].classification === "plain_explanation"; })
    .map(function (e) { return e[0]; })
);

function dueState(ob, todayLocal) {
  if (!ACTIVE_OBLIGATION_STATUSES.has(String(ob.status))) return DUE_STATE.TERMINAL;
  if (!ob.due_at) return DUE_STATE.NO_DUE_DATE;
  //  DATE comparison against the PROPERTY's today, not a clock comparison
  //  against server UTC. An obligation due today is not overdue at 09:00
  //  merely because its timestamp was midnight.
  const due = new Date(ob.due_at).toISOString().slice(0, 10);
  if (due < todayLocal) return DUE_STATE.OVERDUE;
  if (due === todayLocal) return DUE_STATE.DUE_TODAY;
  return DUE_STATE.NOT_DUE;
}

//  ONE property-wide query. No per-row lookup, and the obligation join cannot
//  duplicate a position row because obligations are grouped by space in memory.
async function loadObligations(pool, { property_id }) {
  const { rows } = await pool.query(
    `select o.id, o.type, o.status, o.label, o.due_at, o.assigned_user_id,
            u.name as owner_name, o.related_id as lease_id, l.space_id
       from obligations o
       join leases l on l.id = o.related_id and o.related_type = 'lease'
       left join users u on u.id = o.assigned_user_id
      where o.property_id = $1
        and l.property_id = $1`,
    [property_id]
  );
  const bySpace = new Map();
  for (const r of rows) {
    const k = String(r.space_id);
    if (!bySpace.has(k)) bySpace.set(k, []);
    bySpace.get(k).push(r);
  }
  return bySpace;
}

function actionForRow(p, obligations, todayLocal, referencedLeaseIds) {
  const all = obligations.get(String(p.space_id)) || [];
  //  Same unresolved condition: the obligation's lease must be one this row
  //  actually references.
  const relevant = all.filter((o) => referencedLeaseIds.has(String(o.lease_id)));
  const active = relevant.filter((o) => ACTIVE_OBLIGATION_STATUSES.has(String(o.status)));

  if (active.length === 0) {
    return {
      resolution_state: "no_canonical_action",
      explanation: "No canonical action is recorded yet.",
      existing_action: null,
      //  Terminal obligations stay visible as lineage — they explain WHY there
      //  is no active action without being presented as one.
      closed_action_lineage: relevant.map((o) => ({ obligation_id: o.id, type: o.type, status: o.status })),
    };
  }
  if (active.length > 1) {
    return {
      resolution_state: "conflict",
      explanation: "More than one active obligation represents this condition; none is selected.",
      existing_action: null,
      conflicting_obligation_ids: active.map((o) => o.id),
      closed_action_lineage: [],
    };
  }
  const o = active[0];
  const dest = GOVERNED_DESTINATIONS[String(o.type)] || null;
  return {
    resolution_state: "existing_action",
    explanation: null,
    existing_action: {
      obligation_id: o.id,
      obligation_type: o.type,
      source_object_type: "lease",
      source_object_id: o.lease_id,
      space_id: p.space_id,
      owner: o.assigned_user_id ? { user_id: o.assigned_user_id, name: o.owner_name || null } : "UNASSIGNED",
      due_state: dueState(o, todayLocal),
      due_at: o.due_at || null,
      closing_act: o.label || null,
      canonical_destination: dest
        ? { ...dest, object_type: "obligation", object_id: o.id }
        : null,
      destination_note: dest ? null
        : "No governed operator destination is recorded for this obligation type.",
      evidence: {
        correlation: "obligation.related_id(related_type=lease) -> leases.space_id",
        lease_id: o.lease_id,
        property_walled: "obligation.property_id and lease.property_id both matched",
      },
    },
    closed_action_lineage: [],
  };
}

// ── THE ROW ─────────────────────────────────────────────────────────
async function datedPositionRows(pool, { property_id, as_of = null } = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool is required");
  if (!property_id) throw new TypeError("property_id is required");

  //  The selected date is resolved BEFORE the projection runs, so a property
  //  with no operating day never reaches a dated read at all.
  const zone = await loadPropertyOperatingTimeZone(pool, property_id);
  if (!zone) {
    return {
      property_id, as_of: null, contract_version: "dated_position_rows_v1",
      state: TZ_UNAVAILABLE.state, result_state: RESULT_STATE.AUTHORITY_MISSING,
      reason: TZ_UNAVAILABLE.reason,
      detail: "This property has no configured operating timezone, so it has no operating day and no dated position can be stated.",
      rows: [], withheld: null,
    };
  }
  const resolvedAsOf = as_of || todayInZone(zone);

  const dp = await datedPropertyPositions(pool, { property_id, as_of: resolvedAsOf });
  const asOf = dp.as_of;
  const econ = await loadEconomics(pool, { property_id, month: monthOf(asOf) });
  const cls  = await loadClassification(pool, { property_id });
  const obls = await loadObligations(pool, { property_id });

  const rows = dp.positions.map((p) => {
    const conflicted = p.conflict_state === "conflicted";

    //  CONFLICT INTEGRITY. The prior read detected the conflict and then still
    //  handed back the first matching lease. A position the system cannot
    //  govern must not name a governing lease at all.
    const governing = conflicted ? null : (p.lease || null);
    const withGoverning = { ...p, governing_lease: governing };

    const dclass = denominatorClass(p.use_type);
    const ec = economicsForRow(withGoverning, econ, asOf);

    //  Leases THIS row references — the governing one plus any in conflict.
    const referenced = new Set([
      ...(governing && governing.lease_id ? [String(governing.lease_id)] : []),
      ...(p.conflicting_lease_ids || []).map(String),
    ]);
    const act = actionForRow(p, obls, asOf, referenced);

    //  PER-AXIS COVERAGE. Four independent questions. A missing rent never
    //  erases a proven occupancy, and an unclassified position never erases a
    //  proven lease.
    const coverage = {
      occupancy: conflicted ? "conflict" : (p.lease || p.successor?.lease_id ? "complete" : "complete"),
      rent: ec.rent_authority === RENT_AUTHORITY.DATED ? "complete"
          : ec.rent_authority === RENT_AUTHORITY.CONFLICT ? "conflict"
          : ec.rent_authority === RENT_AUTHORITY.LEGACY
            ? (ec.legacy_qualification === "within_initial_month" ? "complete" : "partial")
            : "partial",
      denominator: dclass === "unknown" ? "unknown" : "complete",
      action: act.resolution_state === "existing_action" ? "complete"
            : act.resolution_state === "conflict" ? "conflict" : "no_canonical_action",
    };

    return {
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,
      space_label: p.space_label,
      position_kind: p.position_kind,

      // denominator authority, with its provenance
      denominator_class: dclass,
      use_type: p.use_type || null,
      classified_by_user_id: (cls.get(String(p.space_id)) || {}).classified_by_user_id || null,
      classified_at: (cls.get(String(p.space_id)) || {}).classified_at || null,
      classification_source: (cls.get(String(p.space_id)) || {}).classification_source || null,

      // position on the selected date
      position_state: conflicted ? "conflict" : p.future_state || null,
      governing_lease_id: governing ? governing.lease_id : null,
      governing_lease_end: governing ? governing.end_date : null,
      successor_state: p.successor ? p.successor.state : null,
      successor_lease_id: p.successor ? p.successor.lease_id : null,
      proof_basis: p.proof_basis || null,

      // conflict, preserved rather than resolved
      conflict_state: p.conflict_state,
      conflicting_lease_ids: p.conflicting_lease_ids || [],

      // economics, naming its own authority
      contractual_rent: ec.contractual_rent,
      rent_authority: ec.rent_authority,
      legacy_qualification: ec.legacy_qualification,
      rent_note: ec.rent_note,
      rent_lineage: ec.rent_lineage || [],

      //  Only a plain_explanation string survives, and only as explanation.
      position_note: EXPLANATORY_ACTION_STRINGS.has(String(p.next_required_action))
        ? p.reason || null : null,
      resolution_state: act.resolution_state,
      resolution_explanation: act.explanation,
      existing_action: act.existing_action,
      closed_action_lineage: act.closed_action_lineage,
      ...(act.conflicting_obligation_ids ? { conflicting_obligation_ids: act.conflicting_obligation_ids } : {}),

      evidence_state: evidenceStateFor(conflicted, ec.rent_authority, ec.legacy_qualification),
      coverage,
      //  TYPED, machine-readable. A consumer must not have to parse prose to
      //  learn why an answer is absent.
      blockers: [
        ...(ec.blockers || []),
        ...(dclass === "unknown"
          ? [{ code: "position_use_type_unclassified", affects: ["denominator"],
               detail: "This position has no governed use_type, so it cannot be placed in a revenue denominator." }]
          : []),
      ],
    };
  });

  return {
    property_id,
    as_of: asOf,
    operating_timezone: zone,
    as_of_basis: as_of ? "explicit_property_local_date" : "property_local_today",
    contract_version: "dated_position_rows_v1",
    state: "ok",
    result_state: rows.length ? RESULT_STATE.QUALIFYING : RESULT_STATE.NONE,
    rows,
    //  Deliberately absent: projected_occupancy_rate, revenue_denominator,
    //  scheduled_rent_total. See the header — a rate over an unknown
    //  denominator, or a total containing unqualified legacy amounts, would
    //  be the confident-wrong number this engine exists to refuse.
    withheld: {
      projected_occupancy_rate: "Withheld — a property rate requires every position classified.",
      revenue_denominator: "Withheld — unknown denominator classes exist or cannot be proven here.",
      scheduled_rent_total: "Withheld — legacy or missing economics could change it.",
    },
  };
}

module.exports = {
  datedPositionRows, denominatorClass,
  RENT_AUTHORITY, REVENUE_USE_TYPES, EVIDENCE_STATE, RESULT_STATE,
  ACTIVE_OBLIGATION_STATUSES, GOVERNED_DESTINATIONS, dueState,
  DUE_STATE, ACTION_STRING_CLASSIFICATION, EXPLANATORY_ACTION_STRINGS,
};
