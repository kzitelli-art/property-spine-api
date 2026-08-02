// ════════════════════════════════════════════════════════════════════
//  metric_contract.js — the ONE shape every Slice 9 evidence metric returns.
//
//  The Slice 9 audit found a single conversion metric publishing two
//  different numbers under one field name, with no window, no as_of, no
//  owner and no version. This module exists so that cannot recur: a metric
//  that does not go through buildMetric() does not get to be a metric.
//
//  ── THE RULES, ENFORCED HERE RATHER THAN REMEMBERED ──────────────────
//   · rate is a DECIMAL 0–1. The browser formats the percentage. A server
//     that returns "33.3%" has made a presentation decision and thrown away
//     precision on the way.
//   · denominator 0 ⇒ rate null. NEVER 0%. Zero percent is a claim that
//     nothing converted; no denominator is a statement that nothing was
//     measured. They are different facts and an operator acts differently
//     on each.
//   · a missing timezone ⇒ state 'unavailable' with the one shared reason.
//     No UTC fallback, ever.
//   · a missing canonical correlation ⇒ untrackable. Never inferred.
//   · an unknown fact ⇒ unknown. Never silently excluded — dropping unknowns
//     flatters every funnel they touch.
//
//  ── VERSIONING ───────────────────────────────────────────────────────
//  metric_code carries an explicit version: s9.opportunity_completed_tour.v1.
//  Changing a denominator, a stage definition, an attribution model or a
//  deduplication key requires a NEW version, because the old number and the
//  new one are not comparable and a chart that silently switches between them
//  is worse than no chart.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { TZ_UNAVAILABLE } = require("../shared/property_timezone");

//  'partial' is a fourth honest state, distinct from the other three: the
//  cohort was measured and its COUNTS are exact, but unresolved evidence can
//  still move the numerator or the denominator, so no rate is published. It is
//  not an error and not an absence — publishing a complete-looking percentage
//  over only the resolved subset would be the lie it exists to prevent.
const METRIC_STATES = Object.freeze(["ok", "partial", "unavailable", "unsupported"]);

const ATTRIBUTION_MODELS = Object.freeze([
  "deduplicated_opportunity",   // one row per opportunity; partitions the population
  "multi_touch_non_additive",   // one opportunity may appear under several sources
  "appointment_journey",        // one root reschedule chain = one journey
  "origin_cohort",              // entities whose ORIGIN event fell in the window
]);

