-- 170_compliance_extended_truth.sql -- Minimal durable Compliance extension.
--
-- 168 established credential periods and finding lifecycles. This migration
-- adds only the truths those shapes cannot represent: a completed inspection
-- result, a governed applicability decision, and identifiers needed to keep
-- equipment certificates and authority findings distinct. It does not create
-- requirement census, standing, assignment, obligation, UI, or agent truth.

alter table compliance_items
  drop constraint if exists compliance_items_item_kind_check;
alter table compliance_items
  add constraint compliance_items_item_kind_check
  check (item_kind in ('credential', 'finding', 'inspection', 'requirement'));

alter table compliance_facts
  drop constraint if exists compliance_facts_fact_type_check;
alter table compliance_facts
  add constraint compliance_facts_fact_type_check
  check (fact_type in
    ('credential_period', 'finding_issued', 'payment_observed',
     'cure_performed', 'authority_disposition', 'inspection_result',
     'requirement_applicability'));

alter table compliance_facts
  add column if not exists credential_subject_identifier text,
  add column if not exists finding_external_reference text,
  add column if not exists payment_reference text,
  add column if not exists inspection_performed_on date,
  add column if not exists inspection_outcome text
    check (inspection_outcome in ('passed', 'passed_with_conditions', 'failed', 'inconclusive')),
  add column if not exists inspection_summary text,
  add column if not exists requirement_decided_on date,
  add column if not exists requirement_applicability text
    check (requirement_applicability in ('applicable', 'exempt', 'not_applicable')),
  add column if not exists requirement_summary text;

alter table compliance_facts drop constraint if exists ck_compliance_fact_typed_shape;
alter table compliance_facts add constraint ck_compliance_fact_typed_shape check (
  (fact_type = 'credential_period'
    and credential_issuing_authority is not null
    and length(btrim(credential_issuing_authority)) > 0
    and credential_external_number is not null
    and length(btrim(credential_external_number)) > 0
    and credential_property_address is not null
    and length(btrim(credential_property_address)) > 0
    and credential_effective_from is not null
    and credential_effective_through is not null
    and finding_issued_on is null and finding_external_reference is null
    and finding_summary is null and payment_observed_on is null
    and payment_amount_cents is null and payment_currency_code is null
    and payment_reference is null and cure_performed_on is null
    and cure_summary is null and authority_decided_on is null
    and authority_disposition is null and authority_summary is null
    and inspection_performed_on is null and inspection_outcome is null
    and inspection_summary is null and requirement_decided_on is null
    and requirement_applicability is null and requirement_summary is null)
  or
  (fact_type = 'finding_issued'
    and finding_issued_on is not null and finding_summary is not null
    and length(btrim(finding_summary)) > 0
    and credential_issuing_authority is null and credential_external_number is null
    and credential_code is null and credential_activity_number is null
    and credential_legal_entity_name is null and credential_property_address is null
    and credential_subject_identifier is null and credential_unit_count is null
    and credential_effective_from is null and credential_effective_through is null
    and payment_observed_on is null and payment_amount_cents is null
    and payment_currency_code is null and payment_reference is null
    and cure_performed_on is null and cure_summary is null
    and authority_decided_on is null and authority_disposition is null
    and authority_summary is null and inspection_performed_on is null
    and inspection_outcome is null and inspection_summary is null
    and requirement_decided_on is null and requirement_applicability is null
    and requirement_summary is null)
  or
  (fact_type = 'payment_observed'
    and payment_observed_on is not null and payment_amount_cents is not null
    and payment_currency_code is not null
    and credential_issuing_authority is null and credential_external_number is null
    and credential_code is null and credential_activity_number is null
    and credential_legal_entity_name is null and credential_property_address is null
    and credential_subject_identifier is null and credential_unit_count is null
    and credential_effective_from is null and credential_effective_through is null
    and finding_issued_on is null and finding_external_reference is null
    and finding_summary is null and cure_performed_on is null and cure_summary is null
    and authority_decided_on is null and authority_disposition is null
    and authority_summary is null and inspection_performed_on is null
    and inspection_outcome is null and inspection_summary is null
    and requirement_decided_on is null and requirement_applicability is null
    and requirement_summary is null)
  or
  (fact_type = 'cure_performed'
    and cure_performed_on is not null and cure_summary is not null
    and length(btrim(cure_summary)) > 0
    and credential_issuing_authority is null and credential_external_number is null
    and credential_code is null and credential_activity_number is null
    and credential_legal_entity_name is null and credential_property_address is null
    and credential_subject_identifier is null and credential_unit_count is null
    and credential_effective_from is null and credential_effective_through is null
    and finding_issued_on is null and finding_external_reference is null
    and finding_summary is null and payment_observed_on is null
    and payment_amount_cents is null and payment_currency_code is null
    and payment_reference is null and authority_decided_on is null
    and authority_disposition is null and authority_summary is null
    and inspection_performed_on is null and inspection_outcome is null
    and inspection_summary is null and requirement_decided_on is null
    and requirement_applicability is null and requirement_summary is null)
  or
  (fact_type = 'authority_disposition'
    and authority_decided_on is not null and authority_disposition is not null
    and authority_summary is not null and length(btrim(authority_summary)) > 0
    and credential_issuing_authority is null and credential_external_number is null
    and credential_code is null and credential_activity_number is null
    and credential_legal_entity_name is null and credential_property_address is null
    and credential_subject_identifier is null and credential_unit_count is null
    and credential_effective_from is null and credential_effective_through is null
    and finding_issued_on is null and finding_external_reference is null
    and finding_summary is null and payment_observed_on is null
    and payment_amount_cents is null and payment_currency_code is null
    and payment_reference is null and cure_performed_on is null and cure_summary is null
    and inspection_performed_on is null and inspection_outcome is null
    and inspection_summary is null and requirement_decided_on is null
    and requirement_applicability is null and requirement_summary is null)
  or
  (fact_type = 'inspection_result'
    and inspection_performed_on is not null and inspection_outcome is not null
    and inspection_summary is not null and length(btrim(inspection_summary)) > 0
    and credential_issuing_authority is null and credential_external_number is null
    and credential_code is null and credential_activity_number is null
    and credential_legal_entity_name is null and credential_property_address is null
    and credential_subject_identifier is null and credential_unit_count is null
    and credential_effective_from is null and credential_effective_through is null
    and finding_issued_on is null and finding_external_reference is null
    and finding_summary is null and payment_observed_on is null
    and payment_amount_cents is null and payment_currency_code is null
    and payment_reference is null and cure_performed_on is null and cure_summary is null
    and authority_decided_on is null and authority_disposition is null
    and authority_summary is null and requirement_decided_on is null
    and requirement_applicability is null and requirement_summary is null)
  or
  (fact_type = 'requirement_applicability'
    and requirement_decided_on is not null and requirement_applicability is not null
    and requirement_summary is not null and length(btrim(requirement_summary)) > 0
    and credential_issuing_authority is null and credential_external_number is null
    and credential_code is null and credential_activity_number is null
    and credential_legal_entity_name is null and credential_property_address is null
    and credential_subject_identifier is null and credential_unit_count is null
    and credential_effective_from is null and credential_effective_through is null
    and finding_issued_on is null and finding_external_reference is null
    and finding_summary is null and payment_observed_on is null
    and payment_amount_cents is null and payment_currency_code is null
    and payment_reference is null and cure_performed_on is null and cure_summary is null
    and authority_decided_on is null and authority_disposition is null
    and authority_summary is null and inspection_performed_on is null
    and inspection_outcome is null and inspection_summary is null)
);

