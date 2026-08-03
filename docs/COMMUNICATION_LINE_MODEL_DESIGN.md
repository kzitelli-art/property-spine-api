# Canonical communication-line model — DESIGN

**Status: DESIGN ONLY. Nothing here is built. No migration number claimed.**
**Requires owner rulings (§9) before any implementation begins.**

Base `main` @ `590f2c9` · 2026-08-03. Supersedes the *Future canonical line model*
sketch in `COMMUNICATION_LINE_ARCHITECTURE.md`, which stays as the governing
doctrine this design must satisfy.

---

## 0. What this replaces, and what already landed

`COMMUNICATION_LINE_ARCHITECTURE.md` proposes *Communication Line Hardening* as
"NOT STARTED". **It is now built and merged** (`a08c1da`, migration 129) — all
five of its points, proven against isolated real Postgres and real HTTP, **not
yet production-active**. That slice deliberately did not introduce the operations
line. This design does.

The doctrine's own sequence:

```text
prove the shared engine            ✅ obligation_engine, one implementation
  → close today's arbitrary-line risk   ✅ 129, merged, awaiting release
  → introduce the operations line       ◀── THIS DESIGN
  → build the technician's text workflow
```

---

## 1. A correction the design has to start from

**FLAG 5 says the assumption "lives in exactly two functions … plus the config
route. That is the whole blast radius."** That is accurate about the **1:1
resolution assumption**. It is not the cost of **retiring the column**, and the
two have been read as the same number.

Measured on `590f2c9` — 24 call sites across 7 files:

| Category | Sites | Where |
|---|---|---|
| **Resolution** (the 1:1 assumption FLAG 5 counts) | 2 | `communications_boundary.js:96` outbound, `:666` inbound |
| **Configuration write** | ~5 | `tenantlink.js:378-402` |
| **Display / read-only** | ~16 | `super_admin.js` ×2, `org_admin.js` ×2, `teamaccess.js` ×2, `demo_preflight.js` ×4, `tenantlink.js` ×6 |
| **Dead** | 1 | `no076_failclosed_check.js:40` — invoked nowhere |

Consequence: **switching resolution is small; dropping the column is not.**
Those are two different slices and §5 separates them.

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
4. **Durable object?** A new `communication_lines` record. `properties.sms_number`
   becomes derived, then retired.
5. **Immutable history?** Line configuration changes are append-only supersession
   — a number moving between properties must remain auditable, and the refusal
   paths write nothing by design.
6. **What reads it automatically?** Every inbound message, every outbound `from`,
   and the operator surfaces that display a property's line.
7. **When it is missing?** Unknown line → honest refusal, zero writes (already
   true). Ambiguous → fail closed (already true as of 129). **Line configured but
   inactive** → new case, must fail closed identically.
8. **Class and removal condition?** §7.

---

## 3. The durable model

One table. **No sentinel "operations property"** (Ruling 2 forbids it), and no
second table for the second line type — one line concept with two postures.

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
  outbound_enabled   boolean not null default true,
  status             text not null default 'active',  -- active | suspended | retired
  provider_config    jsonb,
  created_at         timestamptz not null default now(),
  superseded_at      timestamptz,
  ...
);
```

### The three constraints that carry the doctrine

```sql
-- canonical form, identical to normalizePropertyLine() — the 129 lesson:
-- the database enforces the INVARIANT, never re-implements the algorithm
check (e164 ~ '^\+1[0-9]{10}$')

-- exactly one owner. This is what makes an org-owned ops line representable
-- without a sentinel property.
check ((property_id is not null) <> (organization_id is not null))

-- THE CEILING IS STRUCTURAL, NOT DOCUMENTED (Ruling 4).
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

That third constraint is the point of the whole design. Today "staff texting a
property line gain no authority" holds **by accident** — because no staff sender
tier exists (FLAG 3). After this, **a property-facing line with operational
authority is not a configuration anyone can express.** The invariant stops being
a comment and becomes unrepresentable-if-violated.

### Uniqueness, and the eligibility predicate

```sql
create unique index uq_communication_lines_active_e164
  on communication_lines (e164) where status = 'active';
```

**The resolver must filter on `status = 'active'` and nothing else** — the exact
predicate of this index. That is the 129 rule restated: the set the database
keeps unique must be exactly the set the resolver reads, and if either changes
both change in the same commit.

A `retired` row may share a number with an `active` one. That is deliberate: a
number reassigned from one property to another over time must remain auditable
(§6 — corrections do not erase history). It also means **the resolver seeing a
retired row would be a correctness bug**, so it is an explicit test case.

---

## 4. The resolver API

Exactly the three questions Ruling 3 names. Nothing else may read line storage.

```js
resolveInboundLine(q, toNumber)
//  → { outcome: 'one'|'none'|'many'|'unresolvable'|'inactive',
//      line, candidates }

resolveOutboundLine(q, { propertyId | organizationId, purpose })
//  → { line, refusal }        refusal is a REASON, never a fallback number

lineAuthority(line)
//  → { lineType, authorityCeiling, permittedAudience }   pure, no I/O
```

