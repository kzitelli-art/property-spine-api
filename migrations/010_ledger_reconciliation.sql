-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 010 — OPENING-BALANCE / LEDGER RECONCILIATION
--
--  The second rung of the onboarding funnel. Same SHAPE as deposit_claims
--  (009), DIFFERENT proof. A deposit is one number that ties to CASH in an
--  account. A tenant LEDGER balance is the prior owner's claim of what a
--  tenant owes — and it can be wrong in BOTH directions for non-fraud reasons:
--  a misapplied payment, a credit in the wrong bucket, a reversed-but-uncleared
--  charge. (Seen directly in the MSC package: balances of -2,905.18, 12,505.26,
--  -35.56.) So the proof is not "ties to cash" — cash already happened — it is
--  "this claimed balance is the TRUE balance, reconciled against payment/charge
--  history." Different artifact, so a distinct gate name (ledger_tie), never
--  conflated with cash_tie. False equivalence is the thing the system fights.
--
--  One table: ledger_claims. One row per inherited tenant balance claim. Same
--  funnel item shape — claimed (assumed) → confirmed (reconciled) → variance
--  (generated) → status. Reconciliation obligation links via related_id.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  schema_migrations ledger row itself. NO transaction control, NO ledger
--  insert here — just DDL. Conventions match 001/009 exactly.
--
--  KAMERON-JUDGMENT FLAGS (revisit):
--    [J1] balances are signed: positive = tenant owes (arrears), negative =
--         credit owed to tenant. claimed_balance allows negatives.
--    [J2] confirmed against payment history is captured as a single
--         confirmed_balance number for now (matches the deposit pattern). If
--         you want line-level reconciliation later, that's a child table — not
--         built yet, deliberately, per "smallest real slice."
-- ════════════════════════════════════════════════════════════════════

-- ── ledger_claims ────────────────────────────────────────────────────
-- One row per inherited tenant ledger-balance claim. The funnel item.
--   claimed_balance   — what the prior owner's ledger SAYS the tenant owes
--                       (signed: + = arrears, - = credit)   (assumed)
--   confirmed_balance — the TRUE balance after reconciliation (signed) (confirmed)
--   variance          — claimed - confirmed (generated; null until confirmed)
--   status: claimed → reconciling → confirmed | discrepancy | deferred
create table if not exists ledger_claims (
  id                  uuid primary key default gen_random_uuid(),
  onboarding_run_id   uuid not null references onboarding_runs(id),
  property_id         uuid not null references properties(id),
  unit_id             uuid references units(id),
  tenant_name         text,
  claimed_balance     numeric(12,2) not null default 0,   -- signed: + arrears, - credit
  confirmed_balance   numeric(12,2),                       -- signed
  -- The single net balance is the prior owner's CLAIM and the reconciled total.
  -- But a real Yardi balance is a ROLL-UP of separate GL accounts (rent, parking,
  -- utilities, late fees, minus prepaid credit). A net variance alone tells the
  -- operator a number is wrong but not WHICH bucket. confirmed_components carries
  -- the per-bucket reconciled detail so a discrepancy is ACTIONABLE. Optional:
  -- null = reconciled at net level only (still valid, just less actionable).
  -- Shape: { "rent": n, "parking": n, "utilities": n, "late_fees": n,
  --          "prepaid_credit": n, ... } — keys open, app-layer defines vocab.
  confirmed_components jsonb,
  -- Sign convention is CONFIRMED PER SOURCE, never hardcoded. Validated against
  -- the real 4125 Yardi roll: + = arrears (owed), - = credit. But other exports
  -- invert this, so ingest records which convention THIS source used.
  sign_convention     text not null default 'arrears_positive'
                        check (sign_convention in ('arrears_positive','arrears_negative')),
  variance            numeric(12,2)
                        generated always as (
                          case when confirmed_balance is null then null
                               else claimed_balance - confirmed_balance end
                        ) stored,
  status              text not null default 'claimed'
                        check (status in ('claimed','reconciling','confirmed','discrepancy','deferred')),
  spawned_obligation_id uuid references obligations(id),
  proof               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists ix_ledger_claims_run      on ledger_claims(onboarding_run_id);
create index if not exists ix_ledger_claims_property on ledger_claims(property_id);
create index if not exists ix_ledger_claims_status   on ledger_claims(status);
