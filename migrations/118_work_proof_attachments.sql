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
--  ── NOT APPLIED ANYWHERE ────────────────────────────────────────────
--  The number 118 is PROVISIONAL until the owner-generated baseline shows the
--  live ledger's real ceiling. Nothing has been applied to any database.
--
--  NOTE: migrate.js wraps each file in its own begin/commit.
-- ════════════════════════════════════════════════════════════════════

create table if not exists work_proof_attachments (
  id                   uuid primary key default gen_random_uuid(),

  --  ALL THREE ARE REQUIRED. Property scope, unit scope and work scope are
  --  columns rather than checks performed somewhere else, so a row that is
  --  ambiguous about what it proves cannot be written at all.
  property_id          uuid not null references properties(id) on delete cascade,
  unit_id              uuid not null references units(id) on delete cascade,
  work_id              uuid not null references unit_triage_required_work(id) on delete cascade,

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
  byte_size            integer not null check (byte_size > 0),

  --  EVIDENCE INTEGRITY. A digest of exactly the bytes stored, so a future
  --  reader can tell whether the image they are looking at is the image that
  --  was submitted. Nothing scores or inspects the image itself.
  sha256               text not null check (char_length(sha256) = 64),

  --  THE IMAGE. Class 2 adapter — see the header.
  content              bytea not null,

  --  SERVER TIME. Never client-supplied.
  created_at           timestamptz not null default now()
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
