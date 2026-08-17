-- ════════════════════════════════════════════════════════════════════
--  176 — MEETING RECEIPT v0
--
--  Immutable transcript segments -> versioned interpretation -> hostile
--  validation -> deterministic owner projection -> immutable receipt ->
--  append-only human review.
--
--  This namespace records Meeting Evidence and Meeting Receipt facts only.
--  It writes zero canonical operating truth: no work orders, obligations,
--  leases, concessions, occupancy, person attributes, money, accounting,
--  reporting facts, vendor facts, or staff assignments.
-- ════════════════════════════════════════════════════════════════════

create table if not exists meeting_evidence_meetings (
  meeting_id             uuid primary key default gen_random_uuid(),
  provider_meeting_id    uuid not null references meeting_provider_meetings(id) on delete restrict,
  property_id            uuid not null references properties(id) on delete restrict,
  meeting_occurred_at    timestamptz not null,
  occurred_at_source     text not null check (occurred_at_source in
                           ('provider_scheduled','provider_recorded','manual_entry')),
  bound_by_user_id       uuid not null references users(id) on delete restrict,
  bound_at               timestamptz not null default now(),
  created_at             timestamptz not null default now(),

  unique (provider_meeting_id, property_id)
);

create index if not exists idx_meeting_evidence_meetings_property
  on meeting_evidence_meetings (property_id, meeting_occurred_at desc);

create table if not exists transcript_versions (
  transcript_version_id  uuid primary key default gen_random_uuid(),
  meeting_id             uuid not null references meeting_evidence_meetings(meeting_id) on delete restrict,
  source_digest          text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  source_kind            text not null check (length(btrim(source_kind)) > 0),
  created_at             timestamptz not null default now(),
  supersedes_version_id  uuid references transcript_versions(transcript_version_id) on delete restrict,
  lineage_map            jsonb,

  unique (meeting_id, source_digest),
  constraint ck_transcript_version_not_self_superseding
    check (supersedes_version_id is null or supersedes_version_id <> transcript_version_id)
);

create index if not exists idx_transcript_versions_meeting
  on transcript_versions (meeting_id, created_at desc);

create table if not exists transcript_segments (
  segment_id             uuid primary key default gen_random_uuid(),
  transcript_version_id  uuid not null references transcript_versions(transcript_version_id) on delete restrict,
  ordinal                integer not null check (ordinal > 0),
  provider_timestamp     text,
  speaker_label          text not null check (length(btrim(speaker_label)) > 0),
  text                   text not null check (length(text) > 0),
  normalized_text        text not null,
  created_at             timestamptz not null default now(),

  unique (transcript_version_id, ordinal)
);

create index if not exists idx_transcript_segments_version_ordinal
  on transcript_segments (transcript_version_id, ordinal);

create table if not exists meeting_speaker_resolutions (
  resolution_id               uuid primary key default gen_random_uuid(),
  transcript_version_id       uuid not null references transcript_versions(transcript_version_id) on delete restrict,
  speaker_label               text not null check (length(btrim(speaker_label)) > 0),
  resolved_person_id          uuid references persons(id) on delete restrict,
  resolution_status           text not null check (resolution_status in
                                ('confirmed','probable','unresolved')),
  resolution_basis            text not null check (length(btrim(resolution_basis)) > 0),
  resolved_by_user_id         uuid references users(id) on delete restrict,
  created_at                  timestamptz not null default now(),
  supersedes_resolution_id    uuid references meeting_speaker_resolutions(resolution_id) on delete restrict,

  constraint ck_speaker_resolution_status_shape check (
    (resolution_status in ('confirmed','probable') and resolved_person_id is not null)
    or
    (resolution_status = 'unresolved' and resolved_person_id is null)
  ),
  constraint ck_speaker_resolution_not_self_superseding
    check (supersedes_resolution_id is null or supersedes_resolution_id <> resolution_id)
);

create index if not exists idx_meeting_speaker_resolutions_version
  on meeting_speaker_resolutions (transcript_version_id, speaker_label, created_at desc);

