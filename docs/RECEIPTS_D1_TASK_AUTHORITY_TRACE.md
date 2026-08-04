# RECEIPTS D1 — OBLIGATION AND TASK OPERATION AUTHORITY TRACE

**Status: TRACE ONLY. No product code changed, no migration, no second event.**

The first operation family since `executed_lease.verify` with a genuinely
adequate immutable authority. The defects below are **return-path and scope**
problems, not missing-history problems — a materially different and much
cheaper class than Steps B and C.

---

## 1. Active operations traced

Traced from the operator route through the service into durable rows. Only
operations with a proven active staff consumer, hardened in the authority
packet:

| operation | operator route | canonical service |
|---|---|---|
| resolve | `POST /operator/leasing/tasks/:obligationId/resolve` | `resolveRung` |
| reassign | `.../reassign` | `reassignTask` |
| reopen | `.../reopen` | `reopenRung` |
| change due time | `.../change-due` | `changeDueTime` |

**`claim` excluded.** `POST /leasing/queue/:itemId/claim` has no proven active
in-repository staff consumer (Wave 2 inventory) and is not included merely
because a related table exists.

## 2. The immutable event — `leasing_conversion_obligation_events`

Written by `conversion_obligation_closure.js:172`. This is the strongest
operational history in the codebase outside the executed-lease records.

| column | carries |
|---|---|
| `id` | **primary key — the receipt identity candidate** |
| `conversion_obligation_id` | exact obligation lineage |
| `event_type` | operation type |
| `occurred_at` | recorded time |
| `actor_user_id` | **the acting human** |
| `actor_person_id_at_event`, `actor_assignment_id_at_event`, `identity_resolution_basis` | the actor's identity *as resolved at that moment*, not as it reads today |
| `prior_status` / `next_status` | before / after lifecycle |
| `prior_owner_user_id` / `next_owner_user_id` | before / after ownership |
| `ownership_origin`, `owner_eligibility_state` | why ownership landed where it did |
| `resolution_code`, `resolution_basis`, `reason` | the governed judgment |
| `prior_due_at` / `next_due_at` | before / after due time |
| `prior_event_id` | **correction / supersession lineage** |
| `idempotency_key` | replay identity |

The identity-snapshot columns are notable: this table already records *who the
actor was at the time*, which is exactly the property a mutable projection
cannot hold.

### Indexes

```
leasing_conversion_obligation_events_pkey     (id)
lcoe_idempotency_unique  UNIQUE (idempotency_key) WHERE key IS NOT NULL
lcoe_link_idx            (conversion_obligation_id, occurred_at)
```

A lookup by `idempotency_key` is an **exact unique-index seek**, then joins up
for the property check — bounded, unlike the tour JSONB scan measured in B1.

### The writer already replays correctly

```js
if (e.idempotency_key) {
  const dup = (await client.query(
    "select id from leasing_conversion_obligation_events where idempotency_key=$1",
    [e.idempotency_key])).rows[0];
  if (dup) return dup.id;   // safe retry: history appends nothing new
}
... insert ... returning id
return r.rows[0].id;
```

**The event id is already produced inside the transaction, and a duplicate key
already returns the original id without appending.** That is most of a replay
contract, working today, unreachable from outside.

## 3. Defects — stated separately, as ruled

### D1-a — `resolve` accepts no key at all

```js
resolveRung(client, { obligation_id, result, proof, by_user_id,
                      suppress_next, resolution_basis })
```

No `idempotency_key` parameter. `reassignTask`, `reopenRung` and
`changeDueTime` all take one; **resolve does not**, and the operator route does
not send one. So the most consequential task operation — closing work — has
**no replay protection whatsoever** today, regardless of what the closure
writer would do with a key.

> **not queryable — the key never arrives**

### D1-b — no service returns the event identity

Zero of the four services return `event_id`. The closure writer returns it;
the services discard it. This is the M4 return-path question answered:

> **not returned**

**Repairable without a migration.** The id is already in hand inside the
transaction. It needs threading through the return value — not a second event,
and not a re-read by nearest timestamp, latest-event-for-obligation, actor+time
window, or type+limit 1. Those are guesses, not recovery, and none is used.

### D1-c — the replay lookup has no property scope

```sql
select id from leasing_conversion_obligation_events where idempotency_key=$1
```

Global, exactly as M3's walk-in lookup was before repair. Two properties
minting the same key would collide, and the second caller would receive the
**first property's event id** — which it would then treat as its own receipt.

