-- ============================================================================
--  188 - MIXED-PROPERTY MEETING PASSAGE SCOPE
--
--  A provider meeting can cover one property or several. The whole meeting may
--  only enter the existing one-property binding rail after an explicit
--  single-property classification. Mixed meetings remain unbound. Their exact
--  provider passages can instead receive an append-only human scope assertion.
--
--  This migration does NOT create a canonical meeting, transcript version,
--  extraction attempt, receipt, email, Ask Spine reader, or operating write.
-- ============================================================================

do $$
begin
  if not exists (select 1 from schema_migrations where version = '187') then
    raise exception 'migration 188 requires migration 187 to land first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- PROVIDER-MEETING SCOPE CLASSIFICATION
-- ---------------------------------------------------------------------------

create table if not exists meeting_provider_scope_classifications (
  scope_classification_id       uuid primary key default gen_random_uuid(),
  provider_meeting_id           uuid not null references meeting_provider_meetings(id) on delete restrict,
  scope_mode                    text not null check (scope_mode in (
                                  'single_property','mixed_property','unresolved'
                                )),
  classification_basis          text not null check (length(btrim(classification_basis)) > 0),
  classified_by_user_id         uuid not null references users(id) on delete restrict,
  classified_at                 timestamptz not null default now(),
  supersedes_classification_id  uuid references meeting_provider_scope_classifications(scope_classification_id)
                                  on delete restrict,

  constraint ck_meeting_scope_classification_not_self_superseding check (
    supersedes_classification_id is null
    or supersedes_classification_id <> scope_classification_id
  )
);

create unique index if not exists uq_meeting_scope_classification_one_initial
  on meeting_provider_scope_classifications (provider_meeting_id)
  where supersedes_classification_id is null;

create unique index if not exists uq_meeting_scope_classification_one_successor
  on meeting_provider_scope_classifications (supersedes_classification_id)
  where supersedes_classification_id is not null;

create index if not exists idx_meeting_scope_classification_history
  on meeting_provider_scope_classifications (provider_meeting_id, classified_at, scope_classification_id);

create or replace function public.meeting_provider_scope_classification_guard()
returns trigger as $$
declare
  connection_authorizer uuid;
  prior meeting_provider_scope_classifications%rowtype;
begin
  select c.authorized_by_user_id
    into connection_authorizer
    from meeting_provider_meetings m
    join integration_connections c
      on c.id = m.connection_id
     and c.provider = m.provider
     and c.connection_status = 'active'
   where m.id = new.provider_meeting_id;

  if connection_authorizer is null then
    raise exception 'meeting scope classification requires an active provider connection'
      using errcode = 'check_violation';
  end if;
  if connection_authorizer <> new.classified_by_user_id then
    raise exception 'only the provider connection authorizer may classify an unbound meeting scope'
      using errcode = 'insufficient_privilege';
  end if;

  if new.supersedes_classification_id is not null then
    select * into prior
      from meeting_provider_scope_classifications
     where scope_classification_id = new.supersedes_classification_id
     for update;
    if prior.scope_classification_id is null
       or prior.provider_meeting_id <> new.provider_meeting_id then
      raise exception 'meeting scope correction must remain on the same provider meeting'
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from meeting_provider_scope_classifications child
       where child.supersedes_classification_id = prior.scope_classification_id
    ) then
      raise exception 'meeting scope correction must supersede the current classification head'
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_provider_scope_classification_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_provider_scope_classification_guard
  on meeting_provider_scope_classifications;
create trigger trg_meeting_provider_scope_classification_guard
  before insert on meeting_provider_scope_classifications
  for each row execute function public.meeting_provider_scope_classification_guard();

create or replace view meeting_provider_current_scope_classifications as
select c.scope_classification_id, c.provider_meeting_id, c.scope_mode,
       c.classification_basis, c.classified_by_user_id, c.classified_at,
       c.supersedes_classification_id
  from meeting_provider_scope_classifications c
 where not exists (
   select 1 from meeting_provider_scope_classifications child
    where child.supersedes_classification_id = c.scope_classification_id
 );

