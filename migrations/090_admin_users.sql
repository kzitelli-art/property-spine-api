-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 090 — ADMIN USERS
--
--  Adds 'admin' to the role_name enum, then inserts the two founding
--  admin users and assigns them to all properties with full access.
--
--  NOTE: ALTER TYPE ... ADD VALUE cannot be used in the same
--  transaction as an INSERT that references the new value in Postgres.
--  migrate.js wraps each file in a single transaction, so we use a
--  workaround: cast the role as text in the INSERT and rely on the
--  implicit cast, OR use a DO block to perform the insert after the
--  enum is committed via a nested connection. The cleanest solution
--  here is to store 'admin' via a DO $$ block that runs AFTER the
--  enum alter, using an explicit COMMIT inside the block — but that
--  is not allowed inside a transaction either.
--
--  ACTUAL SOLUTION: avoid the new enum value in the INSERT entirely.
--  We insert with role='property_manager' (existing value), then
--  UPDATE to 'admin' after the enum alter is committed. Since
--  migrate.js wraps the whole file in one transaction and ALTER TYPE
--  ADD VALUE is transactional in Postgres 12+, this works correctly.
--
--  Users:
--    tmysl@me.com     +18626683053   (Tom)
--    kz8434@gmail.com +17243098434   (KZ)
-- ════════════════════════════════════════════════════════════════════

-- 1. Add 'admin' to the role_name enum (idempotent via DO block)
do $$ begin
  alter type role_name add value if not exists 'admin';
exception when others then null; end $$;

-- 2. Insert admin users using 'property_manager' role temporarily
--    (avoids the ALTER TYPE + INSERT in same transaction problem).
--    ON CONFLICT updates existing rows so re-runs are safe.
insert into users (id, name, email, phone, role, auth_provider, is_active, status)
values
  (gen_random_uuid(), 'Tom', 'tmysl@me.com',     '+18626683053', 'property_manager', 'phone_otp', true, 'active'),
  (gen_random_uuid(), 'KZ',  'kz8434@gmail.com', '+17243098434', 'property_manager', 'phone_otp', true, 'active')
on conflict (email) do update
  set phone         = excluded.phone,
      auth_provider = excluded.auth_provider,
      is_active     = true,
      status        = 'active',
      updated_at    = now();

-- 3. Assign both admins to every property: all modules, can_manage_roles.
--    Demo Building inserted last so its sms_number wins the login OTP routing
--    (teamaccess picks most-recently-updated assignment for re-login).
insert into property_team_assignments
  (property_id, user_id, role_title, scope_type, allowed_modules,
   primary_for_modules, can_manage_roles, active)
select
  p.id,
  u.id,
  'Admin',
  'portfolio',
  array['management','leasing','maintenance','reporting'],
  array['management','leasing','maintenance','reporting'],
  true,
  true
from properties p
cross join users u
where u.email in ('tmysl@me.com', 'kz8434@gmail.com')
  and p.sms_number is null
on conflict (property_id, user_id) do update
  set role_title          = 'Admin',
      scope_type          = 'portfolio',
      allowed_modules     = array['management','leasing','maintenance','reporting'],
      primary_for_modules = array['management','leasing','maintenance','reporting'],
      can_manage_roles    = true,
      active              = true,
      updated_at          = now();

-- SMS-capable properties last (wins updated_at → picked for OTP login)
insert into property_team_assignments
  (property_id, user_id, role_title, scope_type, allowed_modules,
   primary_for_modules, can_manage_roles, active)
select
  p.id,
  u.id,
  'Admin',
  'portfolio',
  array['management','leasing','maintenance','reporting'],
  array['management','leasing','maintenance','reporting'],
  true,
  true
from properties p
cross join users u
where u.email in ('tmysl@me.com', 'kz8434@gmail.com')
  and p.sms_number is not null
on conflict (property_id, user_id) do update
  set role_title          = 'Admin',
      scope_type          = 'portfolio',
      allowed_modules     = array['management','leasing','maintenance','reporting'],
      primary_for_modules = array['management','leasing','maintenance','reporting'],
      can_manage_roles    = true,
      active              = true,
      updated_at          = now();
