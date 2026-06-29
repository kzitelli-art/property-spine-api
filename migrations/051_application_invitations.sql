-- ════════════════════════════════════════════════════════════════════
-- 051_application_invitations.sql
--
-- Stage-1 of the application moment as REAL infrastructure (not browser
-- state). Adds the front of the chain that was missing, and joins the
-- application RECORD (033 lease_applications) to the conversion RAIL
-- (047 leasing_conversions / _obligations) so the kept/missed rung
-- outcome and the application disposition are written in one transaction
-- but remain DISTINCT facts.
--
-- This migration is purely additive. It adds NO obligation/event `type`
-- enum values (both are free text in 001_baseline). It does NOT duplicate
-- lease_applications or the submit/approve/sign/countersign machinery.
--
-- The decision chain this enables:
--   applicant_followup  (existing 047 conversation rung)
--     → application submitted  → resolveRung(applicant_followup, completed)
--                              → addGate(application_approval, leasing_manager)
--     → approve | deny         → resolveRung(application_approval, completed)
--     → approve ONLY           → existing activation obligation
--
-- Authority split is HONORED, not relabeled:
--   leasing_manager  owns application_approval
--   property_manager owns lease_terms / countersign / activation
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Application disposition: add 'expired' to the live status enum ──
-- 033 already carries: draft, submitted, approved, lease_ready,
-- tenant_signed, countersigned, active, declined, withdrawn.
-- 'declined' = leasing decision (deny). 'withdrawn' = applicant/staff pulled.
-- We add 'expired' = the invitation/application window elapsed. These three
-- are DISTINCT dispositions and must never be collapsed.
--
-- 033 defines the check as a COLUMN constraint, which Postgres auto-names
-- 'lease_applications_status_check'. Drop that known name (idempotent) and
-- re-add with 'expired' included.
alter table lease_applications
  drop constraint if exists lease_applications_status_check;
alter table lease_applications
  add constraint lease_applications_status_check
  check (status in (
    'draft','submitted','approved','lease_ready',
    'tenant_signed','countersigned','active',
    'declined','withdrawn','expired'
  ));

-- ── 2. Join the application record to the conversion rail + provenance ──
-- conversion_id ties a lease_application to its relationship case (047) so
-- the submission can close the EXACT open applicant_followup rung and the
-- approval gate spawns on the right conversation. Nullable: legitimate
-- internal/import applications may have no conversion.
--
-- source marks HOW the application came to exist, enforcing the boundary:
--   'applicant' — public, invitation-bound self-service (default)
--   'staff'     — operator-created internal pathway
--   'import'    — bulk/migrated record
alter table lease_applications
  add column if not exists conversion_id uuid references leasing_conversions(id) on delete set null;
alter table lease_applications
  add column if not exists source text not null default 'applicant'
    check (source in ('applicant','staff','import'));
-- the leasing_manager decision actor + reason + note (disposition trail)
alter table lease_applications
  add column if not exists decision_by_user_id uuid references users(id) on delete set null;
alter table lease_applications
  add column if not exists decision_reason text;   -- free text reason code for declined/withdrawn/expired
alter table lease_applications
  add column if not exists decided_at timestamptz;
-- the approval GATE obligation (mirror of how 033 links activation_obligation_id).
-- This is the leasing_manager application_approval rung, born at submission.
alter table lease_applications
  add column if not exists approval_obligation_id uuid references obligations(id) on delete set null;

create index if not exists lease_applications_conversion_idx
  on lease_applications(conversion_id) where conversion_id is not null;

