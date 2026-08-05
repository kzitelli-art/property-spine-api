-- ════════════════════════════════════════════════════════════════════
--  132_outbound_line_policy.sql — OUTBOUND IS A POLICY, NOT A BOOLEAN.
--
--  Owner ruling (2026-08-04): the operations line may send outbound in
--  Phase 2 under a strict reply_only policy. NOT by flipping
--  outbound_enabled, which would silently authorize proactive messaging
--  everywhere the line is consumed.
--
--      disabled     sends nothing
--      reply_only   may answer an inbound message on the same line
--      proactive    may originate
--
--  ── THIS IS 130's DOCUMENTED REMOVAL, NOT AN EXEMPTION ──────────────
--
--  ck_cl_outbound_disabled_slice_a was written with its own removal
--  condition: "Removed when the technician loop introduces governed
--  outbound, at which point each outbound message is tied to
--  authenticated staff authority and canonical work state." That is the
--  condition being met here. The ban is REPLACED by a stricter structure,
--  never weakened by an application-only exception.
--
--  ── WHAT BECOMES UNEXPRESSABLE ──────────────────────────────────────
--
--  1. A PROACTIVE OPERATIONS LINE. ck_cl_outbound_policy_by_type permits
--     operations lines only 'disabled' or 'reply_only'. There is no
--     column value for "the operations number may originate messages", so
--     assignment pushes, reminder campaigns and staff broadcasts are not
--     features that were left unbuilt — they are rows that cannot exist.
--
--  2. A LINE WHOSE FLAG AND POLICY DISAGREE. outbound_enabled is now
--     coherent with the policy by constraint, so no caller reading the
--     old boolean can be told something the policy contradicts.
--
--  3. AN UNBOUND REPLY. Every outbound event naming a reply_only line
--     must carry all five bindings the ruling requires — the inbound
--     message it answers, the staff recipient, the thread, a governed
--     reason from a frozen vocabulary, and a durable correlation key.
--     Enforced by trigger, because a CHECK cannot read another table.
--
--  4. RESIDENT MESSAGING FROM THE OPERATIONS NUMBER. An operations-line
--     outbound may not carry person_id. The operations line coordinates
--     the technician; it does not impersonate the resident thread.
--
--  ── WHAT IT DOES NOT CHANGE ─────────────────────────────────────────
--
--  Property-facing lines keep governed resident communication under their
--  existing policy. They are backfilled to 'proactive' because that is
--  what they already are — setup links and agent replies originate today
--  — and recording them as unable to send would be a false blank. The
--  consent and eligibility gates (canSendSmsForRecord) are untouched and
--  remain the resident-side authority.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ── 0. LIFT 130's BAN FIRST ─────────────────────────────────────────
--  ORDERING DEFECT, caught by tests/communication_lines_slice_a.db.js:
--  this drop was originally BELOW the backfill. On an empty table that
--  passes, because the backfill updates nothing. On any database that has
--  actually run 130 — which is every real one, since 130 backfills a line
--  per property holding a number — the backfill sets outbound_enabled=true
--  while the blanket ban is still in force and the migration dies.
--
--  The ban must be gone before anything is enabled. Its replacement is
--  installed immediately below, inside the same transaction, so there is no
--  committed state in which outbound is ungoverned.
alter table communication_lines drop constraint if exists ck_cl_outbound_disabled_slice_a;

-- ── 1. THE POLICY COLUMN ────────────────────────────────────────────
alter table communication_lines
  add column if not exists outbound_policy text not null default 'disabled';

alter table communication_lines drop constraint if exists ck_cl_outbound_policy_vocab;
alter table communication_lines add constraint ck_cl_outbound_policy_vocab
  check (outbound_policy in ('disabled','reply_only','proactive'));

--  Backfill from what each line ALREADY is, before any constraint could
--  refuse an existing row.
update communication_lines set outbound_policy = 'proactive'
 where line_type = 'property_facing' and outbound_policy = 'disabled';
update communication_lines set outbound_policy = 'reply_only'
 where line_type = 'operations' and outbound_policy = 'disabled';
update communication_lines set outbound_enabled = (outbound_policy <> 'disabled');

-- ── 2. WHAT REPLACES IT — STRICTER, NOT LOOSER ──────────────────────
--  An operations line may never be proactive. Not "is not yet" — cannot be.
alter table communication_lines drop constraint if exists ck_cl_outbound_policy_by_type;
alter table communication_lines add constraint ck_cl_outbound_policy_by_type
  check (line_type <> 'operations' or outbound_policy in ('disabled','reply_only'));

--  The legacy boolean is now a projection of the policy, and cannot drift.
alter table communication_lines drop constraint if exists ck_cl_outbound_flag_matches_policy;
alter table communication_lines add constraint ck_cl_outbound_flag_matches_policy
  check (outbound_enabled = (outbound_policy <> 'disabled'));

