-- ════════════════════════════════════════════════════════════════════
--  163_insurance_funding.sql — HOW INSURANCE IS PAID FOR, RECORDED
--  WITHOUT EVER TOUCHING WHAT IT COSTS.
--
--  ── THE DEFECT THIS EXISTS TO KEEP OUT ──────────────────────────────
--  The June 2026 Skyline workpaper computed the property's annual
--  insurance cost FROM the financing stream:
--
--      allocated IPFS down payment + allocated IPFS installments
--        ÷ 12  =  monthly insurance expense
--
--  Migration 161 removed that by deriving cost from premium + taxes +
--  fees + broker fee over the COVERAGE PERIOD, knowing nothing about how
--  the premium was funded. This migration finally lets Spine record the
--  funding — and the entire design problem is doing that without
--  reopening the door 161 closed.
--
--  ── THE WALL, AND IT IS EXECUTABLE ──────────────────────────────────
--  `tests/gate_funding_boundary.js` asserts, structurally and
--  in both directions:
--
--      the economic chain may never IMPORT funding, transitively
--      the economic chain may never NAME a table created here
--      funding MAY reference the coverage it funds — that is the point
--      funding may never INSERT/UPDATE/DELETE/ALTER an economic table
--
--  So `coverage_id references insurance_coverages(id)` below is
--  deliberate and permitted: funding points AT the obligation it funds.
--  What it must never do is author it. Premium financing may FUND the
--  obligation; it never DEFINES it.
--
--  ── FINANCE CHARGE IS NOT INSURANCE EXPENSE ─────────────────────────
--  It is the cost of borrowing to pay a premium early. It belongs to the
--  financing arrangement and it never enters the insurance accrual —
--  which continues to divide the property's ALLOCATED ANNUAL COST by the
--  COVERAGE TERM, and cannot see anything in this file.
--
--  ── THREE MECHANISMS, NOT COLLAPSED ─────────────────────────────────
--  Direct, lender escrow and premium financing are different facts with
--  different evidence and different consequences. One row with a `kind`
--  and thirty nullable columns would make "escrowed" and "financed" the
--  same shape wearing different nulls. The arrangement carries what they
--  SHARE — which coverage, which mechanism, from when, on what evidence
--  — and each mechanism's own facts live in its own table.
--
--  ── ABSENCE IS UNKNOWN, NOT "DIRECT" ────────────────────────────────
--  No arrangement row means Spine does not know how this is paid. It
--  does NOT mean direct payment. `direct` is a POSITIVE finding — someone
--  established that it is paid directly — and defaulting to it would be
--  a healthy state invented from missing information.
--
--  CLASS 1 — permanent product primitive.
-- ════════════════════════════════════════════════════════════════════

