-- ════════════════════════════════════════════════════════════════════
--  057_tour_outcome_capture.sql
--  WHY: the outcome capture (spec: "capture the useful truth in a few taps")
--  needs two facts that have NO home today: (1) the ACTUAL UNITS SHOWN on a
--  tour (multi, 1..5) and (2) structured qualitative REACTIONS + an optional
--  PREFERRED UNIT. Everything else already exists: attendance truth lives in
--  leasing_tours/tour_events (039); the assigned-vs-actual host distinction,
--  outcome, notes, ownership + handoff live on leasing_conversions (047).
--  This migration only EXTENDS the designed rails — no parallel record.
--  IDEMPOTENT: if-not-exists throughout. One-time apply via the ledger.
-- ════════════════════════════════════════════════════════════════════

-- Actual units shown on a tour. Tour-scoped truth; the showroom may be one.
create table if not exists tour_units_shown (
  tour_id     uuid not null references leasing_tours(id) on delete cascade,
  unit_id     uuid not null references units(id)         on delete cascade,
  shown_order int  not null default 1,
  created_at  timestamptz not null default now(),
  primary key (tour_id, unit_id)
);
create index if not exists tour_units_shown_unit_idx on tour_units_shown(unit_id);

-- Reactions ("what landed") are durable knowledge about the PERSON, recorded
-- with tour provenance on the conversion the tour opened. preferred_unit_id is
-- a PREFERENCE record only — per the asset-protection rule it is NOT a hold,
-- NOT a reservation, and creates NO turnover priority. Only a signed lease
-- tied to a unit and move-in date may do that.
alter table leasing_conversions
  add column if not exists reactions         jsonb,
  add column if not exists preferred_unit_id uuid references units(id) on delete set null;
