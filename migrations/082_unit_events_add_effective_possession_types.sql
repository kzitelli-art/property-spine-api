-- ═══════════════════════════════════════════════════════════════════════════
--  ADD EFFECTIVE POSSESSION EVENT TYPES TO ck_unit_events_type
--
--  The possession slice writes effective 'move_in' / 'move_out' unit_events
--  (distinct from the existing 'move_in_scheduled' intent). The existing CHECK
--  constraint ck_unit_events_type does not allow these bare types, so the
--  possession write was rejected. This adds them.
--
--  Drops and recreates the constraint with the two new values appended. All
--  existing allowed values are preserved verbatim.
--
--  The migrate.js runner wraps this in one begin/commit. No txn control here.
-- ═══════════════════════════════════════════════════════════════════════════

alter table unit_events drop constraint if exists ck_unit_events_type;

alter table unit_events add constraint ck_unit_events_type check (
  event_type = any (array[
    'move_in_scheduled'::text,
    'prelease_signed'::text,
    'rent_change_scheduled'::text,
    'lease_start_scheduled'::text,
    'lease_end_scheduled'::text,
    'operating_use_change_scheduled'::text,
    'unit_back_online_scheduled'::text,
    'notice_given'::text,
    'move_in'::text,
    'move_out'::text
  ])
);
