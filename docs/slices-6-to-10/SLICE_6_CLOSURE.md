# Slice 6 — Renewals Operating Rail: CLOSURE

**Date:** 2026-07-31
**Status:** `SLICE 6: CLOSED` · `SLICE 7: AUTHORIZED`

Slice 6 turned Renewals from a read-only expiration cohort into a complete
operating rail, live-proven end-to-end against production.

## Build identity

| | API | App |
|---|---|---|
| Branch | `feat/slice-6-renewals-rail` | `feat/slice-6-renewals-destination` |
| PR | #20 (merged) | #21 (merged) |
| Merged SHA | `9cba504` | (main after #21) |
| Deployed | ✅ Render live | ✅ Render live (`ps-rnw-rail` present) |
| DB | migration **119** applied (ledger + `renewal_cases` verified) | — |

## What shipped

- **Migration 119** — `renewal_cases` (append-only, supersedable; `uq_renewal_case_active`). Reuses `obligations` (ownership/due) and `lease_offers` scope=renewal (offers). One ownership machine, one offer machine.
- **`renewal_lifecycle.js`** — pure state machine: stage / operating_state / waiting_on / blocker / due_state / economics view / one primary_action. Emits only what a fact authorises.
- **`renewalsCohortEnriched`** — joins the successor-aware R1 population to cases/offers/obligations; reconciled home counts from one projection.
- **App destination** — renders the full rail; home Renewals card reconciles on the same `count`.

## Proof ladder — all rungs met

| Rung | Evidence |
|---|---|
| Real DB | migration 119 applied + verified on live Neon |
| Real HTTP | `GET /operator/leasing/renewals` (authenticated) returned 35 open decisions with the full contract |
| Tests | `renewals_slice6_proof.js` 51/51 (35 pure + 16 real-Postgres, rolled back; refuses green without DB) |
| Count reconciliation | live: total_active 35 = rows; unassigned 35, blocked 34, decision_required 34 — all match rows |
| Honest nulls | `proposed_rent: null`, `economics_source: null` on every row (no governed economics yet); no fabricated overdue |
| **Browser verified** | live authenticated session drove the deployed app to the Renewals destination — rendered stage/blocker/ownership badges, `Assign owner` / `Review renewal` actions, successor-pending (49) + conflicted (6) context, counts rail (34 blocked / 35 unassigned). Screenshot captured. |

## Boundaries held

- **Economics**: Slice 6 displays governed economics and routes to Market & Pricing to set them (`set_renewal_economics`) — never authors a renewal price. Slice 8 owns that.
- **No renderer writes**; actions route to where the work is done. No optimistic row removal.
- Additive migration only; property scope from session; no fixture fallback.

## Gate note

The Slice-6 preconditions (governing handoff) are now **GREEN**: the leasing home shows the permanent architecture — **Tours · Follow Ups · Lead Conversations · Renewals · Market & Pricing** — confirmed in the live browser capture. Kameron's Slice-5-closure rename landed. All 8 preconditions pass.

## Carried forward to Slice 7+

- The renewal **write commands** (`prepare_renewal_offer`, `record_resident_response`, `verify_execution`, …) are named by `primary_action` but their server contracts are not yet built — the destination routes the operator to where the work is done. These land with their own contracts + proofs when prioritised.
- `Set renewal economics` routes to **Market & Pricing** — Slice 7 builds that workspace; Slice 8 makes governed renewal economics real, at which point `proposed_rent` fills.
