-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 005 — MONEY EVENTS (Accounting Truth at the Event)
--
--  RECONSTRUCTED for repo reproducibility (2026-06-08), BYTE-FAITHFUL to the
--  live Neon table. Originally applied BY HAND in the Neon SQL editor (not via
--  migrate.js); version row recorded in schema_migrations, but the .sql file
--  was never committed. Reproduces the LIVE table exactly — verified from
--  information_schema + pg_constraint + pg_indexes, not from memory.
--
--  IDEMPOTENT and SAFE: guarded with "if not exists"; the table already exists
--  in production, so a re-run is a no-op. Purpose is repo↔DB reproducibility.
--
--  Money-OUT only, manual entry only. The loop: money_event (unverified) →
--  classification obligation (shared engine) → classify → human confirm →
--  verified. Unverified money is quarantined, never blends into truth. The
--  money-out-only and positive-amount rules are enforced at the DB by CHECKs.
--
--  Run AFTER 004 (FK assigned_assignment_id → assignments(id)).
-- ════════════════════════════════════════════════════════════════════

create table if not exists money_events (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references properties(id),
  unit_id                uuid references units(id),
  amount                 numeric not null,
  vendor                 text,
  spent_by_person_id     uuid references persons(id),
  occurred_on            date,
  source_kind            text not null default 'manual',
  what_for               text,
  completion             text,
  receipt_note           text,
  proposed_category      text,
  confirmed_category     text,
  status                 text not null default 'unverified',
  verified_by_person_id  uuid references persons(id),
  verified_at            timestamptz,
  obligation_id          uuid,
  assigned_assignment_id uuid references assignments(id),
  provenance             jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);

-- ── CHECK constraints (exact live names + text) ─────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'money_events_amount_check') then
    alter table money_events add constraint money_events_amount_check
      check (amount > (0)::numeric);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'money_events_completion_check') then
    alter table money_events add constraint money_events_completion_check
      check ((completion = any (array['done','pending'])) or (completion is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'money_events_source_kind_check') then
    alter table money_events add constraint money_events_source_kind_check
      check (source_kind = 'manual');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'money_events_status_check') then
    alter table money_events add constraint money_events_status_check
      check (status = any (array['unverified','verified']));
  end if;
end $$;

-- ── indexes (exact live definitions) ────────────────────────────────
create index if not exists ix_money_property  on money_events (property_id);
create index if not exists ix_money_status    on money_events (status);
create index if not exists ix_money_assignee  on money_events (assigned_assignment_id);