`resolveInboundLine` keeps the shape `resolvePropertyByLine` already ships and
proves: no `limit`, the count is the finding, and `line` is null for every
outcome except `one` so a caller that forgets to branch gets null rather than an
arbitrary line. `inactive` is new — a configured but suspended/retired line is
**not** the same as an unknown one, and both fail closed.

`resolveOutboundLine` preserves today's `no_property_line` refusal discipline:
**never a Messaging Service default fallback.**

---

## 5. Retiring `properties.sms_number` — two slices, not one

Per §1 this is where the real cost is. Dual-writing the column and the table
would be two truths for one fact (§17), so it is not an option.

**Slice A — the model and resolution (this design).**
1. Create `communication_lines`; backfill one `property_facing` row per property
   holding a line. Trivially safe after 129: every value is canonical and unique.
2. Repoint the **2 resolution sites** at the resolver.
3. Repoint the **configuration route** to write the line record.
4. Leave `properties.sms_number` in place, still read by the ~16 display sites,
   now **derived** — a generated/derived read or a view, never a second writable
   truth.
5. Prove the five invariants (§6).

**Slice B — column retirement (separate, later).**
6. Migrate the ~16 display sites to read the line record.
7. Drop `properties.sms_number` and its 129 constraints, which move to the new
   table.

Splitting is what keeps Slice A narrow (§30). Merging them would make one slice
touch 7 files across identity, leasing and comms.

**Removal condition for `properties.sms_number`** (§18, closing Ruling 2):
retired at Slice B step 7, when no source file outside `communication_lines`
storage reads the column.

---

## 6. The five invariants, and how each is proven

Doctrine §5. All five need real Postgres and real HTTP; none has a browser
surface.

| # | Invariant | Proof |
|---|---|---|
| 1 | Staff texting a property line gain no staff authority | HTTP: staff-identified sender → property line → resolves under `external` ceiling; assert no staff-only action is reachable. **Now structural**, not accidental. |
| 2 | A resident texting the operations line gains no operating authority | HTTP: resident sender → ops line → `permitted_audience='staff'` refuses; zero writes. |
| 3 | Unknown **or ambiguously configured** line fails honestly | Already proven for unknown/ambiguous (`property_line_hardening.db.js` 41/41). Extend with `inactive`. |
| 4 | No property-line path can invoke staff-only actions | Assert on the ceiling, not on sender lookup failure — the FLAG 3 trap. |
| 5 | Both lines update the same work order, not parallel records | One work order, two lines, one history. Directly contradicts "SMS work orders". |

**Invariant 1 needs a deliberately hostile test.** Today it passes because staff
are unresolvable on that path. The test must add a resolvable staff sender and
still show zero authority — otherwise it re-proves the accident, not the ceiling.

---

## 7. Component classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| `communication_lines` table | permanent | — |
| Line resolver module | permanent | — |
| Structural ceiling CHECK | permanent | — |
| `properties.sms_number` | **temporary adapter** | Slice B step 7 |
| Derived read of `sms_number` (Slice A step 4) | **temporary** | deleted with the column |
| Staff OTP over the property line | **temporary transport adapter** (Ruling 5) | an active operations line exists for the organization; `090_admin_users.sql:47-48` assignment ordering becomes unnecessary |

---

## 8. Migration number — NOT claimed

**This design claims no number.** The applied ceiling is 128; 129 is merged and
unreleased; **130 is the next free number and Slice 10B may take it.**

At build time, not now: re-read the ledger, scan every remote branch (not
`ls migrations/`), and coordinate with the Slice 9/10 thread before claiming.

---

## 9. Open rulings — needed before implementation

1. **Properties with no organization.** `properties.organization_id` is
   **nullable** (093). An org-owned ops line cannot serve a property with a null
   organization. Do those properties get no ops line, or does the slice require
   backfilling organization membership first? *This is a data question with a
   product answer and I should not choose it.*
2. **One ops line per organization, or several?** Doctrine says "one
   management-company number **initially**." The unique index allows many; the
   constraint does not cap them. Cap it now, or leave it open?
3. **Does staff OTP move in Slice A?** Ruling 5's replacement condition is "once
   an active operations line exists" — which Slice A satisfies. Moving it is
   correct but widens the slice into `teamaccess.js` and `090`'s ordering hack.
   Recommend **deferring to its own slice**; needs a ruling either way.
4. **Slice A step 4 — derived or dual-read?** Recommend a **read-only derived
   view** over the ~16 display sites so there is exactly one writable truth from
   day one. Confirm.
5. **Does an operations line send outbound in Slice A**, or is it inbound-only
   until the technician loop? Recommend **inbound-only** — outbound staff
   messaging is the technician slice.

---

## 10. Explicitly NOT in this design

The technician SMS workflow · operations-number procurement/provisioning ·
routing an obligation to a technician · ITEM 2 (`conversation_owner_user_id`) ·
production fixture cleanup · rebuild-from-empty (PR #33) · any app-repo change ·
Slice 10A/10B Forward Rent Roll work.

**Nothing in this design may be called live, deployed, activated, or
production-proven.** Migration 129 is not yet released; the property-line proof
statement stays *"merged and proven locally, not production-active"* until the
owner posts the activation receipt.
