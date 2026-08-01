// ════════════════════════════════════════════════════════════════════
//  concessions_read.js — the governed concession read (Slice 8, step 3)
//
//  Slice 7's audit recorded the gap: concessions existed as governed tables
//  with no operator read, so they could only be seen from inside pricing or
//  offer context. This is that read, and nothing more — it authors no
//  concession, approves nothing, and computes no effective rent.
//
//  ── EFFECTIVE STATE IS STATED, NEVER IMPLIED ─────────────────────────
//  A row is not "active" because a boolean says so. Being active means
//  active NOW: attached to the published version, flag set, and today inside
//  its validity window. Everything else is named:
//
//     active_now  · scheduled · expired · inactive · not_published
//
//  A future concession displayed as active is how a prospect gets offered
//  something that does not exist yet, so the window is resolved here once
//  rather than in each surface that shows it.
// ════════════════════════════════════════════════════════════════════
"use strict";

const STATES = Object.freeze(["active_now", "scheduled", "expired", "inactive", "not_published"]);

function effectiveState(row, asOf, publishedVersionId) {
  if (!publishedVersionId || String(row.pricing_version_id) !== String(publishedVersionId)) {
    return "not_published";
  }
  if (row.active === false) return "inactive";
  const d = new Date(asOf + "T00:00:00Z").getTime();
  const from = row.valid_from ? new Date(row.valid_from).getTime() : null;
  const until = row.valid_until ? new Date(row.valid_until).getTime() : null;
  if (from != null && d < from) return "scheduled";
  if (until != null && d > until) return "expired";
  return "active_now";
}

const ymd = (v) => (v == null ? null : String(v).slice(0, 10));

async function governedConcessions(pool, { property_id, as_of = null } = {}) {
  if (!property_id) throw new Error("governedConcessions requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  const version = (await pool.query(
    `select id from property_pricing_versions
      where property_id=$1 and status='published'
        and effective_from <= $2::date
        and (effective_until is null or effective_until >= $2::date)
      order by effective_from desc limit 1`, [property_id, asOf]
  )).rows[0] || null;
  const publishedVersionId = version ? version.id : null;

  const rows = (await pool.query(
    `select id, pricing_version_id, scope, scope_ref, lease_type, required_term_months,
            concession_type, value, fee_category, timing_profile, qualifying_action,
            qualifying_window_hours, valid_from, valid_until, active,
            stacking_rule, reason_code, reason_note, supersedes_concession_id, created_at
       from concession_policies
      where property_id=$1
      order by created_at desc`, [property_id]
  )).rows;

  const concessions = rows.map((r) => ({
    concession_id: r.id,
    pricing_version_id: r.pricing_version_id,
    state: effectiveState(r, asOf, publishedVersionId),
    scope: r.scope,
    scope_ref: r.scope_ref || null,
    lease_type: r.lease_type,
    required_term_months: r.required_term_months == null ? null : Number(r.required_term_months),
    concession_type: r.concession_type,
    value: r.value == null ? null : Number(r.value),
    fee_category: r.fee_category || null,
    timing_profile: r.timing_profile || null,
    qualifying_action: r.qualifying_action || null,
    qualifying_window_hours: r.qualifying_window_hours == null ? null : Number(r.qualifying_window_hours),
    valid_from: ymd(r.valid_from),
    valid_until: ymd(r.valid_until),
    // Slice 8: no silent stacking. Absent a rule the answer is the
    // conservative one, and it is stated rather than assumed.
    stacking_rule: r.stacking_rule || "exclusive",
    reason_code: r.reason_code || null,
    reason_note: r.reason_note || null,
    supersedes_concession_id: r.supersedes_concession_id || null,
  }));

  const activeNow = concessions.filter((c) => c.state === "active_now");

  // Honest absence, distinguishing "none authored" from "none in effect".
  let absence = null;
  if (!publishedVersionId) {
    absence = {
      reason: "no_published_pricing_version",
      detail: "No governed pricing version is published and effective for this property on this date, so no concession can be in effect.",
    };
  } else if (concessions.length === 0) {
    absence = {
      reason: "no_concessions_authored",
      detail: "No concessions have been authored for this property.",
    };
  } else if (activeNow.length === 0) {
    absence = {
      reason: "no_concessions_in_effect",
      detail: "Concessions exist for this property, but none is in effect on this date.",
    };
  }

  return {
    property_id,
    as_of: asOf,
    published_version_id: publishedVersionId,
    counts: {
      total: concessions.length,
      active_now: activeNow.length,
      scheduled: concessions.filter((c) => c.state === "scheduled").length,
      expired: concessions.filter((c) => c.state === "expired").length,
      inactive: concessions.filter((c) => c.state === "inactive").length,
      not_published: concessions.filter((c) => c.state === "not_published").length,
    },
    concessions,
    absence,
  };
}

module.exports = { governedConcessions, effectiveState, STATES };
