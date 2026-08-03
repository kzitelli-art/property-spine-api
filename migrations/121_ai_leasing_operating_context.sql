-- ════════════════════════════════════════════════════════════════════
-- 121 — GOVERNED OPERATING CONTEXT · LEASING CONSUMER
--
-- First leasing implementation of the governed operating-context primitive.
-- Adds policies, SOPs, and guardrails beside the existing agent_facts knowledge rail.
--
-- This migration creates no rules, activates no strategy, and changes no traffic.
-- Existing agent_facts remains the one building-knowledge source.
-- ════════════════════════════════════════════════════════════════════

create table if not exists ai_leasing_operating_rules (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references properties(id) on delete cascade,
  rule_key             text not null check (rule_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  rule_kind            text not null check (rule_kind in ('policy','sop','guardrail')),
  title                text not null check (btrim(title) <> '' and char_length(title) <= 160),
  instruction_text     text not null check (btrim(instruction_text) <> '' and char_length(instruction_text) <= 6000),
  trigger_text         text check (trigger_text is null or (btrim(trigger_text) <> '' and char_length(trigger_text) <= 2000)),
  steps                jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  escalation_text      text check (escalation_text is null or (btrim(escalation_text) <> '' and char_length(escalation_text) <= 2000)),
  source_type          text not null check (source_type in (
                         'management_policy','lease_or_addendum',
                         'verified_operator_confirmation','other_documented_source'
                       )),
  source_note          text check (source_note is null or char_length(source_note) <= 1000),
  confirmed_at         timestamptz not null,
  effective_until      timestamptz,
  status               text not null default 'active' check (status in ('active','retired')),
  supersedes_rule_id   uuid,
  approved_by_user_id  uuid not null references users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  retired_at           timestamptz,
  -- RETIREMENT AUDIT (mandatory correction #2). Content review flagged that the
  -- candidate recorded who approved a rule but not who retired it. A retirement
  -- is a governance decision as consequential as the create; it gets the same
  -- actor discipline. retirement_reason is optional (a replace is often
  -- self-explanatory) but the actor never is.
  retired_by_user_id   uuid references users(id) on delete restrict,
  retirement_reason    text check (retirement_reason is null or char_length(retirement_reason) <= 1000),
  check (effective_until is null or effective_until > confirmed_at),
  check ((status = 'retired') = (retired_at is not null)),
  check ((status = 'retired') = (retired_by_user_id is not null)),
  check (
    (rule_kind = 'sop' and jsonb_array_length(steps) > 0)
    or (rule_kind <> 'sop' and jsonb_array_length(steps) = 0)
  ),
  check (supersedes_rule_id is null or supersedes_rule_id <> id),
  unique (id, property_id),
  foreign key (supersedes_rule_id, property_id)
    references ai_leasing_operating_rules(id, property_id) on delete restrict
);

create unique index if not exists uq_ai_leasing_operating_rule_active
  on ai_leasing_operating_rules(property_id, rule_kind, rule_key)
  where status = 'active';

create index if not exists idx_ai_leasing_operating_rules_active
  on ai_leasing_operating_rules(property_id, rule_kind, created_at desc)
  where status = 'active';

-- Rule content is append-only. A correction retires the old rule and inserts a
-- replacement linked through supersedes_rule_id. The sole allowed in-place
-- transition is active → retired with a retirement timestamp AND actor.
create or replace function protect_ai_leasing_operating_rule_history()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'AI leasing operating rules cannot be deleted; retire the rule.';
  end if;

  if old.property_id is distinct from new.property_id
     or old.rule_key is distinct from new.rule_key
     or old.rule_kind is distinct from new.rule_kind
     or old.title is distinct from new.title
     or old.instruction_text is distinct from new.instruction_text
     or old.trigger_text is distinct from new.trigger_text
     or old.steps is distinct from new.steps
     or old.escalation_text is distinct from new.escalation_text
     or old.source_type is distinct from new.source_type
     or old.source_note is distinct from new.source_note
     or old.confirmed_at is distinct from new.confirmed_at
     or old.effective_until is distinct from new.effective_until
     or old.supersedes_rule_id is distinct from new.supersedes_rule_id
     or old.approved_by_user_id is distinct from new.approved_by_user_id
     or old.created_at is distinct from new.created_at then
    raise exception 'AI leasing operating rule content is immutable; create a replacement.';
  end if;

  if old.status = 'active' and new.status = 'retired'
     and new.retired_at is not null and new.retired_by_user_id is not null then
    return new;
  end if;

  if old.status is not distinct from new.status
     and old.retired_at is not distinct from new.retired_at
     and old.retired_by_user_id is not distinct from new.retired_by_user_id
     and old.retirement_reason is not distinct from new.retirement_reason then
    return new;
  end if;

  raise exception 'Invalid AI leasing operating rule state transition.';
end;
$$;

drop trigger if exists trg_ai_leasing_operating_rule_history on ai_leasing_operating_rules;
create trigger trg_ai_leasing_operating_rule_history
before update or delete on ai_leasing_operating_rules
for each row execute function protect_ai_leasing_operating_rule_history();

-- REPLACEMENT IDENTITY LOCK (mandatory correction #3), enforced structurally,
-- not merely by service discipline. A "replacement" that swaps rule_kind or
-- rule_key is not a replacement — it is an unrelated new rule wearing the
-- lineage of the one it claims to supersede. The service must also enforce
-- this (defense is not delegated to the database alone), but a caller who
-- bypasses the service cannot silently break replacement lineage.
create or replace function protect_ai_leasing_operating_rule_lineage()
returns trigger language plpgsql as $$
declare
  prior ai_leasing_operating_rules%rowtype;
begin
  if new.supersedes_rule_id is null then
    return new;
  end if;
  select * into prior from ai_leasing_operating_rules where id = new.supersedes_rule_id;
  if not found then
    raise exception 'supersedes_rule_id % does not exist.', new.supersedes_rule_id;
  end if;
  if prior.status <> 'retired' then
    raise exception 'A replacement may only supersede an already-retired rule.';
  end if;
  if prior.property_id is distinct from new.property_id
     or prior.rule_kind is distinct from new.rule_kind
     or prior.rule_key is distinct from new.rule_key then
    raise exception 'A replacement must preserve the superseded rule''s property, rule_kind, and rule_key. Changing identity is retire + create, not replace.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ai_leasing_operating_rule_lineage on ai_leasing_operating_rules;
create trigger trg_ai_leasing_operating_rule_lineage
before insert on ai_leasing_operating_rules
for each row execute function protect_ai_leasing_operating_rule_lineage();

-- Store the exact shared rule set used to generate a draft. Dispatch re-reads the
-- current rules and refuses stale copy after a rule is replaced or retired.
alter table agent_runs
  add column if not exists ai_operating_context_snapshot_json jsonb not null default '[]'::jsonb,
  add column if not exists ai_operating_context_hash text;

alter table agent_runs drop constraint if exists agent_runs_ai_operating_context_snapshot_array;
alter table agent_runs add constraint agent_runs_ai_operating_context_snapshot_array
  check (jsonb_typeof(ai_operating_context_snapshot_json) = 'array');

alter table agent_runs drop constraint if exists agent_runs_ai_operating_context_hash_format;
alter table agent_runs add constraint agent_runs_ai_operating_context_hash_format
  check (ai_operating_context_hash is null or ai_operating_context_hash ~ '^[0-9a-f]{64}$');

comment on table ai_leasing_operating_rules is
  'Append-only property policies, SOPs, and guardrails for the leasing consumer of Governed Operating Context. Building facts remain in agent_facts.';
comment on column agent_runs.ai_operating_context_snapshot_json is
  'Exact active policy/SOP/guardrail identities and content used for this generation; compared again at dispatch.';
