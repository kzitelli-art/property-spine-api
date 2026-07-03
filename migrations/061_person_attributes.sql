-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 061 — person_attributes (the Person Card's typed fact store)
--
--  WHY: the Person Card renders prospect vitals (move-in month, budget, unit
--  type, occupants, pets, reason) but nothing structured feeds it beyond the
--  form's move-month buried in leasing_leads.raw_payload. This is the REAL
--  store those facts accrete into — typed, SOURCED (form | ai_conversation |
--  human), timestamped, property-scoped, with full history preserved
--  (retire-then-insert, never overwrite). Doctrine: "typed, audience-scoped,
--  sourced interactions"; the Person Card grows accretively at real capture
--  events; honest blank beats confident wrong (absence of a row = unknown).
--
--  One ACTIVE row per (person, property, key). History rows stay as 'retired'.
--  source_ref points at the comm_event (AI capture) or lead (form) that the
--  fact came from — every fact carries its receipt.  Idempotent.
-- ════════════════════════════════════════════════════════════════════
begin;

create table if not exists person_attributes (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references persons(id) on delete cascade,
  property_id  uuid references properties(id) on delete cascade,   -- nullable: some facts are person-level
  attr_key     text not null check (attr_key in
                 ('move_month','budget','unit_type','occupants','pets','reason')),
  attr_value   text not null,                                      -- short human-readable value, verbatim-ish
  source       text not null check (source in ('form','ai_conversation','human')),
  source_ref   uuid,                                               -- comm_event id (AI) or lead id (form); the receipt
  status       text not null default 'active' check (status in ('active','retired')),
  created_at   timestamptz not null default now()
);

-- one active fact per key per (person, property) — history preserved as retired
create unique index if not exists uq_person_attr_active
  on person_attributes (person_id, property_id, attr_key)
  where status = 'active';

create index if not exists idx_person_attr_person
  on person_attributes (person_id, status);

commit;
