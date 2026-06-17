-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 044 — THE AUTO-CONFIRM SWITCH (earned autonomy)
--
--  The money layer already PROPOSES a category for a known vendor
--  (vendors.default_category / vendor_property_categories, 017+019) and
--  then PARKS the line for a human confirm (bankbridge.js, Hard Rule #1).
--  Every confirm writes proposed_category + confirmed_category side by
--  side on money_events (005) — so a track record of "proposed X, human
--  agreed X" already accumulates with zero new instrumentation.
--
--  This migration adds the SWITCH that lets a (vendor, property) rule
--  graduate from propose-mode to auto-confirm — but ONLY a switch. It
--  creates no new birth path for money on its own; the auto-confirm
--  LANDING logic lives in app code (autoconfirm.js) and still writes a
--  fully-audited money_event. The switch is per (vendor, property),
--  reversible, and carries WHO turned it on and WHEN — so an
--  auto-confirmed line is never indistinguishable from a human one.
--
--  DOCTRINE CARRIED FORWARD (unchanged):
--    • Autonomy is EARNED, not granted day one. A human flips this switch
--      only after the eligibility read (autoconfirm.js) shows the record
--      justifies it. This table does not enforce the threshold — it
--      records the decision. The read gates; the human grants; this
--      stores. Three separate steps on purpose.
--    • REVERSIBLE BY DESIGN. auto_confirm flips back to false the instant
--      a vendor misbehaves (one human override → snap back, enforced in
--      app code). Turning it off is a column update, never a delete — the
--      audit columns persist so we keep the trail of when trust was
--      granted and revoked.
--    • The two tripwires (out-of-band amount → human queue; one override
--      → revoke) are ENFORCED IN APP CODE, not here. This is the storage
--      for the switch state, nothing more. The DB never auto-confirms.
--    • Auto-confirm only ever applies to a vendor that HAS a category rule
--      to propose. Amazon-class (default_category NULL, no property rule)
--      can never be switched on — there is no rule row to flip. The gap is
--      self-correcting: trust accrues only where a proposal exists.
--
--  EXTENDS vendor_property_categories (019). Run AFTER 019. Idempotent —
--  guarded with "if not exists"; re-run is a no-op.
-- ════════════════════════════════════════════════════════════════════

-- ── 1) the switch + its audit trail on the per-property rule ──────────
--   auto_confirm        — false until a human earns+grants it. The gate.
--   auto_confirm_by     — WHO granted autonomy (persons.id). Never null
--                         when auto_confirm is true; cleared trail kept on
--                         revoke. The accountability tie.
--   auto_confirm_at     — WHEN autonomy was granted. Timestamps the trust.
--   auto_confirm_note   — free-text reason captured at grant time (e.g.
--                         "6 confirms, 0 overrides as of 2026-06-17").
--   revoked_at          — WHEN autonomy was last pulled (override tripwire
--                         or manual off). Non-null + auto_confirm=false
--                         means "was trusted, then revoked" — distinct
--                         from "never trusted" (revoked_at null).
--   revoked_reason      — why it snapped back (e.g. "human override on
--                         bank_txn <id>: proposed electric, chose capex").
alter table vendor_property_categories
  add column if not exists auto_confirm      boolean not null default false,
  add column if not exists auto_confirm_by   uuid references persons(id),
  add column if not exists auto_confirm_at   timestamptz,
  add column if not exists auto_confirm_note  text,
  add column if not exists revoked_at        timestamptz,
  add column if not exists revoked_reason    text;

-- ── 2) integrity: if the switch is ON, we MUST know who turned it on ──
--   An auto-confirmed line traces to a human who granted the autonomy.
--   This guarantees that tie at the DB, so an auto-confirm can never be
--   anonymous. (auto_confirm=false leaves auto_confirm_by free — a
--   revoked row keeps its historical grantor or clears it; either is ok.)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'vpc_auto_confirm_needs_grantor'
  ) then
    alter table vendor_property_categories
      add constraint vpc_auto_confirm_needs_grantor
      check (auto_confirm = false or auto_confirm_by is not null);
  end if;
end $$;

-- ── 3) the read pattern: "which rules are live auto-confirm right now"
--   The landing path (autoconfirm.js) asks this per (vendor, property) on
--   every incoming row; the board asks it per property. Partial index —
--   only the switched-on rows, which are the few that matter on the hot
--   path.
create index if not exists ix_vpc_auto_confirm_on
  on vendor_property_categories (property_id, vendor_id)
  where auto_confirm = true;

-- ── 4) stamp on money_events: HOW a line was confirmed ───────────────
--   Existing rows are human-confirmed (verified_by_person_id set by the
--   bridge). Auto-confirmed lines need to be tellable apart for the audit
--   and for the board's "X auto / Y human" split. NULL or 'human' = the
--   existing hand-confirm path; 'auto' = landed via a switched-on rule.
--   We default NULL (not 'human') so we never rewrite history — only new
--   auto lines carry 'auto', and reads treat NULL as human.
alter table money_events
  add column if not exists confirm_method text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'money_events_confirm_method_check'
  ) then
    alter table money_events
      add constraint money_events_confirm_method_check
      check (confirm_method is null or confirm_method = any (array['human','auto']));
  end if;
end $$;

-- An auto-confirmed line records WHICH rule authorized it, so the trail
-- runs charge → rule → human who granted the rule. Nullable: only auto
-- lines carry it.
alter table money_events
  add column if not exists auto_confirm_rule_id uuid references vendor_property_categories(id);