-- Existing pre-188 bindings remain visible until explicitly classified. Once a
-- classification exists, only a current single-property classification may
-- keep a whole-meeting binding visible.
create or replace view meeting_property_current_bindings as
select b.id, b.provider_meeting_id, b.property_id, b.bound_by_user_id,
       b.bound_at, b.binding_basis, b.binding_kind, b.correction_reason,
       b.supersedes_binding_id
  from meeting_property_bindings b
 where not exists (
   select 1 from meeting_property_bindings child
    where child.supersedes_binding_id = b.id
 )
   and (
     not exists (
       select 1 from meeting_provider_scope_classifications c
        where c.provider_meeting_id = b.provider_meeting_id
     )
     or exists (
       select 1 from meeting_provider_current_scope_classifications current_scope
        where current_scope.provider_meeting_id = b.provider_meeting_id
          and current_scope.scope_mode = 'single_property'
     )
   );

-- Replace the binding guard so every new initial whole-meeting binding first
-- earns an explicit single-property classification. Legacy correction chains
-- without a classification remain operable; they predate this migration.
create or replace function public.meeting_property_binding_chain_guard()
returns trigger as $$
declare
  prior meeting_property_bindings%rowtype;
  current_scope_mode text;
  any_scope_history boolean;
  actor_has_initial_authority boolean;
  actor_manages_prior boolean;
  actor_manages_replacement boolean;
begin
  select exists (
    select 1 from meeting_provider_scope_classifications c
     where c.provider_meeting_id = new.provider_meeting_id
  ) into any_scope_history;
  select c.scope_mode into current_scope_mode
    from meeting_provider_current_scope_classifications c
   where c.provider_meeting_id = new.provider_meeting_id;

  if new.binding_kind = 'initial' then
    if coalesce(current_scope_mode, '') <> 'single_property' then
      raise exception 'whole-meeting binding requires an explicit current single-property classification'
        using errcode = 'check_violation';
    end if;
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

  if any_scope_history and coalesce(current_scope_mode, '') <> 'single_property' then
    raise exception 'whole-meeting binding correction is unavailable while meeting scope is mixed or unresolved'
      using errcode = 'check_violation';
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

-- ---------------------------------------------------------------------------
-- IMMUTABLE PASSAGE-SCOPE SETS
-- ---------------------------------------------------------------------------

create table if not exists meeting_passage_scope_sets (
  passage_scope_set_id          uuid primary key default gen_random_uuid(),
  provider_meeting_id           uuid not null references meeting_provider_meetings(id) on delete restrict,
  provider_delivery_qualification_id uuid not null
                                   references meeting_provider_delivery_qualifications(qualification_id)
                                   on delete restrict,
  scope_classification_id       uuid not null
                                   references meeting_provider_scope_classifications(scope_classification_id)
                                   on delete restrict,
  scope_status                  text not null check (scope_status in ('qualified','withdrawn')),
  scope_review_coverage         text not null check (scope_review_coverage in ('partial','complete','none')),
  scope_basis                   text not null check (length(btrim(scope_basis)) > 0),
  scope_digest                  text not null check (scope_digest ~ '^[0-9a-f]{64}$'),
  scoped_by_user_id             uuid not null references users(id) on delete restrict,
  scoped_at                     timestamptz not null default now(),
  created_txid                  bigint not null default txid_current(),
  supersedes_passage_scope_set_id uuid references meeting_passage_scope_sets(passage_scope_set_id)
                                     on delete restrict,

  constraint ck_passage_scope_set_not_self_superseding check (
    supersedes_passage_scope_set_id is null
    or supersedes_passage_scope_set_id <> passage_scope_set_id
  ),
  constraint ck_passage_scope_set_coverage_shape check (
    (scope_status = 'qualified' and scope_review_coverage in ('partial','complete'))
    or (scope_status = 'withdrawn' and scope_review_coverage = 'none')
  )
);

create unique index if not exists uq_passage_scope_set_one_initial
  on meeting_passage_scope_sets (scope_classification_id, provider_delivery_qualification_id)
  where supersedes_passage_scope_set_id is null;

create unique index if not exists uq_passage_scope_set_one_successor
  on meeting_passage_scope_sets (supersedes_passage_scope_set_id)
  where supersedes_passage_scope_set_id is not null;

