-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 033 — LEASE APPLICATIONS (the application record + lifecycle)
--
--  Gives applications a REAL row (replacing the leasing log's summary
--  count). The lifecycle is claimed-vs-proven made structural:
--    draft → submitted → approved → lease_ready
--      → tenant_signed   (applicant/guarantor signatures = INTENT, a claim)
--      → active          (only via manager COUNTERSIGN completing the
--                         activation obligation — the binding proof gate)
--
--  The wall is NOT policy: 'active' is only ever set in the same
--  transaction as a successful completeObligation on the activation
--  obligation, which itself refuses while any required input (the
--  signatures, the countersign) is still outstanding. Lease-document
--  generation and the real e-signature capture are a SEPARATE later rung
--  (they wait on the lease template + a legal answer); this rung is the
--  record and the binding gate, and nothing more.
-- ════════════════════════════════════════════════════════════════════

create table if not exists lease_applications (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references properties(id) on delete cascade,
  unit_id      uuid references units(id) on delete set null,
  person_id    uuid references persons(id) on delete set null,

  status       text not null default 'draft'
    check (status in ('draft','submitted','approved','lease_ready',
                      'tenant_signed','countersigned','active',
                      'declined','withdrawn')),

  applicant_name text,
  unit_label     text,
  rent           numeric,
  deposit        numeric,
  guarantor_name text,

  -- the captured application data (parties, qualification, docs, extras).
  -- A blob for now; the structured intake fields land with the tenant flow.
  captured     jsonb not null default '{}'::jsonb,

  -- link to the activation obligation (the countersign proof gate).
  activation_obligation_id uuid references obligations(id) on delete set null,

  applicant_signed_at  timestamptz,
  guarantor_signed_at  timestamptz,
  countersigned_at     timestamptz,
  activated_at         timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists lease_applications_property_idx
  on lease_applications (property_id, status);