create table if not exists meeting_extraction_runs (
  extraction_run_id            uuid primary key default gen_random_uuid(),
  meeting_id                   uuid not null references meeting_evidence_meetings(meeting_id) on delete restrict,
  transcript_version_id        uuid not null references transcript_versions(transcript_version_id) on delete restrict,
  model                        text not null check (length(btrim(model)) > 0),
  model_version                text not null check (length(btrim(model_version)) > 0),
  extractor_contract_revision text not null check (length(btrim(extractor_contract_revision)) > 0),
  prompt_revision              text not null check (length(btrim(prompt_revision)) > 0),
  extraction_coverage          text not null check (extraction_coverage in
                                ('full','partial','degraded','failed')),
  coverage_notes               text,
  initiated_by_user_id         uuid references users(id) on delete restrict,
  extracted_at                 timestamptz not null default now(),

  unique (extraction_run_id, transcript_version_id)
);

create index if not exists idx_meeting_extraction_runs_meeting
  on meeting_extraction_runs (meeting_id, extracted_at desc);

create table if not exists meeting_interpretation_candidates (
  candidate_id              uuid primary key default gen_random_uuid(),
  meeting_id                uuid not null references meeting_evidence_meetings(meeting_id) on delete restrict,
  extraction_run_id         uuid not null references meeting_extraction_runs(extraction_run_id) on delete restrict,

  candidate_type            text not null check (candidate_type in (
                              'reported_claim','observation','question','constraint',
                              'proposal','decision','instruction','commitment',
                              'unresolved_issue','correction_or_revision'
                            )),
  subject                   text not null check (length(btrim(subject)) > 0),
  summary                   text not null check (length(btrim(summary)) > 0),

  source_class              text not null check (source_class in (
                              'provider_transcript','provider_metadata','human_review',
                              'manual_entry','governed_domain_read'
                            )),
  epistemic_status          text not null check (epistemic_status in (
                              'stated','reported','inferred','unconfirmed','disputed'
                            )),

  owner_status              text not null check (owner_status in ('named','unassigned','none')),
  owner_label               text,
  owner_person_id           uuid references persons(id) on delete restrict,
  owner_resolution_status   text check (owner_resolution_status in
                              ('confirmed','probable','unresolved')),

  relevant_time             timestamptz,
  material_qualifiers       jsonb not null default '[]'::jsonb
                              check (jsonb_typeof(material_qualifiers) = 'array'),
  material                  boolean not null default true,
  personal                  boolean not null default false,

  supersedes_candidate_id   uuid references meeting_interpretation_candidates(candidate_id) on delete restrict,
  created_at                timestamptz not null default now(),

  constraint ck_candidate_no_receipt_types check (
    candidate_type not in ('watching','also_heard','pulse_fact','raised_unanswered')
  ),
  constraint ck_candidate_owner_shape check (
    (owner_status = 'named' and (owner_label is not null or owner_person_id is not null))
    or
    (owner_status in ('unassigned','none') and owner_label is null
      and owner_person_id is null and owner_resolution_status is null)
  ),
  constraint ck_candidate_owner_person_named
    check (owner_person_id is null or owner_status = 'named'),
  constraint ck_candidate_owner_resolution_named
    check (owner_resolution_status is null or owner_status = 'named'),
  constraint ck_candidate_not_self_superseding
    check (supersedes_candidate_id is null or supersedes_candidate_id <> candidate_id)
);

create index if not exists idx_meeting_candidates_run
  on meeting_interpretation_candidates (extraction_run_id, created_at);
create index if not exists idx_meeting_candidates_meeting
  on meeting_interpretation_candidates (meeting_id, candidate_type);

create table if not exists candidate_support (
  candidate_id             uuid not null references meeting_interpretation_candidates(candidate_id) on delete restrict,
  segment_id               uuid not null references transcript_segments(segment_id) on delete restrict,
  support_role             text not null check (support_role in (
                             'decision_basis','proposal_basis','instruction_basis',
                             'commitment_basis','claim_basis','observation_basis',
                             'qualifier','attribution','superseded_position',
                             'temporal_basis','ownership_basis'
                           )),
  created_at               timestamptz not null default now(),

  primary key (candidate_id, segment_id, support_role)
);

