-- 197 · Inventory correction hardening: retired inventory cannot receive
-- new operative attachments, and correction commands have durable identity.
--
-- Reserved for the inventory-correction hardening lane (QB, 2026-09-13);
-- 196 is Sol's. No production migration is authorized by this file.
--
-- ── WHY ─────────────────────────────────────────────────────────────
-- 180 refuses a LEASE on retired inventory. Nothing refused an application,
-- an offer, an invitation, a work order, a tour, a scheduled event, a
-- renewal, money or a configured service point, and nothing refused a
-- NEW child position under a retired unit or a re-target of an existing
-- row onto one. A retired unit could therefore silently acquire operative
-- work that every position reader hides. The staff review reported such
-- rows only after the fact.
--
-- ── ONE FUNCTION, DECLARED PER TABLE ────────────────────────────────
-- The relationship policy lives in ONE place,
-- src/tenancy/inventory_relationship_policy.js; this file installs a
-- trigger for every table that policy marks blocks_while_operative, with
-- the same status vocabulary. The coverage gate
-- (tests/gates/gate_inventory_relationship_policy.db.js) asserts both
-- directions: every column that references units or spaces is classified,
-- and every blocking table carries this trigger with the declared
-- arguments. A new referencing column without a classification goes red;
-- it does not silently bypass retirement.
--
-- Arguments: TG_ARGV[0] status column ('' = every row is operative),
--            TG_ARGV[1] comma-separated terminal statuses,
--            TG_ARGV[2] 'operative' | 'terminal' — what a NULL status means.
--
-- INSERT: refused when the row is operative and its unit (directly, or
--         through its space) is live-retired.
-- UPDATE: refused when the row is operative on a live-retired unit AND
--         either its target moved onto that unit or it was terminal before
--         (a reopen). A row that was already operative on the same retired
--         unit stays editable: it is a reported conflict, and closing or
--         resolving it must remain possible. Moving a row INTO a terminal
--         status is always allowed.
-- The existing 180 lease trigger stays as the any-lease wall.

create or replace function refuse_operative_attachment_to_retired_inventory() returns trigger as $$
declare
  v_status_col text := coalesce(TG_ARGV[0], '');
  v_terminal   text[] := case when coalesce(TG_ARGV[1], '') = '' then array[]::text[] else string_to_array(TG_ARGV[1], ',') end;
  v_null_means text := coalesce(TG_ARGV[2], 'operative');
  new_j jsonb := to_jsonb(NEW);
  old_j jsonb;
  v_space_unit uuid; v_number text;
  v_new_units uuid[] := array[]::uuid[];
  v_old_units uuid[] := array[]::uuid[];
  v_new_operative boolean; v_old_operative boolean; v_new_retired_target boolean := false;
  v_status text;
