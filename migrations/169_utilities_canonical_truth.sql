-- 169_utilities_canonical_truth.sql
--
-- Owner-reserved after refreshing main at ceiling 167. Utilities owns 169.
-- Stale as of this correction: Debt did not keep 168 — Compliance landed
-- there first and Debt was renumbered off it (now 173; see
-- migrations/173_debt_instruments.sql). Numbering this file prepared an
-- order that did not hold; it does not claim this migration has passed its
-- required isolated-PostgreSQL release gate.
--
-- The schema records setup before observations:
--   service -> provider/account/service-point/meter/arrangement -> statement
--
-- No payment table exists here. The repository has no governed provider-bill
-- settlement association, and a resident collection or bank line must never
-- become one by proximity.

create table utility_services (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references properties(id) on delete restrict,
  service_class        text not null check (service_class ~ '^[a-z][a-z0-9_]{1,63}$'),
  service_label        text,
  created_by_user_id   uuid not null references users(id),
  created_at           timestamptz not null default now(),
  unique (property_id, service_class),
  unique (id, property_id)
);

create table utility_service_declarations (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  service_id            uuid not null,
  applicability         text not null check (applicability in ('present','not_applicable')),
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  supersedes_id         uuid,
  revision_reason       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (service_id, property_id)
    references utility_services(id, property_id) on delete restrict,
  unique (id, service_id, property_id),
  foreign key (supersedes_id, service_id, property_id)
    references utility_service_declarations(id, service_id, property_id),
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  check (supersedes_id is null or nullif(btrim(revision_reason), '') is not null),
  check (supersedes_id is null or supersedes_id <> id)
);
create unique index utility_service_declarations_one_successor
  on utility_service_declarations(supersedes_id) where supersedes_id is not null;
create index utility_service_declarations_position
  on utility_service_declarations(property_id, service_id, effective_from);

-- Portfolio provider identity, owned by Utilities and deliberately narrower
-- than either a legal entity or a Money vendor. `provider_name` is the name by
-- which a source identifies the service provider. It does not assert a
-- formation-document legal name, vendor status, payee status, or a payment
-- relationship. Property truth begins in utility_service_providers below.
--
-- This table is portfolio-scoped because PECO does not become a second
-- provider when it supplies another property. The relationship, accounts,
-- service points, meters, statements, and evidence exposed by a property read
-- remain property-scoped.
create table utility_providers (
  id                    uuid primary key default gen_random_uuid(),
  provider_name         text not null check (nullif(btrim(provider_name), '') is not null),
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null)
);
-- A normalized name supports recognition. It is deliberately non-unique:
-- similarly named municipal providers must remain representable as distinct
-- canonical identities until a governed relationship establishes otherwise.
create index utility_providers_normalized_name
  on utility_providers(lower(btrim(provider_name)));