// Registry of every metric Slice 9 authors. A code not listed here cannot be
// built — that is the point.
const METRIC_DEFINITIONS = Object.freeze({
  "s9.lead_demand.opportunities_received.v1": {
    label: "Opportunities received",
    cohort_basis: "opportunities whose received_at falls inside the property-local window",
    deduplication_key: "leasing_leads.id",
    attribution_model: "deduplicated_opportunity",
    source_tables: ["leasing_leads"],
  },
  "s9.lead_demand.first_response_coverage.v1": {
    label: "First-response coverage",
    cohort_basis: "opportunities received in the window; numerator are those with a recorded first response",
    deduplication_key: "leasing_leads.id",
    attribution_model: "deduplicated_opportunity",
    source_tables: ["leasing_leads"],
  },
  "s9.tour_demand.appointment_journeys.v1": {
    label: "Appointment journeys",
    cohort_basis: "root reschedule chains whose first booking falls inside the window",
    deduplication_key: "root leasing_tours.id of the reschedule chain",
    attribution_model: "appointment_journey",
    source_tables: ["leasing_tours"],
  },
  "s9.tour_demand.outcome_capture_completeness.v1": {
    label: "Tour outcome capture",
    cohort_basis: "completed appointment journeys in the window; numerator are those with a captured outcome",
    deduplication_key: "root leasing_tours.id of the reschedule chain",
    attribution_model: "appointment_journey",
    source_tables: ["leasing_tours", "tour_outcome_prompts"],
  },
  "s9.conversion.all_opportunity_to_completed_tour.v1": {
    label: "Opportunity → completed tour",
    cohort_basis: "deduplicated opportunities received inside the window; outcomes observed through as_of",
    deduplication_key: "leasing_leads.id",
    attribution_model: "origin_cohort",
    source_tables: ["leasing_leads", "leasing_tours"],
  },
  "s9.conversion.attributed_opportunity_to_completed_tour.v1": {
    label: "Opportunity → completed tour, by source",
    cohort_basis: "distinct opportunities carrying a touch from this source, received inside the window",
    deduplication_key: "leasing_leads.id within lead_source_touches.source_id",
    attribution_model: "multi_touch_non_additive",
    source_tables: ["leasing_leads", "lead_source_touches", "leasing_tours"],
  },
  //  RETIRED, deliberately kept registered. The chain-grained v1 is no longer
  //  published: its denominator counted appointment chains while its numerator
  //  was credited from the LEAD, so one application could convert two chains.
  //  It is superseded by the opportunity-grained code below. The definition
  //  stays here so a stored historical number can still be explained, and so
  //  the code can never be quietly reused for a different population.
  "s9.conversion.completed_tour_to_submitted_application.v1": {
    label: "Completed tour → submitted application (RETIRED — chain grain)",
    cohort_basis: "appointment journeys whose completed event falls inside the window",
    deduplication_key: "root leasing_tours.id of the reschedule chain",
    attribution_model: "origin_cohort",
    source_tables: ["leasing_tours", "lease_applications"],
    retired: true,
    superseded_by: "s9.conversion.opportunity_observed_visit_to_submitted_application.v1",
    retirement_reason: "denominator was appointment-chain grained while the numerator was credited from the lead; two chains on one lead double-counted a single application",
  },

  //  A NEW CODE, not a bumped version: the denominator, the stage definition,
  //  the attribution model and the deduplication key ALL changed. The old
  //  number and the new one measure different populations and are not
  //  comparable, so they must not share a code.
  "s9.conversion.opportunity_observed_visit_to_submitted_application.v1": {
    label: "Opportunity with an observed visit → submitted application",
    cohort_basis: "durable leasing opportunities whose FIRST OBSERVED VISIT falls inside the property-local window; attendance comes from the canonical appointment-journey projection, never from elapsed time, lead status or flattened conversion fields",
    deduplication_key: "leasing_conversions.id",
    attribution_model: "deduplicated_opportunity",
    source_tables: ["leasing_conversions", "leasing_tours", "scheduled_tours",
                    "scheduled_tour_revisions", "tour_events", "lease_applications"],
  },
  "s9.conversion.submitted_application_to_approved.v1": {
    label: "Submitted application → approved",
    cohort_basis: "applications whose submission event falls inside the window; approval is a MILESTONE reached, not a current status",
    deduplication_key: "lease_applications.id",
    attribution_model: "origin_cohort",
    source_tables: ["lease_applications"],
  },
  "s9.conversion.approved_application_to_executed_lease.v1": {
    label: "Approved application → executed lease",
    cohort_basis: "applications whose approval milestone falls inside the window",
    deduplication_key: "lease_applications.id",
    attribution_model: "origin_cohort",
    source_tables: ["lease_applications", "executed_lease_records"],
  },
});

function definitionFor(metric_code) {
  const def = METRIC_DEFINITIONS[metric_code];
  if (!def) {
    const e = new Error(`Unknown metric_code: ${metric_code}. Metrics must be registered before they can be published.`);
    e.code = "metric_not_registered";
    throw e;
  }
  return def;
}

// definition_version is derived from the code rather than tracked separately,
// so the two can never drift apart.
function versionOf(metric_code) {
  const m = /\.(v\d+)$/.exec(metric_code);
  if (!m) {
    const e = new Error(`metric_code must end in an explicit version: ${metric_code}`);
    e.code = "metric_code_unversioned";
    throw e;
  }
  return m[1];
}

/**
 * buildMetric — the ONLY way a Slice 9 number reaches a caller.
 *
 *   metric_code   registered code, version-suffixed
 *   window        a resolveOperatingWindow() result
 *   numerator     integer, or null when not applicable (count-only metrics)
 *   denominator   integer
 *   counts        { pending, unknown, untrackable }
 *   exclusions    array of stated exclusion strings
 *   provenance    free-form note about how the figure was obtained
 */
