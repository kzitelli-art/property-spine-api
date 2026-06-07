-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 003 — DOWN UNITS v1
--
--  Distinguishes a normal TURN (clean/paint/punch make-ready) from a true
--  DOWN UNIT — a unit blocked by a specific unresolved issue that prevents
--  leasing, showing, move-in, occupancy, or rent-ready delivery.
--
--  Clean/paint/punch alone is NOT a down unit. "Down" is a deliberate flag a
--  human sets with a reason and a blocker; it spawns a resolution obligation.
--
--  Adds seven fields to `units` (the only unit-state home). Idempotent and
--  safe to run on production — every column is guarded with "if not exists".
--
--  Run AFTER 002 via migrate.js.
-- ════════════════════════════════════════════════════════════════════

alter table units add column if not exists is_down                    boolean not null default false;
alter table units add column if not exists down_reason                text;
alter table units add column if not exists down_blocker               text;
alter table units add column if not exists down_started_at            timestamptz;
alter table units add column if not exists down_target_resolution_at  timestamptz;
alter table units add column if not exists down_resolved_at           timestamptz;
alter table units add column if not exists down_related_work_order_id uuid references work_orders(id) on delete set null;

-- Dashboard reads "which units are down" constantly — index the flag.
create index if not exists idx_units_down on units(property_id, is_down) where is_down = true;
