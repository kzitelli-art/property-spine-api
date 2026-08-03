// ════════════════════════════════════════════════════════════════════
//  tour_demand.js — Slice 9, step 3.
//
//  Tour demand is the strongest evidence source in the product, and the one
//  most easily overstated. Migration 039's doctrine is the law here:
//
//      A scheduled tour is a CLAIM.  A completed tour is PROOF.
//      A no_show is EXPOSURE.        A cancellation is a LOST APPOINTMENT.
//      A reschedule is the SAME journey continuing.
//
//  ── THE JOURNEY, NOT THE ROW ─────────────────────────────────────────
//  leasing_tours.rescheduled_from makes reschedules a real chain. Counting
//  rows would report a prospect who moved their appointment twice as three
//  tours' worth of demand. One root chain = one appointment journey; booking
//  attempts are reported separately because they are a genuine operational
//  signal, just not a demand signal.
//
//  ── AMBIGUOUS CHAINS ARE UNTRACKABLE, NOT GUESSED ────────────────────
//  A cycle, a parent pointing outside the property, or a row whose parent is
//  missing cannot be resolved to one root. The ruling forbids silently
//  choosing a row, so those journeys are counted as untrackable and excluded
//  from rates — visibly, with a count.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { buildMetric } = require("./metric_contract");

// Walk each tour to its chain root. Returns { rootById, untrackable:Set }.
// Iterative with a visited set — a cyclic chain must not spin forever, and
// "we could not resolve this" is a reportable answer.
function resolveChains(rows) {
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const rootById = new Map();
  const untrackable = new Set();

  for (const row of rows) {
    const id = String(row.id);
    if (rootById.has(id) || untrackable.has(id)) continue;

    const path = [];
    const seen = new Set();
    let cur = row;
    let root = null;

    while (cur) {
      const curId = String(cur.id);
      if (seen.has(curId)) { root = null; break; }          // cycle
      seen.add(curId); path.push(curId);
      if (rootById.has(curId)) { root = rootById.get(curId); break; }
      const parentId = cur.rescheduled_from ? String(cur.rescheduled_from) : null;
      if (!parentId) { root = curId; break; }               // chain head
      const parent = byId.get(parentId);
      if (!parent) { root = null; break; }                  // parent outside the set
      cur = parent;
    }

    if (root) for (const p of path) rootById.set(p, root);
    else for (const p of path) untrackable.add(p);
  }
  return { rootById, untrackable };
}

const TERMINAL_RANK = { completed: 5, no_show: 4, cancelled: 3, checked_in: 2, confirmed_by_prospect: 1, scheduled: 0, requested: 0 };

// One journey's final status is the strongest outcome any leg reached: a
// journey that was rescheduled twice and then completed IS completed.
function journeyFinalStatus(legs) {
  let best = null, bestRank = -1;
  for (const l of legs) {
    const r = TERMINAL_RANK[l.status] == null ? -1 : TERMINAL_RANK[l.status];
    if (r > bestRank) { bestRank = r; best = l.status; }
  }
  return best;
}

