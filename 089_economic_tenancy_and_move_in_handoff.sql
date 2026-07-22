-- MIGRATION 089 — ECONOMIC TENANCY + MOVE-IN HANDOFF
-- Separates current rent-roll tenancy from physical possession.
-- Required move-in charges reuse scheduled_charges/payment_applications.

alter table leases
  add column if not exists economic_tenancy_activated_at timestamptz,
  add column if not exists economic_tenancy_activated_by_user_id uuid references users(id) on delete set null,
  add column if not exists economic_tenancy_activation_event_id uuid references events(id) on delete set null;

create table if not exists lease_move_in_charge_sets (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null references leases(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  executed_lease_record_id uuid not null references executed_lease_records(id) on delete restrict,
  first_period_amount numeric(14,2) not null check (first_period_amount >= 0),
  first_period_start date not null,
  first_period_end date not null,
  required_fees jsonb not null default '[]'::jsonb,
  payload_hash text not null,
  normalization_version int not null default 1,
  calculation_note text not null,
  authority_basis jsonb not null,
  confirmed_by_user_id uuid not null references users(id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  event_id uuid not null references events(id) on delete restrict,
  status text not null default 'confirmed',
  idempotency_key text,
  created_at timestamptz not null default now(),
  check (first_period_end >= first_period_start)
);

create unique index if not exists uq_move_in_charge_set_live_lease
  on lease_move_in_charge_sets(lease_id) where status='confirmed';
create unique index if not exists uq_move_in_charge_set_idempotency
  on lease_move_in_charge_sets(lease_id, idempotency_key) where idempotency_key is not null;

alter table scheduled_charges
  add column if not exists is_move_in_required boolean not null default false,
  add column if not exists move_in_requirement_key text,
  add column if not exists move_in_charge_set_id uuid references lease_move_in_charge_sets(id) on delete set null,
  add column if not exists display_label text;

create unique index if not exists uq_move_in_required_charge_key
  on scheduled_charges(lease_id, move_in_requirement_key)
  where lease_id is not null and is_move_in_required=true and move_in_requirement_key is not null;

-- keys/access preparation belongs to the PM delivery obligation, not the
-- maintenance readiness obligation. Correct only open work; history remains.
update obligations
   set required_inputs = array_remove(required_inputs, 'keys_access_ready'),
       updated_at = now()
 where module='movein' and type='readiness'
   and status in ('open','in_progress')
   and required_inputs @> array['keys_access_ready']::text[];
