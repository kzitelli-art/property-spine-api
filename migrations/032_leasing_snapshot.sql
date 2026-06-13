-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 032 — LEASING SNAPSHOT (the claimed-side leasing read)
--
--  NOT a leasing-event model. One row per property: the latest leasing
--  payload computed from the uploaded leasing log (.xlsx). A materialized
--  read so GET /properties/:id/leasing-dashboard works between uploads.
--  Replaced in full on every upload (on conflict do update). When this
--  rung grows up, the payload gets recomputed from real claimed-side
--  rows + the proven Yardi/future_events side — this table is the seam.
-- ════════════════════════════════════════════════════════════════════

create table if not exists leasing_snapshots (
  property_id      uuid primary key,
  as_of            date,
  payload          jsonb not null,
  source_filename  text,
  uploaded_at      timestamptz not null default now()
);
