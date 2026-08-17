-- ============================================================================
--  181 - MEETING EVIDENCE BINDING, FINALITY, AND EXTRACTION LINEAGE
--
--  Closes the three gates that must hold before Receipt 001:
--    1. one append-only, non-forking current property binding;
--    2. explicit finality qualification of one exact provider delivery;
--    3. durable delivery -> transcript -> attempt -> outcome -> run lineage.
--
--  Provider metadata is evidence, not authority. In particular, an observed
--  provider trigger is preserved but never qualifies a transcript by itself.
--  This migration still writes no canonical operating truth.
-- ============================================================================

do $$
begin
  if (select count(*) from schema_migrations where version in ('177','178','179','180')) <> 4 then
    raise exception 'migration 181 requires migrations 177, 178, 179, and 180 to land first'
      using errcode = 'object_not_in_prerequisite_state',
            detail = 'Meeting Evidence migration 181 follows the complete Skyline migration range, including inventory retirement at 180.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- PROPERTY BINDING CORRECTIONS
-- ---------------------------------------------------------------------------

alter table meeting_property_bindings
  add column if not exists binding_kind text not null default 'initial',
  add column if not exists correction_reason text,
  add column if not exists supersedes_binding_id uuid
    references meeting_property_bindings(id) on delete restrict;

alter table meeting_property_bindings
  drop constraint if exists meeting_property_bindings_provider_meeting_id_property_id_key;

alter table meeting_property_bindings
  drop constraint if exists ck_meeting_binding_kind_shape;
alter table meeting_property_bindings
  add constraint ck_meeting_binding_kind_shape check (
    (binding_kind = 'initial'
      and supersedes_binding_id is null
      and correction_reason is null)
    or
    (binding_kind = 'correction'
      and supersedes_binding_id is not null
      and length(btrim(correction_reason)) > 0)
  );

alter table meeting_property_bindings
  drop constraint if exists ck_meeting_binding_not_self_superseding;
alter table meeting_property_bindings
  add constraint ck_meeting_binding_not_self_superseding check (
    supersedes_binding_id is null or supersedes_binding_id <> id
  );

do $$
begin
  if exists (
    select 1
      from meeting_property_bindings
     where supersedes_binding_id is null
     group by provider_meeting_id
    having count(*) > 1
  ) then
    raise exception 'meeting binding history already contains multiple initial bindings for one provider meeting'
      using errcode = 'integrity_constraint_violation';
  end if;
end;
$$;

create unique index if not exists uq_meeting_binding_one_initial
  on meeting_property_bindings (provider_meeting_id)
  where supersedes_binding_id is null;

create unique index if not exists uq_meeting_binding_one_successor
  on meeting_property_bindings (supersedes_binding_id)
  where supersedes_binding_id is not null;

create index if not exists idx_meeting_binding_chain
  on meeting_property_bindings (provider_meeting_id, bound_at, id);

create or replace function public.meeting_property_binding_chain_guard()
returns trigger as $$
declare
  prior meeting_property_bindings%rowtype;
  actor_has_initial_authority boolean;
  actor_manages_prior boolean;
  actor_manages_replacement boolean;
begin
  if new.binding_kind = 'initial' then
    select exists (
      select 1
        from property_team_assignments a
       where a.property_id = new.property_id
         and a.user_id = new.bound_by_user_id
         and a.active = true
         and (
           a.can_manage_roles = true
           or a.allowed_modules && array['management','asset_management','leasing']::text[]
         )
    ) into actor_has_initial_authority;

    if not actor_has_initial_authority then
      raise exception 'initial meeting binding requires active property authority'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  select * into prior
    from meeting_property_bindings
   where id = new.supersedes_binding_id
   for update;

  if prior.id is null or prior.provider_meeting_id <> new.provider_meeting_id then
    raise exception 'binding correction must supersede a binding for the same provider meeting'
      using errcode = 'check_violation';
  end if;
  if prior.property_id = new.property_id then
    raise exception 'binding correction must name a different replacement property'
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from meeting_property_bindings child
     where child.supersedes_binding_id = prior.id
  ) then
    raise exception 'binding correction must supersede the current binding head'
      using errcode = 'unique_violation';
  end if;

  select exists (
    select 1 from property_team_assignments a
     where a.property_id = prior.property_id
       and a.user_id = new.bound_by_user_id
       and a.active = true
       and a.can_manage_roles = true
  ) into actor_manages_prior;
  select exists (
    select 1 from property_team_assignments a
     where a.property_id = new.property_id
       and a.user_id = new.bound_by_user_id
       and a.active = true
       and a.can_manage_roles = true
  ) into actor_manages_replacement;

  if not actor_manages_prior or not actor_manages_replacement then
    raise exception 'binding correction requires active management authority at both properties'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_property_binding_chain_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_property_binding_chain_guard on meeting_property_bindings;
