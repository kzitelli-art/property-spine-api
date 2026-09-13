# Combined migration 194→198 release and recovery receipt

Date: 2026-09-13

This candidate adds a strict release wrapper for the already reviewed migrations 195–198. It does not change `migrations/migrate.js`: that runner remains the transaction owner and commits one numbered migration at a time. The wrapper accepts only these operations:

| Database state | Accepted command | Result |
|---|---|---|
| exact 194 | `node tools/release/migration_194_198_predeploy.js --apply` | apply 195–198 |
| exact 195 | `... --resume195` | apply 196–198 |
| exact 196 | `... --resume196` | apply 197–198 |
| exact 197 | `... --resume197` | apply 198 |
| exact 198 | no argument | verify only |

Every command also requires `EXPECTED_SHA` to be the full 40-character executing commit. It verifies the exact ledger and pending suffix, reviewed migration hashes, tracked and clean release entrypoints, positive lock and statement timeouts, and physical definitions rather than object names. Unknown arguments, wrong resumes, missing or extra ledger rows, future migrations, build-pin drift, tracked changes and physical drift refuse before applying a suffix.

The physical contract covers migration 195's check definitions; migration 196's columns, checks, foreign-key actions and valid/ready indexes; migration 197's correction ledger, checks, foreign keys, valid/ready indexes, normalized function body hash and all 24 policy-derived trigger definitions; and migration 198's valid/ready partial unique index including `import_source_row_id IS NULL`. Trigger checks bind the exact public function OID and complete normalized `pg_get_triggerdef`, including the absence of a weakening `WHEN` clause or transition relations.

## Owned PostgreSQL evidence

The final local witness used a nonce-owned PostgreSQL 17 cluster on loopback port 55461 and an exact-194 database named `spine_proof_ef3fff938e584f498d3880c0703bbecd`. The prior lane built the fixture from the real migration chain at the live 194 source, following the historical self-recording and precondition semantics documented in `tests/e2e/apply_migrations.sh`; no currently available Bash executable is claimed. All release applications of 195–198 used the unchanged canonical runner through the wrapper.

`tests/proofs/migration_194_198_release_recovery.db.js` passed 52 assertions with zero failures. It cloned the exact-194 fixture for each case and dropped every clone. It proved:

- a clean 194→198 run ends at 186 ledger rows and ceiling 198, with no business-row count change;
- an actual held lock fails each of 195, 196, 197 and 198, PostgreSQL reports the configured lock timeout, and the exact committed ledger and physical state remain available for the required retry or explicit resume;
- migration 195 failure stays at 194 and recovers through ordinary `--apply`;
- failures after 195, 196 and 197 accept only the matching `--resume195`, `--resume196` and `--resume197`;
- a single real `--apply` from 194 can commit 195–197 and then fail migration 198, after which `--resume197` reaches exact 198;
- node-postgres installs the positive child `statement_timeout` supplied through `PGOPTIONS`;
- repeat wrapper verification and ordinary migration-runner verification are read-only at exact 198;
- two separately started fenced API processes answer owned `/health` at exact 198 with the pinned build, stop between starts, and record no non-loopback network attempt;
- a wrong build pin, ledger-name drift, an incompatible pre-196 identity row and same-name malformed 195 constraint, 196 index, 197 function body, 197 trigger timing, 197 `WHEN (false)` trigger and 198 index all refuse.

Focused exact-198 evidence also passed:

- migration release contract: 23/23;
- source-home mounted HTTP review: 54/54 on a separate nonce-owned database and fenced server;
- inventory relationship policy: 63 referencing columns, 63 policy entries, 24 migration-197 blocking tables and 25 total installed triggers (the additional trigger is the pre-existing lease guard);
- inventory correction source contract: pass;
- source governance: 56/56 at implementation checkpoint `f0500df655e40b68c6274894c4f2ff136753175e`.

The pure release contract is registered in `tests/e2e/verify_all.sh`. The recovery matrix remains a separately invoked owned proof because it requires a second database at exact 194; the main full-CI database advances to 198 and must not be downgraded or have its ledger rewritten to manufacture recovery state. Reproduction is:

```powershell
$env:HARNESS_DATABASE_URL='postgresql://postgres@127.0.0.1:<owned-port>/spine_proof_<32-hex-nonce>'
$env:HARNESS_NONCE='<same-32-hex-nonce>'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
node tests\proofs\migration_194_198_release_recovery.db.js
```

## Recovery and compatibility limits

Recovery is forward-only once any of 195–198 commits. An API that understands the reached ledger and carries this wrapper and all remaining migrations is the recovery artifact. Rolling the API back below migration 195, deleting ledger rows, or manually dropping the new constraints, function, triggers or indexes is not a supported recovery action. A final integrated API artifact, its deployment command and provider rollback controls remain release-coordinator work; this branch does not claim deployment.

The currently cached app build safely treats the new `execute_lease` action as unknown and the old Deal Setup request is refused before an operating write when it omits the new review token and decisions. It has no source-review or inventory-correction controls. The combined successor app contains those controls, but this API lane did not perform a cached-browser post-198 rehearsal. Retained standalone Approve remains intentional compatibility under `two-step-leasing/QB_SUCCESSOR_20260913.md`; it is not relabeled as Execute.

Production was read only by the release coordinator: PostgreSQL 18.6 was at 182 ledger rows/ceiling 194, with the expected 194 prerequisites and no 195–198 objects or incompatible pre-196 identity rows. No production preflight or migration ran. This receipt's full runtime and catalog proof used PostgreSQL 17; the separate PostgreSQL 18.6 rerun is recorded independently and must be required before claiming the production-version catalog gap closed. No provider, shared-database, source-confirmation, customer, deployment or real-property action occurred.
