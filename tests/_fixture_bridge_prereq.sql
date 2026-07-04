-- Minimal PREREQUISITE fixture for testing migration 067 against a real Postgres.
-- Mirrors the PRODUCTION shapes (001/004/035/038 + tours) for ONLY the tables
-- migration 067, the resolver, the bridge workflow, and the suppression seam
-- touch or reference. A TEST fixture, not a migration. (House pattern —
-- same approach as _fixture_prereq.sql for 050.)

do $$ begin
  if not exists (select 1 from pg_type where typname='role_name') then
    create type role_name as enum (
      'owner','asset_manager','property_manager','leasing_agent',
      'maintenance','accountant','ai','system','leasing_manager'
    );
  end if;
end $$;

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- users: 001 baseline + the 035 phone-first columns (status is the second
-- activity column the locked V1 rule reads).
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,
  phone text,
  role role_name not null default 'property_manager',
  auth_provider text,
  is_active boolean not null default true,
  phone_verified_at timestamptz,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- persons: 001 baseline shape (the 'lead' default IS the leak under test).
create table if not exists persons (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  phone text,
  lifecycle_status text not null default 'lead',
  leasing_stage text default 'lead',
  source text,
  interested_unit_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  name text
);

-- assignments: EXACT 004 shape (person-keyed, is_active, NO end-date,
-- NO work-type field — the grounded constraints the resolver honors).
create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references persons(id),
  property_id uuid not null references properties(id),
  role text not null,
  spend_cap numeric,
  approval_cap numeric,
  scope text not null default 'all',
  escalates_to_assignment_id uuid references assignments(id),
  is_active boolean not null default true,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 035: sessions + the user-keyed parallel roster (reconciliation-only source).
create table if not exists staff_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists property_team_assignments (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role_title text not null,
  scope_type text not null default 'property',
  allowed_modules text[] not null default '{}',
  primary_for_modules text[] not null default '{}',
  can_manage_roles boolean not null default false,
  backup_user_id uuid references users(id),
  escalates_to_user_id uuid references users(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- events: 001 shape (the suppression seam writes the durable moves record here).
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  unit_id uuid references units(id) on delete set null,
  type text not null default 'note',
  note text,
  occurred_at timestamptz not null default now()
);

-- obligations: 001 shape (the engine's target; conversion anchor rung lands here).
create table if not exists obligations (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  unit_id uuid references units(id) on delete set null,
  related_id uuid,
  related_type text,
  source_event_id uuid references events(id) on delete set null,
  module text not null default 'leasing',
  type text not null default 'generic',
  label text,
  owner_type text not null default 'human',
  assigned_role role_name,
  assigned_user_id uuid references users(id) on delete set null,
  escalates_to_role role_name,
  escalates_to_user_id uuid references users(id) on delete set null,
  status text not null default 'open',
  required_inputs text[] not null default '{}',
  priority text not null default 'normal',
  severity text not null default 'normal',
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references users(id)
);

-- leasing_leads / leasing_tours: minimal production-true shapes the
-- conversion rail FKs against.
create table if not exists leasing_leads (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references persons(id),
  property_id uuid not null references properties(id),
  status text not null default 'new',
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists leasing_tours (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leasing_leads(id),
  property_id uuid references properties(id),
  scheduled_for timestamptz,
  status text not null default 'scheduled',
  created_at timestamptz not null default now()
);
