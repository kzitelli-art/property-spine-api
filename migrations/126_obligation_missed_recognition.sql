-- ════════════════════════════════════════════════════════════════════
--  126 — DURABLE MISSED RECOGNITION (ITEM 1)
--
--  A missed commitment becomes durable history and visible recovery work. It
--  never cosmetically completes or removes the obligation.
--
--  WHAT THIS DELIBERATELY DOES NOT DO. It does NOT widen ck_obl_status to admit
--  'missed'. That was the rejected design: lifecycle status is MUTUALLY
--  EXCLUSIVE, and missedness is ORTHOGONAL to it. An obligation may be open and
--  missed, in progress and missed, escalated because it was missed, or complete
--  having been missed earlier. Collapsing missedness into the lifecycle enum
--  erases all four of those truths and creates another overloaded field.
--
--    lifecycle status        open | in_progress | complete | escalated
--    timeliness / recovery   on_time | due | overdue | missed
--
--  ck_obl_status is untouched. So is every other constraint.
--
--  WHY THREE COLUMNS AND NOT AN EVENTS CHANGE. The immutable obligation_missed
--  event is written to the existing `events` table in the same transaction. A
--  dedupe column plus a partial unique index on that shared table would be a
--  wider change than this slice needs — single-event semantics come from the
--  conditional update below, which only one concurrent transaction can satisfy:
--
--      update obligations set missed_at = now(), ...
--       where id = $1 and missed_at is null and due_at is not null
--         and due_at < now()
--
--  missed_at IS NULL is both the write-once guarantee and the concurrency gate.
--  The DATABASE CLOCK decides the crossing and the recognition time; no
--  caller-supplied timestamp is trusted for either.
--
--  All three columns are NULLABLE and additive. Existing rows are untouched and
--  every existing query keeps working. Idempotent; safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- when the miss was RECOGNISED (database clock) — write-once by service
-- discipline; a later call may never rewrite when the miss happened.
alter table obligations add column if not exists missed_at timestamptz;

-- the CANONICAL threshold that was crossed, copied from obligations.due_at at
-- recognition time. Never the value a request supplied: a caller that could
-- name its own threshold could mark anything missed by passing an earlier one.
-- Stored separately from due_at so a later reschedule cannot rewrite history.
alter table obligations add column if not exists missed_threshold_at timestamptz;

-- THE RECOGNITION IDEMPOTENCY KEY. The key of the request that caused this
-- recognition, so a recognition is traceable to its cause and a replay is
-- identifiable. Its contract, enforced by the service's single conditional
-- update and by ck_oblig_missed_triple below:
--   · written ATOMICALLY with missed_at and missed_threshold_at, in the same
--     UPDATE — never in a second statement that could fail alone;
--   · WRITE-ONCE. The update is guarded by `missed_at is null`, so only the
--     first recognition can set it;
--   · a repeated call — with the SAME key or a DIFFERENT one — returns the
--     existing recognition and PRESERVES THE FIRST KEY. A later caller can
--     never overwrite who or what first recognised the miss.
alter table obligations add column if not exists missed_recognition_key text;

-- A recognition is INCOHERENT without the threshold it recognised, and
-- untraceable without the key of the request that caused it. All THREE columns
-- move together or not at all — the database refuses a half-written recognition
-- even if some future writer bypasses the service.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_oblig_missed_triple') then
    alter table obligations add constraint ck_oblig_missed_triple
      check (
        (missed_at is null) = (missed_threshold_at is null)
        and (missed_at is null) = (missed_recognition_key is null)
      );
  end if;
end $$;

-- A recognition can only recognise a threshold that had already passed when it
-- was recorded. Enforced in the service by the database clock; enforced here so
-- no future writer can create a recognition that precedes its own threshold.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_oblig_missed_after_threshold') then
    alter table obligations add constraint ck_oblig_missed_after_threshold
      check (missed_at is null or missed_at >= missed_threshold_at);
  end if;
end $$;

-- ── NO INDEX IN THIS MIGRATION. DELIBERATE. ─────────────────────────
--  A recovery-queue index on (property_id, missed_at) was drafted and REMOVED:
--  no query in this slice uses that shape. Every read the primitive and its
--  harness perform is `where id = $1`. An index for a capability this slice
--  explicitly excludes — the sweeper and the recovery/timeliness projections —
--  would be speculative schema, added for a query that does not exist yet.
--
--  It belongs with the build that introduces the recovery-queue read, judged
--  against that query's real shape rather than a guess at it.
