# BUILD CONTRACT — portfolio naming, identity and access

**Issued** 2026-09-16 · over board `8ef648be` · lane
`claude-opus/deal-reconciliation-20260915`

**Scope:** make the owner's four deals read correctly, and make the two
production-priority properties resolvable by the code that already exists.
This is reconciliation and wiring. It is **not** an onboarding build and not an
Asset Management build.

---

## 0 · EVIDENCE CLASS — read this before trusting any number below

| Claim class | How it was established |
|---|---|
| Every row count, id and name | `KEEP_RETIRE_MAP.sql` sections 1–8 run against **production** on 2026-09-15 by the owner and returned whole. Recorded, not inferred. |
| Every code behaviour | Read from source at board `8ef648be`. File and line cited at each item. |
| Which picker the app lands on | **Owner-reported**, corroborated by source (no logo field exists in the API). Not browser-proven. See `PICKER_TRACE.md`. |

Nothing below was measured by this lane against production. This lane performed
**no production read**.

### A claim of mine that the run falsified

I asserted that Solo and Uno carry asset-management, legal-entity, capital,
tax, insurance, debt and document work. **They carry one debt instrument and
one compliance item between them.** Section 4B returns zero for
`legal_entities`, `capital_stack_positions`, `insurance_coverage_properties`,
`tax_obligation_properties` and `documents` across **all 41 properties**.
Retracted in `CLEANUP_PLAN.md` §4 and in the map header. It is stated here
because a contract built on the old claim would have been needlessly cautious.

---

## 1 · THE ESTABLISHED PROBLEM, IN ONE TABLE

The owner has exactly **four active** `property_team_assignments`.
`authorized_properties.js:70-84` selects
`coalesce(p.display_name, p.name)` ordered by the same expression, so the
signed-in chooser renders:

| Rendered | Property id | What it actually is |
|---|---|---|
| `4125 Chestnut` | `260b6bac-4738-47c4-b86d-511b726adc48` | Uno — `display_name` is null |
| `4233 Chestnut` | `9e2bb96e-08e2-41db-81c2-91055ceb50a3` | the **real** Solo — `display_name` is null |
| `Skyline Apartments` | `14e41b7c-e91c-49e8-9651-10c4908a8f6a` | correct |
| `Solo on Chestnut` | `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` | **the demo building, 1 Demo Way, Demo ORG** |

Greenery `a29181cd-3ba1-461c-aead-cd989add1d11` is absent: the owner's
assignment `ae68ad79-1e64-43f0-88ef-e378472deda0` has `active = false`.

**The demo holds the real Solo's name.** The real Solo shows as a street
address. That is the defect, stated exactly.

### Not the defect

~29 active assignments sit on `R3 Prop`, `R3 Prop2` and `Bridge Proof`
fixtures. **None belong to the owner** — they belong to `R3 Ghost`,
`R3 Kandice`, `R3 Katie`, `John Banks` and QA operators. They do not appear in
the owner's chooser and this contract does not touch them.

---

## 2 · DECISIONS REQUIRED BEFORE W5 AND W6

Work items W1–W4 are unblocked. These two are not:

- **D1 — should the demo building appear in the owner's everyday list?**
  If no, deactivate `5c461425-8c61-41ca-9869-05246c256eec`. If yes, it must
  still be renamed (W2) so it cannot be mistaken for the real Solo.
- **D2 — should Greenery appear?** If yes, reactivate
  `ae68ad79-1e64-43f0-88ef-e378472deda0`. **Read trap T2 before attempting it.**

Do not infer either. Both are the owner's call.

---

## 3 · WORK ITEMS

### W1 · There is no governed writer for `display_name` — build one

**Status: this is a gap, not an oversight to route around.**

Eleven statements in the repo update `properties`
(`timezone_command.js:121`, `property_hierarchy_service.js:134`,
`property_creation_service.js:292`, `registry.js:263`, `owner.js:234`,
`owner.js:369`, `activation_service.js:266`, `dealintake.js:404`,
`dealintake.js:443`, `leasepackets.js:850`, `server.js:2756`).
**None of them writes `display_name`.** The only place it is accepted is
`property_creation_service.js:210`, at creation.

