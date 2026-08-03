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

  const rows = dp.positions.map((p) => {
    const conflicted = p.conflict_state === "conflicted";

    //  CONFLICT INTEGRITY. The prior read detected the conflict and then still
    //  handed back the first matching lease. A position the system cannot
    //  govern must not name a governing lease at all.
    const governing = conflicted ? null : (p.lease || null);
    const withGoverning = { ...p, governing_lease: governing };

    const dclass = denominatorClass(p.use_type);
    const ec = economicsForRow(withGoverning, econ, asOf);

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
      action: "no_canonical_action",       // Phase E replaces this with a real projection
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
};
