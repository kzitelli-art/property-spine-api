-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 002 — REVENUE SCHEDULE + SUPPLY REQUESTS
--
--  Captures the last two tables that drifted into production via separate
--  hand-run session SQL files and were not in migration 001:
--
--    1. scheduled_charges — the revenue schedule. A lease's terms expand into
--       this: application fee, deposit, first month, recurring rent, pet/
--       parking, concessions. Carries the move-in gate flag and partial-payment
--       tracking (amount vs amount_paid). Built from a live introspection of
--       production (June 7 2026) — exact columns, the three FKs, all 5 indexes
--       (including the partial move-in-gate index). Confirmed, not guessed.
--
--    2. supply_requests — maintenance supply requests, categorized at request
--       time through the three-layer engine (field -> operating -> GL).
--       Confirmed against production the same way.
--
--  With 002 applied, the repo reproduces the ENTIRE production schema. No
--  drift remains. (The stray `playing_with_neon` table in production is Neon's
--  default sample table — intentionally NOT included here; it is not part of
--  the application schema.)
--
--  Like 001, everything is guarded so applying to production (where these
--  already exist) is harmless, and applying to a fresh test branch builds them.
-- ════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════
--  SCHEDULED CHARGES — the revenue schedule
-- ════════════════════════════════════════════════════════════════════
create table if not exists scheduled_charges (
  id                    uuid primary key default gen_random_uuid(),
  lease_id              uuid not null references leases(id) on delete cascade,
  property_id           uuid references properties(id) on delete cascade,
  charge_type           text not null,                       -- app_fee|deposit|first_month|rent|pet|parking|concession|...
  label                 text,
  amount                numeric not null default 0,
  due_on                date,
  status                text not null default 'scheduled',   -- scheduled|paid|partial|waived|...
  is_move_in_gate       boolean not null default false,      -- must be satisfied before keys_released
  recurs                boolean not null default false,
  recur_period          text,                                -- e.g. 'monthly'
  concession_treatment  text,                                -- upfront | amortized
  concession_of_months  numeric,
  source_lease_event_id uuid references events(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  amount_paid           numeric not null default 0           -- partial payments keep the charge open
);

create index if not exists idx_sched_lease  on scheduled_charges(lease_id);
create index if not exists idx_sched_status on scheduled_charges(status);
create index if not exists idx_sched_due    on scheduled_charges(due_on);
-- partial index: the move-in gate lookup only cares about gate rows
create index if not exists idx_sched_gate
  on scheduled_charges(lease_id, is_move_in_gate)
  where (is_move_in_gate = true);


-- ════════════════════════════════════════════════════════════════════
--  SUPPLY REQUESTS — maintenance supplies, categorized at request time
--  through the three-layer engine: field -> operating -> GL.
-- ════════════════════════════════════════════════════════════════════
create table if not exists supply_requests (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references properties(id) on delete cascade,
  unit_id            uuid references units(id) on delete set null,
  work_order_id      uuid references work_orders(id) on delete set null,
  requested_by       text,
  item               text not null,
  quantity           text,
  reason             text,
  field_category     text,        -- what the tech taps
  operating_category text,        -- what the PM sees
  gl_category        text,        -- what accounting books
  est_cost           numeric,
  status             text not null default 'requested',   -- requested|approved|ordered|received|...
  approved_by        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_supply_property on supply_requests(property_id);
create index if not exists idx_supply_status   on supply_requests(status);
