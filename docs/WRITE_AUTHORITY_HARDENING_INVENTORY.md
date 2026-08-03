# Slices 1–9 Write Authority Hardening — Phase 1 inventory

**Nothing has been changed.** The packet's own rule is *"do not change anything
until the full consumer inventory is complete."* This is that inventory, plus
the classification it supports and the one it does not.

Traced against API `main` `4983e5d` and app `c1684d3`. Read-only.

---

## 1. The defect, traced end to end

The audit found the acting user accepted from the request body. Tracing the
consumer completes the chain, and it is worse than the server source alone
shows.

```
index.html:4305   <input id="userId" class="prop-hidden" aria-hidden="true">
index.html:9893   $('userId').value = localStorage.getItem('ps_user_id') || ''
index.html:6353   const userId = () => $('userId').value.trim()
index.html:14171  const body={}; if(userId()) body.approved_by=userId();
index.html:14172  POST /applications/:id/approve
                      headers: x-operator-key  (from $('opKey'), also a text box)
applications.js:496   const { approved_by = null } = req.body || {}
                      → passed to the approval service as the deciding actor
```

**A human types a user ID into a hidden text box in a browser, and that becomes
the durable record of who approved a lease application.** The shared key beside
it is also typed, and is portfolio-wide.

`POST /applications/:id/deny` is the same shape with `decided_by_user_id`,
reaching `closeApprovalGate` and the decision record.

The request body may describe the intended operation. **Here it declares who
performed it, and the server believes it.**

---

## 2. Scale

```
write routes in the tree           261
  /operator/*  (session-gated)      76
  non-operator (shared-key family)  61
in this packet's named scope        23
```

## 3. Route inventory — the packet's scope

`auth` — `KEY` = shared `OPERATOR_KEY`; `SESSION` = staff session;
`TOKEN` = its own governed token; `NONE` = open.
`actor` — where the acting identity comes from.

| Route | auth | property scope | actor | module | session twin exists |
|---|---|---|---|---|---|
| `POST /leasing/leads/:leadId/tour/request` | KEY | path→row | none | no | no |
| `POST /leasing/tours/:tourId/confirm` | KEY | row | `confirmed_by` (body) | no | no |
| `POST /leasing/tours/:tourId/check-in` | KEY | row | `actor_id` (body) | no | no |
| `POST /leasing/tours/:tourId/confirm-prospect` | KEY | row | `actor_id` (body) | no | no |
| `POST /leasing/tours/:tourId/reminder` | KEY | row | `actor_id` (body) | no | no |
| `POST /leasing/tours/:tourId/complete` | KEY | row | session-if-sent, else `b.actor_id` | no | **YES** `/operator/leasing/tours/:tourId/complete` |
| `POST /leasing/tours/:tourId/correct-outcome` | KEY | row | body | no | no |
| `POST /leasing/tours/:tourId/no-show` | KEY | row | `created_by` (body) | no | no |
| `POST /leasing/tours/:tourId/cancel` | KEY | row | none | no | no |
| `POST /leasing/tours/:tourId/reschedule` | KEY | row | none | no | no |
| `POST /leasing/slots/:slotId/book` | KEY | row | none | no | no |
| `POST /leasing/availability` | KEY | **body `property_id`** | `created_by` (body) | no | no |
| `POST /leasing/availability/:slotId/block` | KEY | row | none | no | no |
| `POST /leasing/rungs/:obligationId/resolve` | KEY | row | body | no | no |
| `POST /leasing/conversions` (+3 sub-routes) | KEY | row | body | no | no |
| `POST /applications/submit-public` | **TOKEN** | invitation, row-locked | applicant | n/a | n/a — correctly public |
| `POST /properties/:propertyId/applications` | **NONE** | path | none | no | no |
| `POST /properties/:propertyId/applications/internal` | KEY | path | `decided_by_user_id`, `by_user_id` | no | no |
| `POST /applications/:id/approve` | **NONE** | row | **`approved_by` (body)** | no | **YES** `/operator/leasing/applications/:id/approve` |
| `POST /applications/:id/deny` | KEY | row | **`decided_by_user_id` (body)** | no | **no** |
| `POST /applications/:id/sign` | **NONE** | row | none | no | no |
| `POST /applications/:id/countersign` | **NONE** | row | `confirmed_by` (body) | no | **YES** `/operator/leasing/applications/:id/countersign` |
| `POST /applications/:id/confirm-term` | dormant guard + perimeter | row | `confirmed_by` (body) | no | **YES** `/operator/leasing/applications/:id/confirm-term` |
| `POST /applications/:id/lease-packet` | **NONE** | row | none | no | no |
| `POST /lease-packets/:id/send` | **NONE** | row | none | no | no |
| `POST /operator/pricing/{draft,review,publish}` | **SESSION** | session | session | **yes** | n/a — already correct |

