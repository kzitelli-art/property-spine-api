-- Contracted Services canonical truth - frozen pre-numbering proof payload.
--
-- Release authority is migrations/171_contracted_services_canonical_truth.sql.
-- This audit artifact preserves the real-PostgreSQL-proven candidate payload;
-- tests execute the numbered migration, whose payload must remain byte-for-byte
-- identical after the release header.

create table contracted_service_coverage_reviews (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  reviewed_as_of        date not null,
  source_artifact_id    uuid references source_artifacts(id) on delete restrict,
  provenance_note       text,
  reviewed_by_user_id   uuid not null references users(id) on delete restrict,
  recorded_at           timestamptz not null default now(),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  unique (id, property_id)
);
create index contracted_service_coverage_reviews_property
  on contracted_service_coverage_reviews(property_id, reviewed_as_of desc);

create table contracted_service_requirements (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  service_class         text not null check (service_class ~ '^[a-z][a-z0-9_]{1,63}$'),
  service_label         text,
  determination         text not null check (determination in
                           ('contracted_service_required','managed_in_house','not_applicable')),
  basis                 text,
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id) on delete restrict,
  provenance_note       text,
  supersedes_id         uuid,
  revision_reason       text,
  recorded_by_user_id   uuid not null references users(id) on delete restrict,
  recorded_at           timestamptz not null default now(),
  unique (id, property_id, service_class),
  foreign key (supersedes_id, property_id, service_class)
    references contracted_service_requirements(id, property_id, service_class) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null
         or nullif(btrim(basis), '') is not null),
  check (supersedes_id is null or nullif(btrim(revision_reason), '') is not null),
  check (supersedes_id is null or supersedes_id <> id)
);
create unique index contracted_service_requirements_one_successor
  on contracted_service_requirements(supersedes_id) where supersedes_id is not null;
create index contracted_service_requirements_position
  on contracted_service_requirements(property_id, service_class, effective_from);

-- Provider UUID is canonical identity. Normalized name is recognition only
-- and deliberately non-unique.
create table contracted_service_providers (
  id                    uuid primary key default gen_random_uuid(),
  provider_name         text not null check (nullif(btrim(provider_name), '') is not null),
  source_artifact_id    uuid references source_artifacts(id) on delete restrict,
  provenance_note       text,
  created_by_user_id    uuid not null references users(id) on delete restrict,
  created_at            timestamptz not null default now(),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null)
);
create index contracted_service_providers_normalized_name
  on contracted_service_providers(lower(btrim(provider_name)));

create table contracted_service_engagements (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  service_class         text not null check (service_class ~ '^[a-z][a-z0-9_]{1,63}$'),
  service_label         text,
  provider_id           uuid not null references contracted_service_providers(id) on delete restrict,
  engagement_label      text,
  effective_from        date,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id) on delete restrict,
  provenance_note       text,
  created_by_user_id    uuid not null references users(id) on delete restrict,
  created_at            timestamptz not null default now(),
  check (effective_to is null or effective_from is not null),
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  unique (id, property_id)
);
create index contracted_service_engagements_position
  on contracted_service_engagements(property_id, service_class, effective_from);
create index contracted_service_engagements_provider
  on contracted_service_engagements(provider_id, property_id);

create table contracted_service_documents (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  engagement_id         uuid,
  source_artifact_id    uuid not null references source_artifacts(id) on delete restrict,
  document_kind         text not null check (document_kind in
                           ('proposal','agreement','statement_of_work','amendment','addendum',
                            'renewal_notice','termination_notice','invoice',
                            'certificate_of_insurance','service_report','accounting_report','other')),
  execution_state       text not null check (execution_state in
                           ('unverified','unsigned','partially_executed','executed')),
  document_date         date,
  named_effective_date  date,
  filename              text,
  supersedes_id         uuid,
  revision_reason       text,
  provenance_note       text,
  confirmed_by_user_id  uuid not null references users(id) on delete restrict,
  confirmed_at          timestamptz not null default now(),
  foreign key (engagement_id, property_id)
    references contracted_service_engagements(id, property_id) on delete restrict,
  unique (id, property_id),
  foreign key (supersedes_id, property_id)
    references contracted_service_documents(id, property_id) on delete restrict,
  check (supersedes_id is null or nullif(btrim(revision_reason), '') is not null),
  check (supersedes_id is null or supersedes_id <> id)
);
create unique index contracted_service_documents_one_successor
  on contracted_service_documents(supersedes_id) where supersedes_id is not null;
create index contracted_service_documents_engagement
  on contracted_service_documents(property_id, engagement_id, confirmed_at);
create index contracted_service_documents_source
  on contracted_service_documents(source_artifact_id);

