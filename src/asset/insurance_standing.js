/* ════════════════════════════════════════════════════════════════════
   insurance_standing.js — ARE WE INSURED, AND ARE WE IN GOOD STANDING?

   A PURE DERIVATION. No table, no writer, no stored state. It reads the
   coverages a property participates in and a date, and returns what is
   true. Nothing here is remembered, so nothing can go stale, and a later
   coverage changes the answer with no backfill.

   ── WHY THERE IS NO SCHEMA ──────────────────────────────────────────
   The operating question — "is the next term bound?" — is already
   answerable. A bound term IS a coverage with a later period, established
   through the ordinary evidence → confirm → write path, carrying its own
   documentary provenance. Recording "renewed: true" beside it would be a
   second, weaker copy of a fact the coverage already states, and the two
   would disagree the first time anyone corrected one.

   §18 killed a speculative index in this repo for the same reason: no
   query in the slice used that shape. A renewal_milestones table would be
   schema for a milestone that is a function of a date and today.

   ── THIS IS NOT THE LEASE RENEWAL RAIL ──────────────────────────────
   Migration 119 / src/leasing/renewal_lifecycle.js is RESIDENT lease
   renewal: renewal_cases, lease_offers, a resident deciding. Same English
   word, unrelated fact. Nothing here touches it and nothing here should
   ever be routed through it.

   ── NEVER HEALTHY FROM ABSENCE ──────────────────────────────────────
   The whole point. No coverage Spine can evidence is COVERAGE NOT
   CONFIRMED — never CURRENT, never blank, never quietly fine. An expiry
   with no bound successor is EXPIRED even if a renewal is, in reality,
   sitting in somebody's inbox. Spine reports what it can evidence.

   ── WHAT IS DELIBERATELY NOT A STATE ────────────────────────────────
   NEEDS ATTENTION. With nothing recording renewal progress it would mean
   only "approaching and not yet bound", which RENEWAL APPROACHING plus an
   unconfirmed successor already says — more precisely, and without
   implying Spine knows about work it has never been told about. Adding it
   is the first step toward the project-management board this is not.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

//  The operating milestones. Renewal work begins well before expiry, so
//  the bands are what an operator plans against — not a countdown.
const MILESTONES = Object.freeze([90, 60, 45, 30]);

const STATES = Object.freeze([
  "current",
  "renewal_approaching",
  "coverage_not_confirmed",
  "expired",
]);

function day(v) {
  if (!v) return null;
  const s = typeof v === "string" ? v.slice(0, 10) : null;
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

//  Whole days between two ISO dates, UTC, no timezone drift. Dates are
//  dates: a policy does not expire at a time of day in this model.
function daysBetween(fromISO, toISO) {
  const a = Date.UTC(+fromISO.slice(0, 4), +fromISO.slice(5, 7) - 1, +fromISO.slice(8, 10));
  const b = Date.UTC(+toISO.slice(0, 4), +toISO.slice(5, 7) - 1, +toISO.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/*  Which milestone window a number of days sits inside. Returns the
 *  TIGHTEST band crossed — 44 days out is inside the 45 window, not the
 *  60 one, because 45 is the more urgent thing that has already happened.
 */
function milestoneFor(days) {
  let hit = null;
  for (const m of MILESTONES) if (days <= m) hit = hit === null ? m : Math.min(hit, m);
  return hit;
}

/*  ── STANDING ───────────────────────────────────────────────────────
 *  coverages — as readParticipation returns them: every coverage this
 *              property is NAMED on, with its own period. Participation,
 *              not allocation: whether the share is known has nothing to
 *              do with whether the property is insured.
 *  asOf      — the date the question is being asked on.
 *
 *  Returns the state, why it is that, what would change it, and the
 *  milestone if one is live. The shape answers the Exposure contract:
 *  what it is about, why Spine cannot stand behind more, what resolves
 *  it, as of when.
 */
