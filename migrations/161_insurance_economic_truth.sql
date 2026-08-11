-- ════════════════════════════════════════════════════════════════════
--  161_insurance_economic_truth.sql — WHAT INSURANCE COSTS A PROPERTY,
--  ESTABLISHED INDEPENDENTLY OF HOW IT WAS PAID FOR.
--
--  ── THE DEFECT THIS EXISTS TO REMOVE ────────────────────────────────
--  The June 2026 Skyline workpaper reconstructs the property's annual
--  insurance cost from the financing stream:
--
--      allocated IPFS down payment + allocated IPFS installments
--        ÷ 12  =  monthly insurance expense
--
--  The monthly straight-line concept was never wrong. The DERIVATION was:
--  it makes the payment instrument the source of the economic fact. Prior
--  year sheets state the intended concept directly — allocated annual
--  insurance cost + brokerage fee, ÷ 12.
--
--  So this chain must be able to answer "what does insurance cost this
--  property this month" WITHOUT KNOWING IPFS EXISTS. Not by convention —
--  by construction. There is no column, no foreign key and no join in
--  anything below that reaches financing, escrow, installments or
--  payments, and tests/gate_insurance_economic_independence.js fails the
--  build if one appears.
--
--      A FINANCE CHARGE IS NOT INSURANCE PREMIUM merely because IPFS
--      collects both through the same payment stream.
--
--  ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────
--  No down payment. No principal financed. No finance charge. No
--  installments. No escrow. No payment. No intercompany funding. Those
--  are real and they get their own chain later; they may FUND the
--  insurance obligation and they never DEFINE the insurance expense.
--
--  ── CURRENCY IS ON THE TERM, WITH NO DEFAULT ────────────────────────
--  There is still no governed property/deal currency primitive in this
--  repo, and Insurance must not invent one. So currency is an explicit
--  governed fact of the program, `not null`, NO DEFAULT, and the writer
--  refuses to establish a program without it. The only other currency in
--  the repo (governed_charges, migration 105) carries `default 'USD'`,
--  which is exactly the silent default this must not repeat.
--
--  CLASSIFICATION: Class 1. Four new tables, one widened check.
-- ════════════════════════════════════════════════════════════════════

begin;

-- ── 1. THE PROGRAM — a placement term, and a DURABLE SPINE IDENTITY ──
--
--  Its identity is this uuid. It is NOT a policy number: the same Ally
--  policy already appears under three different textual numbers across
--  systems, and an identity that changes when a system reformats it is
--  not an identity. Carrier renderings accumulate as sourced evidence in
--  insurance_coverage_identifiers below.
--
--  There is deliberately NO `property_scope` column. A polymorphic
--  deal/portfolio scope would be an abstraction with no canonical entity
--  behind it — today's "portfolio policy" is a colloquialism, not a
--  modelled object. A program's actual relationship to properties is
--  established through coverages and allocations, which is the only place
--  it is ever true.
create table if not exists insurance_programs (
  id                     uuid primary key default gen_random_uuid(),
  program_name           text not null,

  term_start             date not null,
  term_end               date not null,

  --  NO DEFAULT. The writer refuses establishment when this is absent.
  currency_code          text not null check (currency_code ~ '^[A-Z]{3}$'),

  established_by_user_id uuid not null references users(id),
  established_at         timestamptz not null default now(),

  constraint ck_ins_program_term check (term_end > term_start)
);

-- ── 2. COVERAGES — one program, one or more ─────────────────────────
--
--  A coverage carries its OWN period, because a layer legitimately
--  differs from the program term, and its own economics.
--
--  ALLOCATION HANGS OFF THE COVERAGE, NOT THE PROGRAM. The workbook
--  carries "property allocation" and "GL allocation" as separate figures
--  for the same property in the same term, so a program-level allocation
--  could not represent what operations already does.
create table if not exists insurance_coverages (
  id                     uuid primary key default gen_random_uuid(),
  program_id             uuid not null references insurance_programs(id) on delete restrict,

  coverage_type          text not null check (coverage_type in
                           ('property','general_liability','umbrella_excess','other')),

  --  Carrier and broker are TEXT in V1, deliberately.
  --
  --  ⚠ `vendors` MUST NOT be reused as the carrier anchor. It is the
  --  maintenance-vendor table and its `insurance_status` column means
  --  "is this vendor insured" — the opposite meaning. Reusing it would
  --  collide two domains on one word. A carrier entity is the obvious
  --  later extraction; inventing it now buys nothing this slice needs.
  carrier_name           text,
  broker_name            text,

  coverage_period_start  date not null,
  coverage_period_end    date not null,

  --  THE ECONOMICS. bigint cents throughout, converging with migration
  --  045's allocated_amount_cents. Never floating point.
  --
  --  There is NO finance_charge column and there never will be.
  premium_cents          bigint not null check (premium_cents >= 0),
  taxes_cents            bigint not null default 0 check (taxes_cents >= 0),
  fees_cents             bigint not null default 0 check (fees_cents >= 0),
  broker_fee_cents       bigint not null default 0 check (broker_fee_cents >= 0),

  --  GENERATED, so the total can never drift from its parts. The prior
  --  year's concept — "allocated annual insurance cost + brokerage fee" —
  --  is expressible because broker fee is a named component rather than
  --  something recovered from a payment stream.
  total_cents            bigint generated always as
                           (premium_cents + taxes_cents + fees_cents + broker_fee_cents) stored,

  established_by_user_id uuid not null references users(id),
  established_at         timestamptz not null default now(),

  constraint ck_ins_coverage_period check (coverage_period_end > coverage_period_start)
);
create index if not exists idx_ins_coverage_program on insurance_coverages (program_id);

