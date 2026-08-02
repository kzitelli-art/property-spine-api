# SLICE 9 — UNIT COMMITMENT AUTHORITY AUDIT (Pass 2, documentation only)

**Branch:** `claude/slice-9-demand-evidence` · **Audited head:** `8fd2bbd`
**Date:** 2026-08-02 · **Proof DB:** isolated clone at migrations 120/122/123/124/126

> **Documentation only. No behavioral source or SQL change in this commit.**
> The single non-document edit is a stale comment in migration 124 (§10).

---

## Headline

**Application progression holds no inventory, and the canonical architecture already knows it.**

`position_classifier.js` never reads `lease_applications` at all. It classifies a
position entirely from **leases**, plus possession events, notice, turn state and
two derived proof inputs. Approval, `lease_ready` and `accepted_term_required`
create no space reservation of any kind. The instinct to "add the missing
statuses to availability" would have invented an inventory authority that does
not exist in the model — which is exactly what the Pass 2 ruling anticipated.

**One legacy reader disagrees, and it is live.** `src/tenancy/availability.js`
is mounted at `server.js:3174` and joins applications on **`la.unit_id = u.id`** —
unit lineage, not space lineage — to derive a "pending application" signal. That
is the D7 site, and it is the only place in the product where application status
touches an availability answer.

**Stop conditions 3 and 4 are TRIGGERED.** Implementation should not proceed
until ruled on. Details in §8.

---

## 1. Corrected file locations

The Pass 2 brief guessed two paths. Actual source:

| Module | Brief said | Actually |
|---|---|---|
| turn priority | `src/leasing/turn_priority.js` | **`src/maintenance/turn_priority.js`** |
| lease packets | `src/leasing/leasepackets.js` | **`src/applications/leasepackets.js`** |

All others were correct.

---

## 2. The ten authority questions

| # | Question | Verdict | Source |
|---|---|---|---|
| 1 | Does **approval** create a durable unit/space reservation? | **PROVEN ABSENT** | `applications.js` `approveApplication` writes an event, a `terms_review` obligation, and the application row. No `leases`, no `spaces`, no reservation table. |
| 2 | Does **lease_ready** create one? | **PROVEN ABSENT** | Same write. `lease_ready` is a status plus a `terms_review_obligation_id` pointer. |
| 3 | Does **accepted-term confirmation** reserve, or authorize a later act? | **AUTHORIZES ONLY** | `markTermConfirmationRequiredFromExecutedLease` writes **status only** (Path D). It is the precondition for confirm-term, not a reservation. |
| 4 | What write first creates a **directly space-linked future tenancy object**? | **PROVEN** | `src/tenancy/tenancy_anchor_service.js:281` — `confirmTermService`: `insert into leases (..., space_id, ..., lease_status) values (…,'pending', app.id)`. |
| 5 | What write first **suppresses marketing today**? | **PROVEN — the same write** | `position_classifier.js:111` → `availability_state = "committed_future"`; `:105` → `committed_activation_pending` when a pending lease spans `as_of`. Both read the lease created at Q4. |
| 6 | What makes a commitment **locked**? | **PROVEN** | `position_classifier.js:172` — `executed_verified && move_in_funds_cleared`. Both derived in `space_position.js:147–157`. |
| 7 | What write **activates current economic tenancy**? | **PROVEN** | `src/tenancy/economic_tenancy_service.js:342` — `update leases set lease_status='active', economic_tenancy_activated_at=now()`. Gated on: lease is `pending`, term has commenced, and required move-in funds cleared. |
| 8 | What **releases a pending** commitment? | **PARTIAL** | `src/tenancy/lease_void_service.js:106` — `update leases set lease_status='cancelled'`. It is the ONLY `lease_status` writer besides Q7. |
| 9 | What **releases a locked** commitment? | **PARTIAL — same path** | Same service. There is no separate locked-release act; locked is derived, so cancelling the lease removes it. |
| 10 | Can any position exist **without direct `space_id`**? | **PROVEN NO** | `leases.space_id` is `NOT NULL` in the live schema. Direct space lineage is structurally guaranteed, not conventionally maintained. |

