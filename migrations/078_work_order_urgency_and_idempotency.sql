-- Migration 078 (work_order_urgency_and_idempotency) — source-neutral urgency truth on work_orders.
-- Latest applied on Neon was 077 (agent_auto_dispatch); this is 078.
-- (Assign the real number from the live Neon ledger; do NOT trust this placeholder.)
-- is_emergency is retained as the operational projection existing code depends on.
alter table work_orders
  add column if not exists urgency_status     text
    check (urgency_status in ('emergency','regular','needs_confirmation')),
  add column if not exists urgency_basis       text,
  add column if not exists urgency_decided_by  text
    check (urgency_decided_by in ('system','resident_clarification','operator')),
  add column if not exists urgency_decided_at  timestamptz;

-- backfill existing rows to a coherent state from the is_emergency projection
update work_orders
   set urgency_status    = case when is_emergency then 'emergency' else 'regular' end,
       urgency_decided_by = 'operator',
       urgency_decided_at = coalesce(updated_at, created_at, now())
 where urgency_status is null;

-- Idempotency: safe retries (no duplicate work order / obligation).
alter table work_orders add column if not exists idempotency_key text;
-- scoped to actor + property: the same key from a different tenant/property is a
-- DIFFERENT slot (never collides, never returns another person's work order).
create unique index if not exists ux_work_orders_idempotency
  on work_orders (idempotency_key, property_id, coalesce(person_id,'00000000-0000-0000-0000-000000000000'::uuid))
  where idempotency_key is not null;