-- ── 3. THE STAFF COORDINATION THREAD ────────────────────────────────
--  `conversations` is the PROPERTY's record of communication with a
--  tenant: property_id and person_id are both NOT NULL, and three later
--  migrations depend on that. A staff coordination thread has neither a
--  property (the operations line establishes an organization, never a
--  building) nor a person (staff are users).
--
--  Making those columns nullable to accommodate it would weaken the
--  resident model to describe something that is not a resident
--  conversation. Intra-organization coordination and a tenant's
--  communication record are different objects with different participants,
--  different scope and different retention. They get different tables.
create table if not exists staff_threads (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  channel_primary text not null default 'sms',
  status          text not null default 'open',
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index if not exists idx_staff_threads_org on staff_threads(organization_id);

-- ── 4. THE FIVE BINDINGS OF A VALID REPLY ───────────────────────────
alter table comm_events add column if not exists communication_line_id     uuid references communication_lines(id);
alter table comm_events add column if not exists to_user_id                uuid references users(id) on delete set null;
alter table comm_events add column if not exists in_reply_to_comm_event_id uuid references comm_events(id);
alter table comm_events add column if not exists reply_reason              text;
alter table comm_events add column if not exists correlation_key           text;
alter table comm_events add column if not exists staff_thread_id           uuid references staff_threads(id) on delete set null;

--  A comm_event belongs to a resident conversation OR a staff thread.
--  Never both — an event on both threads is an event whose audience is
--  undecided, and that is exactly how a technician message ends up in a
--  resident's record.
alter table comm_events drop constraint if exists ck_comm_one_thread;
alter table comm_events add constraint ck_comm_one_thread
  check (conversation_id is null or staff_thread_id is null);

--  The allowed reasons, frozen. Everything the ruling permits and nothing
--  else: clarification, a safe read, an honest refusal, a canonical
--  execution receipt, and a transport-failure notice.
alter table comm_events drop constraint if exists ck_comm_reply_reason_vocab;
alter table comm_events add constraint ck_comm_reply_reason_vocab
  check (reply_reason is null or reply_reason in
    ('clarification','governed_read','authorization_refusal','execution_receipt','delivery_failure_notice'));

--  One outbound per correlation key. A redelivered inbound produces the
--  same key and therefore cannot produce a second reply.
create unique index if not exists uq_comm_events_correlation_key
  on comm_events (correlation_key) where correlation_key is not null;

create index if not exists idx_comm_events_reply_to
  on comm_events (in_reply_to_comm_event_id) where in_reply_to_comm_event_id is not null;

-- ── 5. THE GUARD ────────────────────────────────────────────────────
--  A CHECK cannot read communication_lines, so the policy is enforced
--  here. It fires only for events that NAME a line, so every existing
--  resident event is untouched and this migration cannot change the
--  meaning of a single row already in the table.
create or replace function guard_line_outbound_policy() returns trigger as $$
declare
  ln communication_lines%rowtype;
begin
  if new.communication_line_id is null then
    return new;
  end if;

  select * into ln from communication_lines where id = new.communication_line_id;
  if not found then
    raise exception 'comm_event names communication_line % which does not exist', new.communication_line_id;
  end if;

  if new.direction <> 'outbound' then
    return new;                       -- inbound may always name its line
  end if;

  if ln.outbound_policy = 'disabled' then
    raise exception 'outbound refused: line % has outbound_policy=disabled', ln.id
      using errcode = '23514';
  end if;

  if ln.outbound_policy = 'reply_only' then
    if new.in_reply_to_comm_event_id is null then
      raise exception 'outbound refused: line % is reply_only and this message answers nothing', ln.id
        using errcode = '23514';
    end if;
    if new.to_user_id is null then
      raise exception 'outbound refused: a reply_only message must name the staff recipient it answers'
        using errcode = '23514';
    end if;
    --  A thread, of the kind this line's audience actually has. An
    --  operations line has staff threads; a property-facing line has
    --  resident conversations. Accepting either here would let a
    --  technician reply land in a tenant's record.
    if ln.line_type = 'operations' and new.staff_thread_id is null then
      raise exception 'outbound refused: an operations reply must belong to the existing staff thread'
        using errcode = '23514';
    end if;
    if ln.line_type <> 'operations' and new.conversation_id is null then
      raise exception 'outbound refused: a reply_only message must belong to the existing thread'
        using errcode = '23514';
    end if;
    if new.reply_reason is null then
      raise exception 'outbound refused: a reply_only message must state a governed reason'
        using errcode = '23514';
    end if;
    if new.correlation_key is null then
      raise exception 'outbound refused: a reply_only message must carry a durable correlation key'
        using errcode = '23514';
    end if;
  end if;

  --  The operations line coordinates the technician. It never speaks to a
  --  resident, and it never speaks about one by attaching to their record.
  if ln.line_type = 'operations' and new.person_id is not null then
    raise exception 'outbound refused: an operations line may not address a resident (person_id set)'
      using errcode = '23514';
  end if;

  return new;
end $$ language plpgsql;

drop trigger if exists trg_guard_line_outbound_policy on comm_events;
create trigger trg_guard_line_outbound_policy
  before insert or update on comm_events
  for each row execute function guard_line_outbound_policy();

commit;
