# Position-kind mapping correction receipt — 2026-09-13

## Scope

Portable correction for `tools/apply_unit_type_mapping.js`, built from exact
`5765357d2933cce144ad1d9b74b79090f0580afe6` on branch
`codex/position-kind-mapping-20260913`. No migration, product API route, source
identity, or production classification was changed.

## First red and intention

The existing Skyline ruling already states “bed-grained” in the ruling note and
the repository’s release/source notes identify Skyline as bed-based. The apply
loop at the baseline `tools/apply_unit_type_mapping.js:369-375` nevertheless
executed `update spaces set position_kind='unit'`, unconditionally overwriting
the structural kind while assigning the reviewed unit type and use. The prior
13/0 Skyline harness did not assert this field, so it passed while leaving the
wrong kind. This is a source-confirmed defect; no production run was used to
prove or repair it.

## Correction

Each approved `RULINGS` block now carries an explicit `position_kind`. Before
the first write, the tool refuses a selected ruling with no valid kind, a unit
ruling whose source links multiple coded positions under one unit, or a bed
ruling with an unlabeled coded position. Dry run reports the approved kind and
the number of coded positions whose kind would change. Apply writes the ruling’s
kind and the existing reviewed `use_type` together, preserving unit type IDs,
source relationships and named overrides.

The existing Skyline e2e now asserts the 160 coded positions remain `bed`,
checks the dry-run kind diff, verifies reapply leaves grain/use/type counts
unchanged, and exercises both pre-write refusal paths.

## Owned proof

Runtime used the bundled Node runtime and PostgreSQL 17.11 binaries. The
separate disposable loopback PostgreSQL cluster listened on `127.0.0.1:55454`;
the proof database was created through `tests/e2e/proof_boundary.js` with an
ownership manifest and built from the real migration chain through ledger 197.
No credentials are recorded here.

Commands, run from the API checkout:

```text
node tests/e2e/skyline_unit_type_mapping.e2e.js
node tests/verify_source_governance.js
git diff --check
```

The focused Skyline harness completed **20 passed / 0 failed**:

- dry run selected `skyline_owner_statement_2026-08-20_source_silent_on_bath_distinction`;
  it reported approved `bed` grain and 160 proposed kind changes;
- apply covered 72 real units and 160 coded positions, with all 160 retaining
  `position_kind=bed`, exactly 3 governed types, and all 6 uncoded legacy rows
  untouched;
- reapply was a no-op for types, grain and use;
- a unit ruling with two coded positions under one parent refused as
  contradictory and wrote no governed type;
- a bed ruling with one unlabeled coded position refused as incomplete and
  wrote no governed type.

The source-governance runner completed **56 gates / 0 failures**. Its child
outputs are routine source checks; it did not use the proof database.

## Cleanup and limits

The focused harness removed all fixture properties, import rows, batches, unit
types, units and spaces it created. The proof database is task-owned and must
be dropped using its ownership manifest; the PostgreSQL process on 55454 must
be stopped and the port rechecked before handoff. No API server, provider,
browser, production database, or real property classification was used.

This proves the tool preserves an explicit approved ruling and refuses two
structural inconsistencies on a disposable Skyline-shaped replica. It does not
approve the live Skyline data for another classification run, settle source
custody, or authorize applying the tool to production.
