# Communication line architecture — standing requirement

**Status: doctrine. Not a slice. Nothing here is built yet.**

No current slice needs to build all of this. But every seam added from now on
must preserve the ability to introduce it **without rewriting the work-order or
communications architecture**.

---

## 1. The required inbound order

Every inbound message begins with the receiving line, not the sender:

```
To number
  → resolve configured communication line
  → determine property or management-company context
  → determine audience class
  → apply that line's authority ceiling
  → then resolve the sender
```

**The sender's identity may reduce what is appropriate. It may never raise the
authority ceiling established by the receiving line.**

## 2. The two line types

**Property-facing line**
- generally one number per property
- residents and prospects
- captures claims, provides verified status
- **incapable of staff authority**
- a staff member texting this line is still held to the external-line ceiling

**Operational line**
- one management-company / operating-team number initially
- staff only
- resolves the staff user, property assignments, and eligible authority
- begins capture-and-confirm
- may later perform governed actions through canonical services

## 3. One spine, not two

Both lines feed the **same** canonical work orders, obligations, events, and
history. There are no "SMS work orders." Resident threads are never forwarded
into staff threads. **The durable work order is what crosses the boundary:**

```
resident property line
  → claim
  → canonical work order
  → routed obligation
  → staff operational line
  → execution and proof
  → canonical status
  → resident property line
```

## 4. Line configuration must eventually express

phone number · line type (`property_facing` | `operations`) · owning property or
operating organization · permitted audience · authority ceiling · active status ·
inbound and outbound capabilities.

Phone numbers live in durable line configuration — **never hardcoded across
modules**.

## 5. Test invariants — add when the operations line begins

1. Staff texting a property line gains no staff authority.
2. A resident texting the operations line gains no operating authority.
3. An unknown **or ambiguously configured** line fails honestly.
4. No property-line path can invoke staff-only actions.
5. Both lines update the same underlying work order rather than creating
   parallel records.

---

# Current-state audit (2026-08-01)

Measured against the source, not reconstructed from memory.

## Already conforms — do not disturb

| | Fact |
|---|---|
| **Order** | `tenantlink.js:1178` already resolves **To → property FIRST, sender inside that property**. The required order exists today. |
| **Unknown line** | `communications_boundary.js:667-673` — zero rows written, loud server log, nothing fabricated. Fails honestly. |
| **Transport is line-agnostic** | `sms.js` takes `from` as a parameter and hardcodes no number. |
| **Outbound `from` is server-derived** | `communications_boundary.js:96` derives it from the property; never client-supplied. |
| **No fallback line** | With no property line, outbound refuses with `no_property_line` rather than falling back to the Messaging Service default (`demo_preflight.js:100`). |
| **No hardcoded numbers** | The only literal is in `no076_failclosed_check.js:40`, a manual check module invoked nowhere. |

## FLAG 1 — the line *is* a property; there is no line record

`properties.sms_number text` (migration `030`) is the **entire** line
configuration. It expresses two of the seven required fields: phone number, and
owning property — the latter only by being a column on `properties`.

It cannot express line type, permitted audience, authority ceiling, active
status, or inbound/outbound capabilities. More fundamentally it is **1:1 with a
property by construction**, so an operations line owned by a management company
has no property to own it and *cannot be represented at all*.

**This currently fails safe.** An ops-line message finds no property, so
`resolveInboundSmsContext` returns `unknownLine:true` and writes zero rows.
Introducing the ops line therefore needs a new line table — not a new column, and
not a sentinel property. Two functions and one route are the blast radius
(FLAG 5).

## FLAG 2 — ambiguous line configuration does NOT fail honestly

Migration `030` is only `add column if not exists sms_number text`. **There is no
unique index on `properties.sms_number`.**

The collision guard exists in application code on exactly one route
(`tenantlink.js:383-391`, returning 409). The inbound lookup is:

```sql
select id, name, address, sms_number from properties where sms_number = $1 limit 1
```

`limit 1` with **no `order by`** — if two properties ever share a number, inbound
silently binds to an arbitrary one. A resident's message lands on another
property's ledger, with full confidence and no signal.

This violates invariant 3 directly: unknown fails honestly, **ambiguous does
not**.

**Currently latent, not live.** The guarded route is the only production writer
(verified: the sole other write is the uninvoked `no076` check module). So today
the app-level guard holds. It is one row of defense with no database backstop,
and any seed, migration, admin tool, or direct SQL bypasses it.

Repair is small and needs a migration: a unique index on `sms_number where
sms_number is not null`, plus a count-based refusal replacing `limit 1`.
Recorded as ITEM 4 in `BLOCKING_DESIGN_ITEMS.md`. **Not written.**

## FLAG 3 — audience class is not a concept; the ceiling holds by accident

Sender resolution has exactly two tiers: active resident (leases +
`tenant_invites`) and open lead (`leasing_leads`). **There is no staff tier.**

A staff member texting the property line therefore resolves to zero eligible
persons → `ambiguous` → person-less `needs_human` record, no outbound.

That satisfies invariant 1 — but **not because a ceiling is applied**. It
satisfies it because staff are unresolvable on this path. No code states the
ceiling, so the day a staff tier is added for any reason, the invariant
disappears silently and nothing fails.

**This is the seam most at risk of being quietly generalized.** When the ops line
lands, the ceiling must become an explicit, tested property of the *line* — not a
side effect of who happens to be lookupable.

## FLAG 4 — the property line already carries staff credential transport

`teamaccess.js:273-282` sends staff login OTPs out over the property's
`sms_number`, classified `purpose='staff_otp'` through the gate.
`090_admin_users.sql:47-48` deliberately orders assignment inserts so an
SMS-capable property "wins the login OTP routing."

This is **outbound**, so it breaches no inbound ceiling today. But a
property-facing line documented as "incapable of staff authority" is presently
the delivery channel for staff authentication codes.

When the operations line exists, staff OTP is the first traffic that should move
to it — and `090`'s ordering hack becomes unnecessary rather than load-bearing.

## FLAG 5 — the assumption lives in exactly two functions

- `communications_boundary.js:96` — outbound: `property_id → sms_number`
- `communications_boundary.js:663` — inbound: `sms_number → property`

Inverse functions of the same 1:1 assumption, plus the config route at
`tenantlink.js:375`. That is the whole blast radius. Both should later route
through a line resolver rather than reading `properties` directly.

**Small enough to change without rewriting anything — provided nothing new starts
reading `properties.sms_number` directly.** That is the seam to protect.

---

## The rule going forward

Do not add code that treats an inbound number as self-evidently a property line.
Any new inbound handling resolves the **line** first and derives context from it.
When a slice needs the receiving number, it asks the boundary — it does not query
`properties.sms_number`.
