// ════════════════════════════════════════════════════════════════════
//  opportunity_funnel.js — FUNNEL 2, RE-GRAINED TO THE DURABLE OPPORTUNITY.
//
//  ── THE GRAIN, AND WHY IT CHANGED ────────────────────────────────────
//  Funnel 2 used to count APPOINTMENT CHAINS in the denominator and credit
//  them from the LEAD in the numerator:
//
//      cohort  = journeys where final_status === 'completed'
//      credit  = the LEAD has any submitted application
//
//  Two completed chains for one lead plus one application produced TWO
//  conversions from one application. The durable opportunity —
//  leasing_conversions — was never read at all.
//
//  Now: ONE ROW PER OPPORTUNITY. Never per lead, person, appointment,
//  appointment chain, completed tour or current application. Several
//  appointments or chains inside one opportunity can never multiply it. Two
//  opportunities belonging to the same lead remain two distinct rows.
//
//  ── APPOINTMENT EVIDENCE COMES FROM ONE AUTHORITY ────────────────────
//  appointment_journey.js, via the bounded property snapshot. This file does
//  NOT re-derive attendance. It never reads leasing_tours.status directly,
//  never reads the flattened leasing_conversions fields as journey truth, and
//  never promotes a past scheduled time into an outcome.
//
//  ── THE NUMERATOR LINK IS EXACT OR IT IS NOTHING ─────────────────────
//  lease_applications.conversion_id (FK to leasing_conversions.id, migration
//  051) is the ONLY accepted link. leasing_lead_id is deliberately NOT used as
//  a fallback: a lead with two opportunities would credit both from one
//  application, which is the exact defect being removed.
//
//  An application with a NULL conversion_id is never assigned by inference. If
//  such an application could plausibly belong to a cohort opportunity, that
//  opportunity's numerator is UNRESOLVED and the rate is suppressed — the lead
//  is used only to recognise UNCERTAINTY, never to award a conversion.
//
//  ── NOT IN THIS FILE ─────────────────────────────────────────────────
//  No scores, no rankings, no recommendations, no leaderboard, no calendar, no
//  writes, no route, no renderer. Terminal opportunity truth is NOT solved here
//  by reading current lead status — see §MISSING at the bottom.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { appointmentJourneySnapshot, OBSERVED } = require("../leasing/appointment_journey");

// ── THE EIGHT APPOINTMENT-EVIDENCE STATES, KEPT SEPARATE ─────────────
//  These are distinct truths, not gradations of one scale. Collapsing any two
//  of them loses a fact an operator would act on differently.
const EVIDENCE = Object.freeze({
  CONFLICT:        "conflict",           // competing/contradictory attribution
  OBSERVED_VISIT:  "observed_visit",     // at least one recorded attendance
  NO_SHOW:         "no_show",            // EXPLICIT no-show, never inferred
  UNTRACKABLE:     "untrackable",        // cycle / parent outside — no resolution
  SCHEDULED_FUTURE:"scheduled_future",   // scheduled, still ahead of as_of
  PAST_UNOBSERVED: "past_unobserved",    // scheduled, past, nothing recorded
  CANCELLED:       "cancelled",          // every occurrence cancelled
  NO_APPOINTMENT:  "no_appointment",     // nothing recorded at all
});

//  RESOLVED means the appointment evidence cannot still change. Only resolved
//  rows can participate in a COMPLETE rate. The other four are not failures —
//  they are honest states that make the cohort partial.
const RESOLVED = new Set([
  EVIDENCE.OBSERVED_VISIT, EVIDENCE.NO_SHOW,
  EVIDENCE.CANCELLED, EVIDENCE.NO_APPOINTMENT,
]);

const APPLICATION_LINK = Object.freeze({
  EXACT:      "exact_conversion_id",
  NONE:       "no_linked_application",
  AMBIGUOUS:  "unlinked_application_may_belong",  // cannot be resolved honestly
});

