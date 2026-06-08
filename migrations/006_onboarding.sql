-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 006 — ONBOARDING (takeover) + DEPOSIT-CLAIM RECONCILIATION
--
--  The operating truth: a takeover is a property where every inherited fact
--  starts ASSUMED. Onboarding is the funnel that drives each claim to
--  CONFIRMED. The first load-bearing rung is the security-deposit claim:
--  the prior owner SAYS it holds $X — proof is that it ties to cash.
--
--  Two tables:
--    onboarding_runs   — one per takeover. Carries scenario + effective_date
--                        (the clock anchor for every stage).
--    deposit_claims    — one per inherited security-deposit claim. Each is a
--                        funnel item: claimed_amount (assumed) → confirmed_amount
--                        (tied to cash) → status. The reconciliation obligation
--                        is spawned per claim and linked via related_id.
--
--  Follows existing conventions: uuid pk, provenance via status vocab + CHECK,
--  numbered + committed (never edit a shipped migration).
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  schema_migrations ledger row itself. This file therefore contains NO
--  transaction control and NO ledger insert — just the DDL.
-- ════════════════════════════════════════════════════════════════════

-- ── onboarding_runs ──────────────────────────────────────────────────
-- One row per property takeover. scenario toggles deed-vs-management rungs;
-- effective_date is the anchor every stage clock (Day1/+14/+30) counts from.
create table if not exists onboarding_runs (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references properties(id),
  scenario        text not null default 'management_only'
                    check (scenario in ('deed_transfer','management_only')),
  effective_date  date not null,
  status          text not null default 'open'
                    check (status in ('open','complete','archived')),
  prior_manager   text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists ix_onboarding_runs_property on onboarding_runs(property_id);
create index if not exists ix_onboarding_runs_status   on onboarding_runs(status);

-- ── deposit_claims ───────────────────────────────────────────────────
-- One row per inherited security-deposit claim. This is the funnel item.
--   claimed_amount    — what the prior owner SAYS is held   (assumed)
--   confirmed_amount  — what actually tied to cash          (confirmed)
--   variance          — claimed - confirmed (generated; the tell)
--   status: claimed → reconciling → confirmed | discrepancy | deferred
-- The reconciliation obligation links here via related_id/related_type.
create table if not exists deposit_claims (
  id                  uuid primary key default gen_random_uuid(),
  onboarding_run_id   uuid not null references onboarding_runs(id),
  property_id         uuid not null references properties(id),
  unit_id             uuid references units(id),
  tenant_name         text,
  claimed_amount      numeric(12,2) not null default 0,
  confirmed_amount    numeric(12,2),
  -- variance is meaningful only once confirmed; null until then
  variance            numeric(12,2)
                        generated always as (
                          case when confirmed_amount is null then null
                               else claimed_amount - confirmed_amount end
                        ) stored,
  status              text not null default 'claimed'
                        check (status in ('claimed','reconciling','confirmed','discrepancy','deferred')),
  spawned_obligation_id uuid references obligations(id),
  proof               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists ix_deposit_claims_run      on deposit_claims(onboarding_run_id);
create index if not exists ix_deposit_claims_property on deposit_claims(property_id);
create index if not exists ix_deposit_claims_status   on deposit_claims(status);
