// ════════════════════════════════════════════════════════════════════
//  conversion.js — Slice 9, step 5. The four funnels.
//
//      1. OPPORTUNITY           → observed visit
//      2. OPPORTUNITY w/ visit   → submitted application
//      3. submitted application  → approved application
//      4. approved application   → executed lease
//
//  Funnels 1 and 2 are two questions about ONE shared opportunity read, taken
//  under ONE coherent snapshot, so they cannot disagree about what happened.
//
//  ── EVERY FUNNEL IS AN ORIGIN COHORT ─────────────────────────────────
//  The denominator is entities whose ORIGIN event fell inside the
//  property-local window; outcomes are observed through as_of. Counting
//  "applications approved this month" against "applications submitted this
//  month" mixes two populations and produces a rate that can exceed 1.
//
//  ── PENDING IS REPORTED, NOT HIDDEN ──────────────────────────────────
//  A cohort from the last few days has not had time to convert. Without
//  pending_count a recent window looks like failure. Every funnel returns it.
//
//  ── CORRELATION IS CANONICAL OR IT IS UNTRACKABLE ────────────────────
//  Ruling 8. No matching on name, phone, email, unit similarity or time
//  proximity. Opportunity→application rides lease_applications.conversion_id;
//  application→lease rides executed_lease_records.application_id. Anything
//  without that link is counted as uncorrelated and stays visible.
//
//  ── THE FORMER "NO submitted_at" LIMITATION IS GONE ──────────────────
//  This header used to say lease_applications had no submitted_at, so Funnel 3
//  cohorted on created_at. Migration 124 added submitted_at, approved_at,
//  terminal_at and terminal_code, and the canonical lifecycle writer authors
//  them at the moment of transition. The note was stale and the columns were
//  simply never adopted. Funnels 3 and 4 now cohort on those DURABLE
//  MILESTONES; Funnel 4 uses approved_at rather than decided_at, which a
//  DENIAL also sets. A milestone reached with no timestamp (pre-migration
//  history) is UNTRACKABLE and makes the metric partial — never assumed into a
//  window.
//
//  ── SOURCE ATTRIBUTION STATES ITS ACTUAL GRAIN ───────────────────────
//  lead_source_touches is ORIGINATING LEAD SOURCE, lead-grained, inherited by
//  later opportunities on the same lead. It is NOT opportunity acquisition
//  source and is never labelled as one.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { buildMetric, FUNNEL_CONTRACTS } = require("./metric_contract");
const { resolveChains, journeyFinalStatus } = require("./tour_demand");
const {
  opportunityFunnelRows, aggregateOpportunityFunnel, MISSING_CANONICAL_FACTS,
  RESOLVED: RESOLVED_APPT,
} = require("./opportunity_funnel");

// ── NO SECOND COPY OF THE LADDER ────────────────────────────────────
//  This file used to carry its own LIFECYCLE_ORDER / TERMINATED / reached().
//  application_lifecycle_read.js exists precisely to stop that: "A second copy
//  is how the nine private ladders this module replaces came to exist." The
//  vocabulary and the milestone predicates now come from the one writer module,
//  BY REFERENCE. `reached` is kept as a thin adapter because the evidence proof
//  imports it, but it no longer defines anything.
const {
  LADDER, TERMINAL, reachedSubmission, reachedApproval, isTerminal,
} = require("../applications/application_lifecycle");

const LIFECYCLE_ORDER = LADDER;
const TERMINATED = new Set(TERMINAL);

function reached(status, milestone) {
  if (!status) return false;
  if (milestone === "submitted") return reachedSubmission(status);
  if (milestone === "approved") return reachedApproval(status);
  const i = LADDER.indexOf(status), m = LADDER.indexOf(milestone);
  return i >= 0 && m >= 0 && i >= m;
}

// ── BOUNDED TRANSPORT ────────────────────────────────────────────────
//  The service computes EVERY opportunity row (the aggregates must reconcile
//  to the full population), but the WIRE carries one bounded page. At 10,000
//  opportunities the full row set is ~12MB — a truthful number nobody should
//  ship to a browser. Summaries, coverage and suppression reasons stay
//  complete; the supporting rows page.
const PAGE_DEFAULT = 100;
const PAGE_MAX = 250;

