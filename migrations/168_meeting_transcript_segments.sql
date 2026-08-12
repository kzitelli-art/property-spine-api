-- ════════════════════════════════════════════════════════════════════
--  168 — MEETING TRANSCRIPT SEGMENTS
--
--  A meeting becomes citable evidence: the file itself, retained, plus
--  the ordered turns inside it, each addressable on its own.
--
--  ── WHY THE ARTIFACT ALONE IS NOT ENOUGH ────────────────────────────
--  153 already stores the exact bytes of a source and can hand them back.
--  That is what a rent roll needs, because a rent roll establishes ONE
--  position and the file sits behind it.
--
--  A meeting does not work that way. One meeting touches a unit dispute,
--  a leasing concession, an elevator, a vendor lesson and an occupancy
--  claim — five different objects, in five different domains. What has to
--  be citable is not "the meeting", it is the eleven seconds where
--  somebody said the thing. So the turns get identity of their own, and
--  the artifact remains their parent.
--
--  ── WHAT THIS IS NOT ────────────────────────────────────────────────
--  Not a meeting product. No scheduling, no attendees, no minutes, no
--  action items, no summarisation, no recording. Spine does not record
--  meetings; it ingests a transcript from an approved source.
--
--  Nothing here promotes anything to truth. A segment is a record of
--  what was SAID, at strictly lower authority than any governed read,
--  and it can never become an obligation, a concession or a work order
--  by sitting in this table. That promotion is a separate, later,
--  human-confirmed act with its own authority rules.
--
--  ── SEQUENCE IS THE IDENTITY. THE TIMESTAMP IS NOT. ─────────────────
--  Measured on the real specimen (Weekly Solo, 96 turns, 17:16): FIVE
--  timestamp collisions in one meeting — 1:00, 6:41, 12:26, 15:09 and
--  16:14 each carry two different speakers. A citation keyed on the
--  timestamp would be ambiguous five times in seventeen minutes.
--
--  So `sequence` is the addressable identity, unique per artifact, and
--  `relative_timestamp` is a display fact stored exactly as written.
--
--  ── SPEAKERS ARE LABELS, NOT PEOPLE ─────────────────────────────────
--  `raw_speaker_label` is what the transcription tool wrote. There is
--  deliberately NO person_id and NO confirmed flag on this table.
--
--  PHILOSOPHY §12: a name is evidence of identity and may never silently
--  create a durable person, merge two humans, or grant authority. A
--  transcript label reading "Robert" is not proof that Spine's Robert
--  said it — it is the same evidence level as "Unidentified Speaker",
--  differing in content, not in standing.
--
--  When speaker confirmation is built it goes in its own table, one row
--  per (artifact, label), carrying who confirmed it and when, so that a
--  confirmation never rewrites a segment and a correction has somewhere
--  to live (§6). If confirmation were a column here, confirming one
--  person would mean UPDATE-ing hundreds of immutable rows.
--
--  This is the lesson of migration 092 applied before the mistake rather
--  than after it: there, the Person Card emitted the whole provenance
--  contract — claim_strength included — and SYNTHESISED all of it at read
--  time, hardcoded to 'proven'. "The contract exists at the read layer
--  and is unbacked at the storage layer." Evidence level is storage.
--
--  ── VERBATIM IS A CONSTRAINT, NOT A PREFERENCE ──────────────────────
--  The specimen says "$29.97" where the room meant $2,997, "route" where
--  they said grout, and spells one colleague two ways in one meeting.
--  Nothing in the ingest path repairs any of it, because the record is
--  lossy in places Spine cannot locate, which makes a correct repair
--  indistinguishable from a corruption. Later authority may state a
--  corrected value as its own dated fact beside the segment; the segment
--  reads $29.97 forever.
--
--  ── SAFETY CONTRACT — merging this EXECUTES it ──────────────────────
--    · one NEW table, referenced by nothing that exists
--    · the artifact_kind CHECK is WIDENED — a widening cannot fail a row
--    · one NEW CHECK on source_artifacts that constrains ONLY the new
--      kind, and no row has that kind yet, so it cannot fail
--    · no existing column, index or constraint is altered or dropped
--  OLD CODE against NEW SCHEMA is therefore safe, which is the
--  rolling-restart window and the state after any code-only rollback.
--
--  CLASS 1 — permanent.
-- ════════════════════════════════════════════════════════════════════


