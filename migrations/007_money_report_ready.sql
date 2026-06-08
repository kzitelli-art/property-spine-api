-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 007 — MONEY REPORT-READY + APPROVAL STAGE
--
--  Extends the money_events lifecycle from a 2-state (unverified → verified)
--  loop to a staged approval lifecycle that ends in 'report_ready':
--
--      unverified  → classification + proof captured
--      verified    → category confirmed by a human (existing meaning, kept)
--      report_ready→ all required approvals landed; safe to roll into the P&L
--
--  Also adds approval_stage: which role in the event-type approval sequence
--  is currently owed the next sign-off. NULL = no approval sequence active.
--
--  Two changes, both ADDITIVE and IDEMPOTENT:
--    1. Replace the status CHECK to allow the new 'report_ready' value.
--       (Defensive: drops the existing status CHECK by name if present, then
--        adds the widened one. Does NOT depend on the old constraint's exact
--        text — it replaces rather than reproduces it. Existing rows are all
--        'unverified'/'verified', both still valid, so no row violates it.)
--    2. Add approval_stage text column (nullable).
--
--  Run AFTER 006. Done through the repo + migrate.js (not hand-run).
--  Safe to re-run: guarded throughout.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) widen the status CHECK to include 'report_ready' ─────────────
-- Drop the old status constraint by its known live name if it exists, then
-- (re)create the widened one. Guarded so a re-run is a clean no-op.
do $$
begin
  -- remove the old 2-value status check if present (any name we might find)
  if exists (select 1 from pg_constraint where conname = 'money_events_status_check') then
    alter table money_events drop constraint money_events_status_check;
  end if;

  -- add the widened 3-value check if it isn't already the live one
  if not exists (select 1 from pg_constraint where conname = 'money_events_status_check') then
    alter table money_events add constraint money_events_status_check
      check (status = any (array['unverified','verified','report_ready']));
  end if;
end $$;

-- ── 1b) add event_type (nullable) ───────────────────────────────────
-- The kind of money movement (supply_run, vendor_payment, investor_distribution,
-- …). Drives the approval chain in money.js. Nullable: an event with no type
-- behaves like v1 (classification only, no approval chain). No CHECK constraint
-- here — the allowed vocabulary is enforced in the app layer (EVENT_TYPES), so
-- the list can evolve without a migration. Existing rows get NULL = v1 behavior.
alter table money_events add column if not exists event_type text;

-- ── 2) add approval_stage (nullable) ────────────────────────────────
-- Tracks which approval role is currently owed in the event-type sequence.
-- NULL until an approval sequence is active; set to the next role on each
-- advance; NULL again (and status='report_ready') when the sequence completes.
alter table money_events add column if not exists approval_stage text;

-- ── index: find money waiting on a given approval stage fast ────────
-- The "Money to Review" queue for a role reads off approval_stage.
create index if not exists ix_money_approval_stage on money_events (approval_stage);