create index if not exists idx_candidate_support_segment
  on candidate_support (segment_id);

create table if not exists candidate_quotes (
  quote_id                 uuid primary key default gen_random_uuid(),
  candidate_id             uuid not null references meeting_interpretation_candidates(candidate_id) on delete restrict,
  segment_id               uuid not null references transcript_segments(segment_id) on delete restrict,
  speaker_label            text not null check (length(btrim(speaker_label)) > 0),
  char_start               integer not null check (char_start >= 0),
  char_end                 integer not null check (char_end > char_start),
  created_at               timestamptz not null default now(),

  unique (candidate_id, segment_id, char_start, char_end)
);

create table if not exists candidate_branches (
  branch_id                uuid primary key default gen_random_uuid(),
  candidate_id             uuid not null references meeting_interpretation_candidates(candidate_id) on delete restrict,
  condition_summary        text not null check (length(btrim(condition_summary)) > 0),
  outcome_summary          text not null check (length(btrim(outcome_summary)) > 0),
  supporting_segment_id    uuid not null references transcript_segments(segment_id) on delete restrict,
  ordinal                  integer not null check (ordinal > 0),
  created_at               timestamptz not null default now(),

  unique (candidate_id, ordinal)
);

create table if not exists candidate_measurements (
  measurement_id           uuid primary key default gen_random_uuid(),
  candidate_id             uuid not null references meeting_interpretation_candidates(candidate_id) on delete restrict,
  measurement_label        text not null check (length(btrim(measurement_label)) > 0),
  value                    numeric not null,
  unit                     text not null check (length(btrim(unit)) > 0),
  as_of                    timestamptz,
  stated_by_segment_id     uuid not null references transcript_segments(segment_id) on delete restrict,
  qualifiers               jsonb not null check (
                            jsonb_typeof(qualifiers) = 'array'
                            and jsonb_array_length(qualifiers) > 0
                          ),
  created_at               timestamptz not null default now()
);

create index if not exists idx_candidate_measurements_candidate
  on candidate_measurements (candidate_id);

create table if not exists meeting_receipts (
  receipt_id                         uuid primary key default gen_random_uuid(),
  meeting_id                         uuid not null references meeting_evidence_meetings(meeting_id) on delete restrict,
  extraction_run_id                  uuid not null references meeting_extraction_runs(extraction_run_id) on delete restrict,
  audience_type                      text not null check (audience_type in ('owner')),
  intended_recipient_person_id       uuid references persons(id) on delete restrict,
  receipt_grammar_revision           text not null check (length(btrim(receipt_grammar_revision)) > 0),
  rendered_subject                   text not null check (length(btrim(rendered_subject)) > 0),
  rendered_body                      text not null check (length(rendered_body) > 0),
  rendered_digest                    text not null check (rendered_digest ~ '^[0-9a-f]{64}$'),
  generation_status                  text not null check (generation_status in ('draft','blocked')),
  created_by_user_id                 uuid not null references users(id) on delete restrict,
  created_at                         timestamptz not null default now(),
  manually_marked_sent_by_user_id    uuid references users(id) on delete restrict,
  manually_marked_sent_at            timestamptz,
  sent_channel_note                  text,
  supersedes_receipt_id              uuid references meeting_receipts(receipt_id) on delete restrict,

  constraint ck_receipt_sent_assertion_shape check (
    (manually_marked_sent_by_user_id is null and manually_marked_sent_at is null)
    or
    (manually_marked_sent_by_user_id is not null and manually_marked_sent_at is not null)
  ),
  constraint ck_receipt_not_self_superseding
    check (supersedes_receipt_id is null or supersedes_receipt_id <> receipt_id)
);

create index if not exists idx_meeting_receipts_run
  on meeting_receipts (extraction_run_id, audience_type, receipt_grammar_revision, created_at desc);
create index if not exists idx_meeting_receipts_meeting
  on meeting_receipts (meeting_id, created_at desc);