-- ── 3. application_invitations — the SENT-link front of the chain ──
-- The invitation is the identity / authorization / provenance spine for the
-- PUBLIC applicant path: a self-service submission must resolve through a
-- live, valid token. Internal staff/import applications do NOT create one.
--
-- TRUTHFUL SEND SEMANTICS: an invitation is 'prepared' when its token exists.
-- It becomes a SEND only on an attested fact:
--   • manually_sent     — a staff member attests they sent it through the real
--                         channel (SMS/email/other), with their actor id, a
--                         recipient-destination snapshot, channel, and time.
--   • provider_dispatched — (later, Twilio) the provider accepted the message
--                         for dispatch, with a provider_message_id.
-- NEITHER means the prospect received or opened the link. 'manually_sent'
-- means "Katie attested she sent it by SMS at this time" — nothing more.
-- Actual delivery/open is a SEPARATE later fact (a provider callback), never a
-- retroactive edit to the send record.
--
-- Lifecycle: prepared → (manually_sent | provider_dispatched) → consumed
--                     → expired | revoked
-- The 'application_link_sent' event + the applicant_followup rung attach + its
-- clock start happen ONLY at the send transition, never at 'prepared'.
create table if not exists application_invitations (
  id                    uuid primary key default gen_random_uuid(),

  -- SECURITY: we store ONLY a non-recoverable digest of the token, never the
  -- usable bearer token. The raw token exists solely in the issued URL handed
  -- to the applicant. Submission hashes the presented token and matches the
  -- digest. A DB leak yields no working links.
  token_digest          text not null unique,

  -- who/where this invitation is for. conversion_id is the rail join;
  -- person/property/unit mirror lease_applications so the submission service
  -- can build the record without re-deriving identity.
  conversion_id         uuid references leasing_conversions(id) on delete cascade,
  person_id             uuid references persons(id) on delete set null,
  property_id           uuid not null references properties(id) on delete cascade,
  unit_id               uuid references units(id) on delete set null,

  -- filled when the applicant submits against this token (the consume step).
  lease_application_id  uuid references lease_applications(id) on delete set null,

  -- the applicant_followup rung this invitation's submission should CLOSE.
  -- Captured at the SEND transition so submit resolves the exact obligation.
  progress_obligation_id uuid references obligations(id) on delete set null,

  -- ── the SEND attestation (not delivery) ──
  dispatch_source       text check (dispatch_source in ('manual','provider')),
  channel               text check (channel in ('sms','email','other')),
  recipient_snapshot    text,                       -- destination as sent (phone/email), captured at send time
  provider_message_id   text,                       -- provider dispatch id (provider source only)
  sent_by_user_id       uuid references users(id),  -- the staff actor who ATTESTED the send (manual source)
  sent_at               timestamptz,                -- when the send was attested/dispatched; null until sent
  sent_note             text,                       -- optional operator note on the send

  -- lifecycle (see header).
  status                text not null default 'prepared'
                          check (status in ('prepared','manually_sent','provider_dispatched','consumed','expired','revoked')),

  -- revocation is a CORRECTION fact, not a rewrite of the send record.
  revoked_by_user_id    uuid references users(id),
  revoked_at            timestamptz,
  revoked_reason        text,

  expires_at            timestamptz,                -- optional window; null = no auto-expiry
  consumed_at           timestamptz,

  created_by_user_id    uuid references users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists application_invitations_conversion_idx
  on application_invitations(conversion_id);
create index if not exists application_invitations_property_idx
  on application_invitations(property_id);
-- fast "live valid token" lookup for the public submit path (a token that has
-- been sent and not yet consumed/expired/revoked):
create index if not exists application_invitations_open_token_idx
  on application_invitations(token_digest) where status in ('manually_sent','provider_dispatched');

-- ── DB-ENFORCED IDEMPOTENCY (route-level SELECT-then-INSERT is not enough
--    under retries / double taps; these constraints make the invariants real) ──

-- (a) At most ONE non-terminal (prepared/sent) invitation per conversion. A
--     second "send application" tap cannot create a competing live invitation
--     for the same relationship. Terminal states (consumed/expired/revoked)
--     are unconstrained so history accrues.
create unique index if not exists application_invitations_one_live_per_conversion
  on application_invitations(conversion_id)
  where conversion_id is not null
    and status in ('prepared','manually_sent','provider_dispatched');

-- (b) At most ONE lease_application linked per invitation (one consume).
create unique index if not exists application_invitations_one_app
  on application_invitations(lease_application_id)
  where lease_application_id is not null;

-- ── At most ONE open application_approval gate per conversion ──
-- The approval decision is single-valued; two open gates would let two
-- managers act in parallel. Partial-unique on the rung link enforces it.
create unique index if not exists one_open_application_approval_per_conversion
  on leasing_conversion_obligations(conversion_id)
  where rung = 'application_approval' and outcome is null;

-- ── At most ONE open application_approval per APPLICATION (internal path,
--    no conversion → guard on the application record's approval link) ──
create unique index if not exists lease_applications_one_open_approval
  on lease_applications(approval_obligation_id)
  where approval_obligation_id is not null;
