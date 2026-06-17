-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 046 — HISTORICAL SNAPSHOT PROVENANCE
--
--  THE THREE DATA MODES (the honest framing):
--    1. demo            — fake seeded rows (never touches this table)
--    2. historical_snapshot — REAL data parsed from a real source file,
--                         loaded as a point-in-time snapshot, clearly
--                         labeled as historical, NOT live
--    3. live            — future connected feeds (rent rolls, leads, work
--                         orders, money, tenant activity)
--
--  This migration builds the provenance layer for mode 2 so that a
--  historical snapshot can never masquerade as live, and so any imported
--  record traces back to the exact source file and the exact parsed row.
--
--  THE HYBRID DESIGN (per spec — provenance without bloat):
--    • import_batches  — the CANONICAL provenance record. One row per
--                        load. Holds the FULL source metadata (file,
--                        as-of date, leasing model, confidence, status).
--                        Every imported record points back via
--                        import_batch_id. This is the single source of
--                        truth for "where did this come from."
--    • lightweight row-level fields on units/spaces/persons/leases —
--                        import_batch_id (the FK back to the batch),
--                        plus source_type + source_as_of_date +
--                        confidence as convenience columns so common
--                        queries ("show only confirmed snapshot rows as
--                        of date X") don't need a join. We do NOT copy
--                        source_file/leasing_model/notes onto every table.
--    • import_source_rows — the ROW-LEVEL AUDIT/staging table. Stores the
--                        raw parsed cells of each source row as jsonb,
--                        plus which records it produced. This is the
--                        "trace it back to the original" guarantee: if a
--                        lease/person/space looks wrong, we can find the
--                        exact spreadsheet row it came from.
--
--  Idempotent. Run after 001 (units/spaces/persons/leases) and 045.
-- ════════════════════════════════════════════════════════════════════

-- ── CANONICAL PROVENANCE: one row per import ──────────────────────────
create table if not exists import_batches (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,

  -- the data mode this batch represents (this layer is for historical_snapshot,
  -- but the column is explicit so the mode is never ambiguous)
  source_type         text not null default 'historical_snapshot'
                        check (source_type in ('historical_snapshot','live','demo')),

  -- the FULL source metadata lives HERE (not duplicated per row)
  source_file         text,                 -- 'Skyline RentRoll 2026 04 30.xlsx'
  source_as_of_date   date,                 -- 2026-04-30 (the "As Of" inside the file)
  leasing_model       text check (leasing_model in ('unit','bed')),  -- per-property, locked
  confidence          text check (confidence in ('confirmed','likely','extracted','manually_reviewed')),

  -- lifecycle of the import itself
  status              text not null default 'parsed'
                        check (status in ('parsed','reviewed','committed','failed')),

  notes               text,
  loaded_at           timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists ix_import_batches_property on import_batches(property_id);
create index if not exists ix_import_batches_status on import_batches(status);

-- ── ROW-LEVEL AUDIT / STAGING: trace any record to its source row ─────
--   Every parsed source row is stored here with its raw cells (jsonb) and
--   pointers to the records it produced. This is the forensic trail: if a
--   committed lease looks wrong, find the row it came from and see exactly
--   what the file said.
create table if not exists import_source_rows (
  id                  uuid primary key default gen_random_uuid(),
  import_batch_id     uuid not null references import_batches(id) on delete cascade,

  row_index           int,                  -- position in the source file (1-based)
  raw                 jsonb not null,       -- the raw parsed cells of this row

  -- what this row produced (nullable — a row may produce some/none)
  produced_unit_id    uuid references units(id) on delete set null,
  produced_space_id   uuid references spaces(id) on delete set null,
  produced_person_id  uuid references persons(id) on delete set null,
  produced_lease_id   uuid references leases(id) on delete set null,

  parse_note          text,                 -- e.g. 'VACANT bed — no person/lease created'
  created_at          timestamptz not null default now()
);
create index if not exists ix_import_source_rows_batch on import_source_rows(import_batch_id);

-- ── LIGHTWEIGHT ROW-LEVEL PROVENANCE on the four receiving tables ─────
--   import_batch_id is the FK back to the canonical batch. The other three
--   are convenience columns for filtering without a join. We deliberately
--   do NOT add source_file / leasing_model / notes here — those live on
--   import_batches to avoid bloat.

-- units
alter table units add column if not exists import_batch_id   uuid references import_batches(id) on delete set null;
alter table units add column if not exists source_type        text;
alter table units add column if not exists source_as_of_date  date;
alter table units add column if not exists confidence         text;
create index if not exists ix_units_import_batch on units(import_batch_id);

-- spaces
alter table spaces add column if not exists import_batch_id   uuid references import_batches(id) on delete set null;
alter table spaces add column if not exists source_type        text;
alter table spaces add column if not exists source_as_of_date  date;
alter table spaces add column if not exists confidence         text;
create index if not exists ix_spaces_import_batch on spaces(import_batch_id);

-- persons
alter table persons add column if not exists import_batch_id   uuid references import_batches(id) on delete set null;
alter table persons add column if not exists source_type        text;
alter table persons add column if not exists source_as_of_date  date;
alter table persons add column if not exists confidence         text;
create index if not exists ix_persons_import_batch on persons(import_batch_id);

-- leases
alter table leases add column if not exists import_batch_id   uuid references import_batches(id) on delete set null;
alter table leases add column if not exists source_type        text;
alter table leases add column if not exists source_as_of_date  date;
alter table leases add column if not exists confidence         text;
create index if not exists ix_leases_import_batch on leases(import_batch_id);
