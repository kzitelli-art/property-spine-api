-- ════════════════════════════════════════════════════════════════════
-- 120 — AI LEASING STRATEGY, VALIDATION, ATTRIBUTION + EVIDENCE LINEAGE
--
-- Permanent primitives only. This migration activates no property and changes
-- no live prompt by itself.
--
-- Critical rulings:
--   • strategy differences are governed next-move contracts, not adjectives;
--   • no strategy version is deployable until a replay corpus passes;
--   • the experimental unit is leasing_leads.id, not a lifelong conversation;
--   • a qualified denominator requires confirmed delivered strategy exposure;
--   • application evidence requires a direct leasing_lead_id link;
--   • unsupported outcomes remain unavailable, never silently false.
-- ════════════════════════════════════════════════════════════════════

create table if not exists ai_leasing_strategy_profiles (
  id              uuid primary key default gen_random_uuid(),
  strategy_key    text not null unique check (strategy_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  interface_name  text not null check (btrim(interface_name) <> ''),
  interface_title text not null check (btrim(interface_title) <> ''),
  description     text not null check (btrim(description) <> ''),
  status          text not null default 'active' check (status in ('active','retired')),
  created_at      timestamptz not null default now(),
  retired_at      timestamptz,
  check ((status = 'retired') = (retired_at is not null))
);

create table if not exists ai_leasing_strategy_versions (
  id                       uuid primary key default gen_random_uuid(),
  strategy_profile_id      uuid not null references ai_leasing_strategy_profiles(id) on delete restrict,
  version_number           integer not null check (version_number > 0),
  behavior_policy          jsonb not null,
  prompt_contract_version  text not null default 'ai_leasing_strategy_v2' check (btrim(prompt_contract_version) <> ''),
  status                   text not null default 'draft' check (status in ('draft','validated','retired')),
  effective_at             timestamptz,
  retired_at               timestamptz,
  created_at               timestamptz not null default now(),
  unique (strategy_profile_id, version_number),
  unique (id, strategy_profile_id),
  check (jsonb_typeof(behavior_policy) = 'object'),
  check (
    (status = 'draft' and effective_at is null and retired_at is null)
    or (status = 'validated' and effective_at is not null and retired_at is null)
    or (status = 'retired' and effective_at is not null and retired_at is not null)
  )
);

create or replace function prevent_ai_leasing_strategy_version_rewrite()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'AI leasing strategy versions cannot be deleted; retire the version.';
  end if;
  if old.strategy_profile_id is distinct from new.strategy_profile_id
     or old.version_number is distinct from new.version_number
     or old.behavior_policy is distinct from new.behavior_policy
     or old.prompt_contract_version is distinct from new.prompt_contract_version
     or old.created_at is distinct from new.created_at then
    raise exception 'AI leasing strategy is immutable; create a new version.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ai_leasing_strategy_version_immutable on ai_leasing_strategy_versions;
create trigger trg_ai_leasing_strategy_version_immutable
before update or delete on ai_leasing_strategy_versions
for each row execute function prevent_ai_leasing_strategy_version_rewrite();

-- A source-level prompt difference is not deployment proof. A completed replay
-- artifact must show repeated next-move adherence and zero shared-rule defects.
create table if not exists ai_leasing_strategy_validation_runs (
  id                          uuid primary key default gen_random_uuid(),
  strategy_version_id         uuid not null references ai_leasing_strategy_versions(id) on delete restrict,
  generation_surface          text not null check (generation_surface in ('first_response','ongoing_reply','regenerated_reply')),
  corpus_digest               text not null check (corpus_digest ~ '^[0-9a-f]{64}$'),
  scenario_count              integer not null check (scenario_count > 0),
  model                       text not null check (btrim(model) <> ''),
  prompt_revision             text not null check (btrim(prompt_revision) <> ''),
  runtime_contract_version    text not null check (btrim(runtime_contract_version) <> ''),
  evaluator_version           text not null check (btrim(evaluator_version) <> ''),
  status                      text not null check (status in ('passed','failed')),
  move_adherence_rate         numeric(7,6) not null check (move_adherence_rate between 0 and 1),
  blind_review_pass_rate      numeric(7,6) not null check (blind_review_pass_rate between 0 and 1),
  tour_gate_adherence_rate    numeric(7,6) not null check (tour_gate_adherence_rate between 0 and 1),
  detail_adherence_rate       numeric(7,6) not null check (detail_adherence_rate between 0 and 1),
  question_rule_adherence_rate numeric(7,6) not null check (question_rule_adherence_rate between 0 and 1),
  unsupported_fact_count      integer not null check (unsupported_fact_count >= 0),
  safety_violation_count      integer not null check (safety_violation_count >= 0),
  shared_rule_violation_count integer not null check (shared_rule_violation_count >= 0),
  expected_move_coverage      jsonb not null check (jsonb_typeof(expected_move_coverage) = 'object'),
  details                     jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  completed_at                timestamptz not null,
  recorded_at                 timestamptz not null default now(),
  unique (strategy_version_id, generation_surface, corpus_digest, model, prompt_revision, evaluator_version),
  check (completed_at <= recorded_at + interval '5 minutes'),
  check (
    status <> 'passed'
    or (
      scenario_count >= 50
      and move_adherence_rate >= 0.85
      and blind_review_pass_rate >= 0.70
      and tour_gate_adherence_rate >= 0.90
      and detail_adherence_rate >= 0.90
      and question_rule_adherence_rate >= 0.90
      and unsupported_fact_count = 0
      and safety_violation_count = 0
      and shared_rule_violation_count = 0
    )
  )
);

create or replace function prevent_ai_leasing_validation_rewrite()
returns trigger language plpgsql as $$
begin
  raise exception 'AI leasing strategy validation artifacts are immutable.';
end;
$$;

drop trigger if exists trg_ai_leasing_validation_immutable on ai_leasing_strategy_validation_runs;
create trigger trg_ai_leasing_validation_immutable
before update or delete on ai_leasing_strategy_validation_runs
for each row execute function prevent_ai_leasing_validation_rewrite();

create or replace function validate_ai_strategy_after_replay()
returns trigger language plpgsql as $$
begin
  if new.status = 'passed' then
    update ai_leasing_strategy_versions
       set status = 'validated', effective_at = coalesce(effective_at, new.completed_at)
     where id = new.strategy_version_id and status = 'draft';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ai_strategy_validate_after_replay on ai_leasing_strategy_validation_runs;
create trigger trg_ai_strategy_validate_after_replay
after insert on ai_leasing_strategy_validation_runs
for each row execute function validate_ai_strategy_after_replay();

create table if not exists property_ai_leasing_strategy_deployments (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references properties(id) on delete cascade,
  strategy_profile_id      uuid not null references ai_leasing_strategy_profiles(id) on delete restrict,
  strategy_version_id      uuid not null,
  status                   text not null default 'configured' check (status in ('configured','active','paused','retired')),
  traffic_weight           integer not null default 0 check (traffic_weight between 0 and 10000),
  eligible_sources         text[],
  cohort_key               text not null default 'all_eligible_leads' check (btrim(cohort_key) <> ''),
  activated_at             timestamptz,
  paused_at                timestamptz,
  retired_at               timestamptz,
  created_at               timestamptz not null default now(),
  created_by_user_id       uuid references users(id) on delete set null,
  unique (property_id, strategy_version_id),
  unique (id, property_id, strategy_profile_id, strategy_version_id),
  foreign key (strategy_version_id, strategy_profile_id)
    references ai_leasing_strategy_versions(id, strategy_profile_id) on delete restrict,
  check (eligible_sources is null or cardinality(eligible_sources) > 0),
  check (status <> 'active' or (traffic_weight > 0 and activated_at is not null and retired_at is null)),
  check (status <> 'paused' or paused_at is not null),
  check (status <> 'retired' or retired_at is not null)
);

create unique index if not exists uq_property_ai_strategy_active_profile
  on property_ai_leasing_strategy_deployments(property_id, strategy_profile_id)
  where status = 'active';
create index if not exists idx_property_ai_strategy_active
  on property_ai_leasing_strategy_deployments(property_id, status)
  where status = 'active';

create or replace function require_validated_ai_strategy_deployment()
returns trigger language plpgsql as $$
declare v_status text;
begin
  if new.status <> 'active' then return new; end if;
  select status into v_status from ai_leasing_strategy_versions where id = new.strategy_version_id;
  if v_status is distinct from 'validated' then
    raise exception 'AI leasing strategy version is not behaviorally validated.';
  end if;
  if (select count(distinct generation_surface)
        from ai_leasing_strategy_validation_runs
       where strategy_version_id = new.strategy_version_id and status = 'passed') <> 3 then
    raise exception 'AI leasing strategy must pass first-response, ongoing-reply, and regenerated-reply validation.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_require_validated_ai_strategy_deployment on property_ai_leasing_strategy_deployments;
create trigger trg_require_validated_ai_strategy_deployment
before insert or update on property_ai_leasing_strategy_deployments
for each row execute function require_validated_ai_strategy_deployment();

-- Composite walls for opportunity-scoped strategy assignment.
create unique index if not exists uq_conversations_id_property_person
  on conversations(id, property_id, person_id);
create unique index if not exists uq_leasing_leads_id_property_person
  on leasing_leads(id, property_id, person_id);
create unique index if not exists uq_comm_events_id_conversation_property
  on comm_events(id, conversation_id, property_id);

create table if not exists conversation_ai_leasing_strategy_events (
  id                            uuid primary key default gen_random_uuid(),
  conversation_id               uuid not null,
  leasing_lead_id               uuid not null,
  person_id                     uuid not null,
  property_id                   uuid not null,
  event_sequence                integer not null check (event_sequence > 0),
  event_type                    text not null check (event_type in ('assigned','handed_off','unassigned')),
  deployment_id                 uuid,
  strategy_profile_id           uuid,
  strategy_version_id           uuid,
  previous_strategy_profile_id  uuid,
  previous_strategy_version_id  uuid,
  assignment_basis              text not null check (btrim(assignment_basis) <> ''),
  assignment_key_hash           text,
  allocation_snapshot           jsonb,
  assignment_policy_fingerprint text,
  source_context                text,
  cohort_key                    text not null check (btrim(cohort_key) <> ''),
  reason                        text,
  actor_user_id                 uuid references users(id) on delete set null,
  idempotency_key               text not null check (btrim(idempotency_key) <> ''),
  occurred_at                   timestamptz not null default now(),
  recorded_at                   timestamptz not null default now(),
  unique (leasing_lead_id, event_sequence),
  unique (leasing_lead_id, idempotency_key),
  unique (id, leasing_lead_id),
  unique (id, leasing_lead_id, conversation_id, property_id, strategy_profile_id, strategy_version_id),
  foreign key (conversation_id, property_id, person_id)
    references conversations(id, property_id, person_id) on delete restrict,
  foreign key (leasing_lead_id, property_id, person_id)
    references leasing_leads(id, property_id, person_id) on delete restrict,
  foreign key (deployment_id, property_id, strategy_profile_id, strategy_version_id)
    references property_ai_leasing_strategy_deployments(id, property_id, strategy_profile_id, strategy_version_id)
    on delete restrict,
  foreign key (strategy_version_id, strategy_profile_id)
    references ai_leasing_strategy_versions(id, strategy_profile_id) on delete restrict,
  foreign key (previous_strategy_version_id, previous_strategy_profile_id)
    references ai_leasing_strategy_versions(id, strategy_profile_id) on delete restrict,
  check (allocation_snapshot is null or jsonb_typeof(allocation_snapshot) = 'object'),
  check (assignment_key_hash is null or assignment_key_hash ~ '^[0-9a-f]{64}$'),
  check (assignment_policy_fingerprint is null or assignment_policy_fingerprint ~ '^[0-9a-f]{64}$'),
  check (occurred_at <= recorded_at + interval '5 minutes'),
  check (
    (event_type in ('assigned','handed_off') and deployment_id is not null
      and strategy_profile_id is not null and strategy_version_id is not null
      and assignment_policy_fingerprint is not null)
    or
    (event_type = 'unassigned' and deployment_id is null
      and strategy_profile_id is null and strategy_version_id is null
      and assignment_policy_fingerprint is null)
  ),
  check (event_type <> 'assigned' or (assignment_key_hash is not null and allocation_snapshot is not null)),
  check (event_type = 'assigned' or (assignment_key_hash is null and allocation_snapshot is null)),
  check (event_type <> 'handed_off' or (reason is not null and actor_user_id is not null)),
  check (event_type <> 'handed_off' or (previous_strategy_profile_id is not null and previous_strategy_version_id is not null)),
  check (event_type = 'handed_off' or (previous_strategy_profile_id is null and previous_strategy_version_id is null)),
  check ((previous_strategy_profile_id is null) = (previous_strategy_version_id is null))
);

create index if not exists idx_leasing_lead_ai_strategy_events_latest
  on conversation_ai_leasing_strategy_events(leasing_lead_id, event_sequence desc);

create or replace view leasing_lead_ai_strategy_current as
with ranked as (
  select e.*, row_number() over (
    partition by e.leasing_lead_id order by e.event_sequence desc, e.id desc
  ) as rn
  from conversation_ai_leasing_strategy_events e
)
select id as assignment_event_id, leasing_lead_id, conversation_id, person_id,
       property_id, deployment_id, strategy_profile_id, strategy_version_id,
       assignment_basis, assignment_policy_fingerprint, source_context,
       cohort_key, occurred_at as assigned_at
  from ranked
 where rn = 1 and event_type in ('assigned','handed_off');

create or replace view leasing_lead_ai_strategy_intervals as
with sequenced as (
  select e.*, lead(e.occurred_at) over (
    partition by e.leasing_lead_id order by e.event_sequence asc, e.id asc
  ) as valid_until
  from conversation_ai_leasing_strategy_events e
)
select id as assignment_event_id, leasing_lead_id, conversation_id, person_id,
       property_id, deployment_id, strategy_profile_id, strategy_version_id,
       assignment_basis, assignment_policy_fingerprint, source_context,
       cohort_key, occurred_at as valid_from, valid_until
  from sequenced
 where event_type in ('assigned','handed_off');

alter table agent_runs add column if not exists ai_leasing_strategy_assignment_event_id uuid;
alter table agent_runs add column if not exists ai_leasing_strategy_leasing_lead_id uuid;
alter table agent_runs add column if not exists ai_leasing_strategy_applied boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname='fk_agent_runs_ai_strategy_opportunity'
      and conrelid='agent_runs'::regclass
  ) then
    alter table agent_runs add constraint fk_agent_runs_ai_strategy_opportunity
      foreign key (ai_leasing_strategy_assignment_event_id, ai_leasing_strategy_leasing_lead_id)
      references conversation_ai_leasing_strategy_events(id, leasing_lead_id) on delete set null;
  end if;