-- ── 1. THE ARTIFACT KIND ────────────────────────────────────────────
--  Same widening pattern as 161/163/164/165/166. The list is restated in
--  full because a CHECK cannot be appended to.
alter table source_artifacts drop constraint if exists source_artifacts_artifact_kind_check;
alter table source_artifacts add constraint source_artifacts_artifact_kind_check
  check (artifact_kind in ('rent_roll','other',
                           'insurance_policy','insurance_binder',
                           'insurance_invoice','insurance_allocation_schedule',
                           'insurance_finance_agreement','insurance_escrow_statement',
                           'entity_formation_document','operating_agreement',
                           'tax_bill','tax_balance_statement','tax_return',
                           'tax_payment_receipt','tax_clearance_certificate',
                           'tax_account_statement','tax_appeal_document',
                           'tax_escrow_statement','tax_escrow_analysis',
                           'meeting_transcript'));


-- ── 2. A TRANSCRIPT MUST CARRY THE DATE OF THE MEETING ──────────────
--  There is NO DATE ANYWHERE INSIDE a transcript — the timestamps are
--  relative to the start of the recording. So the meeting date cannot be
--  parsed out and has to be supplied by whoever uploads it.
--
--  153 already separates `source_as_of_date` ("when the content is true
--  as of") from `uploaded_at`, because a rent roll uploaded today can be
--  an April 30 position. The same distinction, enforced here rather than
--  merely available: without it, evidence age silently becomes upload
--  age, and in six months every meeting appears to have happened on the
--  day somebody got round to uploading it.
--
--  Scoped to this kind ON PURPOSE. Every other artifact kind keeps
--  today's behaviour exactly, including a null date.
alter table source_artifacts drop constraint if exists ck_sa_transcript_needs_meeting_date;
alter table source_artifacts add constraint ck_sa_transcript_needs_meeting_date
  check (artifact_kind <> 'meeting_transcript' or source_as_of_date is not null);


-- ── 3. THE SEGMENTS ─────────────────────────────────────────────────
create table if not exists meeting_transcript_segments (
  id                  uuid primary key default gen_random_uuid(),

  --  RESTRICT, not CASCADE. The retained source and the turns inside it
  --  are one record; removing the parent out from under a citation that
  --  points at a child is not something a foreign key should do quietly.
  --  Retention is org policy, and a deliberate removal path would be its
  --  own governed act with its own authority.
  artifact_id         uuid not null references source_artifacts(id) on delete restrict,

  --  THE IDENTITY. 1-based, contiguous, assigned by position in the file,
  --  so re-parsing the same bytes yields the same references and a stored
  --  citation stays stable.
  sequence            integer not null check (sequence >= 1),

  --  Exactly as written in the file ("5:07"). This is what a citation
  --  shows a human.
  relative_timestamp  text not null check (length(btrim(relative_timestamp)) > 0),

  --  Derived from the above for ordering-independent display. Relative to
  --  the start of the recording — it is NOT a wall-clock time and must
  --  never be added to the meeting date to manufacture one.
  relative_seconds    integer not null check (relative_seconds >= 0),

  --  What the transcription tool wrote. Never normalised, never mapped.
  --  'Unidentified Speaker' is a legitimate, permanent value.
  raw_speaker_label   text not null check (length(btrim(raw_speaker_label)) > 0),

  --  What was said, exactly. Never corrected.
  verbatim_text       text not null check (length(btrim(verbatim_text)) > 0),

  created_at          timestamptz not null default now(),

  --  One segment per position per artifact. This is also what makes a
  --  double-submitted ingest fail loudly instead of doubling the record.
  constraint uq_mts_artifact_sequence unique (artifact_id, sequence)
);

create index if not exists mts_artifact_sequence_idx
  on meeting_transcript_segments(artifact_id, sequence);

--  Retrieval reads a meeting in time order.
create index if not exists mts_artifact_seconds_idx
  on meeting_transcript_segments(artifact_id, relative_seconds, sequence);


-- ── 4. IMMUTABLE, ENFORCED BY THE DATABASE ──────────────────────────
--  Same mechanism as lcoe_append_only (069), deliberately reused rather
--  than invented: one append-only pattern in this repo, not two.
--
--  A segment is a record of what a person said at a moment. There is no
--  legitimate UPDATE of it — a corrected value is a NEW dated fact by
--  somebody with the standing to state it, related to this segment, never
--  written over it. Making that structurally impossible is what stops the
--  $29.97 in this table from quietly becoming $2,997 later.
create or replace function mts_reject_mutation() returns trigger as $$
begin
  raise exception 'meeting_transcript_segments is immutable: % is not permitted', TG_OP
    using errcode = 'raise_exception';
end;
$$ language plpgsql;

drop trigger if exists mts_immutable on meeting_transcript_segments;
create trigger mts_immutable
  before update or delete on meeting_transcript_segments
  for each row execute function mts_reject_mutation();
