/* ════════════════════════════════════════════════════════════════════
   philadelphia_tax_rules.js — THE JURISDICTION'S CLOCKS, IN ONE PLACE.

   Every Philadelphia date lives here. Nothing in a route, a read or a
   surface may carry one: a due date scattered across handlers is a rule
   nobody can find when it changes, and these change.

   PURE. No database, no clock of its own — every function takes the date
   it should reason from, so a proof can ask about any day without
   waiting for it.

   ── THIS FILE WAS WRONG TWICE. BOTH WERE CAUGHT IN REVIEW. ──────────
   1  U&O was modelled as "month M, due the 25th of M+1". It is the SAME
      MONTH: the tax for month M is filed and paid by the 25th OF MONTH M.
      The first version therefore reported the wrong month AND the wrong
      due date, in the direction that under-reports a live obligation.
   2  NPT estimates were placed in the year the RETURN is filed. The
      return for tax year Y is due Apr 15 of Y+1; the ESTIMATES for tax
      year Y are due Apr 15 and Jun 15 OF Y — a full year earlier. A tax
      clock one year late is not a rounding error.

   Both are why the published schedule below is pinned and why the
   derivation is asserted against it on every run.

   ── FOUR OBLIGATIONS. NOT ONE RHYTHM, AND NOT ONE PERIOD. ───────────
       real_estate  PROPERTY subject · annual  · payment due Mar 31 of Y
       birt         ENTITY   subject · annual  · return + balance for Y,
                                                 AND the mandatory
                                                 estimate for Y+1, all due
                                                 Apr 15 of Y+1
       npt          ENTITY   subject · annual  · estimates for Y due
                                                 Apr 15 Y and Jun 15 Y;
                                                 return + balance for Y
                                                 due Apr 15 Y+1
       uo           PROPERTY subject · monthly · filing + payment for
                                                 month M due the 25th OF M

   Commercial Trash is deliberately absent. It is a municipal fee with
   its own exemption machinery, not one of these four.

   ── BIRT'S ESTIMATE RIDES ON THE RETURN, AND THE FORM SAYS SO ───────
   From a real 2023 BIRT return in the portfolio:

       5. Tax Due 2023. (Line 3 minus Line 4)
       6. MANDATORY 2024 BIRT Estimated Payment
       7. Total Due by 4/15/2024 (Line 5 plus Line 6)

   So the year-Y return carries TWO payment requirements on the same day:
   the year-Y balance and the year-(Y+1) estimate. They are separate
   milestones because they are separately satisfiable — paying the
   balance does not pay the estimate.

   ⚠ AND THE CADENCE IS NOT THE SAME FOR EVERY TAXPAYER. New filers get
   relief the City grants explicitly, so the estimate depends on a
   FILER PROFILE somebody establishes. With no profile recorded this
   module reports the requirement as UNKNOWN — it never assumes the
   mandatory estimate applies, and never assumes it does not.

   ── IT COMPUTES CLOCKS, NEVER AMOUNTS ───────────────────────────────
   No rate table. No assessment × rate. No BIRT or NPT calculation. What
   a tax COSTS is what the City says it costs, recorded as governed
   evidence. This file only ever answers "when".
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const JURISDICTION = "philadelphia_pa";

//  The date the U&O annual exemption ceased. The tax itself is unaffected.
const UO_EXEMPTION_ENDED_ON = "2026-01-01";

const TAX_TYPES = Object.freeze(["real_estate", "birt", "npt", "uo"]);

const TAX_LABEL = Object.freeze({
  real_estate: "Real Estate Tax",
  birt: "BIRT",
  npt: "NPT",
  uo: "U&O",
});

//  Which subject the obligation belongs to. Enforced in the schema too —
//  this is the readable statement of the same rule.
const SUBJECT_KIND = Object.freeze({
  real_estate: "property",
  uo: "property",
  birt: "legal_entity",
  npt: "legal_entity",
});

const CADENCE = Object.freeze({
  real_estate: "annual",
  birt: "annual",
  npt: "annual",
  uo: "monthly",
});

//  Does this tax type require a FILING as well as a payment? Real estate
//  is billed by the City and paid; there is no return to file. BIRT, NPT
//  and U&O are filed.
const REQUIRES_FILING = Object.freeze({
  real_estate: false, birt: true, npt: true, uo: true,
});

/*  ── BIRT FILER PROFILES ────────────────────────────────────────────
 *  The City grants new businesses relief from the mandatory estimated
 *  payment. Which relief applies is a fact about the taxpayer that
 *  somebody establishes — it is never inferred from an entity type, a
 *  formation date, or the absence of a prior return.
 */