create table if not exists meeting_receipt_items (
  receipt_item_id          uuid primary key default gen_random_uuid(),
  receipt_id               uuid not null references meeting_receipts(receipt_id) on delete restrict,
  candidate_id             uuid not null references meeting_interpretation_candidates(candidate_id) on delete restrict,
  section                  text not null check (section in (
                            'PROPERTY PULSE','YOU DECIDED','RAISED, NOT ANSWERED',
                            'NEEDS FOLLOW-UP','WATCHING','ALSO HEARD'
                          )),
  ordinal                  integer not null check (ordinal > 0),
  created_at               timestamptz not null default now(),

  unique (receipt_id, candidate_id),
  unique (receipt_id, section, ordinal)
);

create table if not exists meeting_receipt_candidate_reviews (
  review_id                uuid primary key default gen_random_uuid(),
  receipt_id               uuid not null references meeting_receipts(receipt_id) on delete restrict,
  receipt_item_id          uuid references meeting_receipt_items(receipt_item_id) on delete restrict,
  candidate_id             uuid not null references meeting_interpretation_candidates(candidate_id) on delete restrict,
  review_target            text not null check (review_target in ('interpretation','projection')),
  review_class             text not null,
  review_source            text not null check (review_source in
                            ('direct_review','manual_entry','stored_reply')),
  review_source_id         uuid,
  reviewer_user_id         uuid not null references users(id) on delete restrict,
  reviewer_person_id       uuid references persons(id) on delete restrict,
  reviewed_at              timestamptz not null default now(),
  note                     text,

  constraint ck_candidate_review_class_by_target check (
    (review_target = 'interpretation'
      and review_class in ('confirmed','wrong','overclaimed','incomplete'))
    or
    (review_target = 'projection'
      and review_class in ('wrong_section','not_material','should_have_rendered'))
  ),
  constraint ck_projection_should_have_rendered_item_null check (
    (review_target = 'projection' and review_class = 'should_have_rendered'
      and receipt_item_id is null)
    or
    not (review_target = 'projection' and review_class = 'should_have_rendered')
  )
);

create index if not exists idx_meeting_receipt_reviews_receipt
  on meeting_receipt_candidate_reviews (receipt_id, reviewed_at desc);

create table if not exists meeting_receipt_missed_items (
  missed_id                uuid primary key default gen_random_uuid(),
  receipt_id               uuid not null references meeting_receipts(receipt_id) on delete restrict,
  description              text not null check (length(btrim(description)) > 0),
  supporting_segment_ids   uuid[] not null check (cardinality(supporting_segment_ids) > 0),
  review_source            text not null check (review_source in
                            ('direct_review','manual_entry','stored_reply')),
  review_source_id         uuid,
  reviewer_user_id         uuid not null references users(id) on delete restrict,
  reviewer_person_id       uuid references persons(id) on delete restrict,
  reviewed_at              timestamptz not null default now()
);

create index if not exists idx_meeting_receipt_missed_receipt
  on meeting_receipt_missed_items (receipt_id, reviewed_at desc);

create table if not exists meeting_receipt_manual_edit_deltas (
  edit_id                 uuid primary key default gen_random_uuid(),
  receipt_id              uuid not null references meeting_receipts(receipt_id) on delete restrict,
  edited_by_user_id       uuid not null references users(id) on delete restrict,
  edited_at               timestamptz not null default now(),
  edit_source             text not null check (edit_source in
                           ('manual_preview','sent_copy','stored_reply')),
  field_name              text not null check (field_name in
                           ('rendered_subject','rendered_body')),
  spine_text              text not null,
  human_text              text not null,
  receipt_digest_at_edit  text not null check (receipt_digest_at_edit ~ '^[0-9a-f]{64}$'),
  change_note             text,

  constraint ck_manual_edit_delta_changed check (spine_text <> human_text)
);

create index if not exists idx_meeting_receipt_manual_edits_receipt
  on meeting_receipt_manual_edit_deltas (receipt_id, edited_at desc);

-- ── STRUCTURAL LINEAGE GUARDS ──────────────────────────────────────
create or replace function public.meeting_receipt_lineage_guard()
returns trigger as $$
declare
  run_meeting uuid;
  prior_meeting uuid;