/**
 * classifyEvidence — one journey projection → one evidence state.
 *
 * PRECEDENCE, stated rather than implied:
 *   1 conflict          contradictory evidence never resolves to a winner
 *   2 observed_visit    a recorded attendance HAPPENED; later unknowns do not
 *                       erase it
 *   3 no_show           an explicit recorded observation
 *   4 untrackable       evidence exists but cannot be resolved at all
 *   5 scheduled_future  live future work outranks a stale past unknown
 *   6 past_unobserved   past, nothing recorded — NEVER promoted to no_show
 *   7 cancelled         occurrences exist and every one was cancelled
 *   8 no_appointment    nothing recorded
 *
 * The flags below carry the truths precedence would otherwise hide, so
 * "observed a visit AND has more work scheduled" is fully readable.
 */
function classifyEvidence(j) {
  const occ = j.chains.flatMap((ch) => ch.occurrences);
  const has = (s) => occ.some((o) => o.observed_state === s);

  const flags = {
    observed_visit: has(OBSERVED.ATTENDED),
    future_scheduled_remains: has(OBSERVED.PENDING),
    past_evidence_unresolved: has(OBSERVED.UNKNOWN),
    explicit_no_show: has(OBSERVED.NO_SHOW),
    cancelled_present: has(OBSERVED.CANCELLED),
    occurrence_count: occ.length,
    chain_count: j.chains.length,
  };

  let state;
  if (j.conflict_count > 0) state = EVIDENCE.CONFLICT;
  else if (flags.observed_visit) state = EVIDENCE.OBSERVED_VISIT;
  else if (flags.explicit_no_show) state = EVIDENCE.NO_SHOW;
  else if (j.untrackable.length > 0) state = EVIDENCE.UNTRACKABLE;
  else if (flags.future_scheduled_remains) state = EVIDENCE.SCHEDULED_FUTURE;
  else if (flags.past_evidence_unresolved) state = EVIDENCE.PAST_UNOBSERVED;
  else if (occ.length > 0 && flags.cancelled_present) state = EVIDENCE.CANCELLED;
  else state = EVIDENCE.NO_APPOINTMENT;

  return { state, flags, occurrences: occ };
}

// ── ONE COHERENT SNAPSHOT FOR EVERY FUNNEL 2 FACT ───────────────────
//  Funnel 2 reads opportunities, tours, tour events, external tours, revisions
//  and applications. Issued against a POOL, those land on any free connection
//  at READ COMMITTED — six independent snapshots. A tour completed midway
//  through would then appear in one read and not another, and the aggregate
//  would reconcile to rows that never existed together.
//
//  So every material read is taken inside ONE REPEATABLE READ, READ ONLY
//  transaction. Read-only is deliberate: this path must be structurally
//  incapable of writing.
//
//  When the caller already owns a transaction (every proof does), that
//  transaction IS the snapshot and is used as-is — opening a nested one is not
//  possible and starting a second connection would defeat the point.
async function snapshotMeta(client) {
  const r = (await client.query(
    `select current_setting('transaction_isolation') as isolation,
            pg_current_snapshot()::text            as snapshot_marker,
            pg_backend_pid()                       as backend_pid`)).rows[0];
  return { isolation: r.isolation, snapshot_marker: r.snapshot_marker,
           backend_pid: r.backend_pid };
}

async function withCoherentSnapshot(q, fn) {
  //  Discriminate a POOL from a CLIENT. Both expose connect(), so that alone
  //  is not the test — a pg Client throws "cannot reuse a client" on a second
  //  connect(). Pool-specific counters are the reliable marker.
  const isPool = typeof q.connect === "function" && typeof q.totalCount === "number";
  if (isPool) {
    const client = await q.connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const opened = await snapshotMeta(client);
      const out = await fn(client, { ...opened, owner: "opportunity_funnel" });
      const closed = await snapshotMeta(client);
      await client.query("commit");
      return { out, opened, closed, owner: "opportunity_funnel" };
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally { client.release(); }
  }
  const opened = await snapshotMeta(q);
  const out = await fn(q, { ...opened, owner: "caller" });
  const closed = await snapshotMeta(q);
  return { out, opened, closed, owner: "caller" };
}

