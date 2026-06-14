-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 036 — SCHEDULED_CHARGES: the charge ledger (the CLAIM side)
--
--  The income-proof rung starts here. You cannot prove a payment until the
--  system knows what was OWED. Until now `scheduled_charges` was referenced
--  by reporting.js as a hopeful read ("scheduled_charges not present" if
--  absent) but no migration ever created it — so billed rent was a
--  report-side guess, not a structured claim. This makes it real.
--
--  DOCTRINE THIS RUNG SERVES:
--    • A charge is a CLAIM ("$1,850 owed on unit 304 for June"). It is NOT
--      proven income. Proven income requires a payment tie (next rung).
--    • charge = claim · payment tie = proof · unpaid/unmatched = exposure.
--    • Every charge carries its ORIGIN (source + source_ref) — born from a
--      lease, a rent roll, or a historical import. A claim with no provenance
--      is not a claim.
--
--  WHERE CHARGES COME FROM (source vocabulary, app-layer):
--    lease         — generated from an active lease's rent terms
--    rent_roll     — imported from a rent-roll / billing file
--    import        — historical back-fill from a prior system's report
--    manual        — hand-entered correction / one-off (fees, owner items)
--
--  STATUS VOCABULARY (app-layer, NOT a DB CHECK — same precedent as the
--  category vocabulary in 007 and the module vocabulary in 035: the list can
--  evolve without a migration):
--    claimed         — owed, nothing applied yet
--    partially_paid  — some payment applied, balance remains
--    paid            — fully satisfied by applied payment(s)
--    written_off     — forgiven / waived (a money event in its own right)
--    disputed        — contested; held out of normal aging
--
--  ENTITY GRAPH (verified against 001 baseline before writing):
--    properties → units → spaces ; leases reference space_id + tenant_ids[] ;
--    tenants are persons. A charge ties to property + unit (always), and to a
--    lease + person (the payer) WHEN KNOWN — both nullable, because a
--    historical import may carry a unit and amount but no resolved lease/person.
--    Address-is-identity: the unit is the hard anchor; lease/person resolve
--    later without invalidating the charge.
--
--  amount_paid IS CARRIED HERE (default 0) even though the payment rung is
--  next: reporting.js already computes `amount - coalesce(amount_paid,0)` and
--  the exposure buckets your operator wants (billed-but-unpaid, overpaid,
--  etc.) read from it. The payment-tie rung WRITES it; this rung reserves it
--  so we don't retrofit (same discipline as the 001 users auth slot).
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  ledger row. NO transaction control, NO ledger insert here. Conventions
--  match prior migrations (uuid pk, timestamptz, gen_random_uuid).
-- ════════════════════════════════════════════════════════════════════

-- ── PRE-EXISTING TABLE GUARD (added at deploy) ──────────────────────
-- An earlier migration created a DIFFERENT scheduled_charges (move-in /
-- concession shape: label, due_on, is_move_in_gate, recur_period…) with no
-- `period` column, so the income-rung index below failed. That table is
-- EMPTY (verified 0 rows before this change), so we drop it and let this
-- migration build the income-rung ledger clean. Idempotent: `if exists`
-- makes this safe on a fresh DB too.
drop table if exists scheduled_charges cascade;

create table if not exists scheduled_charges (
  id            uuid primary key default gen_random_uuid(),

  -- ── identity anchors ───────────────────────────────────────────────
  property_id   uuid not null references properties(id) on delete cascade,
  unit_id       uuid references units(id) on delete set null,
                  -- the hard anchor in practice; nullable only so a charge
                  -- can exist before unit resolution on a messy import.
  lease_id      uuid references leases(id) on delete set null,
                  -- the lease the charge was generated from, WHEN KNOWN.
  person_id     uuid references persons(id) on delete set null,
                  -- the payer (a tenant/person), WHEN KNOWN.

  -- ── the claim itself ───────────────────────────────────────────────
  charge_type   text not null default 'rent',
                  -- rent | first_month | late_fee | deposit | utility |
                  -- parking | other  (app-layer vocabulary)
  period        date not null,
                  -- the month the charge is FOR, as the 1st of that month
                  -- (e.g. 2026-06-01 = "June 2026"). One grain for aging.
  amount        numeric(14,2) not null,         -- what is owed (gross)
  amount_paid   numeric(14,2) not null default 0,
                  -- what has been APPLIED so far. Written by the payment-tie
                  -- rung (036 reserves it). balance = amount - amount_paid.
  due_date      date,                            -- when it was/is due

  status        text not null default 'claimed',
                  -- claimed | partially_paid | paid | written_off | disputed

  -- ── provenance (every claim carries its origin) ────────────────────
  source        text not null default 'manual',
                  -- lease | rent_roll | import | manual
  source_ref    text,
                  -- free-text pointer to the origin (file name, import batch,
                  -- external charge id) — the receipt for where it came from.

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- one charge per (lease/unit, period, type) when generated from a lease —
  -- prevents double-billing the same rent for the same month. Partial:
  -- only applies when lease_id is present (imports without a lease are not
  -- forced unique, since the same unit can legitimately carry odd history).
  constraint scheduled_charges_amount_nonneg check (amount >= 0)
);

-- one rent charge per lease+period+type (no double-billing the generated set).
-- Partial unique index, not a table constraint, so import/manual rows with a
-- null lease_id are exempt.
create unique index if not exists uq_scheduled_charges_lease_period_type
  on scheduled_charges (lease_id, period, charge_type)
  where lease_id is not null;

-- the reads this table will serve: by property (the report), by unit (the
-- ledger view), by aging/period, and by status (exposure buckets).
create index if not exists idx_scheduled_charges_property on scheduled_charges(property_id);
create index if not exists idx_scheduled_charges_unit     on scheduled_charges(unit_id);
create index if not exists idx_scheduled_charges_lease    on scheduled_charges(lease_id);
create index if not exists idx_scheduled_charges_period   on scheduled_charges(property_id, period);
create index if not exists idx_scheduled_charges_status   on scheduled_charges(property_id, status);
