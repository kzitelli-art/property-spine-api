-- ============================================================================
--  184 - THE GOVERNING INSTRUMENT, AND EXECUTION INSIDE SPINE
--
--  ONE FACT: a lease packet may carry a REAL governing instrument, and may
--  be executed — resident first, then the company — inside Property Spine.
--
--  ── THIS EVOLVES MIGRATION 034. IT DOES NOT REPLACE IT ─────────────
--  034 already built almost all of the mechanism, and built it well:
--
--      packet versioning              unique (application_id, version)
--      rendered_snapshot_hash         the exact bytes that were rendered
--      tenant_token_hash              tokenized resident access, hashed,
--                                     raw token returned once on send
--      lease_packet_fields            initial | signature | acknowledgment
--      session_id / ip_address /      per-field audit evidence
--        user_agent / clause_hash
--      lease_packet_documents         lease_body and city documents
--      lease_packet_audit_events      append-only packet history
--
--  Every one of those is a permanent useful primitive and none is touched
--  here. What made the mechanism non-governing is named in 034's own
--  schema, in one column:
--
--      is_placeholder  boolean not null default true
--        "TRUE until a real lease template fills the body. The tenant UI
--         renders a loud placeholder banner while this is true. Generation
--         refuses to pretend otherwise."
--
--  There was no governing instrument, so there was nothing honest to sign.
--  That is also exactly why `/applications/:id/sign` was retired — its own
--  tombstone reads "There is no signature system today, so there is no
--  honest thing for this route to record." That is a statement about a
--  MISSING CAPABILITY, not a statement that signing belongs outside Spine.
--
--  ── THE THREE LIMITS THIS LIFTS ────────────────────────────────────
--    1  signer_role was `check (signer_role in ('tenant'))` — a company
--       signer could not exist at all.
--    2  status stopped at 'submitted'; 034 said "Activation is not a packet
--       concept", which was right when a packet could not be executed.
--    3  there was no identity for the instrument itself — only a hash of
--       whatever had been rendered, placeholder or not.
--
--  ── WHAT IT REFUSES, AND THIS IS THE POINT ─────────────────────────
--  A PLACEHOLDER CAN NEVER BE EXECUTED. `trg_lease_packet_execution_guard`
--  refuses any move into a resident- or company-executed state while
--  `is_placeholder` is true or the instrument has no identity. The rule
--  lives in Postgres, not in one writer, because more than one path will
--  eventually move a packet and a rule held in one writer is a rule the
--  others do not have.
--
--  That single trigger is what converts 034's honest placeholder into an
--  honest instrument: the mechanism no longer depends on a caller
--  remembering that the body is fake.
--
--  ── WHAT THIS MIGRATION DOES NOT DECIDE ────────────────────────────
--  It does NOT decide what makes an electronic signature legally
--  sufficient. That is a legal/product ruling (see THREAD_HANDOFF "open
--  rulings" R1), and 034 already flagged it — "captured intent metadata
--  (audit, not legal proof — see counsel note)". This migration widens the
--  evidence the mechanism can HOLD; it does not assert that holding it is
--  enough. Nor does it create a lease body, a template, or any legal
--  language: the Skyline form of record is an external input and is not in
--  this repository.
--
--  Additive. No data is read, written or moved.
-- ============================================================================

do $$
begin
  if (select count(*) from schema_migrations where version = '034') <> 1 then
    raise exception 'migration 184 requires migration 034 (lease packets)'
      using errcode = 'object_not_in_prerequisite_state',
            detail = 'This migration evolves the 034 lease-packet mechanism; it does not replace it.';
  end if;
end $$;

-- ── 1 · THE INSTRUMENT'S OWN IDENTITY ──────────────────────────────────────
--  `rendered_snapshot_hash` (034) hashes whatever was rendered — including a
--  placeholder. These columns identify the GOVERNING FORM the body came from,
--  which is a different fact: two packets can render identically and still be
--  built from different revisions of the lease form.
alter table lease_packets
  add column if not exists instrument_form_code     text,
  add column if not exists instrument_form_version  text,
  add column if not exists instrument_body_sha256   text,
  add column if not exists instrument_established_at timestamptz;

comment on column lease_packets.instrument_form_code is
  'The governing lease FORM this packet renders (e.g. the Skyline residential '
  'form). NULL while the packet is a placeholder. Spine never authors lease '
  'language; the form is an external input from the business/legal side.';
comment on column lease_packets.instrument_body_sha256 is
  'SHA-256 of the exact governing body bytes presented to the signers. This is '
  'what a signature is a signature ON. Distinct from rendered_snapshot_hash, '
  'which hashes the rendered packet including placeholder content.';

-- ── 2 · A COMPANY SIGNER MAY EXIST ─────────────────────────────────────────
--  034: `check (signer_role in ('tenant'))`, with the note that guarantor and
--  manager fields were "a later concern". This is that later concern, kept
--  minimal: the roles that actually sign a lease. `guarantor` is admitted
--  because 034's own obligation vocabulary already names guarantor_signature,
--  so leaving it out would force the next build to re-open the same check.
alter table lease_packet_fields drop constraint if exists lease_packet_fields_signer_role_check;
alter table lease_packet_fields add constraint lease_packet_fields_signer_role_check
  check (signer_role in ('tenant', 'guarantor', 'company'));

--  WHO signed, as a durable identity rather than a typed name. 034 captured
--  session/ip/user-agent but not WHICH user — for a tenant-only packet the
--  token implied it. A company signature must name the human.
alter table lease_packet_fields
  add column if not exists signed_by_user_id   uuid references users(id),
  add column if not exists signed_by_person_id uuid references persons(id);

comment on column lease_packet_fields.signed_by_user_id is
  'The authenticated staff user who signed, for signer_role = company. Server-'
  'derived from the session, never a body-supplied name. WHO MAY BIND THE '
  'COMPANY is an open ruling (THREAD_HANDOFF R2) — this column records who '
  'did, it does not decide who may.';

-- ── 3 · EXECUTION STATES ───────────────────────────────────────────────────
--  Appended to 034's lifecycle, never reordered. 'submitted' keeps its exact
--  meaning — all required tenant fields done — and the two new states are what
--  happens after, in the order the business actually performs them.
alter table lease_packets drop constraint if exists lease_packets_status_check;
alter table lease_packets add constraint lease_packets_status_check
  check (status in (
    'draft',
    'sent',
    'tenant_in_progress',
    'submitted',
    'resident_executed',   -- the resident has signed the governing instrument
    'executed',            -- and the authorised company signer has signed it
    'voided'
  ));

alter table lease_packets
  add column if not exists resident_executed_at timestamptz,
  add column if not exists company_executed_at  timestamptz;

-- ── 4 · THE GUARD: A PLACEHOLDER CANNOT BE EXECUTED ────────────────────────
--  The rule that makes the difference between 034's honest placeholder and a
--  governing instrument. In Postgres rather than in one writer, because more
--  than one path will move a packet and a rule held in one of them is a rule
--  the others do not have — the same reasoning as
--  trg_refuse_lease_on_retired_inventory (180).
--
--  It also enforces ORDER: the company signs after the resident, never before.
--  That is the business's own wall, and it is not a UI concern.
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

  if new.instrument_body_sha256 is null or length(btrim(new.instrument_body_sha256)) = 0 then
    raise exception 'lease packet % has no governing instrument identity', new.id
      using errcode = 'check_violation',
            hint = 'instrument_body_sha256 must identify the exact bytes the signatures are on.';
  end if;

  if new.status = 'executed'
     and (old.status is distinct from 'resident_executed')
     and (new.resident_executed_at is null) then
    raise exception 'lease packet % cannot be company-executed before the resident has executed it', new.id
      using errcode = 'check_violation',
            hint = 'The resident signs first. The company signature is the final approval wall.';
  end if;

  return new;
end $$;

drop trigger if exists trg_lease_packet_execution_guard on lease_packets;
create trigger trg_lease_packet_execution_guard
  before insert or update of status, is_placeholder, instrument_body_sha256
  on lease_packets
  for each row execute function assert_lease_packet_execution();

comment on function assert_lease_packet_execution() is
  'A placeholder can never be executed, an instrument must be identified by '
  'hash before it can be signed, and the company signs after the resident. '
  'Migration 184.';
