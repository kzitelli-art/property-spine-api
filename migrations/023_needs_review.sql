-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 023 — NEEDS_REVIEW (the parked state)
--
--  "I don't know yet — park it with a note" as a STATE, not an absence.
--  Today the human queue mixes two truths: lines nobody has looked at,
--  and lines a human looked at and got stuck on. The live Teams research
--  (Jun 2026) showed the real operation already runs on this state —
--  Josephine's weekly Accounting Catch-Up docs ARE parked items with
--  notes, hand-typed, with no trail. This makes that structural.
--
--  THE PRODUCT RULE:
--    parked ≠ resolved. A parked line LEAVES the work queue and ENTERS
--    its own visible block, but its gross NEVER leaves unproven
--    exposure. Parking annotates; only proof resolves.
--
--  ANTI-MARK MECHANISM: gross unproven exposure must be IDENTICAL
--  before and after parking. An empty human queue with parked items can
--  never read as done. Enforcement lives in bankbridge.js (board math);
--  these columns are the durable home of the CURRENT state, and the
--  events table carries the park/unpark trail (txn_parked /
--  txn_unparked / txn_park_note_updated — same pattern as
--  payment_return_paired in slice 2).
--
--  Three columns, not a status change: the closed status vocabulary
--  (claimed | identified | report_ready) stays untouched — parking is
--  ORTHOGONAL to proof state. A claimed line and an identified line can
--  both be parked; neither is any more proven for it.
--
--  parked = (parked_at is not null). Unpark clears all three.
--  Bridging a parked line clears them too (resolution IS the unpark).
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records
--  the ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════

alter table bank_transactions
  add column if not exists parked_at timestamptz,
  add column if not exists parked_by_person_id uuid references persons(id),
  add column if not exists parked_note text;

-- the parked board reads by property via bank_accounts; this keeps the
-- "show me everything parked" read cheap as transaction volume grows
create index if not exists idx_bank_txn_parked
  on bank_transactions (bank_account_id)
  where parked_at is not null;
