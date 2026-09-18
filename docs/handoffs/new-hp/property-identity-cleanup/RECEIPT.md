# Property identity cleanup — production receipt

**Accepted 2026-09-16 12:39 UTC.** The production API is `cd7279ebb23865f4e3e7f9c827dd4b5cc52d475f`; the unchanged production app is `3607b3d5891a4a96b6b5183ead875b974863aef9`. Production schema is 187 applied migrations through ceiling 199.

## Result

Property Spine now keeps three different ideas separate:

- the internal property name, which was preserved;
- the human-facing display name, which can be changed only through a governed, audited command;
- the registry-owned operating model and canonical property key, which are identity and were not inferred from the display label.

The portfolio now presents the following names:

| Property ID | Internal name (unchanged) | Human-facing display name | Canonical key | Registry model |
| --- | --- | --- | --- | --- |
| `14e41b7c-e91c-49e8-9651-10c4908a8f6a` | `skyline` | Skyline Apartments | `1417` | bed |
| `a29181cd-3ba1-461c-aead-cd989add1d11` | `greenery` | Greenery Apartments | `1325-N-15` | bed |
| `9e2bb96e-08e2-41db-81c2-91055ceb50a3` | `4233 Chestnut` | Solo on Chestnut | `4233-CHESTNUT` | unit |
| `260b6bac-4738-47c4-b86d-511b726adc48` | `4125 Chestnut` | Uno on Chestnut | `4125-CHESTNUT` | unit |
| `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` | `Property Spine Demo Building` | Property Spine Demo — Solo Shape | unset, with the pre-existing legacy reason | demo/Solo-shaped |

Greenery's registry model is bed, but its operating `leasing_basis` remains `unknown`. This cleanup deliberately did not turn an identity correction into an inventory-basis ruling.

## Governed implementation

API product commit `53522e9` introduced migration 199, the immutable `property_display_name_changes` history, the command service, and super-admin PUT/GET routes. It also corrected the property, leasing, reporting, and exposure projections to prefer `display_name` while continuing to read the model from `deal_registry`.

The command refuses blank labels, rechecks current database authority, records the actor and authority basis, freezes idempotent retries, conflicts changed payloads, and serializes concurrent writes. Focused checks passed:

- `property_identity_presentation.test.js`: 18/18;
- `property_display_name_command.db.js`: 33/33;
- source governance: 57/57 gates;
- full exact-SHA CI run `35095230370`: success on `cd7279e`.

The first canonical-key production attempt found a real compatibility defect: the legacy route set `canonical_key` without clearing `canonical_key_absent_reason`, so the table constraint refused both writes and changed neither property. Successor `cd7279e` clears the obsolete reason atomically and proves the old-row shape. The second attempt returned 200 for both Skyline and Greenery.

## Production writes and receipts

All four display-name writes used actor user `78375274-922a-44c5-8b61-0c285d1b9911`, actor person `c1dedf39-e5bc-4bb9-a22f-083156781ddd`, authority `platform_role:super_admin`, and reason `Portfolio identity cleanup — BUILD_CONTRACT v2 (2026-09-16)`.

| Order | Property | Before | After | Audit receipt |
| --- | --- | --- | --- | --- |
| 1 | Demo | Solo on Chestnut | Property Spine Demo — Solo Shape | `2f24953f-bc9f-46e8-b7ef-91f54b12c77b` |
| 2 | Real Solo | unset | Solo on Chestnut | `c5482ac4-d30b-4de0-8ff0-95c51ac8ac5b` |
| 3 | Uno | unset | Uno on Chestnut | `8f773d7a-20d3-4460-b42c-b13a17da567b` |
| 4 | Greenery | unset | Greenery Apartments | `abed44d8-24d7-4a55-bb6f-b959a32e0fe6` |

The migration was applied before the product deployment. Render deployment `dep-dal8ffbm8hqs73f95fvg` applied migration 199; final successor deployment `dep-dal8l9tg1s2s73eju130` serves `cd7279e`. The one-time pre-deploy command was removed after verification. `/health` identified `cd7279e`, and a fresh ledger read returned 187 rows through 199.

## Production browser acceptance

A short-lived KZ staff session opened the served app and was revoked after the run. The browser used the real production API and property-switch transaction.

- The authorized chooser showed Greenery Apartments, Property Spine Demo — Solo Shape, Skyline Apartments, Solo on Chestnut, and Uno on Chestnut.
- `Solo on Chestnut` appeared exactly once and resolved to the real Solo property ID.
- Skyline opened Management under `Skyline Apartments`; the canonical read remained 160 rentable bed positions and 31 presently established occupied positions.
- Greenery opened Leasing under `Greenery Apartments`; the UI honestly reported the unavailable live reads and did not invent leasing facts.
- `/operator/me` confirmed the selected property label after both switches.
- Read-only loopback HTTP over the production database confirmed the three contract readers return `Skyline Apartments`, canonical key `1417`, and model `bed`: property surface, leasing detail, and monthly reporting dashboard. This used the deployed product source; the checkout delta was documentation/evidence only.
- `document.elementFromPoint` at each asserted label/row center resolved inside the asserted element; no asserted control was covered.
- The browser emitted no page errors.

Evidence:

- [browser acceptance JSON](production-browser-acceptance-20260916.json)
- [three presentation-reader results](production-presentation-reads-20260916.json)
- [authorized property chooser](production-property-chooser-20260916.png)
- [Skyline Management](production-skyline-management-20260916.png)
- [Greenery Leasing](production-greenery-leasing-20260916.png)

## Access and limits

No property assignment, organization, module grant, person bridge, inventory, price, lease, source, or knowledge record changed in this lane. KZ, Mike Grivna, and John Franco retain their existing Skyline and Greenery access. KZ's demo assignment also remains unchanged.

One owner decision remains open: whether the demo property should stay visible to KZ in the normal production chooser. Until that decision is explicit, the system keeps the assignment and makes the demo unmistakable through its new label. Greenery's inventory basis and live-data setup remain launch work; this receipt establishes property identity and presentation, not Greenery operating readiness.
