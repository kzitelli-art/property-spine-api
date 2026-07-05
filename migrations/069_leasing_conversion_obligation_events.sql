-- ════════════════════════════════════════════════════════════════════
--  069 — LEASING CONVERSION OBLIGATION EVENTS (Release 3, Amendment 4)
--
--  The append-only history of ONE domain object: a conversion-linked
--  obligation. NOT a generic CRM timeline; NOT a second task system.
--  A single mutable link row cannot preserve the whole truth once a task
--  can move through created → reassigned → resolved → reopened →
--  resolved again. This ledger can.
--
--  Doctrine (locked):
--   · event writes and current-state mutation occur in ONE transaction;
--   · events are append-only — no update or delete route exists;
--   · a repeated idempotency_key does not create duplicate history;
--   · the link row remains the CURRENT operational projection;
--   · pre-069 history is NOT fabricated or backfilled as fake events —
--     pre-069 closures render from their existing closure columns.
--
--  event_type includes 'due_changed' (reviewer ruling): a follow-up's DUE
--  TIME changed. Deliberately NOT called 'rescheduled' — in Property Spine
--  that word means a tour/appointment moved, a different fact with
--  different downstream meaning. Allowed on ANY active task (a prospect
--  may ask at 10am to be contacted next week; staff must not have to wait
--  for the task to become overdue to record a real timing change).
--  Forward-only. Nothing destructive.
-- ════════════════════════════════════════════════════════════════════

create table if not exists leasing_conversion_obligation_events (
  id                          uuid primary key default gen_random_uuid(),
  -- ON DELETE RESTRICT (reviewer final gate §1): a cascade delete still
  -- erases history. Conversion-linked obligations and their event history
  -- must not be destructively deleted through ordinary application paths —
  -- deleting the parent link, or a conversion whose delete would cascade
  -- here, is REJECTED by the database. Retention deletion, if ever needed,
  -- is a separate archival operation with its own doctrine. Test teardown
  -- drops the test database; it gets no production escape hatch.
  conversion_obligation_id    uuid not null
                                references leasing_conversion_obligations(id) on delete restrict,

  event_type                  text not null check (event_type in
                                ('created','reassigned','resolved','reopened','due_changed')),
  occurred_at                 timestamptz not null default now(),

  -- WHO (raw session fact + the resolver's answer AT EVENT TIME — never
  -- recomputed later; unbridged actor = nulls + 'unbridged'):
  actor_user_id               uuid references users(id) on delete set null,
  actor_person_id_at_event    uuid,
  actor_assignment_id_at_event uuid,
  identity_resolution_basis   text,

  -- STATE MOVEMENT (nullable — 'created' has no prior):
  prior_status                text,
  next_status                 text,

  -- OWNERSHIP MOVEMENT (never flattened with eligibility):
  prior_owner_user_id         uuid,
  next_owner_user_id          uuid,
  ownership_origin            text check (ownership_origin is null or ownership_origin in
                                ('auto_actual_host','auto_scheduled_host','explicit_choice',
                                 'manual_reassignment','unassigned_pickup')),
  owner_eligibility_state     text check (owner_eligibility_state is null or owner_eligibility_state in
                                ('eligible_assignment','eligibility_lapsed','unassigned')),

  -- RESOLUTION FACTS (for 'resolved'; on 'reopened' they carry the PRIOR close).
  -- Closed vocabularies, DB-enforced (§3 data contract):
  resolution_code             text check (resolution_code is null or resolution_code in
                                ('completed','released','missed')),
  resolution_basis            text check (resolution_basis is null or resolution_basis in
                                ('owner','coverage','manager_intervention','completed_together',
                                 'no_longer_needed','unassigned_pickup')),

  -- RECOVERY FACTS (reopened / rescheduled):
  reason                      text,
  prior_due_at                timestamptz,
  next_due_at                 timestamptz,

  -- LINKAGE + SAFE RETRIES:
  prior_event_id              uuid references leasing_conversion_obligation_events(id) on delete restrict,
  idempotency_key             text,

  -- a recovery or timing change ALWAYS carries the new due time (§3):
  constraint lcoe_recovery_has_due check
    (event_type not in ('due_changed','reopened') or next_due_at is not null)
);

-- one event per idempotency key (retries append nothing new)
create unique index if not exists lcoe_idempotency_unique
  on leasing_conversion_obligation_events(idempotency_key)
  where idempotency_key is not null;

-- the read paths: a task's history, and a conversation's task history
create index if not exists lcoe_link_idx
  on leasing_conversion_obligation_events(conversion_obligation_id, occurred_at);


-- ══ APPEND-ONLY, ENFORCED BY THE DATABASE (reviewer §2) ══
-- Distinct from the rejected session-marker idea (which falsely claimed to
-- prove caller identity): this trigger simply enforces the immutability the
-- table explicitly promises. The task/link row stays mutable current state;
-- this ledger is the historical record and cannot be rewritten by anyone.
create or replace function lcoe_reject_mutation() returns trigger as $$
begin
  -- NO exceptions. Not for cascades, not for teardown convenience. The FK is
  -- ON DELETE RESTRICT, so parent deletion is already refused; this trigger
  -- refuses direct mutation of the record itself. History is durable truth.
  raise exception 'leasing_conversion_obligation_events is append-only: % is not permitted', TG_OP
    using errcode = 'raise_exception';
end;
$$ language plpgsql;

drop trigger if exists lcoe_append_only on leasing_conversion_obligation_events;
create trigger lcoe_append_only
  before update or delete on leasing_conversion_obligation_events
  for each row execute function lcoe_reject_mutation();