end $$;

create table if not exists ai_leasing_message_attributions (
  id                    uuid primary key default gen_random_uuid(),
  comm_event_id         uuid not null unique,
  conversation_id       uuid not null,
  leasing_lead_id       uuid not null,
  property_id           uuid not null,
  assignment_event_id   uuid not null,
  strategy_profile_id   uuid not null,
  strategy_version_id   uuid not null,
  agent_run_id           uuid references agent_runs(id) on delete set null,
  attribution_basis     text not null default 'strategy_applied_at_generation'
                          check (attribution_basis='strategy_applied_at_generation'),
  authorship_scope      text not null default 'full_message'
                          check (authorship_scope in ('full_message','ai_draft_source')),
  human_modified        boolean not null default false,
  authored_at           timestamptz not null,
  recorded_at           timestamptz not null default now(),
  foreign key (comm_event_id, conversation_id, property_id)
    references comm_events(id, conversation_id, property_id) on delete restrict,
  foreign key (assignment_event_id, leasing_lead_id, conversation_id, property_id,
               strategy_profile_id, strategy_version_id)
    references conversation_ai_leasing_strategy_events(
      id, leasing_lead_id, conversation_id, property_id, strategy_profile_id, strategy_version_id
    ) on delete restrict,
  foreign key (strategy_version_id, strategy_profile_id)
    references ai_leasing_strategy_versions(id, strategy_profile_id) on delete restrict,
  check (authored_at <= recorded_at + interval '5 minutes'),
  check ((authorship_scope='ai_draft_source') = human_modified)
);

