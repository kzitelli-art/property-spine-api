-- ════════════════════════════════════════════════════════════════════
--  076_person_property_classifications.sql
--
--  ⚠ RULE 11 — NUMBER IS PROVISIONAL: 076 assumes the live ceiling is 075
--  (STATE_AND_HANDOFF). Query the Neon migration ledger FIRST:
--      select max(...) from the migrations ledger table;
--  If the ceiling is not 075, RENAME this file to ceiling+1 before applying.
--
--  THE CANONICAL PROPERTY-SCOPED RECORD CLASSIFICATION.
--  Class 1 permanent product primitive.
--
--  One governed fact: "What is the current record classification for this
--  person in this property?" The same person can be internal_qa in one
--  property context and production in another — classification belongs to
--  the Person × Property relationship, never globally to the person.
--
--  This table is NOT the canonical Person × Property relationship row.
--  The relationship remains distributed across leasing_leads, leases,
--  tenant_invites, conversations, and future lifecycle facts. This table
--  stores only the classification fact.
--
--  ABSENCE IS EXPLICIT: no current row means UNCLASSIFIED. It does not
--  silently mean production. Enforcement consumers (the communications
--  boundary first; reporting/metrics/AI-prompt exclusions later) refuse
--  or exclude on absence rather than assume.
--
--  CONSENT IS NOT HERE. contact_preferences.consent_state remains the one
--  canonical channel-consent truth. QA enrollment writes BOTH facts (this
--  classification + opted_in consent) as separate canonical rows in one
--  governed transaction — see enrollInternalQa in communications_boundary.js.
--
--  HISTORY IS APPEND-ONLY: classification changes supersede the current
--  row and insert a new one in one transaction. record_class is never
--  updated in place. The partial unique index enforces one CURRENT
--  classification per (person, property).
-- ════════════════════════════════════════════════════════════════════

begin;

create table if not exists person_property_classifications (
  id                      uuid primary key default gen_random_uuid(),
  person_id               uuid not null references persons(id) on delete restrict,
  property_id             uuid not null references properties(id) on delete restrict,
  record_class            text not null
    check (record_class in ('production', 'internal_qa')),
  classified_at           timestamptz not null default now(),
  classified_by_user_id   uuid references users(id) on delete restrict,
  classification_source   text not null
    check (classification_source in (
      'operator',
      'canonical_intake',
      'migration',
      'system'
    )),
  classification_reason   text,
  superseded_at           timestamptz,
  superseded_by_user_id   uuid references users(id) on delete restrict
);

-- One CURRENT classification per Person × Property pair.
create unique index if not exists person_property_classifications_current
  on person_property_classifications (person_id, property_id)
  where superseded_at is null;

-- Read path: "current classification for this pair" and property-wide scans
-- (the central exclusion policy will read by property).
create index if not exists person_property_classifications_property
  on person_property_classifications (property_id)
  where superseded_at is null;

-- Ledger receipt (matches the established migration-ledger pattern; adjust
-- the ledger insert to the live ledger table's actual shape before applying
-- if it differs).
-- insert into schema_migrations (version, name) values (76, 'person_property_classifications');

commit;