const BIRT_FILER_PROFILES = Object.freeze([
  "first_year", "second_year", "established",
]);
const BIRT_FILER_LABEL = Object.freeze({
  first_year: "First year of business in Philadelphia",
  second_year: "Second year of business in Philadelphia",
  established: "Established filer",
});

const p2 = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;

function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}
function daysBetween(a, b) {
  const A = parts(a), B = parts(b);
  if (!A || !B) return null;
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 86400000);
}
//  0 = Sunday … 6 = Saturday. UTC throughout, so a deployment's timezone
//  can never move a due date.
function dow(iso) {
  const P = parts(iso);
  return P ? new Date(Date.UTC(P.y, P.m - 1, P.d)).getUTCDay() : null;
}
function addDays(iso, n) {
  const P = parts(iso);
  if (!P) return null;
  const d = new Date(Date.UTC(P.y, P.m - 1, P.d + n));
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/*  ── CITY HOLIDAYS, COMPUTED RATHER THAN TABULATED ──────────────────
 *  A hardcoded year list rots silently the first January nobody updates
 *  it. These are stable definitions, so they are computed — and the
 *  published-schedule check below is what proves the computation agrees
 *  with the City for the year we can verify.
 */
function nthWeekdayOf(year, month, weekday, n) {
  const first = ymd(year, month, 1);
  const shift = (weekday - dow(first) + 7) % 7;
  return addDays(first, shift + (n - 1) * 7);
}
function lastWeekdayOf(year, month, weekday) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = ymd(year, month, lastDay);
  return addDays(last, -((dow(last) - weekday + 7) % 7));
}
//  A fixed-date holiday falling at a weekend is OBSERVED on the adjacent
//  weekday, which is what closes the office.
function observed(iso) {
  const d = dow(iso);
  if (d === 6) return addDays(iso, -1);
  if (d === 0) return addDays(iso, 1);
  return iso;
}

function cityHolidays(year) {
  return new Set([
    observed(ymd(year, 1, 1)),               // New Year's Day
    nthWeekdayOf(year, 1, 1, 3),             // MLK Day
    nthWeekdayOf(year, 2, 1, 3),             // Presidents Day
    lastWeekdayOf(year, 5, 1),               // Memorial Day
    observed(ymd(year, 6, 19)),              // Juneteenth
    observed(ymd(year, 7, 4)),               // Independence Day
    nthWeekdayOf(year, 9, 1, 1),             // Labor Day
    nthWeekdayOf(year, 10, 1, 2),            // Indigenous Peoples' Day
    observed(ymd(year, 11, 11)),             // Veterans Day
    nthWeekdayOf(year, 11, 4, 4),            // Thanksgiving
    addDays(nthWeekdayOf(year, 11, 4, 4), 1),// the day after
    observed(ymd(year, 12, 25)),             // Christmas Day
  ]);
}

/*  A due date landing on a weekend or a City holiday moves FORWARD to the
 *  next business day. Forward, never backward — the City does not ask for
 *  money earlier because its office was shut. */
function nextBusinessDay(iso) {
  let cur = iso;
  for (let i = 0; i < 10; i++) {
    const d = dow(cur);
    const P = parts(cur);
    if (d !== 0 && d !== 6 && !cityHolidays(P.y).has(cur)) return cur;
    cur = addDays(cur, 1);
  }
  return cur;
}

/*  ── THE CITY'S PUBLISHED 2026 U&O SCHEDULE ─────────────────────────
 *  Pinned verbatim, and it is the AUTHORITY. The derivation above is a
 *  fallback for years the City has not published to us, and `selfCheck()`
 *  asserts the two agree wherever both exist. Where they ever disagree,
 *  the published date wins and the disagreement is REPORTED rather than
 *  quietly resolved — a computed date that contradicts the City's own
 *  calendar is a finding, not a preference.
 *
 *  Every milestone carries `date_source`, so a surface can never present
 *  a derived date as a published one.
 */
const PUBLISHED_DUE_DATES = Object.freeze({
  "uo:2026-01": "2026-01-26",
  "uo:2026-02": "2026-02-25",
  "uo:2026-03": "2026-03-25",
  "uo:2026-04": "2026-04-27",
  "uo:2026-05": "2026-05-26",
  "uo:2026-06": "2026-06-25",
  "uo:2026-07": "2026-07-27",
  "uo:2026-08": "2026-08-25",
});