### The finding that matters most

**In the application path, a lease is only ever created *after* a verified
executed-lease record exists.** `confirmTermService` reads the verified record
first and back-fills `executed_lease_records.lease_id` immediately after
(`tenancy_anchor_service.js:289`).

Therefore, for an application-born lease, `executed_verified` is **already true
at birth**. `pending` versus `locked` differs by **funding alone**, never by
execution proof.

This is narrower than the brief's model, which described pending as "proof
incomplete" in general. For application-born leases the only incomplete proof is
money. Imported leases (`activation.js:402`) are inserted directly at `active`
and never pass through `pending` at all.

---

## 3. Chronological write trace — application to position

| # | Act | File | Durable write | space_id | Proof authored |
|---|---|---|---|---|---|
| 1 | Birth | `application_lifecycle.js:283` | `lease_applications` @ `submitted` + `submitted_at` | — | milestone |
| 2 | Approve | `applications.js` `approveApplication` | status `lease_ready` + `approved_at`; `terms_review` obligation | — | milestone + obligation |
| 3 | Proposed terms | `proposed_terms_service.js` | terms confirmation | — | normalized hash |
| 4 | Packet | `leasepackets.js` | `lease_packets` | — | packet state |
| 5 | Executed evidence | `executed_lease_service.js:271` | `executed_lease_records`; sets `lease_applications.executed_lease_record_id` | via `space_id` on the record | verified/voided |
| 6 | Admission | `executed_lease_service.js` (Path D) | status `accepted_term_required` — **status only** | — | none |
| 7 | **Confirm term** | **`tenancy_anchor_service.js:281`** | **`leases` @ `pending`, `space_id`, `application_id`** | **YES** | **first commitment** |
| 8 | Link evidence | `tenancy_anchor_service.js:289` | `executed_lease_records.lease_id` | — | lease↔evidence |
| 9 | Activate app | `application_lifecycle.js:478` (Path E) | application `active` + `activated_at` | — | milestone |
| 10 | Move-in charges | `economic_tenancy_service.js` | `scheduled_charges` (`is_move_in_required`) | via lease | funding set |
| 11 | **Activate tenancy** | **`economic_tenancy_service.js:342`** | **`leases` @ `active` + `economic_tenancy_activated_at`** | — | current tenancy |
| 12 | Cancel | `lease_void_service.js:106` | `leases` @ `cancelled` | — | release |

**Note step 9 vs 11.** The *application* becomes `active` at step 9, but the
*lease* stays `pending` until step 11. An application reading `active` therefore
does **not** imply a current economic tenancy. Any surface treating application
`active` as occupancy is wrong by one governed step.

---

## 4. The current position contract, as source actually implements it

Verified against `position_classifier.js`, not restated from the brief:

| State | Rule as written | Line |
|---|---|---|
| current | lease status ∈ {`active`,`commercial`} **and** dates span `as_of` | `:87` |
| activation_pending | lease status = `pending` **and** dates span `as_of` | `:88` |
| future | `isFuture(lease, as_of)` | `:89` |
| successor `locked` | `executed_verified && move_in_funds_cleared` | `:172` |
| successor `pending` | a future lease exists, not locked | `:173` |
| successor `none` | no future lease | `:162` |
| conflict | two non-terminal leases on one space with overlapping ranges | `:150–156` |

`availability_state` ladder (`:100–117`), in precedence order: `on_notice` /
`unavailable` (current) → `committed_activation_pending` → `unavailable`
(possessed) → `vacant_turning` → `committed_future` → `ready_now`.