function standingOf({ coverages, asOf } = {}) {
  const today = day(asOf) || day(new Date());
  const rows = (Array.isArray(coverages) ? coverages : [])
    .map((c) => ({
      coverage_id: c.coverage_id,
      coverage_type: c.coverage_type,
      carrier_name: c.carrier_name || null,
      start: day(c.coverage_period_start),
      end: day(c.coverage_period_end),
      //  Evidence is what makes a coverage a claim Spine can stand behind
      //  rather than something somebody typed. It does not change whether
      //  the property is covered; it changes how well the answer is held up.
      evidenced: !!c.observed_in_artifact_id,
    }))
    .filter((c) => c.start && c.end);

  const base = { as_of: today, milestone: null, days_to_expiry: null,
                 in_force: [], next_expiry: null, bound_next_term: null };

  if (!rows.length) {
    return {
      ...base,
      state: "coverage_not_confirmed",
      why: "Spine holds no insurance coverage for this property.",
      resolved_by: "Add the current policy or binder.",
      evidenced: false,
    };
  }

  //  IN FORCE on the day asked about. Start inclusive, end exclusive —
  //  the same convention 161's period overlap uses, so a policy ending
  //  2027-03-01 and its successor starting the same day do not both count.
  const inForce = rows.filter((c) => c.start <= today && c.end > today);

  if (!inForce.length) {
    //  Nothing in force. Distinguish "it ran out" from "there has never
    //  been any" — an operator does very different things about each.
    const ended = rows.filter((c) => c.end <= today)
      .sort((a, b) => (a.end < b.end ? 1 : -1));
    const future = rows.filter((c) => c.start > today)
      .sort((a, b) => (a.start < b.start ? -1 : 1));

    if (ended.length) {
      const last = ended[0];
      //  A future term that has already been bound means cover resumes,
      //  and that is a materially different situation from a bare lapse.
      const gap = future.length ? future[0] : null;
      return {
        ...base,
        state: "expired",
        why: gap
          ? `Coverage ended ${last.end} and the next bound term does not start until ${gap.start}.`
          : `Coverage ended ${last.end} and Spine holds no bound term after it.`,
        resolved_by: gap
          ? "Confirm whether the property is covered between those dates."
          : "Add the renewal policy or binder once the next term is bound.",
        days_to_expiry: daysBetween(today, last.end),
        next_expiry: last.end,
        bound_next_term: gap ? { coverage_id: gap.coverage_id, starts: gap.start } : null,
        evidenced: last.evidenced,
      };
    }
    //  Only future coverage. Not expired — never started.
    return {
      ...base,
      state: "coverage_not_confirmed",
      why: `Spine holds no coverage in force on ${today}.`,
      resolved_by: "Add the policy or binder covering the current period.",
      bound_next_term: future.length
        ? { coverage_id: future[0].coverage_id, starts: future[0].start } : null,
      evidenced: false,
    };
  }

  //  The soonest thing to expire governs the standing. A property with
  //  Property to 2027 and GL to next month is not "current until 2027".
  const soonest = inForce.slice().sort((a, b) => (a.end < b.end ? -1 : 1))[0];
  const days = daysBetween(today, soonest.end);

  /*  IS THE NEXT TERM BOUND?
   *  A successor is a coverage OF THE SAME TYPE starting at or after this
   *  one ends. Same type matters: a bound GL policy does not renew the
   *  Property policy, and treating any later coverage as a successor is
   *  how a property comes to read CURRENT while its Property cover lapses.
   */
  const successor = rows
    .filter((c) => c.coverage_type === soonest.coverage_type
                && c.coverage_id !== soonest.coverage_id
                && c.start >= soonest.end)
    .sort((a, b) => (a.start < b.start ? -1 : 1))[0] || null;

  const shared = {
    ...base,
    days_to_expiry: days,
    next_expiry: soonest.end,
    in_force: inForce.map((c) => ({ coverage_id: c.coverage_id,
      coverage_type: c.coverage_type, carrier_name: c.carrier_name, ends: c.end })),
    bound_next_term: successor
      ? { coverage_id: successor.coverage_id, starts: successor.start }
      : null,
    evidenced: inForce.every((c) => c.evidenced),
  };

  if (successor) {
    //  Renewal already done. Nothing is approaching.
    return {
      ...shared,
      state: "current",
      why: `Covered to ${soonest.end}, with the next term bound from ${successor.start}.`,
      resolved_by: null,
    };
  }

  const milestone = milestoneFor(days);
  if (milestone === null) {
    return {
      ...shared,
      state: "current",
      why: `Covered to ${soonest.end}.`,
      resolved_by: null,
    };
  }

  return {
    ...shared,
    state: "renewal_approaching",
    milestone,
    why: `Coverage ends ${soonest.end} — ${days} day${days === 1 ? "" : "s"} away, ` +
         `inside the ${milestone}-day window, and Spine holds no bound term after it.`,
    //  What resolves it is EVIDENCE, not activity. A quote is not cover
    //  and an intention to bind is not a binder.
    resolved_by: "Add the renewal policy or binder once the next term is bound. " +
                 "A quote or an intention to bind is not coverage.",
  };
}

module.exports = { standingOf, MILESTONES, STATES, milestoneFor, daysBetween };
