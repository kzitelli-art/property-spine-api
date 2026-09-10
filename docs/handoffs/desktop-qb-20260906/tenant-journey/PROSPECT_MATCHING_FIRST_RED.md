# Prospect matching first-red harness — prepared, not yet executed

2026-09-10. Base API `a3e1421`, branch `codex/prospect-matching-20260910`.
Paired existing app checkpoint `f2eda58`; QB knowledge UI candidate is separate.

Intention: a prospect's dates and budget find the exact free bed at its published
asking rent, including a bed override, without discarding it because its sibling
is occupied or because a legacy unit rent disagrees.

Existing mechanism: `leaseableApplicationTargets` supplies the same exact targets
as staff/app, and `resolveSpaceEconomics` supplies chosen-term space economics.
The actual agent's `find_available_units` still delegates to unit-grained
`leasing_inventory.availableUnits`, then applies the type-level pricing adapter.
The earlier date receipt explicitly leaves this cutover open. No new owner,
endpoint, product code or schema is introduced by this harness.

`tests/proofs/prospect_matching_first_red.db.js` first checks fixture validity
through both canonical readers, then drives real `agent._service.processInbound`
with a scripted in-process model, as in `prospect_inventory_dates.db.js`.
Fixtures reuse the baseline/readiness SQL patterns from `opening_claim_identity`
and `availability_readiness_axis`, and draft-then-published pricing fixture
construction from `space_economics`. Publication is a test precondition, not a
proof of the publication workflow.

One occupied sibling and one free sibling share unit101: legacy rent2400,
type default1000, free bed override850. Unit102 has legacy700 and override950;
unit103 has legacy700 and override800. Both 6- and12-month pricing are published
so failure to forward the explicitly stated12-month term cannot hide behind a
one-term default. Budget900 should include101/Room2 and103/Room1, exclude102.

Checks include tool schema, exact durable space identity, selected pricing term,
the canonical `authority` envelope (published version, term row, space override),
and no invitation/offer/outbound dispatch. The matching-only successor must stay
informational: this harness does not license the old unit selection writer to
select a bed or make a promise. Dates are generated from the owned database's
current date; pricing months are explicit assertions, never date rounding.

Run from this worktree using QB's existing fully migrated owned database:

```powershell
$env:E2E_PROOF_MANIFEST = (Resolve-Path ../tmp/qb-ownership.json).Path
$env:E2E_DATABASE_URL = (Get-Content $env:E2E_PROOF_MANIFEST | ConvertFrom-Json).url
$env:NODE_PATH = (Resolve-Path ../api-leasing-knowledge/node_modules).Path
node tests/proofs/prospect_matching_first_red.db.js
```

The owned boundary validates the manifest/database nonce before any insert;
the proof fence blocks provider traffic. QB owns execution and whole-database
cleanup. Fixtures commit because the real agent uses independent transactions;
pool closes in `finally` on failure. No row-level teardown or trigger disabling.
Do not point this at production or a database whose destruction QB does not own.

Expected baseline product failure is exit1 **after `FIXTURE GREEN`**. An error
before that marker is a fixture/infrastructure failure, not evidence of the
matching defect. All product checks collect before the final assertion, so the
log reports the independent missing connections. Prepared checks are not an
observed first red. At authoring, only `node --check` passed; no DB run occurred.

Next action: QB executes in the fenced owned runtime, records the first actual
failure, and corrects fixture defects before assigning product work. This
intentionally red test is not registered in CI until the successor exists.