> **not property scoped**

The unique index is likewise global, so property-scoped *replay* is not
expressible without a composite key — the same residual already frozen for M3.
The property-scoped *read* is repairable now by joining
`leasing_conversion_obligations → leasing_conversions.property_id`.

### D1-d — the key is not bound to payload

Nothing compares the incoming operation against the original. A reused key
returns the original event id whatever the new payload says, so a replayed
`reassign` to a *different* owner would silently return the first
reassignment's receipt.

> **not bound to payload**

`verifyExecutedLease`'s `payload_hash` comparison is the model; there is no
column here to store one.

### D1-e — property lineage is a two-hop join, not a column

`leasing_conversion_obligation_events` has no `property_id`. Lineage runs
event → `leasing_conversion_obligations` → `leasing_conversions.property_id`.
Bounded and exact (the seek happens first), but it must be **written into every
resolver**, never assumed.

## 4. Classification

| operation | status |
|---|---|
| `obligation.reassign` | **CANDIDATE** — key accepted, event immutable and actor-attributed, before/after present. Blocked on D1-b (return path), D1-c (scope), D1-d (payload binding). |
| `obligation.reopen` | **CANDIDATE** — same. |
| `obligation.change_due_time` | **CANDIDATE** — same. |
| `obligation.resolve` | **BLOCKED — REPLAY IDENTITY NOT ACCEPTED BY THE SERVICE** (D1-a), in addition to D1-b/c/d. |

**No operation is blocked on missing immutable history.** That is the material
difference from Steps B and C: this family has the record, and cannot currently
hand it back.

Namespaces stay separate — `obligation.resolve`, `obligation.reassign`,
`obligation.reopen`, `obligation.change_due_time`. No `task.update`. A replayed
reassignment is not a replayed completion.

## 5. What D2 would need to decide

Not started. Three of these are code-only; one is not:

1. Thread the event id out of all four services (**no migration**).
2. Add the property predicate to the duplicate lookup (**no migration**).
3. Add `idempotency_key` to `resolveRung` and its route (**no migration**).
4. Payload binding — needs somewhere to store a hash. **Migration**, unless the
   existing `reason`/`resolution_basis` columns are ruled unsuitable to abuse,
   which they are: overloading a governed business field with a hash is exactly
   the "hide the key in prose" the gate forbids.

So a partial Step D is available without touching the schema: **replay and
recovery for reassign, reopen and change-due, with payload binding carried as a
named gap** — a receipt that recovers the original but cannot yet refuse a
materially changed one. Whether that partial contract is worth shipping, or
whether it should wait so `409 operation_id_payload_mismatch` lands with the
rest, is a judgment call I am not making unilaterally.

## 6. Operational versus economic classification

| operation | classification |
|---|---|
| `obligation.reassign` | **OPERATIONAL ONLY** — who owns work carries no economic meaning |
| `obligation.change_due_time` | **OPERATIONAL ONLY** — when work is due is scheduling |
| `obligation.reopen` | **ECONOMICALLY RELEVANT SOURCE FACT** — reopening after a failed condition is the shape that later supports rework and cost-bearing re-authorization |
| `obligation.resolve` | **ECONOMICALLY RELEVANT SOURCE FACT** — "this work was completed and accepted" is the canonical antecedent of vendor acceptance and turn cost |

For the two economically relevant ones, the event **already preserves** actor,
obligation, occurred_at, resolution basis and supersession lineage. It does
**not** carry property directly (D1-e) or evidence identity — `proof` is passed
to `resolveRung` but its durable landing was not traced in D1 and must not be
assumed.

**No accounting treatment assigned. No expense recognition decided.** Only:
this operation may later serve as source evidence, and here is what its receipt
would and would not preserve.

## 7. Future-money provenance findings

- **FUTURE ACCOUNTING PROVENANCE GAP** — the task event carries no
  `property_id`; economic attribution would depend on a two-hop join through
  mutable conversion rows.
- **FUTURE ACCOUNTING PROVENANCE GAP** — evidence (`proof`) supplied to
  `resolveRung` has no traced durable landing on the event.
- **PARTIAL RECEIPT — CONSEQUENCE ID UNAVAILABLE** — downstream consequences
  (next rung spawned, notifications) were not traced to returned identities in
  D1. They must not be inferred from expected workflow.

Carried as findings. Not repaired here.