create table contracted_service_terms (
  id                          uuid primary key default gen_random_uuid(),
  property_id                 uuid not null references properties(id) on delete restrict,
  engagement_id               uuid not null,
  document_id                 uuid not null,
  term_authority              text not null check (term_authority in
                                 ('offered','governing','observed','asserted')),
  commencement_date           date,
  commencement_trigger        text check (length(commencement_trigger) <= 500
                                 and nullif(btrim(commencement_trigger), '') is not null),
  initial_end_date            date,
  initial_term_months         integer check (initial_term_months > 0),
  term_kind                   text not null check (term_kind in
                                 ('fixed','month_to_month','continues_until_terminated',
                                  'one_time','unknown')),
  automatic_renewal           boolean,
  renewal_period_months       integer check (renewal_period_months > 0),
  notice_days                 integer check (notice_days >= 0),
  continues_until_terminated  boolean not null default false,
  termination_for_convenience boolean,
  source_artifact_id          uuid references source_artifacts(id) on delete restrict,
  provenance_note             text,
  supersedes_id               uuid,
  revision_reason             text,
  recorded_by_user_id         uuid not null references users(id) on delete restrict,
  recorded_at                 timestamptz not null default now(),
  foreign key (engagement_id, property_id)
    references contracted_service_engagements(id, property_id) on delete restrict,
  foreign key (document_id, property_id)
    references contracted_service_documents(id, property_id) on delete restrict,
  unique (id, property_id),
  unique (id, property_id, engagement_id),
  foreign key (supersedes_id, property_id, engagement_id)
    references contracted_service_terms(id, property_id, engagement_id) on delete restrict,
  check (initial_end_date is null or commencement_date is not null),
  check (initial_end_date is null or initial_end_date > commencement_date),
  check ((commencement_trigger is null) = (initial_term_months is null)),
  check (term_kind <> 'fixed'
         or (commencement_date is not null and initial_end_date is not null)
         or (commencement_trigger is not null and initial_term_months is not null)),
  check (automatic_renewal is distinct from true or renewal_period_months is not null),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  check (supersedes_id is null or nullif(btrim(revision_reason), '') is not null),
  check (supersedes_id is null or supersedes_id <> id)
);
create unique index contracted_service_terms_one_successor
  on contracted_service_terms(supersedes_id) where supersedes_id is not null;
create index contracted_service_terms_position
  on contracted_service_terms(property_id, engagement_id, commencement_date, recorded_at);

create table contracted_service_scopes (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  engagement_id         uuid not null,
  term_id               uuid,
  scope_summary         text not null check (nullif(btrim(scope_summary), '') is not null),
  frequency_summary     text,
  exclusions_summary    text,
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id) on delete restrict,
  provenance_note       text,
  supersedes_id         uuid,
  revision_reason       text,
  recorded_by_user_id   uuid not null references users(id) on delete restrict,
  recorded_at           timestamptz not null default now(),
  foreign key (engagement_id, property_id)
    references contracted_service_engagements(id, property_id) on delete restrict,
  foreign key (term_id, property_id, engagement_id)
    references contracted_service_terms(id, property_id, engagement_id) on delete restrict,
  unique (id, property_id),
  unique (id, property_id, engagement_id),
  foreign key (supersedes_id, property_id, engagement_id)
    references contracted_service_scopes(id, property_id, engagement_id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  check (supersedes_id is null or nullif(btrim(revision_reason), '') is not null),
  check (supersedes_id is null or supersedes_id <> id)
);
create unique index contracted_service_scopes_one_successor
  on contracted_service_scopes(supersedes_id) where supersedes_id is not null;
create index contracted_service_scopes_position
  on contracted_service_scopes(property_id, engagement_id, effective_from);

