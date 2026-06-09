-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 011 — PROPERTY ALIAS REGISTRY (the canonical key)
--
--  STEP ZERO of the bridge layer. Before any cross-system join (Yardi ↔
--  Entrata ↔ MRI ↔ lender ↔ bank) is trustworthy, every string a system uses
--  for a property must resolve to ONE canonical property. Proven necessary by
--  real data: "SOLO on Chestnut" is used for BOTH 4125 and 4233; a 4233 loan
--  doc is labeled "LVL 4125" (sister code); "1438" address carries code
--  "crm1439". Name is NOT identity. Address is. (Same rule the SOLO→Uno
--  rebrand proved on units, now at the property level.)
--
--  This does NOT replace `properties`. It adds the resolution layer:
--    property_aliases — every observed (system, alias-string) → property_id.
--  A messy incoming file string gets looked up here and resolved to the one
--  canonical property, or flagged unresolved for a human (never guessed).
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  ledger row. NO transaction control, NO ledger insert here. Conventions
--  match 001/009/010 (uuid pk, timestamptz, CHECK vocab, gen_random_uuid).
-- ════════════════════════════════════════════════════════════════════

-- ── property_aliases ─────────────────────────────────────────────────
-- One row per (source_system, alias_value) a real system/file uses. Resolves
-- to the canonical property_id. The same property has many aliases; an alias
-- value is unique only WITHIN a source system (Yardi's "4233" and a folder's
-- "4233" are different source contexts).
--   source_system: which system/context the string came from
--     yardi | entrata | mri | lender | bank | sharepoint | rent_roll | other
--   alias_type: what kind of identifier it is
--     code | name | account | folder | entity | loan_number | address_string
--   confidence: resolved (human-confirmed) | proposed (system-suggested) |
--               unresolved (seen but not yet mapped — the human queue)
create table if not exists property_aliases (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid references properties(id),   -- nullable: unresolved aliases have no property yet
  source_system   text not null
                    check (source_system in ('yardi','entrata','mri','lender','bank','sharepoint','rent_roll','other')),
  alias_type      text not null default 'code'
                    check (alias_type in ('code','name','account','folder','entity','loan_number','address_string')),
  alias_value     text not null,                      -- the literal string the system uses
  confidence      text not null default 'proposed'
                    check (confidence in ('resolved','proposed','unresolved')),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- an alias string is unique within its source system (case-insensitive
  -- handled in the app layer on lookup; stored as-seen for provenance)
  unique (source_system, alias_value)
);
create index if not exists ix_property_aliases_property on property_aliases(property_id);
create index if not exists ix_property_aliases_value    on property_aliases(alias_value);
create index if not exists ix_property_aliases_confidence on property_aliases(confidence);

-- ── canonical_key on properties ──────────────────────────────────────
-- A stable human-readable canonical key per property, anchored on address
-- (identity), NOT name. e.g. '4233-CHESTNUT'. Nullable until set; unique when
-- present so two properties can't claim the same key.
alter table properties add column if not exists canonical_key text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'uq_properties_canonical_key') then
    alter table properties add constraint uq_properties_canonical_key unique (canonical_key);
  end if;
end $$;