alter table compliance_fact_evidence
  drop constraint if exists compliance_fact_evidence_evidence_role_check;
alter table compliance_fact_evidence
  add constraint compliance_fact_evidence_evidence_role_check
  check (evidence_role in
    ('issuance', 'finding', 'payment', 'cure', 'authority_disposition',
     'inspection', 'applicability', 'supporting'));

create or replace function compliance_fact_chain_guard() returns trigger
language plpgsql as $$
declare
  predecessor compliance_facts%rowtype;
  target_kind text;
  expected_kind text;
begin
  select item_kind into target_kind from compliance_items where id = NEW.item_id;
  if target_kind is null then raise exception 'Compliance item does not exist'; end if;
  expected_kind := case NEW.fact_type
    when 'credential_period' then 'credential'
    when 'inspection_result' then 'inspection'
    when 'requirement_applicability' then 'requirement'
    else 'finding'
  end;
  if target_kind <> expected_kind then
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

create or replace function compliance_evidence_role_guard() returns trigger
language plpgsql as $$
declare
  kind text;
  fact_property uuid;
  artifact_scope_type text;
  artifact_scope_id uuid;
  required_role text;
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
  required_role := case kind
    when 'credential_period' then 'issuance'
    when 'finding_issued' then 'finding'
    when 'payment_observed' then 'payment'
    when 'cure_performed' then 'cure'
    when 'authority_disposition' then 'authority_disposition'
    when 'inspection_result' then 'inspection'
    when 'requirement_applicability' then 'applicability'
  end;
  if NEW.evidence_role <> required_role then
    raise exception 'evidence role % is not competent for fact type %', NEW.evidence_role, kind;
  end if;
  return NEW;
end $$;

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
    when 'inspection_result' then 'inspection'
    when 'requirement_applicability' then 'applicability'
  end;
  if not exists (
    select 1 from compliance_fact_evidence
     where fact_id = NEW.id and evidence_role = required_role
  ) then
    raise exception 'Compliance fact % requires % evidence', NEW.id, required_role;
  end if;
  return null;
end $$;