create trigger trg_meeting_property_binding_chain_guard
  before insert on meeting_property_bindings
  for each row execute function public.meeting_property_binding_chain_guard();

create or replace view meeting_property_current_bindings as
select b.id, b.provider_meeting_id, b.property_id, b.bound_by_user_id,
       b.bound_at, b.binding_basis, b.binding_kind, b.correction_reason,
       b.supersedes_binding_id
  from meeting_property_bindings b
 where not exists (
   select 1 from meeting_property_bindings child
    where child.supersedes_binding_id = b.id
 );

-- ---------------------------------------------------------------------------
-- EXACT DELIVERY FINALITY
-- ---------------------------------------------------------------------------

alter table meeting_provider_deliveries
  add column if not exists provider_event_trigger text;

create table if not exists meeting_provider_delivery_qualifications (
  qualification_id        uuid primary key default gen_random_uuid(),
  provider_meeting_id     uuid not null references meeting_provider_meetings(id) on delete restrict,
  provider_delivery_id    uuid not null references meeting_provider_deliveries(id) on delete restrict,
  qualification_status    text not null check (qualification_status in ('qualified_final','not_final')),
  qualification_method    text not null default 'manual_exact_delivery_review'
                            check (qualification_method = 'manual_exact_delivery_review'),
  qualification_basis     text not null check (length(btrim(qualification_basis)) > 0),
  qualified_by_user_id    uuid not null references users(id) on delete restrict,
  qualified_at            timestamptz not null default now(),
  supersedes_qualification_id uuid references meeting_provider_delivery_qualifications(qualification_id) on delete restrict,

  constraint ck_delivery_qualification_not_self_superseding check (
    supersedes_qualification_id is null or supersedes_qualification_id <> qualification_id
  )
);

create unique index if not exists uq_delivery_qualification_one_initial
  on meeting_provider_delivery_qualifications (provider_delivery_id)
  where supersedes_qualification_id is null;

create unique index if not exists uq_delivery_qualification_one_successor
  on meeting_provider_delivery_qualifications (supersedes_qualification_id)
  where supersedes_qualification_id is not null;

create index if not exists idx_delivery_qualifications_meeting
  on meeting_provider_delivery_qualifications (provider_meeting_id, qualified_at desc);

create or replace function public.meeting_delivery_qualification_guard()
returns trigger as $$
declare
  delivery record;
  prior meeting_provider_delivery_qualifications%rowtype;
begin
  select d.id, d.connection_id, d.provider_session_id, d.related_delivery_id,
         d.delivery_state, m.id as resolved_meeting_id,
         c.authorized_by_user_id
    into delivery
    from meeting_provider_deliveries d
    join meeting_provider_meetings m
      on m.connection_id = d.connection_id
     and m.provider = d.provider
     and m.provider_session_id = d.provider_session_id
    join integration_connections c
      on c.id = d.connection_id
     and c.connection_status = 'active'
   where d.id = new.provider_delivery_id;

  if delivery.id is null
     or delivery.related_delivery_id is not null
     or delivery.delivery_state <> 'processed_unbound'
     or delivery.resolved_meeting_id <> new.provider_meeting_id then
    raise exception 'finality qualification must reference an exact logical delivery for the provider meeting'
      using errcode = 'check_violation';
  end if;
  if delivery.authorized_by_user_id <> new.qualified_by_user_id then
    raise exception 'only the user who authorized the provider connection may qualify delivery finality'
      using errcode = 'insufficient_privilege';
  end if;

  if new.supersedes_qualification_id is not null then
    select * into prior
      from meeting_provider_delivery_qualifications
     where qualification_id = new.supersedes_qualification_id
     for update;
    if prior.qualification_id is null
       or prior.provider_delivery_id <> new.provider_delivery_id
       or prior.provider_meeting_id <> new.provider_meeting_id then
      raise exception 'finality correction must remain on the same exact delivery'
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from meeting_provider_delivery_qualifications child
       where child.supersedes_qualification_id = prior.qualification_id
    ) then
      raise exception 'finality correction must supersede the current qualification head'
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_delivery_qualification_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_delivery_qualification_guard on meeting_provider_delivery_qualifications;
create trigger trg_meeting_delivery_qualification_guard
  before insert on meeting_provider_delivery_qualifications
  for each row execute function public.meeting_delivery_qualification_guard();

