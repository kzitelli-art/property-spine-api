# Slice 6 — Renewals Contract Audit (first deliverable)

**Date:** 2026-07-30
**Scope:** What Renewals actually supports today, before any Slice-6 UI work.
**Source of truth read:** `src/leasing/renewals_read.js` (the R1 cohort projection),
its HTTP route `GET /operator/leasing/renewals` in `src/identity/operator.js`,
the `leases` schema, and a live query of the deployed Neon database.

> Per `06_RENEWALS_OPERATING_RAIL.md`, no broad UI work begins until this audit
> is accepted.

---

## 0. Precondition check (governing handoff §"Preconditions before Slice 6")

| # | Precondition | Status | Evidence |
|---|---|---|---|
| 1 | Leasing home order: Tours, Follow Ups, Lead Conversations, Renewals | ⚠️ VERIFY IN BROWSER | Home doors exist in `index.html`; order not yet browser-confirmed against the permanent architecture |
| 2 | Follow Ups opens former Leasing Work destination | ⚠️ VERIFY | R3 Follow-Ups door reads the 069 task queue; needs browser confirm |
| 3 | Lead Conversations opens Conversations destination | ⚠️ VERIFY | present; needs browser confirm |
| 4 | Follow Ups still contains Active Work + Application Records | ⚠️ VERIFY | needs browser confirm |
| 5 | Separate Applications Review home entrance retired | ⚠️ VERIFY | needs browser confirm |
| 6 | Application Records opens canonical application detail | ⚠️ VERIFY | needs browser confirm |
| 7 | Deployed app SHA current and trustworthy | ✅ | app main `1044718` live; `window.__PS_BUILD` present via `build-info.js` |
| 8 | No authenticated read falls back to fixture data | ✅ (renewals) | `/operator/leasing/renewals` throws on error, never returns an empty cohort (operator.js:1766). Fixtures (`SOLO_DEMO_RENEWALS`) are demo/preview only. |

**Gate status:** Preconditions 7–8 pass for the renewals path. **1–6 require a
browser pass before Slice 6 is formally AUTHORIZED.** Recommend a short
browser-verification session to flip the gate before implementation.

---

## 1. Current row population

- Rows are **derived**, not stored. There is **no renewal entity** — a live DB
  check confirms **zero `renewal*` tables**. Each row is a *position* whose
  current lease expires within the horizon.
- Source: `spacePosition(pool, {property_id, as_of})` → positions whose
  `current_lease_position.end_date` falls in `[as_of, as_of + horizon)`.
- Horizon: **90 days**, fixed at the route (operator.js:1761).
- Live magnitude (2026-07-30): **253 leases expire in the next 90 days** across
  the 4 properties that have leases. The open cohort is a subset (successor-aware).

## 2. Current inclusion and exclusion rules

Every expiring position lands in **exactly one** bucket:

| Bucket | Rule | In work list? |
|---|---|---|
| `open` | `successor_state = none` (no next lease) | **Yes** — the primary work list |
| `successor_pending` | successor lease exists but not executed+funded | No (visible as exposure) |
| `locked_future` | successor executed **and** funded | No (feeds Future Rent Roll) |
| `conflicted` | two non-terminal leases overlap the position | No (excluded, explicit reason) |

Excluded from the horizon entirely: no `end_date`, `end_date < as_of`, or
`end_date >= as_of + 90d`. "locked" uses the governed *executed AND funded* rule.

## 3. Current stages and states

- **No lifecycle stage machine.** The spec's recommended stages
  (`approaching → decision_required → offer_preparation → offer_sent →
  resident_decision → execution`) **do not exist**. Today's only banding is
  urgency by days-to-expiration: `d0_30 / d31_60 / d61_90`.
- **Operating state**: partial. `notice_state ∈ {on_notice, unresolved}` is
  the only per-row state. There is no `available/waiting/blocked/complete`.
- Page-level `uniform` flags exist (`all_unresolved`, `no_owner_anywhere`).

## 4. Current owner fields

- **No canonical ownership.** Every row is hard-set to
  `owner_state = "UNASSIGNED"`, `owner_user_id = null`,
  `owner_reason = "renewal_work_not_created"`.
- This is a **stated product fact**, not a failed lookup: no renewal obligation
  exists yet, so there is no candidate source. (Documented intent: when R2/Slice-6
  creates governed renewal obligations, the canonical resolver replaces this
  constant.)

## 5. Current due fields

- **No renewal clock.** Only `days_until_expiration` + `band`. There is no
  `due_at`, `due_state`, decision deadline, notice deadline, or offer expiry.
- Consistent with doctrine: never emit overdue without an authored timestamp —
  and none exists yet.

## 6. Current economics fields

- `current_rent` only, sourced **exclusively from `leases.rent`** (never
  `units.market_rent`, an explicit owner ruling).
- **No proposed economics.** No `proposed_rent`, `effective_change_*`,
  `concession_summary`, `economics_source`, or `economics_as_of`.

## 7. Current waiting-party fields

- **None.** `waiting_on` is not emitted. `notice_state` is the closest signal
  but is not a waiting-party (silence is `unresolved`, explicitly *not*
  "waiting for a response", because no one has asked).

## 8. Current actions

- **No `primary_action`.** No `{code,label,kind,target}` on any row. The
  destination currently renders context, not a canonical next action.

