-- ════════════════════════════════════════════════════════════════════
--  104_person_record_retirement.sql
--
--  Two additive primitives, both created because a real duplicate happened:
--  re-running a staff-creation script produced a second identical staff
--  person, and there was no honest way to retire the loser.
--
--  ── 1. RETIREMENT, BECAUSE DELETION WOULD ERASE THE AUDIT ────────────
--  persons has no lifecycle mechanism for a staff record: lifecycle_status
--  carries only counterparty journey values (tenant / applicant / lead) and
--  has no constraint. The duplicate cannot be deleted — user_person_bridge_audit
--  references it with NO ACTION, and that audit is append-only history showing
--  the link and relink actually happened.
--
--  Renaming the row to "VOID …" was the crude first attempt and it destroyed
--  what the record WAS. Retirement is recorded in dedicated columns instead,
--  exactly as the deactivated assignment keeps its person_id, role and
--  created_at while provenance carries the correction. A record should still
--  say what it was; a separate field says what happened to it.
--
--  ── 2. A SECOND ACTIVE STAFF PERSON IS NOW IMPOSSIBLE ────────────────
--  An application-level pre-check cannot stop two concurrent requests: both
--  read "no staff person exists", both insert. The partial unique index makes
--  the second insert fail at the database, whatever the caller does — retries,
--  double-clicks, races, or a crash between person creation and bridge
--  completion.
--
--  Scoped to source='staff_bridge' and record_status='active' so it constrains
--  ONLY governed staff records: residents and prospects may legitimately share
--  an email, and retired rows must not block the survivor.
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive; defaults preserve
--  every existing row as 'active'.
-- ════════════════════════════════════════════════════════════════════

alter table persons add column if not exists record_status text not null default 'active';
alter table persons add column if not exists retired_at timestamptz;
alter table persons add column if not exists retired_reason text;
alter table persons add column if not exists retired_by_user_id uuid references users(id);

-- The auditable resolution reference: which record survives.
alter table persons add column if not exists superseded_by_person_id uuid references persons(id);

alter table persons drop constraint if exists ck_persons_record_status;
alter table persons add constraint ck_persons_record_status
  check (record_status in ('active','retired'));

-- A retirement must say when and why. A row that is merely flagged retired,
-- with no reason and no timestamp, is worse than one left active: it looks
-- resolved without recording the resolution.
alter table persons drop constraint if exists ck_persons_retirement_is_explained;
alter table persons add constraint ck_persons_retirement_is_explained
  check (record_status <> 'retired' or (retired_at is not null and retired_reason is not null));

-- A record cannot supersede itself, and an active record supersedes nothing.
alter table persons drop constraint if exists ck_persons_not_self_superseding;
alter table persons add constraint ck_persons_not_self_superseding
  check (superseded_by_person_id is null or superseded_by_person_id <> id);

comment on column persons.record_status is
  'active | retired. Retirement NEVER deletes and never merges: relationships, leases, conversations and audit history stay attached to the row that earned them. A retired row cannot receive authority.';
comment on column persons.superseded_by_person_id is
  'The surviving canonical record, when this one was retired as a duplicate. An auditable pointer, NOT a merge — nothing is moved.';

create index if not exists ix_persons_record_status on persons (record_status)
  where record_status <> 'active';

-- ── the idempotency invariant ────────────────────────────────────────
-- At most ONE active governed staff person per email address.
create unique index if not exists uq_active_staff_person_email
  on persons (lower(email))
  where record_status = 'active' and source = 'staff_bridge' and email is not null;
