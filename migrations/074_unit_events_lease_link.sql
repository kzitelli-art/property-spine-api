-- ════════════════════════════════════════════════════════════════════
--  074_unit_events_lease_link.sql — Slice D, Migration β
--
--  A real durable lease link on unit_events + a real duplicate guard.
--
--  WHY: the move_in_scheduled event must know which lease caused it. Today
--  the lease lives only as optional free-text payload.lease_id — a claim,
--  not a link (same lesson as the term trace). Add a real column.
--
--  DUPLICATE GUARD (ruling #4): at most one move_in_scheduled event per
--  lease, enforced at the DATABASE via a partial unique index — not
--  informal application logic. The inline confirm-term write cannot
--  double-create even under retry/concurrency; the second insert fails on
--  the constraint and the transaction handles it.
--
--  ADDITIVE + IDEMPOTENT: add-column-if-not-exists, create-index-if-not-
--  exists. Nullable (most unit_events — notice, down — have no lease).
-- ════════════════════════════════════════════════════════════════════

alter table unit_events
  add column if not exists lease_id uuid;

create unique index if not exists uq_unit_events_one_movein_per_lease
  on unit_events (lease_id)
  where lease_id is not null and event_type = 'move_in_scheduled';