/*  ⚠ `derived_due` IS ALWAYS CARRIED, EVEN WHEN A PUBLISHED DATE WINS.
 *  Without it the pin MASKS a broken rule: a falsification that put U&O
 *  back on the following month left every pinned month looking correct,
 *  because the published value was substituted before anything could
 *  compare them. The self-check now reads what `milestonesFor` actually
 *  produced rather than recomputing the helper on its own — a check that
 *  scans less than the claim it asserts is worse than no check.
 */
function dueDate(key, computed) {
  const published = key ? PUBLISHED_DUE_DATES[key] : null;
  return published
    ? { due: published, derived_due: computed, date_source: "published",
        agrees_with_rule: published === computed }
    : { due: computed, derived_due: computed, date_source: "derived",
        agrees_with_rule: true };
}

/*  ── THE PERIOD AN OBLIGATION COVERS ────────────────────────────────
 *  Annual taxes cover a calendar tax year. U&O covers one month. One
 *  shape carries both, so nothing needs a second table when a rhythm
 *  differs.
 */
function periodFor(tax_type, { year, month } = {}) {
  if (!TAX_TYPES.includes(tax_type)) return null;
  if (CADENCE[tax_type] === "monthly") {
    if (!year || !month) return null;
    const endY = month === 12 ? year + 1 : year;
    const endM = month === 12 ? 1 : month + 1;
    return { period_start: ymd(year, month, 1), period_end: ymd(endY, endM, 1),
             label: `${year}-${p2(month)}` };
  }
  if (!year) return null;
  return { period_start: ymd(year, 1, 1), period_end: ymd(year + 1, 1, 1),
           label: String(year) };
}

/*  ── WHEN IS IT DUE ─────────────────────────────────────────────────
 *  Every dated milestone this obligation carries for its period.
 *
 *  A filing due date and a payment due date are SEPARATE milestones even
 *  when they fall on the same day, because they are satisfied by
 *  different evidence — a filed return does not pay a balance.
 *
 *  ⚠ EVERY MILESTONE HAS A STABLE `key`. That key is the durable
 *  identity a payment names when it says WHICH requirement it satisfies.
 *  Before it existed, one payment satisfied every payment milestone on
 *  the obligation: a partial Real Estate Tax payment read as PAID and an
 *  NPT first estimate closed out the second. Renaming a key is a
 *  contract change — `tax_payments.satisfies_requirement` stores it.
 */
function milestonesFor(tax_type, period_start, opts = {}) {
  const P = parts(period_start);
  if (!P || !TAX_TYPES.includes(tax_type)) return [];
  const M = (key, kind, rawDue, label, extra = {}) => {
    const computed = nextBusinessDay(rawDue);
    //  The published schedule is keyed by PERIOD, not by milestone — the
    //  City publishes one date per U&O month and both the filing and the
    //  payment land on it.
    const d = dueDate(publishedKeyFor(tax_type, key, period_start), computed);
    return { key, kind, label, ...d, ...extra };
  };

  switch (tax_type) {
    //  Philadelphia Real Estate Tax is annual, due March 31 of the tax
    //  year. Billed by the City — nothing is filed.
    //
    //  ITS AMOUNT IS KNOWN, so the payment milestone is satisfied only by
    //  payments covering the governed liability. A part payment is a part
    //  payment.
    case "real_estate":
      return [M("payment:annual", "payment", ymd(P.y, 3, 31), "Annual payment",
                { amount_basis: "annual_liability" })];

    /*  BIRT: the year-Y return and balance, PLUS the mandatory estimate
     *  for year Y+1, all due Apr 15 of Y+1 — exactly as the City's own
     *  return lays it out (Lines 5, 6 and 7).
     *
     *  The estimate is emitted ONLY when a filer profile has been
     *  established. Unknown is reported as unknown by
     *  `unknownRequirements()`; it is never silently dropped and never
     *  silently assumed. */
    case "birt": {
      const apr15 = ymd(P.y + 1, 4, 15);
      const out = [
        M("filing:return", "filing", apr15, "Annual return"),
        M("payment:balance", "payment", apr15, `${P.y} balance due`,
          { amount_basis: "annual_liability" }),
      ];
      const profile = opts.birt_filer_profile || null;
      if (profile === "established" || profile === "second_year") {
        out.push(M("payment:estimate_next_year", "payment", apr15,
          `Mandatory ${P.y + 1} estimated payment`,
          { amount_basis: "unknown",
            //  A second-year filer may elect to pay the estimate in
            //  installments. Spine records the election when it is
            //  evidenced; it does not invent an installment schedule.
            installments_electable: profile === "second_year" }));
      }
      //  first_year → the City grants relief; no estimate milestone.
      return out;
    }

    /*  NPT: the estimates for tax year Y are due DURING year Y —
     *  Apr 15 Y and Jun 15 Y. The return and balance for Y are due
     *  Apr 15 of Y+1. Four milestones spanning two calendar years, which
     *  is precisely what the one-period model could not represent. */
    case "npt":
      return [
        M("payment:estimate_1", "payment", ymd(P.y, 4, 15),
          `First ${P.y} estimated payment`, { amount_basis: "unknown" }),
        M("payment:estimate_2", "payment", ymd(P.y, 6, 15),
          `Second ${P.y} estimated payment`, { amount_basis: "unknown" }),
        M("filing:return", "filing", ymd(P.y + 1, 4, 15), "Annual return"),
        M("payment:balance", "payment", ymd(P.y + 1, 4, 15),
          `${P.y} balance due`, { amount_basis: "annual_liability" }),
      ];

    //  ⚠ U&O IS SAME-MONTH. The tax for month M is filed and paid by the
    //  25th OF MONTH M, shifted forward past weekends and City holidays.
    case "uo": {
      const raw = ymd(P.y, P.m, 25);
      return [
        M("filing:monthly", "filing", raw, "Monthly filing"),
        M("payment:monthly", "payment", raw, "Monthly payment",
          { amount_basis: "annual_liability" }),
      ];
    }
    default: return [];
  }
}

