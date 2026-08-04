# SLICES 1–9 STRUCTURED RECEIPTS AND IDEMPOTENT RECOVERY
## Gate 1 — trace of the existing idempotency mechanisms

**Status: TRACE ONLY. No contract implemented, no route changed, no migration.**

The packet's objective is that every active leasing write returns enough
durable identity for the caller to prove what happened and recover the result
safely after a timeout or duplicate submission. Before designing a receipt,
this gate answers what already exists and why callers cannot reach it.

**Scope: the executable authority-hardened writes.** Tour reminder and tour
outcome correction are excluded — their canonical services cannot write at
all (see `TOUR_LEDGER_VERB_SCHEMA_REPAIR.md`). They join this packet when
their mutations succeed.

---

## 1. What exists

There are **four** replay mechanisms, not three. The fourth — the walk-in
booking key — behaves differently enough from the obligation-event key to be
counted separately, and missing it would leave a recovery hole in post-tour
capture.

Sixteen `idempotency_key`-shaped columns exist in the live schema. Most belong
to domains outside this packet (work orders, money, agent runs, timezone
changes). The four below are the ones the hardened writes actually traverse.

### M1 — Tour capture replay (`completeTourService`)

| | |
|---|---|
| **Replay identity** | caller-supplied `b.idempotency_key` |
| **Persisted in** | `tour_events.metadata.capture_idempotency_key` — a JSONB field, not a column |
| **Scope** | the tour's first terminal event |
| **Duplicate behaviour** | if the tour is settled AND the incoming key equals the prior key → returns `{ok:true, replayed:true, tour_id, conversion_id, receipt:"Already saved — nothing changed."}` |
| **Original result returned?** | **Partially.** It returns identity (`tour_id`, `conversion_id`) but **not the original outcome** — not what was captured, not who recorded it, not when. |
| **Key mismatch** | 409 with `"This tour was already saved. To change what was recorded, use Correct outcome"` — correct, and it points at a door that currently 503s |

This is the most developed of the four and the closest to a real receipt.

### M2 — Executed lease verification (`verifyExecutedLease`)

| | |
|---|---|
| **Replay identity** | caller-supplied `idempotency_key` |
| **Persisted in** | `executed_lease_records.idempotency_key` (a real column) |
| **Scope** | `(application_id, idempotency_key)` — correctly scoped, not global |
| **Duplicate behaviour** | returns `{idempotent:true, record_id, payload_hash, record_state:"verified", activation_status, blockers, term_obligation_id, receipt}` |
| **Original result returned?** | **Yes, and it is the best in the codebase.** It returns the durable `record_id`, re-evaluates admission (a blocker may have been corrected upstream), and distinguishes admitted from blocked. |
| **Same key, different terms** | `409 idempotency_conflict` — "Same idempotency key, different governing terms." Compared by `payload_hash`, so a caller cannot silently mutate governing economics under a reused key. |

**This is the model the receipt contract should generalise from.** It already
carries operation identity, durable target, state, and a replay flag.

### M3 — Walk-in booking key (`/operator/leasing/walk-in-tour`)

| | |
|---|---|
| **Replay identity** | caller-supplied `b.idempotency_key` |
| **Persisted in** | `leasing_tours.booking_idempotency_key` |
| **Scope** | **GLOBAL** — `select * from leasing_tours where booking_idempotency_key=$1 limit 1`, with no property or lead predicate |
| **Duplicate behaviour** | returns `{walk_in_tour_id, tour_id, person_id, captured, replayed:true, occurred_at, receipt}` |
| **Original result returned?** | Identity yes; the captured outcome no |

**Finding — global key scope.** M2 scopes its lookup to the application. M3
does not scope at all. Two properties that both generate `cap_2026-08-05_1`
would collide, and the second caller would receive the first property's tour
id. The response is then read under a session scoped to a different property.
No harm is proven today — keys embed a tour id and a random suffix — but the
protection is the caller's key format, not the server's predicate. **Flagged;
not repaired in this gate.**