create unique index if not exists uq_passage_scope_set_digest
  on meeting_passage_scope_sets
    (scope_classification_id, provider_delivery_qualification_id, scope_digest);

create index if not exists idx_passage_scope_set_meeting
  on meeting_passage_scope_sets (provider_meeting_id, scoped_at, passage_scope_set_id);

create table if not exists meeting_passage_scopes (
  passage_scope_id          uuid primary key default gen_random_uuid(),
  passage_scope_set_id      uuid not null references meeting_passage_scope_sets(passage_scope_set_id)
                              on delete restrict,
  ordinal                   integer not null check (ordinal > 0),
  provider_block_ordinal    integer not null check (provider_block_ordinal > 0),
  char_start                integer not null check (char_start >= 0),
  char_end                  integer not null check (char_end > char_start),
  provider_start_time       text not null check (length(btrim(provider_start_time)) > 0),
  speaker_label             text not null check (length(btrim(speaker_label)) > 0),
  passage_text              text not null check (length(btrim(passage_text)) > 0),
  passage_text_sha256       text not null check (passage_text_sha256 ~ '^[0-9a-f]{64}$'),
  scope_target_kind         text not null check (scope_target_kind in (
                              'property','portfolio_wide','external_property',
                              'unresolved','excluded_sensitive'
                            )),
  property_id               uuid references properties(id) on delete restrict,
  external_scope_label      text,
  scope_note                text,

  unique (passage_scope_set_id, ordinal),
  constraint ck_passage_scope_target_shape check (
    (scope_target_kind = 'property'
      and property_id is not null
      and external_scope_label is null)
    or
    (scope_target_kind = 'external_property'
      and property_id is null
      and length(btrim(external_scope_label)) > 0)
    or
    (scope_target_kind in ('portfolio_wide','unresolved','excluded_sensitive')
      and property_id is null
      and external_scope_label is null)
  )
);

comment on column meeting_passage_scopes.char_start is
  'Zero-based Unicode code-point offset into the exact provider speaker-block words. Matches PostgreSQL char_length/substring semantics.';
comment on column meeting_passage_scopes.char_end is
  'Exclusive Unicode code-point offset into the exact provider speaker-block words.';

create index if not exists idx_passage_scope_set_order
  on meeting_passage_scopes
    (passage_scope_set_id, provider_block_ordinal, char_start, char_end);

create index if not exists idx_passage_scope_property
  on meeting_passage_scopes (property_id, passage_scope_set_id)
  where scope_target_kind = 'property';

create or replace function public.meeting_passage_scope_set_guard()
returns trigger as $$
declare
  classification meeting_provider_scope_classifications%rowtype;
  qualification record;
  connection_authorizer uuid;
  prior meeting_passage_scope_sets%rowtype;
begin
  select * into classification
    from meeting_provider_scope_classifications
   where scope_classification_id = new.scope_classification_id;
  if classification.scope_classification_id is null
     or classification.provider_meeting_id <> new.provider_meeting_id
     or classification.scope_mode <> 'mixed_property'
     or exists (
       select 1 from meeting_provider_scope_classifications child
        where child.supersedes_classification_id = classification.scope_classification_id
     ) then
    raise exception 'passage scoping requires the current mixed-property classification'
      using errcode = 'check_violation';
  end if;

  select q.provider_meeting_id, q.qualification_status,
         d.connection_id, c.authorized_by_user_id
    into qualification
    from meeting_provider_delivery_qualifications q
    join meeting_provider_deliveries d on d.id = q.provider_delivery_id
    join integration_connections c
      on c.id = d.connection_id
     and c.connection_status = 'active'
   where q.qualification_id = new.provider_delivery_qualification_id;
  if qualification.provider_meeting_id is null
     or qualification.provider_meeting_id <> new.provider_meeting_id
     or qualification.qualification_status <> 'qualified_final'
     or exists (
       select 1 from meeting_provider_delivery_qualifications child
        where child.supersedes_qualification_id = new.provider_delivery_qualification_id
     ) then
    raise exception 'passage scoping requires the current exact-delivery finality qualification'
      using errcode = 'check_violation';
  end if;

  connection_authorizer := qualification.authorized_by_user_id;
  if connection_authorizer <> new.scoped_by_user_id
     or classification.classified_by_user_id <> new.scoped_by_user_id then
    raise exception 'only the connection authorizer who classified the meeting may scope its passages'
      using errcode = 'insufficient_privilege';
  end if;

  if new.supersedes_passage_scope_set_id is not null then
    select * into prior
      from meeting_passage_scope_sets
     where passage_scope_set_id = new.supersedes_passage_scope_set_id
     for update;
    if prior.passage_scope_set_id is null
       or prior.provider_meeting_id <> new.provider_meeting_id
       or prior.scope_classification_id <> new.scope_classification_id
       or prior.provider_delivery_qualification_id <> new.provider_delivery_qualification_id then
      raise exception 'passage scope correction must remain on the same meeting, classification, and exact delivery'
        using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from meeting_passage_scope_sets child
       where child.supersedes_passage_scope_set_id = prior.passage_scope_set_id
    ) then
      raise exception 'passage scope correction must supersede the current scope-set head'
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
alter function public.meeting_passage_scope_set_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_passage_scope_set_guard on meeting_passage_scope_sets;
create trigger trg_meeting_passage_scope_set_guard
  before insert on meeting_passage_scope_sets
  for each row execute function public.meeting_passage_scope_set_guard();

