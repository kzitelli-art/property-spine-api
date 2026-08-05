-- ════════════════════════════════════════════════════════════════════
--  134_technician_lifecycle.sql — WHAT HAPPENED IN THE FIELD.
--
--  A technician's day is a sequence of plain facts: I'm heading over. I
--  couldn't get in. The leak is stopped but it needs a valve. Here's a
--  photo. All done. Each is a different fact with a different consequence,
--  and collapsing any two of them is where the lie lives.
--
--  ── I INSPECTED THE EXISTING EVIDENCE RAIL FIRST ────────────────────
--
--  `work_proof_attachments` (118) exists and is good. It is NOT reused
--  here, and the reason is structural rather than stylistic:
--
--    · its central guarantee is the COMPOSITE key
--      (work_id, property_id, unit_id) → unit_triage_required_work. That
--      is a different parent object — the unit-turn rail, not the
--      maintenance work-order rail;
--    · unit_id is NOT NULL there. A maintenance work order legitimately
--      has no unit (a boiler, a roof, a parking gate);
--    · making it polymorphic over two parents would require dropping that
--      composite key, which is the one thing making "borrow one photo to
--      close three other jobs" unrepresentable.
--
--  So this is a SIBLING on the same contract, not a second philosophy:
--  same Class 1 contract / Class 2 storage split, same digest rule, same
--  size-matches-bytes rule, same scope-is-one-fact composite key.
--
--  It carries five things 118 has no need for, because 118 receives a
--  browser upload and this receives a carrier's MMS: the source
--  communication event, the provider's own attachment identity, the
--  received time as distinct from the stored time, the durable-storage
--  state, and the proof classification.
--
--  ── A PROVIDER URL IS NOT PROOF ─────────────────────────────────────
--  `storage_state` starts at 'referenced' — we know a URL exists and have
--  not copied it. Only 'stored' means the bytes are ours, and only
--  'stored' rows carry content and a digest. A row can therefore say "the
--  technician sent a photo and we have not preserved it" out loud, which
--  is the honest state, instead of pointing at a carrier URL that expires.
-- ════════════════════════════════════════════════════════════════════

begin;

--  work_orders needs a uniquely-constrained (id, property_id) so the
--  composite keys below can reference it as ONE fact. `id` is already the
--  primary key, so this adds no new restriction.
create unique index if not exists uq_work_orders_id_property
  on work_orders (id, property_id);

-- ── 1. THE FIELD RECORD ─────────────────────────────────────────────
--  Append-only. A technician's report is never edited and never deleted:
--  "said en route at 9:02, reported no access at 9:31" is the record, and
--  overwriting the first would make the second unexplainable.
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

-- ── 2. THE EVIDENCE PRIMITIVE ───────────────────────────────────────
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

-- ── 3. RESIDENT UPDATES DERIVED FROM CANONICAL FACTS ────────────────
--  A technician action may CAUSE a resident update. It may never BE one.
--  The resident message is derived from the committed field fact and is
--  attached to the resident conversation on the property-facing line —
--  never to the staff thread, and never in the technician's own words.
alter table comm_events
  add column if not exists derived_from_progress_id uuid references work_order_progress(id);

--  A message derived from a field fact is a RESIDENT message: it belongs to
--  a resident conversation, and never to a staff thread. This is what makes
--  "the operations line forwarded what the technician typed" unrepresentable
--  rather than merely against policy.
alter table comm_events drop constraint if exists ck_comm_derived_is_resident_facing;
alter table comm_events add constraint ck_comm_derived_is_resident_facing
  check (derived_from_progress_id is null
         or (staff_thread_id is null and person_id is not null));

commit;
