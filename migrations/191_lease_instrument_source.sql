-- 191 - A SIGNED LEASE PACKET NAMES THE EXACT SOURCE AND TERMS
--
-- Migration 184 allowed a configured hash to identify a governing instrument.
-- A hash in configuration alone does not prove that Spine retained or showed
-- the bytes. This migration binds execution to the retained source artifact,
-- the exact deal-terms schedule, and a deterministic package manifest.

do $$
begin
  if (select count(*) from schema_migrations where version in ('153','184','186')) <> 3 then
    raise exception 'migration 191 requires 153 (source artifacts), 184 (lease execution), and 186 (property lease config)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
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
    'contracted_service_accounting_report','contracted_service_other',
    'lease_template'
  ));

alter table lease_packets
  add column if not exists instrument_source_artifact_id uuid references source_artifacts(id) on delete restrict,
  add column if not exists instrument_terms_sha256 text,
  add column if not exists instrument_package_sha256 text,
  add column if not exists instrument_manifest jsonb,
  add column if not exists instrument_text_snapshot text;

alter table lease_packet_documents
  add column if not exists source_artifact_id uuid references source_artifacts(id) on delete restrict;

comment on column lease_packets.instrument_source_artifact_id is
  'The retained property-scoped lease template whose exact bytes were presented to the signers.';
comment on column lease_packets.instrument_terms_sha256 is
  'SHA-256 of the deterministic deal-terms schedule presented with the governing form.';
comment on column lease_packets.instrument_package_sha256 is
  'SHA-256 of the canonical manifest binding the form identity, retained bytes, and exact deal terms.';
comment on column lease_packets.instrument_text_snapshot is
  'Text extracted from the retained lease source at packet generation for the resident review surface. The retained source bytes remain authoritative.';

create or replace function assert_lease_packet_execution()
returns trigger
language plpgsql
as $$
begin
  if new.status not in ('resident_executed', 'executed') then
    return new;
  end if;

  if new.is_placeholder then
    raise exception 'lease packet % is a placeholder and cannot be executed', new.id
      using errcode = 'check_violation',
            hint = 'A placeholder has no governing instrument. Establish the real lease body first.';
  end if;

  if new.instrument_source_artifact_id is null
     or new.instrument_body_sha256 is null or length(btrim(new.instrument_body_sha256)) = 0
     or new.instrument_terms_sha256 is null or length(btrim(new.instrument_terms_sha256)) = 0
     or new.instrument_package_sha256 is null or length(btrim(new.instrument_package_sha256)) = 0
     or new.instrument_manifest is null then
    raise exception 'lease packet % does not identify a complete retained lease package', new.id
      using errcode = 'check_violation',
            hint = 'Execution requires the retained source, source hash, terms hash, package hash, and manifest.';
  end if;

  if new.status = 'executed'
     and (old.status is distinct from 'resident_executed')
     and new.resident_executed_at is null then
    raise exception 'lease packet % cannot be company-executed before the resident has executed it', new.id
      using errcode = 'check_violation',
            hint = 'The resident signs first. The company signature is the final approval wall.';
  end if;

  return new;
end $$;

drop trigger if exists trg_lease_packet_execution_guard on lease_packets;
create trigger trg_lease_packet_execution_guard
  before insert or update of status, is_placeholder, instrument_source_artifact_id,
    instrument_body_sha256, instrument_terms_sha256, instrument_package_sha256,
    instrument_manifest
  on lease_packets
  for each row execute function assert_lease_packet_execution();

comment on function assert_lease_packet_execution() is
  'Execution requires a retained governing source and a deterministic package binding that source to the presented deal terms. The company signs after the resident. Migration 191.';

-- The execution service records the package hash, not merely the source-file
-- hash. Enforce that equality where a future writer or repair script cannot
-- route around it.
create or replace function assert_spine_execution_package_identity()
returns trigger
language plpgsql
as $$
declare
  expected_package_sha256 text;
begin
  if new.verification_basis <> 'spine_instrument' then
    return new;
  end if;

  select instrument_package_sha256
    into expected_package_sha256
    from lease_packets
   where id = new.source_lease_packet_id;

  if expected_package_sha256 is null
     or length(btrim(expected_package_sha256)) = 0 then
    raise exception 'source lease packet % does not identify a complete package', new.source_lease_packet_id
      using errcode = 'check_violation',
            hint = 'An in-Spine execution must point to a packet with a retained source and package hash.';
  end if;

  if lower(btrim(new.document_sha256)) <> lower(btrim(expected_package_sha256)) then
    raise exception 'executed lease hash does not match source lease packet % package hash', new.source_lease_packet_id
      using errcode = 'check_violation',
            hint = 'Store the package hash that binds the retained lease source to the signed deal terms.';
  end if;

  return new;
end $$;

drop trigger if exists trg_spine_execution_package_identity on executed_lease_records;
create trigger trg_spine_execution_package_identity
  before insert or update of verification_basis, source_lease_packet_id, document_sha256
  on executed_lease_records
  for each row execute function assert_spine_execution_package_identity();

comment on function assert_spine_execution_package_identity() is
  'An in-Spine executed-lease record must carry the exact package hash on its source lease packet. Migration 191.';
