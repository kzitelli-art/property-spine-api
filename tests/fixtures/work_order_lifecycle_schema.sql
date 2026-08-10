-- ════════════════════════════════════════════════════════════════════
--  WORK ORDER LIFECYCLE — isolated test schema.
--
--  A FAITHFUL SUBSET, not the full production schema, and it exists for
--  the same reason tests/fixtures/release0_audit_schema.sql does:
--
--    Migration 012 is NOT replayable from an empty database.
--    001_baseline.sql:238 already creates a `vendors` table with no
--    `yardi_code` column, so 012_bank_intake.sql:33's
--    `create table if not exists vendors` is a no-op and its
--    `create unique index ... on vendors (yardi_code)` at :43 then fails
--    with `column "yardi_code" does not exist`. Known and recorded —
--    docs/MIGRATION_LEDGER_INVERSE_GATE.md §4.
--
--  Repairing that history to make a test environment cooperate is
--  explicitly out of bounds. So this file does what the audit fixture
--  did: reproduce the structures the code under proof actually reads,
--  copied from their governing migrations, so the proof is a real test
--  and not a test against a convenient replica.
--
--  ── WHAT IS COPIED, AND FROM WHERE ─────────────────────────────────
--    organizations                093_organizations.sql
--    properties.organization_id   093_organizations.sql:43
--    property_team_assignments    035_phone_first_team.sql
--    staff_sessions               035_phone_first_team.sql
--    obligations acceptance       131_work_acceptance.sql:44-75, incl.
--                                 all four check constraints VERBATIM
--    work_order_progress          134_technician_lifecycle.sql
--    work_order_proof_attachments 134_technician_lifecycle.sql
--    uq_work_orders_id_property   134:47
--
--  ── WHY THE CONSTRAINTS MATTER HERE ────────────────────────────────
--  The four acceptance constraints are the whole reason this proof is
--  worth running. `acceptWork` writes assigned_user_id and
--  accepted_by_user_id together and flips status off 'open'; if any of
--  that were wrong the database refuses the row. Copying the columns
--  without the constraints would produce a green run that proves the
--  fixture rather than the service.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

do $$ begin
  create type role_name as enum (
    'owner','asset_manager','property_manager','leasing_agent',
    'maintenance','accountant','ai','system'
  );
exception when duplicate_object then null; end $$;

create table organizations (
  id   uuid primary key default gen_random_uuid(),
  name text not null
);

create table properties (
  id              uuid primary key default gen_random_uuid(),
  name            text,
  organization_id uuid references organizations(id) on delete set null
);

create table units (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  unit_number text
);

create table users (
  id   uuid primary key default gen_random_uuid(),
  name text
);

create table persons (
  id   uuid primary key default gen_random_uuid(),
  name text
);

--  035_phone_first_team.sql — the access GATE the operator routes read.
create table if not exists property_team_assignments (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references properties(id) on delete cascade,
  user_id              uuid not null references users(id) on delete cascade,
  role_title           text not null,
  scope_type           text not null default 'property'
                         check (scope_type in ('property','portfolio','owner')),
  allowed_modules      text[] not null default '{}',
  primary_for_modules  text[] not null default '{}',
  can_manage_roles     boolean not null default false,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (property_id, user_id)
);

--  035_phone_first_team.sql, verbatim.
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

