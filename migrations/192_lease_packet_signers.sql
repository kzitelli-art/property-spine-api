-- 192 - EACH LEASE SIGNER GETS THEIR OWN IDENTITY AND SECRET LINK
--
-- A resident and a guarantor are different people performing different acts.
-- One shared resident token cannot prove which one acted, and a guarantor
-- supplied on an application must not be silently minted as a durable Person.
-- This packet-scoped signer record preserves that distinction while every
-- signature remains on the one retained lease package.

do $$
begin
  if not exists (select 1 from schema_migrations where version = '191') then
    raise exception 'migration 192 requires 191 (retained governing lease package)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $$;

create table if not exists lease_packet_signers (
  id                  uuid primary key default gen_random_uuid(),
  lease_packet_id     uuid not null references lease_packets(id) on delete cascade,
  signer_role         text not null check (signer_role in ('tenant','guarantor')),

  -- A signer is scoped to this exact packet. Tenant identity may point to the
  -- durable applicant Person. Guarantor identity deliberately remains a
  -- packet participant until a separate, governed identity process links it.
  display_name        text not null check (length(btrim(display_name)) > 0),
  person_id           uuid references persons(id),
  phone_e164          text,
  email               text,

  -- Raw tokens are returned once and never stored. These columns are the
  -- authority for public packet access after this migration. Legacy tenant
  -- token columns remain readable during rollout and are backfilled here.
  token_hash          text,
  token_expires_at    timestamptz,
  link_issued_at      timestamptz,
  submitted_at        timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (lease_packet_id, signer_role),
  constraint ck_lps_token_complete check (
    (token_hash is null and token_expires_at is null and link_issued_at is null)
    or
    (token_hash is not null and token_expires_at is not null and link_issued_at is not null)
  )
);

create unique index if not exists uq_lease_packet_signers_token
  on lease_packet_signers(token_hash) where token_hash is not null;
create index if not exists ix_lease_packet_signers_packet
  on lease_packet_signers(lease_packet_id, signer_role);

comment on table lease_packet_signers is
  'Packet-scoped parties allowed to review and sign the resident side of one exact lease package. A row is not a durable Person and grants no property authority.';
comment on column lease_packet_signers.token_hash is
  'SHA-256 of this signer''s one-time-returned secret link token. Raw tokens are never stored.';
comment on column lease_packet_signers.person_id is
  'Durable Person identity when already established. A guarantor application contact is never promoted to a Person by this table.';

-- Preserve every already-issued resident link. New code reads the signer row;
-- older code may continue reading lease_packets.tenant_token_* during rollout.
-- The drop makes this migration safely re-runnable after its own freeze guard
-- exists; the trigger is recreated below in the same transaction.
drop trigger if exists trg_lease_packet_signer_mutation_guard on lease_packet_signers;
insert into lease_packet_signers
  (lease_packet_id, signer_role, display_name, person_id,
   phone_e164, email, token_hash, token_expires_at, link_issued_at, submitted_at)
select pk.id, 'tenant', coalesce(nullif(btrim(a.applicant_name),''), 'Resident'),
       a.person_id,
       coalesce(nullif(a.captured->>'phone',''), p.primary_phone_e164, p.phone),
       coalesce(nullif(a.captured->>'email',''), p.email),
       pk.tenant_token_hash, pk.tenant_token_expires_at,
       case when pk.tenant_token_hash is not null then coalesce(pk.sent_at, pk.updated_at) end,
       pk.tenant_submitted_at
  from lease_packets pk
  join lease_applications a on a.id = pk.application_id
  left join persons p on p.id = a.person_id
 where not exists (
   select 1 from lease_packet_signers existing
    where existing.lease_packet_id = pk.id and existing.signer_role = 'tenant'
 )
on conflict (lease_packet_id, signer_role) do nothing;

alter table lease_packet_fields
  add column if not exists signed_by_packet_signer_id uuid references lease_packet_signers(id);

