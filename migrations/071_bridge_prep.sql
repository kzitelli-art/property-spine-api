-- ════════════════════════════════════════════════════════════════════
--  BRIDGE-PREP — add the two nullable linkage handles. Nothing else.
--
--  WHAT THIS IS: the future forward-tenancy commitment (COUNTERSIGN_
--  TENANCY_ANCHOR.md) needs two linkage points that do not exist yet:
--    · leases.application_id            — a lease will know its origin application
--    · lease_economic_schedules.lease_id — economics will hang off its lease
--
--  WHAT THIS IS NOT: it does not create truth and it does not enforce the
--  future rule. Deliberately, per ruling:
--    NO foreign key      (an FK is enforcement — a lease with a bad
--                         application_id would be rejected; that rule belongs
--                         to the write path, not here)
--    NO unique constraint (the "one live lease per application" invariant is a
--                         product rule born with the countersign write path,
--                         where amendment / reissue / replacement can be
--                         reasoned about — a naive unique index would block them)
--    NO index            (no reader exists yet; an index with no query is
--                         speculation. The behavior slice adds the exact index
--                         its query needs — possibly a PARTIAL index for the
--                         invariant — where it can be justified)
--    NO NOT NULL, NO default, NO backfill (a pre-bridge lease genuinely has no
--                         known originating application; null says that
--                         truthfully. A default or backfill would fabricate
--                         linkage — the confident-wrong this product exists to
--                         kill)
--
--  ACCEPTANCE: the schema diff must be BORING. Two ADD COLUMN statements.
--  If this file does anything clever, it crossed the boundary.
--
--  IDEMPOTENT: add-column-if-not-exists so a re-run (or a version-number
--  collision the ledger didn't catch) is a no-op, never an error.
--
--  The migration creates handles. The write path creates truth.
-- ════════════════════════════════════════════════════════════════════

alter table leases
  add column if not exists application_id uuid;

alter table lease_economic_schedules
  add column if not exists lease_id uuid;
