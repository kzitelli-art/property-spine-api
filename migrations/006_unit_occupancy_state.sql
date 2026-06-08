-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 006 — UNIT v2: OCCUPANCY STATE LAYER + unit_events
--
--  Scope is deliberately NARROW. This is NOT "finish the unit model." It is
--  the minimum state substrate that lets the next obligations — move-out,
--  security deposit, scheduled move-in — spawn, route, prove, and complete.
--
--  What this does NOT add, and why (verified against the live schema):
--    • rentable_status  — already covered by the down-unit cluster (003):
--                         is_down + down_reason/blocker/started/resolved.
--    • lease_status     — already lives on `leases` (status/dates/tenant_ids/
--                         space_id). Possession is DERIVED through unit→space→
--                         active lease, never copied onto the unit.
--    • money_status     — revenue/payments/delinquency/money_events own this.
--                         Putting it on the unit would duplicate accounting truth.
--    • the move-out/turn future — owned by the `turnovers` table (made live by
--                         a later module). unit_events carries only the OTHER
--                         scheduled futures, so the two never overlap.
--
--  Two ownership lines this migration keeps clean:
--    `events`      = past-tense source facts (what happened).
--    `unit_events` = dated FUTURE unit facts (what is scheduled to happen).
--    `turnovers`   = the move-out/turn operating record.
--    `obligations` = proof-gated work.
--
--  Idempotent and safe to run on production: every column guarded with
--  "if not exists"; every CHECK and index guarded by an existence test.
--  Run AFTER 005 via migrate.js.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. OCCUPANCY STATUS (possession axis) ────────────────────────────
--  Default 'unknown' — NOT 'vacant'. We do not yet know who is in possession
--  of existing units, and asserting 'vacant' would invent a fact. Missing
--  stays missing; a real value is set when a lease links or a move-in/out
--  event resolves it. (Provenance discipline, same as the rest of the spine.)
alter table units add column if not exists occupancy_status text not null default 'unknown';

-- ── 2. OPERATING USE (economic/use classification axis) ──────────────
--  Default 'standard'. Unlike occupancy, a unit's USE is standard unless a
--  human deliberately designates otherwise (model / employee / admin) — the
--  same shape as is_down defaulting to false, where the exception is the flag.
alter table units add column if not exists operating_use text not null default 'standard';

-- ── CHECK constraints for the two new vocabularies ───────────────────
--  Guarded so the migration is safe to re-run (CHECK has no native
--  "if not exists"). Fixed vocabularies — bad values cannot enter.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_units_occupancy_status') then
    alter table units add constraint ck_units_occupancy_status
      check (occupancy_status in ('vacant','occupied','unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_units_operating_use') then
    alter table units add constraint ck_units_operating_use
      check (operating_use in ('standard','model','employee','admin','unknown'));
  end if;
end $$;

-- ── 3. unit_events — the dated home for SCHEDULED FUTURE unit facts ───
--  Mirrors the `events` table in spirit (a typed, sourced record about a
--  unit) but is forward-looking: every row has an effective_date and a
--  lifecycle. This is what lets future facts be queried by date and turned
--  into obligations when they become actionable. NOTE: no scheduler is built
--  yet — this is the durable HOME; "process due events" is a later read-time
--  mechanism (the obligation engine's clock is read-time too, not a cron).
create table if not exists unit_events (
  id                    uuid primary key default gen_random_uuid(),
  unit_id               uuid not null references units(id) on delete cascade,
  property_id           uuid references properties(id) on delete set null,

  -- WHAT is scheduled. Fixed vocabulary; excludes move_out/turn (owned by
  -- `turnovers`) so the two tables never model the same fact.
  event_type            text not null,

  -- WHEN it becomes actionable. NOT NULL — a future fact with no date has no
  -- purpose here; the whole point is dated spawning.
  effective_date        date not null,

  -- Typed details that vary by event_type (tenant_name, rent, lease_id, …).
  -- Kept as jsonb so each event_type carries only what it has — same
  -- omit-when-null spirit as the ingest layer.
  payload               jsonb not null default '{}'::jsonb,

  -- WHERE the fact came from, and how sure we are (carried from extraction).
  source                text,                 -- rent_roll | manual | ingest | turnover | …
  confidence            numeric,              -- nullable; from extraction when present

  -- Lifecycle: scheduled → actioned (an obligation was spawned) → or
  -- cancelled / superseded (the date moved, the prelease fell through).
  -- This is what stops a future fact from spawning twice or spawning stale.
  status                text not null default 'scheduled',

  -- The obligation born from this event, once actioned. Proves the link and
  -- prevents double-spawn. Set when the date arrives and work is spawned.
  spawned_obligation_id uuid references obligations(id) on delete set null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- event_type vocabulary — scheduled futures NOT owned by turnovers/down-units.
  constraint ck_unit_events_type check (event_type in (
    'move_in_scheduled',
    'prelease_signed',
    'rent_change_scheduled',
    'lease_start_scheduled',
    'lease_end_scheduled',
    'operating_use_change_scheduled',
    'unit_back_online_scheduled'
  )),
  constraint ck_unit_events_status check (status in (
    'scheduled','actioned','cancelled','superseded'
  ))
);

-- ── indexes the spawn-by-date read will lean on ─────────────────────
--  "find everything actionable by date" is the core query — index it, and
--  partial-index the still-pending ones (the only rows a spawner cares about).
create index if not exists idx_unit_events_due
  on unit_events(effective_date)
  where status = 'scheduled';

create index if not exists idx_unit_events_unit
  on unit_events(unit_id);

-- "which units are occupied / vacant" will be read constantly by the
-- dashboard and availability views — index the occupancy axis by property.
create index if not exists idx_units_occupancy
  on units(property_id, occupancy_status);