create table utility_service_providers (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  service_id            uuid not null,
  provider_id           uuid not null,
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (service_id, property_id)
    references utility_services(id, property_id) on delete restrict,
  foreign key (provider_id)
    references utility_providers(id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  unique (service_id, provider_id, effective_from),
  unique (id, property_id)
);

create table utility_arrangements (
  id                         uuid primary key default gen_random_uuid(),
  property_id                uuid not null references properties(id) on delete restrict,
  service_id                 uuid not null,
  physical_arrangement       text check (physical_arrangement in
    ('whole_building_master_meter','common_house_meter','individual_provider_meters',
     'internal_submeters','shared_plant','non_metered','mixed','unknown')),
  provider_bill_recipient    text check (provider_bill_recipient in
    ('property','resident','billing_administrator','other_third_party','mixed')),
  provider_responsible_party text check (provider_responsible_party in
    ('property','resident','other_third_party','mixed')),
  economic_responsibility    text check (economic_responsibility in
    ('property','resident','shared','mixed')),
  resident_recovery_method   text check (resident_recovery_method in
    ('none_property_absorbs','included_in_rent','resident_direct_to_provider',
     'fixed_fee','rubs_allocation','actual_submeter_usage','passthrough','mixed','other')),
  billing_administrator_name text,
  resident_payment_recipient text check (resident_payment_recipient in
    ('property','provider','billing_administrator','other_third_party','mixed','not_applicable')),
  effective_from             date not null,
  effective_to               date,
  source_artifact_id         uuid references source_artifacts(id),
  provenance_note            text,
  supersedes_id              uuid,
  revision_reason            text,
  recorded_by_user_id        uuid not null references users(id),
  recorded_at                timestamptz not null default now(),
  foreign key (service_id, property_id)
    references utility_services(id, property_id) on delete restrict,
  unique (id, service_id, property_id),
  foreign key (supersedes_id, service_id, property_id)
    references utility_arrangements(id, service_id, property_id),
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  check (supersedes_id is null or nullif(btrim(revision_reason), '') is not null),
  check (supersedes_id is null or supersedes_id <> id),
  check (resident_payment_recipient <> 'billing_administrator'
         or nullif(btrim(billing_administrator_name), '') is not null)
);
create unique index utility_arrangements_one_successor
  on utility_arrangements(supersedes_id) where supersedes_id is not null;
create index utility_arrangements_position
  on utility_arrangements(property_id, service_id, effective_from);

create table utility_service_points (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  service_id            uuid not null,
  point_kind            text not null check (point_kind in
    ('whole_building','common_area','unit','space','shared_equipment',
     'service_address','other','unknown')),
  location_label        text,
  service_address       text,
  unit_id               uuid references units(id) on delete restrict,
  space_id              uuid references spaces(id) on delete restrict,
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (service_id, property_id)
    references utility_services(id, property_id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  check (point_kind <> 'unit' or unit_id is not null),
  check (point_kind <> 'space' or space_id is not null),
  unique (id, property_id)
);
create index utility_service_points_position
  on utility_service_points(property_id, service_id, effective_from);

create table utility_meters (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  provider_id           uuid,
  meter_kind            text not null check (meter_kind in ('provider_meter','internal_submeter')),
  meter_identifier      text not null check (nullif(btrim(meter_identifier), '') is not null),
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (provider_id)
    references utility_providers(id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  check (meter_kind <> 'provider_meter' or provider_id is not null),
  unique (property_id, meter_kind, meter_identifier, effective_from),
  unique (id, property_id)
);

create table utility_provider_accounts (
  id                          uuid primary key default gen_random_uuid(),
  property_id                 uuid not null references properties(id) on delete restrict,
  provider_id                 uuid not null,
  external_account_identifier text not null check
    (nullif(btrim(external_account_identifier), '') is not null),
  billing_cadence             text,
  service_address             text,
  billing_address             text,
  effective_from              date not null,
  effective_to                date,
  source_artifact_id          uuid references source_artifacts(id),
  provenance_note             text,
  recorded_by_user_id         uuid not null references users(id),
  recorded_at                 timestamptz not null default now(),
  foreign key (provider_id)
    references utility_providers(id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  unique (property_id, provider_id, external_account_identifier),
  unique (id, property_id)
);

create table utility_account_services (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  account_id            uuid not null,
  service_id            uuid not null,
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (account_id, property_id)
    references utility_provider_accounts(id, property_id) on delete restrict,
  foreign key (service_id, property_id)
    references utility_services(id, property_id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  unique (account_id, service_id, effective_from),
  unique (id, property_id)
);

create table utility_meter_service_points (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  meter_id              uuid not null,
  service_point_id      uuid not null,
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (meter_id, property_id)
    references utility_meters(id, property_id) on delete restrict,
  foreign key (service_point_id, property_id)
    references utility_service_points(id, property_id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  unique (meter_id, service_point_id, effective_from),
  unique (id, property_id)
);

create table utility_account_service_points (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  account_id            uuid not null,
  service_point_id      uuid not null,
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (account_id, property_id)
    references utility_provider_accounts(id, property_id) on delete restrict,
  foreign key (service_point_id, property_id)
    references utility_service_points(id, property_id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  unique (account_id, service_point_id, effective_from),
  unique (id, property_id)
);

create table utility_account_meters (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  account_id            uuid not null,
  meter_id              uuid not null,
  effective_from        date not null,
  effective_to          date,
  source_artifact_id    uuid references source_artifacts(id),
  provenance_note       text,
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (account_id, property_id)
    references utility_provider_accounts(id, property_id) on delete restrict,
  foreign key (meter_id, property_id)
    references utility_meters(id, property_id) on delete restrict,
  check (effective_to is null or effective_to > effective_from),
  check (source_artifact_id is not null or nullif(btrim(provenance_note), '') is not null),
  unique (account_id, meter_id, effective_from),
  unique (id, property_id)
);

create table utility_statements (
  id                         uuid primary key default gen_random_uuid(),
  property_id                uuid not null references properties(id) on delete restrict,
  account_id                 uuid not null,
  statement_identifier       text,
  bill_date                  date not null,
  service_period_start       date not null,
  service_period_end         date not null,
  due_date                   date,
  currency_code              text not null check (currency_code ~ '^[A-Z]{3}$'),
  amount_billed_cents        bigint not null check (amount_billed_cents >= 0),
  current_amount_due_cents   bigint check (current_amount_due_cents >= 0),
  late_fee_cents             bigint check (late_fee_cents >= 0),
  source_artifact_id         uuid not null references source_artifacts(id),
  provenance_note            text,
  supersedes_id              uuid,
  revision_reason            text,
  recorded_by_user_id        uuid not null references users(id),
  recorded_at                timestamptz not null default now(),
  foreign key (account_id, property_id)
    references utility_provider_accounts(id, property_id) on delete restrict,
  unique (id, account_id, property_id),
  foreign key (supersedes_id, account_id, property_id)
    references utility_statements(id, account_id, property_id),
  check (service_period_end >= service_period_start),
  check (supersedes_id is null or nullif(btrim(revision_reason), '') is not null),
  check (supersedes_id is null or supersedes_id <> id)
);
create unique index utility_statements_one_successor
  on utility_statements(supersedes_id) where supersedes_id is not null;
create unique index utility_statements_external_identity
  on utility_statements(account_id, statement_identifier)
  where statement_identifier is not null and supersedes_id is null;
create index utility_statements_account_period
  on utility_statements(property_id, account_id, service_period_end desc);

create table utility_statement_usage (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete restrict,
  statement_id          uuid not null,
  account_id            uuid not null,
  service_id            uuid not null,
  meter_id              uuid,
  quantity              numeric(20,6) not null check (quantity >= 0),
  usage_unit            text not null check (nullif(btrim(usage_unit), '') is not null),
  usage_basis           text not null check (usage_basis in ('observed','estimated','stated_unknown')),
  source_artifact_id    uuid not null references source_artifacts(id),
  recorded_by_user_id   uuid not null references users(id),
  recorded_at           timestamptz not null default now(),
  foreign key (statement_id, account_id, property_id)
    references utility_statements(id, account_id, property_id) on delete cascade,
  foreign key (service_id, property_id)
    references utility_services(id, property_id) on delete restrict,
  foreign key (meter_id, property_id)
    references utility_meters(id, property_id) on delete restrict
);

-- An account can cover several services, but only when its provider is also a
-- provider of each service for the overlapping period. This keeps a PECO
-- account from being attached to a water service merely because both records
-- belong to the same property.
create or replace function utility_account_service_provider_guard() returns trigger
language plpgsql as $$
declare
  account_provider_id uuid;
begin
  select provider_id into account_provider_id
    from utility_provider_accounts
   where id = new.account_id and property_id = new.property_id;

  if not exists (
    select 1 from utility_service_providers
     where property_id = new.property_id
       and service_id = new.service_id
       and provider_id = account_provider_id
       and effective_from < coalesce(new.effective_to, 'infinity'::date)
       and coalesce(effective_to, 'infinity'::date) > new.effective_from
  ) then
    raise exception 'utility account provider must supply the mapped service for the effective period';
  end if;
  return new;
end $$;
create trigger utility_account_service_provider_guard
  before insert or update on utility_account_services
  for each row execute function utility_account_service_provider_guard();

-- NOT_APPLICABLE is explicit negative truth, not a display label. A current
-- not-applicable declaration and active service topology cannot both be true
-- over the same dates. Correcting the declaration to present preserves the old
-- row but removes it from the current head set, after which topology may begin.
create or replace function utility_topology_not_applicable_guard() returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from utility_service_declarations d
     where d.property_id = new.property_id
       and d.service_id = new.service_id
       and d.applicability = 'not_applicable'
       and not exists (select 1 from utility_service_declarations successor
                        where successor.supersedes_id = d.id)
       and d.effective_from < coalesce(new.effective_to, 'infinity'::date)
       and coalesce(d.effective_to, 'infinity'::date) > new.effective_from
  ) then
    raise exception 'a not-applicable utility service cannot have active topology';
  end if;
  return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'utility_service_providers', 'utility_arrangements',
    'utility_service_points', 'utility_account_services'
  ] loop
    execute format('create trigger %I before insert or update on %I '
      'for each row execute function utility_topology_not_applicable_guard()',
      table_name || '_not_applicable_guard', table_name);
  end loop;
end $$;

create or replace function utility_declaration_topology_guard() returns trigger
language plpgsql as $$
declare
  topology_exists boolean;
begin
  if new.applicability <> 'not_applicable' then return new; end if;

  select exists (
    select 1 from utility_service_providers t
     where t.property_id = new.property_id and t.service_id = new.service_id
       and t.effective_from < coalesce(new.effective_to, 'infinity'::date)
       and coalesce(t.effective_to, 'infinity'::date) > new.effective_from
    union all
    select 1 from utility_arrangements t
     where t.property_id = new.property_id and t.service_id = new.service_id
       and t.effective_from < coalesce(new.effective_to, 'infinity'::date)
       and coalesce(t.effective_to, 'infinity'::date) > new.effective_from
    union all
    select 1 from utility_service_points t
     where t.property_id = new.property_id and t.service_id = new.service_id
       and t.effective_from < coalesce(new.effective_to, 'infinity'::date)
       and coalesce(t.effective_to, 'infinity'::date) > new.effective_from
    union all
    select 1 from utility_account_services t
     where t.property_id = new.property_id and t.service_id = new.service_id
       and t.effective_from < coalesce(new.effective_to, 'infinity'::date)
       and coalesce(t.effective_to, 'infinity'::date) > new.effective_from
  ) into topology_exists;

  if topology_exists then
    raise exception 'a not-applicable utility service cannot have active topology';
  end if;
  return new;
end $$;
create trigger utility_declaration_topology_guard
  before insert or update on utility_service_declarations
  for each row execute function utility_declaration_topology_guard();

-- Usage belongs to a statement's account map. A statement may carry usage
-- without a meter when that association is not established; when it names a
-- meter, that meter must overlap the account during the service period.
create or replace function utility_statement_usage_map_guard() returns trigger
language plpgsql as $$
declare
  period_start date;
  period_end date;
begin
  select service_period_start, service_period_end into period_start, period_end
    from utility_statements
   where id = new.statement_id and account_id = new.account_id
     and property_id = new.property_id;

  if not exists (
    select 1 from utility_account_services
     where account_id = new.account_id and service_id = new.service_id
       and property_id = new.property_id
       and effective_from <= period_end
       and (effective_to is null or effective_to > period_start)
  ) then
    raise exception 'utility statement service must be mapped to its provider account for the service period';
  end if;

  if new.meter_id is not null and not exists (
    select 1 from utility_account_meters
     where account_id = new.account_id and meter_id = new.meter_id
       and property_id = new.property_id
       and effective_from <= period_end
       and (effective_to is null or effective_to > period_start)
  ) then
    raise exception 'utility statement meter must be mapped to its provider account for the service period';
  end if;
  return new;
end $$;
create trigger utility_statement_usage_map_guard
  before insert or update on utility_statement_usage
  for each row execute function utility_statement_usage_map_guard();

-- Unit/space links must belong to the same property as the service point.
create or replace function utility_service_point_scope_guard() returns trigger
language plpgsql as $$
declare
  linked_property uuid;
begin
  if new.unit_id is not null then
    select property_id into linked_property from units where id = new.unit_id;
    if linked_property is distinct from new.property_id then
      raise exception 'utility service point unit must belong to the same property';
    end if;
  end if;
  if new.space_id is not null then
    select u.property_id into linked_property
      from spaces s join units u on u.id = s.unit_id where s.id = new.space_id;
    if linked_property is distinct from new.property_id then
      raise exception 'utility service point space must belong to the same property';
    end if;
  end if;
  return new;
end $$;
create trigger utility_service_point_scope_guard
  before insert or update on utility_service_points
  for each row execute function utility_service_point_scope_guard();

-- Every cited artifact must be a retained source for this same property.
-- Deal-scoped source authority is intentionally parked until onboarding owns a
-- governed deal-to-property evidence rule; a provenance note remains valid.
create or replace function utility_artifact_scope_guard() returns trigger
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
    raise exception 'utility evidence must be retained for the same property';
  end if;
  return new;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'utility_service_declarations', 'utility_service_providers',
    'utility_arrangements', 'utility_service_points', 'utility_meters',
    'utility_provider_accounts', 'utility_account_services',
    'utility_meter_service_points', 'utility_account_service_points',
    'utility_account_meters', 'utility_statements', 'utility_statement_usage'
  ] loop
    execute format('create trigger %I before insert or update on %I '
      'for each row execute function utility_artifact_scope_guard()',
      table_name || '_artifact_scope', table_name);
  end loop;
end $$;

-- Shared source-kind constraint design. This is part of the eventual migration;
-- the service implementation also needs matching validation kinds in
-- source_artifact_service.js, declared separately as a shared junction.
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
    'utility_meter_schedule','utility_account_confirmation'
  ));
