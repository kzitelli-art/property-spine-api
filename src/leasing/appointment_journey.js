// ════════════════════════════════════════════════════════════════════
//  appointment_journey.js — WHAT HAPPENED ACROSS THE APPOINTMENTS OF ONE
//  LEASING OPPORTUNITY.
//
//  A PURE READ. Writes nothing, mounts nothing, creates no status, no metric,
//  no ranking, no scheduling behaviour. It COMPOSES existing truth so Funnel 2
//  can be re-grained without reconstructing meaning from browser state or
//  private status lists.
//
//  ── THE GRAIN ────────────────────────────────────────────────────────
//      opportunity  (leasing_conversions.id — the durable UUID)
//        └─ appointment chain        (one continuous attempt)
//             └─ appointment occurrence  (leasing_tours.id | scheduled_tours revision)
//
//  A reschedule chain is ONE attempt continuing. A separately booked tour is
//  ANOTHER chain inside the same opportunity. They never collapse.
//
//  ── THE TWO MODELS RESCHEDULE IN OPPOSITE WAYS ───────────────────────
//  native   leasing_tours INSERTS A NEW ROW per move (rescheduled_from chain),
//           so every occurrence is its own row.
//  external scheduled_tours MUTATES THE SAME ROW, keeping only the immediately
//           previous start. Intermediate occurrences exist ONLY in
//           scheduled_tour_revisions — reading the row alone silently loses
//           every reschedule before the last. This file reads the revision log.
//
//  ── WHAT IT REFUSES TO DO ────────────────────────────────────────────
//  · infer attribution from lead, person, property, time or conversation
//  · infer attendance from elapsed time — a past scheduled date with no
//    observation is UNKNOWN, never no_show
//  · collapse separately booked tours into one chain
//  · treat the flattened leasing_conversions fields as complete journey history
//  · first-row-win or latest-row-win anything
//
//  REQUIRES the attribution bridge (conversion_id on both appointment tables).
//  There is NO runtime schema detection and NO fallback path: the column is a
//  precondition, not an option.
// ════════════════════════════════════════════════════════════════════

"use strict";

// Attribution bases. Every attributed occurrence states exactly one.
const BASIS = Object.freeze({
  EXPLICIT: "explicit_link",              // conversion_id on the row
  ORIGIN_POINTER: "origin_tour_pointer",  // leasing_conversions.origin_tour_id
  SCHEDULED_POINTER: "scheduled_tour_pointer",
  CHAIN: "chain_inheritance",             // root attributed, members agree
  UNATTRIBUTED: "unattributed",
  CONFLICT: "conflict",
  UNTRACKABLE: "untrackable",
});

// Observed state. Derived ONLY from recorded observation facts.
const OBSERVED = Object.freeze({
  ATTENDED: "attended",
  NO_SHOW: "no_show",
  CANCELLED: "cancelled",
  PENDING: "pending",       // scheduled, in the future
  UNKNOWN: "unknown",       // scheduled, past, nothing recorded — NEVER no_show
});

const iso = (d) => (d ? new Date(d).toISOString() : null);

// ════════════════════════════════════════════════════════════════════
//  MATERIAL LOADING IS SEPARATE FROM CLASSIFICATION.
//
//  There is exactly ONE implementation of "what happened at this appointment"
//  — projectOpportunity() below — and two ways to feed it:
//
//    appointmentJourney()          scoped loader, one opportunity
//    appointmentJourneySnapshot()  bounded loader, every opportunity at a
//                                  property in a CONSTANT number of queries
//
//  Funnel 2 needs the second: calling the first in a loop would be an N+1, and
//  re-deriving attendance inside the funnel would put a second copy of this
//  vocabulary in the codebase — precisely the drift this module exists to stop.
//
//  The single-opportunity path keeps its exact prior contract, so its proof is
//  what demonstrates the split changed no meaning.
// ════════════════════════════════════════════════════════════════════

