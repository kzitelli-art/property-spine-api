-- ════════════════════════════════════════════════════════════════════
--  153 — THE RETAINED SOURCE ARTIFACT
--
--  Spine can always show the exact source that established a position.
--
--  Until now it could not. `deal_intake_files` says it plainly in its own
--  comment — "Binary bytes are NOT stored in v1" — and `import_batches`
--  records `source_file text`, a FILENAME. A filename is a claim about a
--  file, not the file. When someone asks "show me what this came from",
--  a string cannot answer.
--
--  ── WHAT THIS IS NOT ────────────────────────────────────────────────
--  Not a document platform. No OCR, no extraction, no classification, no
--  folders, no versioning, no search. It stores bytes and the facts that
--  make those bytes citable: what they are, how big, their digest, who
--  put them there, when, and what they are about.
--
--  ── THE ADAPTER, AND THE RULING IT INHERITS ─────────────────────────
--  `content bytea` in Postgres. This is the SAME Class 2 adapter ruling
--  as migrations 118 and 134 (work_order_proof_attachments), deliberately
--  reused rather than invented: one binary-storage pattern in this repo,
--  not two.
--
--  REPLACEMENT CONDITION — move behind object storage when real volume
--  makes database storage burdensome. The id, the authority contract and
--  the API stay exactly as they are; only where the bytes sit changes.
--  Nothing outside this table and its service may read `content`.
--
--  ── WHY SCOPE IS (type, id) AND NOT property_id ─────────────────────
--  A rent roll belongs to a property. A loan document belongs to a deal.
--  An operating agreement will belong to a legal entity. The RENT-ROLL
--  tables stay property-scoped on purpose (import_batches, ingest_runs) —
--  that is the right shape for what they hold. The ARTIFACT is the one
--  place where the future is genuinely plural, so it is the one place
--  that carries a scope pair.
--
--  'legal_entity' is deliberately ABSENT from the CHECK. Reserving a
--  vocabulary word for work that has not been designed is how a schema
--  pretends to support something it has never once written. Add it in the
--  migration that first needs it.
--
--  A polymorphic scope cannot have a foreign key, so it gets a trigger
--  that does the same job: the referenced row must exist. Referential
--  integrity is not optional merely because the reference is by pair.
--
--  CLASSIFICATION: Class 1 contract, Class 2 storage adapter.
-- ════════════════════════════════════════════════════════════════════

create table if not exists source_artifacts (
  id                  uuid primary key default gen_random_uuid(),

  --  WHAT THIS ARTIFACT IS ABOUT.
  scope_type          text not null check (scope_type in ('deal','property')),
  scope_id            uuid not null,

  --  WHAT IT IS. `original_filename` is what the human called it and is
  --  shown back to them; it is never used to decide anything.
  original_filename   text not null,
  mime_type           text,
  artifact_kind       text not null default 'rent_roll'
                        check (artifact_kind in ('rent_roll','other')),

  --  THE BYTES.
  byte_size           integer check (byte_size > 0 and byte_size <= 25 * 1024 * 1024),
  sha256              text check (sha256 ~ '^[0-9a-f]{64}$'),
  content             bytea,
  stored_at           timestamptz,

  --  WHEN THE CONTENT IS TRUE AS OF. Distinct from uploaded_at: a rent
  --  roll uploaded today can be an April 30 position, and the position it
  --  establishes is dated by the document, never by the upload.
  source_as_of_date   date,

  --  WHO. Server-derived, always. There is no body-supplied uploader.
  uploaded_by_user_id uuid not null references users(id),
  uploaded_by_basis   text not null,
  uploaded_at         timestamptz not null default now(),

  --  STORED MEANS STORED — the bytes, their size, their digest and the
  --  time arrive together or the row is not stored. Same shape as 134.
  constraint ck_sa_stored_is_complete check (
    (content is not null and byte_size is not null
      and sha256 is not null and stored_at is not null)
    or
    (content is null and byte_size is null
      and sha256 is null and stored_at is null)
  ),

  --  THE SIZE IS THE BYTES, not what the writer claimed it was.
  constraint ck_sa_size_matches_content
    check (content is null or byte_size = octet_length(content))
);

create index if not exists ix_source_artifacts_scope
  on source_artifacts (scope_type, scope_id, uploaded_at desc);

--  THE SAME FILE, UPLOADED TWICE, INTO THE SAME SCOPE, IS ONE ARTIFACT.
--  Not an error — a re-upload is a normal human act. The service returns
--  the existing id rather than storing a second copy of identical bytes,
--  which is also what keeps a retry from silently doubling the evidence.
create unique index if not exists uq_source_artifacts_scope_digest
  on source_artifacts (scope_type, scope_id, sha256)
  where sha256 is not null;

-- ── SCOPE INTEGRITY: the FK a polymorphic reference cannot have ──────
create or replace function public.source_artifact_scope_exists()
returns trigger as $$
declare ok boolean;
begin
  if new.scope_type = 'deal' then
    select exists(select 1 from deal_intakes where id = new.scope_id) into ok;
  elsif new.scope_type = 'property' then
    select exists(select 1 from properties where id = new.scope_id) into ok;
  else
    raise exception 'unknown artifact scope_type %', new.scope_type
      using errcode = 'check_violation';
  end if;
  if not ok then
    raise exception 'no % exists with id % — an artifact cannot be about nothing',
      new.scope_type, new.scope_id
      using errcode   = 'foreign_key_violation',
            detail    = 'source_artifacts.scope_id is polymorphic and cannot carry a '
                     || 'foreign key, so this trigger enforces the same rule.',
            hint      = 'Create the deal or property first, then upload against it.';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.source_artifact_scope_exists() set search_path = public, pg_temp;

drop trigger if exists trg_source_artifact_scope on source_artifacts;
create trigger trg_source_artifact_scope
  before insert or update of scope_type, scope_id on source_artifacts
  for each row execute function public.source_artifact_scope_exists();

-- ── RETENTION MEANS RETENTION ────────────────────────────────────────
--  An artifact is cited by an import batch, which is cited by an opening
--  position. Rewriting the bytes under a position that has already been
--  established would silently give a past statement a different source.
--  Adding a NEW artifact and re-establishing is always available; editing
--  the old one is not.
create or replace function public.source_artifacts_are_immutable()
returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a retained source artifact may not be deleted'
      using errcode = 'restrict_violation',
            detail  = 'Positions cite this file as their basis.';
  end if;
  if new.content is distinct from old.content
     or new.sha256 is distinct from old.sha256
     or new.byte_size is distinct from old.byte_size
     or new.scope_type is distinct from old.scope_type
     or new.scope_id is distinct from old.scope_id then
    raise exception 'a retained source artifact may not be rewritten'
      using errcode = 'restrict_violation',
            detail  = 'The bytes, their digest and what they are about are the '
                   || 'artifact. Changing them would re-base every fact that cites it.',
            hint    = 'Upload the corrected file as a new artifact and establish again.';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.source_artifacts_are_immutable() set search_path = public, pg_temp;

drop trigger if exists trg_source_artifacts_immutable on source_artifacts;
create trigger trg_source_artifacts_immutable
  before update or delete on source_artifacts
  for each row execute function public.source_artifacts_are_immutable();
