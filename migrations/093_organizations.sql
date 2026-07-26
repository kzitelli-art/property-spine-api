-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 093 — ORGANIZATIONS (multi-tenancy top level)
--
--  Adds the concept of a "customer" organization above properties.
--  Each organization is a separate customer of Property Spine.
--  Super admins (Tom + KZ) span all organizations and manage the platform.
--
--  Changes:
--    1. Create organizations table
--    2. Add platform_role to users ('super_admin' | 'member', default 'member')
--    3. Add organization_id FK to properties (nullable — existing properties
--       get org assigned after provisioning, not force-broken now)
--    4. Add organization_id FK to users (which org they belong to;
--       null = super admin, spans all)
--    5. Seed Tom + KZ as super_admin (updates existing rows)
-- ════════════════════════════════════════════════════════════════════

-- 1. Organizations table
create table if not exists organizations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text unique,                    -- url-safe short name, e.g. 'the-felix-group'
  plan         text not null default 'starter', -- starter | growth | enterprise
  status       text not null default 'active',  -- active | suspended | cancelled
  owner_email  text,                            -- primary contact email
  owner_name   text,
  phone        text,
  address      text,
  city         text,
  state        text,
  notes        text,                            -- internal notes (super admin only)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 2. platform_role on users
do $$ begin
  alter table users add column platform_role text not null default 'member';
exception when duplicate_column then null; end $$;

-- 3. organization_id on properties (nullable — no hard break for existing data)
do $$ begin
  alter table properties add column organization_id uuid references organizations(id) on delete set null;
exception when duplicate_column then null; end $$;
create index if not exists idx_properties_org on properties(organization_id);

-- 4. organization_id on users
do $$ begin
  alter table users add column organization_id uuid references organizations(id) on delete set null;
exception when duplicate_column then null; end $$;
create index if not exists idx_users_org on users(organization_id);

-- 5. Seed Tom + KZ as super_admin (both already exist from migration 090)
update users
   set platform_role = 'super_admin',
       organization_id = null,          -- super admins span all orgs
       updated_at = now()
 where email in ('tmysl@me.com', 'kz8434@gmail.com');