begin
  select meeting_id into run_meeting
    from meeting_extraction_runs
   where extraction_run_id = new.extraction_run_id;

  if run_meeting is null or run_meeting <> new.meeting_id then
    raise exception 'receipt meeting must match its extraction run meeting'
      using errcode = 'check_violation';
  end if;

  if new.supersedes_receipt_id is not null then
    select meeting_id into prior_meeting
      from meeting_receipts
     where receipt_id = new.supersedes_receipt_id;
    if prior_meeting is null or prior_meeting <> new.meeting_id then
      raise exception 'receipt supersession must remain within one meeting'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_receipt_lineage_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_receipt_lineage_guard on meeting_receipts;
create trigger trg_meeting_receipt_lineage_guard
  before insert on meeting_receipts
  for each row execute function public.meeting_receipt_lineage_guard();

create or replace function public.meeting_receipt_item_guard()
returns trigger as $$
declare
  receipt_run uuid;
  candidate_run uuid;
begin
  select extraction_run_id into receipt_run
    from meeting_receipts where receipt_id = new.receipt_id;
  select extraction_run_id into candidate_run
    from meeting_interpretation_candidates where candidate_id = new.candidate_id;
  if receipt_run is null or candidate_run is null or receipt_run <> candidate_run then
    raise exception 'receipt items must reference candidates from the receipt extraction run'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_receipt_item_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_receipt_item_guard on meeting_receipt_items;
create trigger trg_meeting_receipt_item_guard
  before insert on meeting_receipt_items
  for each row execute function public.meeting_receipt_item_guard();

create or replace function public.meeting_receipt_review_guard()
returns trigger as $$
declare
  receipt_run uuid;
  candidate_run uuid;
begin
  select extraction_run_id into receipt_run
    from meeting_receipts where receipt_id = new.receipt_id;
  select extraction_run_id into candidate_run
    from meeting_interpretation_candidates where candidate_id = new.candidate_id;
  if receipt_run is null or candidate_run is null or receipt_run <> candidate_run then
    raise exception 'receipt review candidate must belong to the receipt extraction run'
      using errcode = 'check_violation';
  end if;
  if new.receipt_item_id is not null and not exists (
    select 1 from meeting_receipt_items i
     where i.receipt_item_id = new.receipt_item_id
       and i.receipt_id = new.receipt_id
       and i.candidate_id = new.candidate_id
  ) then
    raise exception 'receipt review item must match both receipt and candidate'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_receipt_review_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_receipt_review_guard on meeting_receipt_candidate_reviews;
create trigger trg_meeting_receipt_review_guard
  before insert on meeting_receipt_candidate_reviews
  for each row execute function public.meeting_receipt_review_guard();

create or replace function public.meeting_receipt_missed_item_guard()
returns trigger as $$
declare
  receipt_version uuid;
  matching_count integer;
begin
  select r.transcript_version_id into receipt_version
    from meeting_receipts receipt
    join meeting_extraction_runs r on r.extraction_run_id = receipt.extraction_run_id
   where receipt.receipt_id = new.receipt_id;
  select count(distinct s.segment_id)::int into matching_count
    from transcript_segments s
   where s.segment_id = any(new.supporting_segment_ids)
     and s.transcript_version_id = receipt_version;
  if receipt_version is null or matching_count <> cardinality(new.supporting_segment_ids) then
    raise exception 'missed-item evidence must use unique segments from the receipt transcript version'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_receipt_missed_item_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_receipt_missed_item_guard on meeting_receipt_missed_items;
create trigger trg_meeting_receipt_missed_item_guard
  before insert on meeting_receipt_missed_items
  for each row execute function public.meeting_receipt_missed_item_guard();

create or replace function public.meeting_candidate_supersession_guard()
returns trigger as $$
declare
  prior record;
  current_run record;
