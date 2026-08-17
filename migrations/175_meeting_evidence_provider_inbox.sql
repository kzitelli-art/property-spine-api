-- ════════════════════════════════════════════════════════════════════
--  175 — MEETING EVIDENCE PROVIDER INBOX
--
--  The first Meeting Evidence rail. This migration deliberately stops at
--  authenticated evidence capture and human property binding.
--
--  It does NOT make meetings canonical operating truth.
--  It does NOT wire transcripts into Ask Spine.
--  It does NOT fan interpretations into obligations, leases, work orders,
--  money, or any other operating domain.
--
--  The permanent distinction is:
--
--      provider delivery evidence
--        -> provider meeting identity
--        -> explicit property binding
--
--  An unbound provider meeting is retained authenticated evidence. It is
--  not property evidence until a real staff-session user binds it.
-- ════════════════════════════════════════════════════════════════════

create table if not exists integration_connections (
  id                          uuid primary key default gen_random_uuid(),
  provider                    text not null check (provider in ('read_ai')),
  authorized_by_user_id       uuid not null references users(id) on delete restrict,
  authorized_at               timestamptz not null default now(),
  connection_status           text not null default 'active'
                                check (connection_status in ('active','disabled','revoked')),
  provider_account_metadata   jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists idx_integration_connections_provider_status
  on integration_connections (provider, connection_status);

create table if not exists meeting_webhook_security_receipts (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null check (provider in ('read_ai')),
  connection_id    uuid references integration_connections(id) on delete restrict,
  attempted_at     timestamptz not null default now(),
  body_sha256      text check (body_sha256 is null or body_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length      integer check (byte_length is null or byte_length >= 0),
  refusal_status   text not null check (refusal_status in (
                     'refused_invalid_signature',
                     'refused_missing_signature',
                     'refused_unknown_connection',
                     'refused_body_too_large'
                   )),
  request_ip       text,
  detail           text
);

create index if not exists idx_meeting_security_receipts_attempted
  on meeting_webhook_security_receipts (provider, attempted_at desc);

create table if not exists meeting_provider_deliveries (
  id                         uuid primary key default gen_random_uuid(),
  provider                   text not null default 'read_ai' check (provider in ('read_ai')),
  connection_id              uuid not null references integration_connections(id) on delete restrict,

  --  Null means this row is the logical delivery. Duplicate/anomaly rows
  --  point at the original and never become another processing run.
  related_delivery_id         uuid references meeting_provider_deliveries(id) on delete restrict,

  provider_request_id         text,
  provider_session_id         text,
  received_at                 timestamptz not null default now(),

  payload_sha256              text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length                 integer not null check (byte_length > 0 and byte_length <= 10 * 1024 * 1024),
  raw_body                    bytea not null,

  signature_header            text not null check (signature_header ~ '^[0-9a-fA-F]{64}$'),
  signature_verified          boolean not null default true check (signature_verified is true),

  delivery_state              text not null check (delivery_state in (
                                'accepted_pending_processing',
                                'processed_unbound',
                                'verified_invalid_payload',
                                'verified_unresolved_identity',
                                'processing_failed',
                                'duplicate_delivery',
                                'provider_anomaly'
                              )),
  provider_payload_metadata   jsonb not null default '{}'::jsonb,

  constraint ck_meeting_delivery_size_matches
    check (byte_length = octet_length(raw_body)),
  constraint ck_meeting_delivery_related_state
    check (
      (delivery_state in ('duplicate_delivery','provider_anomaly') and related_delivery_id is not null)
      or
      (delivery_state not in ('duplicate_delivery','provider_anomaly') and related_delivery_id is null)
    )
);

create unique index if not exists uq_meeting_provider_logical_request
  on meeting_provider_deliveries (connection_id, provider_request_id)
  where provider_request_id is not null and related_delivery_id is null;

create unique index if not exists uq_meeting_provider_unresolved_payload
  on meeting_provider_deliveries (connection_id, payload_sha256)
  where provider_request_id is null and related_delivery_id is null;

create index if not exists idx_meeting_provider_deliveries_session
  on meeting_provider_deliveries (connection_id, provider_session_id, received_at desc)
  where provider_session_id is not null;

create table if not exists meeting_provider_meetings (
  id                         uuid primary key default gen_random_uuid(),
  provider                   text not null default 'read_ai' check (provider in ('read_ai')),
  connection_id              uuid not null references integration_connections(id) on delete restrict,
  provider_session_id         text not null,
  first_delivery_id           uuid not null references meeting_provider_deliveries(id) on delete restrict,
  first_observed_at           timestamptz not null default now(),
  provider_title              text,
  provider_started_at_text    text,
  provider_ended_at_text      text,
  provider_metadata           jsonb not null default '{}'::jsonb,

  unique (connection_id, provider, provider_session_id)
);

create index if not exists idx_meeting_provider_meetings_observed
  on meeting_provider_meetings (provider, first_observed_at desc);

create table if not exists meeting_property_bindings (
  id                    uuid primary key default gen_random_uuid(),
  provider_meeting_id   uuid not null references meeting_provider_meetings(id) on delete restrict,
  property_id           uuid not null references properties(id) on delete restrict,
  bound_by_user_id      uuid not null references users(id) on delete restrict,
  bound_at              timestamptz not null default now(),
  binding_basis         text not null check (length(btrim(binding_basis)) > 0),

  unique (provider_meeting_id, property_id)
);

create index if not exists idx_meeting_bindings_property
  on meeting_property_bindings (property_id, bound_at desc);

-- ── EVIDENCE IMMUTABILITY ──────────────────────────────────────────
--  Source evidence and the human binding history are append-only. A
--  correction is another row in a later migration, not a rewrite here.
create or replace function public.meeting_evidence_append_only_refusal()
returns trigger as $$
begin
  raise exception '% is append-only: % is not permitted', tg_table_name, tg_op
    using errcode = 'restrict_violation',
          detail = 'Meeting Evidence preserves authenticated provider evidence and explicit human binding history.';
end;
$$ language plpgsql;
alter function public.meeting_evidence_append_only_refusal() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_webhook_security_receipts_append_only on meeting_webhook_security_receipts;
create trigger trg_meeting_webhook_security_receipts_append_only
  before update or delete on meeting_webhook_security_receipts
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_provider_deliveries_append_only on meeting_provider_deliveries;
create trigger trg_meeting_provider_deliveries_append_only
  before update or delete on meeting_provider_deliveries
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_provider_meetings_append_only on meeting_provider_meetings;
create trigger trg_meeting_provider_meetings_append_only
  before update or delete on meeting_provider_meetings
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_property_bindings_append_only on meeting_property_bindings;
create trigger trg_meeting_property_bindings_append_only
  before update or delete on meeting_property_bindings
  for each row execute function public.meeting_evidence_append_only_refusal();
