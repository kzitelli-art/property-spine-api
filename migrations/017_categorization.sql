-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 017 — THE CATEGORIZATION RUNG
--
--  Widens the category vocabulary so bank-proven money can become
--  reportable accounting lines. Four changes, all ADDITIVE and IDEMPOTENT:
--
--    1. DEFENSIVE CONSTRAINT SCAN — Rule #11 executed by the migration
--       itself. At RUN TIME, scan pg_constraint for any CHECK on
--       money_events whose definition mentions confirmed_category or
--       source_kind, and drop what is found BY ITS DISCOVERED NAME.
--       Vocabulary enforcement lives at the app layer (the 007 §1b
--       precedent: "the list can evolve without a migration"). If no
--       such constraint exists — the expected case — this is a no-op.
--
--    2. SEVEN new category_report_map rows. Each lands on a skeleton
--       line that ALREADY renders at $0 in report-read — these inserts
--       are the fulfillment of the 008 comment block ("Tower lines with
--       no category yet"). Section/line strings are byte-for-byte the
--       skeleton strings in money.js. 'uncategorized' stays unmapped
--       forever (the needs-review path must remain provable).
--
--    3. vendors.default_category — the PECO→utilities knowledge. A
--       property of the VENDOR, not the transaction. NULL is meaningful:
--       NULL = no auto-proposal = the Amazon-class human queue. Amazon
--       stays NULL forever; every Amazon charge queues. That queue IS
--       the product thesis.
--
--    4. bank_transactions.money_event_id — the bridged marker. NULL =
--       unbridged. Makes double-bridging STRUCTURALLY impossible rather
--       than procedurally avoided.
--
--  Run AFTER 016, through the repo + migrate.js. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) defensive scan: drop any CHECK touching confirmed_category /
--       source_kind, whatever it is named in the LIVE database ─────────
do $$
declare c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'money_events'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ~* '(confirmed_category|source_kind)'
  loop
    execute format('alter table money_events drop constraint %I', c.conname);
    raise notice 'dropped % — vocabulary moves to the app layer (007 §1b precedent)', c.conname;
  end loop;
end $$;

-- ── 2) widen the report vocabulary: 7 new categories → existing
--       skeleton lines. sort_order follows the Tower T12 ordering
--       (008 used 13 / 24 / 60; these slot around them). ───────────────
INSERT INTO category_report_map (confirmed_category, report_section, report_line, sort_order) VALUES
  ('payroll',             'Operating Expenses',      'Payroll',                                 21),
  ('taxes_insurance',     'Operating Expenses',      'Taxes & Insurance',                       22),
  ('utilities',           'Operating Expenses',      'Utilities',                               23),
  ('contracted_services', 'Operating Expenses',      'Building Services / Contracted Services', 25),
  ('admin_general',       'Operating Expenses',      'Administration & General',                26),
  ('advertising',         'Operating Expenses',      'Advertising & Marketing',                 27),
  ('debt_service',        'Debt Service / Interest', 'Debt Service / Interest',                 70)
ON CONFLICT (confirmed_category) DO UPDATE
  SET report_section = EXCLUDED.report_section,
      report_line    = EXCLUDED.report_line,
      sort_order     = EXCLUDED.sort_order;

-- NOTE: 'uncategorized' intentionally still NOT inserted.
-- The existing 6 categories (008) are untouched.

-- ── 3) the vendor→category knowledge column ─────────────────────────
-- Plain text, NO check constraint (app validates against
-- category_report_map — the vocabulary is DATA). NULL = human queue.
alter table vendors add column if not exists default_category text;

-- ── 4) the bridged marker ────────────────────────────────────────────
alter table bank_transactions
  add column if not exists money_event_id uuid references money_events(id);

-- find bridged lines fast (board "bridged so far" tile)
create index if not exists ix_bank_txn_money_event
  on bank_transactions (money_event_id) where money_event_id is not null;

-- find BRIDGEABLE lines fast (the categorization board's main read)
create index if not exists ix_bank_txn_bridgeable
  on bank_transactions (bank_account_id)
  where status = 'identified' and money_event_id is null;