create or replace function public.meeting_passage_scope_guard()
returns trigger as $$
declare
  scope_set meeting_passage_scope_sets%rowtype;
  raw_payload jsonb;
  provider_block jsonb;
  provider_words text;
  provider_speaker text;
  provider_start text;
  expected_passage text;
  actor_has_property_authority boolean;
begin
  select s.*
    into scope_set
    from meeting_passage_scope_sets s
   where s.passage_scope_set_id = new.passage_scope_set_id;
  select convert_from(d.raw_body, 'UTF8')::jsonb
    into raw_payload
    from meeting_passage_scope_sets s
    join meeting_provider_delivery_qualifications q
      on q.qualification_id = s.provider_delivery_qualification_id
    join meeting_provider_deliveries d on d.id = q.provider_delivery_id
   where s.passage_scope_set_id = new.passage_scope_set_id;
  if scope_set.passage_scope_set_id is null or scope_set.scope_status <> 'qualified' then
    raise exception 'passages may only belong to a qualified scope set'
      using errcode = 'check_violation';
  end if;
  if scope_set.created_txid <> txid_current() then
    raise exception 'passage membership is frozen when its complete scope set commits'
      using errcode = 'restrict_violation';
  end if;

  provider_block := raw_payload #> array[
    'transcript', 'speaker_blocks', (new.provider_block_ordinal - 1)::text
  ];
  provider_words := provider_block ->> 'words';
  provider_speaker := provider_block #>> '{speaker,name}';
  provider_start := provider_block ->> 'start_time';
  if provider_words is null or provider_speaker is null or provider_start is null
     or new.char_end > char_length(provider_words) then
    raise exception 'passage range must resolve inside one exact provider speaker block'
      using errcode = 'check_violation';
  end if;

  expected_passage := substring(provider_words from new.char_start + 1 for new.char_end - new.char_start);
  if new.passage_text <> expected_passage
     or new.speaker_label <> provider_speaker
     or new.provider_start_time <> provider_start
     or new.passage_text_sha256 <> encode(sha256(convert_to(new.passage_text, 'UTF8')), 'hex') then
    raise exception 'passage evidence must match the exact provider bytes at its stored address'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from meeting_passage_scopes existing
     where existing.passage_scope_set_id = new.passage_scope_set_id
       and existing.provider_block_ordinal = new.provider_block_ordinal
       and new.char_start < existing.char_end
       and new.char_end > existing.char_start
  ) then
    raise exception 'current passage scopes may not overlap within one provider block'
      using errcode = 'exclusion_violation';
  end if;

  if new.scope_target_kind = 'property' then
    select exists (
      select 1 from property_team_assignments a
       where a.property_id = new.property_id
         and a.user_id = scope_set.scoped_by_user_id
         and a.active = true
         and (
           a.can_manage_roles = true
           or a.allowed_modules && array['management','asset_management','leasing']::text[]
         )
    ) into actor_has_property_authority;
    if not actor_has_property_authority then
      raise exception 'property passage scope requires active authority at the target property'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
