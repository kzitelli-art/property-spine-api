-- ════════════════════════════════════════════════════════════════════
--  Release 0 audit — isolated test schema.
--
--  A FAITHFUL SUBSET, not the full production schema. Migration 012 is
--  not replayable from an empty database (the legacy 012 ledger naming
--  issue in MIGRATION_LEDGER_INVERSE_GATE.md §4), so the full chain
--  cannot be applied here.
--
--  What matters for proving the audit's queries is that the structures
--  the queries read are IDENTICAL to production's. The two tables the
--  audit depends on are copied VERBATIM from
--  migrations/134_technician_lifecycle.sql -- including every check
--  constraint, default, composite foreign key and index -- so query D1
--  is a real test rather than a test against a convenient replica.
--
--  work_orders carries the baseline columns the audit reads. It is NOT
--  the full baseline table.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

create table properties (
  id   uuid primary key default gen_random_uuid(),
  name text
);

create table units (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  unit_number text
);

create table users (
  id   uuid primary key default gen_random_uuid(),
  name text
);

--  Subset of 001_baseline.sql work_orders: the columns the audit reads.
--  NOTE: there is no completed_at column here because there is none in
--  production either -- that absence is the finding, and reproducing it
--  faithfully is the point.
create table work_orders (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references properties(id) on delete cascade,
  unit_id          uuid references units(id) on delete set null,
  status           text not null default 'open',
  completion_note  text,
  completion_photo text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

--  134:47, verbatim.
create unique index if not exists uq_work_orders_id_property
  on work_orders (id, property_id);

create table comm_events (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade
);

create table if not exists work_order_progress (
  id                 uuid primary key default gen_random_uuid(),
  work_order_id      uuid not null,
  property_id        uuid not null references properties(id) on delete cascade,

  --  WHAT KIND OF FACT. Each has a different consequence, so each is its
  --  own value rather than a note somebody has to read.
  kind               text not null check (kind in (
                       'en_route',            -- on my way
                       'no_access',           -- could not get in
                       'blocked',             -- something else stops the work
                       'finding',             -- what they observed or did
                       'completion_claimed',  -- says finished; NOT completion
                       'completed'            -- the governed service closed it
                     )),

  --  WHO. The authenticated staff actor, never inferred from the message.
  reported_by_user_id uuid not null references users(id),

  --  WHAT THEY SAID, VERBATIM. Never shown to a resident (see §3); this is
  --  the internal record of the technician's own words.
  note               text,

  --  WHERE IT CAME FROM. The inbound communication event this fact was
  --  reported in, so every field fact traces to a real message.
  source_comm_event_id uuid references comm_events(id),

  --  ONE FACT PER INBOUND MESSAGE. A carrier redelivery cannot produce a
  --  second "on my way" three minutes after the first.
  idempotency_key    text,

  occurred_at        timestamptz not null default now(),

  constraint fk_wop_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete cascade
);

create unique index if not exists uq_work_order_progress_idem
  on work_order_progress (idempotency_key) where idempotency_key is not null;
create index if not exists idx_wop_work on work_order_progress (work_order_id, occurred_at asc);

create table if not exists work_order_proof_attachments (
  id                   uuid primary key default gen_random_uuid(),

  work_order_id        uuid not null,
  property_id          uuid not null references properties(id) on delete cascade,

  --  WHO. The authenticated actor whose device produced this.
  uploaded_by_user_id  uuid not null references users(id),

  --  WHERE IT ARRIVED. The inbound message that carried it, so evidence is
  --  never free-floating.
  source_comm_event_id uuid references comm_events(id),

  --  THE PROVIDER'S OWN IDENTITY for this attachment. Not trusted for
  --  content, kept so a carrier record can be reconciled with ours.
  provider             text,
  provider_media_id    text,
  provider_media_url   text,

  --  WHAT IT IS. Never taken from a filename.
  mime_type            text not null
                         check (mime_type in ('image/jpeg','image/png','image/webp')),

  --  RECEIVED is when it reached us. STORED is when the bytes became ours.
  --  They are different facts and a row can sit between them.
  received_at          timestamptz not null default now(),
  stored_at            timestamptz,

  --  DURABLE-STORAGE STATE. 'referenced' means we know a URL and have not
  --  copied it — evidence we do NOT have.
  storage_state        text not null default 'referenced'
                         check (storage_state in ('referenced','stored','fetch_failed','not_preserved')),

  --  WHAT IT IS OFFERED AS. A photo is evidence; what it is evidence OF is
  --  a separate claim, and the completion service decides whether it
  --  suffices.
  proof_classification text not null default 'unclassified'
                         check (proof_classification in
                           ('unclassified','repair_photo','access_attempt','condition','other')),

  --  THE BYTES. Class 2 adapter, same ruling as 118: Postgres bytea for the
  --  pilot. REPLACEMENT CONDITION — move behind object storage when real
  --  volume makes database storage burdensome; ids, authority contract and
  --  API stay exactly as they are, only where the bytes sit changes.
  byte_size            integer check (byte_size > 0 and byte_size <= 5 * 1024 * 1024),
  sha256               text check (sha256 ~ '^[0-9a-f]{64}$'),
  content              bytea,

  created_at           timestamptz not null default now(),

  constraint fk_wopa_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete cascade,

  --  STORED MEANS STORED. The bytes, their size, their digest and the time
  --  all arrive together or the row is not 'stored'.
  constraint ck_wopa_stored_is_complete check (
    (storage_state = 'stored'
      and content is not null and byte_size is not null
      and sha256 is not null and stored_at is not null)
    or
    (storage_state <> 'stored'
      and content is null and byte_size is null
      and sha256 is null and stored_at is null)
  ),

  --  THE SIZE IS THE BYTES. Same rule as 118: without it, byte_size is
  --  whatever the writer claimed.
  constraint ck_wopa_size_matches_content
    check (content is null or byte_size = octet_length(content))
);

create unique index if not exists uq_wopa_provider_media
  on work_order_proof_attachments (provider, provider_media_id)
  where provider_media_id is not null;
create index if not exists idx_wopa_work on work_order_proof_attachments (work_order_id, received_at asc);