begin
  -- Every populated relationship is a target. Some existing leasing tables
  -- already enforce unit/space agreement with their grain trigger; this wall
  -- must still see both values on every table that carries both columns.
  if new_j ? 'unit_id' and (new_j->>'unit_id') is not null then
    v_new_units := array_append(v_new_units, (new_j->>'unit_id')::uuid);
  end if;
  if new_j ? 'space_id' and (new_j->>'space_id') is not null then
    select s.unit_id into v_space_unit from spaces s where s.id = (new_j->>'space_id')::uuid;
    if v_space_unit is not null then v_new_units := array_append(v_new_units, v_space_unit); end if;
  end if;
  if coalesce(array_length(v_new_units, 1), 0) = 0 then return NEW; end if;

  if v_status_col = '' then
    v_new_operative := true;
  else
    v_status := new_j->>v_status_col;
    if v_status is null then v_new_operative := (v_null_means = 'operative');
    else v_new_operative := not (v_status = any(v_terminal)); end if;
  end if;
  if not v_new_operative then return NEW; end if;

  if TG_OP = 'UPDATE' then
    old_j := to_jsonb(OLD);
    if old_j ? 'unit_id' and (old_j->>'unit_id') is not null then
      v_old_units := array_append(v_old_units, (old_j->>'unit_id')::uuid);
    end if;
    if old_j ? 'space_id' and (old_j->>'space_id') is not null then
      select s.unit_id into v_space_unit from spaces s where s.id = (old_j->>'space_id')::uuid;
      if v_space_unit is not null then v_old_units := array_append(v_old_units, v_space_unit); end if;
    end if;
    if v_status_col = '' then
      v_old_operative := true;
    else
      v_status := old_j->>v_status_col;
      if v_status is null then v_old_operative := (v_null_means = 'operative');
      else v_old_operative := not (v_status = any(v_terminal)); end if;
    end if;
  end if;

  select u.unit_number into v_number
    from units u join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
   where u.id = any(v_new_units)
   order by u.id limit 1;
  if v_number is null then return NEW; end if;

  if TG_OP = 'UPDATE' then
    select exists(
      select 1 from units u join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
       where u.id = any(v_new_units) and not (u.id = any(v_old_units))
    ) into v_new_retired_target;
    -- An already-operative conflict may still be edited or closed, but a
    -- different retired target may never be added or re-targeted onto.
    if v_old_operative and not v_new_retired_target then return NEW; end if;
  end if;

  raise exception 'Unit % is retired from current inventory; % cannot attach operative work to it (%). Reinstate the unit first if this is real current inventory.',
    v_number, TG_TABLE_NAME, case when TG_OP = 'INSERT' then 'new attachment' when v_new_retired_target then 're-target' else 'reopen' end
    using errcode = 'check_violation';
end; $$ language plpgsql;

drop trigger if exists trg_retired_inventory_spaces on spaces;
create trigger trg_retired_inventory_spaces
  before insert or update on spaces
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

drop trigger if exists trg_retired_inventory_lease_applications on lease_applications;
create trigger trg_retired_inventory_lease_applications
  before insert or update on lease_applications
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'declined,withdrawn,expired', 'operative');

drop trigger if exists trg_retired_inventory_lease_offers on lease_offers;
create trigger trg_retired_inventory_lease_offers
  before insert or update on lease_offers
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'expired,superseded,cancelled', 'operative');

drop trigger if exists trg_retired_inventory_application_invitations on application_invitations;
create trigger trg_retired_inventory_application_invitations
  before insert or update on application_invitations
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'consumed,expired,revoked', 'operative');

drop trigger if exists trg_retired_inventory_lease_packets on lease_packets;
create trigger trg_retired_inventory_lease_packets
  before insert or update on lease_packets
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'voided,executed', 'operative');

drop trigger if exists trg_retired_inventory_lease_economic_schedules on lease_economic_schedules;
create trigger trg_retired_inventory_lease_economic_schedules
  before insert or update on lease_economic_schedules
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'cancelled,superseded', 'operative');

drop trigger if exists trg_retired_inventory_executed_lease_records on executed_lease_records;
create trigger trg_retired_inventory_executed_lease_records
  before insert or update on executed_lease_records
  for each row execute function refuse_operative_attachment_to_retired_inventory('record_state', 'superseded,voided', 'operative');

drop trigger if exists trg_retired_inventory_renewal_cases on renewal_cases;
create trigger trg_retired_inventory_renewal_cases
  before insert or update on renewal_cases
  for each row execute function refuse_operative_attachment_to_retired_inventory('terminal_state', 'executed,declined,notice_received,moved_to_turnover,closed', 'operative');

drop trigger if exists trg_retired_inventory_unit_events on unit_events;
create trigger trg_retired_inventory_unit_events
  before insert or update on unit_events
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'cancelled,superseded', 'operative');

drop trigger if exists trg_retired_inventory_tour_availability on tour_availability;
create trigger trg_retired_inventory_tour_availability
  before insert or update on tour_availability
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'cancelled', 'operative');

drop trigger if exists trg_retired_inventory_leasing_tours on leasing_tours;
create trigger trg_retired_inventory_leasing_tours
  before insert or update on leasing_tours
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'completed,no_show,cancelled,rescheduled', 'operative');