create table contracted_service_locations (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  scope_id              uuid not null,
  location_kind         text not null check (location_kind in
                           ('whole_property','building','common_area','equipment',
                            'unit','space','other')),
  location_label        text not null check (nullif(btrim(location_label), '') is not null),
  unit_id               uuid references units(id) on delete restrict,
  space_id              uuid references spaces(id) on delete restrict,
  effective_from        date not null,
  effective_to          date,
  recorded_by_user_id   uuid not null references users(id) on delete restrict,
  recorded_at           timestamptz not null default now(),
  foreign key (scope_id, property_id)
    references contracted_service_scopes(id, property_id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (location_kind <> 'unit' or unit_id is not null),
  check (location_kind <> 'space' or space_id is not null),
  unique (id, property_id)
);
create index contracted_service_locations_scope
  on contracted_service_locations(property_id, scope_id, effective_from);

create table contracted_service_price_components (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  term_id               uuid not null,
  price_basis           text not null check (price_basis in
                           ('monthly','annual','per_visit','hourly','per_unit',
                            'flat','variable','other')),
  amount_cents          bigint check (amount_cents >= 0),
  currency_code         text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  quantity_basis        text,
  description           text,
  recorded_by_user_id   uuid not null references users(id) on delete restrict,
  recorded_at           timestamptz not null default now(),
  foreign key (term_id, property_id)
    references contracted_service_terms(id, property_id) on delete restrict,
  check (price_basis = 'variable' or amount_cents is not null),
  check (amount_cents is not null or nullif(btrim(description), '') is not null),
  unique (id, property_id)
);
create index contracted_service_price_components_term
  on contracted_service_price_components(property_id, term_id);

create table contracted_service_financial_observations (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  engagement_id         uuid,
  service_class         text check (service_class ~ '^[a-z][a-z0-9_]{1,63}$'),
  service_label         text,
  provider_id           uuid references contracted_service_providers(id) on delete restrict,
  source_artifact_id    uuid not null references source_artifacts(id) on delete restrict,
  observation_kind      text not null check (observation_kind in
                           ('accounting_line','underwriting','budget','invoice',
                            'payment_claim','other')),
  line_label            text,
  period_start          date,
  period_end            date,
  amount_cents          bigint check (amount_cents >= 0),
  currency_code         text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  provenance_note       text,
  supersedes_id         uuid,
  revision_reason       text,
  observed_by_user_id   uuid not null references users(id) on delete restrict,
  observed_at           timestamptz not null default now(),
  foreign key (engagement_id, property_id)
    references contracted_service_engagements(id, property_id) on delete restrict,
  unique (id, property_id),
  foreign key (supersedes_id, property_id)
    references contracted_service_financial_observations(id, property_id) on delete restrict,
  check (period_end is null or period_start is not null),
  check (period_end is null or period_end > period_start),
  check (engagement_id is not null or service_class is not null or provider_id is not null
         or nullif(btrim(line_label), '') is not null),
  check (supersedes_id is null or nullif(btrim(revision_reason), '') is not null),
  check (supersedes_id is null or supersedes_id <> id)
);
create unique index contracted_service_financial_observations_one_successor
  on contracted_service_financial_observations(supersedes_id) where supersedes_id is not null;
create index contracted_service_financial_observations_position
  on contracted_service_financial_observations(property_id, engagement_id, period_end);
create index contracted_service_financial_observations_source
  on contracted_service_financial_observations(source_artifact_id);

create table contracted_service_decision_links (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  engagement_id         uuid not null,
  obligation_id         uuid not null references obligations(id) on delete restrict,
  decision_kind         text not null check (nullif(btrim(decision_kind), '') is not null),
  term_id               uuid,
  linked_by_user_id     uuid not null references users(id) on delete restrict,
  linked_at             timestamptz not null default now(),
  foreign key (engagement_id, property_id)
    references contracted_service_engagements(id, property_id) on delete restrict,
  foreign key (term_id, property_id, engagement_id)
    references contracted_service_terms(id, property_id, engagement_id) on delete restrict,
  unique (id, property_id)
);
create index contracted_service_decision_links_engagement
  on contracted_service_decision_links(property_id, engagement_id, term_id);

-- Corrections retain the effective anchor and cannot branch history.
create or replace function contracted_service_correction_guard() returns trigger
language plpgsql as $$
declare
  prior jsonb;
  incoming jsonb;
begin
  incoming := to_jsonb(new);
  if incoming->>'supersedes_id' is null then return new; end if;
  execute format('select to_jsonb(row_value) from %I row_value where id = $1 for update', tg_table_name)
    into prior using (incoming->>'supersedes_id')::uuid;
  if prior is null then
    raise exception 'superseded Contracted Services fact does not exist';
  end if;
  if (prior->>'property_id')::uuid <> (incoming->>'property_id')::uuid then
    raise exception 'a Contracted Services correction may not cross properties';
  end if;
  if tg_table_name in ('contracted_service_requirements','contracted_service_scopes')
     and (prior->>'effective_from')::date <> (incoming->>'effective_from')::date then
    raise exception 'a Contracted Services correction must retain effective_from';
  end if;
  if tg_table_name = 'contracted_service_documents'
     and (prior->>'source_artifact_id')::uuid <> (incoming->>'source_artifact_id')::uuid then
    raise exception 'a document correction must retain the source artifact';
  end if;
  if tg_table_name = 'contracted_service_terms'
     and ((prior->>'commencement_date') is distinct from (incoming->>'commencement_date')
          or (prior->>'commencement_trigger') is distinct from (incoming->>'commencement_trigger')) then
    raise exception 'a term correction must retain its commencement anchor';
  end if;
  return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'contracted_service_requirements','contracted_service_documents',
    'contracted_service_terms','contracted_service_scopes',
    'contracted_service_financial_observations'
  ] loop
    execute format('create trigger %I before insert on %I '
      'for each row execute function contracted_service_correction_guard()',
      table_name || '_correction_guard', table_name);
  end loop;
end $$;

