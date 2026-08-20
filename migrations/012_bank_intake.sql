-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 012 — BANK INTAKE: vendor registry + transaction claims
--
--  THE ONBOARDING/TRAINING RUNG of the money layer (Phase 1). Validated
--  against the real Tower Place Sept 2025 package (Flagstar op 7539 +
--  capex 6225 statements, Yardi bank recs) BEFORE this was written.
--
--  The product rule this schema encodes:
--    bank transaction                          → CLAIM
--    claim + vendor/payee proof                → IDENTIFIED money movement
--    claim + GL/category proof (NEXT rung)     → reportable accounting line
--    anything missing proof                    → visible EXPOSURE (gross, not net)
--
--  What the validation gate proved (receipts in thread, Jun 10 2026):
--    • electronic bank lines carry payee strings → resolvable from description
--    • CHECK lines carry number+amount+date ONLY → NEVER guessable; they stay
--      claimed until joined to the Yardi check register (the rec answer key)
--    • the Yardi bank rec ties every check to a vendor CODE + name
--      (v0000501 - Stratton Amenities) → the vendor registry seeds itself
--    • GL name "Tower - Operating - NYCB" vs bank "Flagstar" → bank accounts
--      need their own alias row (second instance of the alias engine)
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  ledger row. NO transaction control, NO ledger insert here. Conventions
--  match 001/009/010/011 (uuid pk, timestamptz, CHECK vocab, gen_random_uuid).
-- ════════════════════════════════════════════════════════════════════

-- ── vendors ───────────────────────────────────────────────────────────
-- The canonical payee. Seeded from the property's own Yardi rec/check
-- register during onboarding (codes like v0000261 / tenant codes t0003768).
-- vendor_type is descriptive, never a silent branch; 'owner_affiliate' and
-- 'management' exist so the board can surface those flows to the owner.
create table if not exists vendors (
  id              uuid primary key default gen_random_uuid(),
  canonical_name  text not null,
  yardi_code      text,                              -- v0000xxx / t000xxxx; null for bank-only payees
  vendor_type     text not null default 'vendor'
                    check (vendor_type in
                      ('vendor','tenant','owner_affiliate','management','processor',
                       'utility','insurance','lender','bank','software','merchant','unknown')),
  created_at      timestamptz not null default now()
);
--  ⚠ TWO DOMAINS CLAIMED THE NAME `vendors`, AND `if not exists` HID IT.
--  001_baseline already creates a MAINTENANCE vendor
--  (id, name, trade, phone, email, preferred, insurance_status, note).
--  The `create table if not exists` above is therefore a SILENT NO-OP on any
--  database that ran 001 — the payee columns are never created — and the
--  index below then fails with `column "yardi_code" does not exist`,
--  stopping EVERY from-scratch build at this file. Measured, not inferred.
--
--  Fixed additively rather than by renaming either table: these three columns
--  are exactly what the declaration above intended, they are `if not exists`
--  so a database where 012 genuinely created the table is untouched, and no
--  data is read, written or moved. Whether the two `vendors` concepts should
--  eventually be separated is a real question and deliberately NOT answered
--  here — this only stops the chain being unbuildable.
alter table vendors add column if not exists canonical_name text;
alter table vendors add column if not exists yardi_code     text;
alter table vendors add column if not exists vendor_type    text not null default 'vendor';

create unique index if not exists uq_vendors_yardi_code
  on vendors (yardi_code) where yardi_code is not null;
create unique index if not exists uq_vendors_name_nocode
  on vendors (lower(canonical_name)) where yardi_code is null;

-- ── vendor_aliases ────────────────────────────────────────────────────
-- Second instance of the alias engine (twin of property_aliases, 011).
-- Every observed payee string a source uses → the canonical vendor.
-- vendor_id NULL = the unresolved queue (seen, never guessed).
--   source_system: bank_description | yardi_rec | check_register | human
create table if not exists vendor_aliases (
  id              uuid primary key default gen_random_uuid(),
  vendor_id       uuid references vendors(id),       -- nullable: unresolved queue
  source_system   text not null
                    check (source_system in ('bank_description','yardi_rec','check_register','human')),
  alias_value     text not null,                     -- NORMALIZED token (upper, single-spaced)
  property_id     uuid references properties(id),    -- nullable: most payee aliases are portfolio-wide
  note            text,
  created_at      timestamptz not null default now(),
  unique (source_system, alias_value)
);
create index if not exists idx_vendor_aliases_vendor on vendor_aliases(vendor_id);

