-- ════════════════════════════════════════════════════════════════════
--  075_application_structured_terms.sql — Build A
--
--  Make application lease terms CANONICAL and STRUCTURED. Today start/end
--  dates live only in free-text `captured` (a claim, not a structured
--  fact); this promotes them to real columns beside rent/deposit/unit_id/
--  unit_label/person_id — the same structured pattern the lease packet
--  already reads. `captured` becomes audit/fallback display only.
--
--  Concession is a STATUS, never a loose contractual text field:
--    none | structured | unknown  (default 'unknown' = honest blank).
--  'structured' must correspond to a REAL lease_economic_schedules row
--  for the application (validated in app code at execution, not asserted).
--
--  DB CHECK CONSTRAINTS make the guarantees enforceable at the database,
--  so no path can persist an invalid value:
--    · concession_status ∈ {none,structured,unknown}
--    · term_source ∈ {application_capture,confirm_term_repair} or null
--    · lease_end_date > lease_start_date when BOTH present (a term with
--      no positive duration is not a term)
--
--  Build A adds NO status change and NO 'executed' status — the
--  application status model is untouched here (that is a Build B decision).
--
--  ADDITIVE + IDEMPOTENT: add-column-if-not-exists; constraints guarded by
--  name existence so re-run is a no-op. No backfill (a pre-Build-A
--  application genuinely has null structured terms — null says so).
-- ════════════════════════════════════════════════════════════════════

alter table lease_applications add column if not exists lease_start_date   date;
alter table lease_applications add column if not exists lease_end_date     date;
alter table lease_applications add column if not exists term_source        text;
alter table lease_applications add column if not exists terms_completed_at timestamptz;
alter table lease_applications add column if not exists terms_completed_by uuid;
alter table lease_applications add column if not exists concession_status  text default 'unknown';

-- backfill existing rows' concession_status to 'unknown' explicitly (the default
-- only applies to NEW rows; existing rows would be NULL otherwise, which the
-- CHECK would reject). This is not a "guess" — 'unknown' is the honest state of
-- a pre-Build-A application whose concession was never structured.
update lease_applications set concession_status = 'unknown' where concession_status is null;

-- CHECK constraints, each guarded so re-run is safe.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'la_concession_status_ck') then
    alter table lease_applications
      add constraint la_concession_status_ck
      check (concession_status in ('none','structured','unknown'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'la_term_source_ck') then
    alter table lease_applications
      add constraint la_term_source_ck
      check (term_source is null or term_source in ('application_capture','confirm_term_repair'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'la_term_dates_ck') then
    alter table lease_applications
      add constraint la_term_dates_ck
      check (lease_start_date is null or lease_end_date is null or lease_end_date > lease_start_date);
  end if;
end $$;
