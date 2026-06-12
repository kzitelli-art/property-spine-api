-- 012_property_noi_goals.sql
-- PROPERTY NOI GOALS — tiny persistence layer for the onboarding funnel.
-- Stores the asset-management target entered during setup. Current NOI and the
-- gap to target remain unavailable until the expense/money layer exists.
--
-- MERGE NOTE (changed from the handoff draft): property_id is UUID with a FK to
-- properties ON DELETE CASCADE — not bare text. Reasons:
--   1. properties.id is uuid; matching the type prevents silent join/type drift.
--   2. ON DELETE CASCADE means a deleted property takes its goal with it — this
--      thread hit the opposite problem (a non-cascading alias FK blocked property
--      deletes during cleanup). Cascade is the lesson applied.
-- migrate.js applies this after 011. Records itself in schema_migrations (the
-- migration file carries NO begin/commit and NO ledger insert, per the runner).

create table if not exists property_noi_goals (
  property_id uuid primary key references properties(id) on delete cascade,
  target_noi numeric,
  target_gross_rent numeric,
  target_avg_rent_per_unit numeric,
  target_expense_load numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint property_noi_goals_nonnegative check (
    (target_noi is null or target_noi >= 0) and
    (target_gross_rent is null or target_gross_rent >= 0) and
    (target_avg_rent_per_unit is null or target_avg_rent_per_unit >= 0) and
    (target_expense_load is null or target_expense_load >= 0)
  )
);

create index if not exists ix_property_noi_goals_updated_at
  on property_noi_goals(updated_at desc);