begin
  if new.supersedes_candidate_id is null then
    return new;
  end if;

  select candidate_id, meeting_id, extraction_run_id
    into prior
    from meeting_interpretation_candidates
   where candidate_id = new.supersedes_candidate_id;

  if prior.candidate_id is null
     or prior.meeting_id <> new.meeting_id
     or prior.extraction_run_id <> new.extraction_run_id then
    raise exception 'candidate supersession must remain within one meeting and extraction run'
      using errcode = 'check_violation';
  end if;

  select transcript_version_id
    into current_run
    from meeting_extraction_runs
   where extraction_run_id = new.extraction_run_id;

  if not exists (
    select 1
      from meeting_extraction_runs r
      join meeting_interpretation_candidates c
        on c.extraction_run_id = r.extraction_run_id
     where c.candidate_id = prior.candidate_id
       and r.transcript_version_id = current_run.transcript_version_id
  ) then
    raise exception 'candidate supersession must remain within one transcript version'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$ language plpgsql;
alter function public.meeting_candidate_supersession_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_candidate_supersession_guard on meeting_interpretation_candidates;
create trigger trg_meeting_candidate_supersession_guard
  before insert on meeting_interpretation_candidates
  for each row execute function public.meeting_candidate_supersession_guard();

create or replace function public.meeting_candidate_segment_guard()
returns trigger as $$
declare
  candidate_run uuid;
  candidate_version uuid;
  segment_version uuid;
begin
  if tg_table_name = 'candidate_support' then
    select c.extraction_run_id, r.transcript_version_id
      into candidate_run, candidate_version
      from meeting_interpretation_candidates c
      join meeting_extraction_runs r on r.extraction_run_id = c.extraction_run_id
     where c.candidate_id = new.candidate_id;

    select transcript_version_id into segment_version
      from transcript_segments where segment_id = new.segment_id;
  elsif tg_table_name = 'candidate_quotes' then
    select c.extraction_run_id, r.transcript_version_id
      into candidate_run, candidate_version
      from meeting_interpretation_candidates c
      join meeting_extraction_runs r on r.extraction_run_id = c.extraction_run_id
     where c.candidate_id = new.candidate_id;

    select transcript_version_id into segment_version
      from transcript_segments
     where segment_id = new.segment_id
       and speaker_label = new.speaker_label
       and new.char_end <= char_length(text);

    if segment_version is null then
      raise exception 'quote must resolve to one segment, speaker, and valid character range'
        using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'candidate_branches' then
    select c.extraction_run_id, r.transcript_version_id
      into candidate_run, candidate_version
      from meeting_interpretation_candidates c
      join meeting_extraction_runs r on r.extraction_run_id = c.extraction_run_id
     where c.candidate_id = new.candidate_id;

    select transcript_version_id into segment_version
      from transcript_segments where segment_id = new.supporting_segment_id;
  elsif tg_table_name = 'candidate_measurements' then
    select c.extraction_run_id, r.transcript_version_id
      into candidate_run, candidate_version
      from meeting_interpretation_candidates c
      join meeting_extraction_runs r on r.extraction_run_id = c.extraction_run_id
     where c.candidate_id = new.candidate_id;

    select transcript_version_id into segment_version
      from transcript_segments where segment_id = new.stated_by_segment_id;
  end if;

  if candidate_version is null or segment_version is null or candidate_version <> segment_version then
    raise exception 'candidate evidence must reference the extraction run transcript version'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$ language plpgsql;
alter function public.meeting_candidate_segment_guard() set search_path = public, pg_temp;

drop trigger if exists trg_candidate_support_segment_guard on candidate_support;
create trigger trg_candidate_support_segment_guard
  before insert on candidate_support
  for each row execute function public.meeting_candidate_segment_guard();

drop trigger if exists trg_candidate_quotes_segment_guard on candidate_quotes;
create trigger trg_candidate_quotes_segment_guard
  before insert on candidate_quotes
  for each row execute function public.meeting_candidate_segment_guard();

drop trigger if exists trg_candidate_branches_segment_guard on candidate_branches;
create trigger trg_candidate_branches_segment_guard
  before insert on candidate_branches
  for each row execute function public.meeting_candidate_segment_guard();

drop trigger if exists trg_candidate_measurements_segment_guard on candidate_measurements;
create trigger trg_candidate_measurements_segment_guard
  before insert on candidate_measurements
  for each row execute function public.meeting_candidate_segment_guard();

