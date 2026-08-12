/* ════════════════════════════════════════════════════════════════════
   philadelphia_tax_rules.js — THE JURISDICTION'S CLOCKS, IN ONE PLACE.

   Every Philadelphia date lives here. Nothing in a route, a read or a
   surface may carry one: a due date scattered across handlers is a rule
   nobody can find when it changes, and these change.

   PURE. No database, no clock of its own — every function takes the date
   it should reason from, so a proof can ask about any day without
   waiting for it.

   ── FOUR OBLIGATIONS. NOT ONE RHYTHM. ───────────────────────────────
       real_estate   PROPERTY subject · annual · due Mar 31
       birt          ENTITY subject   · annual return Apr 15,
                                        estimated payments distinct
       npt           ENTITY subject   · annual return Apr 15,
                                        estimates Apr 15 and Jun 15
       uo            PROPERTY subject · monthly, due the 25th

   Commercial Trash is deliberately absent. It is a municipal fee with
   its own exemption machinery, not one of these four.

   ── EFFECTIVE-DATED WHERE THE WORLD MOVED ───────────────────────────
   U&O's $2,000 annual exemption ENDED 2026-01-01. The TAX did not — it
   remains active and monthly. That distinction matters enough to encode:
   a reader who assumes U&O lapsed will under-report a live obligation,
   and this module answers the question rather than leaving it to memory.

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
 *  Returns every dated milestone this obligation carries for its period.
 *  A filing due date and a payment due date are SEPARATE milestones even
 *  when they fall on the same day, because they are satisfied by
 *  different evidence — a filed return does not pay a balance.
 */
function milestonesFor(tax_type, period_start) {
  const P = parts(period_start);
  if (!P || !TAX_TYPES.includes(tax_type)) return [];

  switch (tax_type) {
    //  Philadelphia Real Estate Tax is annual, due March 31 of the tax
    //  year. Billed by the City — nothing is filed.
    case "real_estate":
      return [{ kind: "payment", due: ymd(P.y, 3, 31), label: "Annual payment" }];

    //  BIRT: annual return due April 15 of the FOLLOWING year. Estimated
    //  payment mechanics are separate from the return and are recorded as
    //  their own filings when evidenced.
    case "birt":
      return [
        { kind: "filing", due: ymd(P.y + 1, 4, 15), label: "Annual return" },
        { kind: "payment", due: ymd(P.y + 1, 4, 15), label: "Balance due" },
      ];

    //  NPT: annual return April 15 of the following year, with estimated
    //  payments April 15 and June 15.
    case "npt":
      return [
        { kind: "filing", due: ymd(P.y + 1, 4, 15), label: "Annual return" },
        { kind: "payment", due: ymd(P.y + 1, 4, 15), label: "First estimate" },
        { kind: "payment", due: ymd(P.y + 1, 6, 15), label: "Second estimate" },
      ];

    //  U&O: due the 25th of the month FOLLOWING the period.
    case "uo": {
      const y = P.m === 12 ? P.y + 1 : P.y;
      const m = P.m === 12 ? 1 : P.m + 1;
      return [
        { kind: "filing", due: ymd(y, m, 25), label: "Monthly filing" },
        { kind: "payment", due: ymd(y, m, 25), label: "Monthly payment" },
      ];
    }
    default: return [];
  }
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
              "remains active and is filed monthly." }
    : { annual_exemption_available: true, ends_on: UO_EXEMPTION_ENDED_ON,
        note: "The $2,000 annual U&O exemption applies for this period." };
}

/*  ── WHAT THIS JURISDICTION REQUIRES A PROPERTY TO ANSWER ───────────
 *  The four types whose applicability must be established before Spine
 *  may call a property's tax position CURRENT. An unanswered one is not
 *  a gap in the screen; it is the reason the headline cannot be current.
 */
function requiredTaxTypes() { return TAX_TYPES.slice(); }

module.exports = {
  JURISDICTION, TAX_TYPES, TAX_LABEL, SUBJECT_KIND, CADENCE, REQUIRES_FILING,
  UO_EXEMPTION_ENDED_ON,
  periodFor, milestonesFor, nextMilestone, uoExemptionStatus, requiredTaxTypes,
  daysBetween,
};
