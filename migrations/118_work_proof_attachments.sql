-- ════════════════════════════════════════════════════════════════════
--  118 — WORK PROOF ATTACHMENTS  (unit-turn closure slice)
--
--  ONE PHOTO, TIED TO ONE WORK ITEM, UPLOADED BY ONE PERSON.
--
--  This is NOT an attachment platform, a document store, or a media library.
--  It holds the completion photo for a single required-work item and nothing
--  else. Every column exists because the completion flow needs it; there is no
--  caption, no tag, no category, no folder and no mutable status, because
--  none of those is needed to prove a technician finished a job.
--
--  ── WHY THE BYTES LIVE HERE ─────────────────────────────────────────
--  Postgres `bytea`, deliberately, for the pilot. It is durable, attributable,
--  property-scoped, transactionally consistent with the completion claim, and
--  it runs inside the isolated baseline database with no second deployment
--  dependency, no vendor, and no new credential.
--
--  CLASSIFICATION:
--    the attachment CONTRACT  → Class 1, permanent product primitive
--    `content bytea` storage  → Class 2, temporary storage adapter
--
--  REPLACEMENT CONDITION for the adapter: move the bytes behind object storage
--  only when real proof volume or multi-property operation makes database
--  storage materially burdensome. The attachment ids, the authority contract
--  and the completion API stay exactly as they are when that happens — only
--  where the bytes sit changes. Solving storage scale before one unit turn has
--  ever completed would be solving the wrong problem.
--
--  ── THE COLUMNS ARE THE AUTHORITY ───────────────────────────────────
--  property_id + unit_id + work_id are NOT NULL and all three are foreign
--  keys. An attachment therefore cannot exist without naming exactly which
--  work item it proves, which is what makes "borrow one photo to close three
--  other jobs" unrepresentable rather than merely refused.
--
--  ── AND THE SCOPE IS ONE FACT, NOT THREE ────────────────────────────
--  Three SEPARATE foreign keys prove three objects exist. They do NOT prove
--  they belong together: work W at property A, unit U at property B and
--  property A all exist independently, so `(W, B, U)` satisfied every single
--  key while describing a unit-turn photo that belongs to nothing.
--
--  The COMPOSITE key `(work_id, property_id, unit_id)` → required work
--  `(id, property_id, unit_id)` closes that. A cross-property or cross-unit
--  attachment is now rejected by Postgres itself, including through raw SQL
--  that never touches the service. It replaces the single-column work_id key,
--  which it strictly contains; property_id and unit_id keep their own keys
--  because they point at different tables.
--
--  The composite needs a UNIQUE index on the parent's three columns. `id` is
--  already the primary key, so the index adds no new restriction — it exists
--  because a foreign key must reference a uniquely-constrained column list.
--
--  ── NOT APPLIED ANYWHERE ────────────────────────────────────────────
--  The number 118 is PROVISIONAL until the owner-generated baseline shows the
--  live ledger's real ceiling. Nothing has been applied to any database.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

--  The parent's uniquely-constrained column list, so the composite key below
--  has something to reference. `id` alone is already unique; this states the
--  triple so `(work_id, property_id, unit_id)` can be enforced as ONE fact.
create unique index if not exists uq_utrw_id_property_unit
  on unit_triage_required_work (id, property_id, unit_id);

create table if not exists work_proof_attachments (
  id                   uuid primary key default gen_random_uuid(),

  --  ALL THREE ARE REQUIRED. Property scope, unit scope and work scope are
  --  columns rather than checks performed somewhere else, so a row that is
  --  ambiguous about what it proves cannot be written at all.
  property_id          uuid not null references properties(id) on delete cascade,
  unit_id              uuid not null references units(id) on delete cascade,
  --  No single-column key on work_id: the composite below contains it and
  --  additionally proves the work belongs to THIS property and THIS unit.
  work_id              uuid not null,

  --  WHO. Not the person who claimed the completion — the person whose device
  --  produced this image. They are usually the same human and they are not
  --  the same fact, so they are stored separately. `claimed_by_user_id` lives
  --  on the completion claim.
  uploaded_by_user_id  uuid not null references users(id),

  --  WHAT ARRIVED. `original_filename` is kept for a human reading history
  --  later; it is NEVER trusted to establish the type.
  original_filename    text,
  mime_type            text not null
                         check (mime_type in ('image/jpeg','image/png','image/webp')),

  --  A SIZE, NOT A CLAIM ABOUT A SIZE. Bounded above by the same 5 MB the
  --  service and multer enforce, so the three cannot drift apart, and tied to
  --  the bytes themselves further down.
  byte_size            integer not null
                         check (byte_size > 0)
                         check (byte_size <= 5 * 1024 * 1024),

  --  EVIDENCE INTEGRITY. A digest of exactly the bytes stored, so a future
  --  reader can tell whether the image they are looking at is the image that
  --  was submitted. Nothing scores or inspects the image itself.
  --
  --  LOWERCASE HEX, EXACTLY 64. `char_length = 64` accepted 64 spaces. A digest
  --  that is not a digest is worse than a null one: it reads as verified.
  sha256               text not null check (sha256 ~ '^[0-9a-f]{64}$'),

  --  THE IMAGE. Class 2 adapter — see the header.
  content              bytea not null,

  --  SERVER TIME. Never client-supplied.
  created_at           timestamptz not null default now(),

  --  ── THE SCOPE IS ONE FACT ─────────────────────────────────────────
  --  This work item, at this property, in this unit. Not three separate
  --  existence proofs that happen to sit in the same row.
  constraint fk_wpa_work_scope
    foreign key (work_id, property_id, unit_id)
    references unit_triage_required_work (id, property_id, unit_id)
    on delete cascade,

  --  ── THE SIZE IS THE BYTES ─────────────────────────────────────────
  --  Cross-column, so it cannot be a column constraint. Without it `byte_size`
  --  is whatever the writer said it was, and `Content-Length` on the governed
  --  read is served from it — a wrong value there is a truncated or hung
  --  response, from a row that looked perfectly valid.
  constraint ck_wpa_size_matches_content
    check (byte_size = octet_length(content))
);

--  The completion path resolves references for one work item at a time.
create index if not exists idx_wpa_work on work_proof_attachments(work_id, created_at asc);
--  The governed read verifies attachment → work → property agreement.
create index if not exists idx_wpa_property on work_proof_attachments(property_id);

-- ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────
--
--  No `description`, `caption`, `tag`, `category` or `document_type` — this
--  row is not a document, it is a completion photo.
--
--  No `status`, `archived_at`, `superseded_by` or `deleted_at`. There is no
--  delete route and no edit route. A photo submitted as proof of work is
--  evidence; making it mutable would make the proof mutable.
--
--  No `storage_url`, `bucket`, `region` or `provider`. When the Class 2 adapter
--  is replaced those belong in whatever replaces it, not here.
--
--  No `property_id` accepted from a client anywhere in the write path — the
--  service derives it from the session and the work row, and the NOT NULL
--  constraint here is the last line of that same rule.