create or replace view meeting_provider_delivery_current_qualifications as
select q.qualification_id, q.provider_meeting_id, q.provider_delivery_id,
       q.qualification_status, q.qualification_method, q.qualification_basis,
       q.qualified_by_user_id, q.qualified_at,
       q.supersedes_qualification_id
  from meeting_provider_delivery_qualifications q
 where not exists (
   select 1 from meeting_provider_delivery_qualifications child
    where child.supersedes_qualification_id = q.qualification_id
 );

-- ---------------------------------------------------------------------------
-- PROVIDER DELIVERY -> TRANSCRIPT -> ATTEMPT -> OUTCOME -> RUN
-- ---------------------------------------------------------------------------

create table if not exists meeting_transcript_provider_sources (
  source_link_id              uuid primary key default gen_random_uuid(),
  transcript_version_id       uuid not null references transcript_versions(transcript_version_id) on delete restrict,
  provider_delivery_id        uuid not null references meeting_provider_deliveries(id) on delete restrict,
  provider_delivery_qualification_id uuid not null references meeting_provider_delivery_qualifications(qualification_id) on delete restrict,
  linked_by_user_id           uuid not null references users(id) on delete restrict,
  linked_at                   timestamptz not null default now(),

  unique (provider_delivery_qualification_id, transcript_version_id)
);

create index if not exists idx_transcript_provider_sources_version
  on meeting_transcript_provider_sources (transcript_version_id, linked_at desc);

create table if not exists meeting_extraction_attempts (
  extraction_attempt_id       uuid primary key default gen_random_uuid(),
  meeting_id                  uuid not null references meeting_evidence_meetings(meeting_id) on delete restrict,
  transcript_version_id       uuid not null references transcript_versions(transcript_version_id) on delete restrict,
  transcript_source_link_id   uuid not null references meeting_transcript_provider_sources(source_link_id) on delete restrict,
  model                       text not null check (length(btrim(model)) > 0),
  model_version               text not null check (length(btrim(model_version)) > 0),
  extractor_contract_revision text not null check (length(btrim(extractor_contract_revision)) > 0),
  prompt_revision             text not null check (length(btrim(prompt_revision)) > 0),
  prompt_sha256               text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  output_schema_sha256        text not null check (output_schema_sha256 ~ '^[0-9a-f]{64}$'),
  request_input_sha256        text not null check (request_input_sha256 ~ '^[0-9a-f]{64}$'),
  initiated_by_user_id        uuid not null references users(id) on delete restrict,
  started_at                  timestamptz not null default now()
);

create index if not exists idx_extraction_attempts_meeting
  on meeting_extraction_attempts (meeting_id, started_at desc);

do $$
begin
  if exists (select 1 from meeting_extraction_runs) then
    raise exception 'existing extraction runs cannot be assigned invented provider-attempt lineage'
      using errcode = 'integrity_constraint_violation';
  end if;
end;
$$;

alter table meeting_extraction_runs
  add column if not exists extraction_attempt_id uuid
    references meeting_extraction_attempts(extraction_attempt_id) on delete restrict;

alter table meeting_extraction_runs
  alter column extraction_attempt_id set not null;

create unique index if not exists uq_meeting_extraction_run_attempt
  on meeting_extraction_runs (extraction_attempt_id);

create table if not exists meeting_extraction_attempt_outcomes (
  extraction_outcome_id       uuid primary key default gen_random_uuid(),
  extraction_attempt_id       uuid not null unique references meeting_extraction_attempts(extraction_attempt_id) on delete restrict,
  outcome_status              text not null check (outcome_status in ('accepted','rejected','provider_failed','persistence_failed')),
  structured_output           jsonb,
  structured_output_sha256    text check (structured_output_sha256 is null or structured_output_sha256 ~ '^[0-9a-f]{64}$'),
  failure_code                text,
  validation_errors           jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_errors) = 'array'),
  extraction_run_id           uuid unique references meeting_extraction_runs(extraction_run_id) on delete restrict,
  completed_at                timestamptz not null default now(),

  constraint ck_extraction_outcome_shape check (
    (outcome_status = 'accepted'
      and structured_output is not null
      and structured_output_sha256 is not null
      and failure_code is null
      and validation_errors = '[]'::jsonb
      and extraction_run_id is not null)
    or
    (outcome_status = 'rejected'
      and (structured_output is null) = (structured_output_sha256 is null)
      and length(btrim(failure_code)) > 0
      and extraction_run_id is null)
    or
    (outcome_status = 'provider_failed'
      and structured_output is null
      and structured_output_sha256 is null
      and length(btrim(failure_code)) > 0
      and extraction_run_id is null)
    or
    (outcome_status = 'persistence_failed'
      and structured_output is not null
      and structured_output_sha256 is not null
      and length(btrim(failure_code)) > 0
      and extraction_run_id is null)
  )
);