/**
 * opportunityFunnelRows — one row per opportunity, property-scoped, bounded,
 * read under ONE coherent snapshot.
 *
 * `window` is a resolveOperatingWindow() result; property_id and as_of are
 * taken from it, never from a caller-supplied value.
 */
async function opportunityFunnelRows(pq, window) {
  const result = await withCoherentSnapshot(pq, (q, meta) =>
    readOpportunityFunnel(q, window, meta));
  return {
    ...result.out,
    snapshot: {
      isolation_level: result.opened.isolation,
      backend_pid: result.opened.backend_pid,
      snapshot_marker: result.opened.snapshot_marker,
      //  Proof that the LAST read saw the same snapshot as the FIRST.
      stable_across_all_reads: result.opened.snapshot_marker === result.closed.snapshot_marker,
      transaction_owner: result.owner,
      read_only: result.owner === "opportunity_funnel",
    },
  };
}

async function readOpportunityFunnel(q, window, _meta) {
  const property_id = window.property_id;
  const asOfIso = window.as_of_utc;
  const inWindow = (d) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    return t >= new Date(window.window_start_utc).getTime()
        && t <  new Date(window.window_end_utc).getTime();
  };

  const snap = await appointmentJourneySnapshot(q, { property_id, as_of: asOfIso });

  // ── APPLICATIONS, EXACTLY LINKED ───────────────────────────────────
  //  One bounded query. conversion_id is the only link read for credit;
  //  leasing_lead_id is carried ONLY to detect ambiguity, never to assign.
  const apps = (await q.query(
    `select id, conversion_id, leasing_lead_id, status, created_at
       from lease_applications where property_id = $1`, [property_id])).rows;

  const REACHED_SUBMITTED = new Set([
    "submitted", "approved", "lease_ready", "tenant_signed", "countersigned",
    "active", "declined", "withdrawn",
  ]);
  const submitted = apps.filter((a) => REACHED_SUBMITTED.has(String(a.status))
    && new Date(a.created_at).getTime() <= new Date(asOfIso).getTime());

  const byConversion = new Map();
  for (const a of submitted) {
    if (!a.conversion_id) continue;
    const k = String(a.conversion_id);
    if (!byConversion.has(k)) byConversion.set(k, []);
    byConversion.get(k).push(a);
  }
  //  Unlinked submitted applications, indexed by lead — for UNCERTAINTY only.
  const unlinkedByLead = new Map();
  for (const a of submitted) {
    if (a.conversion_id || !a.leasing_lead_id) continue;
    const k = String(a.leasing_lead_id);
    if (!unlinkedByLead.has(k)) unlinkedByLead.set(k, []);
    unlinkedByLead.get(k).push(a);
  }
  const unlinkedNoLead = submitted.filter((a) => !a.conversion_id && !a.leasing_lead_id).length;

  const rows = [];
  for (const opp of snap.opportunities) {
    const oid = String(opp.id);
    const j = snap.journeys.get(oid);
    const ev = classifyEvidence(j);

    // First observed visit — the origin instant for the cohort.
    const visits = ev.occurrences
      .filter((o) => o.observed_state === OBSERVED.ATTENDED && o.observed_at)
      .sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
    const first_observed_visit_at = visits.length ? visits[0].observed_at : null;

    const linked = byConversion.get(oid) || [];
    const maybe = opp.lead_id ? (unlinkedByLead.get(String(opp.lead_id)) || []) : [];
    const application_link = linked.length ? APPLICATION_LINK.EXACT
      : (maybe.length ? APPLICATION_LINK.AMBIGUOUS : APPLICATION_LINK.NONE);

    // Attribution coverage: how much of this opportunity's appointment evidence
    // rests on an explicit durable link rather than a legacy pointer.
    const attributed = ev.occurrences.filter(
      (o) => o.attribution_basis === "explicit_link" || o.attribution_basis === "chain_inheritance").length;

    rows.push({
      opportunity_id: oid,
      property_id,

      // CONTEXT, NOT GRAIN. Present so a reader can navigate; never a key.
      context: { lead_id: opp.lead_id || null, person_id: opp.person_id || null },

      appointment_evidence_state: ev.state,
      observed_visit: ev.flags.observed_visit,
      future_scheduled_remains: ev.flags.future_scheduled_remains,
      past_evidence_unresolved: ev.flags.past_evidence_unresolved,
      explicit_no_show: ev.flags.explicit_no_show,
      first_observed_visit_at,

      // The exact sources supporting the classification.
      evidence_sources: {
        chain_count: ev.flags.chain_count,
        occurrence_count: ev.flags.occurrence_count,
        chains: j.chains.map((ch) => ({
          chain_root_id: ch.chain_root_id,
          source_type: ch.source_type,
          occurrence_count: ch.occurrence_count,
          attribution_basis: ch.attribution_basis,
          occurrence_ids: ch.occurrences.map((o) => o.occurrence_id),
        })),
      },

      attribution_coverage: {
        attributed_occurrences: attributed,
        total_occurrences: ev.flags.occurrence_count,
        rate: ev.flags.occurrence_count
          ? Number((attributed / ev.flags.occurrence_count).toFixed(6)) : null,
      },

      conflict_reasons: j.competing_opportunity_links.map((c) => ({
        reason: c.reason, occurrence_id: c.occurrence_id,
        competing_opportunity_id: c.competing_opportunity_id || null,
      })).concat(j.chains.filter((ch) => ch.conflicting_opportunity_ids)
        .map((ch) => ({ reason: "chain_members_disagree", occurrence_id: ch.chain_root_id,
                        competing_opportunity_id: null }))),
      untrackable_reasons: j.untrackable.map((u) => ({
        reason: u.reason, occurrence_id: u.occurrence_id })),

      application_link,
      submitted_application_ids: linked.map((a) => a.id),

      as_of_utc: asOfIso,

      // Can this row participate in a COMPLETE Funnel 2 rate?
      metric_eligible: RESOLVED.has(ev.state) && application_link !== APPLICATION_LINK.AMBIGUOUS,
      ineligibility_reason: RESOLVED.has(ev.state)
        ? (application_link === APPLICATION_LINK.AMBIGUOUS
            ? "an unlinked application may belong to this opportunity" : null)
        : `appointment evidence is ${ev.state} and may still change`,

      // Cohort membership is decided by the funnel, not by the row.
      _first_visit_in_window: inWindow(first_observed_visit_at),
    });
  }

  return { rows, coverage: {
    applications_total: apps.length,
    submitted_total: submitted.length,
    exactly_linked: submitted.filter((a) => a.conversion_id).length,
    unlinked_with_lead: submitted.filter((a) => !a.conversion_id && a.leasing_lead_id).length,
    unlinked_without_lead: unlinkedNoLead,
    note: "Credit rides lease_applications.conversion_id ONLY. leasing_lead_id is never used to award a conversion — only to recognise that an unlinked application might belong to an opportunity, which suppresses the rate rather than guessing.",
  } };
}

