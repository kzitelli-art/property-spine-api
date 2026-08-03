// ════════════════════════════════════════════════════════════════════
//  opportunity_lifecycle_read.js — IS THIS OPPORTUNITY STILL ALIVE,
//  EXPLICITLY OVER, REOPENED, OR UNRESOLVED — AND WHAT PROVES IT.
//
//  A PURE READ, as of one timestamp. Writes nothing, mounts nothing, creates no
//  status vocabulary, no ranking, no stage configuration, no pipeline.
//
//  ── TERMINAL TRUTH COMES FROM ORDERED EVENTS, NOTHING ELSE ───────────
//  The authority is leasing_lead_lifecycle_events filtered by EXACT
//  conversion_id (migration 128), ordered by the rail's existing durable
//  chronology. This module NEVER reads leasing_leads.status or
//  leasing_conversions.status as terminal evidence. Those remain mutable
//  display/compatibility fields; a stale label cannot override event truth, and
//  a label with no event behind it produces `incomplete`, never `terminal`.
//
//  ── REOPEN IS AN EVENT, NEVER A DELETION ─────────────────────────────
//  A reopen does not erase the close. The whole terminal/reopen chronology is
//  returned. terminal → reopened → terminal again is valid, and the LAST
//  terminal event after the last reopen is the current evidence.
//
//  ── ORDERING ─────────────────────────────────────────────────────────
//  event_sequence is per-CONVERSATION and is deliberately NOT rewritten (the
//  rail is preserved). Within one opportunity the sequence is still strictly
//  increasing, so filtering by conversion_id and ordering by sequence gives
//  this opportunity's true chronology. occurred_at is used ONLY for as-of
//  windowing, never to order two events — clock skew is not chronology.
//
//  ── PENDING IS NOT `terminal = false` ────────────────────────────────
//  Pending must name a real unresolved act from a canonical opportunity-grained
//  source. "Not terminal with nothing pending" is a distinct, honest answer and
//  is NEVER dressed up as "active".
// ════════════════════════════════════════════════════════════════════
"use strict";

const { appointmentJourneySnapshot, OBSERVED } = require("./appointment_journey");

// ── LIFECYCLE STATE — derived from events only ───────────────────────
const LIFECYCLE = Object.freeze({
  NO_TERMINAL_EVENT:  "no_terminal_event",   // nothing terminal ever recorded
  TERMINAL:           "terminal",            // explicitly over, as of now
  REOPENED:           "reopened_after_terminal",
  CONFLICT:           "conflict",            // contradictory terminal evidence
  INCOMPLETE:         "incomplete",          // malformed / unusable evidence
  UNTRACKABLE:        "untrackable",         // historical events not attributable
});

// ── PENDING BASES — each names a real unresolved act ─────────────────
const PENDING = Object.freeze({
  FUTURE_APPOINTMENT:  "future_appointment_scheduled",
  VISIT_AWAITING:      "observed_visit_awaiting_outcome",
  OPEN_OBLIGATION:     "open_follow_up_obligation",
  APPLICATION_UNDERWAY:"application_process_underway",
  NONE_KNOWN:          "no_known_pending_act",   // NOT "active"
  UNKNOWN:             "pending_unknown",        // evidence incomplete
});

const TERMINAL_TYPES = new Set(["closed_not_fit"]);
const REOPEN_TYPES = new Set(["reopened"]);

const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * opportunityLifecycleSnapshot — every opportunity at one property, as of one
 * timestamp, in a CONSTANT number of queries.
 *
 * Reads inside the caller's transaction when given a client. The caller is
 * responsible for the coherent snapshot (the funnel path supplies one).
 */
