-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 035 — PHONE-FIRST TEAM: staff identity + access routing
--
--  Employee access made to work like the rest of Property Spine: phone is
--  identity, role is access, the accountability clock is the work. This is
--  the EMPLOYEE twin of the tenant_link rung (027/030): the same proven
--  pattern — invite → token → OTP (salted hash, never stored plain) →
--  scoped session — pointed at STAFF instead of leaseholders.
--
--  WHY users, NOT persons: persons are leaseholders/vendors (the people the
--  org chart and obligations are ABOUT). users are STAFF (the people who
--  operate). The users table (baseline 001) already reserved the auth slot
--  for exactly this — its own comment: "auth comes later; columns reserved
--  so we don't retrofit" with auth_provider 'phone_otp'. We fill that slot.
--  The obligation engine already carries assigned_user_id → users, so the
--  accountability clock connects to staff the moment they exist.
--
--  FOUR changes, all ADDITIVE and IDEMPOTENT:
--
--    1. users phone-first columns — phone_verified_at, status, and a UNIQUE
--       index on NORMALIZED phone (the login key). Phone uniqueness is the
--       identity guarantee: two staff rows can never share a verified line.
--       Existing rows (org-chart seed) keep status 'active', phone unverified
--       — honest: they predate phone login.
--
--    2. property_team_assignments — the access + ACCOUNTABILITY ROUTING table.
--       NOT just permissions. allowed_modules is the gate; primary_for_modules
--       / backup_user_id / escalates_to_user_id are the Primary/Backup/
--       Escalates-To tiers the accountability clock needs (the flat org chart
--       never stored them). can_manage_roles is the admin bit. role_title is
--       FREE TEXT (real job titles like "Lead Maintenance Tech" don't fit the
--       8-value role_name enum, and modules are the real gate anyway).
--
--    3. team_invites — staff invite links, the tenant_invites twin. Token +
--       OTP-hash slot + lockout, same lifecycle (active|accepted|expired|
--       revoked|superseded), supersede-on-resend (never two live links for
--       one phone at one property). The OTP code is NEVER stored — salted
--       hash only, mirroring 030's rule. One lockout policy, not two.
--
--    4. staff_sessions — browser session after verification, the
--       tenant_sessions twin. Scoped to one user at one property, expiring,
--       revocable.
--
--  Module vocabulary (management|leasing|maintenance|reporting) is enforced
--  at the APP layer, not a DB CHECK — same precedent as the category
--  vocabulary (007 §1b): the list can evolve without a migration.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  ledger row. NO transaction control, NO ledger insert here. Conventions
--  match 027/030 (uuid pk, timestamptz, gen_random_uuid).
-- ════════════════════════════════════════════════════════════════════

-- ── 1) users: the phone-first auth columns the 001 slot reserved ──────
alter table users
  add column if not exists phone_verified_at timestamptz,
  add column if not exists status text not null default 'active';
                  -- active | invited | suspended (app-layer vocabulary)

-- normalized-phone uniqueness: digits only, last 10 (NANP). The login key.
-- Partial: only rows that HAVE a phone participate (seed rows may not).
-- Two staff can never resolve to the same line.
create unique index if not exists uq_users_phone_normalized
  on users (regexp_replace(phone, '\D', '', 'g'))
  where phone is not null and length(regexp_replace(phone, '\D', '', 'g')) >= 10;

-- ── 2) property_team_assignments: access + accountability routing ─────
create table if not exists property_team_assignments (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references properties(id) on delete cascade,
  user_id              uuid not null references users(id) on delete cascade,
  role_title           text not null,                 -- FREE TEXT job title
  scope_type           text not null default 'property'
                         check (scope_type in ('property','portfolio','owner')),
  allowed_modules      text[] not null default '{}',  -- the access GATE (app-validated vocab)
  primary_for_modules  text[] not null default '{}',  -- which modules this user OWNS (tier 1)
  backup_user_id       uuid references users(id) on delete set null,   -- tier 2
  escalates_to_user_id uuid references users(id) on delete set null,   -- tier 3
  can_manage_roles     boolean not null default false,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- one active assignment per (user, property) — an upsert target, not a log
  unique (property_id, user_id)
);
create index if not exists idx_pta_property on property_team_assignments(property_id) where active;
create index if not exists idx_pta_user     on property_team_assignments(user_id)     where active;

-- ── 3) team_invites: staff invite links (tenant_invites twin) ─────────
create table if not exists team_invites (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references properties(id) on delete cascade,
  phone_number       text not null,                   -- E.164-ish; normalized on resolve
  invited_name       text,
  role_title         text,
  allowed_modules    text[] not null default '{}',
  scope_type         text not null default 'property',
  backup_user_id     uuid references users(id) on delete set null,
  escalates_to_user_id uuid references users(id) on delete set null,
  can_manage_roles   boolean not null default false,
  invited_by_user_id uuid references users(id) on delete set null,
  token              text not null unique,            -- the short-lived link token
  status             text not null default 'active',
                     -- active | accepted | expired | revoked | superseded
  -- OTP slot — mirrors 030. The code is NEVER stored, only a salted hash.
  otp_hash           text,
  otp_expires_at     timestamptz,
  otp_sent_at        timestamptz,                     -- rate-limits resends
  failed_attempts    integer not null default 0,      -- 5 misses revokes (one policy)
  superseded_by      uuid,                            -- newer invite id
  expires_at         timestamptz not null,
  accepted_at        timestamptz,
  accepted_user_id   uuid references users(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists idx_team_invites_property on team_invites(property_id);
create index if not exists idx_team_invites_phone    on team_invites(phone_number);

-- ── 4) staff_sessions: browser session after verify (tenant_sessions twin)
create table if not exists staff_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  token       text not null unique,
  expires_at  timestamptz not null,
  revoked     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_staff_sessions_token on staff_sessions(token);
create index if not exists idx_staff_sessions_user  on staff_sessions(user_id);
