-- ════════════════════════════════════════════════════════════════════
--  127 — THE DURABLE APPOINTMENT→OPPORTUNITY BRIDGE
--
--  An appointment is a real-world event: someone agreed to meet, and either
--  showed up or did not. Which OPPORTUNITY that appointment belonged to was
--  never recorded at the moment of work. It was RECONSTRUCTED at read time by:
--
--      select id from leasing_conversions
--       where person_id=$1 and property_id=$2 and status='active' limit 1
--
--  Same person + same property + whichever conversion is active now + limit 1 —
--  four forbidden inferences in one query, in three places. It produced a value,
--  not lineage: only for completed tours, only into JSON metadata, and wrong the
--  moment one person had two opportunities.
--
--  Worse, attribution could not survive a reschedule. The native successor
--  INSERT copied eight columns and not the opportunity, so a chain that began
--  attributed became unattributed at its second occurrence — silently, and
--  unrepairably, because the inference that would fill it back in is forbidden.
--
--  This records the fact at the moment of work instead of guessing it later.
--
--  ── ADDITIVE ONLY ───────────────────────────────────────────────────
--  No column dropped, no constraint tightened, no data rewritten, no status
--  vocabulary changed, no trigger, no new table. `leasing_conversions` is not
--  touched at all. Every existing row keeps working with conversion_id NULL and
--  every existing query keeps working unchanged. Idempotent; safe to re-run.
--
--  ── THIS MIGRATION WRITES NO conversion_id VALUES ───────────────────
--  There is deliberately NO backfill here. Backfill is a separate, exact-links-
--  only act, measured first by tools/appointment_attribution_analyzer.js against
--  the honest opening baseline. Only explicit durable links count:
--  leasing_conversions.origin_tour_id, leasing_conversions.scheduled_tour_id,
--  and reschedule chains whose attributed members AGREE. Nearest timestamp,
--  same person, same lead, same property and current-active-conversion are NOT
--  evidence and never become evidence.
--
--  ── NULL IS VALID INDEFINITELY ──────────────────────────────────────
--  NO NOT NULL is added, now or later. conversion_id IS NULL truthfully means
--  "not attributable from the evidence available" — never "not yet processed".
--  It is the correct, permanent state for walk-ins with no conversation, for
--  external calendar rows imported before any opportunity existed, and for every
--  historical appointment whose only possible association is forbidden
--  inference. No automated pass may ever "improve" that number. An explicit,
--  proven, attributed correction may still resolve an individual row later; what
--  is forbidden is closing the gap automatically.
--
--  ── PROPERTY CONSISTENCY IS WRITER-ENFORCED, NOT STRUCTURAL ─────────
--  A composite FK (property_id, conversion_id) would enforce same-property in
--  the schema, but it requires a new unique key on leasing_conversions
--  (property_id, id) — a constraint on a table this cut is not authorised to
--  reshape — and scheduled_tours has no lead_id to make the pairing natural.
--  So src/leasing/appointment_attribution.js validates that the opportunity's
--  property_id equals the appointment's and refuses cross-property attribution
--  with a controlled refusal; the analyzer and the projector both RE-CHECK it on
--  read and report wrong_property rather than trusting the column.
--
--  This is a deliberate weaker-enforcement choice, recorded as such, not an
--  oversight. PROMOTION CONDITION: if leasing_conversions ever gains a
--  (property_id, id) unique key for any other reason, promote this to a
--  composite FK and delete the writer-side check.
--
--  ── ROLLBACK ────────────────────────────────────────────────────────
--    drop index if exists idx_leasing_tours_conversion;
--    drop index if exists idx_scheduled_tours_conversion;
--    alter table leasing_tours   drop column if exists conversion_id;
--    alter table scheduled_tours drop column if exists conversion_id;
--
--  Trivially reversible BEFORE the writers are cut over. AFTER cutover this
--  migration and the writer cutover are ONE deployable unit: rolling back the
--  column without reverting the writers makes them error on an absent column.
-- ════════════════════════════════════════════════════════════════════

-- ── on delete set null, deliberately ─────────────────────────────────
--  Not `cascade`: deleting an opportunity must never delete the appointment.
--  The appointment HAPPENED. It is observed history, and its tour_events remain
--  truthful evidence whatever becomes of the opportunity record. Losing the link
--  is a demotion to `unattributed`, which the projector already models honestly.
--
--  Not `restrict`: an opportunity's lifecycle is not the appointment's to veto.

alter table leasing_tours
  add column if not exists conversion_id uuid
    references leasing_conversions(id) on delete set null;

alter table scheduled_tours
  add column if not exists conversion_id uuid
    references leasing_conversions(id) on delete set null;

-- ── partial indexes ──────────────────────────────────────────────────
--  The overwhelming majority of historical rows stay NULL indefinitely (see
--  above) and must not be indexed. These support exactly one access path —
--  "every appointment belonging to this opportunity" — which is the only way
--  the projector reads them.

create index if not exists idx_leasing_tours_conversion
  on leasing_tours (conversion_id) where conversion_id is not null;

create index if not exists idx_scheduled_tours_conversion
  on scheduled_tours (conversion_id) where conversion_id is not null;
