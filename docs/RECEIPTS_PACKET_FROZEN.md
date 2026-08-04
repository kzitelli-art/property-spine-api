# SLICES 1–9 STRUCTURED RECEIPTS AND IDEMPOTENT RECOVERY — FROZEN

```
SOURCE AUTHORITY AUDIT COMPLETE
PARTIAL IMPLEMENTATION ACCEPTED
SCHEMA-DEPENDENT OPERATIONS DEFERRED
```

**The full receipts capability is NOT complete.** One operation of twelve can
produce a recoverable receipt.

Branch: `claude/slices-1-9-structured-receipts` @ `5dd97ca`
Contract: `operation_receipt_v1` (`src/shared/operation_receipt.js`)

---

## Final operation state

### IMPLEMENTED AND RECOVERABLE
```
executed_lease.verify
```
Two identities (caller `operation_id`, server `receipt_id`), payload-hash
binding, property-safe recovery read, typed recovery states, lost-response and
browser-reload recovery proven. 53/53.

### CODE-HARDENED BUT NOT RECEIPT-ELIGIBLE
```
obligation.resolve · obligation.reassign
obligation.reopen  · obligation.change_due_time
```
Replay identity threaded, event ids returned, duplicate lookup bound to the
obligation so it can never cross a property. **No receipt exposed** — nothing
binds the key to the payload, so a retry requesting a different owner is
indistinguishable from a replay. 23/23.

### BLOCKED — TOUR EVENT ACCESS PATH
```
tour.check_in · tour.complete · post_tour_capture
tour.walk_in_capture · tour.confirm_prospect
```
Measured, not assumed: a lookup by `tour_events.metadata->>'operation_id'`
degrades to a sequential scan of every event row (100,068 rows, 2,710 buffers
at 110k events). 13/13.

### BLOCKED — NO IMMUTABLE DECISION AUTHORITY
```
application.approve · application.deny
```
Both mutate `lease_applications` only. `events` has no `application_id` and no
actor column. Approval records no actor anywhere. 18/18.

### EXCLUDED — CANONICAL MUTATION WITHHELD
```
tour.reminder · tour.correct_outcome
```
Their writes cannot execute at all (authority packet). They join the receipts
packet only when their canonical services succeed.

**No fake resolvers are registered. `operation_id` is not mandatory globally.**

## Step H — not started, and should stay so

A browser outbox supporting one operation would be infrastructure built ahead
of the writes it exists to serve. H waits until a meaningful set of active
operator writes can produce: immutable receipt identity · queryable operation
identity · material payload binding · property-safe recovery.

## The four schema dependencies — kept separate

They may be **reviewed** together because migration 129 blocks all schema work.
They must not be **merged**: each solves a different domain defect, and a
combined migration nobody can review is worse than four that can be.

| # | dependency | defect class | brief |
|---|---|---|---|
| 1 | **Tour ledger verb repair** | vocabulary / projection | `TOUR_LEDGER_VERB_SCHEMA_REPAIR.md` §1–13 |
| 2 | **Tour operation receipt authority** | access path + immutable walk-in capture | same file, §2 |
| 3 | **Application decision authority** | missing immutable actor-attributed record | `RECEIPTS_D1…`, Step C |
| 4 | **Task payload binding** | missing material hash on an otherwise adequate event | `IMMUTABLE_ACTION_AUTHORITY.md` addendum |

**No migration number. No SQL. No speculative universal schema.**

## The architectural conclusion

> **Property Spine is strong at current lifecycle state and uneven at
> immutable action history.**

This governs both next products.

**Conversational agent.** May read broadly, explain state, recommend work. May
**execute** only operations with authenticated authority, a canonical service,
immutable action identity, payload-bound replay and a recoverable receipt.
Until then it must not say "done" for a blocked or withheld write — and today
that is eleven of twelve operations.

**Money.** An operational event may become financial source evidence only when
it preserves actor, property, canonical object, occurred time, recorded time,
evidence, material facts, and correction/supersession lineage. A lifecycle
projection alone is not accounting authority. A receipt alone is not an
accounting entry.
