// ════════════════════════════════════════════════════════════════════
//  lead_demand.js — Slice 9, step 4.
//
//  Built ONLY from typed canonical facts. The audit found that unit-type and
//  price-range interest exist solely as free text in person_attributes
//  ("verbatim-ish", per its own migration), so aggregating them would mean
//  parsing "around $1,800" and "2 bed maybe 3" into a claimed measurement.
//  Ruling 6 forbids it, and this module has no code path that reads
//  person_attributes at all — the boundary is structural, not a promise.
//
//  ── THE ATTRIBUTION MODEL IS DISCLOSED, NOT IMPLIED ──────────────────
//  lead_source_touches is touch-level; leasing_leads is the deduplicated
//  opportunity. One opportunity may carry touches from several sources, so
//  SOURCE ROWS OVERLAP AND DO NOT SUM TO THE TOTAL. Every response says so in
//  attribution_model, because a table of percentages that looks like it should
//  add to 100 will be read that way whatever the footnote says.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { buildMetric } = require("./metric_contract");

function percentile(sortedSecs, p) {
  if (!sortedSecs.length) return null;
  const idx = Math.min(sortedSecs.length - 1, Math.max(0, Math.ceil(p * sortedSecs.length) - 1));
  return Math.round(sortedSecs[idx]);
}

async function leadDemand(pool, window) {
  if (!window || window.state !== "ok") {
    return {
      state: "unavailable",
      reason: window ? window.reason : "operating_window_unresolved",
      metrics: {
        opportunities_received: buildMetric({ metric_code: "s9.lead_demand.opportunities_received.v1", window }),
        first_response_coverage: buildMetric({ metric_code: "s9.lead_demand.first_response_coverage.v1", window }),
      },
      counts: null, by_source: [],
    };
  }

  const rows = (await pool.query(
    `select l.id, l.received_at, l.first_response_at,
            extract(epoch from (l.first_response_at - l.received_at)) as response_secs
       from leasing_leads l
      where l.property_id = $1
        and l.received_at >= $2::timestamptz
        and l.received_at <  $3::timestamptz`,
    [window.property_id, window.window_start_utc, window.window_end_utc]
  )).rows;

  const asOf = new Date(window.as_of_utc).getTime();
  // An outcome is only observed if it happened by as_of. A response recorded
  // after the reporting instant is not yet a fact for this report.
  const responded = rows.filter((r) => r.first_response_at && new Date(r.first_response_at).getTime() <= asOf);
  const secs = responded
    .map((r) => Number(r.response_secs))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  // Attribution: which of these opportunities carry a source touch.
  const touches = rows.length ? (await pool.query(
    `select t.lead_id, t.source_id, coalesce(s.name,'(unknown source)') as source_name,
            s.source_type, s.monthly_cost
       from lead_source_touches t
       left join lead_sources s on s.id = t.source_id
      where t.lead_id = any($1::uuid[])`,
    [rows.map((r) => r.id)]
  )).rows : [];

  const attributedLeadIds = new Set(touches.map((t) => String(t.lead_id)));
  const bySource = new Map();
  for (const t of touches) {
    const key = t.source_id ? String(t.source_id) : "unknown";
    if (!bySource.has(key)) {
      bySource.set(key, {
        source_id: t.source_id || null, source: t.source_name,
        source_type: t.source_type || null,
        monthly_cost: t.monthly_cost == null ? null : Number(t.monthly_cost),
        opportunity_ids: new Set(),
      });
    }
    bySource.get(key).opportunity_ids.add(String(t.lead_id));
  }

  const by_source = [...bySource.values()]
    .map((s) => ({
      source_id: s.source_id, source: s.source, source_type: s.source_type,
      monthly_cost: s.monthly_cost,
      opportunities: s.opportunity_ids.size,
    }))
    .sort((a, b) => b.opportunities - a.opportunities);

  const counts = {
    opportunities_received: rows.length,
    source_attributed: attributedLeadIds.size,
    unattributed: rows.length - attributedLeadIds.size,
    first_response_present: responded.length,
    first_response_missing: rows.length - responded.length,
    median_first_response_secs: percentile(secs, 0.5),
    p90_first_response_secs: percentile(secs, 0.9),
  };

  return {
    state: "ok",
    counts,
    // Stated on the section, not buried in a metric: these rows overlap.
    attribution_model: "multi_touch_non_additive",
    attribution_note: "One opportunity may carry touches from several sources, so source rows overlap and do not sum to the total. Percentages across sources are not a partition.",
    by_source,
    // Structural, not editorial: nothing here reads person_attributes.
    excluded_by_ruling: [
      "demand by parsed budget",
      "demand by parsed unit type",
      "price-band demand inferred from conversation text",
      "message volume treated as demand",
    ],
    metrics: {
      opportunities_received: buildMetric({
        metric_code: "s9.lead_demand.opportunities_received.v1",
        window, numerator: null, denominator: rows.length,
        exclusions: ["opportunities received outside the property-local window"],
        provenance: "leasing_leads.received_at, deduplicated by leasing_leads.id",
        extra: {
          source_attributed: counts.source_attributed,
          unattributed: counts.unattributed,
        },
      }),
      first_response_coverage: buildMetric({
        metric_code: "s9.lead_demand.first_response_coverage.v1",
        window, numerator: responded.length, denominator: rows.length,
        counts: { unknown: counts.first_response_missing },
        exclusions: ["responses recorded after as_of"],
        provenance: "leasing_leads.first_response_at observed through as_of_utc",
        extra: {
          median_first_response_secs: counts.median_first_response_secs,
          p90_first_response_secs: counts.p90_first_response_secs,
          missing_first_response: counts.first_response_missing,
        },
      }),
    },
  };
}

module.exports = { leadDemand };