async function opportunityLifecycleSnapshot(q, { property_id, as_of = null, journeys: injectedJourneys = null } = {}) {
  if (!property_id) throw new Error("opportunityLifecycleSnapshot requires a server-derived property_id");
  const asOf = as_of ? new Date(as_of) : new Date();
  const asOfIso = asOf.toISOString();

  const opps = (await q.query(
    `select id, property_id, person_id, lead_id, status, current_stage, opened_at, closed_at
       from leasing_conversions where property_id = $1`, [property_id])).rows;

  // ── THE EVENT AUTHORITY ────────────────────────────────────────────
  //  Only events carrying an EXACT conversion_id are evidence for an
  //  opportunity. Conversation-level rows are counted separately as coverage,
  //  never folded in.
  const events = (await q.query(
    `select id, conversation_id, conversion_id, property_id, event_sequence, event_type,
            actor_type, actor_id, reason_code, reason_note, correction_reason,
            occurred_at, recorded_at, idempotency_key
       from leasing_lead_lifecycle_events
      where property_id = $1
      order by event_sequence asc, id asc`, [property_id])).rows;

  const byOpp = new Map();
  const unattributedTerminal = [];   // terminal-ish events with no conversion_id
  for (const e of events) {
    if (!e.conversion_id) {
      if (TERMINAL_TYPES.has(e.event_type) || REOPEN_TYPES.has(e.event_type)) {
        unattributedTerminal.push({ event_id: e.id, event_type: e.event_type,
                                    conversation_id: e.conversation_id,
                                    reason: "not_attributable_from_existing_evidence" });
      }
      continue;
    }
    const k = String(e.conversion_id);
    if (!byOpp.has(k)) byOpp.set(k, []);
    byOpp.get(k).push(e);
  }

  // ── PENDING SOURCES, ALL OPPORTUNITY-GRAINED ───────────────────────
  const obligations = (await q.query(
    `select o.id, o.conversion_id, o.rung, o.due_by, o.resolution, o.closed_at
       from leasing_conversion_obligations o
       join leasing_conversions c on c.id = o.conversion_id
      where c.property_id = $1 and o.closed_at is null`, [property_id])).rows;
  const oblByOpp = new Map();
  for (const o of obligations) {
    const k = String(o.conversion_id);
    if (!oblByOpp.has(k)) oblByOpp.set(k, []);
    oblByOpp.get(k).push(o);
  }

  const UNDERWAY = new Set(["draft", "submitted", "approved", "lease_ready", "tenant_signed"]);
  const apps = (await q.query(
    `select id, conversion_id, status from lease_applications
      where property_id = $1 and conversion_id is not null`, [property_id])).rows;
  const appsByOpp = new Map();
  for (const a of apps) {
    const k = String(a.conversion_id);
    if (!appsByOpp.has(k)) appsByOpp.set(k, []);
    appsByOpp.get(k).push(a);
  }

  //  The caller may pass a journey snapshot it already took under the SAME
  //  coherent read, so the appointment material is not fetched twice and the
  //  two projections cannot disagree about what was scheduled.
  const journeys = injectedJourneys
    || await appointmentJourneySnapshot(q, { property_id, as_of: asOfIso });

  const rows = opps.map((opp) => {
    const oid = String(opp.id);
    //  As-of windowing on occurred_at; ORDER stays the durable sequence.
    const evs = (byOpp.get(oid) || [])
      .filter((e) => !e.occurred_at || new Date(e.occurred_at).getTime() <= asOf.getTime());

    const malformed = (byOpp.get(oid) || []).filter((e) => !e.occurred_at
      || isNaN(new Date(e.occurred_at).getTime()));

    const terminals = evs.filter((e) => TERMINAL_TYPES.has(e.event_type));
    const reopens = evs.filter((e) => REOPEN_TYPES.has(e.event_type));
    const lastTerminal = terminals.length ? terminals[terminals.length - 1] : null;
    const lastReopen = reopens.length ? reopens[reopens.length - 1] : null;

    //  CONFLICT: two terminal events at the SAME sequence position, which the
    //  rail's lock should make impossible — if it ever happens it is reported,
    //  never resolved by picking one.
    const dupSeq = new Set();
    let conflict = false;
    for (const t of terminals) {
      if (dupSeq.has(Number(t.event_sequence))) conflict = true;
      dupSeq.add(Number(t.event_sequence));
    }

    let terminal = false, state;
    if (conflict) state = LIFECYCLE.CONFLICT;
    else if (malformed.length) state = LIFECYCLE.INCOMPLETE;
    else if (!lastTerminal) state = LIFECYCLE.NO_TERMINAL_EVENT;
    else if (lastReopen && Number(lastReopen.event_sequence) > Number(lastTerminal.event_sequence)) {
      state = LIFECYCLE.REOPENED;
    } else { state = LIFECYCLE.TERMINAL; terminal = true; }

    // ── PENDING ──────────────────────────────────────────────────────
    const j = journeys.journeys.get(oid);
    const occ = j ? j.chains.flatMap((ch) => ch.occurrences) : [];
    const bases = [];
    if (occ.some((o) => o.observed_state === OBSERVED.PENDING)) bases.push(PENDING.FUTURE_APPOINTMENT);
    if (occ.some((o) => o.observed_state === OBSERVED.ATTENDED && !o.outcome)) bases.push(PENDING.VISIT_AWAITING);
    if ((oblByOpp.get(oid) || []).length) bases.push(PENDING.OPEN_OBLIGATION);
    if ((appsByOpp.get(oid) || []).some((a) => UNDERWAY.has(String(a.status)))) bases.push(PENDING.APPLICATION_UNDERWAY);

    //  Evidence quality gates the pending answer too: if the lifecycle evidence
    //  is unusable we do not claim "nothing pending".
    let pending_state;
    if (state === LIFECYCLE.CONFLICT || state === LIFECYCLE.INCOMPLETE) pending_state = PENDING.UNKNOWN;
    else if (bases.length) pending_state = "pending";
    else pending_state = PENDING.NONE_KNOWN;

    //  COVERAGE — can this row's terminal answer be trusted?
    let coverage_state = "exact";
    if (state === LIFECYCLE.CONFLICT) coverage_state = "conflict";
    else if (state === LIFECYCLE.INCOMPLETE) coverage_state = "incomplete";
    else if (!evs.length && unattributedTerminal.length) coverage_state = "untrackable_history_present";

    return {
      opportunity_id: oid,
      property_id,
      as_of_utc: asOfIso,

      lifecycle_state: state,
      terminal,
      terminal_code: terminal && lastTerminal ? lastTerminal.reason_code : null,
      terminal_reason_note: terminal && lastTerminal ? lastTerminal.reason_note : null,
      terminal_occurred_at: terminal && lastTerminal ? iso(lastTerminal.occurred_at) : null,
      terminal_event_id: terminal && lastTerminal ? lastTerminal.id : null,

      reopened_after_terminal: state === LIFECYCLE.REOPENED,
      latest_reopen_event_id: lastReopen ? lastReopen.id : null,
      latest_reopen_at: lastReopen ? iso(lastReopen.occurred_at) : null,

      //  FULL chronology — a reopen never hides the close it followed.
      terminal_history: evs
        .filter((e) => TERMINAL_TYPES.has(e.event_type) || REOPEN_TYPES.has(e.event_type))
        .map((e) => ({
          event_id: e.id, event_type: e.event_type, event_sequence: Number(e.event_sequence),
          reason_code: e.reason_code || null, actor_type: e.actor_type, actor_id: e.actor_id || null,
          occurred_at: iso(e.occurred_at), recorded_at: iso(e.recorded_at),
          conversation_id: e.conversation_id,
        })),

      pending_state,
      pending_basis: bases,

      conflict_codes: conflict ? ["duplicate_terminal_at_same_sequence"] : [],
      coverage_state,
      coverage_note: coverage_state === "untrackable_history_present"
        ? "Terminal-type events exist on this conversation that carry no exact opportunity attribution. They are NOT applied to this opportunity, because doing so would require guessing."
        : null,

      //  Exact source ids supporting every claim above.
      source_event_ids: evs.map((e) => e.id),
      //  Mutable labels, carried for COMPARISON ONLY — never used as evidence.
      compatibility: {
        conversion_status: opp.status,
        conversion_closed_at: iso(opp.closed_at),
        note: "Mutable display fields. Not terminal evidence. A disagreement with lifecycle_state means the label is stale, not that the events are wrong.",
      },
      label_disagrees_with_events:
        (String(opp.status) === "released" && state === LIFECYCLE.NO_TERMINAL_EVENT)
        || (String(opp.status) === "active" && terminal),
    };
  });

  return {
    property_id, as_of_utc: asOfIso,
    opportunity_count: rows.length,
    rows,
    unattributed_terminal_events: unattributedTerminal,
  };
}

module.exports = {
  opportunityLifecycleSnapshot, LIFECYCLE, PENDING,
  TERMINAL_TYPES, REOPEN_TYPES,
};
