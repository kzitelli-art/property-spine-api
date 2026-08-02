// ════════════════════════════════════════════════════════════════════
//  conversion.js — Slice 9, step 5. The four funnels.
//
//      1. opportunity            → completed tour
//      2. completed tour         → submitted application
//      3. submitted application  → approved application
//      4. approved application   → executed lease
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
//  proximity. Tour→application rides leasing_leads.id
//  (leasing_tours.lead_id ↔ lease_applications.leasing_lead_id);
//  application→lease rides executed_lease_records.application_id. Anything
//  without that link is counted as uncorrelated and stays visible.
//
//  ── A KNOWN LIMITATION, STATED RATHER THAN SMOOTHED ──────────────────
//  lease_applications has no submitted_at. Funnel 3's origin instant
//  therefore uses created_at for applications that have REACHED the submitted
//  milestone. An application drafted in one window and submitted in the next
//  is attributed to the window it was created in. This is disclosed in the
//  metric's provenance and exclusions rather than quietly assumed, and it is
//  raised in the handback as a question canonical truth does not answer.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { buildMetric } = require("./metric_contract");
const { resolveChains, journeyFinalStatus } = require("./tour_demand");
const {
  opportunityFunnelRows, aggregateOpportunityFunnel, MISSING_CANONICAL_FACTS,
} = require("./opportunity_funnel");

// Canonical lifecycle vocabulary from migration 033. Milestone achievement is
// "reached at least this far", never current-status equality: an application
// that advanced to countersigned still reached approved.
const LIFECYCLE_ORDER = ["draft", "submitted", "approved", "lease_ready", "tenant_signed", "countersigned", "active"];
const TERMINATED = new Set(["declined", "withdrawn"]);

function reached(status, milestone) {
  if (!status) return false;
  if (TERMINATED.has(status)) return milestone === "submitted" && status !== "draft";
  const i = LIFECYCLE_ORDER.indexOf(status);
  const m = LIFECYCLE_ORDER.indexOf(milestone);
  return i >= 0 && m >= 0 && i >= m;
}

