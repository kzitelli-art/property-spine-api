-- 168_compliance_canonical_truth.sql -- Compliance canonical persistence.
--
-- Compliance persists source-backed institutional truth, not its readings.
-- Standing, attention, requirement coverage, UI state and Ask Spine answers
-- are deliberately absent. External identifiers are fact attributes, not
-- globally unique item keys. migrate.js owns the release transaction.

create table if not exists compliance_items (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references properties(id) on delete restrict,
  item_kind              text not null check (item_kind in ('credential', 'finding')),
  compliance_type        text not null check (length(btrim(compliance_type)) > 0),
  created_by_user_id     uuid not null references users(id) on delete restrict,
  created_at             timestamptz not null default now()
);

create index if not exists idx_compliance_items_property
  on compliance_items (property_id, item_kind, compliance_type, id);

-- One row is one established fact. Every fact type has named columns and a
-- database-enforced shape; there is no arbitrary fact_type + JSON escape hatch.
create table if not exists compliance_facts (
  id                              uuid primary key default gen_random_uuid(),
  item_id                         uuid not null references compliance_items(id) on delete restrict,
  fact_type                       text not null check (fact_type in
                                    ('credential_period', 'finding_issued', 'payment_observed',
                                     'cure_performed', 'authority_disposition')),

  credential_issuing_authority    text,
  credential_external_number     text,
  credential_code                text,
  credential_activity_number     text,
  credential_legal_entity_name   text,
  credential_property_address    text,
  credential_unit_count          integer check (credential_unit_count > 0),
  credential_effective_from      date,
  credential_effective_through   date,

  finding_issued_on               date,
  finding_summary                 text,

  payment_observed_on             date,
  payment_amount_cents            bigint check (payment_amount_cents >= 0),
  payment_currency_code           text check (payment_currency_code ~ '^[A-Z]{3}$'),

  cure_performed_on               date,
  cure_summary                    text,

  authority_decided_on            date,
  authority_disposition           text check (authority_disposition in ('closed', 'remains_open')),
  authority_summary               text,

  supersedes_fact_id              uuid references compliance_facts(id) on delete restrict,
  correction_reason               text,

  -- Both are server-computed SHA-256 values. request_fingerprint binds one
  -- property-scoped idempotency key to one request; establishment_fingerprint
  -- deduplicates the same confirmed truth even under a fresh HTTP retry key.
  request_fingerprint             text not null unique
                                    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  establishment_fingerprint       text not null unique
                                    check (establishment_fingerprint ~ '^[0-9a-f]{64}$'),

  established_by_user_id          uuid not null references users(id) on delete restrict,
  established_at                  timestamptz not null default now(),

  constraint ck_compliance_fact_correction_whole check (
    (supersedes_fact_id is null and correction_reason is null)
    or
    (supersedes_fact_id is not null and correction_reason is not null
      and length(btrim(correction_reason)) > 0)
  ),
  constraint ck_compliance_credential_period_order check (
    credential_effective_from is null or credential_effective_through is null
    or credential_effective_through >= credential_effective_from
  ),
  constraint ck_compliance_fact_typed_shape check (
    (fact_type = 'credential_period'
      and credential_issuing_authority is not null
      and length(btrim(credential_issuing_authority)) > 0
      and credential_external_number is not null
      and length(btrim(credential_external_number)) > 0
      and credential_effective_from is not null
      and credential_effective_through is not null
      and finding_issued_on is null and finding_summary is null
      and payment_observed_on is null and payment_amount_cents is null
      and payment_currency_code is null and cure_performed_on is null
      and cure_summary is null and authority_decided_on is null
      and authority_disposition is null and authority_summary is null)
    or
    (fact_type = 'finding_issued'
      and finding_issued_on is not null and finding_summary is not null
      and length(btrim(finding_summary)) > 0
      and credential_issuing_authority is null and credential_external_number is null
      and credential_code is null and credential_activity_number is null
      and credential_legal_entity_name is null and credential_property_address is null
      and credential_unit_count is null and credential_effective_from is null
      and credential_effective_through is null
      and payment_observed_on is null and payment_amount_cents is null
      and payment_currency_code is null and cure_performed_on is null
      and cure_summary is null and authority_decided_on is null
      and authority_disposition is null and authority_summary is null)
    or
    (fact_type = 'payment_observed'
      and payment_observed_on is not null and payment_amount_cents is not null
      and payment_currency_code is not null
      and credential_issuing_authority is null and credential_external_number is null
      and credential_code is null and credential_activity_number is null
      and credential_legal_entity_name is null and credential_property_address is null
      and credential_unit_count is null and credential_effective_from is null
      and credential_effective_through is null
      and finding_issued_on is null and finding_summary is null
      and cure_performed_on is null and cure_summary is null
      and authority_decided_on is null and authority_disposition is null
      and authority_summary is null)
    or
    (fact_type = 'cure_performed'
      and cure_performed_on is not null and cure_summary is not null
      and length(btrim(cure_summary)) > 0
      and credential_issuing_authority is null and credential_external_number is null
      and credential_code is null and credential_activity_number is null
      and credential_legal_entity_name is null and credential_property_address is null
      and credential_unit_count is null and credential_effective_from is null
      and credential_effective_through is null
      and finding_issued_on is null and finding_summary is null
      and payment_observed_on is null and payment_amount_cents is null
      and payment_currency_code is null and authority_decided_on is null
      and authority_disposition is null and authority_summary is null)
    or
    (fact_type = 'authority_disposition'
      and authority_decided_on is not null and authority_disposition is not null
      and authority_summary is not null and length(btrim(authority_summary)) > 0
      and credential_issuing_authority is null and credential_external_number is null
      and credential_code is null and credential_activity_number is null
      and credential_legal_entity_name is null and credential_property_address is null
      and credential_unit_count is null and credential_effective_from is null
      and credential_effective_through is null
      and finding_issued_on is null and finding_summary is null
      and payment_observed_on is null and payment_amount_cents is null
      and payment_currency_code is null and cure_performed_on is null
      and cure_summary is null)
  )
);

