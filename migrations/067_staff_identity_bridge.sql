-- ════════════════════════════════════════════════════════════════════
--  067 — STAFF IDENTITY BRIDGE (users ↔ persons)
--
--  The substrate only. This migration creates:
--    1. users.person_id            — the CURRENT bridge pointer (nullable,
--                                    never auto-populated, no backfill)
--    2. users.account_kind         — account classification. Default
--                                    'unclassified' is deliberate and
--                                    fail-closed: an unclassified account
--                                    can never be bridged or own work.
--    3. user_person_bridge_audit   — append-only, effective-dated history
--                                    of every bridge mutation. The pointer
--                                    is convenience; THIS is the record.
--    4. person_contexts            — ADDITIVE membership (staff | prospect |
--                                    resident | ...). A human may hold many
--                                    contexts over a lifetime; staff is a
--                                    context, never a mutually-exclusive
--                                    person type. (Contract Part 2.2 —
--                                    closes the lifecycle_status='lead'
--                                    default leak for staff-only persons.)
--
--  What this migration deliberately does NOT do:
--    • no backfill of person_id (bridges are deliberate, audited acts)
--    • no uniqueness constraint on users.person_id (live inventory first;
--      the resolver fails closed on multi-link conflicts instead)
--    • no lifecycle_status vocabulary change (staff-only persons keep the
--      floor state; exclusion is by active staff context, per contract)
--    • no Commitment Ledger enablement, no scoring, no staff Person Card
--
--  Forward-only. Applied once through schema_migrations. Never edited
--  after execution in a shared environment.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) users: the current bridge pointer ─────────────────────────────
-- ON DELETE RESTRICT: a person tied to a staff account must not be
-- physically deleted in a way that severs the identity chain.
alter table users
  add column if not exists person_id uuid references persons(id) on delete restrict;

create index if not exists idx_users_person_id
  on users (person_id) where person_id is not null;

-- ── 2) users: account classification (contract Part 2.4) ─────────────
-- 'unclassified' default is the honest state for every pre-existing row.
-- Only 'human_staff' may ever be bridged; the workflow enforces it and
-- the resolver defends it in depth.
alter table users
  add column if not exists account_kind text not null default 'unclassified'
    check (account_kind in
      ('unclassified','human_staff','service_account',
       'integration_account','shared_account','disabled_legacy')),
  add column if not exists account_kind_set_by_user_id uuid references users(id),
  add column if not exists account_kind_set_at timestamptz;

-- ── 3) the append-only, effective-dated bridge audit ─────────────────
-- Two row shapes:
--   'linked' / 'relinked'  → RANGE rows. effective_from set on write,
--                            effective_to null while current. A relink or
--                            unlink CLOSES the open range (sets its
--                            effective_to) — the only permitted mutation —
--                            and every other column is immutable.
--   'unlinked'             → EVENT rows. Zero-width (effective_from =
--                            effective_to = performed_at). Records the act.
-- performed_by_user_id is SERVER-DERIVED from the authenticated admin
-- session at the route boundary — never accepted from a request body.
-- evidence_reference is a constrained pointer, never raw sensitive data.
create table if not exists user_person_bridge_audit (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id),
  prior_person_id       uuid references persons(id),
  new_person_id         uuid references persons(id),
  action                text not null check (action in ('linked','relinked','unlinked')),
  effective_from        timestamptz not null default now(),
  effective_to          timestamptz,
  performed_by_user_id  uuid not null references users(id),
  performed_at          timestamptz not null default now(),
  reason_code           text not null,
  reason_detail         text,
  evidence_type         text not null check (evidence_type in
                          ('directory_email','sso_subject','hr_record',
                           'operator_attestation','other_reference')),
  evidence_reference    text,
  request_id            text
);

create index if not exists idx_bridge_audit_user
  on user_person_bridge_audit (user_id, performed_at desc);

create index if not exists idx_bridge_audit_person
  on user_person_bridge_audit (new_person_id) where new_person_id is not null;

-- At most ONE open effective range per user. 'unlinked' event rows always
-- carry effective_to, so they never collide with this partial index.
create unique index if not exists uq_bridge_audit_open_range
  on user_person_bridge_audit (user_id) where effective_to is null;

-- ── 4) additive person contexts (contract Part 2.2) ──────────────────
-- Membership, not type. The same person may be staff AND later a resident,
-- applicant, guarantor, vendor contact. property_id null = portfolio-wide
-- context (typical for staff working across buildings).
-- active_to null = currently active.
create table if not exists person_contexts (
  id                  uuid primary key default gen_random_uuid(),
  person_id           uuid not null references persons(id) on delete restrict,
  context_type        text not null check (context_type in
                        ('staff','prospect','resident','owner_contact',
                         'vendor_contact','guarantor')),
  property_id         uuid references properties(id),
  active_from         timestamptz not null default now(),
  active_to           timestamptz,
  created_by_user_id  uuid references users(id),
  created_at          timestamptz not null default now()
);

create index if not exists idx_person_contexts_person_active
  on person_contexts (person_id, context_type) where active_to is null;

-- One active context per (person, type, property-scope). coalesce folds the
-- nullable property into the key so "portfolio-wide staff" is one row.
create unique index if not exists uq_person_context_active
  on person_contexts (person_id, context_type,
                      coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where active_to is null;