## 9. Current correlations

- `conversation_id` — the resident's most-recent active thread (presentation
  context only, not a shared fact).
- `successor_lease_id`, `successor_proof_basis` — links to the next position.
- `person_id`, `unit_id`, `space_id`, `lease_id` — canonical keys present.

## 10. Current exit behavior

- A position exits the open list only by a **server-authored** change in the
  shared derivation (successor becomes locked, notice recorded, conflict). No
  optimistic browser disappearance. ✅ already correct.

## 11. Current home counts

- Server projection returns `count` (open), `breakdown` (bands),
  `states {unresolved, on_notice}`, plus `successor_pending`, `locked_future`,
  `conflicted` counts. The Renewals card and destination read the **same**
  projection (app reads `/operator/leasing/renewals`). ✅ reconciled today —
  but the spec's richer counts (`due_today, overdue, unassigned, waiting,
  blocked, offer_sent, decision_required`) are **not yet supported**.

---

## Field classification vs. the required record contract

Legend: **C** already canonical · **P** available, not projected · **D** requires
canonical derivation · **U** unsupported / unresolved (needs new authoring site).

| Contract field | Class | Note |
|---|---|---|
| renewal_id / relationship key | **U** | no renewal entity; today keyed by `lease_id`/`space_id` |
| lease_id, resident/person_id, resident_name, unit_id, unit_number | **C** | projected today |
| current_lease_start | **P** | on `leases.start_date`, not currently projected |
| current_lease_end (`expires_on`) | **C** | projected |
| days_to_expiration | **C** | `days_until_expiration` |
| renewal_stage | **U** | no stage machine |
| renewal_state_code / label | **U** | only `notice_state` exists |
| operating_state (available/waiting/blocked/complete) | **U** | not authored |
| accountable_user_id / name | **U** | always UNASSIGNED; needs renewal obligation + resolver |
| assignment_state | **P** | constant "unassigned"; real assignment site needed |
| responsibility_role | **U** | not emitted |
| due_at, due_state | **U** | no renewal clock |
| waiting_on | **U** | no authoring site |
| blocker_code / label | **U** | not authored |
| current_rent | **C** | from `leases.rent` |
| proposed_rent, effective_change_amount/percent | **U** | Slice 8 owns governed rent; Slice 6 may only *display* existing governed economics |
| concession_summary | **U** | Slice 8 |
| economics_source, economics_as_of | **U** | none until governed economics exist |
| offer_id, offer_status, offer_sent_at, offer_expires_at | **D** | `lease_offers` table EXISTS — needs a renewal-scoped derivation/link |
| decision_status, notice_status | **D** | notice partially derivable (`notice_state`); decision unsupported |
| renewal_lease_id (`successor_lease_id`) | **C** | projected |
| primary_action {code,label,kind,target} | **U** | not authored |
| latest_activity_at / label | **P/D** | conversation thread exists; not surfaced as activity |

---

## Population reconciliation (live, 2026-07-30)

- 4 properties have leases; **253** leases expire within 90 days platform-wide.
- The open renewal cohort is successor-aware: positions with a pending/locked
  successor or a conflict are correctly split out (the Rev-2 fix that removed
  49-of-92 false "open" decisions).
- Home card counts and destination counts read one projection — reconciled.

## Economics-source audit

- Only live economic authority today: `fee.application $50` (governed charge).
  **No governed renewal rent, no concession** exists (per THREAD_HANDOFF.md).
- Therefore Slice 6 must show `proposed_rent: null`, `economics_source: null`
  and offer a **`Set renewal economics`** action routing to Market & Pricing —
  it must not invent a renewal price. Slice 8 creates governed renewal economics.

## What Slice 6 must ADD (gap summary)

1. A **renewal obligation/record** with a stable key + canonical **ownership
   assignment** (replaces the UNASSIGNED constant).
2. A **stage + operating-state machine** (`approaching…execution`;
   `available/waiting/blocked/complete`) with **server-authored labels**.
3. A **renewal clock** → `due_at` / `due_state`, and a **waiting-party** authoring site.
4. **Offer lifecycle** linkage via the existing `lease_offers` table
   (`offer_status/sent_at/expires_at`) + **resident-decision** and **notice** states.
5. A server-authored **`primary_action`** per row (assign, review, set/request
   economics, prepare/send offer, record response/notice, accept/decline,
   prepare docs, verify execution) — canonical commands only, no renderer writes.
6. Richer **home counts** (`due_today, overdue, unassigned, waiting, blocked,
   offer_sent, decision_required`) from the **same** projection.

## Migration posture

Additive only (governing handoff §Migration rule). Any new renewal state would
land as migration **119+** (DB currently at 118). Do not rewrite history; prove
against the supported baseline and real Postgres.

---

## Recommendation

1. **Flip the gate first:** run one browser-verification pass to prove
   preconditions 1–6, then record `SLICE 5: CLOSED / SLICE 6: AUTHORIZED`.
2. **Accept or amend this audit.** On acceptance, implement Slice 6 in this
   order (matching the governing build sequence): renewal record + assignment →
   state machine → due/waiting → offer/decision/notice linkage → primary_action
   → home-count reconciliation → honest empty/unavailable → browser proof.
3. Keep the economics boundary hard: Slice 6 **displays** governed economics and
   routes to Market & Pricing to **set** them; it never authors a renewal price.