function buildMetric({
  metric_code, window, numerator = null, denominator = null,
  counts = {}, exclusions = [], provenance = null, extra = null, partial = null,
} = {}) {
  const def = definitionFor(metric_code);
  const definition_version = versionOf(metric_code);

  const base = {
    metric_code,
    definition_version,
    label: def.label,
    property_id: window ? window.property_id : null,
    operating_timezone: window ? window.operating_timezone : null,
    window_start_local: window ? window.window_start_local : null,
    window_end_local: window ? window.window_end_local : null,
    window_start_utc: window ? window.window_start_utc : null,
    window_end_utc: window ? window.window_end_utc : null,
    as_of_utc: window ? window.as_of_utc : null,
    cohort_basis: def.cohort_basis,
    attribution_model: def.attribution_model,
    deduplication_key: def.deduplication_key,
    source_tables: def.source_tables,
  };

  // No operating day ⇒ no metric. Never a UTC-bucketed substitute.
  if (!window || window.state !== "ok") {
    return {
      ...base,
      state: "unavailable",
      reason: (window && window.reason) || TZ_UNAVAILABLE.reason,
      numerator: null, denominator: null, rate: null,
      pending_count: null, unknown_count: null, untrackable_count: null,
      exclusions: [], provenance: null,
    };
  }

  const den = denominator == null ? null : Number(denominator);
  const num = numerator == null ? null : Number(numerator);

  // THE ZERO-DENOMINATOR RULE. 0% is a claim that nothing converted; a null
  // rate says nothing was measured. They are different facts.
  let rate = null;
  if (num != null && den != null && den > 0) {
    rate = Number((num / den).toFixed(6));
  }

  // THE PARTIAL RULE. If unresolved evidence can still move the numerator or
  // the denominator, no rate is published — publishing one computed over only
  // the trackable subset, while presenting it as the whole cohort, is exactly
  // the flattering lie this contract exists to prevent. THE COUNTS SURVIVE:
  // suppressing a rate must never also hide the numbers that explain it.
  const isPartial = !!(partial && partial.is_partial);
  if (isPartial) rate = null;

  return {
    ...base,
    state: isPartial ? "partial" : "ok",
    ...(isPartial ? { reason: partial.reason || "unresolved evidence can change this metric", partial } : {}),
    numerator: num,
    denominator: den,
    rate,
    pending_count: counts.pending == null ? 0 : Number(counts.pending),
    unknown_count: counts.unknown == null ? 0 : Number(counts.unknown),
    untrackable_count: counts.untrackable == null ? 0 : Number(counts.untrackable),
    exclusions: Array.isArray(exclusions) ? exclusions : [],
    provenance: provenance || null,
    ...(extra && typeof extra === "object" ? { detail: extra } : {}),
  };
}

// A metric that exists in the registry but cannot be computed for a stated
// structural reason — distinct from 'unavailable' (a missing timezone).
function unsupportedMetric(metric_code, reason, window = null) {
  const def = definitionFor(metric_code);
  return {
    metric_code, definition_version: versionOf(metric_code), label: def.label,
    property_id: window ? window.property_id : null,
    operating_timezone: window ? window.operating_timezone : null,
    window_start_local: window ? window.window_start_local : null,
    window_end_local: window ? window.window_end_local : null,
    window_start_utc: window ? window.window_start_utc : null,
    window_end_utc: window ? window.window_end_utc : null,
    as_of_utc: window ? window.as_of_utc : null,
    cohort_basis: def.cohort_basis,
    attribution_model: def.attribution_model,
    deduplication_key: def.deduplication_key,
    source_tables: def.source_tables,
    state: "unsupported", reason,
    numerator: null, denominator: null, rate: null,
    pending_count: null, unknown_count: null, untrackable_count: null,
    exclusions: [], provenance: null,
  };
}

module.exports = {
  METRIC_STATES, ATTRIBUTION_MODELS, METRIC_DEFINITIONS,
  buildMetric, unsupportedMetric, definitionFor, versionOf,
};
