-- 070_operator_session_bootstrap.sql
--
-- BRICK ONE (S1): real staff-session issuance foundation.
-- Three ADDITIVE changes, one migration, applied in the runner's single
-- transaction. Nothing here alters existing behavior on its own: no code
-- reads these columns/tables until the Deploy A cutover mounts it.
--
--   1) operator_session_invites  digest-only, single-use bootstrap proof.
--      The temporary (Class 2) identity-proof adapter for the first real
--      Solo staff login. Replaced by SMS OTP when Twilio/A2P is live; the
--      replacement calls the same issueStaffSession() and this table is
--      then retired per credential policy.
--
--   2) staff_sessions.token_digest  hash-at-rest for session tokens.
--      New sessions store sha256(raw token) here and NULL out nothing:
--      the legacy raw `token` column keeps serving pre-cutover sessions
--      for their remaining TTL (max 14 days). Removal condition is the
--      named hardening release SESSION-DIGEST-CLEANUP: after every
--      pre-digest session has expired, the raw-token fallback branch is
--      deleted and the raw column dropped. We are draining a liability,
--      not adding one.
--
--   3) users.account_kind gains 'internal_qa'  the ONE central
--      classification for controlled QA staff identities. Enforced at
--      output boundaries through a single shared predicate
--      (userIsOperational), never scattered per-route is_test checks.
--      Distinct from the boardroom_demo lead-source axis: internal_qa is
--      a real staff identity for controlled proof; boardroom_demo tags
--      synthetic prospects.

-- ---------------------------------------------------------------------
-- 1) Bootstrap proof table (Class 2  temporary adapter)
-- ---------------------------------------------------------------------
create table if not exists operator_session_invites (
  id                        uuid primary key default gen_random_uuid(),

  -- who this proof resolves to, and the ONE property it is bound to.
  -- The invite binds the login attempt; it never grants authority 
  -- issueStaffSession independently re-verifies the live active
  -- property_team_assignments row at consume time.
  user_id                   uuid not null references users(id) on delete cascade,
  property_id               uuid not null references properties(id) on delete cascade,

  -- sha256 hex digest of the raw invite token. The raw token is shown
  -- exactly once by the issuing CLI and never stored, logged, or echoed.
  token_digest              text not null unique,

  issuance_reason           text not null default 'bootstrap_invite',
  purpose                   text not null default 'operator_login'
                              check (purpose in ('operator_login')),

  created_at                timestamptz not null default now(),
  expires_at                timestamptz not null,
  consumed_at               timestamptz,
  revoked_at                timestamptz,

  -- proof  exact session linkage (acceptance receipts, targeted
  -- revocation, rollback). Set in the same transaction that mints the
  -- session; NULL means never successfully consumed.
  consumed_staff_session_id uuid references staff_sessions(id),

  -- attribution: which trusted operation created this invite.
  created_by_user_id        uuid references users(id),
  issuance_source           text not null default 'cli',

  -- integrity the transaction already guarantees, enforced by the schema
  -- too: a consumed invite ALWAYS names its session, and vice versa; an
  -- invite can never be born already-expired.
  constraint osi_consume_pair check (
    (consumed_at is null and consumed_staff_session_id is null)
    or
    (consumed_at is not null and consumed_staff_session_id is not null)
  ),
  constraint osi_expiry_sane check (expires_at > created_at)
);

-- consume path is: lock by digest FOR UPDATE  validate  mint  mark.
-- The unique index on token_digest doubles as the lookup index.
create index if not exists idx_osi_user_property
  on operator_session_invites (user_id, property_id);

-- ---------------------------------------------------------------------
-- 2) staff_sessions hash-at-rest (additive column; legacy rows untouched)
-- ---------------------------------------------------------------------
alter table staff_sessions
  add column if not exists token_digest text;

-- new sessions are digest-only: token becomes nullable so post-cutover rows
-- store NO raw value at all (safe by construction, not by argument). Legacy
-- rows keep their raw token until expiry; SESSION-DIGEST-CLEANUP drops the
-- column once they are all gone.
alter table staff_sessions
  alter column token drop not null;

-- sessions self-describe their issuance origin (security + audit context,
-- not merely a TTL input). Legacy pre-cutover rows stay NULL  honest blank.
-- Server-owned only; no browser or ordinary caller supplies this.
alter table staff_sessions
  add column if not exists issuance_purpose text
    check (issuance_purpose is null
           or issuance_purpose in ('demo','bootstrap_invite','sms_otp'));

