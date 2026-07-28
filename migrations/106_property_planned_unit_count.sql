-- 106_property_planned_unit_count.sql
--
-- The org-onboarding wizard captures an approximate unit count per property as
-- a PLANNING number, before any real rent roll is loaded. It is explicitly NOT
-- the live inventory (that is derived from the `units` rows / snapshot). Storing
-- it in its own nullable column keeps it honest: a stated intention, never
-- confused with counted units. NULL = not stated.

alter table properties add column if not exists planned_unit_count int;

comment on column properties.planned_unit_count is
  'Approximate unit count stated at onboarding (planning figure only). Live inventory is derived from units rows, never this column.';
