-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 096 — TOUR OUTCOME PROMPTS (the ask, recorded)
--
--  NUMBERING: 095 is deliberately left free. migrations/094_staff_roles.sql
--  is misnumbered — 094 was already taken by 094_property_channel_capabilities
--  and the runner keys the ledger on the 3-digit prefix alone
--  (`const version = file.slice(0,3)`), so staff_roles is silently SKIPPED
--  and its tables do not exist in live. It needs renaming to 095. This file
--  takes 096 so that rename cannot collide a second time.
--
--  Additive. ONE new table. Nothing existing is altered. Nothing is seeded.
--
--  WHY: post-tour capture is the moment of work. The agent's fresh judgment
--  after a tour is the fact this instrument exists to record — and it decays
--  in minutes. On a busy leasing day (eight tours back to back, one agent,
--  the next prospect already in the lobby) the capture will not happen
--  unless the system ASKS, and asks well.
--
--  Everything else about a capture is already derivable from existing rows:
--    when the tour ended     tour_availability.ends_at   (via leasing_tours.slot_id)
--    when the outcome landed tour_events.event_at
--    latency                 the difference between them
--    who recorded it         leasing_conversions.feedback_recorded_by_user_id
--    what they judged        leasing_conversions.tour_outcome + reactions
--
--  THE ASK IS THE ONLY THING NOT RECORDED ANYWHERE. That gap matters for a
--  reason that is not merely tidiness:
--
--    YOU CANNOT HOLD SOMEONE ACCOUNTABLE FOR IGNORING A PROMPT YOU HAVE NO
--    RECORD OF SENDING.
--
--  Escalation and any later scoring both read this table. Without it, both
--  would be reconstructions — which is the exact inversion of the North
--  Star ("reporting becomes a read, not a reconstruction"). So the ask is
--  recorded at the moment it is made, like every other real-world fact.
--
--  ONE ROW PER ASK, NOT ONE PER TOUR. A second prompt is a second real
--  event, not an update to the first. Attempt 1 at 10:45 and attempt 2 at
--  11:15 are two things that happened, and "we asked twice" is exactly the
--  fact accountability needs. Append-only in spirit: rows are never edited
--  except to stamp the answer onto the ask that produced it.
--
--  WHAT THIS TABLE DOES NOT DO — deliberately:
--    · It does NOT hold the outcome. The judgment lives where it already
--      lives (leasing_conversions + tour_events). This records the ASKING,
--      not the answer. Two different facts, two different homes — the same
--      separation the rest of the system keeps between classification and
--      consent, presence and stage, relationship owner and obligation owner.
--    · It does NOT make the AI able to answer for the agent. The AI was not
--      at the tour and has no standing to judge what the agent saw. A prompt
--      with no reply stays unanswered and reads as NOT CAPTURED — an honest
--      blank, never a default.
--    · It grants no authority and sends nothing. Creating this table cannot
--      cause a single message to leave.
--
--  SAFETY CONTRACT — there is no staging; merging this EXECUTES it:
--    · CREATE TABLE IF NOT EXISTS only. No ALTER of anything existing.
--    · No INSERT, no backfill, no seed. Born empty.
--    · Nothing reads it yet, so OLD CODE against NEW SCHEMA is trivially
--      safe and a code-only rollback leaves an unread empty table.
--    · tour_id CASCADEs with the tour (an ask about a deleted tour is not a
--      fact about anything). user/comm_event FKs are SET NULL: losing the
--      actor must never erase the fact that the ask happened.
--
--  KNOWN CONSUMERS THAT MUST STAY GREEN: none as of 096.
-- ════════════════════════════════════════════════════════════════════

create table if not exists tour_outcome_prompts (
  id                 uuid primary key default gen_random_uuid(),

  tour_id            uuid not null references leasing_tours(id) on delete cascade,

  -- WHO we asked. Nullable with a required explanation below: a tour with no
  -- host has nobody to ask, and that is itself a finding worth recording
  -- rather than a reason to skip the row. An unassigned tour is unscoreable,
  -- honestly.
  asked_user_id      uuid references users(id) on delete set null,

  asked_at           timestamptz not null default now(),

  -- how the ask was delivered. 'sms' is the busy-day path (the agent's phone
  -- is already in their hand); 'app' is the desk/sweep path.
  channel            text not null,

  -- 1, 2, 3… Each ask is its own row; this names which one it was.
  attempt_no         integer not null default 1,

  -- the actual outbound message, when the ask went by SMS. Provenance:
  -- "we say we asked" should be checkable against the comm spine.
  prompt_comm_event_id uuid references comm_events(id) on delete set null,

  -- ── the answer, stamped onto the ask that produced it ──
  responded_at         timestamptz,
  -- the inbound reply, when the answer came back by SMS
  response_comm_event_id uuid references comm_events(id) on delete set null,
  -- how the answer arrived: 'sms_reply' | 'app' | 'sweep'
  response_source      text,

  -- why we stopped asking without an answer: 'superseded' (a later attempt
  -- replaced it), 'tour_settled' (captured elsewhere), 'abandoned'.
  closed_without_response_reason text,

  -- when there is no one to ask, or the ask was made outside the normal
  -- path, this must say why. Honest blank needs a stated reason.
  note               text,

  created_at         timestamptz not null default now(),

  constraint top_channel_known
    check (channel in ('sms','app')),
  constraint top_response_source_known
    check (response_source is null or response_source in ('sms_reply','app','sweep')),
  constraint top_attempt_positive
    check (attempt_no >= 1),

  -- an answered ask has a source; an unanswered one has neither
  constraint top_response_coherent
    check ((responded_at is null and response_source is null)
        or (responded_at is not null and response_source is not null)),

  -- an ask that was answered was not also abandoned
  constraint top_not_both_answered_and_closed
    check (responded_at is null or closed_without_response_reason is null),

  -- if we could not name who we asked, say why
  constraint top_actor_or_note
    check (asked_user_id is not null or note is not null)
);

-- the hot read: "is there an open ask for this tour, and how many have we made?"
create index if not exists top_tour_open
  on tour_outcome_prompts (tour_id, asked_at desc);

-- escalation sweep: unanswered asks, oldest first
create index if not exists top_unanswered
  on tour_outcome_prompts (asked_at)
  where responded_at is null and closed_without_response_reason is null;

-- accountability read: what was asked of this person, and did they answer?
create index if not exists top_by_user
  on tour_outcome_prompts (asked_user_id, asked_at desc);

-- at most ONE open ask per tour per attempt number — a retry must increment,
-- not duplicate, so "we asked twice" cannot be manufactured by a double-write.
create unique index if not exists top_one_per_attempt
  on tour_outcome_prompts (tour_id, attempt_no);

comment on table tour_outcome_prompts is
  'Every request for a tour outcome, recorded at the moment it is made. One row per ask, never per tour. The ANSWER lives in leasing_conversions/tour_events — this records only the ASKING, because accountability for an ignored prompt requires proof the prompt was sent.';