/**
 * aggregateOpportunityFunnel — the cohort roll-up.
 *
 * RECONCILIATION IS AN INVARIANT, NOT A HOPE: every opportunity row lands in
 * exactly one population bucket, and the buckets sum to the row count.
 *
 * THE RATE IS SUPPRESSED WHENEVER UNRESOLVED EVIDENCE COULD MOVE IT. Counts
 * remain available in every case — suppressing a rate must never also hide the
 * numbers that explain why.
 */
function aggregateOpportunityFunnel(rows) {
  const bucket = {
    observed_visit: 0, pending_future_appointment: 0, unresolved_past_appointment: 0,
    no_appointment: 0, no_show: 0, cancelled: 0, conflict: 0, untrackable: 0,
  };
  const MAP = {
    [EVIDENCE.OBSERVED_VISIT]:   "observed_visit",
    [EVIDENCE.SCHEDULED_FUTURE]: "pending_future_appointment",
    [EVIDENCE.PAST_UNOBSERVED]:  "unresolved_past_appointment",
    [EVIDENCE.NO_APPOINTMENT]:   "no_appointment",
    [EVIDENCE.NO_SHOW]:          "no_show",
    [EVIDENCE.CANCELLED]:        "cancelled",
    [EVIDENCE.CONFLICT]:         "conflict",
    [EVIDENCE.UNTRACKABLE]:      "untrackable",
  };
  for (const r of rows) bucket[MAP[r.appointment_evidence_state]] += 1;

  // ── THE COHORT ─────────────────────────────────────────────────────
  //  Origin cohort: opportunities whose FIRST observed visit falls in the
  //  window. An opportunity with no observed visit has no origin instant and
  //  is therefore not in this funnel's denominator — it is reported in its own
  //  bucket instead of being silently dropped.
  const cohort = rows.filter((r) => r.observed_visit && r._first_visit_in_window);
  const numerator = cohort.filter((r) => r.application_link === APPLICATION_LINK.EXACT).length;

  //  Rows that are IN the cohort but cannot be settled. TWO ways that happens,
  //  and both must count:
  //    · the credit is ambiguous — an unlinked application may belong here
  //    · the APPOINTMENT EVIDENCE ITSELF is unresolved. A conflicted or
  //      untrackable opportunity can carry an observed visit and still not be
  //      settled: the conflict may resolve to another opportunity entirely,
  //      moving the row out of this denominator. Counting it as decided merely
  //      because one occurrence was attended is the flattering read.
  const inCohortUnsettled = cohort.filter((r) =>
    r.application_link === APPLICATION_LINK.AMBIGUOUS
    || !RESOLVED.has(r.appointment_evidence_state));
  const ambiguous = inCohortUnsettled.length;

  //  Rows that could still ENTER the cohort: no visit yet, but unresolved
  //  evidence means one may still be recorded inside this window.
  const couldEnter = rows.filter((r) => !r.observed_visit
    && !RESOLVED.has(r.appointment_evidence_state)).length;

  const unresolved = ambiguous + couldEnter;
  const is_partial = unresolved > 0;

  return {
    populations: {
      opportunity_rows: rows.length,
      eligible_population: rows.filter((r) => r.metric_eligible).length,
      ...bucket,
    },
    reconciles: Object.values(bucket).reduce((a, b) => a + b, 0) === rows.length,
    cohort_size: cohort.length,
    numerator,
    partial: {
      is_partial,
      unresolved_count: unresolved,
      unresolved_in_cohort: ambiguous,
      could_still_enter_cohort: couldEnter,
      reason: is_partial
        ? "Unresolved appointment or application evidence can still change the numerator or the denominator, so no complete rate is published. The counts remain exact."
        : null,
    },
    cohort_opportunity_ids: cohort.map((r) => r.opportunity_id),
  };
}

