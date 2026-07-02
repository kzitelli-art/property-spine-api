-- ════════════════════════════════════════════════════════════════════
--  058_noshow_recovery_rail.sql
--  WHY: no-show recovery is the first place the building learns from its own
--  leasing behavior — an EVIDENCE system, human-governed. Humans approve a
--  small set of message variants; every no-show gets ONE server-owned attempt
--  record linked to the canonical person/conversation/tour; outcomes (reply →
--  rebook → attended → applied → leased) are MEASURED from existing canonical
--  events, never duplicated here. No autonomous dispatch: attempts are
--  PREPARED truthfully; transport stays dormant until consent rails are live.
--  Reversible: attempts can be voided; variants retired. IDEMPOTENT DDL.
-- ════════════════════════════════════════════════════════════════════

create table if not exists recovery_variants (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references properties(id) on delete cascade,
  variant_key    text not null,
  body_template  text not null,           -- may use {{first_name}}
  status         text not null default 'active'
                   check (status in ('active','retired')),
  approved_by    uuid references users(id),   -- human governance: who approved
  created_at     timestamptz not null default now(),
  retired_at     timestamptz,
  unique (property_id, variant_key)
);

create table if not exists recovery_attempts (
  id               uuid primary key default gen_random_uuid(),
  tour_id          uuid not null references leasing_tours(id) on delete cascade,
  person_id        uuid references persons(id) on delete set null,
  conversation_id  uuid references conversations(id) on delete set null,
  variant_id       uuid not null references recovery_variants(id) on delete restrict,
  prepared_body    text not null,          -- rendered; PREPARED, never claimed sent
  state            text not null default 'prepared'
                     check (state in ('prepared','voided')),
  created_by       uuid references users(id),  -- null = system on no-show event
  created_at       timestamptz not null default now(),
  voided_at        timestamptz,
  void_reason      text,
  constraint recovery_attempt_void_needs_reason
    check (voided_at is null or (void_reason is not null and btrim(void_reason) <> ''))
);
create index if not exists recovery_attempts_tour_idx on recovery_attempts(tour_id);
create index if not exists recovery_attempts_conv_idx on recovery_attempts(conversation_id);
create index if not exists recovery_attempts_variant_idx on recovery_attempts(variant_id);
