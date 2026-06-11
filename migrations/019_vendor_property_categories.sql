-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 019 — PER-PROPERTY VENDOR CATEGORY RULES
--
--  vendors.default_category is GLOBAL: teaching "Virtus → management_fee"
--  for Tower Place teaches it for every property that ever pays Virtus.
--  That is wrong the moment the second property onboards (4233 is next):
--  the same vendor can legitimately be a different report line at a
--  different asset (one property's landscaper is another's capex crew).
--
--  This table lets a property OVERRIDE the global default. Resolution
--  order, applied at read time, never stored:
--
--      explicit category on the confirm call   (always wins — the human)
--    > property rule                            (this table)
--    > global default                           (vendors.default_category)
--
--  Hard rules carried forward:
--    • Teaching changes PROPOSALS only. No row in this table ever creates
--      a money_event. The human confirm remains the only birth path.
--    • The category vocabulary stays DATA: values are validated against
--      category_report_map at the app layer (007 §1b precedent), so the
--      vocabulary can evolve without touching this table.
--    • One rule per (vendor, property) — an upsert target, not a history.
--      Clearing a rule deletes the row; the global default resumes.
--
--  Run AFTER 017 (vendors table must exist). Idempotent.
-- ════════════════════════════════════════════════════════════════════

create table if not exists vendor_property_categories (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references vendors(id),
  property_id      uuid not null references properties(id),
  default_category text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint vendor_property_categories_one_rule unique (vendor_id, property_id)
);

-- the read pattern: all rules for a property (board), one rule for a pair (bridge)
create index if not exists ix_vpc_property
  on vendor_property_categories (property_id);
