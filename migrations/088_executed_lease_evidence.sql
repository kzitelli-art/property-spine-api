-- ════════════════════════════════════════════════════════════════════
--  088_executed_lease_evidence.sql
--
--  THE PERMANENT DOORWAY through which a really-executed lease becomes
--  operating truth. Not a signing system: Property Spine does not sign
--  anything. An authorized staff member attests that a governing lease
--  exists, identifies WHICH EXACT DOCUMENT VERSION, and records its
--  normalized governing terms.
--
--  Mirrors the 085 proposed-terms pattern deliberately: normalized terms
--  + payload hash + supersession lineage + idempotency + staff actor +
--  an immutable event written first. One pattern for "a governed,
--  hashed, superseded, attested terms record."
--
--  PREMISES: space_id, not unit_id. `leases` anchors to space_id, the
--  possession writer resolves through lease.space_id, and space_position
--  is one row per space (a by-bed lease commits a specific bed). The
--  canonical leaseable atom is the space.
--
--  CLASSIFICATION: Class 1 permanent primitive. A paper lease, a
--  DocuSign envelope, or a future in-product signing system all land
--  here. Nothing in this migration is demo scaffolding.
-- ════════════════════════════════════════════════════════════════════

create table if not exists executed_lease_records (
  id                      uuid primary key default gen_random_uuid(),

  application_id          uuid not null references lease_applications(id),
  property_id             uuid not null references properties(id),
  -- CANONICAL PREMISES. NOT NULL by ruling: an executed residential lease
  -- with no identified premises may not enter operating truth.
  space_id                uuid not null references spaces(id),
  -- back-filled when confirm-term creates the tenancy anchor
  lease_id                uuid null references leases(id),

  -- ── normalized governing terms (same normalizer as 085) ──
  rent                    numeric(12,2) not null,
  security_deposit        numeric(12,2) not null,
  lease_start_date        date not null,
  lease_end_date          date not null,
  concession_status       text not null default 'none',
  -- a non-none concession must point at canonical normalized economics;
  -- otherwise hash equality would imply concession equality it cannot prove
  concession_schedule_id  uuid null references lease_economic_schedules(id),
  payload_hash            text not null,
  -- without this, a future normalization change silently makes old and new
  -- hashes incomparable with no way to detect it
  normalization_version   int  not null default 1,

  -- ── document identity ──
  -- a mutable path is CONTEXT, never proof
  document_reference      text null,
  document_sha256         text null,
  provider_name           text null,
  provider_document_id    text null,
  provider_version_id     text null,
  document_version        int  not null default 1,

  -- ── execution facts (four distinct times, never collapsed) ──
  executed_at             date not null,
  effective_date          date null,
  signers                 jsonb not null,
  execution_channel       text not null,

  -- ── verification: recording is an attested act, distinct from signing ──
  verified_by_user_id     uuid not null references users(id),
  verified_at             timestamptz not null default now(),
  event_id                uuid not null references events(id),

  -- ── lifecycle: append-only. Never updated in place, never deleted. ──
  record_state            text not null default 'verified',
  supersedes_record_id    uuid null references executed_lease_records(id),
  void_reason             text null,
  voided_by_user_id       uuid null references users(id),
  voided_at               timestamptz null,

  -- ── ADMISSION (phase 2). Recording truth is never blocked; operational
  --    activation is. A conflict is a durable, readable state — not a
  --    failed request and not a rolled-back record. Without this the
  --    evidence would exist with nobody able to see what must happen next.
  admission_status        text not null default 'pending',
  admission_blockers      jsonb not null default '[]'::jsonb,
  admission_evaluated_at  timestamptz null,

  idempotency_key         text null,
  created_at              timestamptz not null default now(),

  constraint executed_lease_state_ck
    check (record_state in ('verified','superseded','voided')),

  constraint executed_lease_channel_ck
    check (execution_channel in ('paper','external_esign','other')),

  constraint executed_lease_term_ck
    check (lease_end_date > lease_start_date),

  -- IMMUTABLE DOCUMENT IDENTITY: a folder path plus human attestation is
  -- too weak to unlock tenancy. Require a content hash OR an immutable
  -- provider document+version pair.
  constraint executed_lease_document_identity_ck
    check (
      document_sha256 is not null
      or (provider_document_id is not null and provider_version_id is not null)
    ),

  -- a non-none concession may not rest on a bare status word
  constraint executed_lease_concession_ck
    check (concession_status = 'none' or concession_schedule_id is not null),

  constraint executed_lease_signers_ck
    check (jsonb_typeof(signers) = 'array' and jsonb_array_length(signers) > 0),

  constraint executed_lease_admission_ck
    check (admission_status in ('pending','admitted','blocked')),

  constraint executed_lease_void_ck
    check (record_state <> 'voided' or (voided_by_user_id is not null and void_reason is not null))
);

-- ONE live verified record per application. A correction supersedes or
-- voids; it never edits.
create unique index if not exists executed_lease_one_live_per_application
  on executed_lease_records (application_id)
  where record_state = 'verified';

create unique index if not exists executed_lease_idempotency
  on executed_lease_records (application_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists executed_lease_by_lease
  on executed_lease_records (lease_id);

create index if not exists executed_lease_by_space
  on executed_lease_records (space_id);

-- current pointer, matching the 085 projection pattern
alter table lease_applications
  add column if not exists executed_lease_record_id uuid null
    references executed_lease_records(id);

-- ════════════════════════════════════════════════════════════════════
--  APPEND-ONLY ADMISSION HISTORY
--
--  executed_lease_records carries the LATEST verdict for fast reads.
--  That row is a projection and it is overwritten. This table preserves
--  WHAT HAPPENED: a conflict that later clears must not vanish from
--  history. Never updated, never deleted — one row per evaluation.
-- ════════════════════════════════════════════════════════════════════
create table if not exists executed_lease_admission_evaluations (
  id                        uuid primary key default gen_random_uuid(),
  executed_lease_record_id  uuid not null references executed_lease_records(id),
  application_id            uuid not null references lease_applications(id),
  result                    text not null,
  blockers                  jsonb not null default '[]'::jsonb,
  -- exactly which records were compared, so a verdict can be re-read later
  -- without guessing what it was computed from
  sources_compared          jsonb not null default '{}'::jsonb,
  evaluation_context        text not null,
  evaluated_by_user_id      uuid null references users(id),
  evaluated_at              timestamptz not null default now(),

  constraint ela_result_ck  check (result in ('admitted','blocked')),
  constraint ela_context_ck check (evaluation_context in ('verify','confirm_term','re_evaluation'))
);

create index if not exists ela_by_record
  on executed_lease_admission_evaluations (executed_lease_record_id, evaluated_at desc);
create index if not exists ela_by_application
  on executed_lease_admission_evaluations (application_id, evaluated_at desc);
