# Canonical communication-line model — DESIGN

**Status: DESIGN APPROVED. Nothing here is built. No migration number claimed.**
**Implementation waits on the migration-129 production activation receipt.**

Base `main` @ `224f33d` · designed 2026-08-03 · owner rulings 2026-08-03 (§9).
Expands the *Future canonical line model* sketch in
`COMMUNICATION_LINE_ARCHITECTURE.md`, which remains the governing doctrine this
design must satisfy.

---

## 0. Sequence — where this sits

```text
finish and receipt migration-129 production activation
→ finalize communication-line design            ◀── this document
→ Slice A: canonical model + inbound resolution + compatibility projection
→ prove and review
→ Slice B: migrate display reads + retire properties.sms_number
→ operations-number activation
→ technician execution loop
→ governed outbound status
```

**The design may advance now. Implementation does not.** It waits until the
activation receipt establishes that the current property wall is actually
enforced in production — building the next line model on an unenforced one would
be reasoning from a wall that is not yet standing.

`COMMUNICATION_LINE_ARCHITECTURE.md`'s *Communication Line Hardening* slice is
**built and merged** (`a08c1da`, migration 129), proven against isolated real
Postgres and real HTTP, **not yet production-active**.

---

## 1. The blast radius, measured

FLAG 5 in the doctrine says the assumption *"lives in exactly two functions …
plus the config route. That is the whole blast radius."*

**That is accurate about the 1:1 resolution assumption and it does NOT describe
column retirement.** It must not be carried forward as though it does. Measured
on `590f2c9` — 24 call sites across 7 files:

| Category | Sites | Where |
|---|---|---|
| **Resolution** (what FLAG 5 counts) | 2 | `communications_boundary.js:96` outbound, `:666` inbound |
| **Configuration write** | ~5 | `tenantlink.js:378-402` |
| **Display / read-only** | ~16 | `super_admin.js` ×2, `org_admin.js` ×2, `teamaccess.js` ×2, `demo_preflight.js` ×4, `tenantlink.js` ×6 |
| **Dead** | 1 | `no076_failclosed_check.js:40` — invoked nowhere |

Switching resolution is small. Dropping the column is not. §5 splits them.

---

## 2. The Eight Questions (§31)

1. **Real-world fact?** Which physical phone line received or will send a
   message, what it is for, and what authority it carries.
2. **Canonical service?** A new line resolver. `communications_boundary` is its
   only caller for send/receive; nothing else queries line storage.
3. **Authenticated actor and property?** For **inbound, neither** — line
   resolution happens *before* identity, because the receiving line establishes
   the ceiling (§21, doctrine §1). For **configuration**, an authenticated
   operator with authority over the owning property or organization.
4. **Durable object?** A `communication_lines` record. `properties.sms_number`
   becomes a read-only projection, then is retired.
5. **Immutable history?** Line configuration is append-only supersession — a
   number moving between properties stays auditable — and every refusal path
   writes nothing by design.
6. **What reads it automatically?** Every inbound message, every outbound `from`,
   and the operator surfaces that display a property's line.
7. **When it is missing?** Unknown → honest refusal, zero writes (already true).
   Ambiguous → fail closed (true as of 129). **Configured but inactive** → new
   case, fails closed identically. **Organization with no line, or property with
   no organization** → fails closed as *not configured for operations-line use*.
8. **Class and removal condition?** §7.

---

## 3. The durable model

One table, two postures. **No sentinel operations property** (Ruling 2 of the
doctrine) and **no sentinel organization** (owner Ruling 1 below).

```sql
create table communication_lines (
  id                 uuid primary key default gen_random_uuid(),
  e164               text not null,
  line_type          text not null,   -- property_facing | operations
  property_id        uuid references properties(id),
  organization_id    uuid references organizations(id),
  authority_ceiling  text not null,   -- external | operational
  permitted_audience text not null,   -- residents_and_prospects | staff
  inbound_enabled    boolean not null default true,
  outbound_enabled   boolean not null default false,
  status             text not null default 'active',  -- active | suspended | retired
  provider_config    jsonb,
  created_at         timestamptz not null default now(),
  superseded_at      timestamptz
);
```

`outbound_enabled` defaults **false**: an operations line is inbound-only in
Slice A (Ruling 5), and a default that grants sending would make the restriction
a matter of remembering to set a flag.

### The constraints that carry the doctrine

```sql
-- Canonical form, identical to normalizePropertyLine(). The 129 lesson: the
-- database enforces the INVARIANT and never re-implements the algorithm.
check (e164 ~ '^\+1[0-9]{10}$')

-- Exactly one owner. This is what makes an org-owned operations line
-- representable without a sentinel property.
check ((property_id is not null) <> (organization_id is not null))

-- THE CEILING IS STRUCTURAL, NOT DOCUMENTED (doctrine Ruling 4).
check (
  (line_type = 'property_facing'
     and property_id is not null
     and authority_ceiling = 'external'
     and permitted_audience = 'residents_and_prospects')
  or
  (line_type = 'operations'
     and organization_id is not null
     and authority_ceiling = 'operational'
     and permitted_audience = 'staff')
)
```

