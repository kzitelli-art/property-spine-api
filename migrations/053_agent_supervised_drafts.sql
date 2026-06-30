-- 053_agent_supervised_drafts.sql
-- Agent Stage A: supervised, grounded, draft-first conversation layer.
--
-- Owns NO domain truth. The agent reads canonical records (conversations, comm_events,
-- units, persons) and PROPOSES; nothing reaches a lead until a human dispatches it.
-- This migration creates the agent-run / draft / thread-state / curated-fact tables.
--
-- Grounded against live schema (Jun 2026):
--   * conversations(id) is the canonical thread identity (comm_events.conversation_id FKs to it)
--   * comm_events(id), persons(id), properties(id), units(id), spaces(id), users(id),
--     obligations(id) are the real tables; all ids are uuid
--   * live unit truth (availability, rent, type) is read from units — NOT copied here
--
-- FAIL-CLOSED PREFLIGHT: this file refuses to apply unless the schema_migrations head
-- is exactly '052'. A generic runner that applies pending files in order cannot mask
-- the migration-state question — if 052 is not the confirmed head, this aborts the
-- whole run (migrate.js rolls back and exits non-zero). Rename + re-evaluate if it trips.

begin;

do $$
declare
  head text;
begin
  select version into head
  from schema_migrations
  order by version desc
  limit 1;

  if head is null then
    raise exception '053 preflight: schema_migrations is empty — expected head 052. Aborting.';
  end if;
  if head <> '052' then
    raise exception '053 preflight: expected head 052 but found %. Aborting — confirm the ledger and renumber if needed.', head;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- agent_thread_state — one row per canonical conversation. The takeover machine.
-- conversation_id is the SOLE identity; property/person are derived from conversations.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists agent_thread_state (
  id                            uuid primary key default gen_random_uuid(),
  conversation_id               uuid not null unique references conversations(id) on delete cascade,
  mode                          text not null default 'ai_active'
                                  check (mode in ('ai_active','awaiting_review','human_takeover','paused','closed')),
  thread_version                bigint not null default 0,          -- monotonic; bumped per inbound under lock
  latest_inbound_comm_event_id  uuid references comm_events(id),
  current_review_obligation_id  uuid references obligations(id),
  updated_at                    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- agent_runs — one row per model GENERATION attempt (the audit record).
-- Owns pending/failed. Attaches to a conversation + its specific inbound event.
-- Stores the ACTUAL resolved facts (json) so "what did the agent see" is
-- reconstructable forever, even after a fact is retired.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists agent_runs (
  id                          uuid primary key default gen_random_uuid(),
  conversation_id             uuid not null references conversations(id) on delete cascade,
  inbound_comm_event_id       uuid not null references comm_events(id),   -- every run has a cause
  input_thread_version        bigint not null,                            -- the version it was generated against
  generation_no               integer not null,                          -- assigned under the thread lock
  generation_reason           text not null
                                check (generation_reason in ('initial_inbound','manager_regenerate')),
  request_idempotency_key      text,                                      -- inbound retry → same run; regen → new run
  status                      text not null default 'pending'
                                check (status in ('pending','ready','superseded','failed')),
  prompt_revision             text not null,                             -- immutable code label, e.g. 'stage-a-v1'
  policy_revision             text not null,                             -- immutable code label
  app_release                 text,                                      -- deployed build id, when available
  resolved_fact_snapshot_json jsonb not null default '[]'::jsonb,        -- the facts actually in context (+ provenance)
  fact_snapshot_hash          text not null default '',
  model                       text not null,
  provider_request_id         text,
  policy_decision             text check (policy_decision in ('safe','requires_handoff','blocked')),
  handoff_reason_code         text,                                      -- concrete, not a vague flag
  created_at                  timestamptz not null default now(),
  unique (conversation_id, input_thread_version, generation_no)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- agent_drafts — exists ONLY when the model returned text. The proposed reply.
-- generated_body is IMMUTABLE (the model's words, forever). An edit goes to
-- dispatch_body. A draft is NOT a comm_event — only dispatch writes one.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists agent_drafts (
  id                       uuid primary key default gen_random_uuid(),
  agent_run_id             uuid not null unique references agent_runs(id) on delete cascade,
  generated_body           text not null,                               -- immutable model output
  dispatch_body            text,                                        -- exact text actually sent (nullable)
  status                   text not null default 'ready'
                             check (status in ('ready','superseded','dispatched','discarded')),
  dispatched_comm_event_id uuid references comm_events(id),
  dispatched_by_user_id    uuid references users(id),                   -- server-derived demo-manager identity
  dispatched_at            timestamptz,
  superseded_at            timestamptz,
  discarded_at             timestamptz,
  review_obligation_id     uuid references obligations(id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- agent_facts — CURATED operational truth with no better canonical home.
-- NOT a shadow rent roll: availability / rent / unit type are resolved LIVE from
-- units. This holds tour windows, pet/parking policy, fees, routing, etc.
-- Absence of a fact = unknown → honest handoff (we do NOT store "not confirmed").
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists agent_facts (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references properties(id) on delete cascade,
  space_id             uuid references spaces(id),                      -- optional bed/space scope
  fact_key             text not null,                                   -- pet_policy, parking_rules, tour_window, ...
  category             text not null,                                   -- pets|parking|tours|documents|fees|routing
  rendered_text        text not null,
  source_type          text not null,
  source_record_id     uuid,
  confirmed_at         timestamptz,
  effective_until      timestamptz,
  status               text not null default 'active' check (status in ('active','retired')),
  approved_by_user_id  uuid references users(id),
  created_at           timestamptz not null default now()
);

-- one ACTIVE property-level fact per key; one ACTIVE space-level fact per key.
-- space fact overrides property fact (resolver concern); these enforce no duplicates.
create unique index if not exists uq_agent_facts_property_active
  on agent_facts (property_id, fact_key) where status = 'active' and space_id is null;
create unique index if not exists uq_agent_facts_space_active
  on agent_facts (property_id, space_id, fact_key) where status = 'active' and space_id is not null;

-- lookups
create index if not exists idx_agent_thread_open
  on agent_thread_state (conversation_id) where mode <> 'closed';
create index if not exists idx_agent_runs_inbound
  on agent_runs (inbound_comm_event_id);
create index if not exists idx_agent_runs_idem
  on agent_runs (request_idempotency_key) where request_idempotency_key is not null;
create index if not exists idx_agent_drafts_ready
  on agent_drafts (agent_run_id) where status = 'ready';
create index if not exists idx_agent_facts_active
  on agent_facts (property_id, category) where status = 'active';

commit;