So the plan's earlier phrase *"property update through its governed path"* was
wrong: there is no such path.

**Build:** one canonical writer for `display_name`, server-derived actor and
authority (§21), refusing a blank or whitespace-only value, with an immutable
record of the prior value. Model it on
`POST /registry/properties/:id/canonical-key` (`registry.js:252`), which is the
closest existing shape.

**Do not** bulk-update the column by hand and call it done. A display name is
what an operator reads to decide which building they are looking at; it needs a
writer with a receipt.

**Acceptance:** the writer refuses blank input with a sayable message; it
records the prior value; a second call with the same value is not an error; the
change is visible in the chooser without a deploy.

---

### W2 · Set the four display names — IN THIS ORDER

Through W1's writer, never by hand.

| # | Property id | Set `display_name` to | Note |
|---|---|---|---|
| 1 | `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` | *(clear it, or a name containing "Demo")* | **must go first** |
| 2 | `9e2bb96e-08e2-41db-81c2-91055ceb50a3` | `Solo on Chestnut` | the real Solo |
| 3 | `260b6bac-4738-47c4-b86d-511b726adc48` | `Uno on Chestnut` | |
| 4 | `a29181cd-3ba1-461c-aead-cd989add1d11` | `Greenery Apartments` | internal name is lowercase `greenery` |

`14e41b7c…` already reads `Skyline Apartments`. Leave it.

**Order is load-bearing.** Until step 1 lands, the demo holds the string
`Solo on Chestnut`. Doing step 2 first puts two identical entries in the
owner's own chooser.

**⛔ TRAP T1 — change `display_name`, NEVER `name`.**
Five call sites look a property up by `properties.name` with
`order by created_at asc limit 1`, enumerated in
`tests/gate_property_name_resolution.js:66-78`: `operator.js`,
`demo_reset.js`, `demo_preflight.js` and `leasingleads.js` (×2). The demo's
`name` is `Property Spine Demo Building` and every one of those resolves
through it. Changing `name` reroutes all five silently.

That gate's own header says three production rows share that name. **Section 1
shows only one.** The premise is stale; the defect class is not — three rows
share the *display* string `Solo on Chestnut`
(`a50fbdd0`, `79a5a8d1`, `21197bb1`). Record, do not chase.

---

### W3 · Six readers ignore `display_name` — fix them

All six issue `select id, name, canonical_key from properties where id=$1` and
then render `name`:

| File | Line | Consequence |
|---|---|---|
| `src/surfaces/property_surface.js` | 71 | property surface shows `skyline` |
| `src/leasing/leasing_detail.js` | 38 | leasing detail shows `skyline` |
| `src/money/reporting.js` | 88 | **the reporting dashboard** |
| `src/money/exposure.js` | 57 | exposure read |
| `src/identity/identify.js` | 295 | |
| `src/identity/property_resolution_service.js` | 75, 116, 136 | resolution by key/name |

Twenty-plus other files already use `coalesce(display_name, name)` correctly,
so this is drift, not a design choice.

**Judgement required on the last two.** `identify.js` and
`property_resolution_service.js` may be matching on the internal name
deliberately. **Read each before changing it.** If the internal name is the
right input there, leave it and say so in the receipt.

**⛔ TRAP T3 — an API output key is a contract.** A blunt rename during
migration 159 changed a response key and not the app that read it; nothing
threw and a deal page showed "Setup in progress" for an established property.
If a response key changes shape here, pin it with an assertion that reads the
key **by name**.

**Acceptance:** Skyline renders `Skyline Apartments` on the property surface,
the leasing detail and the reporting dashboard. Browser-verified, not asserted
from JSON — and look at the screenshot, not the test output.

---

### W4 · Skyline and Greenery have no canonical key, so the registry cannot find them

Section 5's own verdict, for `greenery`, `skyline`, `templenest` and `n1850`:
**"no pin, and no row for this canonical key."**
For `solo` and `uno`: **"pin and canonical key agree"** — their identity is
sound and needs nothing.

`deal_registry.js` resolves by pinned id or canonical key. Skyline and Greenery
are pinned to neither, and both carry
`canonical_key_absent_reason = predates_canonical_identity_requirement`.

