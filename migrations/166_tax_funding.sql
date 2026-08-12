-- ════════════════════════════════════════════════════════════════════
--  166_tax_funding.sql — HOW A TAX IS PAID FOR, RECORDED WITHOUT EVER
--  TOUCHING WHAT IS OWED.
--
--  ── THE SENTENCE THIS FILE EXISTS TO MAKE UNREPRESENTABLE ───────────
--
--      "The escrow is healthy, so the taxes are paid."
--
--  It is the most reasonable-sounding wrong statement in the domain. An
--  escrow statement is monthly, authoritative-looking, and arrives from
--  a servicer who genuinely intends to pay the bill. It still is not
--  evidence that the City was paid. Escrows get analysed and re-spread,
--  disbursements get missed, and a property with a fat escrow balance
--  and an unpaid 2025 Real Estate Tax bill is an ordinary occurrence.
--
--  So: nothing in this file may write `tax_payments`. PAID means the
--  City was paid and there is evidence of it. Migration 165 owns that
--  table; `tests/gate_funding_boundary.js` fails the build if anything
--  here reaches it.
--
--  ── AND THE SECOND ONE ──────────────────────────────────────────────
--
--      "The escrow contribution went up, so the tax went up."
--
--  A servicer raising a monthly escrow contribution from $1,200 to
--  $1,450 has not changed what the City assessed. It has changed the
--  cash the property sends the servicer. The annual liability and the
--  monthly accrual are computed in `tax_position_read.js` from the
--  governed liability over the obligation's own period, and that module
--  imports nothing — it cannot see this schema by any path.
--
--  This is the insurance wall (161/163) applied to a second domain,
--  because it is the same defect: the payment instrument becoming the
--  source of the economic fact.
--
--  ── STANDING, NOT PER-PERIOD ────────────────────────────────────────
--  An insurance funding arrangement keys to a COVERAGE, because a
--  coverage is itself a term with a start and an end. A tax obligation
--  is per-PERIOD — one row per tax year, or per month for U&O — and
--  keying funding to it would mint a new arrangement every January for
--  an escrow that has not changed since 2019.
--
--  So a tax funding arrangement is a STANDING, dated claim about a
--  (subject, tax_type) pair — the same shape as
--  `tax_obligation_applicability`, and for the same reason. It answers
--  "how is Real Estate Tax paid at this property, and since when",
--  which is the question that actually has a stable answer.
--
--  A DISBURSEMENT, by contrast, is per-obligation: the escrow paid
--  something toward a specific bill. That reference is permitted and is
--  the whole point of a disbursement record.
--
--  ── FOUR TABLES, BECAUSE FOUR DIFFERENT FACTS ───────────────────────
--      arrangement     how this tax is funded, from when, on what
--                      evidence — a governed claim
--      escrow detail   the terms of that escrow: who holds it, and the
--                      monthly contribution
--      observation     what a statement SAID the balance was, on a day —
--                      not a term, an observation, and it goes stale
--      disbursement    the escrow says it sent money toward a bill — a
--                      funding event, NOT a payment record
--
--  Collapsing observation into the arrangement would make a balance look
--  like a term and stop it going stale. Collapsing disbursement into
--  payment is the first defect at the top of this file.
--
--  CLASS 1 — permanent product primitive.
-- ════════════════════════════════════════════════════════════════════

--  ── THE ARRANGEMENT ────────────────────────────────────────────────
create table if not exists tax_funding_arrangements (
  id                     uuid primary key default gen_random_uuid(),

  jurisdiction           text not null default 'philadelphia_pa',
  tax_type               text not null check (tax_type in
                           ('real_estate','birt','npt','uo')),

  --  SAME TWO-SHAPE SUBJECT RULE AS THE OBLIGATION. Real Estate Tax and
  --  U&O are funded for a property; BIRT and NPT are funded by the
  --  taxpayer entity. Escrowing BIRT is unusual, but the shape must not
  --  be the thing that decides — the schema says which subject a tax
  --  type belongs to, and it says it the same way in both files.
  subject_property_id    uuid references properties(id) on delete restrict,
  subject_legal_entity_id uuid references legal_entities(id) on delete restrict,

  --  `direct` is a POSITIVE finding — somebody established that the
  --  property pays the City itself. Absence of a row is UNKNOWN, and the
  --  read says so. Defaulting absence to direct would invent a settled
  --  answer out of missing information (§5).
  funding_method         text not null check (funding_method in
                           ('direct','lender_escrow')),

  effective_from         date not null,
  effective_to           date,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  --  A CORRECTION restates the same claim; the predecessor stays
  --  readable. A world-change is a new slice instead — last year's
  --  answer must stay true after this year's servicer changes.
  supersedes_id          uuid references tax_funding_arrangements(id),
  revision_reason        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint ck_tax_fund_one_subject check (
    (subject_property_id is not null)::int
    + (subject_legal_entity_id is not null)::int = 1),
  constraint ck_tax_fund_subject_matches_type check (
    (tax_type in ('real_estate','uo') and subject_property_id is not null)
    or (tax_type in ('birt','npt') and subject_legal_entity_id is not null)),
  constraint ck_tax_fund_slice check (effective_to is null or effective_to > effective_from),
  constraint ck_tax_fund_revision check (
    supersedes_id is null or (revision_reason is not null
    and length(btrim(revision_reason)) > 0)),
  constraint ck_tax_fund_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);