const cursorEncode = (row, fhash) => Buffer.from(JSON.stringify(
  { o: row.opened_at ? new Date(row.opened_at).toISOString() : null,
    id: String(row.opportunity_id), f: fhash })).toString("base64url");
const cursorDecode = (cur) => {
  try { return JSON.parse(Buffer.from(String(cur), "base64url").toString("utf8")); }
  catch (_) { return null; }
};

//  Stable order: cohort timestamp (opened_at) ascending, then the opportunity
//  UUID as the deterministic tie-breaker. Server-authored; not configurable.
const rowOrder = (a, b) => {
  const ta = a.opened_at ? new Date(a.opened_at).getTime() : 0;
  const tb = b.opened_at ? new Date(b.opened_at).getTime() : 0;
  if (ta !== tb) return ta - tb;
  return String(a.opportunity_id) < String(b.opportunity_id) ? -1 : 1;
};

function pageSupportingRows(allRows, { rowsOpts = {}, sourceIdsBySource, asOfIso }) {
  //  WHITELISTED server-side filters — the ones a renderer genuinely needs.
  //  Anything else is ignored, never passed to matching.
  const f = {
    funnel: ["f1", "f2"].includes(rowsOpts.funnel) ? rowsOpts.funnel : null,
    evidence_state: rowsOpts.evidence_state || null,
    lifecycle_state: rowsOpts.lifecycle_state || null,
    pending_state: rowsOpts.pending_state || null,
    source_id: rowsOpts.source_id || null,
  };
  let rows = allRows;
  if (f.funnel === "f2") rows = rows.filter((r) => r.observed_visit === true);
  if (f.evidence_state) rows = rows.filter((r) => r.appointment_evidence_state === f.evidence_state);
  if (f.lifecycle_state) rows = rows.filter((r) => r.lifecycle_state === f.lifecycle_state);
  if (f.pending_state) rows = rows.filter((r) => r.pending_state === f.pending_state);
  if (f.source_id) {
    const inSrc = sourceIdsBySource.get(String(f.source_id)) || new Set();
    rows = rows.filter((r) => inSrc.has(String(r.opportunity_id)));
  }
  rows = [...rows].sort(rowOrder);

  const fhash = JSON.stringify(f);
  const limit = Math.max(1, Math.min(PAGE_MAX, Number(rowsOpts.limit) || PAGE_DEFAULT));

  let start = 0, cursor_rejected = null;
  if (rowsOpts.cursor) {
    const cur = cursorDecode(rowsOpts.cursor);
    if (!cur || cur.f !== fhash) {
      //  A cursor minted under different filters cannot honestly continue this
      //  sequence. Said plainly; the response restarts from the first page.
      cursor_rejected = "The cursor does not match these filters; starting from the first page.";
    } else {
      start = rows.findIndex((r) =>
        (new Date(r.opened_at || 0).getTime() > new Date(cur.o || 0).getTime())
        || (String(new Date(r.opened_at || 0).toISOString()) === String(cur.o)
            && String(r.opportunity_id) > String(cur.id)));
      if (start < 0) start = rows.length;
    }
  }

  const page = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  return {
    page,
    page_size: page.length,
    default_page_size: PAGE_DEFAULT,
    max_page_size: PAGE_MAX,
    total_matching: rows.length,
    total_rows: allRows.length,
    cursor: hasMore ? cursorEncode(page[page.length - 1], fhash) : null,
    ...(cursor_rejected ? { cursor_rejected } : {}),
    filters: f,
    sort: "opened_at asc, opportunity_id asc — server-authored, deterministic",
    as_of_utc: asOfIso,
    snapshot_note: "Each page is its own coherent repeatable-read response at its own as_of. One database snapshot does NOT persist across HTTP requests.",
  };
}

