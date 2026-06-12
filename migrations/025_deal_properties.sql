-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 025 — DEAL ↔ PROPERTIES (the deal holds what you bought)
--
--  Real case that forced this (Jun 11 2026): a six-building Temple OM
--  arrived, but the deal was TWO of the six, bought individually
--  (The Greenery 1325 N 15th + 1850 N 18th). A deal is the unit of
--  acquisition and can hold multiple properties — that was locked long
--  ago; this table finally makes it explicit. The HUMAN picks which
--  properties are in the deal. Documents mentioning other buildings
--  (OM comps, siblings not purchased) stay reference material — a
--  mention is never membership.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records
--  the ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════
create table if not exists deal_intake_properties (
  id          uuid primary key default gen_random_uuid(),
  intake_id   uuid not null references deal_intakes(id),
  property_id uuid not null references properties(id),
  note        text,
  created_at  timestamptz not null default now(),
  unique (intake_id, property_id)
);
