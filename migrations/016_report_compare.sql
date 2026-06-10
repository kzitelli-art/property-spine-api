-- ============================================================
-- 016_report_compare.sql
--
-- THE COMPARISON LAYER (the Phase-1 hook): their actual report,
-- imported as line claims, compared against our recreated
-- report-read. Third instance of the alias engine:
--   registry (properties) -> vendor_aliases (payees) -> report_line_aliases (their P&L labels)
--
-- THEIR fine lines (Electric, HVAC Repairs, Legal Fees...) roll up to
-- OUR skeleton lines (Utilities, Repair & Maintenance, Admin & General...)
-- via report_line_aliases. Mapping is DATA, never code. Unmatched labels
-- stay unmatched (needs_mapping) — never fuzzy-merged, never guessed.
--
-- compare_mode per label:
--   'cash'       -> compared against report_ready money_events
--   'non_cash'   -> accrual construct (depreciation, loss-to-lease...) — declared, never compared
--   'revenue_v2' -> income lives in revenue tables, not read in v1 — declared, never compared
--
-- Seeds below come from the REAL Tower Place + 4233 Chestnut October 2025
-- budget comparisons (read Jun 10 2026), not invented labels.
-- Idempotent. No BEGIN/COMMIT (migrate.js owns the transaction + ledger).
-- ============================================================

CREATE TABLE IF NOT EXISTS report_line_aliases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label_norm     text NOT NULL UNIQUE,          -- lower(trim(label))
  label_raw      text NOT NULL,
  report_section text NOT NULL,
  report_line    text NOT NULL,
  compare_mode   text NOT NULL DEFAULT 'cash'
                 CHECK (compare_mode IN ('cash','non_cash','revenue_v2')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_imports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES properties(id),
  month        date NOT NULL,                   -- first of month
  source_label text NOT NULL,                   -- e.g. 'Tower Oct 2025 monthly package'
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_import_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id      uuid NOT NULL REFERENCES report_imports(id) ON DELETE CASCADE,
  label_raw      text NOT NULL,
  label_norm     text NOT NULL,
  amount         numeric NOT NULL,
  -- resolution SNAPSHOT at import time (so later alias edits don't silently
  -- rewrite history — re-import to re-resolve):
  report_section text,                          -- null = unmatched label
  report_line    text,
  compare_mode   text
);

CREATE INDEX IF NOT EXISTS idx_report_import_lines_import
  ON report_import_lines (import_id);