-- ── bank_accounts ─────────────────────────────────────────────────────
-- The account identity row. Carries BOTH names observed in the real data:
-- the bank's current name (Flagstar) and the GL's historical name
-- ("Tower - Operating - NYCB") — the alias problem at the account level.
create table if not exists bank_accounts (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references properties(id),
  account_label   text not null,                     -- yardi label: tower_op / tower_ca
  account_last4   text not null,                     -- 7539 / 6225
  bank_name       text not null,                     -- Flagstar
  gl_name         text,                              -- Tower - Operating - NYCB
  account_role    text not null default 'operating'
                    check (account_role in ('operating','capex','escrow','security_deposit','other')),
  created_at      timestamptz not null default now(),
  unique (property_id, account_last4)
);
create index if not exists idx_bank_accounts_property on bank_accounts(property_id);

-- ── bank_transactions ─────────────────────────────────────────────────
-- One row per bank statement line, staged as a CLAIM. Signed amount:
-- positive = credit (money in), negative = debit (money out).
-- status vocabulary is deliberately SHORT for this rung:
--   claimed     — on the statement, payee NOT proven (the exposure bucket)
--   identified  — payee proven (bank description alias OR check-register join)
--   report_ready — RESERVED for the next rung (GL/category proof). No route
--                  in this rung may set it; the board reports it as 0.
-- exception_reason is a FLAG, not a status — an identified Spotify charge is
-- both identified AND an exception the owner should see.
create table if not exists bank_transactions (
  id                     uuid primary key default gen_random_uuid(),
  bank_account_id        uuid not null references bank_accounts(id),
  txn_date               date not null,
  description            text not null,              -- the literal bank string
  amount                 numeric(14,2) not null,     -- signed: + in, − out
  txn_type               text not null
                           check (txn_type in
                             ('check','check_return','ach','wire','card','deposit','fee','other')),
  check_number           text,                       -- checks only
  status                 text not null default 'claimed'
                           check (status in ('claimed','identified','report_ready')),
  vendor_id              uuid references vendors(id),
  identification_source  text
                           check (identification_source in
                             ('bank_description','check_register_join','human')),
  exception_reason       text
                           check (exception_reason in
                             ('possible_non_property_spend','composite_batch','rejected_check',
                              'ambiguous_payee','amount_mismatch','affiliate_transfer')),
  source_document        text,                       -- provenance: which statement file
  created_at             timestamptz not null default now()
);
-- idempotency: re-staging the same statement inserts nothing twice
create unique index if not exists uq_bank_txn_natural
  on bank_transactions (bank_account_id, txn_date, description, amount);
create index if not exists idx_bank_txn_account_status
  on bank_transactions (bank_account_id, status);

-- ── check_register_orphans ────────────────────────────────────────────
-- Register rows (Yardi rec) that did NOT match a statement line: outstanding
-- checks and prior-period clears. Kept so the property board can tell
-- cross-account stories — the real case: Check 1151 ($27,700) rejected twice
-- in the CAPEX account while register check 1977 to Hesta Renovations for
-- the SAME $27,700 sits outstanding in OPERATING. A human skimming two PDFs
-- misses that; the board must not.
create table if not exists check_register_orphans (
  id              uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references bank_accounts(id),
  check_number    text not null,
  payee_name      text not null,
  yardi_code      text,
  amount          numeric(14,2) not null,            -- positive magnitude
  reason          text not null
                    check (reason in ('not_on_statement','ambiguous_check_number')),
  created_at      timestamptz not null default now(),
  unique (bank_account_id, check_number, amount)
);
