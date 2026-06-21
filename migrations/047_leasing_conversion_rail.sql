-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 047 — LEASING CONVERSION RAIL
--
--  After a completed tour, the human who ACTUALLY gave it owns the
--  prospect's conversation until they explicitly hand it off. This
--  migration adds the canonical system-of-record for that relationship.
--
--  DESIGN — what is new here vs. what is reused:
--   • REUSED: child follow-up commitments are ordinary rows in the existing
--     `obligations` table, spawned through spawnObligationFromEvent (the one
--     accountable-human spine). We do NOT fork a parallel obligation engine.
--   • NEW: the parent conversion record, the scheduled-vs-actual tour-host
--     facts, conversation ownership + durable handoff history, and the
--     kept/missed/released OUTCOME with its proof — none of which the generic
--     obligation table models. A thin link table ties each obligation row to
--     its conversion record and stamps the immutable outcome on close.
--
--  OWNERSHIP RULE (enforced in the service layer, shaped by these columns):
--   conversation_owner_user_id changes ONLY via an explicit handoff row.
--   Absence sets handoff_required = true; it NEVER silently reassigns.
--   scheduled_tour_host_user_id is operational context and is preserved.
--   actual_tour_host_user_id is the relationship truth and is immutable.
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records the
--  ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════

-- ── 0. WIDEN THE ROLE VOCABULARY ────────────────────────────────────
-- The target org has a Leasing Manager who owns applicant/exception decision
-- gates (distinct from a Leasing Agent who hosts tours, and from the Property
-- Manager who owns lease terms / countersign). The baseline role_name enum
-- predates that role; migration 041 already established that this vocabulary
-- gets widened as the org formalizes. Add it idempotently so gate obligations
-- can carry assigned_role='leasing_manager'. (Postgres has no IF NOT EXISTS for
-- enum values before v? — guard with a catalog check.)
do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'role_name' and e.enumlabel = 'leasing_manager'
  ) then
    alter type role_name add value 'leasing_manager';
  end if;
end $$;