create index if not exists idx_compliance_facts_item_history
  on compliance_facts (item_id, established_at, id);
create unique index if not exists uq_compliance_fact_one_successor
  on compliance_facts (supersedes_fact_id) where supersedes_fact_id is not null;

-- Evidence belongs to the exact fact it is competent to support. An artifact
-- attached somewhere else on the item cannot silently prove this fact.
create table if not exists compliance_fact_evidence (
  id                     uuid primary key default gen_random_uuid(),
  fact_id                uuid not null references compliance_facts(id) on delete restrict,
  source_artifact_id     uuid not null references source_artifacts(id) on delete restrict,
  evidence_role          text not null check (evidence_role in
                           ('issuance', 'finding', 'payment', 'cure',
                            'authority_disposition', 'supporting')),
  label                  text not null check (length(btrim(label)) > 0),
  recorded_at            timestamptz not null default now(),
  constraint uq_compliance_fact_evidence unique (fact_id, source_artifact_id, evidence_role)
);

create index if not exists idx_compliance_evidence_artifact
  on compliance_fact_evidence (source_artifact_id, fact_id);

create or replace function compliance_fact_chain_guard() returns trigger
language plpgsql as $$
declare
  predecessor compliance_facts%rowtype;
  target_kind text;
begin
  select item_kind into target_kind from compliance_items where id = NEW.item_id;
  if target_kind is null then raise exception 'Compliance item does not exist'; end if;
  if (NEW.fact_type = 'credential_period' and target_kind <> 'credential')
     or (NEW.fact_type <> 'credential_period' and target_kind <> 'finding') then
    raise exception 'fact type % is not valid for Compliance item kind %', NEW.fact_type, target_kind;
  end if;
  if NEW.supersedes_fact_id is null then return NEW; end if;
  if NEW.supersedes_fact_id = NEW.id then
    raise exception 'a Compliance fact may not supersede itself';
  end if;

  select * into predecessor from compliance_facts
   where id = NEW.supersedes_fact_id for update;
  if not found then raise exception 'superseded Compliance fact does not exist'; end if;
  if predecessor.item_id <> NEW.item_id or predecessor.fact_type <> NEW.fact_type then
    raise exception 'a correction may not cross Compliance item or fact type';
  end if;
  if NEW.established_at <= predecessor.established_at then
    raise exception 'a correction must be established after its predecessor';
  end if;
  if exists (select 1 from compliance_facts where supersedes_fact_id = predecessor.id) then
    raise exception 'the superseded Compliance fact already has a correction';
  end if;
  return NEW;