async function tourDemand(pool, window) {
  if (!window || window.state !== "ok") {
    return {
      state: "unavailable",
      reason: window ? window.reason : "operating_window_unresolved",
      metrics: {
        appointment_journeys: buildMetric({ metric_code: "s9.tour_demand.appointment_journeys.v1", window }),
        outcome_capture: buildMetric({ metric_code: "s9.tour_demand.outcome_capture_completeness.v1", window }),
      },
      counts: null,
    };
  }

  // Every tour for the property — the whole set, so a chain whose root sits
  // before the window still resolves. Window filtering happens on the ROOT's
  // first booking, after chains are assembled.
  const rows = (await pool.query(
    `select t.id, t.lead_id, t.status, t.rescheduled_from,
            t.created_at, t.scheduled_for, t.completed_at, t.no_show_at, t.cancelled_at,
            exists(select 1 from tour_outcome_prompts p
                    where p.tour_id = t.id and p.responded_at is not null) as outcome_captured
       from leasing_tours t
      where t.property_id = $1`,
    [window.property_id]
  )).rows;

  const { rootById, untrackable } = resolveChains(rows);

  const legsByRoot = new Map();
  for (const r of rows) {
    const id = String(r.id);
    if (untrackable.has(id)) continue;
    const root = rootById.get(id);
    if (!legsByRoot.has(root)) legsByRoot.set(root, []);
    legsByRoot.get(root).push(r);
  }

  const startUtc = new Date(window.window_start_utc).getTime();
  const endUtc = new Date(window.window_end_utc).getTime();
  const asOf = new Date(window.as_of_utc).getTime();
  const inWindow = (d) => { const t = d ? new Date(d).getTime() : null; return t != null && t >= startUtc && t < endUtc; };

  const journeys = [];
  for (const [root, legs] of legsByRoot) {
    legs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const first = legs[0];
    journeys.push({
      root,
      lead_id: first.lead_id,
      booking_attempts: legs.length,
      reschedule_count: legs.length - 1,
      final_status: journeyFinalStatus(legs),
      opened_at: first.created_at,
      completed_at: legs.map((l) => l.completed_at).filter(Boolean).sort()[0] || null,
      outcome_captured: legs.some((l) => l.outcome_captured),
    });
  }

  // Origin cohort: journeys whose FIRST booking falls inside the window.
  const cohort = journeys.filter((j) => inWindow(j.opened_at));
  const completed = cohort.filter((j) => j.final_status === "completed"
    && j.completed_at && new Date(j.completed_at).getTime() <= asOf);

  const counts = {
    appointment_journeys: cohort.length,
    booking_attempts: cohort.reduce((n, j) => n + j.booking_attempts, 0),
    reschedule_count: cohort.reduce((n, j) => n + j.reschedule_count, 0),
    scheduled: cohort.filter((j) => j.final_status === "scheduled" || j.final_status === "requested").length,
    confirmed: cohort.filter((j) => j.final_status === "confirmed_by_prospect").length,
    checked_in: cohort.filter((j) => j.final_status === "checked_in").length,
    completed: completed.length,
    no_show: cohort.filter((j) => j.final_status === "no_show").length,
    cancelled: cohort.filter((j) => j.final_status === "cancelled").length,
    outcome_captured: completed.filter((j) => j.outcome_captured).length,
    outcome_unknown: completed.filter((j) => !j.outcome_captured).length,
    untrackable_chains: untrackable.size,
  };

  return {
    state: "ok",
    counts,
    metrics: {
      // A count-only metric: journeys are the denominator of demand, not a rate.
      appointment_journeys: buildMetric({
        metric_code: "s9.tour_demand.appointment_journeys.v1",
        window, numerator: null, denominator: cohort.length,
        counts: { untrackable: untrackable.size },
        exclusions: [
          "journeys whose first booking falls outside the window",
          "chains that are cyclic, broken, or resolve to no single root",
        ],
        provenance: "leasing_tours, reschedule chains collapsed on rescheduled_from",
        extra: {
          booking_attempts: counts.booking_attempts,
          reschedule_count: counts.reschedule_count,
          final_status_breakdown: {
            scheduled: counts.scheduled, confirmed: counts.confirmed,
            checked_in: counts.checked_in, completed: counts.completed,
            no_show: counts.no_show, cancelled: counts.cancelled,
          },
        },
      }),
      // Completeness, NOT a conversion. A completed tour with no captured
      // outcome stays in the denominator — excluding it would flatter every
      // funnel downstream.
      outcome_capture: buildMetric({
        metric_code: "s9.tour_demand.outcome_capture_completeness.v1",
        window, numerator: counts.outcome_captured, denominator: completed.length,
        counts: { unknown: counts.outcome_unknown, untrackable: untrackable.size },
        exclusions: ["journeys that did not reach completed"],
        provenance: "tour_outcome_prompts.responded_at on any leg of the journey",
      }),
    },
  };
}

module.exports = { tourDemand, resolveChains, journeyFinalStatus };