Both consumers then do:

```js
const deal = byPropertyId(propertyId) || (propRow && byCanonical(propRow.canonical_key)) || null;
const model = deal?.model || null;   // NEVER inferred — if unknown, say so
const displayName = deal?.name || propRow?.name || "Property";
```
`property_surface.js:71-75` · `leasing_detail.js:38-42`

So for the two production-priority deals, leasing basis reads **blank** —
even though `properties.leasing_basis` says `bed` for Skyline. Neither reader
consults that column.

**Do:** set canonical keys through the existing governed door,
`POST /registry/properties/:id/canonical-key` (`registry.js:252`). It is
address-anchored by contract and returns 409 on collision.

| Property id | Key the registry expects |
|---|---|
| `14e41b7c-e91c-49e8-9651-10c4908a8f6a` | `1417` |
| `a29181cd-3ba1-461c-aead-cd989add1d11` | `1325-N-15` |

**Do NOT** make these two readers fall back to `properties.leasing_basis`. The
comment *"NEVER inferred — if unknown, say so"* is doctrine (§5), and the
column is `unknown` for 37 of 41 rows including the real Solo and Uno. A
fallback would turn a correct blank into a confident wrong.

**Acceptance:** `/properties/14e41b7c…/surface` returns a non-null `model` and
the name `Skyline`, sourced from the registry, with the reader unchanged.

---

### W5 · Greenery access — **D2 required**

Assignment `ae68ad79-1e64-43f0-88ef-e378472deda0`, owner, `active = false`.

**⛔ TRAP T2 — the obvious route cannot do this.**
`PATCH /property-team-assignments/:id` (`teamaccess.js:818`) refuses at line
**830**:

```js
if (target.property_id !== me.property_id)
  return res.status(403).json({ receipt: "Not in your property scope." });
```

The caller must already be **operating that property**. The owner cannot
select Greenery, because the assignment is inactive. **You cannot restore your
own lost access through this door.**

**Use** `PATCH /admin/users/:id/assignments/:assignmentId`
(`super_admin.js:529`, `requireSuperAdmin`), body `{ "active": true }`.

**⛔ TRAP T4 — send `active` alone. Do not send `role_key`.**
That route carries its own hardcoded `ROLE_MODULE_MAP` (`super_admin.js:533`)
— a **second** preset source beside the migration-160 presets. In it, `owner`
grants `capital`, not `asset_management`. Passing a `role_key` overwrites
`allowed_modules` from that map and would strip `asset_management` from the
owner's assignment. With `role_key` omitted, `preset` is null and
`coalesce($3, allowed_modules)` preserves what is there.

**Record, do not fix here:** two preset sources for one concept is the
divergence §40.3 warns about. It is a separate lane.

---

### W6 · The demo in the owner's chooser — **D1 required**

If D1 is "no": `PATCH /admin/users/:id/assignments/:assignmentId` on
`5c461425-8c61-41ca-9869-05246c256eec` with `{ "active": false }`.
Reversible, per-person, moves no history, deletes nothing. Trap T4 applies.

---

## 4 · RECORDED, NOT IN SCOPE

Real, established, and deliberately excluded. Each needs its own decision.

1. **The demo may hold real resident data.** `a50fbdd0` has **283 units** —
   identical to the real Solo's 283 — plus 349 leases and 2 imports, at
   "1 Demo Way". Identical unit counts are not coincidence. Worth knowing
   before the demo is shown outside the company.
2. **Which row holds the real Solo work is unresolved.** The demo has more
   leases (349 vs 274) and more imports (2 vs 1) than the real property.
   Touch neither row until a human rules.
3. **Tom can open only the demo.** Every assignment for user
   `5ee50499-1506-40d0-ab2c-ce6284bcccca` is inactive except
   `ee9f8871-ecd9-4bfd-b577-f6024c89d294` on `a50fbdd0`. He cannot open
   Skyline, Uno, the real Solo or Greenery. If unintended, larger than naming.
4. **There is no Solo deal and no Uno deal.** Section 2 returns eight
   `deal_intakes`: one `skyline`, five Greenery-ish (`1325 N 15th st`,
   `Greenery`, `greenery` ×3), two unnamed. Two of the Greenery records point
   at the same property; three point at nothing.