/**
 * projectOpportunity — PURE. No queries. Classification lives here and nowhere
 * else.
 *
 *   opp              the leasing_conversions row
 *   native           leasing_tours rows belonging to this opportunity
 *   eventsByTour     Map tour_id -> tour_events[], ascending
 *   outsideParents   Map tour_id -> {id, conversion_id, property_id} for
 *                    reschedule parents NOT in `native`
 *   external         [{ row, revisions[] }]
 */
function projectOpportunity({
  opp, native, eventsByTour, outsideParents, external, property_id, asOf,
}) {
  const opportunity_id = String(opp.id);

  // ── CHAIN RESOLUTION — iterative, cycle-safe ───────────────────────
  const byId = new Map(native.map((t) => [String(t.id), t]));

  function rootOf(t) {
    const seen = new Set();
    let cur = t;
    while (cur && cur.rescheduled_from) {
      const k = String(cur.id);
      if (seen.has(k)) return { root: null, reason: "reschedule_cycle" };
      seen.add(k);
      const pid = String(cur.rescheduled_from);
      const parent = byId.get(pid);
      if (!parent) {
        const outside = outsideParents.get(pid);
        if (outside && outside.conversion_id
            && String(outside.conversion_id) !== String(opportunity_id)) {
          return { root: null, reason: "competing_opportunity_link",
                   competing_opportunity_id: String(outside.conversion_id),
                   parent_occurrence_id: pid, conflict: true };
        }
        return { root: null, reason: "parent_outside_opportunity" };
      }
      cur = parent;
    }
    return { root: cur ? String(cur.id) : null, reason: null };
  }

  const chainMap = new Map();
  const untrackable = [];
  const competingLinks = [];
  for (const t of native) {
    const r = rootOf(t);
    if (!r.root) {
      const entry = { occurrence_id: t.id, reason: r.reason };
      if (r.conflict) {
        entry.competing_opportunity_id = r.competing_opportunity_id;
        entry.parent_occurrence_id = r.parent_occurrence_id;
        competingLinks.push(entry);
      }
      untrackable.push(entry);
      continue;
    }
    if (!chainMap.has(r.root)) chainMap.set(r.root, []);
    chainMap.get(r.root).push(t);
  }

  // ── OCCURRENCE SHAPE ───────────────────────────────────────────────
  //  Observed state comes ONLY from recorded facts. The clock never promotes a
  //  scheduled appointment into an outcome.
  function observedOf(t) {
    if (t.completed_at) return OBSERVED.ATTENDED;
    if (t.no_show_at) return OBSERVED.NO_SHOW;
    if (t.cancelled_at) return OBSERVED.CANCELLED;
    if (t.status === "cancelled") return OBSERVED.CANCELLED;
    if (t.scheduled_for && new Date(t.scheduled_for) > asOf) return OBSERVED.PENDING;
    return OBSERVED.UNKNOWN;    // past and unobserved — NOT no_show
  }

  // Actual host and outcome come from the APPOINTMENT-SPECIFIC authority
  // (tour_events.metadata written by the canonical completion service), never
  // from leasing_conversions. The LATEST observation event wins because a
  // correction is written as a later event that preserves the earlier one; both
  // are returned so prior truth is never hidden.
  function observationOf(t) {
    const evs = (eventsByTour.get(String(t.id)) || [])
      .filter((e) => ["completed", "no_show", "cancelled", "checked_in"].includes(e.event_type));
    if (!evs.length) return { actual_host_user_id: null, outcome: null, recorded_by_user_id: null,
                              recorded_at: null, corrections: [], observation_count: 0 };
    const outcomeEvs = evs.filter((e) => e.metadata && (e.metadata.tour_outcome || e.metadata.actual_tour_host_user_id));
    const latest = outcomeEvs[outcomeEvs.length - 1] || null;
    const superseded = outcomeEvs.slice(0, -1).map((e) => ({
      outcome: e.metadata.tour_outcome || null,
      actual_host_user_id: e.metadata.actual_tour_host_user_id || null,
      recorded_by_user_id: e.metadata.recorded_by_user_id || null,
      recorded_at: iso(e.event_at),
    }));
    return {
      actual_host_user_id: latest ? (latest.metadata.actual_tour_host_user_id || null) : null,
      actual_host_name_claim: latest ? (latest.metadata.actual_tour_host_name_claim || null) : null,
      outcome: latest ? (latest.metadata.tour_outcome || null) : null,
      recorded_by_user_id: latest ? (latest.metadata.recorded_by_user_id || null) : null,
      recorded_at: latest ? iso(latest.event_at) : null,
      corrections: superseded,          // PRIOR TRUTH, preserved
      observation_count: evs.length,
    };
  }

  function basisOf(t, chainBases) {
    if (chainBases === BASIS.CONFLICT) return BASIS.CONFLICT;
    if (t.conversion_id) return BASIS.EXPLICIT;
    if (opp.origin_tour_id && String(t.id) === String(opp.origin_tour_id)) return BASIS.ORIGIN_POINTER;
    if (chainBases) return BASIS.CHAIN;
    return BASIS.UNATTRIBUTED;
  }

  const chains = [];
  for (const [root, members] of chainMap) {
    // Do the chain's explicit links AGREE? Disagreement is a conflict, never a
    // vote and never the first row.
    const linked = [...new Set(members.filter((m) => m.conversion_id)
                                      .map((m) => String(m.conversion_id)))];
    const chainBasis = linked.length > 1 ? BASIS.CONFLICT
      : (linked.length === 1 ? BASIS.CHAIN : null);

    const occurrences = members
      .sort((a, b) => String(a.scheduled_for || "").localeCompare(String(b.scheduled_for || "")))
      .map((t) => ({
        occurrence_id: t.id,
        source_type: "leasing_tours",
        source_id: t.id,
        planned_state: t.status,
        planned_for: iso(t.scheduled_for),
        observed_state: observedOf(t),
        observed_at: iso(t.completed_at || t.no_show_at || t.cancelled_at || t.checked_in_at),
        scheduled_host_user_id: t.leasing_agent_id || null,
        attribution_basis: basisOf(t, chainBasis),
        attributed_opportunity_id: t.conversion_id || null,
        ...observationOf(t),
      }));

    chains.push({
      chain_root_id: root,
      source_type: "leasing_tours",
      occurrence_count: occurrences.length,
      attribution_basis: chainBasis === BASIS.CONFLICT ? BASIS.CONFLICT
        : (linked.length === 1 ? BASIS.EXPLICIT : BASIS.UNATTRIBUTED),
      conflicting_opportunity_ids: chainBasis === BASIS.CONFLICT ? linked : null,
      occurrences,
    });
  }

  // ── EXTERNAL OCCURRENCES — reconstructed from the REVISION LOG ─────
  //  The scheduled_tours row holds only the last move. Every prior occurrence
  //  lives in scheduled_tour_revisions, so the row alone is not the history.
  for (const { row: s, revisions: revs } of external) {
    // One occurrence per recorded scheduled time, in order. External rows carry
    // NO attendance vocabulary at all, so observed state is `unknown` unless
    // the row itself says cancelled. It is never `attended` and never `no_show`.
    const occurrences = revs.map((r, i) => ({
      occurrence_id: `${s.id}:rev${i + 1}`,
      source_type: "scheduled_tours",
      source_id: s.id,
      revision_ordinal: i + 1,
      planned_state: r.new_status || s.status,
      planned_for: iso(r.new_scheduled_start),
      superseded_planned_for: iso(r.prev_scheduled_start),
      observed_state: (r.new_status === "cancelled" || s.status === "cancelled")
        ? OBSERVED.CANCELLED
        : (r.new_scheduled_start && new Date(r.new_scheduled_start) > asOf
            ? OBSERVED.PENDING : OBSERVED.UNKNOWN),
      observed_at: null,
      observation_unavailable_reason: "external_source_records_no_attendance",
      scheduled_host_user_id: s.scheduled_host_user_id || null,
      actual_host_user_id: null,
      outcome: null,
      attribution_basis: s.conversion_id ? BASIS.EXPLICIT
        : (opp.scheduled_tour_id && String(s.id) === String(opp.scheduled_tour_id)
            ? BASIS.SCHEDULED_POINTER : BASIS.UNATTRIBUTED),
      attributed_opportunity_id: s.conversion_id || null,
    }));

    chains.push({
      chain_root_id: s.id,
      source_type: "scheduled_tours",
      occurrence_count: occurrences.length,
      reschedule_count: s.reschedule_count,
      attribution_basis: s.conversion_id ? BASIS.EXPLICIT
        : (opp.scheduled_tour_id && String(s.id) === String(opp.scheduled_tour_id)
            ? BASIS.SCHEDULED_POINTER : BASIS.UNATTRIBUTED),
      conflicting_opportunity_ids: null,
      occurrences,
    });
  }

  // ── OPPORTUNITY-LEVEL ROLL-UP — stated rules, never a collapse ─────
  const allOcc = chains.flatMap((ch) => ch.occurrences);
  const attended = allOcc.filter((o) => o.observed_state === OBSERVED.ATTENDED);
  const conflicted = chains.filter((ch) => ch.attribution_basis === BASIS.CONFLICT);
  const pending = allOcc.filter((o) => o.observed_state === OBSERVED.PENDING);
  const unknown = allOcc.filter((o) => o.observed_state === OBSERVED.UNKNOWN);

  let observed_visit;
  if (conflicted.length || competingLinks.length) observed_visit = "conflict";
  else if (attended.length) observed_visit = true;
  else if (pending.length || unknown.length) observed_visit = "unknown";
  else observed_visit = false;

  return {
    ok: true,
    opportunity_id,
    property_id,
    opportunity_status: opp.status,
    chain_count: chains.length,
    occurrence_count: allOcc.length,
    chains,

    observed_visit,
    observed_visits: attended.map((o) => ({
      occurrence_id: o.occurrence_id, observed_at: o.observed_at,
      actual_host_user_id: o.actual_host_user_id, outcome: o.outcome })),

    evidence_pending: pending.length > 0 || unknown.length > 0,
    unknown_occurrence_count: unknown.length,
    pending_occurrence_count: pending.length,
    untrackable,
    //  Two conflict shapes, counted together and listed separately: members of
    //  ONE chain carrying different opportunities, and a chain whose parent
    //  belongs to another opportunity entirely.
    conflict_count: conflicted.length + competingLinks.length,
    competing_opportunity_links: competingLinks,

    // COMPATIBILITY ONLY — the flattened fields, reported so a reader can see
    // them, explicitly NOT treated as journey history.
    compatibility: {
      origin_tour_id: opp.origin_tour_id,
      scheduled_tour_id: opp.scheduled_tour_id,
      conversion_actual_tour_host_user_id: opp.actual_tour_host_user_id,
      conversion_tour_outcome: opp.tour_outcome,
      note: "Originating-tour facts, immutable by migration 047. Not per-occurrence truth.",
    },
  };
}

