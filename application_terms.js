// ════════════════════════════════════════════════════════════════════
//  application_terms.js — Build A: the ONE canonical judge of application
//  lease-term completeness, used by the lease packet, confirm-term, and
//  countersign so all three judge "complete" identically (one definition,
//  not three).
//
//  Completeness is DATA-ONLY (7 conditions). Packet render is NOT a
//  factor — the packet renders FROM the terms, so making completeness
//  depend on the packet would be circular. Packet/source alignment is a
//  SEPARATE property proven independently.
//
//  The concession check is not a pure column read: concession_status
//  'structured' is a CLAIM until a real lease_economic_schedules row for
//  the application is proven present. So this takes a `client` and
//  validates the concession link against the governed economics.
//
//  CLASSIFICATION: Class 1 permanent primitive (the canonical completeness
//  contract). No writes.
// ════════════════════════════════════════════════════════════════════

// Read the canonical structured terms off an application row. Dates/concession
// come from the STRUCTURED columns (migration 075), NOT free-text `captured`.
// `captured` is audit/fallback DISPLAY only and is never an operating source here.
function structuredTerms(app) {
  return {
    person_id: app.person_id ?? null,
    unit_id: app.unit_id ?? null,
    unit_label: app.unit_label ?? null,
    rent: app.rent ?? null,
    deposit: app.deposit ?? null,
    lease_start_date: app.lease_start_date ?? null,   // structured column
    lease_end_date: app.lease_end_date ?? null,       // structured column
    concession_status: app.concession_status ?? "unknown",
    term_source: app.term_source ?? null,             // recorded fact, NOT an authority (never gates)
    terms_completed_at: app.terms_completed_at ?? null,
    terms_completed_by: app.terms_completed_by ?? null,
  };
}

// Does a `structured` concession claim have a REAL backing schedule?
// (edit #2 — the status string is not enough.)
async function concessionBacked(client, application_id) {
  const q = await client.query(
    `select 1 from lease_economic_schedules
      where application_id = $1 and status = 'locked' limit 1`,
    [application_id]);
  return q.rows.length > 0;
}

// THE COMPLETENESS CONTRACT — 7 conditions, data-only.
// Returns { complete: boolean, missing: string[], terms }.
// `client` is required because condition 7 validates the concession link.
async function applicationTermsComplete(app, client) {
  const t = structuredTerms(app);
  const missing = [];

  // 1. person/applicant exists
  if (!t.person_id) missing.push("person");
  // 2. unit/space exists (unit_id present; space resolution is confirmed by countersign/packet separately)
  if (!t.unit_id) missing.push("unit");
  // 3. rent present
  if (t.rent == null) missing.push("rent");
  // 4. deposit present OR explicitly zero (0 valid; null/absent not)
  if (t.deposit == null) missing.push("deposit");
  // 5. start date present
  if (!t.lease_start_date) missing.push("start_date");
  // 6. end date present AND after start (the DB also enforces end>start; here we require presence)
  if (!t.lease_end_date) {
    missing.push("end_date");
  } else if (t.lease_start_date && new Date(t.lease_end_date) <= new Date(t.lease_start_date)) {
    missing.push("end_date_after_start");
  }
  // 7. concession resolved AND backed:
  //    'none'       → ok
  //    'structured' → ok ONLY if a real locked schedule exists for the application
  //    'unknown'    → fail
  if (t.concession_status === "unknown") {
    missing.push("concession_unresolved");
  } else if (t.concession_status === "structured") {
    if (!client) {
      missing.push("concession_unvalidated_no_client");
    } else {
      const backed = await concessionBacked(client, app.id);
      if (!backed) missing.push("concession_structured_but_no_schedule");
    }
  }
  // 'none' → nothing to add.

  return { complete: missing.length === 0, missing, terms: t };
}

module.exports = { applicationTermsComplete, structuredTerms, concessionBacked };
