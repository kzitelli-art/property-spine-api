# Inventory correction final review — 2026-09-13

This is a narrow successor to the migration-197 hardening receipt. It starts
from API `e65dfb26e86d4d546de85acf8f944c587f0fa58c` and unchanged app
`0d035c8ff80e396f63f613a0090314b8338dfbcb`, in isolated sibling worktrees.
It does not authorize a production migration, deployment, provider action,
merge, rebase, reset, or push.

## Defects reproduced first

On a fresh nonce-owned PostgreSQL 17 database, with the delivered source:

1. `unit_events` has both `unit_id` and `space_id` but does not carry the
   application-specific grain trigger. An operative event with a current direct
   unit and a space resolving to retired `H-L05` was accepted on INSERT. An
   event that began current/current was also accepted when UPDATE moved only its
   space to retired `H-L05`. The old migration function selected `unit_id` and
   skipped `space_id`; the old conflict reader used the same coalesce shape, so
   the property-wide standing did not name the retired space target.
2. Two retirement idempotency keys with a common 200-character prefix and
   different final characters became the same stored identity. The first wrote;
   the second returned an idempotent replay and the stored key length was 200.

`lease_applications` correctly refused the divergent shape through its existing
grain trigger. This successor does not create a new generic grain policy.

## Repair

API code commit `c479a9cf834f68d77083d135157186924f9ed55a`:

- Migration 197 resolves both populated relationships and refuses an operative
  row if either resolves to a live-retired unit. An existing operative conflict
  remains closable, but an UPDATE cannot add or retarget a different retired
  target.
- The correction conflict query expands distinct actual targets per row. A row
  whose direct and space targets agree counts once; a divergent legacy row is
  named under each affected retired target.
- The command service refuses `idempotency_key` values longer than 200
  characters with HTTP 400 `idempotency_key_too_long`. It no longer truncates a
  distinct request into an existing command identity.

## Owned evidence

All evidence used `spine_proof_c6d3ba409e63da2010caef35` on loopback port
55453 and the local API on port 3353, with fake transports and the proof fence.

| Check | Result |
| --- | --- |
| Delivered source hardening proof before repair | INSERT and UPDATE divergent-target writes accepted; reader omitted the space target |
| Delivered source key witness before repair | second suffix-only-distinct key replayed; stored key length 200 |
| `tests/e2e/inventory_correction_hardening.e2e.js` after repair | **104 passed, 0 failed, 2 observations** |
| `tests/e2e/inventory_correction.e2e.js` after repair | **85 passed, 0 failed, 4 observations** |
| `tests/unit/inventory_correction_contract.test.js` | PASS |
| `tests/gates/gate_inventory_relationship_policy.db.js` | PASS — 61 references, 61 policy entries, 24 blocking tables, 25 triggers |
| `tests/verify_source_governance.js` | exit 0 — 56 gates |

The hardening proof covers direct-current plus space-retired INSERT and UPDATE
refusals; a legacy divergent fixture named once in both history and standing;
both reader blocker kinds; permissible closing of that legacy conflict; and two
suffix-only-distinct oversized command keys that both refuse without a receipt.

The nonce database is dropped and its PostgreSQL server stopped after this
receipt. No product tenancy, signing behavior, migration source other than 197,
or application code changed.
