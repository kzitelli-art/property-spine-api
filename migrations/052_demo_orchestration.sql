-- 052_demo_orchestration.sql
-- Two-sided live demo: cross-domain orchestration + append-only proof timeline.
-- Owns NO domain truth. References real persons / properties / units / spaces / users /
-- applications / events / obligations. The "checkpoint" is a PRESENTATION gate that
-- controls what the two-phone walkthrough may do next — it is NOT the tenant's real
-- lifecycle state (real records remain the source of truth).
--
-- Grounded against live server.js (Jun 29 2026):
--   * all ids are uuid (properties.id is uuid; ::uuid casts present)
--   * unit = apartment (units.id); space = bed within a unit (spaces.unit_id -> units.id)
--   * persons / events / obligations / users / properties are the real tables

begin;

-- ── permanent scenario definition (rarely changes) ──
create table if not exists demo_runs (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,                 -- shareable id, e.g. 'solo-live-demo'
  property_id  uuid not null references properties(id),
  unit_id      uuid references units(id),            -- apartment (unit-based properties)
  space_id     uuid references spaces(id),           -- bed (bed-based properties); one of unit/space set
  created_at   timestamptz not null default now()
);

-- ── one walk-through instance. reset = close current + open fresh, NEVER delete. ──
create table if not exists demo_attempts (
  id                     uuid primary key default gen_random_uuid(),
  demo_run_id            uuid not null references demo_runs(id) on delete cascade,
  status                 text not null default 'active'
                           check (status in ('active','completed','reset','abandoned')),
  -- PRESENTATION gate (not real lifecycle). honest first checkpoint = application_ready:
  -- "this prospect has toured; their application is invited and ready to complete."
  checkpoint             text not null default 'application_ready'
                           check (checkpoint in (
                             'application_ready','application_submitted','application_approved',
                             'lease_terms_ready','lease_sent','tenant_signed','lease_countersigned',
                             'move_in_ready','move_in_confirmed','operations','completed')),
  -- real identities
  tenant_person_id       uuid not null references persons(id),   -- fresh synthetic person per attempt
  manager_user_id        uuid not null references users(id),     -- real operator who approves/countersigns
  manager_role           text not null default 'leasing_manager',
  -- real downstream records, null until the attempt creates them
  application_id         uuid,                                   -- references applications(id); FK added once table confirmed
  lease_id               uuid,                                   -- polymorphic until lease table confirmed
  conversation_thread_id uuid,                                   -- comm_events thread
  -- two-sided access: hashes only (mirror digestToken() in applicationSubmission.js)
  tenant_token_hash      text,
  manager_token_hash     text,
  closed_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ── append-only proof for ONE attempt. links to canonical records + canonical event. ──
create table if not exists demo_events (
  id                 uuid primary key default gen_random_uuid(),
  demo_attempt_id    uuid not null references demo_attempts(id) on delete cascade,
  sequence_no        integer not null,                   -- gap-free, monotonic within attempt
  event_type         text not null,
  actor_type         text not null check (actor_type in ('tenant','manager','ai','system')),
  actor_person_id    uuid references persons(id),        -- when tenant / ai-on-behalf
  actor_user_id      uuid references users(id),          -- when manager
  actor_role         text,
  -- canonical linkage: PROVE, don't duplicate
  source_module      text,                               -- 'application_submission' | 'leasingconversion' | ...
  source_record_type text,                               -- 'application' | 'lease' | 'work_order' | ...
  source_record_id   uuid,                               -- the real downstream record
  source_event_id    uuid references events(id),         -- the canonical events row, when the domain made one
  payload_json       jsonb not null default '{}'::jsonb, -- DISPLAY/PROOF ONLY — no shadow domain state
  created_at         timestamptz not null default now(),
  unique (demo_attempt_id, sequence_no)
);

create index if not exists idx_demo_attempts_run   on demo_attempts (demo_run_id, status);
create index if not exists idx_demo_events_attempt on demo_events (demo_attempt_id, sequence_no);

commit;
