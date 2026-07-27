// ════════════════════════════════════════════════════════════════════
//  concession_schedule_compiler.js — DATED ECONOMIC CONSEQUENCE
//
//  Replaces the throw-only stub that has blocked every concession. Pure and
//  deterministic: no database, no clock, no randomness. Same inputs, same
//  schedule lines, forever — which is what makes a concession auditable
//  rather than a story about a discount.
//
//  ── A CONCESSION IS NOT A FLAG ───────────────────────────────────────
//  "One month free" is not economic truth. The truth is WHICH month, WHICH
//  amount, and WHEN it posts. `free_months: 1` cannot answer any of those, so
//  this compiler never returns it as a result — every profile produces dated
//  lines, and the effective-rent consequence is DERIVED from those lines
//  rather than asserted alongside them. If the lines are wrong, the effective
//  rent is wrong in the same direction, and a reviewer can see it.
//
//  ── ONLY COMPLETE CONTRACTS ARE IMPLEMENTED ──────────────────────────
//  Four profiles were evaluated. Three are implemented because their inputs,
//  date rules, output and failure conditions are fully specified. The fourth
//  (free_rent_period) is SPECIFIED BUT NOT IMPLEMENTED — see FREE_RENT_PERIOD
//  below for the exact missing primitive. Shipping it half-defined would put
//  a number in front of a prospect that the ledger could not later reproduce.
//
//  ACTIVATES NOTHING. No route calls this to create real lines, and no
//  operator UI can reach it.
// ════════════════════════════════════════════════════════════════════

"use strict";

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || "").slice(0, 10));
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const parse = (s) => new Date(String(s).slice(0, 10) + "T00:00:00Z");
const money = (n) => Math.round(Number(n) * 100) / 100;