create or replace function public.meeting_receipt_core_immutable_guard()
returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'meeting_receipts is immutable: DELETE is not permitted'
      using errcode = 'restrict_violation';
  end if;

  if old.receipt_id = new.receipt_id
     and old.meeting_id = new.meeting_id
     and old.extraction_run_id = new.extraction_run_id
     and old.audience_type = new.audience_type
     and old.intended_recipient_person_id is not distinct from new.intended_recipient_person_id
     and old.receipt_grammar_revision = new.receipt_grammar_revision
     and old.rendered_subject = new.rendered_subject
     and old.rendered_body = new.rendered_body
     and old.rendered_digest = new.rendered_digest
     and old.generation_status = new.generation_status
     and old.created_by_user_id = new.created_by_user_id
     and old.created_at = new.created_at
     and old.supersedes_receipt_id is not distinct from new.supersedes_receipt_id
     and old.manually_marked_sent_by_user_id is null
     and old.manually_marked_sent_at is null
     and new.manually_marked_sent_by_user_id is not null
     and new.manually_marked_sent_at is not null then
    return new;
  end if;

  raise exception 'meeting_receipts core is immutable; use a new receipt row for changes'
    using errcode = 'restrict_violation',
          detail = 'The only in-place update allowed is a one-time manual sent assertion.';
end;
$$ language plpgsql;
alter function public.meeting_receipt_core_immutable_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_receipts_core_immutable on meeting_receipts;
create trigger trg_meeting_receipts_core_immutable
  before update or delete on meeting_receipts
  for each row execute function public.meeting_receipt_core_immutable_guard();

-- ── APPEND-ONLY TABLES ─────────────────────────────────────────────
drop trigger if exists trg_meeting_evidence_meetings_append_only on meeting_evidence_meetings;
create trigger trg_meeting_evidence_meetings_append_only
  before update or delete on meeting_evidence_meetings
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_transcript_versions_append_only on transcript_versions;
create trigger trg_transcript_versions_append_only
  before update or delete on transcript_versions
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_transcript_segments_append_only on transcript_segments;
create trigger trg_transcript_segments_append_only
  before update or delete on transcript_segments
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_speaker_resolutions_append_only on meeting_speaker_resolutions;
create trigger trg_meeting_speaker_resolutions_append_only
  before update or delete on meeting_speaker_resolutions
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_extraction_runs_append_only on meeting_extraction_runs;
create trigger trg_meeting_extraction_runs_append_only
  before update or delete on meeting_extraction_runs
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_interpretation_candidates_append_only on meeting_interpretation_candidates;
create trigger trg_meeting_interpretation_candidates_append_only
  before update or delete on meeting_interpretation_candidates
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_candidate_support_append_only on candidate_support;
create trigger trg_candidate_support_append_only
  before update or delete on candidate_support
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_candidate_quotes_append_only on candidate_quotes;
create trigger trg_candidate_quotes_append_only
  before update or delete on candidate_quotes
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_candidate_branches_append_only on candidate_branches;
create trigger trg_candidate_branches_append_only
  before update or delete on candidate_branches
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_candidate_measurements_append_only on candidate_measurements;
create trigger trg_candidate_measurements_append_only
  before update or delete on candidate_measurements
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_receipt_items_append_only on meeting_receipt_items;
create trigger trg_meeting_receipt_items_append_only
  before update or delete on meeting_receipt_items
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_receipt_candidate_reviews_append_only on meeting_receipt_candidate_reviews;
create trigger trg_meeting_receipt_candidate_reviews_append_only
  before update or delete on meeting_receipt_candidate_reviews
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_receipt_missed_items_append_only on meeting_receipt_missed_items;
create trigger trg_meeting_receipt_missed_items_append_only
  before update or delete on meeting_receipt_missed_items
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_receipt_manual_edit_deltas_append_only on meeting_receipt_manual_edit_deltas;
create trigger trg_meeting_receipt_manual_edit_deltas_append_only
  before update or delete on meeting_receipt_manual_edit_deltas
  for each row execute function public.meeting_evidence_append_only_refusal();
