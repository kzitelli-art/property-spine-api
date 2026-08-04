  create extension if not exists pgcrypto;
  do $$ begin
    create type role_name as enum ('owner','asset_manager','property_manager',
      'leasing_agent','maintenance','accountant','ai','system');
  exception when duplicate_object then null; end $$;

  create table organizations (
    id uuid primary key default gen_random_uuid(),
    name text not null, slug text unique, status text not null default 'active',
    created_at timestamptz not null default now());

  create table properties (
    id uuid primary key default gen_random_uuid(),
    name text not null, address text,
    organization_id uuid references organizations(id) on delete set null,
    sms_number text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now());

  create table users (
    id uuid primary key default gen_random_uuid(),
    name text not null, email text unique, phone text,
    role role_name not null default 'maintenance',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now());

  create table persons (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id), name text);
  create table units (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id), unit_number text);
  create table leases (id uuid primary key default gen_random_uuid());

  create table property_team_assignments (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    role_title text not null default 'tech',
    active boolean not null default true,
    unique (property_id, user_id));

  create table conversations (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    person_id uuid not null references persons(id) on delete cascade,
    unit_id uuid references units(id) on delete set null,
    lease_id uuid references leases(id) on delete set null,
    status text not null default 'open',
    last_message_at timestamptz,
    created_at timestamptz not null default now(),
    unique (property_id, person_id));

  create table comm_events (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id) on delete cascade,
    person_id uuid references persons(id) on delete set null,
    unit_id uuid references units(id) on delete set null,
    conversation_id uuid references conversations(id) on delete set null,
    work_order_id uuid,
    channel text not null default 'chat',
    direction text not null default 'inbound',
    body text, ai_summary text, classification text,
    created_object_type text, created_object_id uuid,
    sms_sid text, sms_status text, sms_error text,
    actor_user_id uuid references users(id) on delete set null,
    needs_human boolean not null default false,
    occurred_at timestamptz not null default now());
  create unique index idx_comm_sms_sid on comm_events(sms_sid) where sms_sid is not null;

  create table events (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id) on delete cascade,
    person_id uuid references persons(id) on delete set null,
    unit_id uuid references units(id) on delete set null,
    type text not null default 'note', note text,
    occurred_at timestamptz not null default now());

  create table work_orders (
    id uuid primary key default gen_random_uuid(),
    property_id uuid not null references properties(id) on delete cascade,
    unit_id uuid references units(id) on delete set null,
    title text, status text not null default 'open',
    created_at timestamptz not null default now());

  create table obligations (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id) on delete cascade,
    person_id uuid references persons(id) on delete set null,
    unit_id uuid references units(id) on delete set null,
    related_id uuid, related_type text,
    type text not null default 'generic', label text,
    assigned_user_id uuid references users(id) on delete set null,
    status text not null default 'open',
    required_inputs text[] not null default '{}',
    priority text not null default 'normal', severity text not null default 'normal',
    ownership_origin text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now());
