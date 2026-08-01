# Proof summary — one obligation engine (branch `claude/obligation-engine-one-implementation`)

**Approved to merge 2026-08-01.** This is the evidence the approval rests on.
Read the four statements at the bottom before citing anything here.

## The claim being proven

`tests/_engine.js` was a hand-maintained VERBATIM COPY of the obligation engine,
kept in step with `server.js` by discipline. It had drifted — in three places,
all PERMISSIVE:

- `spawnObligationFromEvent` was missing five columns, including `dedupe_key`,
  the idempotency mechanism, and the durable-ownership-at-insert fields;
- `satisfyObligation` was missing the ENTIRE reserved-input guard;
- `completeObligation` was missing the ENTIRE conversion-rail guard.

Every harness importing it was asserting against an engine **more permissive
than production** — a test could pass on behaviour the real system rejects. That
is the same shape `work_order_service.js` documents for `deriveCategories`: two
implementations of one rule, silently diverging, which had already misclassified
money once.

The branch extracts the engine to `src/shared/obligation_engine.js`, verified
byte-identical to the inline originals, and reduces `tests/_engine.js` to a
one-line re-export. The harness and the server can no longer disagree, because
there is only one implementation to disagree with.

## Evidence

All final DB runs executed on the **isolated Neon branch**
`ep-small-morning-aqxjnmz9-pooler` (migration ceiling 122), never production.

| Harness | Result | What it proves |
|---|---|---|
| `obligation_engine_one_implementation.test.js` | **14 / 14** | the harness bridge IS the real function, not a copy; `server.js` redefines none of the four inline; the reserved-input and conversion-rail guards are reachable through the bridge; `dedupe_key` reaches the INSERT |
| `obligation_engine_import_smoke.test.js` | **8 / 8** | the shared module loads no `server.js`, no `pg`, no `express`, no network module; starts no timers; reads no env; its only local dependency is `obligation_transitions.js` |
| `test_release3.db.js` | **23 / 23** | recovery, reassignment and the event ledger against real Postgres through the shared engine |
| `test_identity_bridge.db.js` | **44 / 44** | staff identity, the authority veto, the admin gate, and real HTTP through the shared engine |
| `test_conversion_rail.db.js` | **11 / 12** | see below — **not fully proven** |

## Four statements that must travel with this summary

1. **The conversion rail is NOT yet fully proven.** It stands at 11/12.
2. **Scenario 8 is blocked by ITEM 1** — `obligations.status='missed'` is
   unwritable against `ck_obl_status`. That is a pre-existing product-model
   defect on `main`, which this branch neither caused nor conceals. It is
   recorded in `BLOCKING_DESIGN_ITEMS.md` and ruled on there.
3. **No test was weakened to produce green.** Every correction was fixture-side,
   supplying the real conditions production requires rather than relaxing them:
   - the conversion rail's `mkUser` now builds genuinely eligible staff through
     the same five-condition chain `resolveStaffIdentity` walks;
   - `test_identity_bridge.db.js` gained per-run identities (emails, session
     tokens, `request_id`), the missing closure authority on its conversion
     mount, and the team-authority rows the 2026-07-26 veto requires;
   - `test_release3.db.js`'s only failure was two `readFileSync` paths left
     behind by the domain reorg.
   `CONVERSION_RAIL_REQUIRED`, the reserved-input guard, the durable ownership
   fields, dedupe behaviour, the authority veto and the admin gate are all
   untouched. Scenario 4b was ADDED, pinning that an ineligible host keeps
   attribution while the obligation stays honestly UNASSIGNED.
4. **All final DB runs occurred on the isolated database.** Production Neon is no
   longer an accepted target for any harness — `HARNESS_DATABASE_URL` is now
   required, with no fallback, and a same-target check refuses production even
   when the connection string differs by password or parameters. See
   `DB_HARNESS_ISOLATION.md`, which also carries the read-only manifest of
   synthetic rows earlier runs committed to production. That cleanup is
   outstanding and separately governed.

## What this branch does NOT prove

The conversion rail end to end; the `missed` path in any form; anything about
`conversation_owner_user_id` (ITEM 2); anything about communication lines.