That third constraint is the point of the design. Today *"staff texting a
property line gain no authority"* holds **by accident** — because no staff sender
tier exists (FLAG 3). After this, **a property-facing line carrying operational
authority is not a configuration anyone can express.**

### Uniqueness

```sql
-- One active line per number, globally.
create unique index uq_communication_lines_active_e164
  on communication_lines (e164) where status = 'active';

-- ONE ACTIVE OPERATIONS LINE PER ORGANIZATION (owner Ruling 2).
-- Structural, not conventional: several simultaneously active operations lines
-- stay impossible until routing, regional scope, priority and operator
-- expectations are deliberately designed.
create unique index uq_one_active_operations_line_per_org
  on communication_lines (organization_id)
  where line_type = 'operations' and status = 'active';
```

**The resolver filters on `status = 'active'` and nothing else** — the exact
predicate of these indexes. That is the 129 rule restated: the set the database
keeps unique must be exactly the set the resolver reads, and if either changes,
both change in the same commit.

A `retired` row may share a number with an `active` one, deliberately: a number
reassigned between properties must stay auditable (§6 — corrections do not erase
history). That makes **"the resolver returned a retired row" an explicit test
case**, not an oversight.

---

## 4. The resolver API

Exactly the three questions doctrine Ruling 3 names. Nothing else may read line
storage.

```js
resolveInboundLine(q, toNumber)
//  → { outcome: 'one'|'none'|'many'|'unresolvable'|'inactive', line, candidates }

resolveOutboundLine(q, { propertyId | organizationId, purpose })
//  → { line, refusal }        refusal is a REASON, never a fallback number

lineAuthority(line)
//  → { lineType, authorityCeiling, permittedAudience }   pure, no I/O
```

`resolveInboundLine` keeps the shape `resolvePropertyByLine` already ships and
proves: **no `limit`** — the count is the finding — and `line` is null for every
outcome except `one`, so a caller that forgets to branch gets null rather than an
arbitrary line. `inactive` is new: a configured-but-suspended line is **not** an
unknown one, and both fail closed.

`resolveOutboundLine` preserves today's `no_property_line` discipline: **never a
Messaging Service default fallback.**

---

## 5. ⚠ Organization context is not property context

**The most important boundary in this design.**

An organization-owned line establishes **organization context and an authority
ceiling. It does not establish property context.** A staff sender may work at
several properties, so knowing *who* texted and *which company* they texted does
not determine *which building* they meant.

Property scope for an operational action must come from exactly one of:

1. an explicit canonical **work-order or obligation reference**;
2. an existing **active assignment that resolves to exactly one property**;
3. an unambiguous **governed staff-property context**.

If property context is **absent or ambiguous**, Spine asks the **smallest useful
clarification** and performs **no property-scoped action**.

> **The organization number must never silently choose a building.**

This is the same defect as the property-line ambiguity closed in 129, on a
different axis. There, two properties shared one number and `limit 1` picked
arbitrarily. Here, one number legitimately spans many properties and the
temptation is to resolve "their property" from assignment order, most-recent
activity, or a single-property convenience case that stops being true the day a
second property is assigned.

**Design consequences, binding on Slice A even though it is inbound-only:**

- The inbound path resolves organization and ceiling from the line, and **stops**
  — it does not attempt a property.
- Zero, one and many eligible properties are three named outcomes, exactly as
  zero/one/many properties-per-line already are. **Many is not a pick.**
- Any future action taking `property_id` from the ops line's *organization* is a
  defect by construction, and the tests must state that as a property rather than
  discover it later.
- A single-property organization must **not** shortcut resolution. That is the
  trap: it works until the second property, then silently misroutes. The
  one-eligible-property case must resolve through the same explicit path.

---

## 6. Retiring `properties.sms_number` — two slices

**One writable truth and a read-only compatibility projection. No dual-read**
(Ruling 4). A temporary projection is acceptable; two sources of truth are not.

**Slice A**
1. Create `communication_lines`; backfill one `property_facing` row per property
   holding a line. Trivially safe after 129: every value is already canonical and
   unique.
2. Switch **inbound resolution** and **configuration writes** to the canonical
   model.
3. Provide a **read-only compatibility projection** for the ~16 display
   consumers.
4. **Prevent new direct writes** to `properties.sms_number`.
5. Prove the invariants (§8).

**Slice B**
6. Move the remaining display consumers to the canonical projection.
7. Remove the compatibility adapter.
8. Drop `properties.sms_number`, and with it migration 129's
   `ck_properties_sms_number_canonical` and `uq_properties_sms_number` — whose
   guarantees now live on `communication_lines`.

**The legacy column must never be independently writable or go stale while
screens still display it.** That is the failure this ordering exists to prevent:
a column nobody writes but everybody reads, drifting silently from the truth.

### Proposed mechanism for steps 3–4 (needs review at build time)

A one-way sync trigger on `communication_lines` writes `properties.sms_number`,
plus a `before insert or update` trigger on `properties` that **raises unless the
new value equals the canonical value** for that property.

