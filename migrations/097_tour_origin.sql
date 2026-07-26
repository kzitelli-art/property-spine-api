-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 097 — TOUR ORIGIN (how the tour came to exist)
--
--  Additive. ONE nullable column, one index. Nothing existing is altered,
--  nothing is backfilled, nothing is seeded.
--
--  WHY: someone is in the neighbourhood, walks in, and gets toured. That
--  is a real tour. Today it cannot be recorded at all: the only capture
--  door is /operator/leasing/tours/:tourId/complete, which needs a tour
--  row that already exists, and a walk-in has none.
--
--  THE TRAP THIS COLUMN EXISTS TO PREVENT
--
--  The obvious shortcut is to capture the walk-in against whatever tour
--  the person already has booked — they toured, there is a row, use it.
--  That falsifies WHEN the tour happened: the record would claim it
--  occurred at tomorrow's slot time. "The tour we planned" and "the tour
--  that happened" are two different facts, and a system whose whole
--  purpose is recording the truth at the moment of work cannot merge them
--  because they usually coincide.
--
--  So a walk-in gets its OWN tour row, at its own time. Tomorrow's
--  scheduled tour still exists and is still scheduled until a human says
--  otherwise — the system never infers that a walk-in cancels it. Both
--  outcomes are real: they came early instead, or they saw the lobby
--  today and still want the unit tour tomorrow. Only the agent knows.
--
--  WHY A COLUMN RATHER THAN INFERENCE
--
--  A walk-in has no slot. So does every tour created through the legacy
--  request/confirm path. Without this column those are indistinguishable,
--  and the board cannot tell "no slot because it was a walk-in, which is
--  fine" from "no slot because the booking path was bypassed, which is
--  the defect that made 21 of 30 tours untimeable". One means nothing is
--  wrong; the other means something is. Collapsing them would make the
--  untrackable diagnosis useless the moment walk-ins start arriving.
--
--  NULL is honest. Every existing row predates the distinction, and this
--  file does NOT guess which of them were walk-ins. A backfill here would
--  be inventing history — the same refusal that leaves 27 'interested'
--  rows unresolved rather than mapping them to a standing nobody recorded.
--
--  SAFETY CONTRACT — there is no staging; merging this EXECUTES it:
--    · ADD COLUMN IF NOT EXISTS, nullable, no default (catalog-only).
--    · The CHECK admits NULL, so every existing row satisfies it.
--    · No UPDATE, no backfill, no seed.
--    · Nothing reads it in a decision path yet, so OLD CODE against NEW
--      SCHEMA is trivially safe and a code-only rollback is harmless.
--
--  KNOWN CONSUMERS THAT MUST STAY GREEN: none as of 097.
-- ════════════════════════════════════════════════════════════════════

alter table leasing_tours
  add column if not exists origin text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leasing_tours_origin_known'
  ) then
    alter table leasing_tours
      add constraint leasing_tours_origin_known
      check (origin is null or origin in ('scheduled','walk_in'));
  end if;
end $$;

comment on column leasing_tours.origin is
  'How the tour came to exist: ''scheduled'' (booked into a tour_availability slot) or ''walk_in'' (occurred unscheduled, recorded at capture). NULL = predates the distinction; never backfilled, because guessing which historical tours were walk-ins would invent history. A walk-in legitimately has no slot_id; a scheduled tour missing one is a defect. This column is what tells those apart.';

-- the board asks "which of these no-slot tours are actually fine?"
create index if not exists leasing_tours_origin_idx
  on leasing_tours (property_id, origin);
