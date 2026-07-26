-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 094 — STAFF ROLES
--
--  Formalizes the 3-tier platform role model and canonical staff roles.
--
--  Changes:
--    1. Add 'org_admin' to platform_role check constraint
--    2. Create staff_roles reference table (canonical role presets)
--    3. Seed the 5 canonical staff roles
--    4. Add role_key column to property_team_assignments (nullable,
--       references staff_roles — null = legacy/custom assignment)
-- ════════════════════════════════════════════════════════════════════

-- 1. Extend platform_role check constraint to allow org_admin
--    platform_role is a plain text column (not enum) so we drop/add the constraint.
do $$ begin
  alter table users drop constraint if exists users_platform_role_check;
exception when undefined_object then null; end $$;

alter table users
  add constraint users_platform_role_check
  check (platform_role in ('super_admin', 'org_admin', 'member'));

-- 2. Canonical staff roles reference table
create table if not exists staff_roles (
  key              text primary key,          -- e.g. 'maintenance_tech'
  label            text not null,             -- e.g. 'Maintenance Tech'
  allowed_modules  text[] not null,
  primary_modules  text[] not null,
  can_manage_roles boolean not null default false,
  description      text,
  sort_order       int not null default 0
);

-- 3. Seed canonical roles (upsert so re-running is safe)
insert into staff_roles (key, label, allowed_modules, primary_modules, can_manage_roles, description, sort_order)
values
  ('maintenance_tech',
   'Maintenance Tech',
   array['maintenance'],
   array['maintenance'],
   false,
   'Sees and updates work orders assigned to them. No access to leasing, financials, or other units.',
   10),
  ('leasing_agent',
   'Leasing Agent',
   array['leasing'],
   array['leasing'],
   false,
   'Manages tours, applications, and move-ins. Sees availability and market rents.',
   20),
  ('property_manager',
   'Property Manager',
   array['management','leasing','maintenance'],
   array['management'],
   false,
   'Full property view across leasing, maintenance, and management. Cannot manage team or reporting.',
   30),
  ('property_admin',
   'Property Admin',
   array['management','leasing','maintenance','reporting'],
   array['management'],
   true,
   'Everything a Property Manager can do plus reporting and team management at the property level.',
   40),
  ('owner',
   'Owner',
   array['management','leasing','maintenance','reporting','capital'],
   array['management'],
   true,
   'Full access including capital and reporting. Typically the asset owner or principal.',
   50)
on conflict (key) do update
  set label            = excluded.label,
      allowed_modules  = excluded.allowed_modules,
      primary_modules  = excluded.primary_modules,
      can_manage_roles = excluded.can_manage_roles,
      description      = excluded.description,
      sort_order       = excluded.sort_order;

-- 4. Add role_key to property_team_assignments (nullable — existing rows stay valid)
do $$ begin
  alter table property_team_assignments
    add column role_key text references staff_roles(key) on delete set null;
exception when duplicate_column then null; end $$;

create index if not exists idx_pta_role_key on property_team_assignments(role_key);