--  ── THE ARRANGEMENT ────────────────────────────────────────────────
--  What is shared by every funding mechanism: which coverage, which
--  mechanism, from when, on what evidence, recorded by whom.
--
--  EFFECTIVE-DATED, mirroring insurance_property_allocations, because
--  funding changes mid-term: a policy paid directly in year one is
--  financed in year two, and the year-one answer must stay true. Same
--  distinction the allocation service already draws and for the same
--  reason —
--      a NEW SLICE      the world changed; it moves only the future
--      a CORRECTION     the claim was wrong; the predecessor is kept
create table if not exists insurance_funding_arrangements (
  id                     uuid primary key default gen_random_uuid(),

  --  PERMITTED AND DELIBERATE. Funding points at the coverage it funds.
  --  The boundary gate allows this reference and forbids the reverse.
  coverage_id            uuid not null references insurance_coverages(id) on delete restrict,

  --  Scoped to a property, because a shared master policy can be funded
  --  differently by each property on it — one owner escrows, another
  --  finances. Funding is not a property of the policy alone.
  property_id            uuid not null references properties(id) on delete restrict,

  --  `direct` is a POSITIVE finding, never a default. Absence of a row
  --  is unknown, and the read says NOT ESTABLISHED rather than guessing.
  funding_method         text not null check (funding_method in
                           ('direct', 'lender_escrow', 'premium_financed')),

  effective_from         date not null,
  effective_to           date,

  --  Same provenance rule as an allocation: a document, or a stated
  --  account of where this came from. Never neither.
  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  --  A correction restates the SAME claim; the predecessor stays
  --  readable. A mid-term change is a new slice instead.
  supersedes_id          uuid references insurance_funding_arrangements(id),
  revision_reason        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint ck_ins_fund_slice check (effective_to is null or effective_to > effective_from),
  constraint ck_ins_fund_revision_reason
    check (supersedes_id is null or (revision_reason is not null
           and length(btrim(revision_reason)) > 0)),
  constraint ck_ins_fund_provenance
    check (source_artifact_id is not null
           or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);

create index if not exists idx_ins_fund_property
  on insurance_funding_arrangements (property_id, effective_from);
create index if not exists idx_ins_fund_coverage
  on insurance_funding_arrangements (coverage_id);

--  ONE SUCCESSOR per correction, the same concurrency guard the
--  allocation chain uses.
create unique index if not exists uq_ins_fund_one_successor
  on insurance_funding_arrangements (supersedes_id)
  where supersedes_id is not null;

--  ── PREMIUM FINANCING ──────────────────────────────────────────────
--  The finance company lends the premium and is repaid in installments.
--
--  ⚠ EVERY AMOUNT HERE IS A FINANCING FACT. None of it is insurance
--  expense, none of it reaches the accrual, and the boundary gate makes
--  that structural rather than a promise in a comment.
--
--  `finance_charge_cents` is the cost of BORROWING. Adding it to the
--  premium would overstate what insurance costs the property, which is
--  the workpaper defect arriving from the other direction.
create table if not exists premium_finance_agreements (
  id                     uuid primary key default gen_random_uuid(),
  arrangement_id         uuid not null unique
                           references insurance_funding_arrangements(id) on delete cascade,

  finance_provider       text not null,
  agreement_reference    text,

  --  bigint cents, matching 045 and 161. Never floating point.
  down_payment_cents     bigint check (down_payment_cents >= 0),
  principal_financed_cents bigint check (principal_financed_cents > 0),
  finance_charge_cents   bigint check (finance_charge_cents >= 0),

  installment_count      integer check (installment_count > 0),
  installment_cents      bigint check (installment_cents > 0),
  first_payment_date     date,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);

--  ── LENDER ESCROW / RESERVE ────────────────────────────────────────
--  The lender or servicer holds funds and pays the premium.
--
--  Escrow is where the temptation to derive cost from cash is strongest,
--  because an escrow statement looks authoritative and arrives monthly.
--  It says what LEFT THE RESERVE. What the property's insurance COSTS is
--  the allocated premium over the coverage period, and the two disagree
--  routinely — escrow analyses true up, shortages get spread, cushions
--  get collected. Reading cost off the escrow line is the workpaper
--  defect with a different document on the desk.
create table if not exists insurance_escrow_arrangements (
  id                     uuid primary key default gen_random_uuid(),
  arrangement_id         uuid not null unique
                           references insurance_funding_arrangements(id) on delete cascade,

  lender_name            text,
  servicer_name          text,
  escrow_account_reference text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);

--  ── ARTIFACT KINDS FOR FUNDING EVIDENCE ────────────────────────────
--  161 widened this for policies and binders. Funding brings its own
--  documents, and they are a different kind of thing.
alter table source_artifacts drop constraint if exists source_artifacts_artifact_kind_check;
alter table source_artifacts add constraint source_artifacts_artifact_kind_check
  check (artifact_kind in ('rent_roll','other',
                           'insurance_policy','insurance_binder',
                           'insurance_invoice','insurance_allocation_schedule',
                           'insurance_finance_agreement','insurance_escrow_statement'));
