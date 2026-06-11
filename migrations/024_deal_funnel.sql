-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 024 — DEAL NAMES (the bigger funnel)
--
--  The intake door (015) works one deal at a time. The next move is
--  7–8 real deals through it at once — and eight unnamed deal_intakes
--  rows are indistinguishable on any board. One column: a human-given
--  deal name, set at creation ("4233 Chestnut", "Greenery", "MSC
--  takeover"). The DEAL is the unit of acquisition (a deal can hold
--  multiple properties); the name names the deal, not a property —
--  identity still resolves per file through the registry, never from
--  this label.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records
--  the ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════

alter table deal_intakes
  add column if not exists deal_name text;
