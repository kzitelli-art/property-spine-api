-- ============================================================================
--  185 - HOW AN EXECUTED LEASE WAS VERIFIED
--
--  ONE FACT: a verified executed lease records the BASIS of its own
--  verification — a staff attestation of an outside instrument, or Spine's
--  own witnessed execution of an instrument it holds.
--
--  ── WHY THIS IS NARROW ON PURPOSE ──────────────────────────────────
--  088 and `executed_lease_service` are already the ONE canonical
--  executed-lease admission service, and both already say a future
--  in-product signing system lands here:
--
--      "Permanent by design: a paper lease, a DocuSign envelope, or a
--       future in-product signing system all land HERE. A signing provider
--       would feed this evidence model, never create a second
--       lease-execution architecture."
--
--  So the owner is settled and nothing about it is being reopened. There is
--  no second executed-lease service, no alternate tenancy writer, and no
--  broad source-authority framework in this migration.
--
--  The ONLY mismatch is the one the service states about itself:
--
--      "Property Spine signs nothing. An authorized staff member ATTESTS
--       that a governing lease exists."
--
--  That is right when Spine RECEIVES an already-executed outside lease. It
--  is wrong when Spine itself witnessed the resident and the company sign
--  the exact hashed instrument it holds — there is nothing left to attest
--  to, and asking a second human to attest to what Spine just watched is
--  the "verify what I just signed" ceremony the product is removing.
--
--  ── verified_by_user_id IS NOT FAKED, AND IS NOT DROPPED ───────────
--  It stays required. For a staff attestation it is the attestor. For an
--  in-Spine execution it is the AUTHORISED COMPANY SIGNER — the human who
--  performed the consequential act. That is a real person doing a real
--  thing, not an invented attestation. What changes is that the record now
--  says WHICH ACT it was, so the two can never be read as the same claim.
--
--  ── AND A FIRST-PARTY EXECUTION STAYS DISTINGUISHABLE ──────────────
--  `spine_esign` is added to the channel vocabulary rather than hidden
--  under `other`. An imported outside execution and one Spine performed
--  itself carry different evidence and different exposure, and a bucket
--  named `other` would make them the same row to anyone reading later.
--
--  ── LINEAGE IS REQUIRED, NOT OPTIONAL ──────────────────────────────
--  An in-Spine execution must point at the lease_packet it executed, and
--  must carry the document hash. Without both, "Spine witnessed it" is an
--  unfalsifiable claim: the check constraint below makes the basis and its
--  evidence inseparable, so the stronger claim cannot be made with the
--  weaker record.
--
--  Additive. No data is read, written or moved. Existing rows keep the
--  staff-attestation basis, which is what they are.
-- ============================================================================

do $$
begin
  if (select count(*) from schema_migrations where version in ('088','184')) <> 2 then
    raise exception 'migration 185 requires 088 (executed lease evidence) and 184 (governing lease execution)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end $$;

-- ── 1 · THE BASIS ──────────────────────────────────────────────────────────
alter table executed_lease_records
  add column if not exists verification_basis text not null default 'staff_attestation',
  add column if not exists source_lease_packet_id uuid references lease_packets(id) on delete restrict;

alter table executed_lease_records drop constraint if exists ck_elr_verification_basis;
alter table executed_lease_records add constraint ck_elr_verification_basis
  check (verification_basis in ('staff_attestation', 'spine_instrument'));

comment on column executed_lease_records.verification_basis is
  'HOW this execution was verified. staff_attestation: an authorised staff user '
  'attested that an instrument executed elsewhere exists. spine_instrument: Spine '
  'witnessed the resident and the company execute the exact instrument it holds. '
  'verified_by_user_id is a real user in both cases — the attestor, or the '
  'authorised company signer respectively.';

comment on column executed_lease_records.source_lease_packet_id is
  'The lease_packet that was executed. Required for verification_basis = '
  'spine_instrument and forbidden otherwise: an attested outside lease has no '
  'Spine packet, and claiming one would invent lineage.';

-- ── 2 · THE CHANNEL ────────────────────────────────────────────────────────
--  Not hidden under `other`. A first-party execution must remain
--  distinguishable from an imported one.
--  ⚠ THE CONSTRAINT IS NAMED, NOT DEFAULTED. 088 declared it inline as
--  `constraint executed_lease_channel_ck`, so Postgres never generated the
--  `<table>_<column>_check` name. Dropping the guessed name would succeed
--  silently (IF EXISTS), add a second permissive constraint, and leave the
--  real one still rejecting spine_esign — a migration that appears to apply
--  and changes nothing. Caught by inserting a spine_esign row and reading
--  which constraint actually fired.
alter table executed_lease_records drop constraint if exists executed_lease_channel_ck;
alter table executed_lease_records drop constraint if exists executed_lease_records_execution_channel_check;
alter table executed_lease_records add constraint executed_lease_channel_ck
  check (execution_channel in ('paper', 'external_esign', 'spine_esign', 'other'));

-- ── 3 · THE BASIS AND ITS EVIDENCE ARE INSEPARABLE ─────────────────────────
--  Each half of this refuses a different lie:
--    · an in-Spine claim with no packet or no hash — unfalsifiable;
--    · an in-Spine claim on an outside channel — a mislabelled origin;
--    · an attestation carrying a Spine packet — invented lineage.
alter table executed_lease_records drop constraint if exists ck_elr_spine_instrument_lineage;
alter table executed_lease_records add constraint ck_elr_spine_instrument_lineage
  check (
    (verification_basis = 'spine_instrument'
       and source_lease_packet_id is not null
       and document_sha256 is not null
       and length(btrim(document_sha256)) > 0
       and execution_channel = 'spine_esign')
    or
    (verification_basis = 'staff_attestation'
       and source_lease_packet_id is null
       and execution_channel <> 'spine_esign')
  );

--  One executed record per packet. A packet is executed once; a second
--  record for the same packet is a duplicate, not a supersession — and
--  supersession already has its own column (supersedes_record_id).
create unique index if not exists uq_elr_source_lease_packet
  on executed_lease_records (source_lease_packet_id)
  where source_lease_packet_id is not null;

create index if not exists ix_elr_verification_basis
  on executed_lease_records (verification_basis);
