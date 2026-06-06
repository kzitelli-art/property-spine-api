-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 001 — BASELINE
--
--  This migration reproduces the ENTIRE live production schema as it
--  actually exists in Neon as of June 6 2026. It is the starting point.
--  Every change to the schema from here forward is a NEW numbered migration
--  (002, 003, ...). The database is never hand-edited again.
--
--  It is built from two sources, reconciled so it matches production exactly:
--    1. The repo schema (core spine, revenue shell, maintenance, obligations,
--       property controls, enums, the spaces trigger) — included verbatim below.
--    2. The drifted-in ingest tables (ingest_runs, ingest_candidates), which
--       were created by hand in Neon and never made it into the repo. These are
--       reconstructed below from a live introspection of the production DB —
--       exact column types, the prov enum, the ck_cand_decision CHECK with its
--       real allowed values, the uq_unit_per_property unique constraint, and
--       every index — confirmed against Neon, not guessed.
--
--  Everything uses IF NOT EXISTS / duplicate-safe guards, so applying this to
--  a database that already has these objects (like production) is harmless —
--  it simply confirms they exist. Applying it to a fresh, empty database
--  (like a new test branch) builds the whole schema from nothing.
--
--  NOTE ON SCOPE: this baseline covers every table the deployed API reads or
--  writes plus the modeled-but-unbuilt shells from the repo. Two further sets
--  of objects that also drifted in via separate session SQL files —
--  `scheduled_charges` (revenue) and the maintenance session tables — are
--  handled in migration 002, captured the same verified way (see the companion
--  introspection queries). 001 deliberately stops at what is confirmed here so
--  nothing in the baseline is a guess.
-- ════════════════════════════════════════════════════════════════════


create extension if not exists "pgcrypto";

-- ── PROVENANCE ────────────────────────────────────────────────────────
-- Mirrors the front-end idea: every value is confirmed / assumed / missing.
-- In SQL we keep it lightweight: nullable columns ARE "missing"; a separate
-- provenance map is overkill for v1. Where provenance matters (AI guessed a
-- value), we store it in a *_prov column alongside. Used sparingly for now.
do $$ begin
  create type prov as enum ('confirmed','assumed','missing');
exception when duplicate_object then null; end $$;

-- ── ROLES ─────────────────────────────────────────────────────────────
-- Role enum drives obligation ownership & escalation. Extend as needed.
do $$ begin
  create type role_name as enum (
    'owner','asset_manager','property_manager','leasing_agent',
    'maintenance','accountant','ai','system'
  );
exception when duplicate_object then null; end $$;

-- ── USERS (minimal) ───────────────────────────────────────────────────
-- Not full auth today. Just enough that an obligation can belong to a real
-- person ("Katie"), not only a role. auth columns left for later.
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text unique,
  phone         text,
  role          role_name not null default 'property_manager',
  -- auth comes later; columns reserved so we don't retrofit:
  auth_provider text,            -- e.g. 'phone_otp', 'password', null for now
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════
--  THE SPINE
-- ════════════════════════════════════════════════════════════════════