--  ⚠ ONE LIVE ARRANGEMENT PER SUBJECT PER TAX TYPE.
--  The applicability chain shipped without this and a property could
--  read `applies` and `not_applicable` at once. Same failure mode here:
--  two live arrangements would let one screen say both "paid directly"
--  and "paid from escrow", and the reader would pick by row order.
create unique index if not exists uq_tax_fund_one_live_property
  on tax_funding_arrangements (tax_type, subject_property_id)
  where subject_property_id is not null and effective_to is null
        and supersedes_id is null;
create unique index if not exists uq_tax_fund_one_live_entity
  on tax_funding_arrangements (tax_type, subject_legal_entity_id)
  where subject_legal_entity_id is not null and effective_to is null
        and supersedes_id is null;

create unique index if not exists uq_tax_fund_one_successor
  on tax_funding_arrangements (supersedes_id) where supersedes_id is not null;

create index if not exists idx_tax_fund_property
  on tax_funding_arrangements (subject_property_id, tax_type);
create index if not exists idx_tax_fund_entity
  on tax_funding_arrangements (subject_legal_entity_id, tax_type);

--  ── THE ESCROW'S OWN TERMS ─────────────────────────────────────────
--  Who holds the money and what the property sends them each month.
--
--  ⚠ `monthly_contribution_cents` IS CASH TO A SERVICER. It is not the
--  monthly tax accrual and it is routinely a different number: servicers
--  collect a cushion, spread a prior shortage, or true up after an
--  analysis. The accrual is the governed annual liability over the
--  obligation's period and is computed where this column is invisible.
create table if not exists tax_escrow_arrangements (
  id                     uuid primary key default gen_random_uuid(),
  arrangement_id         uuid not null unique
                           references tax_funding_arrangements(id) on delete cascade,

  lender_name            text,
  servicer_name          text,
  escrow_account_reference text,

  --  Nullable on purpose. "We know it is escrowed, we do not yet know
  --  the contribution" is a real and common state, and it is a better
  --  record than a zero.
  monthly_contribution_cents bigint check (monthly_contribution_cents >= 0),

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);

--  ── WHAT A STATEMENT SAID, ON A DAY ────────────────────────────────
--  An OBSERVATION, not a term. A balance is true as of the statement
--  date and starts going stale immediately, which is exactly why it may
--  not live on the arrangement beside facts that do not decay.
--
--  ⚠ A BALANCE IS NOT AN ENTITLEMENT AND IT IS NOT A PAYMENT. A balance
--  larger than the bill proves the servicer HOLDS enough money. It says
--  nothing about whether they sent it.
create table if not exists tax_escrow_observations (
  id                     uuid primary key default gen_random_uuid(),
  arrangement_id         uuid not null
                           references tax_funding_arrangements(id) on delete cascade,

  observed_on            date not null,
  balance_cents          bigint not null check (balance_cents >= 0),
  currency_code          text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint ck_tax_escrow_obs_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0)),
  --  One observation per account per day. Two statements claiming
  --  different balances on the same date is a correction to make, not a
  --  pair of facts to hold.
  constraint uq_tax_escrow_obs_day unique (arrangement_id, observed_on)
);
create index if not exists idx_tax_escrow_obs_arrangement
  on tax_escrow_observations (arrangement_id, observed_on desc);

--  ── THE ESCROW SAYS IT SENT MONEY ──────────────────────────────────
--  A funding event: the servicer disbursed toward a specific obligation.
--
--  ⚠ THIS IS NOT `tax_payments` AND MAY NEVER BECOME IT.
--  A servicer's statement line saying "RE TAX DISB 03/28 $14,203" is the
--  servicer's account of what they did. City payment evidence is a
--  receipt, a cleared account statement, a confirmation number — and
--  they disagree often enough to matter: a disbursement can be returned,
--  applied to the wrong OPA account, or simply never leave.
--
--  When both exist they should reconcile, and the read SURFACES the gap
--  rather than closing it. When only this exists, the tax is NOT PAID
--  and the position says so out loud with the disbursement visible
--  beside it as the reason someone believed otherwise.
--
--  `obligation_id` is a REFERENCE — funding pointing at the bill it
--  funds, which the boundary explicitly permits. What it must never do
--  is author that bill or its payment.
create table if not exists tax_escrow_disbursements (
  id                     uuid primary key default gen_random_uuid(),
  arrangement_id         uuid not null
                           references tax_funding_arrangements(id) on delete cascade,
  obligation_id          uuid not null references tax_obligations(id) on delete restrict,

  disbursed_on           date not null,
  amount_cents           bigint not null check (amount_cents > 0),
  currency_code          text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  reference              text,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint ck_tax_disb_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);
create index if not exists idx_tax_disb_arrangement
  on tax_escrow_disbursements (arrangement_id, disbursed_on desc);
create index if not exists idx_tax_disb_obligation
  on tax_escrow_disbursements (obligation_id);

--  ── EVIDENCE KINDS FOR TAX FUNDING ─────────────────────────────────
--  165 added the City's documents. A servicer's escrow statement and an
--  escrow analysis are a different kind of thing from a tax bill, and
--  keeping them distinguishable is what lets the read refuse to treat
--  one as the other.
alter table source_artifacts drop constraint if exists source_artifacts_artifact_kind_check;
alter table source_artifacts add constraint source_artifacts_artifact_kind_check
  check (artifact_kind in ('rent_roll','other',
                           'insurance_policy','insurance_binder',
                           'insurance_invoice','insurance_allocation_schedule',
                           'insurance_finance_agreement','insurance_escrow_statement',
                           'entity_formation_document','operating_agreement',
                           'tax_bill','tax_balance_statement','tax_return',
                           'tax_payment_receipt','tax_clearance_certificate',
                           'tax_account_statement','tax_appeal_document',
                           'tax_escrow_statement','tax_escrow_analysis'));
