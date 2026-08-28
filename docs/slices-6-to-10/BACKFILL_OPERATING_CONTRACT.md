# EXACT-LINKS BACKFILL — OPERATING CONTRACT (VERIFIED, NOT REDESIGNED)

`tools/appointment_attribution_backfill.js`, verified at commit `b4ab228`
against real Postgres with the bridge supplied by migration 127.

**Outcome: all eight required properties were already true. No automatic
execution path existed, so nothing was removed and no code was changed.**

---

## 1 · THE EIGHT CHECKS

| # | required property | verdict | evidence |
|---|---|---|---|
| 1 | not imported by application runtime | **PASS** | the only `require` of it anywhere in the repo is its own proof (`tests/proofs/slice9_attribution_backfill_proof.js:20`). Zero references in `src/` or `server.js`. |
| 2 | not called by migration startup or deployment hooks | **PASS** | `prestart` is `node migrations/migrate.js`; `start` is `node server.js`. No `render.yaml`, no `Procfile`, no other hook file exists. No migration references it. |
| 3 | does not run automatically | **PASS** | instrumented `Module.prototype.require` while loading `server.js`: **0** backfill requires observed. Importing the module directly opens no connection and attempts no write — the CLI body is behind `if (require.main === module)` (line 134). |
| 4 | supports read-only / dry-run mode | **PASS** | dry run is the **default posture**. `--apply` is required to write; the CLI issues `rollback` unless `apply` is set. |
| 5 | writes require explicit deliberate invocation | **PASS** | two independent gates: the `--apply` argv flag, and `DATABASE_URL` must be supplied by the operator. Neither is defaulted. |
| 6 | never overwrites an existing different `conversion_id` | **PASS** | every write carries `and conversion_id is null`. A row holding a different opportunity is counted into `conflict_left_alone` and reported by id, never rewritten. Proven at `slice9_attribution_backfill_proof.js` ("a row already carrying a DIFFERENT opportunity is left exactly as it was"). |
| 7 | emits a receipt with the five counts | **PASS** | receipt below. `exact candidates` = examined · `written` · `already correct` = unchanged · `conflicts LEFT ALONE` = conflicting · `left NULL by design` = untrackable. Plus `refused, wrong property`. |
| 8 | replay writes zero additional rows | **PASS** | run 3 below: `written 0`, `already correct 2`. |

## 2 · THE RECEIPT, AS EMITTED

Three runs, identical invocation, one transaction, fixture-scoped:

```
─── RUN 1 (dry run, the DEFAULT) ───      ─── RUN 2 (--apply) ───       ─── RUN 3 (replay) ───
  exact candidates          2               exact candidates      2       exact candidates      2
  would write               2               written               2       written               0
  already correct           0               already correct       0       already correct       2
  conflicts LEFT ALONE      0               conflicts LEFT ALONE  0       conflicts LEFT ALONE  0
  refused, wrong property   0               refused, wrong prop   0       refused, wrong prop   0
  left NULL by design      16               left NULL by design  16       left NULL by design  16
```

Run 1 wrote nothing and the database was verifiably untouched afterwards.

## 3 · RECONCILIATION TO THE RULED OPENING STATE

**2 written + 16 left NULL = 18.** That is exactly the frozen historical
opening state — 2 of 18 exactly attributable, 16 of 18 untrackable from
existing evidence, **zero inferred links**. The tool reproduces those numbers;
it does not move them, and it has no code path that could. Verified absent:
active-conversion lookup, person+property lookup, lead-based attribution,
nearest-time selection.

**These numbers are not to be improved.**

## 4 · NOT DONE IN THIS CUT

The backfill was **not** deployed and **not** run against production. It has
only ever executed inside a rolled-back transaction on a local proof database.

Migration 121's provenance defect — production carries
`ai_leasing_operating_rules`, two triggers and `agent_runs` constraints that no
release branch's source can rebuild — remains recorded as an **external
source-rebuild defect**. It is not repaired here and its repair is not absorbed
into Slice 9.
