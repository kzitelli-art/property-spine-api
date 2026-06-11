-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 021 — PAYMENT_RETURN EXCEPTION CLASS
--
--  The Virtus rule (Jun 11 2026): six bank debits reading "External
--  Withdrawal VIRTUSMANAGEMENT - Return ..." were not expenses at all —
--  they decomposed to the cent into Yardi RC tenant-return entries. The
--  descriptor names the PROCESSOR, not the counterparty. A payment
--  clawback is revenue moving backward and must NEVER be bookable as an
--  expense — no category, no acknowledgement override.
--
--  012 created exception_reason with a closed six-value vocabulary; the
--  first live backfill run proved it (check-constraint violation, loud
--  and clean, nothing partially written). This migration widens the
--  vocabulary by exactly one value. Detection lives in bankintake.js;
--  the 409 hard block lives in bankbridge.js; the findings home is the
--  categorization board's payment_returns block.
-- ════════════════════════════════════════════════════════════════════

alter table bank_transactions
  drop constraint if exists bank_transactions_exception_reason_check;

alter table bank_transactions
  add constraint bank_transactions_exception_reason_check
  check (exception_reason in
    ('possible_non_property_spend','composite_batch','rejected_check',
     'ambiguous_payee','amount_mismatch','affiliate_transfer',
     'payment_return'));