comment on column lease_packet_fields.signed_by_packet_signer_id is
  'The packet-scoped resident or guarantor whose secret link completed this signature. Used when a signer is not and must not be silently minted as a durable Person.';

-- Execution is guarded in the database as well as the service. A packet may
-- not claim resident-side execution while any required tenant/guarantor
-- signature remains open, and it may not claim company execution before the
-- company signature field itself is complete.
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

  if exists (
    select 1 from lease_packet_fields f
     where f.lease_packet_id = new.id
       and f.field_type = 'signature'
       and f.signer_role in ('tenant','guarantor')
       and f.required = true
       and f.completed = false
  ) then
    raise exception 'lease packet % still has an outstanding resident-side signer', new.id
      using errcode = 'check_violation',
            hint = 'Every required resident and guarantor signature must be complete before company execution.';
  end if;

  if exists (
    select 1 from lease_packet_signers s
     where s.lease_packet_id = new.id
       and (s.submitted_at is null or not exists (
         select 1 from lease_packet_fields f
          where f.lease_packet_id = s.lease_packet_id
            and f.field_type = 'signature'
            and f.signer_role = s.signer_role
            and f.required = true
            and f.completed = true
            and f.signed_by_packet_signer_id = s.id
       ))
  ) then
    raise exception 'lease packet % has no submitted signature for every resident-side signer', new.id
      using errcode = 'check_violation',
            hint = 'A missing signer field or missing final submission is missing evidence, not a completed signature.';
  end if;

  if not exists (
    select 1 from lease_packet_fields f
     where f.lease_packet_id = new.id
       and f.field_type = 'signature'
       and f.signer_role = 'tenant'
       and f.completed = true
  ) then
    raise exception 'lease packet % has no completed resident signature', new.id
      using errcode = 'check_violation';
  end if;

  if new.status = 'executed' and not exists (
    select 1 from lease_packet_fields f
     where f.lease_packet_id = new.id
       and f.field_type = 'signature'
       and f.signer_role = 'company'
       and f.completed = true
  ) then
    raise exception 'lease packet % has no completed company signature', new.id
      using errcode = 'check_violation';
  end if;

  if new.status = 'executed'
     and old.status is distinct from 'resident_executed' then
    raise exception 'lease packet % cannot be company-executed before the resident side has executed it', new.id
      using errcode = 'check_violation',
            hint = 'Every required resident-side signer signs first. The company signature is the final approval wall.';
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
  'Execution requires the retained package, every required resident/guarantor signature, and finally the company signature. Migration 192.';

-- The packet status cannot stay trustworthy if its signer identity or field
-- evidence can be rewritten afterward. Draft construction remains editable.
-- Once issued, signer identity and secret-link authority freeze; the only
-- allowed signer-row change is recording that exact signer submitted. Once a
-- packet is issued, field structure freezes and only one-way completion
-- evidence may be added. The sole resident_executed exception is the expected
-- company-signature completion.
create or replace function assert_lease_packet_signer_mutation()
returns trigger
language plpgsql
as $$
declare
  packet_status text;
  packet_id uuid;
begin
  packet_id := case when tg_op = 'DELETE' then old.lease_packet_id else new.lease_packet_id end;
  select status into packet_status from lease_packets where id = packet_id;

  if packet_status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op <> 'UPDATE' then
    raise exception 'lease packet signer identity is frozen after issue'
      using errcode = 'restrict_violation';
  end if;

  if new.id is distinct from old.id
     or new.lease_packet_id is distinct from old.lease_packet_id
     or new.signer_role is distinct from old.signer_role
     or new.display_name is distinct from old.display_name
     or new.person_id is distinct from old.person_id
     or new.phone_e164 is distinct from old.phone_e164
     or new.email is distinct from old.email
     or new.token_hash is distinct from old.token_hash
     or new.token_expires_at is distinct from old.token_expires_at
     or new.link_issued_at is distinct from old.link_issued_at
     or new.created_at is distinct from old.created_at
     or old.submitted_at is not null
     or new.submitted_at is null then
    raise exception 'lease packet signer identity and link authority are frozen after issue'
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