create index if not exists idx_ai_leasing_message_strategy
  on ai_leasing_message_attributions(property_id, strategy_version_id, authored_at);
create index if not exists idx_ai_leasing_message_opportunity
  on ai_leasing_message_attributions(leasing_lead_id, authored_at);

create or replace function prevent_ai_leasing_message_attribution_rewrite()
returns trigger language plpgsql as $$
begin
  raise exception 'AI leasing message attribution is append-only.';
end;
$$;

drop trigger if exists trg_ai_leasing_message_attribution_immutable on ai_leasing_message_attributions;
create trigger trg_ai_leasing_message_attribution_immutable
before update or delete on ai_leasing_message_attributions
for each row execute function prevent_ai_leasing_message_attribution_rewrite();

-- Direct opportunity lineage for downstream application evidence. Historical or
-- internal applications may remain null and therefore cannot be credited to a
-- strategy. New canonical creation paths must write and verify this id.
alter table application_invitations add column if not exists leasing_lead_id uuid;
alter table lease_applications add column if not exists leasing_lead_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname='fk_application_invitation_leasing_lead'
      and conrelid='application_invitations'::regclass
  ) then
    alter table application_invitations add constraint fk_application_invitation_leasing_lead
      foreign key (leasing_lead_id, property_id, person_id)
      references leasing_leads(id, property_id, person_id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint where conname='fk_lease_application_leasing_lead'
      and conrelid='lease_applications'::regclass
  ) then
    alter table lease_applications add constraint fk_lease_application_leasing_lead
      foreign key (leasing_lead_id, property_id, person_id)
      references leasing_leads(id, property_id, person_id) on delete restrict;
  end if;
