-- ════════════════════════════════════════════════════════════════════
--  177_activation_source_supersession.sql
--
--  WHY IS *THIS* TRACKER VERSION THE OPERATING SOURCE?
--
--  That question has to have an answer a person can read. Today it does
--  not, and the reason is structural rather than careless.
--
--  ── WHAT 040 ASSUMED, AND WHY IT NO LONGER HOLDS ────────────────────
--  `activations` was designed for OPENING TRUTH: one activation per
--  property, status open → activated, done. Under that assumption there
--  is never a second source to choose between, so no "which one is
--  current" concept was needed and none exists.
--
--  A leasing tracker breaks that assumption on purpose. Mike's workbook
--  is refreshed continuously; v2 arrives next week and v3 after it. Each
--  arrival is a NEW source artifact producing NEW claims, and the earlier
--  one must remain intact — a claim history that gets rewritten by the
--  next upload is not evidence.
--
--  ── WHAT THIS MIGRATION REFUSES TO DO ───────────────────────────────
--  It does NOT make `max(created_at)` the authority. "Newest row wins" is
--  an implicit rule that nobody stated, cannot be explained to an
--  operator, and silently promotes a mistaken re-upload over a reviewed
--  one. This repo already has the right primitive for "this replaced
--  that": SUPERSESSION, used by executed_lease_records, capital stack
--  positions, and the leasing cycles added in 176.
--
--  So: the operating source is the activation that is `activated` and
--  NOT superseded. Exactly one, by construction, per property and source
--  kind. When a v2 is accepted it supersedes v1 IN THE SAME STATEMENT
--  that activates it, so there is no window where two are current and no
--  window where none is.
--
--  The answer to "why this version?" becomes a sentence:
--      "It is the accepted source; it superseded the 08-14 upload."
--  and the superseded row still says what it was and when it stopped
--  being authoritative.
--
--  ── SOURCE KIND ─────────────────────────────────────────────────────
--  A property's rent-roll activation and its leasing-tracker activation
--  are both activations and must not supersede each other. `source_kind`
--  separates the lanes. Existing rows are left NULL rather than
--  backfilled to a guess: an unlabelled historical activation is an
--  honest unknown, and 'rent_roll' would be an assumption about rows this
--  migration has not read.
-- ════════════════════════════════════════════════════════════════════

alter table activations
  add column if not exists source_kind             text,
  add column if not exists supersedes_activation_id uuid references activations(id),
  add column if not exists superseded_by_id        uuid references activations(id),
  add column if not exists superseded_at           timestamptz,
  add column if not exists accepted_by_user_id     uuid references users(id) on delete set null,
  add column if not exists accepted_at             timestamptz;

--  AT MOST ONE CURRENT SOURCE per property per kind. This is the
--  constraint that makes the resolver's answer unique rather than
--  conventional — without it, "the accepted, unsuperseded one" is a hope.
create unique index if not exists uq_activation_current_source
  on activations (property_id, source_kind)
  where status = 'activated' and superseded_by_id is null and source_kind is not null;

create index if not exists idx_activation_superseded
  on activations (superseded_by_id) where superseded_by_id is not null;

comment on column activations.source_kind is
  'Which lane this source occupies (e.g. leasing_tracker, rent_roll). Sources '
  'in different lanes never supersede each other. NULL on rows predating 177 — '
  'an honest unknown, not backfilled to a guess.';
comment on column activations.superseded_by_id is
  'The activation that replaced this one as the operating source. The current '
  'source is `status=activated and superseded_by_id is null` — never '
  'max(created_at), which is an authority rule nobody stated.';
