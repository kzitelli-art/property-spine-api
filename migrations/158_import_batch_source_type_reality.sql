-- ════════════════════════════════════════════════════════════════════
--  158 — THE SOURCE TYPE THE IMPORTER HAS ALWAYS WRITTEN
--
--  Migration 046 created `import_batches` with:
--      check (source_type in ('historical_snapshot','live','demo'))
--
--  `loadLedgerSnapshot` — reached from `POST /operator/rent-roll/import`,
--  the canonical signed-in rent-roll importer — writes:
--      insert into import_batches (… source_type …) values ($1,'rent_roll_ledger',…)
--
--  and `readLatestSnapshot` reads back:
--      where source_type in ('rent_roll_ledger','historical_snapshot')
--
--  No migration has ever permitted that value. Found by building the
--  schema from the migration files and running the importer against it:
--      new row for relation "import_batches" violates check constraint
--      "import_batches_source_type_check"
--
--  ── WHAT THIS MEANS, STATED HONESTLY ────────────────────────────────
--  Against a schema built from this repository, the canonical signed-in
--  rent-roll import CANNOT SUCCEED. Two readings are possible and this
--  migration is correct under both:
--
--    · production's constraint was widened by hand, outside the ledger —
--      in which case the ledger has been lying about the schema, and this
--      makes it true. `drop constraint if exists` makes that safe.
--    · the route has never actually run in production — in which case
--      nothing is being fixed retroactively and this simply lets it work.
--
--  Which one it is, is answerable in one query and worth answering:
--      select source_type, count(*) from import_batches group by 1;
--
--  ── WHY THE CHECK IS KEPT AT ALL ────────────────────────────────────
--  Dropping it would be the easy move and the wrong one: the column
--  decides which batches the operator rent roll reads, so an unconstrained
--  value is a batch that silently never appears on anyone's screen. The
--  vocabulary is widened to what the code actually writes, and no further.
--
--  CLASSIFICATION: Class 1. Constraint widened; no data changes.
-- ════════════════════════════════════════════════════════════════════

alter table import_batches
  drop constraint if exists import_batches_source_type_check;

alter table import_batches
  add constraint import_batches_source_type_check check (source_type in (
    --  A dated rent-roll ledger import. What the canonical signed-in
    --  importer and Asset Management activation both write.
    'rent_roll_ledger',
    --  A point-in-time snapshot reconstructed from a reporting package.
    'historical_snapshot',
    --  Reserved by 046 and still unused by any writer in this repository.
    'live',
    'demo'));
