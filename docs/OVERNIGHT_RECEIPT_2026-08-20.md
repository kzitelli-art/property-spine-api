# Overnight receipt — 20 August 2026

```text
INTENT   one canonical governed path to Skyline pricing authority, proven
         off-production, then drive the real pricing path to its first red.
```

## Existing mechanism (found, not built)

| fact | owner | state before |
|---|---|---|
| `person_contexts` staff scope | `src/identity/staffbridge.js` — sole writer | reachable, mounted, audited — but **no path to a second property** |
| `assignments` authority role | `src/identity/authority_resolution.js` | governed, 7 preconditions, receipt — **dormant, no HTTP route** |
| `assignments` authority role | `src/surfaces/orgchart.js` | **reachable**, OPERATOR_KEY only, **no actor recorded** |
| governed unit types | `tools/apply_unit_type_mapping.js` | governed CLI, owner-approved mapping, dry-run, idempotent |

## Observed reds

1. **Authority bypass.** On a disposable DB, a person `resolveAuthority`
   refused (`person_is_classified_staff`, `person_entitled_to_property`,
   `person_is_not_a_counterparty`) got `may_publish_pricing = true` the
   instant an `assignments` row appeared. `pricingAuthority` reads
   `assignments` and never consults `person_contexts` — the row *is* the
   grant, and orgchart wrote it behind a shared key with no actor.
2. **No second-property entitlement.** `createStaffPerson` writes a scoped
   context only while creating a NEW person; `linkBridge` refuses an
   already-linked one. An established staff person could never become
   entitled elsewhere.
3. **Withdrawn contexts still counted — found by falsification.**
   `authority_resolution` read `person_contexts` with no `active_to`
   filter, so a *closed* staff context still satisfied both staffness and
   entitlement. Revoking entitlement did not revoke it for granting
   authority. The chain proof withdrew a context it had just granted and
   required a refusal; the gate did not notice.
4. **Replica shape wrong at first build.** 72 units produced 232 spaces:
   `trg_unit_space` auto-inserts a `(whole unit)` placeholder per unit.
   Caught by the replica's own shape assertion before anything downstream
   was believed.
5. **First red on the pricing path** — see below.

## Fixes made, each in the existing owner

- **`staffbridge.grantStaffContext`** + `POST /operator/admin/bridge/staff-context`.
  Idempotent (replay reported, not duplicated), attributed via the same
  `created_by_user_id` column `createStaffPerson` uses, session-authorized
  behind `requireBridgeAdmin` with the admin server-derived, and refuses a
  person holding no active staff context — widening entitlement must never
  be what first makes someone staff. Creates no person, touches no
  `users.person_id`, confers no authority.
- **`orgchart` fails closed** for `owner`/`asset_manager`, importing
  `FULL_AUTHORITY_ROLES` rather than re-listing it. Guards both the
  requested role *and the existing row's* role — otherwise a deactivated
  `asset_manager` could be handed its authority back with
  `{"is_active": true}` and no role in the body at all.
- **`authority_resolution`** now filters `active_to is null`.

`roomowners.js` also writes assignments; its `ROOM_TO_ROLE` map contains no
authority-bearing role, so it was left alone.

## Canonical owners preserved

No new authority writer, no second governed implementation, no operator UI.
The consequential write still belongs to `resolveAuthority`; entitlement
still belongs to `staffbridge`; unit types still belong to
`apply_unit_type_mapping.js`.

## Hostile proofs — `tests/e2e/authority_chain.e2e.js`, 16/16, wired into CI

```text
✓ no authority before anything is granted
✓ grantor refuses without an entitling context
✓ context granted, and it records the acting admin
✓ replay reported, exactly one active row
✓ person with no staff context refused
✓ grantor applies; provenance names the real actor and reason
✓ prepare / review / publish all true, basis assignment:asset_manager
✓ wrong property still refused
✓ orgchart refuses asset_manager, and confers nothing
✓ an existing authority row cannot be re-activated from the org chart
✓ FALSIFIED: withdraw the context → the grantor refuses again
```

## The pricing drive — `tests/e2e/skyline_pricing_drive.e2e.js`

Replica reproduces production's canonical shape exactly: `leasing_basis
bed`, **72 units / 160 rentable positions / 0 governed unit types**,
confirmed by `datedPropertyPositions`. Authority established through the
newly-proven rail. Then:

```text
✗ effectivePropertyPricing        returns ZERO types to price
✓ previewPublication              refuses
✓ resolveSpaceEconomics           refuses — unit_type_not_established
```

```text
FIRST OBSERVED RED
  The pricing worksheet has no unit types to price.
  Three independent surfaces agree, and each refuses honestly.
```

## Exact next blocker — a business ruling, not code

`apply_unit_type_mapping.js` maps a **source code** to a governed type via
`import_source_rows.produced_space_id`, from an **owner-approved** list. The
list in the file today is an apartment floorplan vocabulary (`S.1UN_02`,
`1.1DN_02`, …) approved 2026-07-27 for a different property. Skyline is
bed-based, and nobody can approve a Skyline mapping without seeing Skyline's
actual codes.

So `tools/release/unit_type_source_codes.js` (read-only, decides nothing)
reports the codes that are really there — with row/unit/position counts,
coverage, and which raw keys exist at all if `unit_type` is absent.

**The morning question:** for each code it returns, what is the human label
and the use type (`residential | commercial | non_revenue | other`)?

## Deliberately NOT touched

The 160 unclassified positions and the six unresolved 31-July baseline rows
did **not** appear in the first red. `resolveSpaceEconomics` stops at
`unit_type_not_established`, which is upstream of both. They stay logged and
unrepaired until something actually blocks on them.

## Production actions waiting for approval

```text
1. KZ Skyline staff context       POST /operator/admin/bridge/staff-context
                                  (or the service from the Render shell)
2. KZ asset_manager assignment    resolveAuthority, apply=true
3. Skyline unit-type mapping      needs the ruling above first
```

No production writes were made. No entitlement granted. No pricing
published. No Mike activation. No identity or property cleanup.
