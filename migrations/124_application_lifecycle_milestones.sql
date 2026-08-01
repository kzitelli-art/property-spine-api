-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 124 — APPLICATION LIFECYCLE MILESTONES (Slice 9, ruling 2)
--
--  Evidence was reconstructing application history from CURRENT status, which
--  cannot work: `declined` and `withdrawn` sit beside the progressive statuses,
--  so an application approved and later withdrawn loses its approval, and a
--  withdrawn draft reads as submitted. Milestones must be authored when they
--  happen, not inferred afterwards.
--
--  ── EXPANSION ONLY — ENFORCEMENT LIVES IN 125 ────────────────────────
--  This migration is deliberately COMPATIBLE with the production writers that
--  exist today. It adds columns, comments, indexes and a conditional
--  historical backfill, and nothing that can refuse a write.
--
--  Why the split: a rolling deployment runs the migration while the PREVIOUS
--  application instance is still serving traffic. That instance inserts
--  applications at 'submitted' with no submitted_at. If enforcement shipped
--  here, real prospect applications would fail for the length of the rollout.
--  Merging the migration and the writers in one commit does not remove that
--  window — only sequencing does.
--
--      Deployment A : 124 expansion + canonical lifecycle writer + cutover
--      Deployment B : 125 enforcement, once every instance runs A
--
--  No trigger in this file invents a timestamp for compatibility. Absence
--  stays absent.
--
--  ── TERMINAL VOCABULARY (ruling A, 2026-08-01) ───────────────────────
--      declined | withdrawn | expired
--  `expired` is an application-level terminal disposition, outcome_class
--  closed_without_target. An expired application is NOT reopened in place;
--  later pursuit is a NEW application record, so one row never represents two
--  attempts. Deliberately distinct from an expired INVITATION (a replaceable
--  link) and an expired OFFER/PACKET (may be superseded) — neither is an
--  application terminal event.
--
--  `accepted_term_required` is NOT terminal. It is blocked/waiting work.
--
--  ── BACKFILL: CONDITIONAL, NEVER GLOBAL (ruling 1) ───────────────────
--  approved_at ← decided_at ONLY where the current row proves approval was
--  reached. submitted_at is NOT backfilled at all: no proven direct-submit
--  path has been established by the writer audit yet, and created_at is not
--  the submission instant. Unproven rows stay null and are honestly
--  untrackable for a submission-origin cohort.
--
--  IDEMPOTENT throughout; migrate.js owns the transaction.
-- ════════════════════════════════════════════════════════════════════

alter table lease_applications add column if not exists submitted_at timestamptz;
alter table lease_applications add column if not exists approved_at  timestamptz;
alter table lease_applications add column if not exists terminal_at  timestamptz;
alter table lease_applications add column if not exists terminal_code text;

comment on column lease_applications.submitted_at is
  'Canonical submission milestone, authored in the transaction that crosses into submitted. '
  'NULL = untrackable for a submission-origin cohort. Never inferred from created_at (Slice 9 ruling 1).';
comment on column lease_applications.approved_at is
  'Canonical approval milestone. Once set it survives later withdrawal or expiry — '
  'the application DID reach approval (Slice 9 ruling 3).';
comment on column lease_applications.terminal_code is
  'declined | withdrawn | expired. accepted_term_required is NOT terminal.';

alter table lease_applications drop constraint if exists ck_la_terminal_code;
alter table lease_applications add constraint ck_la_terminal_code
  check (terminal_code is null or terminal_code in ('declined','withdrawn','expired'));

-- A terminal disposition carries BOTH its code and its instant, or neither.
-- A code with no time cannot be placed in a window; a time with no code
-- cannot be classified.
alter table lease_applications drop constraint if exists ck_la_terminal_pair;
alter table lease_applications add constraint ck_la_terminal_pair
  check ((terminal_at is null and terminal_code is null)
      or (terminal_at is not null and terminal_code is not null));

-- ── CONDITIONAL BACKFILL ────────────────────────────────────────────
--  1. approved_at ← decided_at, ONLY where the current row proves approval was
--     reached. Never for declined/withdrawn/draft/submitted, and never merely
--     because an expired application COULD once have been approved — that
--     needs independent semantic evidence this schema does not hold.
update lease_applications
   set approved_at = decided_at
 where approved_at is null
   and decided_at is not null
   and status in ('approved','lease_ready','tenant_signed','countersigned','active');

--  2. Terminal time for currently-declined rows. decided_at supports a DECLINE
--     terminal instant — never an approval one.
update lease_applications
   set terminal_at = decided_at, terminal_code = 'declined'
 where terminal_at is null and terminal_code is null
   and decided_at is not null
   and status = 'declined';

--  3. Terminal time for currently-expired rows (ruling A).
update lease_applications
   set terminal_at = decided_at, terminal_code = 'expired'
 where terminal_at is null and terminal_code is null
   and decided_at is not null
   and status = 'expired';

--  NOT BACKFILLED, deliberately:
--   · submitted_at — no proven direct-submit path established by the writer
--     audit, and created_at is not the submission instant. Rows stay null and
--     report as untrackable rather than as a fabricated submission date.
--   · withdrawn terminal time — no ruling establishes decided_at as the
--     withdrawal instant, so it is left null rather than assumed.
--   · approved_at for withdrawn/expired rows — the original approval time is
--     not recoverable from current status.

create index if not exists idx_la_submitted_at on lease_applications (property_id, submitted_at)
  where submitted_at is not null;
create index if not exists idx_la_approved_at  on lease_applications (property_id, approved_at)
  where approved_at is not null;
create index if not exists idx_la_terminal_at  on lease_applications (property_id, terminal_at)
  where terminal_at is not null;
create index if not exists idx_la_leasing_lead on lease_applications (leasing_lead_id)
  where leasing_lead_id is not null;