-- ── 3. IDENTIFIERS — policy numbers as sourced EVIDENCE ─────────────
--
--  Many per coverage, all true at once. Three textual renderings of one
--  Ally policy become three rows, not a conflict for Spine to resolve by
--  picking a favourite.
--
--  There is deliberately NO unique constraint on identifier_value alone:
--  the same string legitimately appears for different coverages across
--  years, and different strings legitimately name one coverage.
create table if not exists insurance_coverage_identifiers (
  id                     uuid primary key default gen_random_uuid(),
  coverage_id            uuid not null references insurance_coverages(id) on delete cascade,

  identifier_value       text not null,
  issued_by              text not null check (issued_by in
                           ('carrier','broker','lender','internal','other')),

  observed_in_artifact_id uuid references source_artifacts(id),
  observed_as_of         date,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint uq_ins_identifier unique (coverage_id, identifier_value, issued_by)
);
create index if not exists idx_ins_identifier_value on insurance_coverage_identifiers (identifier_value);

-- ── 4. THE GOVERNED PROPERTY ALLOCATION ─────────────────────────────
--
--  The load-bearing object: how much of a coverage's economics belongs to
--  one property, for one effective slice of time.
--
--  MANY-TO-MANY IS STRUCTURAL. One coverage allocates to many properties;
--  one property participates in many coverages. There is no
--  properties.policy_id and there never will be.
--
--  ── STATED vs DERIVED IS AN EPISTEMIC SPLIT, NOT A LABEL ───────────
--  A broker- or carrier-stated dollar figure is a RECORDED fact with an
--  external authority behind it. A TIV pro-rata split is DERIVED — the
--  output of a model with parameters somebody chose. §38 requires they
--  render as visibly different classes and that the derived one names its
--  model, which is why basis_detail is mandatory for 'derived'.
--  Collapsing them is how an internal estimate reaches a lender wearing a
--  carrier's authority.
create table if not exists insurance_property_allocations (
  id                     uuid primary key default gen_random_uuid(),
  coverage_id            uuid not null references insurance_coverages(id) on delete restrict,
  property_id            uuid not null references properties(id) on delete restrict,

  --  STAMPED AT ORIGIN, never derived at read time. Migration 155 makes
  --  membership historical, so deriving the Deal later would rewrite old
  --  economics when a property changes deals. Null when there is no
  --  governed membership. Never backfilled.
  deal_membership_id     uuid references deal_intake_properties(id),

  allocated_amount_cents bigint not null check (allocated_amount_cents > 0),

  allocation_class       text not null check (allocation_class in ('stated','derived')),
  allocation_basis       text not null check (allocation_basis in
                           ('carrier_stated','broker_stated','tiv_prorata',
                            'unit_count','negotiated','other')),
  --  The model, when the number came from one.
  basis_detail           text,

  --  THE EFFECTIVE SLICE. A mid-term addition or a recut opens a NEW
  --  slice; it does not edit the one that governed the earlier months.
  effective_from         date not null,
  effective_to           date,

  --  PROVENANCE IS REQUIRED, and its STRENGTH is visible.
  --  A document is not required — a broker's emailed figure confirmed by
  --  a human is a legitimate source. It is a WEAKER one, and the read
  --  reports which it was rather than flattening them.
  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  confirmed_by_user_id   uuid not null references users(id),
  confirmed_at           timestamptz not null default now(),

  --  CORRECTION, not accumulation. A restatement of the SAME claim.
  supersedes_id          uuid references insurance_property_allocations(id),
  revision_reason        text,

  created_at             timestamptz not null default now(),

  constraint ck_ins_alloc_slice check (effective_to is null or effective_to > effective_from),
  --  A correction requires a reason, at the database. Same rule
  --  person_facts enforces in code and for the same purpose.
  constraint ck_ins_alloc_revision_reason
    check (supersedes_id is null or (revision_reason is not null and length(btrim(revision_reason)) > 0)),
  --  A derived allocation must name the model that produced it.
  constraint ck_ins_alloc_derived_names_model
    check (allocation_class <> 'derived' or (basis_detail is not null and length(btrim(basis_detail)) > 0)),
  --  Provenance: a document, or a stated account of where the figure
  --  came from. Never neither.
  constraint ck_ins_alloc_provenance
    check (source_artifact_id is not null
           or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);

create index if not exists idx_ins_alloc_coverage on insurance_property_allocations (coverage_id);
create index if not exists idx_ins_alloc_property on insurance_property_allocations (property_id, effective_from);

--  ONE SUCCESSOR. The concurrent-race guard the trigger below cannot see,
--  same pairing migration 137 uses for the proof-evaluation chain.
create unique index if not exists uq_ins_alloc_one_successor
  on insurance_property_allocations (supersedes_id) where supersedes_id is not null;

-- ── 5. THE CHAIN AND SLICE INTEGRITY TRIGGER ────────────────────────
--
--  Two different things are being protected, and conflating them is the
--  mistake this exists to prevent:
--
--    CORRECTION      supersedes_id set. The same claim, restated. The
--                    predecessor must be the same (coverage, property),
--                    must be the current head, and must not be itself.
--
--    NEW SLICE       supersedes_id null. A DIFFERENT period's truth.
--                    It may not overlap another live slice for the same
--                    (coverage, property) — the service closes the prior
--                    slice in the same transaction.
--
--  June must remain explainable after July is recut. That is only true if
--  the June row is never edited, so nothing here updates a prior row's
--  amount; the service closes it by setting effective_to and writes a new
--  row forward.
--  UNQUALIFIED table references, deliberately. Schema-qualifying these
--  to `public.` would make the trigger unusable in a scoped-schema
--  harness — and a scoped schema is the ONLY way this repo can prove a
--  migration, because the full chain cannot rebuild from empty
--  (012_bank_intake / yardi_code). A guard that cannot be exercised is a
--  guard nobody has measured. This function is INVOKER-rights, so it
--  resolves through the caller's own search_path exactly as the caller's
--  own queries do, and grants no privilege the caller lacks.
create or replace function ins_alloc_chain_guard() returns trigger
language plpgsql as $$
declare
  pred  insurance_property_allocations%rowtype;
  live  int;
begin
  if NEW.supersedes_id is not null then
    if NEW.supersedes_id = NEW.id then
      raise exception 'allocation % may not supersede itself', NEW.id;
    end if;

    select * into pred from insurance_property_allocations where id = NEW.supersedes_id;
    if not found then
      raise exception 'allocation % supersedes a row that does not exist', NEW.id;
    end if;

    --  CROSS-SCOPE SUPERSESSION IS REFUSED. Correcting one property's
    --  allocation must never silently retire another's.
    if pred.coverage_id <> NEW.coverage_id or pred.property_id <> NEW.property_id then
      raise exception 'allocation supersession may not cross (coverage, property) scope';
    end if;

    --  HEAD ONLY. Read as "no successor exists", never as newest — that
    --  is only the head if the chain is guaranteed linear, and it is not.
    perform 1 from insurance_property_allocations
      where supersedes_id = NEW.supersedes_id;
    if found then
      raise exception 'allocation % is already superseded', NEW.supersedes_id;
    end if;

    return NEW;
  end if;

  --  A NEW SLICE. Refuse an overlapping live slice for the same scope.
  --  A row is live when nothing supersedes it.
  select count(*) into live
    from insurance_property_allocations a
   where a.coverage_id = NEW.coverage_id
     and a.property_id = NEW.property_id
     and not exists (select 1 from insurance_property_allocations s
                      where s.supersedes_id = a.id)
     and (a.effective_to is null or a.effective_to > NEW.effective_from)
     and (NEW.effective_to is null or NEW.effective_to > a.effective_from);
  if live > 0 then
    raise exception 'an overlapping allocation slice already exists for this coverage and property';
  end if;

  return NEW;
end $$;

drop trigger if exists trg_ins_alloc_chain_guard on insurance_property_allocations;
create trigger trg_ins_alloc_chain_guard
  before insert on insurance_property_allocations
  for each row execute function ins_alloc_chain_guard();

-- ── 6. INSURANCE SOURCE DOCUMENTS ───────────────────────────────────
--  Reuse the existing retained-artifact rail (153). It already carries
--  bytes, sha256, size and — the important one — source_as_of_date,
--  distinct from uploaded_at, because a binder uploaded today may be a
--  March 1 position and the term it establishes is dated by the document.
alter table source_artifacts drop constraint if exists source_artifacts_artifact_kind_check;
alter table source_artifacts add constraint source_artifacts_artifact_kind_check
  check (artifact_kind in ('rent_roll','other',
                           'insurance_policy','insurance_binder',
                           'insurance_invoice','insurance_allocation_schedule'));

commit;
