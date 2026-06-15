-- 040_proposed_records.sql
-- ===========================================================================
-- SPINE ACTIVATION V1 — the proposed-records ledger (the CLAIM layer).
--
-- DOCTRINE: a proposed record is NOT a unit/lease/tenant yet. It is a
-- structured claim, extracted from file evidence, waiting for a human
-- signature. There is no generic `claims` table in the system; for Activation
-- V1, THIS table IS the claim layer. Lineage to evidence is carried in
-- evidence_refs (JSON), NOT a foreign key to a claims table.
--
-- A proposed record becomes operating truth only through confirmation:
-- the operator confirms one row, and in ONE atomic transaction the activation
-- module writes the live structural tie (unit -> space -> lease -> person),
-- marks this row `promoted` with promoted_record_id, and satisfies the
-- confirmation obligation. Same write-then-satisfy pattern every proven
-- module already uses. No separate confirmation system.
--
-- V1 SCOPE: leasing only. One rent-roll row = one proposed_record with
-- target_type='lease'. The payload carries everything the three live writes
-- need. We do NOT split a row into per-type proposals.
-- ===========================================================================

create table if not exists activations (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid,                         -- nullable: V1 may activate a bare property
  property_id   uuid references properties(id),
  source_label  text,                         -- e.g. "4233 Chestnut rent roll" / filename
  status        text not null default 'open', -- open / activated / abandoned
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists proposed_records (
  id                 uuid primary key default gen_random_uuid(),
  activation_id      uuid not null references activations(id) on delete cascade,
  property_id        uuid references properties(id),

  -- WHAT this claim is about
  module             text not null default 'leasing',   -- leasing / maintenance / reporting / management / capital
  target_type        text not null,                     -- V1: 'lease'

  -- identity / dedup within an activation
  natural_key        text,                              -- e.g. unit_number, or unit_number+tenant_name

  -- the extracted claim itself (raw) and a cleaned/canonical version
  payload_json       jsonb not null default '{}'::jsonb,
  normalized_json    jsonb,

  -- LINEAGE — no FK to a claims table; evidence carried here
  evidence_refs      jsonb not null default '[]'::jsonb, -- [{file, row, page, ...}]

  confidence         numeric,                            -- 0..1, honest (low is allowed)

  -- lifecycle of the CLAIM
  --   staged       — extracted, not yet looked at
  --   needs_review — flagged: missing/ambiguous required field (anti-Mark)
  --   blocked      — cannot be confirmed as-is (e.g. no unit_number)
  --   confirmed    — human signed; about to promote (transient, same txn)
  --   promoted     — live tie written; promoted_record_id set
  --   rejected     — human rejected the claim
  --   conflicted   — collides with another proposal/live row
  status             text not null default 'staged',
  status_reason      text,                               -- why needs_review/blocked/conflicted

  conflict_group_id  uuid,                               -- group rows that contend
  promoted_record_id uuid,                               -- the live lease id, once promoted

  confirmed_by       text,
  confirmed_at       timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_proposed_activation on proposed_records(activation_id);
create index if not exists idx_proposed_status     on proposed_records(status);
create index if not exists idx_proposed_property   on proposed_records(property_id);

-- one rent-roll row should not stage twice for the same activation+unit
create unique index if not exists uq_proposed_natural
  on proposed_records(activation_id, target_type, natural_key)
  where natural_key is not null;
