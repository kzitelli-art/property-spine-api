-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 002 — FULL PRODUCTION SCHEMA BASELINE
--
--  Purpose: make the repo reproduce the LIVE production database exactly.
--  Captured by fresh introspection of the production branch on 2026-06-07.
--
--  This migration is IDEMPOTENT and SAFE to run on the existing production
--  database: every object uses "if not exists" / guarded creation, so running
--  it against the live DB changes nothing — it only fills gaps on a fresh DB
--  (e.g. the future test branch, or a rebuilt environment).
--
--  It captures the tables that had drifted out of the repo: scheduled_charges,
--  the maintenance tables (work_orders, supply_requests), and the operational
--  tables added across threads (bids, comm_events, documents, inventory,
--  ledger_entries, property_controls, turnovers, vendors).
--
--  Run AFTER 001_baseline.sql via migrate.js.
-- ════════════════════════════════════════════════════════════════════

-- ── CUSTOM TYPES (guarded — create only if absent) ────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname = 'prov') then
    create type prov as enum ('confirmed', 'assumed', 'missing');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'role_name') then
    create type role_name as enum
      ('owner','asset_manager','property_manager','leasing_agent',
       'maintenance','accountant','ai','system');
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
--  CORE SPINE TABLES (parents first, for FK ordering)
-- ════════════════════════════════════════════════════════════════════