create index if not exists idx_extraction_outcomes_status
  on meeting_extraction_attempt_outcomes (outcome_status, completed_at desc);

create or replace function public.meeting_transcript_provider_source_guard()
returns trigger as $$
declare
  source_context record;
begin
  select tv.meeting_id, em.provider_meeting_id, em.property_id,
         q.provider_delivery_id, q.qualification_status
    into source_context
    from transcript_versions tv
    join meeting_evidence_meetings em on em.meeting_id = tv.meeting_id
    join meeting_provider_delivery_current_qualifications q
      on q.qualification_id = new.provider_delivery_qualification_id
   where tv.transcript_version_id = new.transcript_version_id;

  if source_context.meeting_id is null
     or source_context.provider_delivery_id <> new.provider_delivery_id
     or source_context.qualification_status <> 'qualified_final'
     or not exists (
       select 1 from meeting_provider_delivery_current_qualifications q
        where q.qualification_id = new.provider_delivery_qualification_id
          and q.provider_meeting_id = source_context.provider_meeting_id
     ) then
    raise exception 'transcript source must use the current final qualification for its exact provider delivery'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from meeting_property_current_bindings b
     where b.provider_meeting_id = source_context.provider_meeting_id
       and b.property_id = source_context.property_id
  ) then
    raise exception 'transcript source requires the canonical meeting property to remain the current binding'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from property_team_assignments a
     where a.property_id = source_context.property_id
       and a.user_id = new.linked_by_user_id
       and a.active = true
       and (
         a.can_manage_roles = true
         or a.allowed_modules && array['management','asset_management','leasing']::text[]
       )
  ) then
    raise exception 'transcript source link requires active property authority'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_transcript_provider_source_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_transcript_provider_source_guard on meeting_transcript_provider_sources;
create trigger trg_meeting_transcript_provider_source_guard
  before insert on meeting_transcript_provider_sources
  for each row execute function public.meeting_transcript_provider_source_guard();

create or replace function public.meeting_extraction_attempt_guard()
returns trigger as $$
declare
  source_context record;
begin
  select s.transcript_version_id, tv.meeting_id, em.property_id,
         em.provider_meeting_id, s.provider_delivery_qualification_id
    into source_context
    from meeting_transcript_provider_sources s
    join transcript_versions tv on tv.transcript_version_id = s.transcript_version_id
    join meeting_evidence_meetings em on em.meeting_id = tv.meeting_id
   where s.source_link_id = new.transcript_source_link_id;

  if source_context.transcript_version_id is null
     or source_context.transcript_version_id <> new.transcript_version_id
     or source_context.meeting_id <> new.meeting_id
     or not exists (
       select 1 from meeting_provider_delivery_current_qualifications q
        where q.qualification_id = source_context.provider_delivery_qualification_id
          and q.qualification_status = 'qualified_final'
     )
     or not exists (
       select 1 from meeting_property_current_bindings b
        where b.provider_meeting_id = source_context.provider_meeting_id
          and b.property_id = source_context.property_id
     ) then
    raise exception 'extraction attempt requires current binding and current exact-delivery finality'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from property_team_assignments a
     where a.property_id = source_context.property_id
       and a.user_id = new.initiated_by_user_id
       and a.active = true
       and (
         a.can_manage_roles = true
         or a.allowed_modules && array['management','asset_management','leasing']::text[]
       )
  ) then
    raise exception 'extraction attempt requires active property authority'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_extraction_attempt_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_extraction_attempt_guard on meeting_extraction_attempts;
create trigger trg_meeting_extraction_attempt_guard
  before insert on meeting_extraction_attempts
  for each row execute function public.meeting_extraction_attempt_guard();

create or replace function public.meeting_extraction_run_attempt_guard()
returns trigger as $$
declare
  attempt meeting_extraction_attempts%rowtype;
  source_context record;
  current_finality boolean;
  current_binding boolean;