5. **No organization holds any deal.** Demo ORG 2 properties / 0 deals;
   OneFive Management 1 / 0; ZZ TEST 0810 2 / 0. All eight deals have a null
   `organization_id`. The Capital → Deals → Properties structure exists as
   three disconnected pieces.
6. **Asset Management is empty in production.** Zero legal entities, zero
   capital positions, zero insurance, zero tax obligations, zero documents,
   across all 41 properties. One debt instrument (Uno). Eleven compliance
   items, ten of them on the demo.
7. **Leasing basis is `unknown` for 37 of 41**, including the real Solo and
   Uno. For Solo, Uno and Greenery the registry file is currently the **only**
   place that fact exists — so `deal_registry.js` cannot be retired until
   basis is recorded properly. Section 5 says
   *"model disagreement — REPORT, do not convert"* for both.
   **Do not reconcile basis by copying the registry into the column.** Bed
   versus unit decides how inventory counts; it changes from a rent roll with
   evidence, never to make two sources agree.

---

## 5 · NOT AUTHORIZED

Deletion of any record. Bulk reassignment. A new membership model —
`deal_intake_properties` exists and is many-to-many. Any organization-wide
permissions rewrite. Renaming the demo's `name` (T1). Merging by address.
Recreating a property to obtain a clean card. Converting any `leasing_basis`.

---

## 6 · TRAPS, COLLECTED

| | Trap | Where |
|---|---|---|
| T1 | Change `display_name`, never `name` — five lookups key on `name` | W2 |
| T2 | `PATCH /property-team-assignments/:id` requires you already hold the property; it cannot restore your own lost access | W5 |
| T3 | An API output key is a contract; pin renamed keys by name | W3 |
| T4 | Send `active` alone to the super-admin route; `role_key` reloads modules from a stale second preset map and drops `asset_management` | W5, W6 |
| T5 | **A deploy does not migrate.** `prestart` runs `migrate.js` verify-only and the service refuses to start on a pending file. Releasing schema is a separate deliberate act with `MIGRATION_RELEASE=1` and `EXPECTED_LEDGER_CEILING`. | any migration |

---

## 7 · DEFINITION OF DONE

Per §33, and each demonstrable rather than asserted:

1. The owner's chooser reads **Greenery Apartments · Skyline Apartments ·
   Solo on Chestnut · Uno on Chestnut**, and the entry named
   `Solo on Chestnut` resolves to `9e2bb96e…`, **by id, not by name match**.
2. The demo building is distinguishable from the real Solo in the chooser.
   Both rows still exist.
3. Skyline renders `Skyline Apartments` and a non-null leasing model on the
   property surface, the leasing detail and the reporting dashboard.
4. Section 4A and 4B counts for every property are **unchanged** before and
   after. Re-run `KEEP_RETIRE_MAP.sql` and diff.
5. Section 7 before and after differs **only** on the assignments this
   contract names, and only for the people it names.
6. Browser-verified, with the screenshot preserved — not JSON, not test output.
   Assert the app actually loaded, and that the asserted element is what
   `document.elementFromPoint` returns at its centre. A rendered element under
   a fixed overlay is invisible and `innerText` reads it perfectly.
7. **Registered for Ask Spine** if any new canonical read lands (§40.2).
   `tests/gate_ask_spine_readers.js` enforces it.
8. `docs/CURRENT_STATE.md` updated for what was built, connected, proved or
   disproved — per its CLOSING A THREAD section.

---

## 8 · SEQUENCE

```
D1, D2 answered
      ↓
W1  display_name writer                     (code, has proofs)
      ↓
W2  four display names, in order            (data, through W1)
      ↓
W3  six readers                             (code) ──┐
W4  two canonical keys                      (data)  ─┤  independent
W5  Greenery access          [D2]                   ─┤
W6  demo access              [D1]                   ─┘
      ↓
re-run KEEP_RETIRE_MAP.sql · diff 4A, 4B, 7 · browser proof · CURRENT_STATE
```

W1 gates W2. Nothing else is ordered.
