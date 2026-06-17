-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 045 — MONEY EVENT ATTRIBUTIONS (causality as a first-class
--  relationship)
--
--  THE PRODUCT RULE (the load-bearing distinction):
--    category confirmation says WHAT THE SPEND WAS  (plumbing supplies)
--    attribution confirmation says WHAT CAUSED IT    (WO-2384 disposal leak)
--  Those are RELATED but they are NOT THE SAME FACT. Bundling them would
--  assert a causal claim a human never made. So attribution is its own
--  record, with its own lifecycle, separate from the category confirm.
--
--  THE ABSTRACTION (discovered from the live schema, not imposed):
--    Work orders, turnovers, and supply_requests already have their own
--    well-shaped tables. We do NOT collapse them into an operating_events
--    mega-table — the codebase already rejects that ("comm_events: its own
--    object, not a flavor of event"). Instead this is a thin POLYMORPHIC
--    relationship that points at whichever operating record by
--    (related_type, related_id) — the SAME pattern the bridge already uses
--    (related_type/related_id on the obligation engine). The "operating
--    event" is a ROLE an existing table plays, identified by a type tag.
--
--  V1 SCOPE (deliberately narrow):
--    • related_type = 'work_order' ONLY this rung. The column is text so
--      'turnover' / 'supply_request' / future types need no schema change.
--    • HUMAN-CONFIRMED ONLY. A proposal is born by the system; it becomes
--      truth only when a person confirms. No auto-linking this rung (auto
--      can earn its way later from confirmed history — same path as the
--      auto-confirm switch, 044).
--    • Allocation in INTEGER CENTS (allocated_amount_cents). money_events
--      .amount is numeric dollars; cents avoids float drift in the sum
--      guard. V1 UI creates ONE 100% attribution; the schema supports
--      many-to-many (a charge split across WOs, a WO fed by many charges)
--      from day one.
--    • PARTIAL attribution is POSSIBLE in the schema (sum of a money
--      event's attributions < its amount) but NOT EXPOSED in V1 UI. The
--      table can hold it; the interface doesn't surface it yet.
--
--  HARD GUARANTEES:
--    • Splits-must-sum doctrine, applied to attribution: app-layer guard
--      ensures confirmed allocated_amount_cents for a money event never
--      exceeds the event amount (×100). A DB constraint can't sum across
--      rows cleanly, so this lives in app code — see attributions.js.
--    • No double-attribution: a partial unique index allows only ONE
--      active (proposed|confirmed) attribution per
--      (money_event_id, related_type, related_id). Rejected rows don't
--      count, so re-proposing after a rejection still works.
--
--  Run AFTER 005 (money_events) and 001 (work_orders). Idempotent.
-- ════════════════════════════════════════════════════════════════════

create table if not exists money_event_attributions (
  id                        uuid primary key default gen_random_uuid(),

  -- WHAT money this attributes
  money_event_id            uuid not null references money_events(id) on delete cascade,

  -- WHICH operating record caused it (polymorphic — no FK by design, the
  -- target lives in one of several tables keyed by related_type)
  related_type              text not null,           -- 'work_order' (V1) | future types
  related_id                uuid not null,

  -- HOW MUCH of the money event this attribution claims, in integer cents.
  -- V1 UI always sets this = the full money event amount (one 100% link).
  allocated_amount_cents    bigint not null check (allocated_amount_cents > 0),

  -- lifecycle: proposed (system) → confirmed | rejected (human)
  status                    text not null default 'proposed'
                              check (status in ('proposed','confirmed','rejected')),

  -- the evidence behind a PROPOSAL (null for a hand-created link)
  confidence_score          numeric,                 -- 0..1, the proposer's strength
  confidence_reason         text,                    -- plain-English why (shown on card)
  proposed_by_system_version text,                   -- which proposer logic made it

  -- who CONFIRMED (the attribution becomes truth)
  confirmed_by_person_id    uuid references persons(id),
  confirmed_at              timestamptz,

  -- who REJECTED (kept for the trail + so re-proposal is allowed)
  rejected_by_person_id     uuid references persons(id),
  rejected_at               timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- ── NO DOUBLE-ATTRIBUTION ────────────────────────────────────────────
--   One ACTIVE (proposed or confirmed) attribution per
--   (money_event, related_type, related_id). A rejected row is inactive,
--   so re-proposing the same pair after a rejection is allowed. This is
--   what stops the same dollar being counted twice against the same WO in
--   the "top drivers" report — the one thing attribution exists to get
--   right.
create unique index if not exists uq_mea_one_active
  on money_event_attributions (money_event_id, related_type, related_id)
  where status in ('proposed','confirmed');

-- ── read patterns ────────────────────────────────────────────────────
--   by money event (the card asks "what's attributed for this charge")
create index if not exists ix_mea_money_event
  on money_event_attributions (money_event_id);
--   by operating record (reporting asks "what spend rolls up to this WO")
create index if not exists ix_mea_related
  on money_event_attributions (related_type, related_id);
--   the work queue (proposed lines awaiting a human)
create index if not exists ix_mea_status
  on money_event_attributions (status);