// ── LOADER 1 · ONE OPPORTUNITY, SCOPED ───────────────────────────────
//  Unchanged contract. Queries only what this opportunity can reach.
async function appointmentJourney(q, { property_id, opportunity_id, as_of = null } = {}) {
  if (!property_id) throw new Error("appointmentJourney requires a server-derived property_id");
  if (!opportunity_id) throw new Error("appointmentJourney requires an exact opportunity_id");
  const asOf = as_of ? new Date(as_of) : new Date();

  // ── THE OPPORTUNITY, PROPERTY-WALLED ───────────────────────────────
  const opp = (await q.query(
    `select id, property_id, person_id, lead_id, status, current_stage,
            opened_at, closed_at, origin_tour_id, scheduled_tour_id,
            actual_tour_host_user_id, tour_outcome
       from leasing_conversions where id = $1`, [opportunity_id])).rows[0];

  if (!opp) {
    return { ok: false, refusal_code: "opportunity_not_found", opportunity_id, chains: [] };
  }
  if (String(opp.property_id) !== String(property_id)) {
    // Cross-property refusal. Not a journey question at all.
    return { ok: false, refusal_code: "opportunity_not_at_property",
             opportunity_id, chains: [] };
  }

  //  Every tour explicitly attributed to this opportunity, PLUS every tour any
  //  exact legacy pointer claims. Nothing is gathered by lead, person or time.
  const native = (await q.query(
    `select t.*, (t.conversion_id is not null) as has_explicit
       from leasing_tours t
      where t.property_id = $1
        and ( t.conversion_id = $2
              or t.id = $3
              or t.rescheduled_from in (
                   select id from leasing_tours
                    where property_id = $1 and (conversion_id = $2 or id = $3)) )
      order by t.scheduled_for asc nulls last`,
    [property_id, opportunity_id, opp.origin_tour_id])).rows;

  const events = native.length ? (await q.query(
    `select tour_id, event_type, event_at, actor_id, metadata
       from tour_events where tour_id = any($1::uuid[])
      order by event_at asc`, [native.map((t) => t.id)])).rows : [];
  const eventsByTour = new Map();
  for (const e of events) {
    const k = String(e.tour_id);
    if (!eventsByTour.has(k)) eventsByTour.set(k, []);
    eventsByTour.get(k).push(e);
  }

  //  A parent NOT in this opportunity's set is not automatically a dead end. If
  //  it carries a DIFFERENT opportunity the chain spans two, which the ruling
  //  requires be surfaced as conflict rather than dropped as untrackable.
  const byId = new Map(native.map((t) => [String(t.id), t]));
  const outsideParents = new Map();
  const orphanParentIds = [...new Set(native
    .map((t) => t.rescheduled_from).filter(Boolean).map(String)
    .filter((id) => !byId.has(id)))];
  if (orphanParentIds.length) {
    for (const r of (await q.query(
      `select id, conversion_id, property_id from leasing_tours where id = any($1::uuid[])`,
      [orphanParentIds])).rows) outsideParents.set(String(r.id), r);
  }

  const extRows = (await q.query(
    `select s.* from scheduled_tours s
      where s.property_id = $1 and (s.conversion_id = $2 or s.id = $3)`,
    [property_id, opportunity_id, opp.scheduled_tour_id])).rows;
  const external = [];
  for (const s of extRows) {
    external.push({ row: s, revisions: (await q.query(
      `select change_type, prev_scheduled_start, prev_status,
              new_scheduled_start, new_status, created_at
         from scheduled_tour_revisions
        where scheduled_tour_id = $1 order by created_at asc`, [s.id])).rows });
  }

  return projectOpportunity({ opp, native, eventsByTour, outsideParents,
                              external, property_id, asOf });
}