drop trigger if exists trg_lease_packet_signer_mutation_guard on lease_packet_signers;
create trigger trg_lease_packet_signer_mutation_guard
  before insert or update or delete on lease_packet_signers
  for each row execute function assert_lease_packet_signer_mutation();

create or replace function assert_lease_packet_field_mutation()
returns trigger
language plpgsql
as $$
declare
  packet_status text;
  packet_id uuid;
begin
  packet_id := case when tg_op = 'DELETE' then old.lease_packet_id else new.lease_packet_id end;
  select status into packet_status from lease_packets where id = packet_id;

  if packet_status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if packet_status in ('sent', 'in_progress', 'tenant_in_progress')
     and tg_op = 'UPDATE'
     and old.completed = false
     and old.completed_at is null
     and new.completed = true
     and new.completed_at is not null
     and new.id is not distinct from old.id
     and new.lease_packet_id is not distinct from old.lease_packet_id
     and new.field_key is not distinct from old.field_key
     and new.section_key is not distinct from old.section_key
     and new.label is not distinct from old.label
     and new.field_type is not distinct from old.field_type
     and new.signer_role is not distinct from old.signer_role
     and new.required is not distinct from old.required
     and new.clause_hash is not distinct from old.clause_hash
     and new.display_order is not distinct from old.display_order
     and new.created_at is not distinct from old.created_at
     and (
       (old.field_type = 'signature'
        and old.signer_role in ('tenant','guarantor')
        and new.signed_by_packet_signer_id is not null
        and (old.signer_role <> 'tenant' or new.signed_by_person_id is not null)
        and new.signed_by_user_id is not distinct from old.signed_by_user_id)
       or
       (old.field_type <> 'signature'
        and new.signed_by_user_id is not distinct from old.signed_by_user_id
        and new.signed_by_person_id is not distinct from old.signed_by_person_id
        and new.signed_by_packet_signer_id is not distinct from old.signed_by_packet_signer_id)
     ) then
    return new;
  end if;

  if packet_status = 'resident_executed'
     and tg_op = 'UPDATE'
     and old.field_type = 'signature'
     and old.signer_role = 'company'
     and old.completed = false
     and old.completed_at is null
     and old.signed_by_user_id is null
     and new.completed = true
     and new.completed_at is not null
     and new.signed_by_user_id is not null
     and new.id is not distinct from old.id
     and new.lease_packet_id is not distinct from old.lease_packet_id
     and new.field_key is not distinct from old.field_key
     and new.section_key is not distinct from old.section_key
     and new.label is not distinct from old.label
     and new.field_type is not distinct from old.field_type
     and new.signer_role is not distinct from old.signer_role
     and new.required is not distinct from old.required
     and new.clause_hash is not distinct from old.clause_hash
     and new.display_order is not distinct from old.display_order
     and new.created_at is not distinct from old.created_at
     and new.signed_by_person_id is not distinct from old.signed_by_person_id
     and new.signed_by_packet_signer_id is not distinct from old.signed_by_packet_signer_id then
    return new;
  end if;

  raise exception 'lease packet field evidence is frozen at status %', packet_status
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists trg_lease_packet_field_mutation_guard on lease_packet_fields;
create trigger trg_lease_packet_field_mutation_guard
  before insert or update or delete on lease_packet_fields
  for each row execute function assert_lease_packet_field_mutation();

comment on function assert_lease_packet_signer_mutation() is
  'Signer identity and secret-link authority freeze after issue; only first submission time may be added. Migration 192.';
comment on function assert_lease_packet_field_mutation() is
  'Issued packet structure is immutable; only one-way signer completion evidence and the final company signature may be added. Migration 192.';
