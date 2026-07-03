-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 062 — PRICING AUTHORITY (Commitment Ledger, Tier 1)
--
--  Build A's foundation: what may we offer, who may offer it, what does
--  it economically mean. Three locked doctrines live in this DDL:
--
--  D9  — published pricing is VERSIONED, never merely editable. A live
--        offer references a version; countersign snapshots it; a later
--        edit creates a NEW version and retires the old. No offer ever
--        points at mutable pricing.
--  D11 — the guardrail is a CONFIGURABLE DIAL, not a fixed behavior.
--        soft|hard mode + a dollar threshold + per-person scope, all on
--        the grant row, all adjustable per property/person. NO GRANT =
--        fail-closed HARD (no discretionary authority exists at all) —
--        the same fail-closed-to-zero posture as the Decision Rail.
--  D12 — one deterministic concession value governs everything. The
--        grant stores the dollar comparators the value is checked
--        against; the value itself is computed and stored on the OFFER
--        (063) at offer time.
--
--  AUTHORITY STAYS ON THE ASSIGNMENT GRAPH: the grant row LINKS an
--  assignment (004) — it is a scope extension of existing authority,
--  never a parallel permissions product.
--
--  AMOUNTS: numeric(14,2) dollars (platform convention). IDEMPOTENT:
--  create-if-not-exists throughout; migrate.js owns the transaction —
--  no BEGIN/COMMIT here.
-- ════════════════════════════════════════════════════════════════════

-- ── the versioned published pricing spine (D9) ───────────────────────
create table if not exists property_pricing_versions (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references properties(id) on delete cascade,
  status                text not null default 'draft'
                        check (status in ('draft','published','retired')),
  effective_from        timestamptz,
  effective_until       timestamptz,
  published_by_person_id uuid references persons(id),
  published_at          timestamptz,
  -- who could publish, at the moment of publish (D10 applied to pricing)
  authority_basis       jsonb,
  supersedes_version_id uuid references property_pricing_versions(id),
  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_ppv_property_status
  on property_pricing_versions (property_id, status);
-- exactly ONE published version per property at a time (the read is
-- unambiguous; supersede = retire old + publish new in one transaction)
create unique index if not exists uq_ppv_one_published
  on property_pricing_versions (property_id) where status = 'published';

-- ── per-segment terms inside a version ───────────────────────────────
create table if not exists pricing_terms (
  id                  uuid primary key default gen_random_uuid(),
  pricing_version_id  uuid not null references property_pricing_versions(id) on delete cascade,
  -- segment: keep loose text for v1 (unit_type names come from the rent
  -- roll vocabulary, not an enum we'd have to chase)
  unit_type           text not null,
  lease_term_months   int  not null check (lease_term_months between 1 and 36),
  base_rent           numeric(14,2) not null check (base_rent >= 0),
  renewal_rent        numeric(14,2) check (renewal_rent >= 0),
  immediate_move_in_rent numeric(14,2) check (immediate_move_in_rent >= 0),
  -- fee schedule for the segment (app fee, amenity, admin …) — jsonb
  -- keyed by fee_category, dollar values. Read, never interpreted.
  fee_terms           jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists idx_pricing_terms_version
  on pricing_terms (pricing_version_id);

-- ── published concession offers (layer A — pre-authorized by definition)
create table if not exists concession_policies (
  id                  uuid primary key default gen_random_uuid(),
  pricing_version_id  uuid not null references property_pricing_versions(id) on delete cascade,
  property_id         uuid not null references properties(id) on delete cascade,
  -- scope of who the offer applies to
  scope               text not null default 'property'
                      check (scope in ('property','unit_type','unit','bed_type')),
  scope_ref           text,            -- unit_type name / unit label when scoped
  lease_type          text not null default 'new'
                      check (lease_type in ('new','renewal')),
  required_term_months int check (required_term_months between 1 and 36),
  concession_type     text not null
                      check (concession_type in ('free_rent','fixed_rent_credit','fee_waiver')),
  -- value semantics by type: free_rent → months (e.g. 1.0, 0.5);
  -- fixed_rent_credit → dollars; fee_waiver → dollars (the fee amount)
  value               numeric(14,2) not null check (value > 0),
  fee_category        text,            -- required when fee_waiver
  constraint ck_policy_fee_needs_category
    check (concession_type <> 'fee_waiver' or fee_category is not null),
  -- HOW the resident's scheduled charge is actually reduced (D4; the
  -- monthly_scheduled_credit rename is deliberate — it is NOT NER math)
  timing_profile      text not null default 'first_full_month'
                      check (timing_profile in
                        ('first_full_month','third_full_month',
                         'final_full_month','monthly_scheduled_credit')),
  -- the clock: what earns it, and until when (V1: two qualifying actions)
  qualifying_action   text not null default 'application_submitted'
                      check (qualifying_action in ('application_submitted','lease_signed')),
  qualifying_window_hours int,         -- e.g. 24 → offer expires_at = sent+24h
  valid_from          timestamptz,
  valid_until         timestamptz,
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);
create index if not exists idx_concession_policies_property_active
  on concession_policies (property_id, active);

-- ── the guardrail dial (layer B authority — D11) ─────────────────────
--  One row = one person's discretionary concession arsenal on one
--  property, LINKED to their assignment. Everything is a dial:
--    guardrail_mode        soft = honored+flagged (escalate over
--                          threshold) · hard = the write is BLOCKED
--                          outside the sheet/grant
--    escalation_threshold  dollars; soft-mode flag-only under, escalate
--                          over (default 500, adjustable per grant)
--    max_discretionary_value  the D12 comparator: total contractual
--                          reduction the person may grant per offer
--  NO ROW for a person = they hold NO discretionary authority: hard
--  block. Published offers need no grant — pre-authorized (Part 4).
create table if not exists concession_authority_grants (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id) on delete cascade,
  person_id           uuid not null references persons(id) on delete cascade,
  assignment_id       uuid not null,   -- links assignments(id); FK loose on
                                       -- purpose (004 predates this file and
                                       -- some environments rebuild it) —
                                       -- integrity enforced in the module
  guardrail_mode      text not null default 'soft'
                      check (guardrail_mode in ('soft','hard')),
  escalation_threshold numeric(14,2) not null default 500
                      check (escalation_threshold >= 0),
  max_discretionary_value numeric(14,2) not null default 0
                      check (max_discretionary_value >= 0),
  may_grant_application_fee_waiver boolean not null default false,
  may_grant_amenity_fee_waiver     boolean not null default false,
  may_grant_admin_fee_waiver       boolean not null default false,
  maximum_discretionary_free_rent_months numeric(4,2) not null default 0
                      check (maximum_discretionary_free_rent_months >= 0),
  permitted_concession_timing_profile text
                      check (permitted_concession_timing_profile is null or
                             permitted_concession_timing_profile in
                               ('first_full_month','third_full_month',
                                'final_full_month','monthly_scheduled_credit')),
  may_publish_public_offers boolean not null default false,
  may_edit_pricing          boolean not null default false,
  effective_from      timestamptz not null default now(),
  effective_until     timestamptz,
  granted_by_person_id uuid references persons(id),
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_cag_property_person
  on concession_authority_grants (property_id, person_id);