-- ---------- SEED: real labels -> skeleton lines ----------
INSERT INTO report_line_aliases (label_norm, label_raw, report_section, report_line, compare_mode) VALUES
-- Operating Expenses -> Payroll
('payroll','Payroll','Operating Expenses','Payroll','cash'),
-- Operating Expenses -> Taxes & Insurance
('property taxes','Property Taxes','Operating Expenses','Taxes & Insurance','cash'),
('property insurance','Property Insurance','Operating Expenses','Taxes & Insurance','cash'),
('city/local taxes','City/Local Taxes','Operating Expenses','Taxes & Insurance','cash'),
-- Operating Expenses -> Utilities
('electric','Electric','Operating Expenses','Utilities','cash'),
('electricity - common area','Electricity - Common Area','Operating Expenses','Utilities','cash'),
('electricity - occupied','Electricity - Occupied','Operating Expenses','Utilities','cash'),
('gas','Gas','Operating Expenses','Utilities','cash'),
('water and sewer','Water and Sewer','Operating Expenses','Utilities','cash'),
('internet','Internet','Operating Expenses','Utilities','cash'),
('telephone','Telephone','Operating Expenses','Utilities','cash'),
('trash disposal','Trash Disposal','Operating Expenses','Utilities','cash'),
-- Operating Expenses -> Repair & Maintenance
('general r&m','General R&M','Operating Expenses','Repair & Maintenance','cash'),
('materials and supplies','Materials and Supplies','Operating Expenses','Repair & Maintenance','cash'),
('appliance repairs','Appliance Repairs','Operating Expenses','Repair & Maintenance','cash'),
('turnover expenses','Turnover Expenses','Operating Expenses','Repair & Maintenance','cash'),
('labor - cleaning','Labor - Cleaning','Operating Expenses','Repair & Maintenance','cash'),
('materials - cleaning','Materials - Cleaning','Operating Expenses','Repair & Maintenance','cash'),
('hvac repairs','HVAC Repairs','Operating Expenses','Repair & Maintenance','cash'),
('electrical repairs','Electrical Repairs','Operating Expenses','Repair & Maintenance','cash'),
('painting','Painting','Operating Expenses','Repair & Maintenance','cash'),
('plumbing','Plumbing','Operating Expenses','Repair & Maintenance','cash'),
('cleaning - turnover','Cleaning - Turnover','Operating Expenses','Repair & Maintenance','cash'),
('elevator repairs','Elevator Repairs','Operating Expenses','Repair & Maintenance','cash'),
('furniture, fixtures and equipment','Furniture, Fixtures and Equipment','Operating Expenses','Repair & Maintenance','cash'),
-- Operating Expenses -> Building Services / Contracted Services
('building cleaning contract','Building Cleaning Contract','Operating Expenses','Building Services / Contracted Services','cash'),
('extermination','Extermination','Operating Expenses','Building Services / Contracted Services','cash'),
('property management fees','Property Management Fees','Operating Expenses','Building Services / Contracted Services','cash'),
('snow removal','Snow Removal','Operating Expenses','Building Services / Contracted Services','cash'),
('landscaping','Landscaping','Operating Expenses','Building Services / Contracted Services','cash'),
('fire alarm service','Fire Alarm Service','Operating Expenses','Building Services / Contracted Services','cash'),
('elevator contract','Elevator Contract','Operating Expenses','Building Services / Contracted Services','cash'),
('security services','Security Services','Operating Expenses','Building Services / Contracted Services','cash'),
('parking garage','Parking Garage','Operating Expenses','Building Services / Contracted Services','cash'),
('hvac contract','HVAC Contract','Operating Expenses','Building Services / Contracted Services','cash'),
('meter reading service','Meter Reading Service','Operating Expenses','Building Services / Contracted Services','cash'),
('leasing commissions','Leasing Commissions','Operating Expenses','Building Services / Contracted Services','cash'),
('leasing commissions - moore','Leasing Commissions - Moore','Operating Expenses','Building Services / Contracted Services','cash'),
('concierge and amenities','Concierge and Amenities','Operating Expenses','Building Services / Contracted Services','cash'),
-- Operating Expenses -> Administration & General
('general office','General Office','Operating Expenses','Administration & General','cash'),
('accounting fees','Accounting Fees','Operating Expenses','Administration & General','cash'),
('postage','Postage','Operating Expenses','Administration & General','cash'),
('bank fees and service charges','Bank Fees and Service Charges','Operating Expenses','Administration & General','cash'),
('software','Software','Operating Expenses','Administration & General','cash'),
('licenses and permits','Licenses and Permits','Operating Expenses','Administration & General','cash'),
('legal fees','Legal Fees','Operating Expenses','Administration & General','cash'),
('locks & lockboxes','Locks & Lockboxes','Operating Expenses','Administration & General','cash'),
('dropbox','Dropbox','Operating Expenses','Administration & General','cash'),
('miscellaneous office supplies','Miscellaneous Office Supplies','Operating Expenses','Administration & General','cash'),
('miscellaneous expenses','Miscellaneous Expenses','Operating Expenses','Administration & General','cash'),
('travel expenses','Travel Expenses','Operating Expenses','Administration & General','cash'),
('other professional fees','Other Professional Fees','Operating Expenses','Administration & General','cash'),
-- Operating Expenses -> Advertising & Marketing
('website','Website','Operating Expenses','Advertising & Marketing','cash'),
('online advertisement','Online Advertisement','Operating Expenses','Advertising & Marketing','cash'),
('resident events','Resident Events','Operating Expenses','Advertising & Marketing','cash'),
('other marketing costs','Other Marketing Costs','Operating Expenses','Advertising & Marketing','cash'),
-- Below NOI -> Debt Service / Interest
('mortgage interest','Mortgage Interest','Debt Service / Interest','Debt Service / Interest','cash'),
('mezzanine loan interest','Mezzanine Loan Interest','Debt Service / Interest','Debt Service / Interest','cash'),
('loan fees','Loan Fees','Debt Service / Interest','Debt Service / Interest','cash'),
-- Below NOI -> CapEx
('construction management fees','Construction Management Fees','Capital Expenditures','CapEx','cash'),
-- NON-CASH / accrual constructs — declared, never compared against cash
('less: vacancy','Less: Vacancy','Income','Residential Rent','non_cash'),
('loss/gain to lease','Loss/Gain to Lease','Income','Residential Rent','non_cash'),
('less: model unit','Less: Model Unit','Income','Residential Rent','non_cash'),
('less: non revenue generating units','Less: Non Revenue Generating Units','Income','Residential Rent','non_cash'),
('less: employee unit rent credit','Less: Employee Unit Rent Credit','Income','Residential Rent','non_cash'),
('less: rent concessions','Less: Rent Concessions','Income','Residential Rent','non_cash'),
('less: rent discount','Less: Rent Discount','Income','Residential Rent','non_cash'),
('less: rent write offs','Less: Rent Write Offs','Income','Residential Rent','non_cash'),
('gross potential rent (market rent)','Gross Potential Rent (Market Rent)','Income','Residential Rent','non_cash'),
('allowance for bad debt','Allowance for Bad Debt','Income','Residential Rent','non_cash'),
('depreciation expense','Depreciation Expense','Depreciation / Amortization','Depreciation / Amortization','non_cash'),
('amortization expense','Amortization Expense','Depreciation / Amortization','Depreciation / Amortization','non_cash'),
('prior period adjustments','Prior Period Adjustments','Depreciation / Amortization','Depreciation / Amortization','non_cash'),
-- REVENUE — lives in revenue tables; not read by report-read v1. Declared.
('rent - residential','Rent - Residential','Income','Residential Rent','revenue_v2'),
('rent-commercial','Rent-Commercial','Income','Residential Rent','revenue_v2'),
('short-term rent','Short-Term Rent','Income','Residential Rent','revenue_v2'),
('parking','Parking','Income','Other Income','revenue_v2'),
('amenity fees','Amenity fees','Income','Other Income','revenue_v2'),
('pet rent','Pet Rent','Income','Other Income','revenue_v2'),
('application fees','Application fees','Income','Other Income','revenue_v2'),
('estimated cam charges','Estimated CAM Charges','Income','Other Income','revenue_v2'),
('move out charges','Move Out Charges','Income','Other Income','revenue_v2'),
('deposit forfeit','Deposit Forfeit','Income','Other Income','revenue_v2'),
('termination fees','Termination Fees','Income','Other Income','revenue_v2'),
('utility income','Utility Income','Income','Billbacks / Utility Income','revenue_v2'),
('water admin fee income','Water Admin Fee Income','Income','Billbacks / Utility Income','revenue_v2'),
('late fee','Late Fee','Income','Other Income','revenue_v2'),
('nsf fees','NSF Fees','Income','Other Income','revenue_v2'),
('bank interest','Bank Interest','Income','Other Income','revenue_v2'),
('event cleaning','Event Cleaning','Income','Other Income','revenue_v2'),
('yardi system admin fees income','Yardi System Admin Fees Income','Income','Other Income','revenue_v2'),
('key replacement','Key Replacement','Income','Other Income','revenue_v2'),
('vending machine commission','Vending Machine Commission','Income','Other Income','revenue_v2'),
('miscellaneous income','Miscellaneous Income','Income','Other Income','revenue_v2')
ON CONFLICT (label_norm) DO NOTHING;

-- DELIBERATELY NOT SEEDED (must surface as unmatched -> needs_mapping, on real data):
--   'Asset Management Fee' — Tower books it below NOI; our skeleton has no honest
--   home for it yet. It queues for a human, exactly like 'uncategorized' does.