drop trigger if exists trg_retired_inventory_work_orders on work_orders;
create trigger trg_retired_inventory_work_orders
  before insert or update on work_orders
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'closed,cancelled,completed,done,resolved,void,not_done', 'operative');

drop trigger if exists trg_retired_inventory_turnovers on turnovers;
create trigger trg_retired_inventory_turnovers
  before insert or update on turnovers
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'closed,cancelled,complete,completed,done', 'operative');

drop trigger if exists trg_retired_inventory_obligations on obligations;
create trigger trg_retired_inventory_obligations
  before insert or update on obligations
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'complete,completed,cancelled,closed', 'operative');

drop trigger if exists trg_retired_inventory_unit_triage_required_work on unit_triage_required_work;
create trigger trg_retired_inventory_unit_triage_required_work
  before insert or update on unit_triage_required_work
  for each row execute function refuse_operative_attachment_to_retired_inventory('status', 'complete,withdrawn,superseded', 'operative');

drop trigger if exists trg_retired_inventory_unit_readiness_certifications on unit_readiness_certifications;
create trigger trg_retired_inventory_unit_readiness_certifications
  before insert or update on unit_readiness_certifications
  for each row execute function refuse_operative_attachment_to_retired_inventory('state', 'revoked,corrected', 'operative');

drop trigger if exists trg_retired_inventory_bids on bids;
create trigger trg_retired_inventory_bids
  before insert or update on bids
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

drop trigger if exists trg_retired_inventory_supply_requests on supply_requests;
create trigger trg_retired_inventory_supply_requests
  before insert or update on supply_requests
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

drop trigger if exists trg_retired_inventory_scheduled_charges on scheduled_charges;
create trigger trg_retired_inventory_scheduled_charges
  before insert or update on scheduled_charges
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

drop trigger if exists trg_retired_inventory_ledger_claims on ledger_claims;
create trigger trg_retired_inventory_ledger_claims
  before insert or update on ledger_claims
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

drop trigger if exists trg_retired_inventory_deposit_claims on deposit_claims;
create trigger trg_retired_inventory_deposit_claims
  before insert or update on deposit_claims
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

drop trigger if exists trg_retired_inventory_money_events on money_events;
create trigger trg_retired_inventory_money_events
  before insert or update on money_events
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

drop trigger if exists trg_retired_inventory_utility_service_points on utility_service_points;
create trigger trg_retired_inventory_utility_service_points
  before insert or update on utility_service_points
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

drop trigger if exists trg_retired_inventory_contracted_service_locations on contracted_service_locations;
create trigger trg_retired_inventory_contracted_service_locations
  before insert or update on contracted_service_locations
  for each row execute function refuse_operative_attachment_to_retired_inventory('', '', 'operative');

-- ── COMMAND IDENTITY ────────────────────────────────────────────────
-- A correction command is a durable receipt (the 188 tour-command pattern):
-- the same scoped key with the same canonical payload replays the recorded
-- result; the same key with a different payload is a conflict; retire and
-- reinstate are independent identities. The row is written INSIDE the
-- command's transaction, so a refused command leaves no receipt and a
-- concurrent duplicate waits on the unique index and then replays.
create table if not exists inventory_correction_commands (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references properties(id) on delete cascade,
  command_type     text not null check (command_type in ('retire', 'reinstate')),
  idempotency_key  text not null,
  payload_hash     text not null,
  input            jsonb not null default '{}'::jsonb,
  result           jsonb not null default '{}'::jsonb,
  actor_user_id    uuid references users(id) on delete restrict,
  assignment_id    uuid,
  recorded_at      timestamptz not null default now()
);
create unique index if not exists uq_inventory_correction_commands_key
  on inventory_correction_commands (property_id, command_type, idempotency_key);
create index if not exists idx_inventory_correction_commands_property
  on inventory_correction_commands (property_id, recorded_at desc);

comment on table inventory_correction_commands is
  'Durable identity of an inventory correction command (retire or reinstate): '
  'same scoped key and payload replay the recorded result; changed payload refuses.';
