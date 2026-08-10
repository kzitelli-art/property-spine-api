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
    property_id uuid references properties(id), name text,
    phone text, primary_phone_e164 text);
  create table units (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id), unit_number text);
  create table leases (
    id uuid primary key default gen_random_uuid(),
    property_id uuid references properties(id),
    unit_id uuid references units(id),
    tenant_ids uuid[] not null default '{}',
    lease_status text not null default 'active');
  create table leasing_leads (
    id uuid primary key default gen_random_uuid(),
    person_id uuid references persons(id),
    property_id uuid references properties(id),
    status text not null default 'open');
  create table tenant_invites (
    id uuid primary key default gen_random_uuid(),
    person_id uuid references persons(id),
    property_id uuid references properties(id),
    status text not null default 'used');

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
    --  001_baseline. Present in production and previously omitted here
    --  because nothing this fixture served had read it. The work-order
    --  status read now describes a routed follow-up from the IMMUTABLE
    --  event that created it — `work_orders.not_done_reason` holds only the
    --  latest key — so the join is load-bearing, and without the column the
    --  whole live read 503s and the door honestly renders UNAVAILABLE.
    source_event_id uuid references events(id) on delete set null,
    module text not null default 'leasing',
    assigned_role role_name,
    escalates_to_role role_name,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now());

  create table contact_preferences (
    id uuid primary key default gen_random_uuid(),
    person_id uuid not null references persons(id) on delete cascade,
    channel text not null default 'text',
    consent_state text not null default 'unknown',
    updated_at timestamptz not null default now(),
    source text);
  create unique index contact_prefs_person_channel on contact_preferences(person_id, channel);

  create table person_property_classifications (
    id uuid primary key default gen_random_uuid(),
    person_id uuid not null references persons(id),
    property_id uuid not null references properties(id),
    record_class text not null check (record_class in ('production','internal_qa')),
    classified_at timestamptz not null default now(),
    classification_source text not null default 'operator',
    superseded_at timestamptz,
    notes text);