### M4 — Obligation/task event keys

| | |
|---|---|
| **Replay identity** | caller-supplied `idempotency_key` on `resolveRung`, `reassignTask`, `reopenRung`, `changeDueTime` |
| **Persisted in** | `leasing_conversion_obligation_events.idempotency_key` |
| **Duplicate behaviour** | **not traced to a return path in this gate** — the key is written onto the event row, and no read-back-and-return branch was located |
| **Original result returned?** | **No evidence found.** Recorded as an open question rather than asserted either way. |

## 2. Why the replay identities are unreachable to callers

Three distinct reasons, all of which the receipt contract must fix.

### 2.1 No success response returns the key

Searched every `res.json(...)` and service return in `src/`: **no successful
write echoes its `idempotency_key` back to the caller.** The key travels
inbound only.

Consequence: a caller that loses the response cannot ask "what key did I use?"
It must have retained the key locally *before* sending. If the browser tab
reloaded, the key is gone and there is no way to discover whether the write
landed — only to send a *new* key, which produces a second mutation.

### 2.2 The key is caller-minted, so absence is silent

Every mechanism above treats the key as optional. `if (idempotency_key) {...}`
— no key, no replay protection, no error. A caller that forgets one is not
told; it simply loses recovery, and finds out by creating a duplicate.

In the app, **9 registered write actions forward a key if given one, but only
2 call sites actually mint one** (`_ltrNewKey` for lease-packet issue,
`C.idemKey` for tour capture). Tour check-in, application approve, application
deny, confirm-prospect and the task rail send no key at all — so for those,
**no replay protection exists in practice**, regardless of what the service
would do with a key.

### 2.3 There is no service-level receipt ID to return instead

The durable identities that do exist are database implementation details —
`tour_events.id`, `executed_lease_records.id`, `obligations.id`. M2 returns
`record_id` and is the only one that returns any durable handle at all.

The packet's rule — *do not expose a database implementation detail as the
public contract if a stable service-level receipt ID can be used* — means the
contract needs a receipt identity that is stable across the operation, not the
primary key of whichever table happened to receive the row.

## 3. The four outcomes that are currently collapsed

The packet requires these be distinguishable. Today they are not:

| outcome | what a caller sees today |
|---|---|
| write failed | an error |
| write succeeded, receipt recovered | **unreachable** — no recovery read exists |
| duplicate replayed | `replayed:true` / `idempotent:true` on M1–M3 only, absent on M4 and on every write with no key |
| outcome genuinely unknown | **indistinguishable from "write failed"** |

The fourth is the dangerous one. A timeout looks exactly like a failure, and
the honest answer — "this may or may not have happened, here is how to find
out" — cannot currently be expressed.

## 4. What Gate 2 must decide

1. Receipt identity: minted where, stable across what, returned always.
2. Whether the key becomes required (and what a keyless legacy caller gets).
3. The recovery read per operation — for writes that cannot be safely
   replayed, an exact "did this happen" read rather than a blind resubmit.
4. Additive transition: the existing `receipt` prose string stays while the
   structured receipt is added, then the app migrates, then the prose is
   marked deprecated. Existing consumers must not break.
5. Whether M3's global key scope is repaired inside this packet or carried.

## 5. Accounting provenance

The eight gaps from the authority packet carry forward as named findings and
are **not** repaired here — unless a durable receipt cannot identify its own
canonical operation without closing one. Two are on that line and must be
watched in Gate 2:

- **`events` has no `application_id`** — an application-decision receipt that
  must name its own canonical event cannot do so through `events` today.
- **walk-in capture writes no `tour_events` row when no outcome is supplied**
  — a receipt for that operation has no immutable event to point at.

Whether these force a repair depends on where receipt identity is minted, which
is Gate 2's first decision. Flagged, not pre-judged.
