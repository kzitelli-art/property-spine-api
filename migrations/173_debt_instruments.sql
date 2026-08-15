-- ════════════════════════════════════════════════════════════════════
--  173_debt_instruments.sql — THE GOVERNED DEBT DOMAIN.
--  First specimen: 4125 Chestnut, ORIX/Freddie loan 480010465, serviced
--  by Lument. Everything here is forced by that specimen at authority
--  level 1 (executed governing instruments). See
--  docs/DEBT_READ_CONTRACT_AND_SCHEMA.md and DEBT_4125_STRUCTURAL_MAP.md.
--
--  ── HISTORY IS CANONICAL. "CURRENT" IS A READING. ───────────────────
--  There is no current_balance, current_rate, current_maturity or
--  current_payment column anywhere in this file, deliberately. PHILOSOPHY
--  §39: stages are READINGS of an accumulating history, not statuses on
--  one row. Every "what is true now" answer is
--      position(instrument, as_of = today)
--  and every "what was true before the modification" answer is the SAME
--  read at another date. A materialised cache of that read is acceptable
--  later; it is a disposable projection, and this history is not.
--
--  ── APPEND-ONLY MEANS POINTS BACKWARD ───────────────────────────────
--  Superseding rows carry `supersedes_*_id` and reference the row they
--  replace. There is deliberately NO `superseded_by` column: that would
--  require UPDATEing an earlier canonical record when a later amendment
--  arrives, which is a rewrite of history wearing an append-only name.
--  Which row is in force at a date is DERIVED from the chain.
--
--  `effective_to` survives only where the GOVERNING INSTRUMENT ITSELF
--  established the end. 4125's interest-only period legitimately carries
--  2024-08-01 because the original Loan Agreement says so. A later
--  amendment must never back-write `effective_to` on an earlier row.
--
--  ── THE ORIGINAL INSTRUMENT ALREADY HAS TWO REGIMES ─────────────────
--  This is why effective-dated terms are not future-proofing. 4125 is the
--  SIMPLE specimen and it still needs them:
--      interest-only   2020-09-01 → 2024-08-01
--      level P&I       2024-09-01 → 2030-08-01   $123,411.40
--  Two rows, both term_source = 'original', from one document.
--
--  ── PARTY ROLES ARE THREE, NOT ONE ──────────────────────────────────
--  ORIX Real Estate Capital originated; the security instrument was
--  ASSIGNED to Freddie Mac; Lument services. Collapsing these into one
--  `lender_name` loses the assignment, which is a dated event — so party
--  roles are effective-dated for the same reason terms are.
--
--  ── WHAT IS DELIBERATELY ABSENT, AND WHY ────────────────────────────
--  Each of these was designed, argued, and REMOVED before DDL. Adding one
--  back is a ruling, not a tidy-up.
--
--    covenant / reporting table   Ordinary Article VI borrower covenants
--                                 exist. A table with no threshold, test
--                                 date, due rule or compliance column is a
--                                 taxonomy with no operational consequence,
--                                 and W5 holds more cleanly with no covenant
--                                 object for a read to over-interpret.
--    extension_standing           4125 forces no extension object. The read
--                                 narrates "no option evidenced"; it does not
--                                 store a state. Model a real extension when a
--                                 specimen produces a right or an exercise.
--    balloon_amount               $24,716,182.48 is what the SCHEDULE projects
--                                 assuming every payment occurs — a projection
--                                 in contractual costume. The instrument
--                                 establishes that the loan does not fully
--                                 amortize; the figure is derived.
--    satisfies_requirement        Requirements are DERIVED from terms, so there
--                                 is no canonical row for the reference to
--                                 mean. Inventing one drags toward a payment
--                                 engine.
--    reserve balances             A reserve REQUIREMENT is a row here. Tax and
--                                 insurance escrow BALANCES are those domains'
--                                 funding truth and are not writable from here.
--    schedule publication table   The servicer's 120 published rows are a PROOF
--                                 FIXTURE, on the tax precedent where the City
--                                 calendar is pinned in code, not a table.
--
--  ── CROSS-DOMAIN ────────────────────────────────────────────────────
--  Nothing in this file may write tax or insurance truth. A Lument
--  statement carries debt, tax-escrow and insurance-escrow facts in one
--  document; the artifact is shared, authority never is. Enforced by
--  tests/gate_funding_boundary.js (CROSS-DOMAIN section).
--
--  CLASS 1 — permanent product primitive.
-- ════════════════════════════════════════════════════════════════════

