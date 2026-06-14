-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 037 — PAYMENT PROOF: the three layers of collected income
--
--  Slice 3. Slice 1 built the charge ledger (the CLAIM: what is owed).
--  This builds the PROOF: that billed rent became collected cash. The
--  doctrine distinction this rung exists to enforce —
--
--    Payment applied to a charge   = COLLECTED CLAIM ("someone says paid").
--    Payment tied to a bank deposit = CASH-PROVEN ("the bank confirms it").
--
--  NOI's proven income requires BOTH, except a trusted processor settlement
--  that carries its own proof trail. A tenant can claim they paid; a manager
--  can key a payment; a processor can report one — but the strongest proof is
--  still cash hitting the bank. Applying a payment must NOT instantly make NOI
--  real, or we'd be proving "someone said tenant paid," not "cash collected."
--
--  THREE LAYERS (each a table; kept SEPARATE on purpose):
--
--    1. payments — the payment-event CLAIM. A tenant/payer paid an amount on
--       a date by some method. Source can be processor, manual, import, check,
--       cash, or bank_match. This is a claim until proven; it is NOT itself
--       the bank record.
--
--    2. payment_applications — the TIE table (charge ↔ payment, many-to-many).
--       One payment can cover several charges (rent + late fee in one check);
--       one charge can be covered by several payments (partials). Each row is
--       an amount_applied, signed by a human (confirmed_by / confirmed_at).
--       This is the ONLY thing that moves scheduled_charges.amount_paid — and
--       the app layer does that write atomically when an application is made.
--
--    3. payment_bank_links — the CASH-PROOF layer. Ties a payment to the real
--       bank_transactions row (a deposit/inflow) that proves the cash landed.
--       One deposit can prove one payment or a batch (link rows are per
--       payment). This is where Plaid eventually lands — it just becomes
--       another way bank_transactions get created and linked.
--
--  GROSS NEVER NET; THE SAME DOLLAR NEVER COUNTED TWICE:
--    • sum(payment_applications.amount_applied) for a payment must not exceed
--      the payment's amount — enforced in the app layer (a check would need a
--      trigger; the app guards it and we keep the schema honest with indexes).
--    • amount_applied > 0 (a non-positive application is meaningless).
--    • a payment can link to a bank txn at most once (unique) — no double cash
--      proof from one deposit row for the same payment.
--
--  REUSE, DON'T FORK: the cash side ties to the EXISTING bank_transactions
--  table (012) — the same rows the expense bridge uses. A rent deposit is a
--  positive-amount bank_transactions row (txn_type 'deposit'/'ach'). We do not
--  create a parallel deposits table.
--
--  VOCABULARIES are app-layer (no DB CHECK), matching the precedent of the
--  category (007), module (035), and charge (036) vocabularies — so they can
--  evolve without a migration:
--    payment.method : processor | manual | check | cash | ach | import | bank_match
--    payment.status : claimed | applied | partially_applied | cash_proven | void
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  ledger row. NO transaction control, NO ledger insert here. Conventions
--  match prior migrations (uuid pk, timestamptz, gen_random_uuid).
-- ════════════════════════════════════════════════════════════════════

-- ── 1) payments — the payment-event CLAIM ──────────────────────────────
create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,
  person_id     uuid references persons(id) on delete set null,   -- the payer, when known
  lease_id      uuid references leases(id) on delete set null,    -- the lease, when known

  amount        numeric(14,2) not null,        -- gross amount the payer paid
  paid_date     date not null,                 -- when the payer says it was paid
  method        text not null default 'manual',
                  -- processor | manual | check | cash | ach | import | bank_match
  reference     text,                          -- check #, processor txn id, memo

  status        text not null default 'claimed',
                  -- claimed | applied | partially_applied | cash_proven | void

  -- a trusted processor settlement carries its OWN proof trail; mark it so the
  -- income read can treat it as cash-proven without a separate bank link.
  processor_settled boolean not null default false,

  source        text not null default 'manual',  -- where the record came from
  source_ref    text,                            -- provenance receipt

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint payments_amount_positive check (amount > 0)
);
create index if not exists idx_payments_property on payments(property_id);
create index if not exists idx_payments_person   on payments(person_id);
create index if not exists idx_payments_lease    on payments(lease_id);
create index if not exists idx_payments_status   on payments(property_id, status);

-- ── 2) payment_applications — the TIE (charge ↔ payment) ───────────────
create table if not exists payment_applications (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references payments(id) on delete cascade,
  scheduled_charge_id uuid not null references scheduled_charges(id) on delete cascade,

  amount_applied     numeric(14,2) not null,   -- how much of the payment hits this charge

  -- the human signature: an application is a CONFIRMED act, not a guess.
  confirmed_by       uuid references users(id) on delete set null,
  confirmed_at       timestamptz not null default now(),

  created_at         timestamptz not null default now(),

  constraint payment_applications_amount_positive check (amount_applied > 0),
  -- a given payment may apply to a given charge only once (combine into one row)
  unique (payment_id, scheduled_charge_id)
);
create index if not exists idx_payment_apps_payment on payment_applications(payment_id);
create index if not exists idx_payment_apps_charge  on payment_applications(scheduled_charge_id);

-- ── 3) payment_bank_links — the CASH-PROOF layer ───────────────────────
create table if not exists payment_bank_links (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references payments(id) on delete cascade,
  bank_transaction_id uuid not null references bank_transactions(id) on delete cascade,

  -- how much of the bank deposit this link attributes to this payment (a
  -- batch deposit covering several payments splits across link rows).
  amount_matched     numeric(14,2),

  confirmed_by       uuid references users(id) on delete set null,
  confirmed_at       timestamptz not null default now(),

  created_at         timestamptz not null default now(),

  -- one payment ↔ one bank txn at most once (no double cash proof)
  unique (payment_id, bank_transaction_id)
);
create index if not exists idx_payment_bank_payment on payment_bank_links(payment_id);
create index if not exists idx_payment_bank_txn     on payment_bank_links(bank_transaction_id);
