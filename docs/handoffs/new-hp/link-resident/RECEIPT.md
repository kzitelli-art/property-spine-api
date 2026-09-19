# Link resident — receipt

**2026-09-19** · API `claude-opus/link-resident-20260919` (from
`claude/rentroll-grain-refusal-20260918` @ `8169b2c9`) · app
`claude-opus/link-resident-app-20260919` (from `claude/app-convergence-20260919`
@ `1060c23`).

## What was built

One door. `POST /operator/leases/:leaseId/link-resident` turns row 156's
deliberately-unlinked resident claim into a durable Person, through
`person_ingress.ingestPerson` and nowhere else.

| Piece | File | Class |
| --- | --- | --- |
| Route + gate + promotion | `src/tenancy/link_resident.js` | 1 |
| Mount | `server.js` | 1 |
| Proof | `tests/proofs/link_resident.db.js` | 1 |
| CI registration | `tests/e2e/verify_all.sh` | 1 |
| App control + named action | `property-spine-app/index.html` | 1 |
| App harness | `property-spine-app/link_resident_app.test.js` | 1 |

## The design call that needed a ruling

`activation_id` is **deliberately not passed** to `ingestPerson`.

With `channel:'rent_roll'` + `activation_id` + `import_source_row_id`, ingress
first honours a confirmed person proposal for that row. A reviewer who earlier
judged the row `distinct_unlinked` would short-circuit this link to
`person_id: null` **forever**.

That verdict was reached under a specific condition: a different person from
every candidate, **and nothing to recognise them by**. An operator arriving at
this door has supplied precisely the thing that was missing. Honouring the old
decision would make the handle unusable — the opposite of what row 156 left
open.

Omitting it has a second property worth naming: `writeProposal` returns
immediately without an `activation_id`, so a conflicted outcome writes no stray
claim row. "409 and write nothing" becomes structural rather than something a
rollback has to remember.

`person_ingress`'s staging rule is untouched. This module never calls
`confirmPersonProposal` and never writes `persons`.

## Proof levels reached

| Rung | State |
| --- | --- |
| Reported | yes |
| Locally exercised | yes |
| Built-but-dormant | no — mounted and routed |
| **Proven (real DB + real HTTP)** | **yes — 34/34, twice** |
| Browser verified | **no** |
| Ask Spine registered (§40.2) | **no** |

`tests/proofs/link_resident.db.js` — 34 assertions, owned proof database, real
services, real HTTP over a real socket. Fixture built through the Deal Setup
path (three units → three unlinked leases), so the leases under test are
established exactly as production establishes them.

Run twice consecutively: 34/34 both times. `person_continuity_handle.db.js`
still 20/20 beside it.

App suite: **78 harnesses · 2657 passed · 0 failed · 0 red**.
Source-governance gates: parent exit 0.

## What was NOT reached

**Done as a screen, not as a domain.** No Ask Spine registration.
`resident_not_linked` appears only in `rent_roll_canonical.js`; no
conversational reader surfaces it, so an entitled person cannot ask *"which
residents are not linked?"* and get a governed answer. The browser rung for the
app control was not run either.

## Found and not fixed

1. **`gate_person_ingress` fails 2** — `src/baseline/baseline_routes.js` writes
   `insert into persons` outside the ingress boundary, and `server.js` is stale
   in the DECLARED register. Pre-existing: verified identical at the branch
   point with these changes absent. Neither names this file.

2. **`POST /leases/:id/tenants` already exists** in
   `src/tenancy/lease_lifecycle_routes.js`. Legacy shared-key surface; attaches
   an already-known `person_id`; no property scoping from a session, no
   ingress, no claim promotion, no evidence-row write. A genuinely different
   door, left alone — but a real adjacent duplication someone should rule on
   rather than discover.

## Refusals, in the words an operator sees

| Case | Status | Said |
| --- | --- | --- |
| No phone or email | 400 | a name alone is not something Spine can recognise them by later |
| No `source_basis` | 400 | say where the handle came from — a call, an email, the signed lease |
| Handle on two Persons | 409 | names the disagreement, returns the candidates, writes nothing |
| Lease on another property | 404 | not 403 — a forbidden would confirm it exists |
| Lease already linked | 409 | correct the tenancy rather than linking a second person |
| Client sends `property_id` | 403 | property is server-derived (§21) |
| No session | 401 | sign in |

No production data was touched at any point.
