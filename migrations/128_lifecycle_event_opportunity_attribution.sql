-- ════════════════════════════════════════════════════════════════════
--  128 — EXACT OPPORTUNITY ATTRIBUTION ON THE LEASING LIFECYCLE RAIL
--
--  The 054 rail already records terminal truth properly: append-only events,
--  governed reason codes, explicit `reopened` that never deletes the prior
--  close, per-conversation sequence assigned under a row lock, idempotency
--  keys, and correction events. Everything is right except WHAT IT NAMES.
--
--  It is keyed on conversation_id, and `conversations` carries a UNIQUE index
--  on (property_id, person_id) — exactly ONE conversation per person per
--  property. `leasing_conversions` meanwhile permits MANY opportunities over
--  time for that same pair (only one ACTIVE at a time). So one conversation
--  necessarily spans every opportunity a person ever has at a property, and a
--  recorded `closed_not_fit` cannot say which opportunity it closed.
--
--  Proven against real Postgres before this migration was written:
--      opportunities for one person+property: 2
--      conversations  for one person+property: 1
--      closed_not_fit -> names the conversation -> UNANSWERABLE
--
--  ── THE MODEL ────────────────────────────────────────────────────────
--      conversation_id  relationship / channel context   (kept, still useful)
--      conversion_id    EXACT leasing-opportunity attribution   (added here)
--
--  The conversation remains meaningful context. It is no longer sufficient
--  authority for an opportunity-level terminal claim.
--
--  ── ADDITIVE ONLY ───────────────────────────────────────────────────
--  One nullable column, one partial index. No column dropped, no constraint
--  tightened, no data rewritten, no event type added, no reason code changed,
--  no new table, no trigger. NO new lifecycle system — this migration creates
--  nothing that could become a second ladder. Idempotent; safe to re-run.
--
--  ── THIS MIGRATION WRITES NO conversion_id VALUES ───────────────────
--  Backfill is a separate, exact-links-only act. The ONLY permitted evidence
--  is a source object that already carries the exact opportunity UUID — e.g. a
--  tour-link event whose `tour_id` names a tour that itself carries
--  conversion_id (migration 127). Explicitly forbidden, and impossible here
--  because this file writes nothing: whichever opportunity was active at the
--  event time, the only one currently open, nearest conversion creation time,
--  same lead, same person+property, current lead status, current conversion
--  status.
--
--  ── NULL, AND WHEN IT IS NOT ACCEPTABLE ─────────────────────────────
--  NO NOT NULL is added, and none may be added later: `reopened` and the
--  tour-link events can be genuinely conversation-level, and historical rows
--  are legitimately not attributable from existing evidence. NULL there is the
--  truthful answer, and the projection reports it as untrackable rather than
--  as data awaiting a batch fix.
--
--  For NEW opportunity-terminal acts NULL is NOT acceptable. That is enforced
--  by the WRITER, which refuses the act when the caller cannot supply an exact
--  opportunity UUID, rather than by a table-wide constraint that would
--  retroactively invalidate honest historical nulls. Recorded as a deliberate
--  choice: a NOT NULL here would force either a fabricated backfill or a
--  broken deploy, and both are worse than a writer-enforced rule.
--
--  ── ROLLBACK ────────────────────────────────────────────────────────
--    drop index if exists idx_lifecycle_events_conversion;
--    alter table leasing_lead_lifecycle_events drop column if exists conversion_id;
--
--  Trivially reversible before the writers are cut over. After cutover this
--  migration and the writer cutover are ONE deployable unit.
-- ════════════════════════════════════════════════════════════════════

-- ── on delete set null, deliberately ─────────────────────────────────
--  Not `cascade`: deleting an opportunity must never delete the record that
--  someone explicitly closed or reopened something. The decision HAPPENED, and
--  it remains governed history with its actor, reason code and time intact.
--  Losing the link demotes the event to unattributed, which the projection
--  already models.
--
--  Not `restrict`: an opportunity's lifecycle is not the event's to veto.

alter table leasing_lead_lifecycle_events
  add column if not exists conversion_id uuid
    references leasing_conversions(id) on delete set null;

comment on column leasing_lead_lifecycle_events.conversion_id is
  'EXACT leasing-opportunity attribution for this lifecycle event. conversation_id remains relationship/channel context but is NOT sufficient authority for an opportunity-level terminal claim, because one conversation spans every opportunity a person has at a property. NULL means the event is genuinely conversation-level, or is not exactly attributable from existing evidence — never that it is awaiting an automated fix. New opportunity-terminal acts must carry it; that is enforced by the canonical writer, which refuses rather than guessing.';

-- ── partial index ────────────────────────────────────────────────────
--  Historical rows stay NULL and must not be indexed. This supports exactly
--  one access path — "every lifecycle event for this opportunity" — which is
--  how the terminal/pending projection reads them.

create index if not exists idx_lifecycle_events_conversion
  on leasing_lead_lifecycle_events (conversion_id)
  where conversion_id is not null;
