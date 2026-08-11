-- ════════════════════════════════════════════════════════════════════
--  158 — THE SOURCE TYPES import_batches ACTUALLY CONTAINS
--
--  Migration 046 created `import_batches` with:
--      check (source_type in ('historical_snapshot','live','demo'))
--
--  Production holds `rent_roll_ledger` and `rent_roll_reconciliation`,
--  neither of which that CHECK permits. Both are written by shipped code.
--
--  ── THIS FILE'S FIRST VERSION WAS WRONG, IN THE HOUSE WAY ───────────
--  It widened the list to `rent_roll_ledger` and said, in its own header,
--  "widened to what the code actually writes, and no further." That was a
--  claim about a SEARCH, not about the code: one writer was read
--  (`loadLedgerSnapshot`) and the others were not. It reached production,
--  and the release refused:
--
--      ✗ FAILED — rolled back. Nothing from this file was applied.
--        check constraint "import_batches_source_type_check" of relation
--        "import_batches" is violated by some row
--
--  The row was `rent_roll_reconciliation`, written by `loadReconciliation`
--  in the SAME FILE as the writer that was read, ~260 lines further down.
--
--  So this version states its scope. Every `insert into import_batches`
--  in the repository, excluding node_modules, including the root:
--
--      src/shared/snapshot_loader.js:272   'historical_snapshot'
--      src/shared/snapshot_loader.js:595   'rent_roll_ledger'
--      src/shared/snapshot_loader.js:857   'rent_roll_reconciliation'
--      src/shared/seed_snapshot.js:97      'historical_snapshot'
--
--  And what production actually contains, measured before writing this:
--
--      rent_roll_reconciliation   1
--      historical_snapshot        3
--
--  `tests/deal_activation_opening_position.db.js` now asserts that every
--  value any writer produces is permitted here — so the next writer that
--  invents a value fails a proof instead of a production release.
--
--  ── WHY THE CHECK IS KEPT AT ALL ────────────────────────────────────
--  Dropping it would be the easy move and the wrong one: this column
--  decides which batches the operator rent roll reads, so an
--  unconstrained value is a batch that silently never reaches a screen.
--
--  CLASSIFICATION: Class 1. Constraint corrected; no data changes.
-- ════════════════════════════════════════════════════════════════════

alter table import_batches
  drop constraint if exists import_batches_source_type_check;

alter table import_batches
  add constraint import_batches_source_type_check check (source_type in (
    --  A dated rent-roll ledger import. Written by loadLedgerSnapshot,
    --  reached from POST /operator/rent-roll/import and from Asset
    --  Management activation. Read back by readLatestSnapshot.
    'rent_roll_ledger',

    --  A reconciled unit timeline. Written by loadReconciliation, reached
    --  from the same route's reconciliation branch. Read back by
    --  readLatestReconciliation — which is why it is NOT in
    --  readLatestSnapshot's batch filter and must not be added to it.
    'rent_roll_reconciliation',

    --  A point-in-time snapshot reconstructed from a reporting package.
    'historical_snapshot',

    --  Reserved by migration 046 and still produced by no writer in this
    --  repository. Kept because removing a value the schema has always
    --  permitted is a NARROWING, and narrowing is how a migration breaks
    --  a caller nobody looked for.
    'live',
    'demo'));
