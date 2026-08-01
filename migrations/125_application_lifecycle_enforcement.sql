-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 125 — APPLICATION LIFECYCLE ENFORCEMENT (Slice 9)
--
--  ⚠️  DEPLOYMENT B ONLY. DO NOT APPLY UNTIL EVERY PRODUCTION INSTANCE IS
--      RUNNING THE CANONICAL LIFECYCLE WRITER FROM DEPLOYMENT A.
--
--  124 expanded the schema compatibly. This file makes the database refuse
--  what the writers must no longer do. Applied too early it would reject
--  real prospect applications from an old instance still serving traffic —
--  which is precisely why it is a separate migration and not a later section
--  of 124.
--
--  Nothing here INVENTS a timestamp. Every rule is a refusal.
--
--  ── WHY GROUPS, NOT LABELS ───────────────────────────────────────────
--  The submission service INSERTs directly at 'submitted'; the approval
--  service advances straight to 'lease_ready'. A rule matching the exact
--  strings 'submitted' and 'approved' fires on neither. Boundaries are
--  membership tests, so a status added to a group is covered without a new
--  trigger.
--
--  ── TERMINAL IS IMMUTABLE, PERMANENTLY ───────────────────────────────
--  Not merely "terminal cannot become non-terminal". Once terminal, status
--  cannot change AT ALL — declined → withdrawn and withdrawn → expired are
--  refused too. A later pursuit is a NEW application record. Unrelated
--  fields may still be corrected while status stays put.
--
--  IDEMPOTENT throughout; migrate.js owns the transaction.
-- ════════════════════════════════════════════════════════════════════

-- ── STATUS GROUPS — BOUNDARIES, NOT LABELS ──────────────────────────
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

-- ── STANDING CORRESPONDENCE, NOT A CROSSING-TIME CHECK ──────────────
--  Enforced as a table constraint so a HISTORICAL row cannot later acquire
--  status='declined' with terminal_code='withdrawn' without changing status.
--  A crossing-time trigger alone would miss that.
alter table lease_applications drop constraint if exists ck_la_terminal_correspondence;
alter table lease_applications add constraint ck_la_terminal_correspondence
  check (
    terminal_code is null
    or (ps_app_is_terminal(status) and terminal_code = status)
  );

-- ── WRITE-ONCE MILESTONES + TERMINAL IMMUTABILITY ───────────────────
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

  -- TERMINAL IS FINAL. Not just "cannot become non-terminal" — cannot change
  -- at all. declined → withdrawn and withdrawn → expired are refused. A later
  -- pursuit is a new application record, so one row never carries two
  -- dispositions. Unrelated columns may still be corrected in place.
  if ps_app_is_terminal(old.status) and new.status is distinct from old.status then
    raise exception 'a terminal application (%) cannot change status to % — the disposition is immutable and a later pursuit is a new application',
      old.status, new.status;
  end if;

  return new;
end $$ language plpgsql;

drop trigger if exists trg_application_milestones_write_once on lease_applications;
create trigger trg_application_milestones_write_once
  before update on lease_applications
  for each row execute function ps_application_milestones_write_once();

-- ── MILESTONE BOUNDARIES MUST BE AUTHORED, ON INSERT *AND* UPDATE ───
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

  -- Crossing INTO submission, including birth at submitted.
  if ps_app_reached_submission(new.status) and not old_submitted
     and new.submitted_at is null then
    raise exception 'reaching % requires submitted_at in the same statement (application %)',
      new.status, new.id;
  end if;

  -- Crossing INTO approval, including a direct jump to lease_ready.
  if ps_app_reached_approval(new.status) and not old_approved
     and new.approved_at is null then
    raise exception 'reaching % requires approved_at in the same statement (application %)',
      new.status, new.id;
  end if;

  -- Terminal status alone does NOT prove submission or approval: a draft may
  -- be withdrawn without ever being submitted, and submitted_at correctly
  -- stays null.
  if ps_app_is_terminal(new.status) and not old_terminal then
    if new.terminal_at is null or new.terminal_code is null then
      raise exception 'a terminal disposition requires terminal_at and terminal_code in the same statement (application %)', new.id;
    end if;
  end if;

  -- Terminal metadata may not be attached to a non-terminal row.
  if new.terminal_code is not null and not ps_app_is_terminal(new.status) then
    raise exception 'terminal metadata cannot be attached to non-terminal status % (application %)',
      new.status, new.id;
  end if;

  return new;
end $$ language plpgsql;

drop trigger if exists trg_application_transition_authors_milestone on lease_applications;
drop trigger if exists trg_application_authors_milestones on lease_applications;
create trigger trg_application_authors_milestones
  before insert or update on lease_applications
  for each row execute function ps_application_authors_milestones();