--  ── THE INSTRUMENT ─────────────────────────────────────────────────
create table if not exists debt_instruments (
  id                     uuid primary key default gen_random_uuid(),

  instrument_kind        text not null check (instrument_kind in
                           ('first_mortgage','mezzanine','supplemental',
                            'line_of_credit','other')),

  --  The servicer's number. NEVER an identity or a property resolver:
  --  this loan's own name is "LVL 4125" and carries BOTH properties'
  --  tokens. Collateral is established in debt_instrument_properties by
  --  evidence, never by a name or a number.
  loan_number            text,

  original_principal_cents  bigint not null check (original_principal_cents > 0),

  --  ⚠ NOT NULL, NO DEFAULT, ON PURPOSE.
  --  There is no governed currency context anywhere in this repo — no
  --  currency on properties, orgs, deals or portfolios. Debt resolves it
  --  explicitly or refuses to record the instrument. It does not inherit
  --  USD by luck and then discover the assumption at the first non-USD deal.
  currency               text not null check (length(currency) = 3),

  origination_date       date,
  first_payment_date     date,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);

create index if not exists idx_debt_instruments_loan_number
  on debt_instruments (loan_number);

--  ── PARTIES ────────────────────────────────────────────────────────
--  Obligor is an ENTITY-to-INSTRUMENT relationship, never entity-to-
--  property. You do not borrow a property; you borrow from a lender,
--  under an instrument, secured by a property. The property-keyed shape
--  produces N "borrower" rows and no instrument the moment a loan is
--  cross-collateralised. `legal_entity_properties` (164) is left alone.
create table if not exists debt_instrument_parties (
  id                     uuid primary key default gen_random_uuid(),
  instrument_id          uuid not null references debt_instruments(id) on delete restrict,

  party_role             text not null check (party_role in
                           ('borrower','guarantor',
                            'originator_lender','holder_assignee','servicer')),

  --  EXACTLY ONE of these, enforced below.
  --  Entities resolve to legal_entities. Natural-person guarantors are
  --  recorded as an ATTRIBUTED NAME on the instrument — reading a loan
  --  document must never mint a durable person (PHILOSOPHY §12). 4125 has
  --  five individual guarantors and none of them becomes a Spine person here.
  legal_entity_id        uuid references legal_entities(id) on delete restrict,
  party_name_text        text,

  effective_from         date not null,
  --  Only where the governing instrument itself established the end.
  effective_to           date,

  --  POINTS BACKWARD. An assignment inserts a row naming the row it
  --  replaces; the earlier row is never updated.
  supersedes_party_id    uuid references debt_instrument_parties(id),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint debt_party_exactly_one_subject check (
    (legal_entity_id is not null and party_name_text is null) or
    (legal_entity_id is null and party_name_text is not null
       and length(btrim(party_name_text)) > 0)
  ),
  constraint debt_party_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_debt_parties_instrument_role
  on debt_instrument_parties (instrument_id, party_role, effective_from);

--  ── COLLATERAL ─────────────────────────────────────────────────────
--  A relationship, not a column, even though 4125 has exactly one
--  property. A column would force a row per property and silently
--  duplicate the instrument on the first cross-collateralised loan.
--
--  `established_by_source_artifact_id` is the point of this table. The
--  loan is named "LVL 4125"; a 4233 document has said "LVL 4125" too.
--  The link records WHAT ESTABLISHED IT — a security instrument's legal
--  description — so the next reader does not resolve a property from a name.
create table if not exists debt_instrument_properties (
  id                     uuid primary key default gen_random_uuid(),
  instrument_id          uuid not null references debt_instruments(id) on delete restrict,
  property_id            uuid not null references properties(id) on delete restrict,

  lien_position          int check (lien_position >= 1),

  effective_from         date not null,
  effective_to           date,

  established_by_source_artifact_id  uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint debt_collateral_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_debt_collateral_instrument
  on debt_instrument_properties (instrument_id, effective_from);
create index if not exists idx_debt_collateral_property
  on debt_instrument_properties (property_id);

--  ── TERMS ──────────────────────────────────────────────────────────
--  Effective-dated, append-only, points backward. One mechanism serves
--  the original instrument's two regimes, any later amendment, and any
--  extension exercise — they are all "the terms in force changed on a date".
create table if not exists debt_terms (
  id                     uuid primary key default gen_random_uuid(),
  instrument_id          uuid not null references debt_instruments(id) on delete restrict,

  effective_from         date not null,
  --  Only where the governing instrument established the end date itself.
  effective_to           date,

  term_source            text not null check (term_source in
                           ('original','amendment','extension_exercised','assumption')),

  --  RATE. Passive representation only. index/spread/floor/cap exist so a
  --  floating instrument can be RECORDED; there is deliberately no index
  --  feed and no rate-reset machinery in this build. A cheap seam.
  rate_kind              text not null check (rate_kind in ('fixed','floating')),
  fixed_rate_bp          int check (fixed_rate_bp >= 0),
  rate_index_name        text,
  spread_bp              int,
  rate_floor_bp          int,
  rate_cap_bp            int,

  --  ⚠ STORED, NEVER ASSUMED. 4125 is 360 DAYS/ACTUAL DAY MOS (2/29) and
  --  that convention is why interest differs every month: $79,790.56 in a
  --  31-day month, $72,068.89 in a 28-day month. Defaulting this to 30/360
  --  would silently produce a different number every single period.
  day_count_convention   text not null check (day_count_convention in
                           ('actual_360','actual_365','thirty_360','actual_actual')),

  payment_frequency      text not null check (payment_frequency in
                           ('monthly','quarterly','semiannual','annual')),

  --  interest_only carries a null level payment. That is the honest shape:
  --  under actual/360 an IO payment is not level and no constant exists.
  amortization_kind      text not null check (amortization_kind in
                           ('interest_only','level_payment','custom')),
  level_payment_cents    bigint check (level_payment_cents > 0),

  --  Whether principal remains due at maturity. The AMOUNT is derived, not
  --  stored — see the header. This flag is a contractual fact; the dollar
  --  figure on the servicer's schedule is a projection.
  fully_amortizing       boolean not null default false,

  maturity_date          date,

  supersedes_term_id     uuid references debt_terms(id),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint debt_terms_effective_order check (
    effective_to is null or effective_to >= effective_from
  ),
  --  A fixed instrument states a rate; a floating one states a formula.
  constraint debt_terms_rate_shape check (
    (rate_kind = 'fixed'    and fixed_rate_bp is not null) or
    (rate_kind = 'floating' and rate_index_name is not null)
  ),
  --  A level-payment regime must carry its payment; an interest-only one
  --  must NOT, because there is no level payment to carry.
  constraint debt_terms_amortization_shape check (
    (amortization_kind = 'level_payment'  and level_payment_cents is not null) or
    (amortization_kind = 'interest_only'  and level_payment_cents is null) or
    (amortization_kind = 'custom')
  )
);

create index if not exists idx_debt_terms_instrument_effective
  on debt_terms (instrument_id, effective_from);

--  ── RESERVE REQUIREMENTS ───────────────────────────────────────────
--  What the INSTRUMENT REQUIRES. 4125 establishes four categories,
--  including a $1,110,703 COVID-19 debt service reserve that no servicing
--  statement shows — which is exactly why "not found in a monthly
--  statement" was never evidence of absence.
--
--  ⚠ THERE ARE NO BALANCE COLUMNS HERE, ON PURPOSE.
--  A tax escrow balance is the Tax domain's funding truth and an insurance
--  escrow balance is Insurance's. Debt may state that the loan REQUIRES the
--  escrow. It may not hold, author, or imply what is in the account. This
--  is not a Reserves & Escrows module and must not grow into one.
create table if not exists debt_reserve_requirements (
  id                     uuid primary key default gen_random_uuid(),
  instrument_id          uuid not null references debt_instruments(id) on delete restrict,

  reserve_kind           text not null check (reserve_kind in
                           ('tax_imposition','insurance_imposition',
                            'replacement','debt_service','other')),

  --  Null is legitimate: a reserve may be established without a governed
  --  amount in the source read. Unknown stays unknown, never zero.
  amount_cents           bigint check (amount_cents >= 0),
  amount_basis           text check (amount_basis in
                           ('monthly','annual','one_time','formula')),

  effective_from         date not null,
  effective_to           date,

  supersedes_requirement_id uuid references debt_reserve_requirements(id),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint debt_reserve_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_debt_reserve_instrument
  on debt_reserve_requirements (instrument_id, reserve_kind, effective_from);

--  ── BALANCE OBSERVATIONS ───────────────────────────────────────────
--  APPEND-ONLY DATED FACTS. Never updated, never deleted.
--
--  ⚠ THE CHECK CONSTRAINT ON observation_source IS A TRUTH WALL (W8).
--  A projection derived from the amortization schedule is NOT an
--  observation, and there is deliberately no enum value for one — so a
--  projected balance cannot be stored here and later read back as though
--  someone had observed it. Spine can compute $27,131,874.12 for
--  2026-08-01 from terms alone, with no evidence that any 2026 payment
--  occurred; presenting that as "the balance" asserts a payment history
--  the source cannot support.
--
--  This constraint is NECESSARY AND NOT SUFFICIENT. It stops the write.
--  It does not stop a read computing a projection and labelling it
--  "balance", so position() still gets a hostile proof for W8.
create table if not exists debt_balance_observations (
  id                     uuid primary key default gen_random_uuid(),
  instrument_id          uuid not null references debt_instruments(id) on delete restrict,

  observed_balance_cents bigint not null check (observed_balance_cents >= 0),

  --  ⚠ THE AS-OF IS PART OF THE TRUTH (W7). An observation is true as of a
  --  date, not now. 4125's newest retained statement is 2025-08-01.
  as_of_date             date not null,

  observation_source     text not null check (observation_source in
                           ('lender_statement','payoff_statement',
                            'borrower_record','audit_confirmation')),

  source_authority       text not null default 'governed_read'
                           check (source_authority in
                             ('governed_read','transcript_claim',
                              'email_claim','user_assertion')),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);

create index if not exists idx_debt_balance_instrument_asof
  on debt_balance_observations (instrument_id, as_of_date desc);

--  ── PAYMENT OBSERVATIONS ───────────────────────────────────────────
--  What a LENDER OR SERVICER OBSERVED about payment standing. This is not
--  a cash-settlement primitive and is deliberately not named `debt_payments`.
--  Four different facts stay distinct:
--
--      contractually due  ≠  cash left the bank
--                         ≠  the lender received it
--                         ≠  the lender applied it
--
--  The servicer's own statement already separates AMT DUE / AMT RECEIVED /
--  AMT REMAINING, plus the application split, so this table holds exactly
--  what the source states rather than a normalised invention.
--
--  ⚠ NO satisfies_requirement COLUMN. Requirements are DERIVED from terms,
--  so there is no canonical requirement row for such a reference to point
--  at, and creating one to satisfy the foreign key would drag this build
--  toward a payment engine.
create table if not exists debt_payment_observations (
  id                     uuid primary key default gen_random_uuid(),
  instrument_id          uuid not null references debt_instruments(id) on delete restrict,

  --  The date the source states this standing is true as of.
  observed_as_of         date not null,
  --  The period the amounts concern, where the source states one.
  period_start           date,
  period_end             date,

  amount_due_cents       bigint check (amount_due_cents >= 0),
  amount_received_cents  bigint check (amount_received_cents >= 0),
  amount_remaining_cents bigint check (amount_remaining_cents >= 0),

  applied_principal_cents bigint check (applied_principal_cents >= 0),
  applied_interest_cents  bigint check (applied_interest_cents >= 0),
  --  Escrow moving THROUGH the lender. Present so debt service can be
  --  separated from the total payment (W9), never so Debt can author what
  --  the escrow then paid.
  applied_escrow_cents    bigint check (applied_escrow_cents >= 0),
  applied_other_cents     bigint check (applied_other_cents >= 0),

  observation_source     text not null check (observation_source in
                           ('lender_statement','servicer_transaction_history',
                            'borrower_record')),

  source_authority       text not null default 'governed_read'
                           check (source_authority in
                             ('governed_read','transcript_claim',
                              'email_claim','user_assertion')),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint debt_payment_period_order check (
    period_end is null or period_start is null or period_end >= period_start
  )
);

create index if not exists idx_debt_payment_instrument_asof
  on debt_payment_observations (instrument_id, observed_as_of desc);