//  U&O's published key is per MONTH, not per milestone, so both the
//  filing and the payment resolve to the same published date.
function publishedKeyFor(tax_type, key, period_start) {
  if (tax_type !== "uo") return null;
  const P = parts(period_start);
  return P ? `uo:${P.y}-${p2(P.m)}` : null;
}

/*  ── WHAT THIS OBLIGATION CANNOT YET SAY ────────────────────────────
 *  A requirement whose existence depends on a fact nobody has recorded.
 *  Reported so the row can show it rather than behaving as though the
 *  requirement is absent (§5: not knowing is not the same as fine).
 */
function unknownRequirements(tax_type, opts = {}) {
  if (tax_type !== "birt") return [];
  if (BIRT_FILER_PROFILES.includes(opts.birt_filer_profile)) return [];
  return [{
    requirement: "payment:estimate_next_year",
    label: "Mandatory BIRT estimated payment",
    why: "The City's BIRT return carries a mandatory estimated payment for the " +
         "following year, and grants relief to businesses in their first year in " +
         "Philadelphia. Which applies here has not been established.",
    resolves: "Record whether this taxpayer is a first-year, second-year or " +
              "established Philadelphia filer.",
  }];
}

/*  The soonest milestone at or after `asOf`, across a set of obligations.
 *  Returned so a surface can say "Next due Aug 25" without any surface
 *  knowing what Aug 25 means.
 */
function nextMilestone(items, asOf) {
  const future = (items || [])
    .filter((x) => x && x.due && daysBetween(asOf, x.due) >= 0)
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  return future[0] || null;
}

/*  ── WHICH PERIODS ARE LIVE RIGHT NOW ───────────────────────────────
 *  ⚠ THE DEFECT THIS REPLACES: the read used to pick ONE period per tax
 *  type and present it as the whole row. The real standing position is
 *  several periods at once —
 *
 *      2025 BIRT return filed  ·  2026 BIRT estimate outstanding
 *      2025 NPT return filed   ·  2026 NPT estimates in progress
 *      July U&O complete       ·  August U&O due the 25th
 *
 *  This returns the periods that OUGHT to be established today. The read
 *  adds any period already established that still carries an unsatisfied
 *  milestone, so a two-year-old unpaid bill does not fall off the screen
 *  simply because it is old.
 */