create table events (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  person_id   uuid references persons(id) on delete set null,
  unit_id     uuid references units(id) on delete set null,
  type        text not null,
  note        text,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

--  Subset of 001_baseline work_orders plus the columns later migrations
--  added that this slice reads: 042 not_done_reason / needs_pm_review,
--  133 work_order_ref, 098 the person columns.
create table work_orders (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  unit_id               uuid references units(id) on delete set null,
  title                 text,
  status                text not null default 'open',
  urgency_status        text,
  work_order_ref        text,
  not_done_reason       text,
  needs_pm_review       boolean not null default false,
  completion_note       text,
  completion_photo      text,
  reported_by_person_id uuid references persons(id) on delete set null,
  affected_person_id    uuid references persons(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

--  134:47, verbatim. work_order_progress's composite FK depends on it.
create unique index if not exists uq_work_orders_id_property
  on work_orders (id, property_id);

--  Subset of 001_baseline obligations: the columns this slice reads or
--  writes, plus every acceptance column and constraint from 131.
create table obligations (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid references properties(id) on delete cascade,
  person_id       uuid references persons(id) on delete set null,
  unit_id         uuid references units(id) on delete set null,
  related_id      uuid,
  related_type    text,
  source_event_id uuid references events(id) on delete set null,
  module          text not null default 'leasing',
  type            text not null default 'generic',
  label           text,
  owner_type      text not null default 'human',
  assigned_role        role_name,
  assigned_user_id     uuid references users(id) on delete set null,
  escalates_to_role    role_name,
  escalates_to_user_id uuid references users(id) on delete set null,
  status          text not null default 'open',
  required_inputs text[] not null default '{}',
  priority        text not null default 'normal',
  severity        text not null default 'normal',
  due_at          timestamptz,
  completed_at    timestamptz,
  ownership_origin text,
  accepted_by_user_id uuid references users(id),
  accepted_at         timestamptz,
  acceptance_key      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

--  131_work_acceptance.sql:50-71 — all four, VERBATIM. These are the
--  reason this proof means anything.
alter table obligations add constraint ck_oblig_acceptance_paired
  check ((accepted_by_user_id is null) = (accepted_at is null));
alter table obligations add constraint ck_oblig_accepter_is_owner
  check (accepted_by_user_id is null or assigned_user_id = accepted_by_user_id);
alter table obligations add constraint ck_oblig_accepted_not_open
  check (accepted_at is null or status <> 'open');
alter table obligations add constraint ck_oblig_acceptance_key_requires_acceptance
  check (acceptance_key is null or accepted_at is not null);
create unique index if not exists uq_obligations_acceptance_key
  on obligations (acceptance_key) where acceptance_key is not null;

--  The columns work_order_status_read reads off comm_events.
create table comm_events (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references properties(id) on delete cascade,
  person_id               uuid references persons(id) on delete set null,
  body                    text,
  direction               text,
  channel                 text,
  classification          text,
  sms_status              text,
  sms_sid                 text,
  sms_error               text,
  derived_from_progress_id uuid,
  created_object_type     text,
  created_object_id       uuid,
  occurred_at             timestamptz not null default now(),
  created_at              timestamptz not null default now()
);

--  134_technician_lifecycle.sql, verbatim.
create table if not exists work_order_progress (
  id                 uuid primary key default gen_random_uuid(),
  work_order_id      uuid not null,
  property_id        uuid not null references properties(id) on delete cascade,
  kind               text not null check (kind in (
                       'en_route', 'no_access', 'blocked', 'finding',
                       'completion_claimed', 'completed'
                     )),
  reported_by_user_id uuid not null references users(id),
  note               text,
  source_comm_event_id uuid references comm_events(id),
  idempotency_key    text,
  occurred_at        timestamptz not null default now(),
  constraint fk_wop_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete cascade
);
create unique index if not exists uq_work_order_progress_idem
  on work_order_progress (idempotency_key) where idempotency_key is not null;
create index if not exists idx_wop_work on work_order_progress (work_order_id, occurred_at asc);

--  134_technician_lifecycle.sql, subset: the columns the proof read uses.
create table if not exists work_order_proof_attachments (
  id                   uuid primary key default gen_random_uuid(),
  work_order_id        uuid not null,
  property_id          uuid not null references properties(id) on delete cascade,
  uploaded_by_user_id  uuid not null references users(id),
  source_comm_event_id uuid references comm_events(id),
  provider             text,
  mime_type            text not null
                         check (mime_type in ('image/jpeg','image/png','image/webp')),
  byte_size            integer,
  received_at          timestamptz not null default now(),
  stored_at            timestamptz,
  storage_state        text not null default 'received'
                         check (storage_state in ('received','stored','failed','rejected')),
  proof_classification text not null default 'unclassified',
  constraint fk_wopa_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete cascade
);

-- ── WHAT THE REAL SESSION RESOLVER READS ────────────────────────────
--  identity/staff_session_service.js RESOLVER_SQL joins users and
--  property_team_assignments and filters on u.is_active / u.status. The
--  proof authenticates through THAT function, so these columns are not
--  optional: without them every request 500s at the gate and the run
--  would prove nothing about the routes behind it.
--
--  token_digest is digest-at-rest (post-cutover). The legacy raw-token
--  branch is kept so the resolver's real WHERE clause is exercised as
--  written rather than half of it.
alter table users add column if not exists phone        text;
alter table users add column if not exists email        text;
alter table users add column if not exists role         role_name;
alter table users add column if not exists is_active    boolean not null default true;
alter table users add column if not exists status       text not null default 'active';
alter table users add column if not exists account_kind text not null default 'human_staff';

alter table staff_sessions add column if not exists token_digest text;

-- ── WHAT THE SHARED OBLIGATION ENGINE WRITES ────────────────────────
--  shared/obligation_engine.js:74 inserts 22 columns. Three of them were
--  added after 001_baseline and are absent from the subset above, so the
--  insert was rejected — and the route reported an honest 503 while the
--  proof was, correctly, red.
--
--  Every routed follow-up in this slice is born from that engine, so
--  these are not optional decoration: without them `Still needs work`
--  cannot record anything at all.
alter table obligations add column if not exists parent_obligation_id    uuid references obligations(id);
alter table obligations add column if not exists owner_eligibility_state text;
alter table obligations add column if not exists dedupe_key              text;
--  086:23, VERBATIM — including its `type = 'operational_escalation'`
--  scope. An unscoped unique index here would be STRICTER than production
--  and could fail a write the real database accepts, which is a fixture
--  inventing a constraint and calling it a finding.
create unique index if not exists uq_obligations_operational_escalation_dedupe
  on obligations (dedupe_key)
  where type = 'operational_escalation' and dedupe_key is not null;