function addMonths(dateStr, n) {
  const d = parse(dateStr);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  // Clamp to month end rather than rolling into the next month: adding one
  // month to Jan 31 must not silently become Mar 3.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** First day of the first FULL calendar month on or after a start date. */
function firstFullMonthStart(startYmd) {
  const d = parse(startYmd);
  if (d.getUTCDate() === 1) return ymd(d);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

const fail = (code, detail) => ({ ok: false, code, detail, lines: [] });

// ── PRORATION BASIS — the primitive that blocked four profiles ───────
// A period that does not align to calendar months has no single correct
// credit. On a 20-day February the three bases differ by more than 10%, so a
// silent default would make the ledger unable to reproduce the number later.
// There is deliberately NO property default: the basis must be declared.
const PRORATION_BASES = {
  actual_days:      { detail: 'Credit = monthly amount x (days covered / days in that calendar month).' },
  thirty_day_month: { detail: 'Credit = monthly amount x (days covered / 30), regardless of month length.' },
  full_months_only: { detail: 'Only whole calendar months are credited; partial months are credited nothing.' },
};

function daysInMonth(ymdStr) {
  const d = parse(ymdStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Prorated credit for a partial month. PURE. */
function prorate(monthlyAmount, coveredDays, anchorYmd, basis) {
  if (basis === 'full_months_only') return 0;
  const denom = basis === 'thirty_day_month' ? 30 : daysInMonth(anchorYmd);
  return money((Number(monthlyAmount) * Number(coveredDays)) / denom);
}

// ── SCHEDULE SOURCE — the primitive that blocked monthly_scheduled_credit ──
// A per-month schedule cannot be inferred from one total: 'nine hundred
// dollars' does not say whether that is 3x300 or 9x100, nor which months.
// So the caller supplies explicit dated amounts, or names a governed source.
const SCHEDULE_SOURCES = ['explicit_lines', 'governed_reference'];

// ── PROFILE CONTRACTS ────────────────────────────────────────────────
const PROFILES = {
  one_time_fee_waiver: {
    implemented: true,
    required_inputs: ["concession_type=fee_waiver", "fee_category", "fee_amount (resolved)", "posting_date"],
    date_rules: "Month-agnostic. Needs a posting date only — no lease-relative calendar.",
    output: "Exactly ONE credit line on the posting date, equal to the resolved fee amount.",
    effective_rent_consequence: "None on monthly rent. It reduces move-in cost, not rent.",
    failure_conditions: ["fee amount unresolved", "no fee_category", "no posting date"],
    applies_to: ["new_lease", "renewal"],
    storable_today: true,
    storage_note: "concession_policies with timing_profile='one_time_fee_waiver' and fee_category set.",
  },
  flat_dated_credit: {
    implemented: true,
    required_inputs: ["value", "posting_date", "lease_start", "lease_end"],
    date_rules: "posting_date must fall inside [lease_start, lease_end).",
    output: "Exactly ONE credit line on posting_date for the stated value.",
    effective_rent_consequence: "Amortized across the lease term for reporting; the LINE is not amortized.",
    failure_conditions: ["posting date outside the lease", "missing lease dates", "value <= 0"],
    applies_to: ["new_lease", "renewal"],
    storable_today: true,
    storage_note: "concession_policies with timing_profile='flat_dated_credit' and applies_from as the posting date.",
  },
  fixed_monthly_discount: {
    implemented: true,
    required_inputs: ["value (per month)", "duration_months", "lease_start", "lease_end", "base_rent"],
    date_rules: "Runs for duration_months consecutive full months from the first full month of the lease. Must fit inside the term.",
    output: "ONE credit line per month, each for `value`, dated the 1st of each covered month.",
    effective_rent_consequence: "effective_rent = base_rent − (total credit ÷ lease term months).",
    failure_conditions: ["duration exceeds the term", "missing lease dates", "value >= base_rent", "value <= 0"],
    applies_to: ["new_lease", "renewal"],
    storable_today: true,
    storage_note: "concession_policies with timing_profile='fixed_monthly_discount' and duration_months set.",
  },
  // ── legacy calendar vocabulary (migration 062) ────────────────────
  // Listed rather than treated as unknown. They are real, declared profiles
  // that the concession vocabulary still accepts; they are simply not
  // implementable for the same reason free_rent_period is not. Returning
  // "unknown profile" for them would misreport a known gap as a typo.
  first_full_month: {
    implemented: true, legacy: true, requires_proration_basis: true,
    required_inputs: ["lease_start", "base_rent", "PRORATION RULE"],
    missing_primitive: "proration_basis",
    missing_detail: "Relative to a lease that does not begin on the 1st, 'the first full month' " +
      "identifies a month but not the amount, because the partial month before it has no declared " +
      "proration basis.",
    applies_to: ["new_lease", "renewal"], storable_today: true,
  },
  third_full_month: { implemented: true, legacy: true, requires_proration_basis: true,
    missing_detail: "Same gap as first_full_month.", applies_to: ["new_lease", "renewal"], storable_today: true },
  final_full_month: { implemented: true, legacy: true, requires_proration_basis: true,
    missing_detail: "Same gap, plus it depends on an end date that early termination can move.",
    applies_to: ["new_lease", "renewal"], storable_today: true },
  monthly_scheduled_credit: { implemented: true, legacy: true, requires_schedule_source: true,
    missing_detail: "A per-month schedule needs a declared source for the amounts; the vocabulary " +
      "carries a single value and no schedule. fixed_monthly_discount is the implemented form of this shape.",
    applies_to: ["new_lease", "renewal"], storable_today: true },

  free_rent_period: {
    implemented: true, requires_proration_basis: true,
    required_inputs: ["lease_start", "lease_end", "base_rent", "free period start", "free period end", "PRORATION RULE"],
    date_rules: "Specified except for the proration rule on a partial month.",
    output: "One credit per covered month; a PARTIAL month's credit is undefined.",
    effective_rent_consequence: "base_rent − (total free rent ÷ term).",
    failure_conditions: ["period outside the lease", "missing dates"],
    applies_to: ["new_lease", "renewal"],
    storable_today: false,
    // The precise missing primitive, stated rather than guessed at:
    missing_primitive: "proration_basis",
    missing_detail:
      "A free-rent period that does not align to calendar month boundaries needs a declared " +
      "proration basis — actual days in month, a 30-day month, or full-months-only. The three " +
      "produce materially different credits on the same lease (a 20-day February differs by more " +
      "than 10%), and nothing in the schema or the concession vocabulary declares which applies. " +
      "Guessing would make the ledger unable to reproduce the number later.",
  },
};

const IMPLEMENTED = Object.keys(PROFILES).filter((k) => PROFILES[k].implemented);

/**
 * Compile a concession into dated economic lines. PURE.
 *
 * @param input {
 *   timing_profile, concession_type, value,
 *   lease_start, lease_end, base_rent, lease_term_months,
 *   duration_months?, posting_date?, fee_category?, fee_amount?, fee_resolved?
 * }
 * @returns { ok, code?, detail?, lines:[{date, kind, amount, reason}], effective_rent?, total_credit? }
 */
function compileSchedule(input = {}) {
  const p = input.timing_profile;
  if (!p) return fail("no_timing_profile", "A concession must state how it lands in time.");
  if (!PROFILES[p]) return fail("unknown_timing_profile", `${p} is not a known profile.`);
  if (!PROFILES[p].implemented) {
    return fail("timing_profile_not_implemented",
      `${p} is specified but not implemented. Missing primitive: ${PROFILES[p].missing_primitive}. ` +
      PROFILES[p].missing_detail);
  }

  // ── a fee waiver is month-agnostic and handled first ──────────────
  if (p === "one_time_fee_waiver") {
    if (input.concession_type !== "fee_waiver")
      return fail("profile_type_mismatch", "one_time_fee_waiver requires concession_type fee_waiver.");
    if (!input.fee_category) return fail("fee_waiver_without_category", "A waiver must name the fee it waives.");
    // THE RULE THAT MATTERS: a waiver's size IS the fee's amount.
    if (input.fee_resolved !== true || input.fee_amount == null)
      return fail("governed_fee_unresolved",
        `The ${input.fee_category} fee has no single governed amount, so the size of the waiver ` +
        `cannot be stated. A waiver over an unresolved fee is a discount nobody can quantify.`);
    const date = input.posting_date || input.lease_start;
    if (!isYmd(date)) return fail("missing_posting_date", "A waiver needs a posting date.");
    const amount = money(input.fee_amount);
    return {
      ok: true, profile: p,
      lines: [{ date, kind: "fee_waiver_credit", amount, reason: `${input.fee_category} fee waived` }],
      total_credit: amount,
      effective_rent: input.base_rent == null ? null : money(input.base_rent),
      effective_rent_note: "A fee waiver does not change monthly rent.",
    };
  }

  // ── everything else is dated and needs real lease dates ───────────
  if (!isYmd(input.lease_start) || !isYmd(input.lease_end))
    return fail("missing_lease_dates", "A dated concession cannot be compiled without lease start and end dates.");
  if (parse(input.lease_end) <= parse(input.lease_start))
    return fail("invalid_lease_dates", "lease_end must be after lease_start.");
  // `value` is required only by the profiles that USE it. Free-rent and
  // full-month profiles forgive the RENT, and monthly_scheduled_credit
  // carries its amounts on its schedule lines, so demanding a value from
  // them would refuse a well-formed concession for missing a field it has
  // no use for.
  const VALUE_DRIVEN = ["flat_dated_credit", "fixed_monthly_discount"];
  const value = Number(input.value);
  if (VALUE_DRIVEN.includes(p) && (!Number.isFinite(value) || value <= 0))
    return fail("invalid_value", "A concession value must be greater than zero.");

  const termMonths = Number(input.lease_term_months) || null;

  if (p === "flat_dated_credit") {
    const date = input.posting_date || input.lease_start;
    if (!isYmd(date)) return fail("missing_posting_date", "A flat dated credit needs a posting date.");
    if (parse(date) < parse(input.lease_start) || parse(date) >= parse(input.lease_end))
      return fail("posting_date_outside_lease", `${date} is not inside the lease term.`);
    const amount = money(value);
    return {
      ok: true, profile: p,
      lines: [{ date, kind: "rent_credit", amount, reason: "flat dated credit" }],
      total_credit: amount,
      effective_rent: input.base_rent == null || !termMonths ? null
        : money(Number(input.base_rent) - amount / termMonths),
    };
  }

  if (p === "fixed_monthly_discount") {
    const duration = Number(input.duration_months);
    if (!Number.isInteger(duration) || duration < 1)
      return fail("invalid_duration", "fixed_monthly_discount requires a whole number of months.");
    if (input.base_rent == null) return fail("missing_base_rent", "A monthly discount needs the rent it discounts.");
    if (value >= Number(input.base_rent))
      return fail("discount_exceeds_rent", `A $${value} monthly discount is not less than the $${input.base_rent} rent.`);
    if (termMonths && duration > termMonths)
      return fail("duration_exceeds_term", `${duration} discounted months do not fit in a ${termMonths}-month term.`);

    const start = firstFullMonthStart(input.lease_start);
    const lines = [];
    for (let i = 0; i < duration; i++) {
      const date = addMonths(start, i);
      if (parse(date) >= parse(input.lease_end))
        return fail("duration_exceeds_term", `Month ${i + 1} of the discount falls on ${date}, outside the lease.`);
      lines.push({ date, kind: "rent_credit", amount: money(value), reason: `fixed monthly discount ${i + 1}/${duration}` });
    }
    const total = money(value * duration);
    return {
      ok: true, profile: p, lines, total_credit: total,
      effective_rent: termMonths ? money(Number(input.base_rent) - total / termMonths) : null,
    };
  }

  // ── PROFILES REQUIRING AN EXPLICIT PRORATION BASIS ────────────────
  // Every one of these can land on a partial month, and there is no property
  // default: an undeclared basis is refused, not guessed.
  const needsProration = ["first_full_month", "third_full_month", "final_full_month", "free_rent_period"];
  if (needsProration.includes(p)) {
    const basis = input.proration_basis;
    if (!basis) {
      return fail("proration_basis_required",
        `${p} can land on a partial month. Declare a proration basis (${Object.keys(PRORATION_BASES).join(", ")}). ` +
        `On a 20-day February these differ by more than 10%, so a default would make the credit unreproducible.`);
    }
    if (!PRORATION_BASES[basis]) return fail("unknown_proration_basis", `${basis} is not a known basis.`);
    if (input.base_rent == null) return fail("missing_base_rent", "A free-rent style concession needs the rent it forgives.");
    const rent = Number(input.base_rent);

    if (p === "free_rent_period") {
      const from = input.free_from || input.lease_start;
      const to = input.free_until;
      if (!isYmd(from) || !isYmd(to)) return fail("missing_free_period", "State the free period start and end.");
      if (parse(from) < parse(input.lease_start) || parse(to) > parse(input.lease_end))
        return fail("free_period_outside_lease", `${from}..${to} is not inside the lease term.`);

      // Walk calendar months, crediting whole months in full and partial
      // months through the declared basis.
      const lines = [];
      let cursor = from;
      while (parse(cursor) < parse(to)) {
        const d = parse(cursor);
        const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
        const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
        const segEnd = parse(nextMonth) < parse(to) ? nextMonth : to;
        const dim = daysInMonth(cursor);
        const covered = Math.round((parse(segEnd) - parse(cursor)) / 86400000);
        const whole = covered >= dim;
        const amount = whole ? money(rent) : prorate(rent, covered, cursor, basis);
        if (amount > 0) {
          lines.push({ date: cursor, kind: "rent_credit", amount,
            reason: whole ? "free rent, whole month"
                          : `free rent, ${covered}/${basis === "thirty_day_month" ? 30 : dim} days (${basis})` });
        }
        cursor = nextMonth;
      }
      if (!lines.length) return fail("free_period_credits_nothing",
        `Under '${basis}' this period credits nothing. That is a real answer, not an error — but it is not a concession.`);
      const total = money(lines.reduce((s2, l) => s2 + l.amount, 0));
      return { ok: true, profile: p, proration_basis: basis, lines, total_credit: total,
               effective_rent: termMonths ? money(rent - total / termMonths) : null };
    }

    // first / third / final full month — one whole month's rent, on the
    // identified month. The basis matters because it decides which month
    // qualifies as "full" when the lease does not start on the 1st.
    const firstFull = firstFullMonthStart(input.lease_start);
    let date;
    if (p === "first_full_month") date = firstFull;
    else if (p === "third_full_month") date = addMonths(firstFull, 2);
    else {
      const end = parse(input.lease_end);
      const lastFull = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)).toISOString().slice(0, 10);
      date = lastFull;
    }
    if (parse(date) >= parse(input.lease_end) || parse(date) < parse(input.lease_start))
      return fail("target_month_outside_lease", `${date} is not inside the lease term.`);
    const amount = money(rent);
    return { ok: true, profile: p, proration_basis: basis,
             lines: [{ date, kind: "rent_credit", amount, reason: `${p.replace(/_/g, " ")} free` }],
             total_credit: amount,
             effective_rent: termMonths ? money(rent - amount / termMonths) : null };
  }

  // ── MONTHLY SCHEDULED CREDIT — needs an explicit schedule ─────────
  if (p === "monthly_scheduled_credit") {
    const src = input.schedule_source;
    if (!src || !SCHEDULE_SOURCES.includes(src)) {
      return fail("schedule_source_required",
        `monthly_scheduled_credit cannot be inferred from one total: $${value || "X"} does not say how many ` +
        `months, of what size, starting when. Supply schedule_source (${SCHEDULE_SOURCES.join(", ")}).`);
    }
    const sched = Array.isArray(input.schedule_lines) ? input.schedule_lines : [];
    if (!sched.length) return fail("schedule_lines_required", "An explicit schedule needs its dated amounts.");
    const lines = [];
    for (const l of sched) {
      if (!isYmd(l.date)) return fail("invalid_schedule_line_date", `${l.date} is not a date.`);
      const amt = Number(l.amount);
      if (!Number.isFinite(amt) || amt <= 0) return fail("invalid_schedule_line_amount", `${l.amount} is not an amount.`);
      if (parse(l.date) < parse(input.lease_start) || parse(l.date) >= parse(input.lease_end))
        return fail("schedule_line_outside_lease", `${l.date} is not inside the lease term.`);
      lines.push({ date: l.date, kind: "rent_credit", amount: money(amt),
                   reason: `scheduled credit (${src})` });
    }
    lines.sort((a, b) => (a.date < b.date ? -1 : 1));
    const total = money(lines.reduce((s2, l) => s2 + l.amount, 0));
    return { ok: true, profile: p, schedule_source: src, lines, total_credit: total,
             effective_rent: input.base_rent != null && termMonths
               ? money(Number(input.base_rent) - total / termMonths) : null };
  }

  return fail("unhandled_profile", p);
}

module.exports = { compileSchedule, PROFILES, IMPLEMENTED, firstFullMonthStart, addMonths,
                   PRORATION_BASES, SCHEDULE_SOURCES, prorate, daysInMonth };
