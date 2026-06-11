-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 022 — RC PAIRINGS (payment_return rung, slice 2)
--
--  The golden set (Jun 11 2026, real Tower Place bank recs): 5 of 6
--  payment_return bank lines tie per-line to Yardi RC tenant-return
--  entries — 1:1, N:1 batch (9/03 $3,610.00 = RC 96654+97059+97071),
--  and cross-month (10/06 bank line ↔ RC 99047 on the October rec).
--  One line (9/11 $100.00) has NO book entry anywhere — the orphan.
--
--  THE PRODUCT RULE this table encodes:
--    payment_return bank line            → flagged finding (slice 1, live)
--    + proposed RC entries               → a PAIRING CLAIM (this slice)
--    + human confirm, sums to the cent   → paired, explained
--    no confirmed pairing                → UNPAIRED EXPOSURE on the board
--    (the orphan stays exposure — it never vanishes, never nets)
--
--  ANTI-MARK MECHANISM: confirm is refused unless proposed entries sum
--  to the bank line EXACTLY, in integer cents. A 2-of-3 batch can never
--  read as done. Enforcement lives in bankbridge.js; this table is the
--  durable home.
--
--  One row per (bank return line, RC entry). N:1 batches are N rows.
--  rc_date is just data — cross-month needs no special handling.
--  repay_transaction_id models the return→re-pay link PER ROW (the
--  t0005237 case: $1,938.38 return, $1,938.38 CHECKscan re-pay), so
--  each tenant in a batch can re-pay separately.
--
--  Status vocabulary:
--    proposed  — drafted, replaceable, proves nothing
--    confirmed — human-confirmed, sum-gated; the only state that pairs
--    rejected  — was confirmed, then unpaired; kept for the trail
--  The unique index excludes 'rejected' so an unpaired RC can be
--  re-proposed without losing the history of the first attempt.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records
--  the ledger row. NO transaction control, NO ledger insert here.
--  Conventions match 012/021 (uuid pk, timestamptz, CHECK vocab).
-- ════════════════════════════════════════════════════════════════════

create table if not exists rc_pairings (
  id                      uuid primary key default gen_random_uuid(),
  bank_transaction_id     uuid not null references bank_transactions(id),
  rc_number               text not null,                 -- Yardi RC entry id, e.g. '96654'
  rc_date                 date not null,                 -- the RC entry's date (may be cross-month)
  tenant_code             text,                          -- t0004562; nullable = honest blank, never invented
  amount                  numeric(14,2) not null
                            check (amount > 0),          -- positive magnitude of this RC entry
  status                  text not null default 'proposed'
                            check (status in ('proposed','confirmed','rejected')),
  repay_transaction_id    uuid references bank_transactions(id),  -- the re-pay credit line, if observed
  confirmed_by_person_id  uuid references persons(id),
  confirmed_at            timestamptz,
  note                    text,
  created_at              timestamptz not null default now()
);

-- one live row per (bank line, RC entry); rejected rows keep the trail
-- without blocking a re-propose
create unique index if not exists uq_rc_pairings_live
  on rc_pairings (bank_transaction_id, rc_number)
  where status <> 'rejected';

create index if not exists idx_rc_pairings_txn
  on rc_pairings (bank_transaction_id, status);