**Nine routes in scope carry `mw=[]`** — no `requireOperator` on the router
line at all. They sit behind `server.js`'s global operator-key gate, which is
the same portfolio-wide credential, not a per-route decision.

```
actor-from-body fields found      approved_by · decided_by_user_id · actor_id ·
                                  by_user_id · confirmed_by · created_by ·
                                  completed_by · recorded_by
property-from-body fields found   POST /leasing/availability
                                  POST /properties/:propertyId/sms-number
                                  POST /units/:id/schedule-move-in
```

**Pricing is already correct** and needs no work in this packet: session-gated,
module-entitled, actor and property from the session. Its Class F is authority
*governance* (who may publish), not authentication.

---

## 4. Consumer inventory

Searched: API `src/`, `server.js`, `tests/`, `tools/`, `seeds/`, `docs/`, and
the whole app repository. Route-definition lines excluded from counts.

| Route | src | server | tests | tools | docs | app |
|---|---|---|---|---|---|---|
| `/leasing/tours/:tourId/complete` | — | 1 | 5 | — | 3 | **5** |
| `/leasing/tours/:tourId/correct-outcome` | 1 | — | — | — | 2 | **1** |
| `/leasing/tours/:tourId/check-in` | — | — | — | — | — | **1** |
| `/leasing/availability` | 1 | — | 6 | — | 5 | **1** |
| `/leasing/slots/:slotId/book` | 1 | — | 5 | — | — | — |
| `/leasing/rungs/:obligationId/resolve` | 1 | — | — | — | 4 | — |
| `/leasing/conversions*` | 6 | — | — | — | 1 | **1** |
| `/applications/submit-public` | 3 | 1 | 2 | — | 3 | — |
| `/properties/:propertyId/applications` | — | — | 16 | — | — | **4** |
| `/applications/:id/approve` | 2 | — | 8 | — | 4 | **2** |
| `/applications/:id/deny` | — | — | 3 | — | 3 | — |
| `/applications/:id/sign` | — | — | 2 | — | 1 | **1** |
| `/applications/:id/countersign` | 2 | — | 2 | — | — | **2** |
| `/applications/:id/confirm-term` | 4 | — | 6 | — | — | **1** |
| `/applications/:id/lease-packet` | 1 | — | — | **5** | 1 | **2** |
| `/lease-packets/:id/send` | 1 | — | — | **4** | — | **2** |
| `/leasing/leads/:leadId/tour/request` | — | — | — | — | 1 | — |
| `/leasing/tours/:tourId/confirm` | — | — | — | — | 1 | — |
| `/leasing/tours/:tourId/reschedule` | — | — | — | — | 1 | — |
| `/leasing/tours/:tourId/no-show` | — | — | — | — | — | — |
| `/leasing/tours/:tourId/cancel` | — | — | — | — | — | — |
| `/leasing/leads/:leadId/lost` | — | — | — | — | — | — |
| `/leasing/leads/:leadId/reply` | — | — | — | — | — | — |

**The `tools/` hits are proofs, not integrations.** `proof_lease_packet_operator_http.js`
declares itself *"Deployed HTTP proof for the two staff-session routes"*, and
`proof_lease_packet_operator_static.js` is a source-structure check. Neither is
a production consumer.

**No vendor integration, automation service or deployment configuration
referencing any of these routes was found in either repository.**

---

## 5. Classification

| Class | Routes | Basis |
|---|---|---|
| **MIGRATE** | `/leasing/tours/:tourId/complete` · `/applications/:id/approve` · `/applications/:id/countersign` · `/applications/:id/confirm-term` | active app consumer **and a session twin already exists**. Migration is repointing a caller, not building a door. |
| **MIGRATE (twin must be built)** | `/leasing/tours/:tourId/correct-outcome` · `/leasing/tours/:tourId/check-in` · `/leasing/availability` · `/properties/:propertyId/applications` · `/applications/:id/sign` · `/applications/:id/lease-packet` · `/lease-packets/:id/send` | active app consumer, no session twin |
| **MIGRATE (no app consumer, test-only today)** | `/applications/:id/deny` · `/leasing/rungs/:obligationId/resolve` · `/leasing/slots/:slotId/book` · `/leasing/conversions*` | a governed staff decision with no session door. `deny` is the sharpest: an application rejection is a durable institutional decision reachable only through the key. |
| **NOT IN SCOPE — correctly public** | `/applications/submit-public` | its own governed auth: invitation token, digest-matched, row-locked; invalid/expired/never-sent fail closed |
| **NOT IN SCOPE — already correct** | `/operator/pricing/{draft,review,publish}` | session, module, server-derived actor and property |
| **BLOCKED — consumer ownership not establishable from source** | `/leasing/tours/:tourId/{no-show,cancel,confirm,reschedule}` · `/leasing/leads/:leadId/{tour/request,lost,reply}` | **zero in-repo consumers** |

