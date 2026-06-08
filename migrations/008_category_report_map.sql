-- ============================================================
-- 008_category_report_map.sql
--
-- The mapping layer for Money Report Read v1.
-- Report SHAPE is DATA, not code. Refined against the Tower Place T12 /
-- monthly cash-flow structure (not the generic skeleton).
--
-- Input vocabulary = ONLY the categories money.js proposeCategory() emits today:
--   capital_expenditure, tenant_billback, operating_supplies,
--   repairs_maintenance, turnover, uncategorized
--
-- The Tower shape has richer lines (Payroll, Taxes & Insurance, Utilities,
-- Building Services, Admin & General, Advertising). Those have NO category
-- yet, so they are NOT seeded here — they live in the endpoint's section
-- skeleton and render as $0 until a category produces them. The gap is
-- visible by design, never faked.
--
-- 'uncategorized' is DELIBERATELY left unmapped — must surface in
-- unmapped_categories so the needs-review path is provable.
--
-- Idempotent: safe to run more than once.
-- ============================================================

CREATE TABLE IF NOT EXISTS category_report_map (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmed_category text NOT NULL UNIQUE,
  report_section     text NOT NULL,
  report_line        text NOT NULL,
  sort_order         integer NOT NULL DEFAULT 100,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Seed rows, mapped onto the Tower T12 section/line names.
-- sort_order encodes the Tower report ordering (Income < OpEx < below-NOI).
INSERT INTO category_report_map (confirmed_category, report_section, report_line, sort_order) VALUES
  ('tenant_billback',     'Income',             'Billbacks / Utility Income', 13),
  ('repairs_maintenance', 'Operating Expenses', 'Repair & Maintenance',       24),
  ('operating_supplies',  'Operating Expenses', 'Repair & Maintenance',       24),
  ('turnover',            'Operating Expenses', 'Repair & Maintenance',       24),
  ('capital_expenditure', 'Capital Expenditures', 'CapEx',                    60)
ON CONFLICT (confirmed_category) DO UPDATE
  SET report_section = EXCLUDED.report_section,
      report_line    = EXCLUDED.report_line,
      sort_order     = EXCLUDED.sort_order;

-- NOTE: 'uncategorized' intentionally NOT inserted (must hit unmapped_categories).
--
-- Tower lines with no category yet (rendered $0 by the endpoint skeleton, not seeded):
--   Income:            Residential Rent (lives in revenue tables, not money_events), Other Income
--   Operating Expenses: Payroll, Taxes & Insurance, Utilities,
--                       Building Services / Contracted Services,
--                       Administration & General, Advertising & Marketing
--   Below NOI:         Debt Service / Interest, Depreciation / Amortization