-- ── 1. PARENT CONVERSION RECORD ─────────────────────────────────────
-- One durable record per (prospect, property) post-tour relationship.
-- Created ONLY from a completed tour with a confirmed actual host — the
-- service layer refuses to insert without actual_tour_host_user_id.
create table if not exists leasing_conversions (
  id                            uuid primary key default gen_random_uuid(),
  person_id                     uuid not null references persons(id),
  property_id                   uuid not null references properties(id),
  -- the tour this conversion was born from (nullable so a manual/edge open is
  -- possible, but the normal path always sets it)
  origin_tour_id                uuid references leasing_tours(id),
  lead_id                       uuid references leasing_leads(id),

  -- ── the three host/owner facts the contract requires be DISTINGUISHABLE ──
  scheduled_tour_host_user_id   uuid references users(id),   -- who was expected (context, preserved)
  actual_tour_host_user_id      uuid not null references users(id), -- who actually gave it (relationship truth, immutable)
  feedback_recorded_by_user_id  uuid references users(id),   -- who entered feedback (distinct; truth not assumed)

  -- ── conversation ownership: starts = actual host, moves ONLY by handoff ──
  conversation_owner_user_id    uuid not null references users(id),
  handoff_required              boolean not null default false, -- owner unavailable + no successor named = visible risk

  -- ── conversion position + outcome ──
  -- the rail position is derived from child obligations, but we cache the
  -- latest stage label for fast queue reads. 'released'/'converted' close it.
  current_stage                 text not null default 'tour_followup',
  status                        text not null default 'active'
                                  check (status in ('active','converted','released')),

  -- the human asset from the tour (free text now; extensible later — the
  -- contract says capture only enough to start the rail + let AI draft)
  tour_outcome                  text,                         -- e.g. 'interested'
  tour_notes                    text,

  opened_at                     timestamptz not null default now(),
  closed_at                     timestamptz,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
create index if not exists leasing_conversions_person_idx
  on leasing_conversions(person_id);
create index if not exists leasing_conversions_property_idx
  on leasing_conversions(property_id);
create index if not exists leasing_conversions_owner_idx
  on leasing_conversions(conversation_owner_user_id) where status = 'active';
-- One ACTIVE conversion per (person, property): a prospect has one live
-- relationship per building. Closed ones (released/converted) don't collide.
create unique index if not exists leasing_conversions_one_active
  on leasing_conversions(person_id, property_id) where status = 'active';

-- ── 2. OWNERSHIP TRANSFER HISTORY ───────────────────────────────────
-- Every explicit handoff is a durable event. The original tour host is
-- never erased; the chain reads toured-by → handed-by → handed-to.
-- Append-only: rows are never updated or deleted.
create table if not exists leasing_conversation_handoffs (
  id                  uuid primary key default gen_random_uuid(),
  conversion_id       uuid not null references leasing_conversions(id) on delete cascade,
  from_user_id        uuid references users(id),     -- prior owner (null only for the synthetic origin row)
  to_user_id          uuid not null references users(id),
  by_user_id          uuid references users(id),     -- who performed the transfer (owner or manager override)
  kind                text not null default 'handoff'
                        check (kind in ('origin','handoff','manager_override')),
  reason              text,
  note                text,
  acknowledged_by_to  boolean not null default false, -- recipient acknowledgment (optional gate)
  created_at          timestamptz not null default now()
);
create index if not exists leasing_handoffs_conversion_idx
  on leasing_conversation_handoffs(conversion_id, created_at);

-- ── 3. CHILD OBLIGATION LINKAGE + IMMUTABLE OUTCOME ─────────────────
-- The follow-up COMMITMENT lives in the existing `obligations` table. This
-- link row ties that obligation to its conversion record and — when the
-- window closes — stamps the IMMUTABLE kept/missed/released outcome and its
-- proof. The obligation row may be completed by the generic engine; the
-- outcome recorded HERE is what the Grade later reads, and it is write-once.
create table if not exists leasing_conversion_obligations (
  id                  uuid primary key default gen_random_uuid(),
  conversion_id       uuid not null references leasing_conversions(id) on delete cascade,
  obligation_id       uuid not null references obligations(id),

  -- which rung of the rail this is. Core human-conversion rungs + the
  -- separate decision/operating gates that can run ALONGSIDE a follow-up.
  rung                text not null
                        check (rung in (
                          'tour_followup','applicant_followup','lease_signature_followup',
                          'application_approval','lease_terms_approval','lease_countersign','move_in_readiness'
                        )),

  -- the human responsible for THIS rung at spawn time. For the conversation
  -- rungs this is the conversation owner; for gates it's the gate role's
  -- resolved person. Stored so closed history shows who actually owned it.
  owner_user_id       uuid references users(id),
  owner_role          text,                          -- e.g. 'leasing_manager' for a gate

  due_by              timestamptz,

  -- ── write-once outcome (the durable proof the Grade reads) ──
  outcome             text check (outcome in ('kept','missed')),   -- null while open
  resolution          text check (resolution in ('completed','released','missed')), -- how it closed
  proof               jsonb,                         -- what was done (message ref, call ref, decision ref…)
  closed_at           timestamptz,

  created_at          timestamptz not null default now()
);
create index if not exists lco_conversion_idx
  on leasing_conversion_obligations(conversion_id);
create unique index if not exists lco_obligation_unique
  on leasing_conversion_obligations(obligation_id); -- one link per obligation
-- Fast "open rungs for this conversion" read:
create index if not exists lco_open_idx
  on leasing_conversion_obligations(conversion_id) where outcome is null;

-- ── 4. COMMUNICATION LINKAGE POINT (forward-declared, not yet populated) ──
-- The contract's NEXT step is the Twilio-backed interaction ledger. We add
-- the join column now so messages/calls can attach to a conversion without a
-- later migration churn. NOT populated by this slice.
-- (comm_events already exists from the leasing/tenantlink work.)
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'comm_events') then
    alter table comm_events
      add column if not exists conversion_id uuid references leasing_conversions(id);
    create index if not exists comm_events_conversion_idx
      on comm_events(conversion_id) where conversion_id is not null;
  end if;
end $$;
