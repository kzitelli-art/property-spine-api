-- ════════════════════════════════════════════════════════════════════
--  136_one_resident_update_per_cause.sql — ONE FACT, ONE RESIDENT MESSAGE.
--
--  A resident update is derived from a committed canonical fact. One fact
--  is therefore one message, and a second message about the same fact is
--  not a second fact — it is the same thing said twice.
--
--  This was not theoretical. A technician reporting no access caused the
--  derived update "The technician could not access the unit. Please reply
--  with the best way to coordinate entry." The operator surface then
--  offered a Coordinate entry control that sent BYTE-IDENTICAL text, and
--  its duplicate guard could not see the first message because that guard
--  was keyed on correlation_key and the derived update carries none.
--
--  Two writers, one cause, no shared key. The resident got the same
--  sentence twice.
--
--  ── WHY A DATABASE CONSTRAINT AND NOT A CHECK IN THE SERVICE ────────
--  Because the two writers are in different files, reached by different
--  actors, through different transports, and a third writer added later
--  would have to remember. `derived_from_progress_id` is the canonical
--  cause both of them ALREADY record. Making it unique is what makes
--  "tell the resident the same thing twice" unrepresentable rather than
--  merely discouraged.
--
--  A RETRY is unaffected: it creates no comm_event. It is a new attempt at
--  the existing intent (135), which is exactly the distinction this index
--  relies on.
--
--  ── SAFE ON A LIVE DATABASE ─────────────────────────────────────────
--  The column arrives in 134 and cannot hold a value in any database that
--  has not run 134, so there is nothing to conflict with here.
-- ════════════════════════════════════════════════════════════════════

begin;

create unique index if not exists uq_comm_events_resident_update_cause
  on comm_events (derived_from_progress_id)
  where derived_from_progress_id is not null;

commit;
