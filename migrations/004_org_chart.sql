-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 004 — ORG CHART v1 (Per-Property Responsibility Map)
--
--  RECONSTRUCTED for repo reproducibility (2026-06-08), BYTE-FAITHFUL to the
--  live Neon table. This migration was originally applied BY HAND in the Neon
--  SQL editor (not via migrate.js); its version row is recorded in
--  schema_migrations but the .sql file was never committed. This file
--  reproduces the LIVE table exactly — verified from information_schema +
--  pg_constraint + pg_indexes dumps, not from memory.
--
--  IDEMPOTENT and SAFE: every object guarded with "if not exists". The table
--  already exists in production, so a re-run is a no-op. Purpose is repo↔DB
--  reproducibility — do NOT re-run expecting to create anything.
--
--  The assignments table = the core org-chart object: a person assigned to a
--  property in a role, with spend/approval caps, scope, and an escalation
--  pointer to another assignment. Accountable owner is a designation on the
--  property (accountable_assignment_id), NOT a role.
--
--  Role + scope vocabularies are enforced by CHECK constraints (the DB is the
--  guard; orgchart.js mirrors them in app code). Caps: numeric, nullable —
--  convention in app code is 0=none, null=N/A, -1=unlimited.
--
--  Run AFTER 003.
-- ════════════════════════════════════════════════════════════════════

-- ── assignments: person ↔ property ↔ role, with caps + escalation ───
create table if not exists assignments (
  id                          uuid primary key default gen_random_uuid(),
  person_id                   uuid not null references persons(id),
  property_id                 uuid not null references properties(id),
  role                        text not null,
  spend_cap                   numeric,
  approval_cap                numeric,
  scope                       text not null default 'all',
  escalates_to_assignment_id  uuid references assignments(id),
  is_active                   boolean not null default true,
  provenance                  jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now()
);

-- ── CHECK constraints: fixed role + scope vocabularies (exact live names) ──
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_assign_role') then
    alter table assignments add constraint ck_assign_role
      check (role = any (array['property_manager','maintenance','leasing','bookkeeper','asset_manager','owner']));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_assign_scope') then
    alter table assignments add constraint ck_assign_scope
      check (scope = any (array['all','maintenance','leasing','accounting','management']));
  end if;
end $$;

-- ── indexes (exact live definitions) ────────────────────────────────
-- The partial-unique that enforces "one active assignment per person+property+role"
-- — this is what orgchart.js relies on (catches 23505 = duplicate active role).
create unique index if not exists ux_assign_person_prop_role_active
  on assignments (person_id, property_id, role) where (is_active = true);
create index if not exists ix_assign_person
  on assignments (person_id) where (is_active = true);
create index if not exists ix_assign_property
  on assignments (property_id) where (is_active = true);

-- ── properties.accountable_assignment_id: the accountable-owner designation ──
-- A property's "who owns the truth" is a pointer to ONE assignment (not a role).
alter table properties add column if not exists accountable_assignment_id uuid references assignments(id);