async function conversionFunnels(pool, window) {
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
    `select id, leasing_lead_id, status, created_at, decided_at, executed_lease_record_id
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

  // ── FUNNEL 1 — opportunity → completed tour ───────────────────────
  const opps = (await pool.query(
    `select id, received_at from leasing_leads
      where property_id=$1 and received_at >= $2::timestamptz and received_at < $3::timestamptz`,
    [propertyId, startUtc, endUtc])).rows;

  const completedByLead = new Set(
    journeys.filter((j) => j.final_status === "completed" && observed(j.completed_at))
      .map((j) => String(j.lead_id)));
  const f1num = opps.filter((o) => completedByLead.has(String(o.id))).length;
  // Pending: no completed tour yet, and the opportunity is recent enough that
  // absence is not yet an outcome.
  const f1pending = opps.filter((o) => !completedByLead.has(String(o.id))
    && journeys.some((j) => String(j.lead_id) === String(o.id)
      && ["scheduled", "requested", "confirmed_by_prospect", "checked_in"].includes(j.final_status))).length;

  // Source rows: OVERLAPPING by construction.
  const touches = opps.length ? (await pool.query(
    `select t.lead_id, t.source_id, coalesce(s.name,'(unknown source)') as source_name
       from lead_source_touches t left join lead_sources s on s.id=t.source_id
      where t.lead_id = any($1::uuid[])`, [opps.map((o) => o.id)])).rows : [];
  const srcMap = new Map();
  for (const t of touches) {
    const k = t.source_id ? String(t.source_id) : "unknown";
    if (!srcMap.has(k)) srcMap.set(k, { source_id: t.source_id || null, source: t.source_name, ids: new Set() });
    srcMap.get(k).ids.add(String(t.lead_id));
  }
  const by_source = [...srcMap.values()].map((s) => {
    const den = s.ids.size;
    const num = [...s.ids].filter((id) => completedByLead.has(id)).length;
    return buildMetric({
      metric_code: CODES.f1src, window, numerator: num, denominator: den,
      exclusions: ["opportunities received outside the window"],
      provenance: `lead_source_touches for source ${s.source}; overlapping, non-additive`,
      extra: { source_id: s.source_id, source: s.source },
    });
  }).sort((a, b) => (b.denominator || 0) - (a.denominator || 0));

  // ── FUNNEL 2 — OPPORTUNITY with an observed visit → submitted application ──
  //  RE-GRAINED. One row per durable opportunity, never per chain or lead.
  //  Attendance comes from the canonical appointment-journey projection; this
  //  file no longer derives Funnel 2 from leasing_tours.status at all.
  const f2rows = await opportunityFunnelRows(pool, window);
  const f2agg = aggregateOpportunityFunnel(f2rows.rows);

  // Correlation coverage: applications with no canonical opportunity link.
  const uncorrelatedApps = apps.filter((a) => !a.leasing_lead_id).length;
  const correlatedApps = apps.length - uncorrelatedApps;

  // ── FUNNEL 3 — submitted → approved ───────────────────────────────
  const submitted = apps.filter((a) => reached(a.status, "submitted") && within(a.created_at));
  const f3num = submitted.filter((a) => reached(a.status, "approved")
    && (a.decided_at ? observed(a.decided_at) : true)).length;
  const f3pending = submitted.filter((a) => a.status === "submitted").length;

  // ── FUNNEL 4 — approved → executed lease ──────────────────────────
  //  Approval instant is decided_at where recorded; applications that reached
  //  approval without one cannot be dated and are untrackable, not assumed.
  const approvedAll = apps.filter((a) => reached(a.status, "approved"));
  const approvedDated = approvedAll.filter((a) => a.decided_at);
  const f4cohort = approvedDated.filter((a) => within(a.decided_at));
  const f4untrackable = approvedAll.length - approvedDated.length;

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

  return {
    state: "ok",
    //  The opportunity rows the Funnel 2 aggregate is computed from. Published
    //  so the aggregate can be RECONCILED against its own inputs rather than
    //  trusted — every population count above is derivable from these rows.
    //  The internal cohort-membership marker is stripped; it is not contract.
    opportunity_rows: f2rows.rows.map(({ _first_visit_in_window, ...r }) => r),
    correlation: {
      applications_total: apps.length,
      correlated_count: correlatedApps,
      uncorrelated_count: uncorrelatedApps,
      correlation_rate: apps.length ? Number((correlatedApps / apps.length).toFixed(6)) : null,
      uncorrelated_executed_leases: uncorrelatedLeases,
      note: "Correlation is canonical only — leasing_leads.id for tour→application and executed_lease_records.application_id for application→lease. Uncorrelated records stay visible and are never assigned to a funnel by inference.",
    },
    by_source,
    metrics: {
      f1all: buildMetric({
        metric_code: CODES.f1all, window, numerator: f1num, denominator: opps.length,
        counts: { pending: f1pending, untrackable: untrackable.size },
        exclusions: ["opportunities received outside the window", "tours in chains that resolve to no single root"],
        provenance: "leasing_leads received in window; completed appointment journeys observed through as_of",
        extra: { completed_journeys_in_cohort: f1num },
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
        counts: { pending: f3pending },
        exclusions: ["applications still in draft"],
        provenance: "MILESTONE achievement, not current status: an application that advanced past approved still reached it. LIMITATION: lease_applications has no submitted_at, so created_at is used as the submission instant.",
      }),
      f4: buildMetric({
        metric_code: CODES.f4, window, numerator: f4num, denominator: f4cohort.length,
        counts: { pending: f4pending, untrackable: f4untrackable },
        exclusions: ["approvals with no decided_at — cannot be dated, so not assumed into a window"],
        provenance: "decided_at as the approval instant; execution requires an admitted, non-void executed_lease_record correlated by application_id",
        extra: { approved_without_decision_timestamp: f4untrackable, uncorrelated_executed_leases: uncorrelatedLeases },
      }),
    },
  };
}

module.exports = { conversionFunnels, reached, LIFECYCLE_ORDER };
