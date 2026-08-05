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
--  ── SCOPED TO WHAT IT GOVERNS, AND NO WIDER ─────────────────────────
--  The first cut of this index was unique on `derived_from_progress_id`
--  outright. That does more than the ruling asks: it would stop ANY
--  future comm_event of ANY type from ever referencing the same field
--  fact — a follow-up call record, an email, an escalation notice, a
--  different classification entirely. A field fact is allowed to be
--  referenced many times. What is not allowed is being TOLD TWICE.
--
--  So the predicate names the exact message this governs:
--
--    direction      = 'outbound'            we are telling, not receiving
--    channel        = 'sms'                 a text; a call or an email
--                                           derived from the same fact is
--                                           a different message, not a
--                                           second copy of this one
--    classification = 'work_order_update'   the type both writers produce
--    person_id     is not null              addressed to a resident
--
--  AUDIENCE IS ALREADY CLOSED ELSEWHERE. 134's
--  ck_comm_derived_is_resident_facing requires any row carrying
--  `derived_from_progress_id` to have `staff_thread_id is null and
--  person_id is not null`, so a staff-facing row referencing this cause
--  is unrepresentable regardless of this index. `person_id is not null`
--  is repeated here anyway so the index states its own audience rather
--  than depending on a constraint two files away.
--
--  THE KNOWN LIMIT, stated rather than discovered later: a writer that
--  used a different `classification` or `channel` would not be caught.
--  That is the deliberate cost of scoping. If a second resident-facing
--  work-order message type is ever added, it needs its own answer to
--  "has this fact already been communicated" — not a widening of this
--  index, which would start blocking legitimate references.
--
--  ── SAFE ON A LIVE DATABASE ─────────────────────────────────────────
--  The column arrives in 134 and cannot hold a value in any database that
--  has not run 134, so there is nothing to conflict with here.
--
--  The DROP is not defensive noise: an earlier draft of this file created
--  the same index name with a wider predicate, and `if not exists` would
--  silently keep it. Dropping first makes re-running this file converge on
--  what the file actually says.
-- ════════════════════════════════════════════════════════════════════

begin;

drop index if exists uq_comm_events_resident_update_cause;

create unique index uq_comm_events_resident_update_cause
  on comm_events (derived_from_progress_id)
  where derived_from_progress_id is not null
    and direction = 'outbound'
    and channel = 'sms'
    and classification = 'work_order_update'
    and person_id is not null;

commit;