async function conversionFunnels(pool, window, rowsOpts = {}) {
  const unavailable = (code) => buildMetric({ metric_code: code, window });
  const CODES = {
    f1all: "s9.conversion.all_opportunity_to_completed_tour.v1",
    f1src: "s9.conversion.attributed_opportunity_to_completed_tour.v1",
    f2: "s9.conversion.opportunity_observed_visit_to_submitted_application.v1",
    f3: "s9.conversion.submitted_application_to_approved.v1",
    f4: "s9.conversion.approved_application_to_executed_lease.v1",
  };

  if (!window || window.state !== "ok") {
    return {
      state: "unavailable",
      reason: window ? window.reason : "operating_window_unresolved",
      metrics: Object.fromEntries(Object.entries(CODES).map(([k, c]) => [k, unavailable(c)])),
      by_source: [],
    };
  }

  const propertyId = window.property_id;
  const startUtc = window.window_start_utc, endUtc = window.window_end_utc;
  const asOfMs = new Date(window.as_of_utc).getTime();
  const within = (d) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    return t >= new Date(startUtc).getTime() && t < new Date(endUtc).getTime();
  };
  const observed = (d) => !!d && new Date(d).getTime() <= asOfMs;

  // ── shared source data ────────────────────────────────────────────
  const tours = (await pool.query(
    `select id, lead_id, status, rescheduled_from, created_at, completed_at
       from leasing_tours where property_id=$1`, [propertyId])).rows;
  const apps = (await pool.query(
    `select id, leasing_lead_id, conversion_id, status, created_at, decided_at,
            submitted_at, approved_at, terminal_at, terminal_code, executed_lease_record_id
       from lease_applications where property_id=$1`, [propertyId])).rows;
  const execs = (await pool.query(
    `select id, application_id, executed_at, record_state, admission_status
       from executed_lease_records where property_id=$1`, [propertyId])).rows;

  const { rootById, untrackable } = resolveChains(tours);
  const legsByRoot = new Map();
  for (const t of tours) {
    const id = String(t.id);
    if (untrackable.has(id)) continue;
    const root = rootById.get(id);
    if (!legsByRoot.has(root)) legsByRoot.set(root, []);
    legsByRoot.get(root).push(t);
  }
  const journeys = [...legsByRoot.entries()].map(([root, legs]) => {
    legs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return {
      root, lead_id: legs[0].lead_id,
      opened_at: legs[0].created_at,
      final_status: journeyFinalStatus(legs),
      completed_at: legs.map((l) => l.completed_at).filter(Boolean).sort()[0] || null,
    };
  });

  // ── THE SHARED OPPORTUNITY READ ───────────────────────────────────
  //  ONE read, under ONE coherent snapshot, feeding BOTH opportunity-grained
  //  funnels. Funnels 1 and 2 are two questions about the same rows, so they
  //  cannot disagree about what happened.
  const f2rows = await opportunityFunnelRows(pool, window);
  const f2agg = aggregateOpportunityFunnel(f2rows.rows);

  // ── FUNNEL 1 — OPPORTUNITY → OBSERVED VISIT ───────────────────────
  //  RE-GRAINED. The denominator was `leasing_leads` received in the window —
  //  LEAD grain — and the numerator credited a lead whose tour STATUS looked
  //  completed. Both now come from the SAME opportunity rows Funnel 2 reads, so
  //  the two funnels cannot disagree about what happened.
  //
  //  Attendance comes from the appointment-journey authority. Pending comes from
  //  the LIFECYCLE authority — a real unresolved act — not from "a tour status
  //  that still looks alive".
  const f1cohort = f2rows.rows.filter((r) => within(r.opened_at));
  const f1num = f1cohort.filter((r) => r.observed_visit === true).length;
  const f1pending = f1cohort.filter((r) => r.observed_visit !== true
    && r.pending_state === "pending").length;
  const f1terminalNoVisit = f1cohort.filter((r) => r.observed_visit !== true
    && r.terminal === true).length;
  const f1unresolved = f1cohort.filter((r) => r.observed_visit !== true
    && !RESOLVED_APPT.has(r.appointment_evidence_state)).length;
  const f1partial = {
    is_partial: f1unresolved > 0,
    unresolved_count: f1unresolved,
    reason: f1unresolved > 0
      ? "Unresolved appointment evidence can still change this numerator, so no complete rate is published. The counts remain exact."
      : null,
  };
  const opps = f1cohort;

  //  Source attribution stays LEAD-keyed — lead_source_touches is a lead-grained
  //  fact and is NOT re-grained. But the unit counted is the OPPORTUNITY, so one
  //  touch attributes every opportunity that lead opened in the window.
  //  OVERLAPPING by construction; never additive.
  const leadIds = [...new Set(f1cohort.map((o) => o.context && o.context.lead_id).filter(Boolean))];
  const touches = leadIds.length ? (await pool.query(
    `select t.lead_id, t.source_id, coalesce(s.name,'(unknown source)') as source_name
       from lead_source_touches t left join lead_sources s on s.id=t.source_id
      where t.lead_id = any($1::uuid[])`, [leadIds])).rows : [];
  const oppsByLead = new Map();
  for (const o of f1cohort) {
    const k = o.context && o.context.lead_id ? String(o.context.lead_id) : null;
    if (!k) continue;
    if (!oppsByLead.has(k)) oppsByLead.set(k, []);
    oppsByLead.get(k).push(o);
  }
  const visited = new Set(f1cohort.filter((r) => r.observed_visit === true)
    .map((r) => String(r.opportunity_id)));
  const srcMap = new Map();
  for (const t of touches) {
    const k = t.source_id ? String(t.source_id) : "unknown";
    if (!srcMap.has(k)) srcMap.set(k, { source_id: t.source_id || null, source: t.source_name, ids: new Set() });
    for (const o of (oppsByLead.get(String(t.lead_id)) || [])) srcMap.get(k).ids.add(String(o.opportunity_id));
  }
  //  ── SOURCE-ATTRIBUTION BASIS, FROZEN ─────────────────────────────
  //  lead_source_touches records the ARRIVAL OF A LEAD FROM A SOURCE
  //  (migration 038: lead_id, source_id, arrived_at, source_listing_id). It is
  //  lead-grained, permits several touches per lead, and is NEVER recorded per
  //  opportunity.
  //
  //  A lead can carry SEVERAL opportunities. For the first, the touch is a fair
  //  acquisition record. For any later one, the source was NOT independently
  //  recorded — it is INHERITED. So this is:
  //
  //      ORIGINATING LEAD SOURCE, inherited by later opportunities on the same
  //      lead, with INCOMPLETE opportunity attribution.
  //
  //  It is NOT "opportunity acquisition source", and is never labelled as one.
  //  No product contract says every opportunity for a lead shares an
  //  acquisition source, so claiming it would be a confident wrong.
  //
  //  CONSEQUENCE: when any lead in the cohort carries MORE THAN ONE
  //  opportunity, a source-segmented rate could change under a correct
  //  per-opportunity source. That makes the segmented metric PARTIAL — the
  //  counts stay exact and the rate is withheld.
  const multiOppLeads = [...oppsByLead.entries()].filter(([, v]) => v.length > 1);
  const inheritedOpportunities = multiOppLeads.reduce((n, [, v]) => n + (v.length - 1), 0);
  const sourceBasis = {
    basis: "originating_lead_source",
    grain: "lead",
    counted_unit: "opportunity",
    independently_recorded_per_opportunity: false,
    inherited_opportunity_count: inheritedOpportunities,
    leads_with_multiple_opportunities: multiOppLeads.length,
    disclosure: "lead_source_touches records a lead's ARRIVAL from a source. It is lead-grained and was not recorded per opportunity. Where one lead carries several opportunities, the later ones INHERIT this source rather than having had it observed. This is originating lead source as context — not opportunity acquisition source.",
  };
  const sourcePartial = {
    is_partial: inheritedOpportunities > 0,
    unresolved_count: inheritedOpportunities,
    reason: inheritedOpportunities > 0
      ? "One or more leads in this cohort carry several opportunities, so the source shown for the later ones is inherited, not observed. A correct per-opportunity source could change these rates, so none is published. The counts remain exact."
      : null,
  };

  const by_source = [...srcMap.values()].map((s) => {
    const den = s.ids.size;
    const num = [...s.ids].filter((id) => visited.has(id)).length;
    return buildMetric({
      metric_code: CODES.f1src, window, numerator: num, denominator: den,
      partial: sourcePartial,
      exclusions: ["opportunities opened outside the window"],
      provenance: `lead_source_touches for source ${s.source}. ORIGINATING LEAD SOURCE, lead-grained, inherited by later opportunities on the same lead — NOT an opportunity acquisition source. Overlapping, non-additive.`,
      extra: { source_id: s.source_id, source: s.source, source_attribution: sourceBasis },
    });
  }).sort((a, b) => (b.denominator || 0) - (a.denominator || 0));

  // ── FUNNEL 2 — OPPORTUNITY with an observed visit → submitted application ──
  //  RE-GRAINED. One row per durable opportunity, never per chain or lead.
  //  Attendance comes from the canonical appointment-journey projection; this
  //  file no longer derives Funnel 2 from leasing_tours.status at all.

  // Correlation coverage: applications with no canonical opportunity link.
  const uncorrelatedApps = apps.filter((a) => !a.leasing_lead_id).length;
  const correlatedApps = apps.length - uncorrelatedApps;

  // ── FUNNEL 3 — SUBMITTED → APPROVED, ON DURABLE MILESTONES ────────
  //  Migration 124 added lease_applications.submitted_at / approved_at, and the
  //  canonical lifecycle writer authors them at the moment each transition
  //  happens. This funnel used created_at as the submission instant and carried
  //  a note saying "lease_applications has no submitted_at". THAT NOTE WAS
  //  STALE — the column exists on this branch and was simply never adopted, so
  //  an application drafted in one window and submitted in the next was
  //  attributed to the wrong window.
  //
  //  Cohorting is now on the REAL submission instant. An application that
  //  reached submission but carries no submitted_at is pre-milestone history:
  //  it cannot be dated, so it is UNTRACKABLE, never assumed into a window.
  const submissionReached = apps.filter((a) => reached(a.status, "submitted") || a.submitted_at);
  const submittedDated = submissionReached.filter((a) => a.submitted_at);
  const submitted = submittedDated.filter((a) => within(a.submitted_at));
  const f3undateable = submissionReached.length - submittedDated.length;

  //  Approval is the milestone, not the current label: an application that
  //  advanced past approved still reached it, and one later withdrawn still
  //  reached it. approved_at is the durable proof of that.
  const f3num = submitted.filter((a) => a.approved_at && observed(a.approved_at)).length;
  const f3pending = submitted.filter((a) => !a.approved_at && !TERMINATED.has(a.status)).length;
  const f3partial = {
    is_partial: f3undateable > 0,
    unresolved_count: f3undateable,
    reason: f3undateable > 0
      ? "Some applications reached submission without a durable submitted_at (pre-milestone history). They cannot be placed in a window, so no complete rate is published. The counts remain exact."
      : null,
  };

  // ── FUNNEL 4 — APPROVED → EXECUTED LEASE, ON DURABLE MILESTONES ───
  //  Was cohorted on decided_at — a general decision timestamp that is also set
  //  by a DENIAL. approved_at means approval specifically.
  const approvalReached = apps.filter((a) => reached(a.status, "approved") || a.approved_at);
  const approvedDated = approvalReached.filter((a) => a.approved_at);
  const f4cohort = approvedDated.filter((a) => within(a.approved_at));
  const f4untrackable = approvalReached.length - approvedDated.length;

  const execByApp = new Map();
  for (const e of execs) {
    if (!e.application_id) continue;
    // Admission is the canonical execution rule — an unsigned packet or a
    // signature without completed admission is not an executed lease.
    const admitted = String(e.admission_status || "").toLowerCase() === "admitted"
      && String(e.record_state || "active") !== "void";
    if (admitted && observed(e.executed_at)) execByApp.set(String(e.application_id), e);
  }
  const f4num = f4cohort.filter((a) => execByApp.has(String(a.id))).length;
  const f4pending = f4cohort.filter((a) => !execByApp.has(String(a.id))
    && !TERMINATED.has(a.status)).length;
  const uncorrelatedLeases = execs.filter((e) => !e.application_id).length;

  //  SERVER-AUTHORED: how many distinct opportunities carry incomplete
  //  evidence (unresolved appointment state, or an unlinked application that
  //  may belong). The browser renders this number in the partial banner; it
  //  never counts anything itself.
  const unresolvedOpportunityCount = f2rows.rows.filter((r) =>
    !RESOLVED_APPT.has(r.appointment_evidence_state)
    || r.application_link === "unlinked_application_may_belong").length;

  return {
    state: "ok",
    unresolved_opportunity_count: unresolvedOpportunityCount,
    //  THE FROZEN CONTRACTS ride the response by reference — the browser and
    //  every other reader consume the meaning, never re-derive it.
    contracts: FUNNEL_CONTRACTS,
    //  ONE BOUNDED PAGE of the rows the aggregates were computed from —
    //  complete summaries, paged evidence. total_rows lets a reader reconcile
    //  the aggregate without shipping 10,000 rows to a browser.
    supporting_rows: pageSupportingRows(
      f2rows.rows.map(({ _first_visit_in_window, ...r }) => r),
      { rowsOpts,
        sourceIdsBySource: new Map([...srcMap.values()].map((x) => [String(x.source_id), x.ids])),
        asOfIso: window.as_of_utc }),
    correlation: {
      applications_total: apps.length,
      correlated_count: correlatedApps,
      uncorrelated_count: uncorrelatedApps,
      correlation_rate: apps.length ? Number((correlatedApps / apps.length).toFixed(6)) : null,
      uncorrelated_executed_leases: uncorrelatedLeases,
      note: "Correlation is canonical only — leasing_leads.id for tour→application and executed_lease_records.application_id for application→lease. Uncorrelated records stay visible and are never assigned to a funnel by inference.",
    },
    by_source,
    source_attribution: sourceBasis,
    metrics: {
      f1all: buildMetric({
        metric_code: CODES.f1all, window, numerator: f1num, denominator: f1cohort.length,
        counts: { pending: f1pending, unknown: f1unresolved,
                  untrackable: f2agg.populations.untrackable + f2agg.populations.conflict },
        partial: f1partial,
        exclusions: ["opportunities opened outside the window"],
        provenance: "ONE ROW PER leasing_conversions.id opened in the window. A visit is an OBSERVED attendance from the canonical appointment-journey projection — never a tour status, never elapsed time. Pending is a real unresolved act from the lifecycle authority, never 'not terminal'.",
        extra: {
          terminal_without_visit: f1terminalNoVisit,
          populations: f2agg.populations,
          lifecycle_split: f2agg.lifecycle_split,
        },
      }),
      f2: buildMetric({
        metric_code: CODES.f2, window,
        numerator: f2agg.numerator, denominator: f2agg.cohort_size,
        counts: {
          pending: f2agg.populations.pending_future_appointment,
          unknown: f2agg.populations.unresolved_past_appointment,
          untrackable: f2agg.populations.untrackable + f2agg.populations.conflict,
        },
        partial: f2agg.partial,
        exclusions: [
          "opportunities whose first observed visit falls outside the window",
          "opportunities with no observed visit — reported in their own populations, never dropped",
        ],
        provenance: "ONE ROW PER leasing_conversions.id. Attendance from the canonical appointment-journey projection (never elapsed time, lead status or flattened conversion fields). Credit rides lease_applications.conversion_id ONLY — leasing_lead_id is never used to award a conversion.",
        extra: {
          populations: f2agg.populations,
          reconciles: f2agg.reconciles,
          coverage: f2rows.coverage,
          missing_canonical_facts: MISSING_CANONICAL_FACTS,
        },
      }),
      f3: buildMetric({
        metric_code: CODES.f3, window, numerator: f3num, denominator: submitted.length,
        counts: { pending: f3pending, untrackable: f3undateable },
        partial: f3partial,
        exclusions: ["applications that never reached submission",
                     "applications that reached submission with no durable submitted_at — undateable, never assumed into a window"],
        provenance: "DURABLE MILESTONES (migration 124): submitted_at is the submission instant and approved_at the approval instant, authored by the canonical lifecycle writer at the moment of transition. Milestone achievement, not current status — an application later withdrawn still reached approval, and approved_at still proves it.",
        extra: { submission_reached_without_timestamp: f3undateable },
      }),
      f4: buildMetric({
        metric_code: CODES.f4, window, numerator: f4num, denominator: f4cohort.length,
        counts: { pending: f4pending, untrackable: f4untrackable },
        exclusions: ["approvals with no approved_at — cannot be dated, so not assumed into a window"],
        provenance: "approved_at (migration 124) as the approval instant — NOT decided_at, which a DENIAL also sets. Execution requires an admitted, non-void executed_lease_record correlated by application_id.",
        extra: { approved_without_decision_timestamp: f4untrackable, uncorrelated_executed_leases: uncorrelatedLeases },
      }),
    },
  };
}

module.exports = { conversionFunnels, reached, LIFECYCLE_ORDER };