// ── §MISSING — FACTS THIS FUNNEL NEEDS THAT DO NOT YET EXIST ─────────
//  Exposed, not solved here, and NOT worked around by reading current lead
//  status. Assigned to the already-sequenced `lead_events terminal/pending
//  truth` phase.
const MISSING_CANONICAL_FACTS = Object.freeze([
  {
    fact: "terminal opportunity truth",
    why_needed: "An opportunity with no observed visit and no future appointment cannot be distinguished between 'still live, nothing booked yet' and 'over, it never toured'. Both currently land in no_appointment.",
    forbidden_workaround: "reading leasing_leads.status or leasing_conversions.status as terminal truth",
    assigned_to: "lead_events terminal/pending truth",
  },
  {
    fact: "pending opportunity truth",
    why_needed: "Without it, a young opportunity and a dead one are the same row, so no_appointment cannot be split into pending and closed-without-tour.",
    forbidden_workaround: "elapsed time since opened_at",
    assigned_to: "lead_events terminal/pending truth",
  },
  {
    fact: "application→opportunity link coverage",
    why_needed: "lease_applications.conversion_id is nullable and historically sparse. Unlinked applications suppress the rate rather than being guessed onto an opportunity.",
    forbidden_workaround: "falling back to leasing_lead_id, which double-credits a lead with two opportunities",
    assigned_to: "not this cut — coverage is reported, never inferred",
  },
]);

module.exports = {
  opportunityFunnelRows, aggregateOpportunityFunnel, classifyEvidence,
  EVIDENCE, RESOLVED, APPLICATION_LINK, MISSING_CANONICAL_FACTS,
};