### Why the zero-consumer routes are BLOCKED and not RETIRE

The packet's own instruction is *"do not infer that a route is unused because
the browser does not call it."* The credential these routes accept is a
**portfolio-wide shared key held outside this repository**. Source can prove a
consumer exists; it cannot prove one does not. Anything holding that key —
a script, a saved request, an integration nobody has mentioned — is invisible
here.

**Retiring them requires one of:** an owner statement that no external holder
of `OPERATOR_KEY` calls them, or production access logs. Neither exists in this
environment. **Seven routes are blocked on that, and it is the only thing
blocking them.**

---

## 6. The target rule, and what it will and will not change

```
authenticated staff session
  → actor derived from the session, never the body
  → property derived from the authorized operating context
  → target record checked against that property
  → module entitlement enforced
  → the SAME canonical service invoked
  → durable mutation attributed to the authenticated actor
```

**The canonical services are not touched.** `completeTourService` already
demonstrates the shape: one service, two doors, no fork, and the session door
passes `recordedByUserId: req.operator.id` with the comment *"SERVER-DERIVED —
never the body."* Hardening is repointing doors at that pattern, not rewriting
decisions.

Body actor fields will be **rejected**, not ignored: a caller sending
`approved_by` is either a stale client or an attempt, and both deserve a 400
rather than silent substitution. Silent ignoring would let a stale app keep
sending a field it believes is honoured.

**Not in this packet:** receipts, replay identity, object resolution, renewal
implementation, agent work. The audit result is preserved unchanged —
0 durable structured receipts, 8 partial, 1 acknowledgment-only, 1 absent;
three idempotency mechanisms, all three replay identities missing from their
public receipts. That pairing is the next packet, because they are one
operational problem.

---

## 7. Renewal ruling brief — decision required, two options

**Finding, frozen: `RECORDING GAP — VERIFIED`.** `renewal_cases` exists
(migration `119_renewal_operating_rail.sql`), is fully designed, and has zero
writers across six search forms. `renewal_decision` obligations are never
spawned either. Zero rows. Two source references, both reads.

**Nothing was built. The decision is yours.**

### Option A — complete the renewal rail

Build, in one bounded slice: the canonical writer for `renewal_cases` as an
append-only supersedable record; the `renewal_decision` obligation lifecycle
that 119 already specifies; the `lease_offers` scope=`renewal` linkage; the
authority checks; the receipt; the recovery behaviour.

*Cost:* a full slice with real-Postgres and HTTP proof.
*Effect:* the renewals surface stops deriving its operating state and starts
reading a record that is actually written. The design work is already done and
recorded in 119 — this is implementation, not design.

### Option B — retire the dormant rail

Mark `renewal_cases` deprecated and remove it from `renewals_read.js` as an
active authority, so the read derives from position and lease facts only and
says so. Keep the table and 119 as a design record; publish the deprecation so
no surface treats it as populated.

*Cost:* small.
*Effect:* the read becomes honest about its own sources. Nothing else changes,
because nothing writes it today.

### The recommendation, and the thing that must not happen

**Recommend B unless renewals are the next operating slice.** A designed,
migrated, zero-writer table that a live read joins against is a standing
invitation to assume it is populated — and the read currently looks complete
precisely because it falls back to derivation. That is the shape of a confident
blank.

**Either option is acceptable. Leaving it as-is is not**, and that is the whole
point of raising it.

---

## 8. Status

```
PHASE 1 COMPLETE — INVENTORY AND CLASSIFICATION
NOTHING CHANGED
BLOCKED ON ONE OWNER INPUT BEFORE ANY RETIREMENT
```

**Ready to proceed without further input:** the MIGRATE set — four routes whose
session twin already exists, and the rest whose twin must be built.

**Requires your answer first:** whether any external holder of `OPERATOR_KEY`
calls the seven zero-consumer routes. Everything else in the packet can start
now.
