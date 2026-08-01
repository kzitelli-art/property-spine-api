-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 124 — APPLICATION LIFECYCLE MILESTONES (Slice 9, ruling 2)
--
--  Evidence was reconstructing application history from CURRENT status, which
--  cannot work: `declined` and `withdrawn` sit beside the progressive statuses,
--  so an application approved and later withdrawn loses its approval, and a
--  withdrawn draft reads as submitted. Milestones must be authored when they
--  happen, not inferred afterwards.
--
--  This migration adds the truth. The evidence domain's own LIFECYCLE_ORDER /
--  reached() hierarchy is deleted in the same change — evidence does not own
--  application lifecycle.
--
--  ── WRITE-ONCE, ENFORCED BY THE DATABASE ─────────────────────────────
--  A milestone timestamp records when something happened. Once established it
--  cannot be cleared or moved: a re-run, a correction script or a future
--  service bug must not be able to rewrite when an application was approved.
--  No trigger here INVENTS a timestamp — they only refuse bad changes.
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

-- ── STATUS GROUPS — BOUNDARIES, NOT LABELS ──────────────────────────
--  The first version of this trigger checked the exact strings 'submitted'
--  and 'approved'. That missed the two paths the product actually uses: the
--  submission service INSERTS directly at 'submitted', and the approval
--  service advances straight to 'lease_ready'. A milestone rule that only
--  fires on a label it never sees enforces nothing.
--
--  These are membership tests, so a future status added to a group is covered
--  without a new trigger.
create or replace function ps_app_reached_submission(p_status text) returns boolean as $$
  select p_status in ('submitted','approved','lease_ready','tenant_signed',
                      'countersigned','accepted_term_required','active');
$$ language sql immutable;

create or replace function ps_app_reached_approval(p_status text) returns boolean as $$
  select p_status in ('approved','lease_ready','tenant_signed',
                      'countersigned','accepted_term_required','active');
$$ language sql immutable;

create or replace function ps_app_is_terminal(p_status text) returns boolean as $$
  select p_status in ('declined','withdrawn','expired');
$$ language sql immutable;

-- ── WRITE-ONCE ENFORCEMENT ──────────────────────────────────────────
create or replace function ps_application_milestones_write_once() returns trigger as $$
begin
  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'submitted_at is write-once and cannot be changed or cleared (application %)', old.id;
  end if;
  if old.approved_at is not null and new.approved_at is distinct from old.approved_at then
    raise exception 'approved_at is write-once and cannot be changed or cleared (application %)', old.id;
  end if;
  if old.terminal_at is not null and new.terminal_at is distinct from old.terminal_at then
    raise exception 'terminal_at is write-once and cannot be changed or cleared (application %)', old.id;
  end if;
  if old.terminal_code is not null and new.terminal_code is distinct from old.terminal_code then
    raise exception 'terminal_code is write-once and cannot be changed (application %)', old.id;
  end if;
  -- A terminal application is closed. A later pursuit is a NEW application,
  -- so one row never represents two attempts (ruling A).
  if ps_app_is_terminal(old.status) and not ps_app_is_terminal(new.status) then
    raise exception 'a terminal application (%) cannot reopen into % — a later pursuit is a new application',
      old.status, new.status;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_application_milestones_write_once on lease_applications;
create trigger trg_application_milestones_write_once
  before update on lease_applications
  for each row execute function ps_application_milestones_write_once();

-- ── MILESTONE BOUNDARIES MUST BE AUTHORED, ON INSERT *AND* UPDATE ───
--  The database is the backstop. It does not rely on every current writer
--  behaving, and it covers an application BORN into a lifecycle state.
create or replace function ps_application_authors_milestones() returns trigger as $$
declare
  old_submitted boolean := false;
  old_approved  boolean := false;
  old_terminal  boolean := false;
begin
  if tg_op = 'UPDATE' then
    old_submitted := ps_app_reached_submission(old.status);
    old_approved  := ps_app_reached_approval(old.status);
    old_terminal  := ps_app_is_terminal(old.status);
  end if;

  -- Crossing INTO submission (including birth at submitted).
  if ps_app_reached_submission(new.status) and not old_submitted
     and new.submitted_at is null then
    raise exception 'reaching % requires submitted_at in the same statement (application %)',
      new.status, new.id;
  end if;

  -- Crossing INTO approval (including a direct jump to lease_ready).
  if ps_app_reached_approval(new.status) and not old_approved
     and new.approved_at is null then
    raise exception 'reaching % requires approved_at in the same statement (application %)',
      new.status, new.id;
  end if;

  -- Terminal disposition. Terminal status alone does NOT prove submission or
  -- approval: a draft may be withdrawn without ever being submitted, and its
  -- submitted_at correctly stays null.
  if ps_app_is_terminal(new.status) and not old_terminal then
    if new.terminal_at is null or new.terminal_code is null then
      raise exception 'a terminal disposition requires terminal_at and terminal_code in the same statement (application %)', new.id;
    end if;
    if new.terminal_code <> new.status then
      raise exception 'terminal_code (%) must match the terminal status (%) (application %)',
        new.terminal_code, new.status, new.id;
    end if;
  end if;

  return new;
end $$ language plpgsql;

drop trigger if exists trg_application_transition_authors_milestone on lease_applications;
drop trigger if exists trg_application_authors_milestones on lease_applications;
create trigger trg_application_authors_milestones
  before insert or update on lease_applications
  for each row execute function ps_application_authors_milestones();

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