exception
  when invalid_text_representation then
    raise exception 'provider delivery bytes are not valid JSON passage evidence'
      using errcode = 'check_violation';
end;
$$ language plpgsql;
alter function public.meeting_passage_scope_guard() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_passage_scope_guard on meeting_passage_scopes;
create trigger trg_meeting_passage_scope_guard
  before insert on meeting_passage_scopes
  for each row execute function public.meeting_passage_scope_guard();

create or replace function public.meeting_passage_scope_set_requires_shape()
returns trigger as $$
begin
  if new.scope_status = 'qualified' and not exists (
    select 1 from meeting_passage_scopes p
     where p.passage_scope_set_id = new.passage_scope_set_id
  ) then
    raise exception 'qualified passage scope set must contain at least one exact passage'
      using errcode = 'check_violation';
  end if;
  if new.scope_status = 'withdrawn' and exists (
    select 1 from meeting_passage_scopes p
     where p.passage_scope_set_id = new.passage_scope_set_id
  ) then
    raise exception 'withdrawn passage scope set must contain no passages'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$ language plpgsql;
alter function public.meeting_passage_scope_set_requires_shape() set search_path = public, pg_temp;

drop trigger if exists trg_meeting_passage_scope_set_requires_shape on meeting_passage_scope_sets;
create constraint trigger trg_meeting_passage_scope_set_requires_shape
  after insert on meeting_passage_scope_sets
  deferrable initially deferred
  for each row execute function public.meeting_passage_scope_set_requires_shape();

create or replace view meeting_passage_scope_current_sets as
select s.passage_scope_set_id, s.provider_meeting_id,
       s.provider_delivery_qualification_id, q.provider_delivery_id,
       s.scope_classification_id, s.scope_status, s.scope_review_coverage,
       s.scope_basis, s.scope_digest,
       s.scoped_by_user_id, s.scoped_at, s.supersedes_passage_scope_set_id
  from meeting_passage_scope_sets s
  join meeting_provider_current_scope_classifications c
    on c.scope_classification_id = s.scope_classification_id
   and c.provider_meeting_id = s.provider_meeting_id
   and c.scope_mode = 'mixed_property'
  join meeting_provider_delivery_current_qualifications q
    on q.qualification_id = s.provider_delivery_qualification_id
   and q.provider_meeting_id = s.provider_meeting_id
   and q.qualification_status = 'qualified_final'
 where s.scope_status = 'qualified'
   and not exists (
     select 1 from meeting_passage_scope_sets child
      where child.supersedes_passage_scope_set_id = s.passage_scope_set_id
   );

create or replace view meeting_property_current_passages as
select s.passage_scope_set_id, s.provider_meeting_id, s.provider_delivery_id,
       s.provider_delivery_qualification_id, s.scope_classification_id,
       s.scope_basis, s.scope_digest, s.scoped_by_user_id, s.scoped_at,
       p.passage_scope_id, p.ordinal, p.provider_block_ordinal,
       p.char_start, p.char_end, p.provider_start_time, p.speaker_label,
       p.passage_text, p.passage_text_sha256, p.property_id, p.scope_note
  from meeting_passage_scope_current_sets s
  join meeting_passage_scopes p on p.passage_scope_set_id = s.passage_scope_set_id
 where p.scope_target_kind = 'property';

-- Scope facts and their exact passage evidence are append-only. Corrections
-- replace a complete set so one range can safely split into several ranges.
drop trigger if exists trg_meeting_provider_scope_classifications_append_only
  on meeting_provider_scope_classifications;
create trigger trg_meeting_provider_scope_classifications_append_only
  before update or delete on meeting_provider_scope_classifications
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_passage_scope_sets_append_only on meeting_passage_scope_sets;
create trigger trg_meeting_passage_scope_sets_append_only
  before update or delete on meeting_passage_scope_sets
  for each row execute function public.meeting_evidence_append_only_refusal();

drop trigger if exists trg_meeting_passage_scopes_append_only on meeting_passage_scopes;
create trigger trg_meeting_passage_scopes_append_only
  before update or delete on meeting_passage_scopes
  for each row execute function public.meeting_evidence_append_only_refusal();