begin
  select * into attempt
    from meeting_extraction_attempts
   where extraction_attempt_id = new.extraction_attempt_id;

  if attempt.extraction_attempt_id is null
     or attempt.meeting_id <> new.meeting_id
     or attempt.transcript_version_id <> new.transcript_version_id
     or attempt.model <> new.model
     or attempt.model_version <> new.model_version
     or attempt.extractor_contract_revision <> new.extractor_contract_revision
     or attempt.prompt_revision <> new.prompt_revision
     or exists (
       select 1 from meeting_extraction_attempt_outcomes o
        where o.extraction_attempt_id = attempt.extraction_attempt_id
     ) then
    raise exception 'accepted extraction run must match one open extraction attempt exactly'
      using errcode = 'check_violation';
  end if;

  select em.provider_meeting_id, em.property_id, s.provider_delivery_qualification_id
    into source_context
    from meeting_transcript_provider_sources s
    join meeting_evidence_meetings em on em.meeting_id = attempt.meeting_id
   where s.source_link_id = attempt.transcript_source_link_id;

  select true into current_finality
    from meeting_provider_delivery_qualifications q
   where q.qualification_id = source_context.provider_delivery_qualification_id
     and q.qualification_status = 'qualified_final'
   for share;

  -- Lock the binding history before checking its head. If a correction won
  -- first, this waits and the following statement sees its committed child.
  -- If this run won first, the correction waits until the accepted outcome
  -- and receipt commit together.
  perform 1
    from meeting_property_bindings b
   where b.provider_meeting_id = source_context.provider_meeting_id
   for share;

  select exists (
    select 1 from meeting_property_bindings b
     where b.provider_meeting_id = source_context.provider_meeting_id
       and b.property_id = source_context.property_id
       and not exists (
         select 1 from meeting_property_bindings child
          where child.supersedes_binding_id = b.id
       )
  ) into current_binding;

  if coalesce(current_finality, false) is not true
     or exists (
       select 1 from meeting_provider_delivery_qualifications child
        where child.supersedes_qualification_id = source_context.provider_delivery_qualification_id
     )
     or coalesce(current_binding, false) is not true then
    raise exception 'accepted extraction requires finality and binding to remain current at commit'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_extraction_run_attempt_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_extraction_run_attempt_guard on meeting_extraction_runs;
create trigger trg_meeting_extraction_run_attempt_guard
  before insert on meeting_extraction_runs
  for each row execute function public.meeting_extraction_run_attempt_guard();

create or replace function public.meeting_extraction_outcome_guard()
returns trigger as $$
declare
  run_attempt uuid;
begin
  if new.outcome_status = 'accepted' then
    select extraction_attempt_id into run_attempt
      from meeting_extraction_runs
     where extraction_run_id = new.extraction_run_id;
    if run_attempt is null or run_attempt <> new.extraction_attempt_id then
      raise exception 'accepted extraction outcome must point to its own extraction run'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_extraction_outcome_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_extraction_outcome_guard on meeting_extraction_attempt_outcomes;
create trigger trg_meeting_extraction_outcome_guard
  before insert on meeting_extraction_attempt_outcomes
  for each row execute function public.meeting_extraction_outcome_guard();

create or replace function public.meeting_extraction_run_requires_outcome()
returns trigger as $$
begin
  if not exists (
    select 1 from meeting_extraction_attempt_outcomes o
     where o.extraction_attempt_id = new.extraction_attempt_id
       and o.extraction_run_id = new.extraction_run_id
       and o.outcome_status = 'accepted'
  ) then
    raise exception 'extraction run must commit with one accepted attempt outcome'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$ language plpgsql;
alter function public.meeting_extraction_run_requires_outcome() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_extraction_run_requires_outcome on meeting_extraction_runs;
create constraint trigger trg_meeting_extraction_run_requires_outcome
  after insert on meeting_extraction_runs
  deferrable initially deferred
  for each row execute function public.meeting_extraction_run_requires_outcome();

-- The new records preserve evidence and model history. Corrections are new
-- rows; none of these tables permits a rewrite or delete.
drop trigger if exists trg_meeting_provider_delivery_qualifications_append_only on meeting_provider_delivery_qualifications;
create trigger trg_meeting_provider_delivery_qualifications_append_only
  before update or delete on meeting_provider_delivery_qualifications
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_transcript_provider_sources_append_only on meeting_transcript_provider_sources;
create trigger trg_meeting_transcript_provider_sources_append_only
  before update or delete on meeting_transcript_provider_sources
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_extraction_attempts_append_only on meeting_extraction_attempts;
create trigger trg_meeting_extraction_attempts_append_only
  before update or delete on meeting_extraction_attempts
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_extraction_attempt_outcomes_append_only on meeting_extraction_attempt_outcomes;
create trigger trg_meeting_extraction_attempt_outcomes_append_only
  before update or delete on meeting_extraction_attempt_outcomes
  for each row execute function public.meeting_evidence_append_only_refusal();