end $$;

drop trigger if exists trg_compliance_fact_chain_guard on compliance_facts;
create trigger trg_compliance_fact_chain_guard
  before insert on compliance_facts
  for each row execute function compliance_fact_chain_guard();

create or replace function compliance_evidence_role_guard() returns trigger
language plpgsql as $$
declare
  kind text;
  fact_property uuid;
  artifact_scope_type text;
  artifact_scope_id uuid;
begin
  select f.fact_type, i.property_id into kind, fact_property
    from compliance_facts f join compliance_items i on i.id = f.item_id
   where f.id = NEW.fact_id;
  if kind is null then raise exception 'Compliance evidence fact does not exist'; end if;
  select scope_type, scope_id into artifact_scope_type, artifact_scope_id
    from source_artifacts where id = NEW.source_artifact_id;
  if artifact_scope_type <> 'property' or artifact_scope_id <> fact_property then
    raise exception 'Compliance evidence must belong to the fact item property';
  end if;
  if NEW.evidence_role = 'supporting' then return NEW; end if;
  if (kind = 'credential_period' and NEW.evidence_role <> 'issuance')
     or (kind = 'finding_issued' and NEW.evidence_role <> 'finding')
     or (kind = 'payment_observed' and NEW.evidence_role <> 'payment')
     or (kind = 'cure_performed' and NEW.evidence_role <> 'cure')
     or (kind = 'authority_disposition' and NEW.evidence_role <> 'authority_disposition') then
    raise exception 'evidence role % is not competent for fact type %', NEW.evidence_role, kind;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_compliance_evidence_role_guard on compliance_fact_evidence;
create trigger trg_compliance_evidence_role_guard
  before insert on compliance_fact_evidence
  for each row execute function compliance_evidence_role_guard();

-- Deferred so the writer can insert the fact and its evidence in one transaction.
-- Supporting evidence alone is insufficient; each fact needs its competent role.
create or replace function compliance_fact_requires_evidence() returns trigger
language plpgsql as $$
declare
  required_role text;
begin
  required_role := case NEW.fact_type
    when 'credential_period' then 'issuance'
    when 'finding_issued' then 'finding'
    when 'payment_observed' then 'payment'
    when 'cure_performed' then 'cure'
    when 'authority_disposition' then 'authority_disposition'
  end;
  if not exists (
    select 1 from compliance_fact_evidence
     where fact_id = NEW.id and evidence_role = required_role
  ) then
    raise exception 'Compliance fact % requires % evidence', NEW.id, required_role;
  end if;
  return null;
end $$;

drop trigger if exists trg_compliance_fact_requires_evidence on compliance_facts;
create constraint trigger trg_compliance_fact_requires_evidence
  after insert on compliance_facts
  deferrable initially deferred
  for each row execute function compliance_fact_requires_evidence();

create or replace function compliance_append_only_guard() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; establish a correction instead', TG_TABLE_NAME;
end $$;

drop trigger if exists trg_compliance_items_append_only on compliance_items;
create trigger trg_compliance_items_append_only
  before update or delete on compliance_items
  for each row execute function compliance_append_only_guard();

drop trigger if exists trg_compliance_facts_append_only on compliance_facts;
create trigger trg_compliance_facts_append_only
  before update or delete on compliance_facts
  for each row execute function compliance_append_only_guard();

drop trigger if exists trg_compliance_evidence_append_only on compliance_fact_evidence;
create trigger trg_compliance_evidence_append_only
  before update or delete on compliance_fact_evidence
  for each row execute function compliance_append_only_guard();
