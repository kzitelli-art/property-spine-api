-- ════════════════════════════════════════════════════════════════════
--  079_tour_booking_idempotency.sql
--  RULE 11: verify Neon ceiling = 078 before applying. Rename if not.
--
--  GOVERNED AGENT TOUR BOOKING — durable structures.
--
--  1. leasing_tours.booking_idempotency_key — DURABLE anchor tied to a specific
--     CONFIRMATION ACTION (NOT the lead). Retried delivery of the same
--     confirmation converges on the SAME tour. Server-namespaced by the caller
--     ('agent-book-tour:<conversation_id>:<message_sid>:<slot_id>'); the model
--     never supplies it, and the demo-link path uses its own namespace. The
--     partial UNIQUE index enforces exactly-once per key (a concurrent retry
--     raises 23505 -> caught, returns existing tour). Distinct from the slot
--     lock, which stops two DIFFERENT people taking one slot.
--
--  2. agent_tour_offers — the DURABLE OFFER RECORD. A slot becomes confirmable
--     ONLY because it was actually PRESENTED to the prospect in an outbound
--     message, not merely because it sat in the model's context. Each row is
--     one offer the agent made, connecting:
--        · conversation_id + lead_id + property_id  (scope)
--        · agent_run_id                             (the run that offered)
--        · outbound_comm_event_id                   (the message that stated it)
--        · slot_ids (jsonb array)                   (EXACTLY the slots stated)
--        · offered_at + expires_at                  (freshness)
--        · status: 'active' | 'superseded' | 'consumed'
--     SUPERSESSION (not mere age): a NEW active offer for a conversation
--     supersedes prior active offers by default (they flip to 'superseded').
--     Confirmation resolves against the MOST RECENT still-'active', unexpired
--     offer for the conversation — so a slot from a superseded earlier offer is
--     refused unless the newer offer re-stated it. This prevents contradictory
--     offers staying simultaneously bookable.
-- ════════════════════════════════════════════════════════════════════
begin;

alter table leasing_tours
  add column if not exists booking_idempotency_key text;

create unique index if not exists leasing_tours_booking_idem_key
  on leasing_tours (booking_idempotency_key)
  where booking_idempotency_key is not null;

create table if not exists agent_tour_offers (
  id                      uuid primary key default gen_random_uuid(),
  conversation_id         uuid not null references conversations(id) on delete cascade,
  lead_id                 uuid references leasing_leads(id) on delete set null,
  property_id             uuid not null references properties(id) on delete cascade,
  agent_run_id            uuid references agent_runs(id) on delete set null,
  outbound_comm_event_id  uuid references comm_events(id) on delete set null,
  slot_ids                jsonb not null default '[]'::jsonb,   -- EXACTLY the slots stated
  offered_at              timestamptz not null default now(),
  expires_at              timestamptz not null,
  status                  text not null default 'active'
                            check (status in ('active','superseded','consumed')),
  created_at              timestamptz not null default now()
);
create index if not exists agent_tour_offers_conv_active_idx
  on agent_tour_offers (conversation_id, offered_at desc) where status = 'active';

-- THE INVARIANT, ENFORCED BY THE DATABASE: at most ONE active offer per
-- conversation. recordTourOffer supersedes-then-inserts in one transaction, so
-- this can never be violated in normal operation; the index makes it a hard
-- guarantee rather than a lookup-ordering hope. If two concurrent offer writes
-- ever raced, the second insert would raise 23505 (unique_violation) instead of
-- leaving two active offers — a controlled failure, not silent contradiction.
create unique index if not exists agent_tour_offers_one_active_per_conv
  on agent_tour_offers (conversation_id) where status = 'active';

-- ledger receipt (match the live ledger's padded-text convention):
-- insert into schema_migrations (version, name) values ('079', 'tour_booking_idempotency');

commit;
