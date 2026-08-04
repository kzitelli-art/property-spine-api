-- ════════════════════════════════════════════════════════════════════
--  131_work_acceptance.sql — ACCEPTANCE IS A DURABLE FACT, NOT A STATUS.
--
--  The obligation model has carried `status = 'in_progress'` since the
--  baseline and NOTHING has ever transitioned into it. "Someone has taken
--  this on" was therefore a state the schema could describe and the product
--  could not record. A technician accepting work is the first real writer
--  of it.
--
--  ── WHAT THIS MAKES UNEXPRESSABLE ───────────────────────────────────
--
--  1. Accepted, but nobody owns it.
--     accepted_by_user_id and accepted_at move together or neither moves,
--     and an accepted obligation always carries assigned_user_id equal to
--     the accepter. "Accepted by Dana, assigned to Sam" is not a row that
--     can exist. Ownership IS the acceptance.
--
--  2. Accepted, and still waiting for someone.
--     An accepted obligation is never `open`. The status and the ownership
--     fact cannot disagree, so a board cannot show unclaimed work that
--     somebody is already doing.
--
--  3. The same message accepting the same work twice.
--     acceptance_key is the provider's own message id, unique across the
--     table. A carrier redelivery loses at the DATABASE, not at whichever
--     application layer happened to remember. Replay safety that depends on
--     a boundary having deduped first is replay safety that ends the moment
--     a second caller appears.
--
--  ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────
--
--  No backfill, because there is nothing to backfill: no row has ever been
--  accepted. Every column is nullable and every constraint is vacuously
--  true for existing rows, so this migration cannot change the meaning of
--  any obligation already in the table.
--
--  It does NOT touch ck_cl_outbound_disabled_slice_a. Operations lines
--  still cannot send. Recording an acceptance and TELLING the technician
--  about it are two different facts, and only the first is built here.
-- ════════════════════════════════════════════════════════════════════

begin;

alter table obligations add column if not exists accepted_by_user_id uuid references users(id);
alter table obligations add column if not exists accepted_at         timestamptz;
alter table obligations add column if not exists acceptance_key      text;

--  1. Both or neither. An acceptance with no time, or a time with no
--     accepter, is a half-recorded fact pretending to be a whole one.
alter table obligations drop constraint if exists ck_oblig_acceptance_paired;
alter table obligations add constraint ck_oblig_acceptance_paired
  check ((accepted_by_user_id is null) = (accepted_at is null));

--  2. The accepter IS the owner. Not "and also assigned to" — the same
--     person, in the same row, or the row is refused.
alter table obligations drop constraint if exists ck_oblig_accepter_is_owner;
alter table obligations add constraint ck_oblig_accepter_is_owner
  check (accepted_by_user_id is null or assigned_user_id = accepted_by_user_id);

--  3. Accepted work is never open work.
alter table obligations drop constraint if exists ck_oblig_accepted_not_open;
alter table obligations add constraint ck_oblig_accepted_not_open
  check (accepted_at is null or status <> 'open');

--  4. A key without an acceptance is a claim about a write that did not
--     happen. It cannot be stored.
alter table obligations drop constraint if exists ck_oblig_acceptance_key_requires_acceptance;
alter table obligations add constraint ck_oblig_acceptance_key_requires_acceptance
  check (acceptance_key is null or accepted_at is not null);

--  5. ONE acceptance per inbound message, enforced by the database.
--     Partial: unaccepted obligations all carry null and do not collide.
create unique index if not exists uq_obligations_acceptance_key
  on obligations (acceptance_key) where acceptance_key is not null;

--  Read path for "what have I accepted" — owner first, because that is the
--  question the technician surface asks.
create index if not exists idx_obligations_accepted_by
  on obligations (accepted_by_user_id, status) where accepted_by_user_id is not null;

commit;