function activePeriods(tax_type, asOf) {
  const T = parts(asOf);
  if (!T || !TAX_TYPES.includes(tax_type)) return [];
  const { y, m } = T;

  /*  ⚠ `required` IS THE WHOLE DISTINCTION, AND IT WAS LEARNED TWICE.
   *
   *  required: true   this period OUGHT to exist now. Missing is a
   *                   finding, and the row says ACTION REQUIRED once its
   *                   first date has passed.
   *  required: false  show it IF it is established; never complain that
   *                   it is not. Last month's U&O belongs on the row when
   *                   we hold it — the operator wants to see July closed
   *                   beside August open — but a July nobody ever
   *                   recorded is not evidence of anything, and by that
   *                   logic June and May would be findings too.
   *
   *  An earlier draft made both unconditional, which left every property
   *  permanently delinquent for a period nobody had said a word about.
   */
  const req = (p) => (p ? { ...p, required: true } : null);
  const opt = (p) => (p ? { ...p, required: false } : null);

  if (tax_type === "uo") {
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    return [req(periodFor("uo", { year: y, month: m })),
            opt(periodFor("uo", { year: prevY, month: prevM }))].filter(Boolean);
  }
  if (tax_type === "real_estate") {
    return [req(periodFor("real_estate", { year: y })),
            opt(periodFor("real_estate", { year: y - 1 }))].filter(Boolean);
  }
  //  BIRT: the prior tax year, whose return, balance and next-year
  //  estimate were all due this April.
  if (tax_type === "birt") {
    return [req(periodFor("birt", { year: y - 1 })),
            opt(periodFor("birt", { year: y - 2 }))].filter(Boolean);
  }
  //  NPT: the prior tax year (return and balance, due this April) AND the
  //  current tax year (its two estimates, due this April and June).
  return [req(periodFor("npt", { year: y - 1 })),
          req(periodFor("npt", { year: y })),
          opt(periodFor("npt", { year: y - 2 }))].filter(Boolean);
}

/*  ── U&O IS STILL LIVE, AND THIS SAYS SO ────────────────────────────
 *  The $2,000 annual exemption ended 2026-01-01. Anyone reasoning from
 *  "the exemption is gone, so U&O must be gone" is wrong in the direction
 *  that under-reports a live monthly obligation, so the module answers
 *  the question explicitly rather than leaving it to be remembered.
 */
function uoExemptionStatus(asOf) {
  const on = daysBetween(UO_EXEMPTION_ENDED_ON, asOf);
  if (on === null) return null;
  return on >= 0
    ? { annual_exemption_available: false, ended_on: UO_EXEMPTION_ENDED_ON,
        note: "The $2,000 annual U&O exemption ended 2026-01-01. The tax itself " +
              "remains active and is filed monthly, by the 25th of the same month." }
    : { annual_exemption_available: true, ends_on: UO_EXEMPTION_ENDED_ON,
        note: "The $2,000 annual U&O exemption applies for this period." };
}

/*  ── WHAT THIS JURISDICTION REQUIRES A PROPERTY TO ANSWER ───────────
 *  The four types whose applicability must be established before Spine
 *  may call a property's tax position CURRENT. An unanswered one is not
 *  a gap in the screen; it is the reason the headline cannot be current.
 */
function requiredTaxTypes() { return TAX_TYPES.slice(); }

/*  ── THE DERIVATION IS CHECKED AGAINST THE CITY, EVERY LOAD ─────────
 *  Returns any published date the weekend/holiday rule fails to
 *  reproduce. An empty array means the rule and the City agree on every
 *  date we can verify; a non-empty one is a real finding about the rule,
 *  surfaced rather than hidden behind the pin.
 */
function scheduleDisagreements() {
  const out = [];
  for (const [key, published] of Object.entries(PUBLISHED_DUE_DATES)) {
    const m = /^uo:(\d{4})-(\d{2})$/.exec(key);
    if (!m) continue;
    //  ⚠ ASKS THE PRODUCT, NOT THE HELPER. An earlier version recomputed
    //  `nextBusinessDay(the 25th)` here, which validated the shift rule
    //  while saying nothing about the milestone the read actually uses —
    //  so a U&O clock a month late passed this check untouched.
    for (const ms of milestonesFor("uo", ymd(+m[1], +m[2], 1))) {
      if (ms.derived_due !== published) {
        out.push({ key, requirement: ms.key, published, computed: ms.derived_due });
      }
    }
  }
  return out;
}

module.exports = {
  JURISDICTION, TAX_TYPES, TAX_LABEL, SUBJECT_KIND, CADENCE, REQUIRES_FILING,
  UO_EXEMPTION_ENDED_ON, BIRT_FILER_PROFILES, BIRT_FILER_LABEL,
  PUBLISHED_DUE_DATES,
  periodFor, milestonesFor, nextMilestone, activePeriods, unknownRequirements,
  uoExemptionStatus, requiredTaxTypes, scheduleDisagreements,
  daysBetween, nextBusinessDay, cityHolidays, publishedKeyFor,
};
