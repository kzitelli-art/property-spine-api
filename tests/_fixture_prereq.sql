-- Minimal PREREQUISITE fixture for testing migration 050 against a real Postgres.
-- These mirror the PRODUCTION shapes (001/004/038/048) for ONLY the tables/columns
-- migration 050 touches or references. This is a TEST fixture, not a migration.

-- NOTE: production gets pgcrypto from its 001 baseline. This local fixture relies
-- on gen_random_uuid(), which is built into Postgres core (>=13) with no extension.

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

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique,
  phone text,
  role role_name not null default 'property_manager',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  unit_number text not null,
  market_rent numeric(10,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- persons: baseline (001) shape, BEFORE 050's additions.
create table if not exists persons (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  phone text,
  lifecycle_status text not null default 'lead',
  leasing_stage text default 'lead',
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- assignments: org chart (004) shape — persons-space, role free text.
create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references persons(id),
  property_id uuid not null references properties(id),
  role text not null,
  is_active boolean not null default true,
  escalates_to_assignment_id uuid references assignments(id),
  created_at timestamptz not null default now()
);

-- leasing_leads: (038) shape including assignee_id (persons-space), BEFORE 050.
create table if not exists leasing_leads (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references persons(id),
  property_id uuid not null references properties(id),
  unit_id uuid references units(id),
  source_id uuid,
  message text,
  status text not null default 'new'
    check (status in ('new','ai_responded','tour_requested','tour_scheduled',
                      'human_takeover','applied','leased','lost')),
  assignee_id uuid references persons(id),
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists leasing_leads_one_open_per_person_property
  on leasing_leads(person_id, property_id)
  where status not in ('leased','lost');

-- scheduled_tours: (048) shape, BEFORE 050's import_mode columns.
create table if not exists scheduled_tours (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete set null,
  person_id uuid references persons(id) on delete set null,
  prospect_name text,
  prospect_phone text,
  prospect_email text,
  external_appt_id text,
  source_system text not null default 'acuity_squarespace',
  appointment_type text,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  scheduled_host_user_id uuid references users(id) on delete set null,
  status text not null default 'scheduled'
    check (status in ('scheduled','rescheduled','cancelled')),
  authority text not null default 'individual'
    check (authority in ('individual','digest')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists scheduled_tours_extappt_unique
  on scheduled_tours(source_system, external_appt_id)
  where external_appt_id is not null;