create table if not exists properties (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  address       text,
  city          text,
  state         text,
  zip           text,
  property_type text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists units (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references properties(id) on delete cascade,
  unit_number  text not null,
  bedrooms     integer,
  bathrooms    numeric,
  square_feet  integer,
  market_rent  numeric,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint uq_unit_per_property unique (property_id, unit_number)
);

create table if not exists spaces (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references units(id) on delete cascade,
  space_label text default '(whole unit)'::text,
  created_at  timestamptz not null default now()
);

create table if not exists persons (
  id                 uuid primary key default gen_random_uuid(),
  name               text,
  email              text,
  phone              text,
  lifecycle_status   text not null default 'lead'::text,
  leasing_stage      text default 'lead'::text,
  source             text,
  interested_unit_id uuid references units(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text unique,
  phone         text,
  role          role_name not null default 'property_manager'::role_name,
  auth_provider text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  person_id   uuid references persons(id) on delete set null,
  unit_id     uuid references units(id) on delete set null,
  type        text not null default 'note'::text,
  note        text,
  occurred_at timestamptz not null default now()
);

create table if not exists leases (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  space_id              uuid not null references spaces(id) on delete restrict,
  tenant_ids            uuid[] not null default '{}'::uuid[],
  rent                  numeric,
  balance               numeric not null default 0,
  start_date            date,
  end_date              date,
  lease_status          text not null default 'active'::text,
  security_deposit      numeric,
  application_fee       numeric,
  schedule_generated_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists obligations (
  id                          uuid primary key default gen_random_uuid(),
  property_id                 uuid references properties(id) on delete cascade,
  person_id                   uuid references persons(id) on delete set null,
  unit_id                     uuid references units(id) on delete set null,
  related_id                  uuid,
  related_type                text,
  source_event_id             uuid references events(id) on delete set null,
  module                      text not null default 'leasing'::text,
  type                        text not null default 'generic'::text,
  label                       text,
  owner_type                  text not null default 'human'::text,
  assigned_role               role_name,
  assigned_user_id            uuid references users(id) on delete set null,
  escalates_to_role           role_name,
  escalates_to_user_id        uuid references users(id) on delete set null,
  status                      text not null default 'open'::text,
  required_inputs             text[] not null default '{}'::text[],
  priority                    text not null default 'normal'::text,
  severity                    text not null default 'normal'::text,
  due_at                      timestamptz,
  completed_at                timestamptz,
  escalated_at                timestamptz,
  notification_channel        text default 'in_app'::text,
  requires_acknowledgment     boolean not null default false,
  acknowledged_at             timestamptz,
  acknowledged_by             uuid references users(id) on delete set null,
  escalation_interval_minutes integer,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint ck_obl_owner_type check (owner_type = any (array['ai','human','team'])),
  constraint ck_obl_status    check (status = any (array['open','in_progress','complete','escalated'])),
  constraint ck_obl_priority  check (priority = any (array['low','normal','high'])),
  constraint ck_obl_severity  check (severity = any (array['low','normal','high','emergency']))
);

-- ════════════════════════════════════════════════════════════════════
--  REVENUE TABLES
-- ════════════════════════════════════════════════════════════════════

create table if not exists scheduled_charges (
  id                    uuid primary key default gen_random_uuid(),
  lease_id              uuid not null references leases(id) on delete cascade,
  property_id           uuid references properties(id) on delete cascade,
  charge_type           text not null,
  label                 text,
  amount                numeric not null default 0,
  due_on                date,
  status                text not null default 'scheduled'::text,
  is_move_in_gate       boolean not null default false,
  recurs                boolean not null default false,
  recur_period          text,
  concession_treatment  text,
  concession_of_months  numeric,
  source_lease_event_id uuid references events(id) on delete set null,
  amount_paid           numeric not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists ledger_entries (
  id          uuid primary key default gen_random_uuid(),
  lease_id    uuid not null references leases(id) on delete cascade,
  label       text,
  kind        text not null default 'charge'::text,
  amount      numeric not null default 0,
  method      text,
  occurred_at timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════
--  MAINTENANCE TABLES (the ones recovered as a module)
-- ════════════════════════════════════════════════════════════════════

create table if not exists vendors (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  trade            text,
  phone            text,
  email            text,
  preferred        boolean not null default false,
  insurance_status text,
  note             text,
  created_at       timestamptz not null default now()
);

create table if not exists work_orders (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references properties(id) on delete cascade,
  unit_id            uuid references units(id) on delete set null,
  person_id          uuid references persons(id) on delete set null,
  title              text,
  issue_type         text,
  description        text,
  status             text not null default 'open'::text,
  assigned_to        text,
  vendor_id          uuid references vendors(id) on delete set null,
  contact_pref       text,
  entry_permission   text,
  schedule_window    text,
  completion_note    text,
  completion_photo   text,
  source             text not null default 'staff'::text,
  field_category     text,
  operating_category text,
  gl_category        text,
  unit_state         text,
  cause              text,
  is_emergency       boolean not null default false,
  is_capex           boolean not null default false,
  billback           boolean not null default false,
  est_cost           numeric,
  needs_pm_review    boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists supply_requests (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references properties(id) on delete cascade,
  unit_id            uuid references units(id) on delete set null,
  work_order_id      uuid references work_orders(id) on delete set null,
  requested_by       text,
  item               text not null,
  quantity           text,
  reason             text,
  field_category     text,
  operating_category text,
  gl_category        text,
  est_cost           numeric,
  status             text not null default 'requested'::text,
  approved_by        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists turnovers (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references properties(id) on delete cascade,
  unit_id          uuid references units(id) on delete set null,
  outgoing_lease_id uuid references leases(id) on delete set null,
  status           text not null default 'in_progress'::text,
  ready_date       date,
  moveout_photos   boolean not null default false,
  deposit_review   boolean not null default false,
  needs            text[] not null default '{}'::text[],
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists bids (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid references properties(id) on delete cascade,
  unit_id            uuid references units(id) on delete set null,
  turnover_id        uuid references turnovers(id) on delete set null,
  work_order_id      uuid references work_orders(id) on delete set null,
  scope              text,
  vendors_contacted  integer not null default 0,
  quotes_received    integer not null default 0,
  low_quote          numeric,
  status             text not null default 'decision'::text,
  selected_vendor_id uuid references vendors(id) on delete set null,
  created_at         timestamptz not null default now()
);

create table if not exists inventory (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid references properties(id) on delete cascade,
  item_name     text not null,
  category      text,
  qty_on_hand   integer not null default 0,
  minimum_stock integer not null default 0,
  order_status  text not null default 'ok'::text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════
--  OPERATIONAL / DOCUMENT TABLES
-- ════════════════════════════════════════════════════════════════════

create table if not exists comm_events (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid references properties(id) on delete cascade,
  person_id          uuid references persons(id) on delete set null,
  unit_id            uuid references units(id) on delete set null,
  work_order_id      uuid references work_orders(id) on delete set null,
  channel            text not null default 'chat'::text,
  direction          text not null default 'inbound'::text,
  body               text,
  transcript         text,
  ai_summary         text,
  follow_up_required boolean not null default false,
  occurred_at        timestamptz not null default now()
);

create table if not exists documents (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid references properties(id) on delete cascade,
  unit_id                 uuid references units(id) on delete set null,
  person_id               uuid references persons(id) on delete set null,
  lease_id                uuid references leases(id) on delete set null,
  doc_type                text,
  name                    text,
  storage_url             text,
  satisfies_obligation_id uuid references obligations(id) on delete set null,
  effective_date          date,
  expiration_date         date,
  created_at              timestamptz not null default now()
);

create table if not exists property_controls (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references properties(id) on delete cascade,
  control_type           text not null,
  name                   text,
  status                 text not null default 'active'::text,
  severity               text not null default 'normal'::text,
  responsible_role       role_name,
  assigned_user_id       uuid references users(id) on delete set null,
  effective_date         date,
  expiration_date        date,
  due_date               date,
  renewal_lead_time_days integer,
  required_document_type text,
  last_completed_at      timestamptz,
  next_required_at       timestamptz,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════
--  INGEST STAGING TABLES
-- ════════════════════════════════════════════════════════════════════

create table if not exists ingest_runs (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references properties(id) on delete cascade,
  kind             text not null default 'rent_roll'::text,
  source_text      text not null,
  model_id         text,
  model_raw_output text,
  candidate_count  integer not null default 0,
  unclear          text[] not null default '{}'::text[],
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now()
);

create table if not exists ingest_candidates (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references ingest_runs(id) on delete cascade,
  property_id      uuid not null references properties(id) on delete cascade,
  unit_number      text,
  bedrooms         integer,
  market_rent      numeric,
  prov             prov not null default 'assumed'::prov,
  ai_note          text,
  decision_status  text not null default 'pending'::text,
  reviewed_by      uuid references users(id) on delete set null,
  reviewed_at      timestamptz,
  promoted_unit_id uuid references units(id) on delete set null,
  promoted_by      uuid references users(id) on delete set null,
  promoted_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint ck_cand_decision check (decision_status = any
    (array['pending','ready_for_promotion','approved','rejected','promoted']))
);

-- ── Neon's default scratch table (present in production; kept for parity) ──
create table if not exists playing_with_neon (
  id    integer primary key generated by default as identity,
  name  text not null,
  value real
);

-- ════════════════════════════════════════════════════════════════════
--  Done. This migration reproduces the production schema as of 2026-06-07.
-- ════════════════════════════════════════════════════════════════════
