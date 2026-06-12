-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 026 — LEASING BASIS (by the unit or by the bed)
--
--  A building leases one way: by the unit (rent attaches to the door)
--  or by the bed (rent attaches to each bedroom — student housing).
--  This is a PROPERTY attribute, not a deal attribute: the Temple OM
--  itself had 4 buildings by-unit and 2 by-bed inside one offering.
--
--  'unknown' is the honest default. When basis = 'bed', bed counts are
--  REQUIRED operating data: promote refuses units with blank bedrooms
--  (a by-bed building where you can't count beds can't bill rent).
--  Declared basis also lets the system flag declared-vs-observed
--  mismatches instead of silently guessing from row patterns.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records
--  the ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════
alter table properties
  add column if not exists leasing_basis text not null default 'unknown'
  check (leasing_basis in ('unit','bed','unknown'));
