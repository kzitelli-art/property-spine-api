-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 063 — LEASE OFFERS + THE IMMUTABLE ECONOMIC SCHEDULE
--  (Commitment Ledger, Tier 2 · rev 2 — refined while still staged-only;
--   never deployed, so refinement beats a stack of corrective migrations)
--
--  REV 2 CHANGES (charter corrections #2 and #5):
--   · SCOPED-OR-BOUND OFFERS: a pre-lease offer is a commercial promise —
--     it MAY quote an exact space, or carry an eligibility SCOPE
--     ("any Studio"). It NEVER creates a hold, reservation, or turnover
--     priority. Only the SCHEDULE binds an exact space, at lock, after
--     eligibility is re-validated. D5 is preserved for economics and
--     correctly narrowed for promises.
--   · THE EVIDENCE MODEL: "offer drafted" is not "offer made".
--     communicated_at (when the prospect was told) is distinct from
--     recorded_at (when staff captured it). A tour ends at 3:00 PM; the
--     host records at 6:00 PM — both facts survive. An offer with no
--     evidence is a DRAFT: it cannot qualify and cannot lock. For an
--     in-person promise the host's structured attestation IS the
--     evidence — a claim, not a proven recording, which is exactly why
--     it carries attribution and timing.
--
--  Standing doctrines (unchanged from rev 1): D4 dated schedules ·
--  D7 immutable-means-never-silently-edited (no update path; amendments
--  are Tier 7) · D9/D10 snapshot the pricing version and the authority
--  basis at the moment of decision · D12 one deterministic value ·
--  D13 reconciliation vocabulary with NO matcher invented.
--
--  IDEMPOTENT. migrate.js owns the transaction — no BEGIN/COMMIT.
-- ════════════════════════════════════════════════════════════════════

-- ── the applicant-specific offer (scoped-or-bound, with a real clock) ─
create table if not exists lease_offers (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  person_id           uuid references persons(id) on delete set null,
  application_id      uuid,            -- lease_applications(id); loose FK on
                                       -- purpose (module verifies) — the offer
                                       -- may precede the application

  -- THE TARGET: exactly one of the two shapes (reviewer #2).
  --   bound:  space_id set, scope null — an exact quoted slot (still no hold)
  --   scoped: space_id null, scope set — an eligibility class
  space_id            uuid references spaces(id) on delete restrict,
  scope               text check (scope in ('property','unit_type','bed_type')),
  scope_ref           text,            -- the unit_type / bed_type name when scoped
  constraint ck_offer_target_one_shape
    check ( (space_id is not null and scope is null)
         or (space_id is null and scope is not null) ),
  constraint ck_offer_scope_needs_ref
    check (scope is null or scope = 'property' or scope_ref is not null),

  source              text not null
                      check (source in ('published','discretionary','decision_rail')),
  source_policy_id    uuid references concession_policies(id),
  constraint ck_offer_published_needs_policy
    check (source <> 'published' or source_policy_id is not null),

  -- the exact terms at the moment of the offer — never re-derived later
  offered_terms_snapshot   jsonb not null,
  -- who could offer this, at that moment (grant / policy / role + caps).
  -- rev 2: for soft out-of-scope offers this also carries over_threshold —
  -- read at lock time to spawn the (non-blocking) review obligation.
  authority_basis_snapshot jsonb not null,
  source_pricing_version_id uuid references property_pricing_versions(id),

  -- D12: the ONE deterministic value. 0 is legal.
  concession_authority_value numeric(14,2) not null default 0
                      check (concession_authority_value >= 0),

  guardrail_flag      boolean not null default false,
  -- retained for the FUTURE provisional mode (propose-then-clear). Soft
  -- mode no longer writes it — soft is honor-and-review, never
  -- pre-clearance (charter Stream 1).
  decision_case_id    uuid,

  -- THE EVIDENCE MODEL (reviewer #5): how the prospect actually received
  -- the promise. Absent = the offer is a DRAFT (draft ≠ promise).
  communicated_at     timestamptz,     -- when the prospect was told
  recorded_at         timestamptz not null default now(),  -- when staff captured it
  evidence_type       text check (evidence_type in
                        ('dispatched_message','tour_host_attestation','follow_up_dispatch')),
  evidence_ref        text,            -- outbound_event_id | tour_outcome/tour id
  constraint ck_offer_evidence_whole
    check ( (evidence_type is null and evidence_ref is null and communicated_at is null)
         or (evidence_type is not null and evidence_ref is not null and communicated_at is not null) ),

  status              text not null default 'sent'
                      check (status in ('draft','sent','earned','expired',
                                        'superseded','cancelled','locked')),
  -- a live promise MUST be evidenced; only draft (and dead states) may be bare
  constraint ck_offer_live_needs_evidence
    check (status in ('draft','superseded','cancelled') or evidence_type is not null),

  qualifying_action   text not null default 'application_submitted'
                      check (qualifying_action in ('application_submitted','lease_signed')),
  expires_at          timestamptz,     -- clock runs from communicated_at; null = no clock
  earned_at           timestamptz,

  granted_by_person_id uuid not null references persons(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_lease_offers_property_status
  on lease_offers (property_id, status);
create index if not exists idx_lease_offers_application
  on lease_offers (application_id) where application_id is not null;

-- ── the locked economic schedule (born at countersign, J1) ───────────
create table if not exists lease_economic_schedules (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  application_id      uuid not null,   -- the live lease record IS
                                       -- lease_applications (recon receipt)
  space_id            uuid not null references spaces(id) on delete restrict,  -- D5: ALWAYS exact
  -- HOW the exact space was resolved/validated against the offer's target
  -- (reviewer #2, kept honest given the schema: units carry no unit_type
  -- column today, so segment eligibility is attested, never fake-verified):
  --   exact_offer_bound       — the offer quoted this space
  --   property_scope          — offer scoped to the property; wall verified
  --   caller_attested_segment — unit_type/bed_type scope; property wall
  --                             verified, segment match ATTESTED by the
  --                             locking human (schema cannot verify it yet)
  space_resolution    text not null default 'exact_offer_bound'
                      check (space_resolution in
                        ('exact_offer_bound','property_scope','caller_attested_segment')),
  status              text not null default 'locked'
                      check (status in ('locked','active','cancelled','superseded')),
  locked_at           timestamptz not null default now(),
  source_offer_id     uuid not null references lease_offers(id),
  source_pricing_version_id uuid references property_pricing_versions(id),  -- D9 snapshot
  locked_by_person_id uuid not null references persons(id),
  created_at          timestamptz not null default now()
  -- NO updated_at: this row is never edited (D7). Amendments (Tier 7)
  -- reference it; they never touch it.
);
create unique index if not exists uq_les_application_live
  on lease_economic_schedules (application_id)
  where status in ('locked','active');

-- ── the dated lines (the atom of the Forward Rent Roll) ──────────────
create table if not exists lease_economic_lines (
  id                  uuid primary key default gen_random_uuid(),
  schedule_id         uuid not null references lease_economic_schedules(id) on delete cascade,
  effective_month     date not null,
  line_type           text not null
                      check (line_type in ('base_rent','recurring_fee','one_time_fee',
                                           'concession_credit','fee_waiver')),
  amount              numeric(14,2) not null,
  constraint ck_line_sign
    check ( (line_type in ('concession_credit','fee_waiver') and amount < 0)
         or (line_type in ('base_rent','recurring_fee','one_time_fee') and amount >= 0) ),
  source_reference    text,
  reconciliation_state text not null default 'not_yet_due'
                      check (reconciliation_state in
                        ('not_yet_due','posted_and_matched','partially_matched',
                         'reversed_or_superseded','in_exception')),
  matched_actual_ref  text,
  created_at          timestamptz not null default now()
);
create index if not exists idx_lel_schedule_month
  on lease_economic_lines (schedule_id, effective_month);