-- Governing authority requires an executed eligible document for this same
-- engagement. An invoice, proposal, COI, or service report cannot govern.
create or replace function contracted_service_governing_term_guard() returns trigger
language plpgsql as $$
begin
  if new.term_authority <> 'governing' then return new; end if;
  if not exists (
    select 1 from contracted_service_documents d
     where d.id = new.document_id and d.property_id = new.property_id
       and d.engagement_id = new.engagement_id
       and d.execution_state = 'executed'
       and d.document_kind in ('agreement','statement_of_work','amendment','addendum')
  ) then
    raise exception 'governing terms require an executed eligible document for the same engagement';
  end if;
  return new;
end $$;
create trigger contracted_service_governing_term_guard
  before insert on contracted_service_terms
  for each row execute function contracted_service_governing_term_guard();

-- Every property-scoped artifact must be retained for that same property.
create or replace function contracted_service_artifact_scope_guard() returns trigger
language plpgsql as $$
declare
  artifact_scope_type text;
  artifact_scope_id uuid;
begin
  if new.source_artifact_id is null then return new; end if;
  select scope_type, scope_id into artifact_scope_type, artifact_scope_id
    from source_artifacts where id = new.source_artifact_id;
  if artifact_scope_type is distinct from 'property'
     or artifact_scope_id is distinct from new.property_id then
    raise exception 'Contracted Services evidence must be retained for the same property';
  end if;
  return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'contracted_service_coverage_reviews','contracted_service_requirements',
    'contracted_service_engagements','contracted_service_documents',
    'contracted_service_terms','contracted_service_scopes',
    'contracted_service_financial_observations'
  ] loop
    execute format('create trigger %I before insert on %I '
      'for each row execute function contracted_service_artifact_scope_guard()',
      table_name || '_artifact_scope_guard', table_name);
  end loop;
end $$;

create or replace function contracted_service_location_scope_guard() returns trigger
language plpgsql as $$
declare linked_property uuid;
begin
  if new.unit_id is not null then
    select property_id into linked_property from units where id = new.unit_id;
    if linked_property is distinct from new.property_id then
      raise exception 'contracted service location unit must belong to the same property';
    end if;
  end if;
  if new.space_id is not null then
    select u.property_id into linked_property
      from spaces s join units u on u.id = s.unit_id where s.id = new.space_id;
    if linked_property is distinct from new.property_id then
      raise exception 'contracted service location space must belong to the same property';
    end if;
  end if;
  return new;
end $$;
create trigger contracted_service_location_scope_guard
  before insert on contracted_service_locations
  for each row execute function contracted_service_location_scope_guard();

create or replace function contracted_service_decision_scope_guard() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from obligations
                  where id = new.obligation_id and property_id = new.property_id) then
    raise exception 'contract decision obligation must belong to the same property';
  end if;
  return new;
end $$;
create trigger contracted_service_decision_scope_guard
  before insert on contracted_service_decision_links
  for each row execute function contracted_service_decision_scope_guard();

-- Canonical rows are append-only. Corrections are new rows linked through
-- supersedes_id where the concept supports correction.
create or replace function contracted_service_append_only_guard() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; record a new fact or correction instead', tg_table_name;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'contracted_service_coverage_reviews','contracted_service_requirements',
    'contracted_service_providers','contracted_service_engagements',
    'contracted_service_documents','contracted_service_terms',
    'contracted_service_scopes','contracted_service_locations',
    'contracted_service_price_components','contracted_service_financial_observations',
    'contracted_service_decision_links'
  ] loop
    execute format('create trigger %I before update or delete on %I '
      'for each row execute function contracted_service_append_only_guard()',
      table_name || '_append_only_guard', table_name);
  end loop;
end $$;

alter table source_artifacts drop constraint if exists source_artifacts_artifact_kind_check;
alter table source_artifacts add constraint source_artifacts_artifact_kind_check
  check (artifact_kind in (
    'rent_roll','other',
    'insurance_policy','insurance_binder','insurance_invoice','insurance_allocation_schedule',
    'insurance_finance_agreement','insurance_escrow_statement',
    'entity_formation_document','operating_agreement',
    'tax_bill','tax_return','tax_payment_receipt','tax_clearance_certificate',
    'tax_appeal_document','tax_balance_statement','tax_account_statement',
    'tax_escrow_statement','tax_escrow_analysis',
    'utility_statement','utility_service_agreement','utility_addendum',
    'utility_meter_schedule','utility_account_confirmation',
    'contracted_service_proposal','contracted_service_agreement',
    'contracted_service_statement_of_work','contracted_service_amendment',
    'contracted_service_addendum','contracted_service_renewal_notice',
    'contracted_service_termination_notice','contracted_service_invoice',
    'contracted_service_certificate_of_insurance','contracted_service_service_report',
    'contracted_service_accounting_report','contracted_service_other'
  ));
