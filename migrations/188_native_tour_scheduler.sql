-- 188_native_tour_scheduler.sql
--
-- Property Spine owns tour scheduling. Migration 039's tour_availability rows
-- remain the exact booking truth. This migration adds the reusable weekly
-- policy that publishes those rows and the command/event receipts that retain
-- who changed the schedule and why. No provider calendar is an authority.

create table if not exists tour_schedule_policies (
  property_id             uuid primary key references properties(id) on delete cascade,
  weekly_hours            jsonb not null,
  slot_duration_minutes   integer not null default 60
                            check (slot_duration_minutes between 15 and 240),
  minimum_notice_minutes  integer not null default 120
                            check (minimum_notice_minutes between 0 and 10080),
  holiday_calendar        text not null default 'none'
                            check (holiday_calendar in ('none','us_federal_observed')),
  default_host_user_id    uuid references users(id) on delete set null,
  horizon_days            integer not null default 45
                            check (horizon_days between 7 and 180),
  active                  boolean not null default true,
  updated_by_user_id      uuid references users(id) on delete set null,
  updated_at              timestamptz not null default now(),
  check (jsonb_typeof(weekly_hours) = 'object')
);

create table if not exists tour_availability_commands (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  command_type      text not null
                      check (command_type in ('policy_published','day_closed','day_reassigned')),
  local_date        date,
  input             jsonb not null default '{}'::jsonb,
  result            jsonb not null default '{}'::jsonb,
  actor_user_id     uuid references users(id) on delete set null,
  actor_type        text not null default 'human_staff'
                      check (actor_type in ('human_staff','operator_key','system')),
  reason            text,
  idempotency_key   text,
  recorded_at       timestamptz not null default now()
);

create index if not exists idx_tour_availability_commands_property_time
  on tour_availability_commands (property_id, recorded_at desc);

create unique index if not exists uq_tour_availability_commands_idempotency
  on tour_availability_commands (property_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists tour_availability_events (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  slot_id               uuid not null references tour_availability(id) on delete cascade,
  command_id            uuid references tour_availability_commands(id) on delete set null,
  event_type            text not null
                          check (event_type in ('opened','blocked','reopened','reassigned')),
  before_status         text,
  after_status          text not null
                          check (after_status in ('open','booked','blocked')),
  before_host_user_id   uuid references users(id) on delete set null,
  after_host_user_id    uuid references users(id) on delete set null,
  actor_user_id         uuid references users(id) on delete set null,
  actor_type            text not null default 'human_staff'
                          check (actor_type in ('human_staff','operator_key','system')),
  reason                text,
  idempotency_key       text,
  event_at              timestamptz not null default now()
);

create index if not exists idx_tour_availability_events_property_time
  on tour_availability_events (property_id, event_at desc);

create index if not exists idx_tour_availability_events_slot_time
  on tour_availability_events (slot_id, event_at desc);

create unique index if not exists uq_tour_availability_events_idempotency
  on tour_availability_events (property_id, idempotency_key)
  where idempotency_key is not null;

comment on table tour_schedule_policies is
  'Current native weekly tour policy. Applying it publishes explicit tour_availability rows; it is not a virtual or provider-owned calendar.';

comment on table tour_availability_commands is
  'Attributable receipts for schedule-policy publication and atomic day-level staff adjustments.';

comment on table tour_availability_events is
  'Event receipts for native Property Spine tour-slot publication and status/host changes; application writers insert new receipts rather than editing prior ones.';