end $$;

create index if not exists idx_application_invitations_leasing_lead
  on application_invitations(leasing_lead_id) where leasing_lead_id is not null;
create index if not exists idx_lease_applications_leasing_lead
  on lease_applications(leasing_lead_id) where leasing_lead_id is not null;

-- Seed three V2 drafts. They are intentionally NOT validated and cannot be
-- activated until a real replay artifact passes the structural gate above.
insert into ai_leasing_strategy_profiles
  (strategy_key, interface_name, interface_title, description, status)
values
  ('maya','Maya','The Guide','Patient discovery for prospects still narrowing what matters.','active'),
  ('james','James','The Closer','Efficient progression for prospects already showing concrete intent.','active'),
  ('claire','Claire','The Advisor','Structured resolution for prospects comparing material details.','active')
on conflict (strategy_key) do nothing;

insert into ai_leasing_strategy_versions
  (strategy_profile_id, version_number, behavior_policy, prompt_contract_version, status)
select p.id, 2, v.policy::jsonb, 'ai_leasing_strategy_v2', 'draft'
from ai_leasing_strategy_profiles p
join (values
  ('maya','{
    "voice":{"tone":"warm, patient, observant","message_length":"brief, leaving room to respond"},
    "operating_moves":{
      "default_next_move":"discover_one_preference",
      "high_intent_next_move":"confirm_fit_then_offer_tour",
      "hesitation_next_move":"lower_commitment",
      "tour_offer_gate":"value_delivered",
      "follow_up_next_move":"gentle_context_reminder",
      "detail_depth":"one_relevant_detail",
      "question_rule":"one_open_preference"
    },
    "handoff_rule":"Hand off policy, pricing, authority, safety, or unresolved factual uncertainty."
  }'),
  ('james','{
    "voice":{"tone":"clear, confident, efficient","message_length":"short and direct"},
    "operating_moves":{
      "default_next_move":"advance_smallest_decision",
      "high_intent_next_move":"offer_tour_now",
      "hesitation_next_move":"isolate_blocker",
      "tour_offer_gate":"clear_intent",
      "follow_up_next_move":"single_action_prompt",
      "detail_depth":"minimum_to_advance",
      "question_rule":"only_blocking_question"
    },
    "handoff_rule":"Hand off exceptions, ambiguity, policy, pricing, authority, or unsupported commitments."
  }'),
  ('claire','{
    "voice":{"tone":"calm, precise, structured","message_length":"complete but not verbose"},
    "operating_moves":{
      "default_next_move":"resolve_material_questions",
      "high_intent_next_move":"confirm_constraints_then_offer_tour",
      "hesitation_next_move":"separate_tradeoffs",
      "tour_offer_gate":"material_questions_resolved",
      "follow_up_next_move":"open_items_summary",
      "detail_depth":"structured_complete",
      "question_rule":"one_precision_question"
    },
    "handoff_rule":"Hand off whenever detail exceeds governed evidence or requires human judgment."
  }')
) as v(strategy_key, policy) on v.strategy_key=p.strategy_key
on conflict (strategy_profile_id, version_number) do nothing;

comment on table ai_leasing_strategy_validation_runs is
  'Immutable replay evidence required before a strategy version can be deployed.';
comment on table conversation_ai_leasing_strategy_events is
  'Append-only opportunity-scoped strategy assignment. Conversation continuity does not collapse repeated leasing opportunities.';
comment on table ai_leasing_message_attributions is
  'Exact strategy authorship for one outbound message and one leasing opportunity; deterministic fallbacks receive no strategy credit.';