**`proofBasis` (`:72–77`) deliberately does not collapse** `native_verified`,
`confirmed_opening_import` and `unproven`. An imported lease is real operating
truth that did not pass proof steps it never passed, and that stays visible.

**Funding is fail-closed and worth quoting** (`space_position.js:149`):
*"Absence of a charge set is NOT funded."* A lease with no required move-in
charges is **not** locked. That is correct and must not be "fixed" into a
default-true.

The brief's four definitions are confirmed accurate against source, with one
correction: the pending-successor rule does **not** independently test proof
incompleteness — it is simply "future lease that is not locked."

---

## 5. Surface inventory — who answers what

| Route / service | File | Class | Reads applications? | Consumer |
|---|---|---|---|---|
| `datedPropertyPositions` | `dated_positions.js` | **canonical** | no | rent roll, availability |
| `classifyPosition` | `position_classifier.js` | **canonical** | **no** | all position surfaces |
| space loader | `space_position.js` | **canonical** | no | classifier input |
| `availabilityRead` | `surfaces/availability_read.js` | **canonical** | no | operator, pricing packet, readiness, unit-turn read |
| **legacy availability** | **`tenancy/availability.js`** | **LEGACY ACTIVE** | **YES — D7** | mounted `server.js:3174`; also required at `operator.js:3202` and `:3674` |
| turn priority | `maintenance/turn_priority.js` | legacy active | **YES — D8** | turn surfaces |
| packet eligibility | `applications/leasepackets.js` | workflow | **YES — D9** | packet routes |

**The legacy availability reader is reachable in signed-in runtime.** It is not
dormant and not a compatibility shim: `server.js:3174` mounts it directly, and
`operator.js` requires it in two places. Its D7 join is:

```sql
left join lateral (
  select la.id from lease_applications la
   where la.unit_id = u.id
     and la.status in ('submitted','tenant_signed','lease_ready')
   order by la.created_at desc nulls last limit 1
) ap on true
```

Two defects, independent of the missing statuses:

1. **Unit lineage, not space lineage.** The canonical architecture is
   space-scoped and `leases.space_id` is NOT NULL. Joining on `unit_id` attributes
   an application to *every* space in the unit. For a multi-space unit that is a
   guess, and the Pass 2 brief forbids inferring lineage.
2. **It answers a question no canonical surface asks.** No other module derives
   any availability signal from application status.

---

## 6. The four availability-proof failures

Investigated individually, per instruction. They do **not** share a cause with
any commitment-authority defect.

| # | Assertion | Actual | Cause |
|---|---|---|---|
| 1 | `0 positions have no spanning lease, but only 0 are marketable` | 0 vs 0 | population empty |
| 2 | `the model unit is blocked by operating designation (none)` | `(none)` | no model unit exists |
| 3 | `keeps its durable residential use — an operating designation is not a use` | — | depends on #2 |
| 4 | `a commenced-but-unactivated lease blocks marketing ()` | `()` | no pending lease exists |

**Root cause, measured:** `tests/availability_canonical_proof.js:18` hardcodes
the Demo Building UUID and **seeds nothing**. In the isolated proof database the
Demo Building property row exists but has **0 spaces** and there are **0 pending
leases** repository-wide.

**Classification for all four: `harness invocation defect`.** The harness
requires a database carrying the Demo Building inventory fixture; an isolated
migration-only proof DB does not have one. Evidence that this is not a code
regression: the pre-Pass-1 archive branch produces the identical 38/4 on the
same database.

They are **not** obsolete expectations, **not** fixture defects in the harness
logic, and **not** commitment-authority defects. The correct resolution is to
run this harness against a Demo-seeded database, or give it its own fixture —
**not** to adjust the expectations. Deliberately not changed in this pass.

This is the same false-green shape `docs/ASSERTION_BOUNDARY_AUDIT.md` names as
bypass #3: a data-driven harness handed an empty dataset.

---

## 7. Governing semantic distinctions — how source stands today