This needs no session flag and is self-validating: the sync write always matches
by construction, and any other write path fails loudly. The alternative — a
session-variable escape hatch — is rejected because an escape hatch is a second
write path wearing a disguise.

---

## 7. Component classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| `communication_lines` table | permanent | — |
| Line resolver module | permanent | — |
| Structural ceiling CHECK | permanent | — |
| One-active-ops-line-per-org index | **temporary constraint** | replaced only when multi-line routing, regional scope and priority are deliberately designed — never relaxed casually |
| `properties.sms_number` | **temporary adapter** | Slice B step 8 |
| Compatibility projection + write-guard triggers | **temporary** | deleted at Slice B step 7 |
| **Staff OTP over the property line** | **temporary transport adapter** | **an operations line is active for the organization AND a dedicated identity/authentication slice has separately proven: credential ownership, staff-user resolution, expiration, replay protection, organization scope, property entitlement, and recovery behavior.** Only then does `090_admin_users.sql:47-48` assignment ordering stop being load-bearing. |

**Staff OTP does not move in Slice A** (Ruling 3). An operations line existing is
*necessary but not sufficient* to make it an authentication channel. This slice
does not touch `teamaccess.js` or the migration-090 ordering issue.

---

## 8. Invariants, and how each is proven

Doctrine §5, plus the boundary in §5 above. All need real Postgres and real HTTP;
none has a browser surface.

| # | Invariant | Proof |
|---|---|---|
| 1 | Staff texting a property line gain no staff authority | **Now structural.** Test must add a *resolvable* staff sender and still show zero authority. |
| 2 | A resident texting the operations line gains no operating authority | Resident sender → ops line → `permitted_audience='staff'` refuses; zero writes. |
| 3 | Unknown, ambiguous **or inactive** line fails honestly | Unknown/ambiguous already proven (`property_line_hardening.db.js` 41/41). Extend with `inactive`. |
| 4 | No property-line path can invoke staff-only actions | Assert on the **ceiling**, never on sender-lookup failure — the FLAG 3 trap. |
| 5 | Both lines update the same work order, not parallel records | One work order, two lines, one history. |
| 6 | **An ops line never yields property context by itself** | Staff with 2+ assignments texts the ops line → **no property-scoped write**, smallest useful clarification only. |
| 7 | **A single-property organization takes no shortcut** | Staff with exactly 1 assignment resolves through the same explicit path — not by convenience. |
| 8 | One active operations line per organization | Second active ops line for an org is refused **by the index**, not by application code. |

**Invariant 1 needs a deliberately hostile test.** Today it passes because staff
are unresolvable on that path. A test written against current behaviour would
re-prove the accident rather than the ceiling.

**Invariant 7 is the one most likely to be skipped** and it is where the design
will actually fail if it fails: the shortcut works until the second property.

---

## 9. Owner rulings (2026-08-03) — decided, not open

1. **Properties without an organization get no operations line.** Organization
   membership is an **activation prerequisite**. No sentinel organization, no
   silent attachment, no fallback to the property-facing line. An unowned
   property **fails closed as not configured for operations-line use**. For the
   first OneFive activation, relevant properties may be assigned to the real
   OneFive organization through an explicit, governed configuration step.
2. **One active operations line per organization initially.** Retired and
   historical lines are retained; exactly one may be active. **Enforced
   structurally.** Several simultaneously active operations lines wait until
   routing, regional scope, priority and operator expectations are deliberately
   designed.
3. **Staff OTP does not move in Slice A.** Deferred to its own identity and
   authentication slice, with the full replacement condition recorded in §7.
4. **One writable truth and a read-only compatibility projection. No dual-read.**
   Slice A/B steps as in §6.
5. **The operations line is inbound-only in Slice A.** Outbound
   acknowledgements, assignments, technician prompts, resident updates, retries
   and delivery receipts belong to the **technician loop**, where each message
   can be tied to authenticated staff authority and canonical work state.

### The product choice underneath

**One company operations number, at first.** Easier to remember, easier to
deploy, easier for staff to use without training — *staff know the company
number.*

The complexity does not disappear; it moves underneath. The number identifies the
**organization**. Spine must still establish **person, property, assignment,
authority and work record** before permitting any action. §5 is where that
complexity is held, and it is the reason the simple surface is safe rather than
merely simpler.

---

## 10. Migration number — NOT claimed

Applied ceiling **128**; **129** merged and unreleased; **130** free and possibly
Slice 10B's.

**The number is claimed when the build begins, not now** — after re-reading the
ledger *and* rechecking active branches, coordinated with the Slice 9/10 thread.

---

## 11. Explicitly NOT in this design

The technician SMS workflow · operations-number procurement and provisioning ·
routing an obligation to a technician · outbound staff messaging · staff OTP
migration · ITEM 2 (`conversation_owner_user_id`) · production fixture cleanup ·
rebuild-from-empty (PR #33) · any app-repo change · Slice 10A/10B Forward Rent
Roll work.

**Nothing in this design may be called live, deployed, activated, or
production-proven.** Migration 129 is merged and unreleased; the property-line
proof statement stays *"merged and proven locally, not production-active"* until
the owner posts the activation receipt.
