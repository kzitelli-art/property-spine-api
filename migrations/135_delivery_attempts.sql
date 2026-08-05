-- ════════════════════════════════════════════════════════════════════
--  135_delivery_attempts.sql — EVERY ATTEMPT IS KEPT.
--
--  A retry is a NEW attempt at the SAME operating cause. It is not a new
--  work order, not a new completion event, and not a new message: the
--  outbound intent already exists and already says what it says.
--
--  So the intent stays put and each attempt at putting it on the wire
--  becomes its own append-only row. "Failed at 9:05, failed at 9:31,
--  delivered at 10:02" is the record; overwriting sms_status would leave
--  only the last one and make the first two unexplainable.
--
--  comm_events.sms_status remains the CURRENT projection — one read, no
--  join, nothing downstream changes — and is now derived from the latest
--  attempt rather than being the only thing that exists.
-- ════════════════════════════════════════════════════════════════════

begin;

create table if not exists comm_delivery_attempts (
  id                uuid primary key default gen_random_uuid(),
  comm_event_id    uuid not null references comm_events(id) on delete cascade,
  attempt_no       integer not null check (attempt_no > 0),

  --  WHO asked for this attempt. The first is the system; a retry names
  --  the operator who pressed it, so a resend is attributable.
  requested_by_user_id uuid references users(id),

  outcome          text not null check (outcome in ('sent','failed','refused')),
  provider         text,
  provider_ref     text,
  failure_reason   text,

  --  ONE attempt per idempotency key. A double-click and a replayed
  --  request cannot become two simultaneous sends.
  idempotency_key  text,

  attempted_at     timestamptz not null default now(),

  unique (comm_event_id, attempt_no)
);

create unique index if not exists uq_cda_idem
  on comm_delivery_attempts (idempotency_key) where idempotency_key is not null;
create index if not exists idx_cda_event on comm_delivery_attempts (comm_event_id, attempt_no);

--  A failed attempt must say why. An unexplained failure is a blank
--  pretending to be a fact.
alter table comm_delivery_attempts drop constraint if exists ck_cda_failure_has_reason;
alter table comm_delivery_attempts add constraint ck_cda_failure_has_reason
  check (outcome = 'sent' or failure_reason is not null);

commit;
