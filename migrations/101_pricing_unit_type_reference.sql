-- ════════════════════════════════════════════════════════════════════
--  101_pricing_unit_type_reference.sql
--
--  Replaces the OPERATING use of pricing_terms.unit_type (free text) with a
--  durable reference to property_unit_types.id.
--
--  WHY: a text unit type is a runtime label match. It is the same class of
--  join that made the Current Rent Roll bind imported rows to canonical
--  positions by unit_number string — the exact seam that convergence just
--  removed. Pricing must not reintroduce it one layer down.
--
--  SAFE TO DO STRUCTURALLY: pricing_terms has 0 rows, and exactly ONE file
--  in the repo references it (src/money/commitmentledger.js). There is no
--  dormant consumer elsewhere. The legacy text column is RETAINED as
--  provenance, not dropped, so an existing row could always explain what it
--  was published as.
--
--  ── CROSS-PROPERTY IS MADE STRUCTURALLY IMPOSSIBLE ──────────────────
--  A pricing term must never reference another property's unit type. That
--  is enforced by the SHAPE of the keys rather than by a runtime check or a
--  trigger, because a check that lives in code can be bypassed by the next
--  caller:
--
--    pricing_terms(property_id, unit_type_id)
--        → property_unit_types(property_id, id)
--    pricing_terms(property_id, pricing_version_id)
--        → property_pricing_versions(property_id, id)
--
--  Both composite foreign keys carry property_id, so a term, its version and
--  its unit type cannot disagree about which property they belong to. The
--  database refuses it.
--
--  ── LEAVING ROOM FOR OVERRIDES, WITHOUT BUILDING THEM ───────────────
--  The eventual model is:
--        property pricing version → unit-type default
--          → optional later override → inventory cohort or specific space
--  This migration does NOT build cohort or space overrides. It only avoids
--  making them impossible: pricing_terms gains a nullable scope pair
--  (override_scope, override_ref) that is NULL for every type-default row.
--  A future override lands as an additional row with a narrower scope and a
--  precedence rule, rather than by mutating the type default — so a default
--  is never corrupted to express an exception.
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive; no data changes.
-- ════════════════════════════════════════════════════════════════════

-- Composite targets the child keys can reference. Both are redundant on top
-- of the existing primary keys, and exist purely so property_id can travel
-- inside the foreign key.
create unique index if not exists uq_property_unit_types_prop_id
  on property_unit_types (property_id, id);

create unique index if not exists uq_property_pricing_versions_prop_id
  on property_pricing_versions (property_id, id);

-- ── the durable reference ────────────────────────────────────────────
alter table pricing_terms add column if not exists property_id  uuid;
alter table pricing_terms add column if not exists unit_type_id uuid;

-- Legacy provenance. The text value is what a term was ORIGINALLY published
-- as; it must never again be used to resolve pricing at runtime.
comment on column pricing_terms.unit_type is
  'LEGACY PROVENANCE ONLY. The original free-text unit type. Runtime pricing resolves through unit_type_id; this column is retained so a historical row can explain itself, and is not a lookup key.';

alter table pricing_terms drop constraint if exists fk_pricing_terms_unit_type;
alter table pricing_terms add constraint fk_pricing_terms_unit_type
  foreign key (property_id, unit_type_id)
  references property_unit_types (property_id, id);

alter table pricing_terms drop constraint if exists fk_pricing_terms_version_property;
alter table pricing_terms add constraint fk_pricing_terms_version_property
  foreign key (property_id, pricing_version_id)
  references property_pricing_versions (property_id, id);

-- One priced row per (version, type, term). A second row for the same
-- combination is a contradiction, not an override.
create unique index if not exists uq_pricing_terms_version_type_term
  on pricing_terms (pricing_version_id, unit_type_id, lease_term_months)
  where unit_type_id is not null;

-- ── room for later overrides, not the overrides themselves ───────────
alter table pricing_terms add column if not exists override_scope text;
alter table pricing_terms add column if not exists override_ref   uuid;

alter table pricing_terms drop constraint if exists ck_pricing_terms_override_scope;
alter table pricing_terms add constraint ck_pricing_terms_override_scope
  check (override_scope is null or override_scope in ('inventory_cohort','space'));

-- An override must name what it overrides; a type default must name nothing.
alter table pricing_terms drop constraint if exists ck_pricing_terms_override_pair;
alter table pricing_terms add constraint ck_pricing_terms_override_pair
  check ((override_scope is null and override_ref is null)
      or (override_scope is not null and override_ref is not null));

-- ── explicit non-offer ───────────────────────────────────────────────
-- A published version may omit a marketable type ONLY by saying so. Silence
-- cannot create a property-wide published truth, so "not offered" and
-- "pricing unavailable" are values a term carries, not an absent row.
alter table pricing_terms add column if not exists offer_state text not null default 'offered';
alter table pricing_terms drop constraint if exists ck_pricing_terms_offer_state;
alter table pricing_terms add constraint ck_pricing_terms_offer_state
  check (offer_state in ('offered','not_offered','pricing_unavailable'));

-- Base rent is required when a type is actually offered, and must be absent
-- of meaning when it is not.
alter table pricing_terms drop constraint if exists ck_pricing_terms_offered_has_rent;
alter table pricing_terms add constraint ck_pricing_terms_offered_has_rent
  check (offer_state <> 'offered' or base_rent is not null);

create index if not exists ix_pricing_terms_unit_type on pricing_terms (unit_type_id);
create index if not exists ix_pricing_terms_property on pricing_terms (property_id);