| Distinction | Held? | Where |
|---|---|---|
| `application_approved` ≠ `pending_space_commitment` | **YES** | classifier ignores applications entirely |
| `pending_space_commitment` ≠ `locked_contractual_commitment` | **YES** | `:172`, derived from execution + funding |
| `locked_contractual_commitment` ≠ `active_economic_tenancy` | **YES** | locked is a successor; current requires step 11 |
| `physically_ready` ≠ `marketable_now` | **YES** | `vacant_turning` distinct from `ready_now` |
| `packet_eligible` ≠ `unit_held` | **YES** | packets write no lease |

**All five distinctions already hold in the canonical path.** The only violation
is the legacy availability reader, which manufactures an application-derived
signal the canonical model does not recognise.

No generic `unit_held` boolean should be introduced. The classifier's existing
vocabulary already covers the required contract.

---

## 8. Stop conditions

| # | Condition | Triggered | Evidence |
|---|---|---|---|
| 1 | Approval is the only durable hold | **NO** | approval creates nothing; the lease at Q4 is the hold |
| 2 | Pending commitment lacks `space_id` | **NO** | `leases.space_id` NOT NULL |
| 3 | **Services disagree on when commitment begins** | **YES** | canonical says the `pending` lease (step 7); legacy `availability.js` says application status ∈ {submitted, tenant_signed, lease_ready} — three steps earlier and via unit lineage |
| 4 | **Active legacy availability cannot consume the canonical projection** | **YES** | mounted `server.js:3174` + two `operator.js` requires; returns its own `spaces[]` shape. Whether `availabilityRead` can back it without a response-contract change is **not yet established** and needs a browser-consumer check |
| 5 | Packet creation and reservation inseparable | **NO** | `leasepackets.js` writes no lease |
| 6 | No canonical release path | **NO** (partial) | `lease_void_service.js:106` exists; whether every terminal path (rescission, supersession, expiry) routes through it is **unverified** |
| 7 | Migration or new table required | **NO** | every fact needed already exists |
| 8 | Pending and locked collapsed durably | **NO** | neither is a durable field; both are derived live |

**Two triggered. Implementation stops here for a ruling.**

---

## 9. Minimum correction sequence (proposed, not executed)

**Behavior-preserving routing** — no product decision required:

1. `turn_priority.js` (D8): replace the application-status list with the
   canonical future/successor object. An approved application with no lease
   must not manufacture an incoming-resident deadline.
2. `leasepackets.js` (D9): narrow to present-tense workflow eligibility.
   Must **not** adopt `APPROVAL_REACHED` wholesale — that would admit withdrawn,
   expired and active applications.

**Requires a ruling** — product/contract decision:

3. `tenancy/availability.js` (D7). Three options, none safe to pick unilaterally:
   - **(a)** route it through `availabilityRead` and reduce it to a compatibility
     projection — needs the browser response contract compared first;
   - **(b)** retire the route if no live consumer remains;
   - **(c)** keep it and delete only the application join, accepting that its
     "pending application" signal disappears from whatever surface shows it.

   Option (c) is the smallest and the most honest — the signal it produces is
   not recognised by any canonical authority — but it is a **visible operator
   behavior change**, which is why it is not being taken here.

**Not a correction, but required before the next proof run:** give
`availability_canonical_proof.js` a Demo-seeded database or its own fixture.

---

## 10. Migration 124 stale comment

Header line 25 states:

> No trigger in this file invents a timestamp for compatibility. Absence stays absent.

The same migration creates `ps_app_compat_author_milestones` /
`trg_app_compat_author_milestones` at lines 144 and 184. The statement was true
of an earlier revision and was not updated when the compatibility adapter was
added. Corrected in this commit to describe the trigger accurately: it authors a
milestone **only while PostgreSQL witnesses a real transition** during
Deployment A, it is not historical inference, and staged migration 125 drops it.

**No executable SQL changed.**