// ── LOADER 2 · EVERY OPPORTUNITY AT ONE PROPERTY, BOUNDED ────────────
//  Query count is CONSTANT in the number of opportunities: six, regardless of
//  whether the property has one opportunity or ten thousand. This is what
//  Funnel 2 reads. It also batches the per-row revisions lookup that the scoped
//  loader still performs one row at a time.
async function appointmentJourneySnapshot(q, { property_id, as_of = null } = {}) {
  if (!property_id) throw new Error("appointmentJourneySnapshot requires a server-derived property_id");
  const asOf = as_of ? new Date(as_of) : new Date();

  const opps = (await q.query(
    `select id, property_id, person_id, lead_id, status, current_stage,
            opened_at, closed_at, origin_tour_id, scheduled_tour_id,
            actual_tour_host_user_id, tour_outcome
       from leasing_conversions where property_id = $1`, [property_id])).rows;

  const tours = (await q.query(
    `select t.*, (t.conversion_id is not null) as has_explicit
       from leasing_tours t where t.property_id = $1
      order by t.scheduled_for asc nulls last`, [property_id])).rows;

  const events = tours.length ? (await q.query(
    `select tour_id, event_type, event_at, actor_id, metadata
       from tour_events where tour_id = any($1::uuid[])
      order by event_at asc`, [tours.map((t) => t.id)])).rows : [];
  const eventsByTour = new Map();
  for (const e of events) {
    const k = String(e.tour_id);
    if (!eventsByTour.has(k)) eventsByTour.set(k, []);
    eventsByTour.get(k).push(e);
  }

  const extRows = (await q.query(
    `select s.* from scheduled_tours s where s.property_id = $1`, [property_id])).rows;
  const revs = extRows.length ? (await q.query(
    `select scheduled_tour_id, change_type, prev_scheduled_start, prev_status,
            new_scheduled_start, new_status, created_at
       from scheduled_tour_revisions where scheduled_tour_id = any($1::uuid[])
      order by created_at asc`, [extRows.map((s) => s.id)])).rows : [];
  const revsByTour = new Map();
  for (const r of revs) {
    const k = String(r.scheduled_tour_id);
    if (!revsByTour.has(k)) revsByTour.set(k, []);
    revsByTour.get(k).push(r);
  }

  const tourById = new Map(tours.map((t) => [String(t.id), t]));

  //  Reschedule parents that live at ANOTHER property are not in `tours`. One
  //  bounded lookup covers every opportunity at once.
  const knownIds = new Set(tourById.keys());
  const foreignParentIds = [...new Set(tours
    .map((t) => t.rescheduled_from).filter(Boolean).map(String)
    .filter((id) => !knownIds.has(id)))];
  const foreignParents = new Map();
  if (foreignParentIds.length) {
    for (const r of (await q.query(
      `select id, conversion_id, property_id from leasing_tours where id = any($1::uuid[])`,
      [foreignParentIds])).rows) foreignParents.set(String(r.id), r);
  }

  const journeys = new Map();
  for (const opp of opps) {
    const oid = String(opp.id);

    //  EXACTLY the scoped loader's membership rule, in memory: explicitly
    //  attributed, or claimed by the exact legacy pointer, or a direct
    //  reschedule child of one of those.
    const directIds = new Set(tours
      .filter((t) => (t.conversion_id && String(t.conversion_id) === oid)
                  || (opp.origin_tour_id && String(t.id) === String(opp.origin_tour_id)))
      .map((t) => String(t.id)));
    const native = tours.filter((t) => directIds.has(String(t.id))
      || (t.rescheduled_from && directIds.has(String(t.rescheduled_from))));

    const inSet = new Set(native.map((t) => String(t.id)));
    const outsideParents = new Map();
    for (const t of native) {
      const pid = t.rescheduled_from && String(t.rescheduled_from);
      if (!pid || inSet.has(pid)) continue;
      const parent = tourById.get(pid) || foreignParents.get(pid);
      if (parent) outsideParents.set(pid, parent);
    }

    const external = extRows
      .filter((s) => (s.conversion_id && String(s.conversion_id) === oid)
                  || (opp.scheduled_tour_id && String(s.id) === String(opp.scheduled_tour_id)))
      .map((s) => ({ row: s, revisions: revsByTour.get(String(s.id)) || [] }));

    journeys.set(oid, projectOpportunity({
      opp, native, eventsByTour, outsideParents, external,
      property_id, asOf,
    }));
  }

  return {
    property_id,
    as_of_utc: asOf.toISOString(),
    opportunity_count: opps.length,
    opportunities: opps,
    journeys,                       // Map opportunity_id -> journey projection
    query_count: 6,                 // CONSTANT in the number of opportunities
  };
}

module.exports = {
  appointmentJourney, appointmentJourneySnapshot, projectOpportunity,
  BASIS, OBSERVED,
};
