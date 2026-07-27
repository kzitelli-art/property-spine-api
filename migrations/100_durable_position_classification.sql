-- ════════════════════════════════════════════════════════════════════
--  100_durable_position_classification.sql
--
--  THE DURABLE PROPERTY CLASSIFICATION. Three concepts that were being
--  inferred from status strings, given real homes — and deliberately NOT
--  collapsed into one another, because they answer different questions:
--
--    position_kind  unit | bed
--                   the SHAPE of the rentable position.
--    use_type       residential | commercial | non_revenue | other
--                   what the position is FOR. Governs leasable
--                   denominators and residential-vs-commercial treatment.
--    unit_type      a property-scoped governed category (Studio, 1BR, …)
--                   the PRICING and grouping category.
--
--  WHY use_type SITS ON THE POSITION, NOT THE UNIT (ruling 2026-07-27):
--  Current Rent Roll, Availability, Renewals and Future Rent Roll all
--  operate per rentable position, and leasable denominators are
--  position-based. A by-bed property must not depend on a unit-level
--  assumption, and a position-level exception (one bed taken out of
--  residential use) must be expressible without reclassifying its
--  siblings.
--
--  unit_type stays on the UNIT: it is a physical/pricing category of the
--  apartment, and beds within one unit share it.
--
--  CLASSIFICATION: Class 1 permanent primitives. Nothing here is demo
--  scaffolding and nothing is temporary.
--
--  ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ──────────────────
--   · No values are populated. Every column is nullable and every
--     existing row stays NULL, which the surfaces render as
--     "Not configured". Honest missing configuration beats preserved
--     string sniffing.
--   · NO INFERENCE from occupancy_status, unit_type text, or any status
--     string. The previous is_commercial was a regex over a status field;
--     reproducing that in a column would make a guess permanent.
--   · No mass population. Values arrive only through a reviewed mapping
--     receipt, so classification provenance is retained.
--   · NO PRICING. property_unit_types carries a label and a code and
--     nothing economic. Pricing terms belong to the Pricing & Concessions
--     build and must not be smuggled in here.
--   · unit_type does NOT become free text on a lease or a screen. It is a
--     reference to a governed row, or it is absent.
--
--  Additive and nullable throughout: no existing read changes behaviour,
--  and no deployed code path references these columns until a surface
--  opts in.
-- ════════════════════════════════════════════════════════════════════

-- ── the governed, property-scoped category vocabulary ────────────────
create table if not exists property_unit_types (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,

  code          text not null,          -- stable machine key, e.g. 'STUDIO', '1BR'
  label         text not null,          -- what an operator reads, e.g. 'Studio'
  sort_order    int,

  -- provenance of the classification itself: how this category came to exist.
  source_note   text,
  created_by_user_id uuid references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- one code per property; the same code may exist at many properties.
create unique index if not exists uq_property_unit_types_code
  on property_unit_types (property_id, code);
create index if not exists ix_property_unit_types_property
  on property_unit_types (property_id);

-- ── the rentable position's own classification ───────────────────────
alter table spaces add column if not exists position_kind text;
alter table spaces add column if not exists use_type      text;

-- Constraints admit NULL deliberately: absent is the honest default, and a
-- position must never be forced into a category to satisfy a NOT NULL.
alter table spaces drop constraint if exists ck_spaces_position_kind;
alter table spaces add constraint ck_spaces_position_kind
  check (position_kind is null or position_kind in ('unit','bed'));

alter table spaces drop constraint if exists ck_spaces_use_type;
alter table spaces add constraint ck_spaces_use_type
  check (use_type is null or use_type in ('residential','commercial','non_revenue','other'));

-- ── the unit's governed pricing/grouping category ────────────────────
alter table units add column if not exists unit_type_id uuid references property_unit_types(id);
create index if not exists ix_units_unit_type on units (unit_type_id);

-- ── classification provenance ────────────────────────────────────────
-- Every populated value must be able to say who classified it, when, and on
-- what basis. Without this the mapping receipt has nowhere to land and a
-- classification becomes indistinguishable from a guess.
alter table spaces add column if not exists classification_source     text;
alter table spaces add column if not exists classified_by_user_id     uuid references users(id);
alter table spaces add column if not exists classified_at            timestamptz;

alter table units  add column if not exists unit_type_source          text;
alter table units  add column if not exists unit_type_assigned_by_user_id uuid references users(id);
alter table units  add column if not exists unit_type_assigned_at     timestamptz;
