-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 031 — PLAID ITEMS: the linked-bank-connection memory
--
--  Fills the open 031 slot. Plaid is NOT a new bank pipeline — it is a
--  SECOND FEED into the bank_transactions claim table built in 012. The
--  manual path (PDF → typed lines → POST /bank/accounts/:id/transactions)
--  stays exactly as-is; Plaid pulls the same lines from the bank API and
--  lands them in the same door. Everything downstream — payee
--  identification, exposure math, the activation surface — already works
--  the moment a row lands. See bankintake.js for the receiving contract.
--
--  This migration adds the ONE thing the manual path never needed:
--  somewhere to remember a live connection between syncs.
--
--    plaid_item       → one linked bank login (the Plaid "Item"): the
--                       access_token we exchange once, plus the sync
--                       cursor so each pull only fetches what is new.
--    plaid_account    → the bank sub-accounts Plaid reports under that
--                       login, each mapped to OUR bank_accounts row so a
--                       Plaid transaction knows which account it belongs to.
--
--  WHAT THIS SCHEMA DELIBERATELY DOES NOT DO:
--    • No raw-Plaid-transaction table. Plaid txns are normalized in JS and
--      inserted straight into bank_transactions (idempotent there already).
--      A second copy would be the same dollar in two places — forbidden.
--    • No status/identification columns. Those live on bank_transactions.
--      This table only remembers the CONNECTION, never the money.
--
--  CREDENTIALS NOTE: the Plaid access_token is a live credential. It is
--  stored here because the server must use it to call Plaid on a schedule;
--  it is never returned to the browser by any read endpoint (the module
--  enforces this). client_id / secret are NEVER stored in the DB — they
--  live in Render env vars (PLAID_CLIENT_ID / PLAID_SECRET), same shape as
--  the Twilio keys.
--
--  Conventions match 012 (uuid pk, timestamptz, CHECK vocab,
--  gen_random_uuid). migrate.js owns the transaction + ledger row — NO
--  transaction control and NO ledger insert in this file.
-- ════════════════════════════════════════════════════════════════════

-- ── plaid_item ────────────────────────────────────────────────────────
-- One linked bank login. item_id is Plaid's stable identifier for the
-- connection; access_token is the credential we exchanged the one-time
-- public_token for. status tracks the connection's health so a revoked or
-- errored login surfaces instead of silently going stale.
create table if not exists plaid_item (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references properties(id),
  item_id         text not null,                     -- Plaid Item id (stable per connection)
  access_token    text not null,                     -- exchanged credential; server-only, never read to browser
  institution_id  text,                              -- Plaid institution id (e.g. ins_109508)
  institution_name text,                             -- human label ("Chase", "KeyBank")
  sync_cursor     text,                              -- Plaid /transactions/sync cursor; null = never synced
  status          text not null default 'active'
                    check (status in ('active','login_required','error','revoked')),
  last_synced_at  timestamptz,
  last_error      text,                              -- last Plaid error code/message, if any
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (item_id)
);
create index if not exists idx_plaid_item_property on plaid_item(property_id);

-- ── plaid_account ─────────────────────────────────────────────────────
-- The bank sub-accounts Plaid reports under one login (checking, savings,
-- etc.). Each maps to OUR bank_accounts row (012). bank_account_id is
-- nullable on purpose: Plaid reports the account the instant the login is
-- linked, but the operator may not have mapped it to a known bank_accounts
-- row yet — an unmapped Plaid account is the "seen, not yet tied" queue,
-- the same seen-never-guessed discipline the vendor alias queue uses.
-- A transaction from an unmapped account cannot be staged until tied.
create table if not exists plaid_account (
  id                uuid primary key default gen_random_uuid(),
  plaid_item_id     uuid not null references plaid_item(id) on delete cascade,
  account_id        text not null,                   -- Plaid account_id (stable per account)
  name              text,                            -- Plaid-reported name ("Plaid Checking")
  official_name     text,
  mask              text,                            -- last 4 ("0000") — matches bank_accounts.account_last4
  subtype           text,                            -- checking / savings / etc. (descriptive)
  bank_account_id   uuid references bank_accounts(id),-- nullable: unmapped = not yet tied to a known account
  created_at        timestamptz not null default now(),
  unique (plaid_item_id, account_id)
);
create index if not exists idx_plaid_account_item on plaid_account(plaid_item_id);
create index if not exists idx_plaid_account_bank on plaid_account(bank_account_id);