-- new sessions resolve by digest; must be unique when present.
create unique index if not exists idx_staff_sessions_token_digest
  on staff_sessions (token_digest)
  where token_digest is not null;

-- ---------------------------------------------------------------------
-- 3) account_kind gains 'internal_qa'
-- ---------------------------------------------------------------------
-- 067 created the CHECK inline on ADD COLUMN, so Postgres auto-named it.
-- Look the name up from the catalog rather than guessing, drop it, and
-- re-add the same constraint with the one new value. NOT VALID + VALIDATE
-- keeps the lock cheap; existing rows already satisfy the superset.
do $$
declare
  cname text;
begin
  select conname into cname
    from pg_constraint
   where conrelid = 'users'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%account_kind%';

  if cname is not null then
    execute format('alter table users drop constraint %I', cname);
  end if;

  alter table users
    add constraint users_account_kind_check
    check (account_kind in
      ('unclassified','human_staff','service_account',
       'integration_account','shared_account','disabled_legacy',
       'internal_qa'))
    not valid;

  alter table users validate constraint users_account_kind_check;
end $$;

-- 4) BLOCKER 1 (reviewer, slice 1-3 v2): the digest-only shape is enforced
-- by the TABLE, not merely by the canonical service. Exactly two legal
-- shapes: legacy raw rows exactly as they exist today, and canonical rows
-- (digest + server-owned purpose, raw token never stored). Mixed rows,
-- raw-new-session rows, and purpose-less digest rows are rejected at write.
-- Transition-safe: NOT VALID first, then VALIDATE against existing rows.
alter table staff_sessions
  add constraint staff_sessions_token_shape_check
  check (
    (token_digest is null and token is not null and issuance_purpose is null)
    or
    (token_digest is not null and token is null and issuance_purpose is not null)
  )
  not valid;
alter table staff_sessions
  validate constraint staff_sessions_token_shape_check;

-- 5) BLOCKER 2: ONE active authority row per (property, user). Issuer and
-- resolver read one row for this pair; two active rows would make
-- entitlement nondeterministic.
--
-- WORLD-ADAPTIVE: the live constraint state of this table is a runtime
-- fact this file must not assume. If a FULL unique on (property_id,
-- user_id) already exists (the reviewer's accepted option 1), it already
-- guarantees the invariant -- more strictly -- and this section records
-- that and stops. Otherwise it guards against live duplicates (failing
-- LOUDLY, never papering over a conflict) and creates the reviewer's
-- accepted option 2: a partial active-only unique index, which permits
-- inactive reassignment HISTORY rows while forbidding a second ACTIVE row.
-- NOTE: plain CREATE INDEX, not CONCURRENTLY -- migrate.js runs each file
-- inside one transaction (CONCURRENTLY is forbidden there); the table is
-- small and Stage 1 applies this before any code cutover.
do $$
declare full_unique_name text; dup_count int;
begin
  select c.conname into full_unique_name
    from pg_constraint c
   where c.conrelid = 'property_team_assignments'::regclass
     and c.contype = 'u'
     and (select array_agg(a.attname order by a.attname)
            from unnest(c.conkey) k join pg_attribute a
              on a.attrelid = c.conrelid and a.attnum = k)
         = array['property_id','user_id']::name[];
  if full_unique_name is not null then
    raise notice 'BLOCKER-2 RECEIPT: full unique % already enforces one row per (property,user); invariant satisfied (option 1), partial index skipped.', full_unique_name;
    return;
  end if;
  select count(*) into dup_count from (
    select property_id, user_id from property_team_assignments
     where active = true group by property_id, user_id having count(*) > 1
  ) d;
  if dup_count > 0 then
    raise exception 'BLOCKER: % duplicate active assignment pair(s) exist. Run the Stage-1 duplicate scan, resolve each pair, then re-run 070.', dup_count;
  end if;
  execute 'create unique index if not exists uq_pta_one_active on property_team_assignments (property_id, user_id) where active = true';
  raise notice 'BLOCKER-2 RECEIPT: no full unique found; duplicate scan clean; partial unique uq_pta_one_active created (option 2).';
end $$;