-- ── PROPERTY ──────────────────────────────────────────────────────────
create table if not exists properties (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  address       text,
  city          text,
  state         text,
  zip           text,
  property_type text,            -- suggestion only, never a silent branch
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── UNIT ──────────────────────────────────────────────────────────────
create table if not exists units (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,
  unit_number   text not null,
  bedrooms      int,
  bathrooms     numeric(3,1),
  square_feet   int,
  market_rent   numeric(10,2),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_units_property on units(property_id);

-- ── SPACE ─────────────────────────────────────────────────────────────
-- Invariant (enforced in app + trigger below): every unit has ≥1 space,
-- and a lease attaches to a SPACE, never directly to a unit. This is what
-- lets whole-unit and by-the-bed leasing share one code path.
create table if not exists spaces (
  id            uuid primary key default gen_random_uuid(),
  unit_id       uuid not null references units(id) on delete cascade,
  space_label   text default '(whole unit)',
  created_at    timestamptz not null default now()
);
create index if not exists idx_spaces_unit on spaces(unit_id);

-- ── PERSON ────────────────────────────────────────────────────────────
-- DURABLE across the lifecycle. Status changes; the record is never replaced.
create table if not exists persons (
  id               uuid primary key default gen_random_uuid(),
  name             text,
  email            text,
  phone            text,
  lifecycle_status text not null default 'lead',  -- lead|applicant|tenant|past
  leasing_stage    text default 'lead',
  source           text,
  interested_unit_id uuid references units(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── LEASE ACCOUNT ─────────────────────────────────────────────────────
-- Attaches to space_id (never unit_id — see invariant). tenant_ids is an
-- array of person ids (multiple tenants per lease).
create table if not exists leases (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,
  space_id      uuid not null references spaces(id) on delete restrict,
  tenant_ids    uuid[] not null default '{}',
  rent          numeric(10,2),
  balance       numeric(10,2) not null default 0,
  start_date    date,
  end_date      date,
  lease_status  text not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_leases_property on leases(property_id);
create index if not exists idx_leases_space on leases(space_id);

-- ── LEDGER ────────────────────────────────────────────────────────────
create table if not exists ledger_entries (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid not null references leases(id) on delete cascade,
  label         text,
  kind          text not null default 'charge',  -- charge | payment
  amount        numeric(10,2) not null default 0,
  method        text,
  occurred_at   timestamptz not null default now()
);
create index if not exists idx_ledger_lease on ledger_entries(lease_id);

-- ── EVENT ─────────────────────────────────────────────────────────────
-- Something that HAPPENED. Events are what create obligations.
create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid references properties(id) on delete cascade,
  person_id     uuid references persons(id) on delete set null,
  unit_id       uuid references units(id) on delete set null,
  type          text not null default 'note',
  note          text,
  occurred_at   timestamptz not null default now()
);
create index if not exists idx_events_property on events(property_id);

-- ── COMMUNICATION EVENT ───────────────────────────────────────────────
-- Its own object, not a flavor of event. The seam for the comms-capture layer.
create table if not exists comm_events (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid references properties(id) on delete cascade,
  person_id     uuid references persons(id) on delete set null,
  unit_id       uuid references units(id) on delete set null,
  work_order_id uuid,                      -- fk added after work_orders exists
  channel       text not null default 'chat',  -- call|text|email|voicemail|chat|emergency_line|portal
  direction     text not null default 'inbound',
  body          text,
  transcript    text,
  ai_summary    text,
  follow_up_required boolean not null default false,
  occurred_at   timestamptz not null default now()
);
create index if not exists idx_comm_property on comm_events(property_id);

-- ── WORK ORDER ────────────────────────────────────────────────────────
create table if not exists work_orders (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references properties(id) on delete cascade,
  unit_id         uuid references units(id) on delete set null,
  person_id       uuid references persons(id) on delete set null,  -- reporting tenant
  title           text,
  issue_type      text,
  description     text,
  status          text not null default 'open',     -- open|scheduled|complete
  assigned_to     text,
  vendor_id       uuid,                              -- fk added after vendors
  contact_pref    text,
  entry_permission text,
  schedule_window text,
  completion_note text,                              -- required before complete
  completion_photo text,
  source          text not null default 'staff',     -- staff | tenant
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_wo_property on work_orders(property_id);

-- backfill the comm_events fk now that work_orders exists
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_comm_wo') then
    alter table comm_events
      add constraint fk_comm_wo foreign key (work_order_id)
      references work_orders(id) on delete set null;
  end if;
end $$;

-- ── TURNOVER ──────────────────────────────────────────────────────────
create table if not exists turnovers (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references properties(id) on delete cascade,
  unit_id            uuid references units(id) on delete set null,
  outgoing_lease_id  uuid references leases(id) on delete set null,
  status             text not null default 'in_progress',
  ready_date         date,
  moveout_photos     boolean not null default false,
  deposit_review     boolean not null default false,
  needs              text[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── VENDOR ────────────────────────────────────────────────────────────
create table if not exists vendors (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  trade         text,
  phone         text,
  email         text,
  preferred     boolean not null default false,
  insurance_status text,
  note          text,
  created_at    timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_wo_vendor') then
    alter table work_orders
      add constraint fk_wo_vendor foreign key (vendor_id)
      references vendors(id) on delete set null;
  end if;
end $$;

-- ── BID ───────────────────────────────────────────────────────────────
create table if not exists bids (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid references properties(id) on delete cascade,
  unit_id           uuid references units(id) on delete set null,
  turnover_id       uuid references turnovers(id) on delete set null,
  work_order_id     uuid references work_orders(id) on delete set null,
  scope             text,
  vendors_contacted int not null default 0,
  quotes_received   int not null default 0,
  low_quote         numeric(10,2),
  status            text not null default 'decision',  -- decision | selected
  selected_vendor_id uuid references vendors(id) on delete set null,
  created_at        timestamptz not null default now()
);

-- ── INVENTORY ─────────────────────────────────────────────────────────
create table if not exists inventory (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid references properties(id) on delete cascade,
  item_name     text not null,
  category      text,
  qty_on_hand   int not null default 0,
  minimum_stock int not null default 0,
  order_status  text not null default 'ok',  -- ok | needs_order | ordered
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── DOCUMENT ──────────────────────────────────────────────────────────
-- A document is not just a file. It can satisfy a required input, close an
-- obligation, and update a property control. (Behavior built later; shape now.)
create table if not exists documents (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid references properties(id) on delete cascade,
  unit_id         uuid references units(id) on delete set null,
  person_id       uuid references persons(id) on delete set null,
  lease_id        uuid references leases(id) on delete set null,
  doc_type        text,            -- lease|license|insurance|receipt|checklist|...
  name            text,
  storage_url     text,            -- provider URL later; null for now
  satisfies_obligation_id uuid,    -- fk added after obligations
  effective_date  date,
  expiration_date date,
  created_at      timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════
--  THE ENGINE — OBLIGATIONS
--  One event can create multiple obligations for different roles/users.
--  Role-level AND user-level ownership both present; user nullable.
-- ════════════════════════════════════════════════════════════════════
create table if not exists obligations (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid references properties(id) on delete cascade,
  person_id       uuid references persons(id) on delete set null,
  unit_id         uuid references units(id) on delete set null,

  -- what this obligation is attached to (polymorphic, kept loose for v1)
  related_id      uuid,
  related_type    text,            -- work_order|turnover|lease|property_control|...
  source_event_id uuid references events(id) on delete set null,

  module          text not null default 'leasing',  -- leasing|maintenance|accounting|controls
  type            text not null default 'generic',   -- lead_response|tour_feedback|lease_review|wo_closeout|control_renewal|...
  label           text,

  -- OWNERSHIP — both levels. Role always; specific user optional.
  owner_type      text not null default 'human',     -- ai | human | team
  assigned_role        role_name,                    -- e.g. leasing_agent
  assigned_user_id     uuid references users(id) on delete set null,  -- e.g. Katie (nullable)
  escalates_to_role    role_name,
  escalates_to_user_id uuid references users(id) on delete set null,  -- nullable

  -- STATE + PROOF
  status          text not null default 'open',      -- open|in_progress|complete|escalated
  required_inputs text[] not null default '{}',      -- still-outstanding inputs; empty = satisfied
  priority        text not null default 'normal',    -- low|normal|high
  severity        text not null default 'normal',    -- low|normal|high|emergency

  -- THE CLOCK (behavior is read-time only for now; columns support more later)
  due_at          timestamptz,                       -- null = status-only (no clock)
  completed_at    timestamptz,
  escalated_at    timestamptz,

  -- NOTIFICATION (columns reserved — NO behavior built yet; Twilio/email later)
  notification_channel    text default 'in_app',     -- in_app|email|text|phone_call
  requires_acknowledgment boolean not null default false,
  acknowledged_at         timestamptz,
  acknowledged_by         uuid references users(id) on delete set null,
  escalation_interval_minutes int,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_obl_property on obligations(property_id);
create index if not exists idx_obl_status on obligations(status);
create index if not exists idx_obl_role on obligations(assigned_role);
create index if not exists idx_obl_due on obligations(due_at);

-- backfill the documents fk now that obligations exists
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_doc_obligation') then
    alter table documents
      add constraint fk_doc_obligation foreign key (satisfies_obligation_id)
      references obligations(id) on delete set null;
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
--  PROPERTY CONTROLS — first-class. Turns "PM software" into "control system".
--  A control expiring/coming-due is an EVENT that spawns an OBLIGATION
--  through the same loop. Behavior built later; shape now.
-- ════════════════════════════════════════════════════════════════════
create table if not exists property_controls (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references properties(id) on delete cascade,
  control_type            text not null,    -- rental_license|coo|lead_safe|tax|insurance|lender_report|permit|inspection|utility|service_contract|vendor_insurance|compliance
  name                    text,
  status                  text not null default 'active',  -- active|expiring|expired|pending|complete
  severity                text not null default 'normal',
  responsible_role        role_name,
  assigned_user_id        uuid references users(id) on delete set null,
  effective_date          date,
  expiration_date         date,
  due_date                date,
  renewal_lead_time_days  int,
  required_document_type  text,
  last_completed_at       timestamptz,
  next_required_at        timestamptz,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists idx_control_property on property_controls(property_id);
create index if not exists idx_control_expiration on property_controls(expiration_date);

-- ════════════════════════════════════════════════════════════════════
--  INVARIANT — every unit has ≥1 space. Auto-create the mirroring space.
--  (App also enforces this; the trigger guarantees it at the data layer.)
-- ════════════════════════════════════════════════════════════════════
create or replace function ensure_unit_space() returns trigger as $$
begin
  insert into spaces (unit_id, space_label) values (new.id, '(whole unit)');
  return new;
end; $$ language plpgsql;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_unit_space') then
    create trigger trg_unit_space after insert on units
      for each row execute function ensure_unit_space();
  end if;
end $$;


-- ════════════════════════════════════════════════════════════════════
--  INGEST TABLES — AI rent-roll staging.
--  Reconstructed from a live introspection of production (June 6 2026).
--  These drifted in via hand-run SQL in Neon and were never in the repo;
--  this section is the canonical definition from here forward.
--
--  The flow: ingest -> ingest_runs + ingest_candidates -> approve -> promote.
--  Provenance vs decision are kept separate and explicit:
--    prov            = the AI's BELIEF about a row (confirmed|assumed|missing)
--    decision_status = the HUMAN/SYSTEM decision about the row
--    promoted_*      = the canonical state the row entered (a real unit exists)
-- ════════════════════════════════════════════════════════════════════

-- ── INGEST RUNS ───────────────────────────────────────────────────────
-- One row per ingest attempt. Stores verbatim input, the raw model output,
-- and the model id — the audit anchor for everything the run produced.
create table if not exists ingest_runs (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  kind              text not null default 'rent_roll',   -- rent_roll | rent_roll_file
  source_text       text not null,                       -- verbatim input
  model_id          text,                                -- INGEST_MODEL used
  model_raw_output  text,                                -- raw model output
  candidate_count   integer not null default 0,
  unclear           text[] not null default '{}',        -- rows the model couldn't place
  created_by        uuid references users(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists idx_ingest_runs_property on ingest_runs(property_id);

-- ── INGEST CANDIDATES ─────────────────────────────────────────────────
-- One row per extracted unit, held for review. Nothing here is a real unit
-- until it is approved (a human decision) and then promoted (creates the unit
-- and records the transition on promoted_unit_id / promoted_at / promoted_by).
create table if not exists ingest_candidates (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references ingest_runs(id) on delete cascade,
  property_id       uuid not null references properties(id) on delete cascade,
  unit_number       text,
  bedrooms          integer,
  market_rent       numeric,
  prov              prov not null default 'assumed',     -- AI belief (the prov enum)
  ai_note           text,
  decision_status   text not null default 'pending',     -- human/system decision
  reviewed_by       uuid references users(id) on delete set null,
  reviewed_at       timestamptz,
  promoted_unit_id  uuid references units(id) on delete set null,
  promoted_by       uuid references users(id) on delete set null,
  promoted_at       timestamptz,
  created_at        timestamptz not null default now(),
  -- The exact CHECK from production. These five values are the full set the
  -- promote/approve logic depends on; 'ready_for_promotion' in particular was
  -- the source of an earlier production break when it was missing.
  constraint ck_cand_decision check (
    decision_status = any (array[
      'pending'::text,
      'ready_for_promotion'::text,
      'approved'::text,
      'rejected'::text,
      'promoted'::text
    ])
  )
);
create index if not exists idx_ingest_cand_run on ingest_candidates(run_id);
create index if not exists idx_ingest_cand_status on ingest_candidates(decision_status);

-- ── UNITS DEDUP CONSTRAINT ────────────────────────────────────────────
-- The promote step relies on this: a re-run that produces a duplicate
-- (property_id, unit_number) is caught by the database, not silently doubled.
-- Named exactly as it exists in production: uq_unit_per_property.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'uq_unit_per_property'
  ) then
    alter table units
      add constraint uq_unit_per_property unique (property_id, unit_number);
  end if;
end $$;
