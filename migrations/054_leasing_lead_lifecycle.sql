-- 054_leasing_lead_lifecycle.sql
-- Pre-Tour AI Conversations — FOUNDATION: the leasing-lead lifecycle rail.
--
-- WHAT THIS OWNS: the append-only HISTORY of explicit commercial decisions on a
-- leasing lead's conversation (close / reopen / tour link / cancel / correction),
-- plus a durable, multi-tour conversation↔tour relation. It owns NO current-stage
-- truth: leasing_leads.status remains authoritative for opportunity existence and the
-- major exits (applied/leased/lost); the queue PROJECTION (application code) computes
-- current operating position and stores nothing. This rail is the durable memory the
-- projection and the future assessment/policy/feedback layers read.
--
-- AUTHORITY BOUNDARY (locked):
--   leasing_leads.status  → opportunity existence + exits: applied|leased|lost
--   these lifecycle events → history of explicit decisions (close/reopen/tour/correction)
--   queue projection       → current operating position (computed, unstored)
--
-- GROUNDED against live schema (verified):
--   * conversations(id) is guaranteed for every lead (043 backfills it) → it is the
--     universal per-conversation LOCK point. agent_thread_state is lazily created
--     (053) and NOT guaranteed per lead, so it is NEVER the lock and is NEVER created
--     as a side effect of a lifecycle write.
--   * scheduled_tours is the canonical CURRENT-truth tour row (048). A rescheduled row
--     is the current appointment → LIVE = status in ('scheduled','rescheduled');
--     'cancelled' = not live. Cancellation is a status change on the tour and KEEPS the
--     link; unlinked_at is an explicit mis-attribution correction ONLY.
--   * comm_events carries direction, sender_role (043), provider_status (048).
--
-- INVARIANTS ENFORCED HERE (DB, not convention):
--   * conditional-required fields per event_type (CHECK)
--   * closure reason fields absent on non-close events (CHECK)
--   * unlink requires a reason (CHECK)
--   * per-conversation monotonic ordering (unique conversation_id, event_sequence)
--   * duplicate protection (unique conversation_id, idempotency_key)
-- Cross-row relationship checks (lifecycle.property = conversation.property; a tour_*
-- event's tour shares the conversation's property AND person) cannot be expressed as a
-- table CHECK — they are asserted in the writing transaction under the conversation
-- lock. Documented in the module; not silently dropped.
--
-- FAIL-CLOSED PREFLIGHT (identical discipline to 053): refuses to apply unless the
-- schema_migrations head is exactly '053'. A generic "apply pending files" runner
-- cannot mask the migration-state question — if 053 is not the confirmed head, this
-- aborts the whole run. Rename + re-evaluate if it trips.

begin;

do $$
declare
  head text;
begin
  select version into head from schema_migrations order by version desc limit 1;
  if head is null then
    raise exception '054 preflight: schema_migrations is empty — expected head 053. Aborting.';
  end if;
  if head <> '053' then
    raise exception '054 preflight: expected head 053 but found %. Aborting — confirm the ledger and renumber if needed.', head;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- leasing_lead_lifecycle_events — append-only history of explicit commercial
-- decisions. ON DELETE RESTRICT: the operating memory is not destroyed as a casual
-- DB consequence; privacy erasure is a separate, explicit, audited process.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists leasing_lead_lifecycle_events (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references conversations(id) on delete restrict,
  property_id           uuid not null references properties(id) on delete restrict,
  event_sequence        bigint not null,                 -- per-conversation monotonic (assigned under lock)
  event_type            text not null
                          check (event_type in
                            ('closed_not_fit','reopened','tour_linked','tour_cancelled','tour_link_corrected')),
  actor_type            text not null
                          check (actor_type in ('operator','system','agent')),
  actor_id              uuid references users(id),        -- nullable (null for system/agent)
  reason_code           text
                          check (reason_code in
                            ('budget_mismatch','program_mismatch','move_timing','location',
                             'duplicate','no_longer_interested','other')),
  reason_note           text,
  source_comm_event_id  uuid references comm_events(id),  -- the inbound that caused a reopen
  tour_id               uuid references scheduled_tours(id),
  correction_reason     text,
  idempotency_key       text not null,
  occurred_at           timestamptz not null,             -- when the business event happened
  recorded_at           timestamptz not null default now(),-- when we wrote it
  metadata              jsonb not null default '{}'::jsonb,-- NARROW: provider ids / source attrs only

  -- conditional-required fields (enforced in the DB)
  constraint lle_close_requires_reason
    check (event_type <> 'closed_not_fit' or reason_code is not null),
  constraint lle_other_requires_note
    check (reason_code is distinct from 'other'
           or (reason_note is not null and btrim(reason_note) <> '')),
  constraint lle_tour_events_require_tour
    check (event_type not in ('tour_linked','tour_cancelled','tour_link_corrected')
           or tour_id is not null),
  constraint lle_correction_requires_reason
    check (event_type <> 'tour_link_corrected' or correction_reason is not null),
  -- closure fields absent on non-close events (no stray reasons on tour/reopen rows)
  constraint lle_closure_fields_only_on_close
    check (event_type = 'closed_not_fit' or (reason_code is null and reason_note is null))
);

create unique index if not exists lle_conv_sequence_unique
  on leasing_lead_lifecycle_events (conversation_id, event_sequence);
create unique index if not exists lle_conv_idem_unique
  on leasing_lead_lifecycle_events (conversation_id, idempotency_key);
create index if not exists lle_conv_latest_idx
  on leasing_lead_lifecycle_events (conversation_id, event_sequence desc);
create index if not exists lle_property_idx
  on leasing_lead_lifecycle_events (property_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- leasing_conversation_tour_links — durable, multi-tour relation between a
-- conversation and canonical scheduled_tours. Cancellation KEEPS the link (history
-- stays true); unlinked_at is a mis-attribution correction ONLY, and requires a reason.
-- ON DELETE RESTRICT for the same memory-preservation reason.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists leasing_conversation_tour_links (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations(id) on delete restrict,
  tour_id            uuid not null references scheduled_tours(id) on delete restrict,
  relationship_type  text not null default 'originated_from'
                       check (relationship_type in ('originated_from','rescheduled_to','follow_up_tour')),
  linked_at          timestamptz not null default now(),
  linked_by          uuid references users(id),           -- null only when system-linked WITH an explicit conversation_id
  unlinked_at        timestamptz,                          -- correction ONLY, never cancellation
  unlink_reason      text,
  constraint lctl_unlink_requires_reason
    check (unlinked_at is null or (unlink_reason is not null and btrim(unlink_reason) <> ''))
);

create unique index if not exists lctl_conv_tour_unique
  on leasing_conversation_tour_links (conversation_id, tour_id);
create index if not exists lctl_conv_active_idx
  on leasing_conversation_tour_links (conversation_id) where unlinked_at is null;
create index if not exists lctl_tour_idx
  on leasing_conversation_tour_links (tour_id);

insert into schema_migrations (version) values ('054');

commit;
