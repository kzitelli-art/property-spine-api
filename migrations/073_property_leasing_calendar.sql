-- ════════════════════════════════════════════════════════════════════
--  073_property_leasing_calendar.sql — Slice D, Migration α
--
--  A dedicated property-level primitive: the leasing rhythm config that
--  drives lease-end recommendations and the delivery-window severity.
--  NOT columns bolted onto `properties`; NOT hardcoded Solo logic (rule 12).
--
--  Minimal by ruling: preferred + allowed lease-end anchors, approved
--  move-in options (jsonb — flexible storage, simple behavior), a
--  delivery-window for severity derivation, a recommendation reason.
--  NO analytics, NO forecasting, NO capacity model.
--
--  Solo's row is DATA seeded below, never a code branch. A different
--  property gets a different row in the same shape.
--
--  IDEMPOTENT: create-if-not-exists; the Solo seed is an upsert.
-- ════════════════════════════════════════════════════════════════════

create table if not exists property_leasing_calendar (
  id                          uuid primary key default gen_random_uuid(),
  property_id                 uuid not null unique,
  preferred_lease_end_anchor  text,                       -- 'MM-DD', e.g. '07-31'
  allowed_lease_end_anchors   text[]  default '{}',        -- e.g. {'07-01','07-15','07-31'}
  approved_move_in_options    jsonb   default '{}'::jsonb, -- e.g. {"type":"day_of_month","days":[1,15]}
  delivery_window_days        integer default 14,          -- feeds due-window severity (Slice D 2B)
  recommendation_reason       text,
  active                      boolean default true,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

-- Solo on Chestnut (Demo Building context, display_name "Solo on Chestnut").
-- Property id a50fbdd0-... — the July anchors are DATA, not code.
insert into property_leasing_calendar
  (property_id, preferred_lease_end_anchor, allowed_lease_end_anchors, approved_move_in_options, delivery_window_days, recommendation_reason)
values
  ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe', '07-31', '{07-01,07-15,07-31}',
   '{"type":"day_of_month","days":[1,15]}'::jsonb, 14,
   'keeps this unit in the peak student leasing cycle')
on conflict (property_id) do update set
  preferred_lease_end_anchor = excluded.preferred_lease_end_anchor,
  allowed_lease_end_anchors  = excluded.allowed_lease_end_anchors,
  approved_move_in_options   = excluded.approved_move_in_options,
  delivery_window_days       = excluded.delivery_window_days,
  recommendation_reason      = excluded.recommendation_reason,
  updated_at                 = now();
