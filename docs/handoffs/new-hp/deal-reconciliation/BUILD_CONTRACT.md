# BUILD CONTRACT — portfolio naming, identity and access

**v2** · issued 2026-09-16 · over board `8ef648be` · lane
`claude-opus/deal-reconciliation-20260915`

**Revised after consultant review.** Five corrections accepted, one of which
found a real defect: v1's W4 would have partly defeated its own W3. Changes are
marked **[C1]–[C5]**; two additions I raised are marked **[A1]–[A2]**. v1 is in
git history at `84e3a2d1`.

**Scope:** make the owner's deals read correctly, and make the two
production-priority properties resolvable by code that already exists.

**This is portfolio identity cleanup. It is not the reusable property-onboarding
framework**, and must not be mistaken for it. When onboarding is built, this
becomes **one governed shelf inside it** — the naming, identity and access shelf
— not its foundation. It is also not an Asset Management build; that door is
empty in production and is a separate programme.

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

## 2 · DECISIONS

### ✅ D2 — CLOSED **[C1]**

**Greenery access is already done.** Signed-in work on 2026-09-16 granted the
owner Greenery access while preserving SUPER ADMIN, and Greenery now appears in
the picker.

**W5 is complete. Do not perform a second access write.** A redundant write
through the super-admin route would touch `allowed_modules` and `updated_at`
for no gain, and is exactly the kind of change that makes the before/after
diff in §7.5 unreadable.

Evidence class: **owner-reported**, 2026-09-16. It is confirmed when the fresh
section 7 (§2.1) shows `ae68ad79-1e64-43f0-88ef-e378472deda0` active with
`asset_management` still present. Confirm before starting, not after.

### ⏳ D1 — STILL OPEN **[C2]**

**Should the demo building appear in the owner's everyday picker?**
If no, deactivate `5c461425-8c61-41ca-9869-05246c256eec` (W6).

**Either way the demo is renamed.** Recommended label, from the review:

> `Property Spine Demo — Solo Shape`

It states what it is and what it is shaped like, and cannot be misread as the
real Solo. W2 proceeds on this name whichever way D1 goes.

### 2.1 · ⛔ THE SEPTEMBER 15 SNAPSHOT IS STALE — RE-READ FIRST **[C1]**

v1's premise — *"the owner has exactly four active assignments"* — was true on
2026-09-15 and **is not true now**. The Greenery grant changed it.

**Before any naming or canonical-key write**, re-run `KEEP_RETIRE_MAP.sql`
**sections 1, 4A, 5 and 7** and work from that output. Those four are the ones
an access write can move: current names and keys (1), team counts (4A),
registry agreement (5), and who can open what (7). Sections 2, 3, 4B, 6 and 8
are unaffected by an access write and need no re-read.

Every id in this contract is stable — ids do not change. **Every count and
every active/inactive flag must be re-read.**

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

**[C3] There is no clearing path, and W2 does not ask for one.** v1 contradicted
itself: W1 refused a blank value while W2 told the developer to clear the demo's
name. The refusal is right and stands — a blank display name silently falls back
to the internal name, which is the failure being fixed. **Every property named in
W2 gets an explicit label.** The writer never accepts empty, and nothing in this
contract needs it to.

**Acceptance:** the writer refuses blank and whitespace-only input with a
message a human can act on (§"a refusal a user can see is product copy" — name
the next step, do not emit machinery vocabulary); it records the prior value; a
second call with the same value is not an error; the change is visible in the
chooser without a deploy.

---

### W2 · Set the four display names — IN THIS ORDER

Through W1's writer, never by hand.

| # | Property id | Set `display_name` to | Note |
|---|---|---|---|
| 1 | `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` | `Property Spine Demo — Solo Shape` | **must go first** · **[C3]** never blank |
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

### W0 · THE SEPARATION OF CONCERNS THIS CONTRACT NOW ENFORCES **[C4]**

**Read this before W3 or W4. v1 conflated three facts and its own two work
items fought each other.**

Both readers do:

```js
const deal = byPropertyId(propertyId) || (propRow && byCanonical(propRow.canonical_key)) || null;
const model = deal?.model || null;   // NEVER inferred — if unknown, say so
const displayName = deal?.name || propRow?.name || "Property";
```
`property_surface.js:71-75` · `leasing_detail.js:38-42`

`deal?.name` **wins over everything.** So the moment W4 gives Skyline the
canonical key `1417`, the registry resolves and the label becomes the
registry's string `"Skyline"` — not `"Skyline Apartments"`, no matter what
`display_name` holds. v1's W4 would have partly defeated v1's W3. That is a
defect in v1, not a matter of taste.

**Three separate facts, three separate owners. Never collapse them:**

| Fact | Authority | Never |
|---|---|---|
| **Human-facing label** | `properties.display_name`, falling back to `properties.name` | never the registry |
| **Property identity** | `properties.id` and `properties.canonical_key` | never the label |
| **Leasing model** | the governed deal registry, stored and never inferred | never a rent roll, never the DB column |

**Target for Skyline `14e41b7c-e91c-49e8-9651-10c4908a8f6a`, all three at once:**

```
display_name : "Skyline Apartments"
canonical_key: "1417"
model        : "bed"
```

#### [A1] · The registry's own header becomes false — change it in the same commit

`src/onboarding/deal_registry.js` opens by claiming it is

> *"the source of truth the property surface reads to know: **what to call the
> property** · whether to count by unit or by bed · which canonical key / id
> resolves it"*

After this change it is **no longer the naming authority**. It keeps leasing
model and identity resolution and loses naming.

**Update that header in the same commit as W3.** A file whose header claims an
authority the code no longer gives it is precisely how this repository has been
misled before — `CODEBASE_STATE.md` was stamped to one commit and silently
wrong two weeks later. Do not leave the claim standing "until later."

---

### W3 · Four presentation readers — display label only **[C4] [C5]**

Change **exactly four**, and in each one change **both** the query and the
precedence:

| File | Line | Query change | Precedence change |
|---|---|---|---|
| `src/surfaces/property_surface.js` | 71, 74 | add `display_name` | drop `deal?.name` from the label |
| `src/leasing/leasing_detail.js` | 38, 41 | add `display_name` | drop `deal?.name` from the label |
| `src/money/reporting.js` | 88 | add `display_name` | — |
| `src/money/exposure.js` | 57 | add `display_name` | — |

The label expression becomes, in the two registry-aware readers:

```js
const displayName = propRow?.display_name || propRow?.name || "Property";
const model       = deal?.model || null;   // unchanged — registry keeps the model
```

**`deal?.model` stays exactly as it is.** The registry remains the model
authority and the comment *"NEVER inferred — if unknown, say so"* stays true.
Only the label moves.

#### Leave these alone **[C5]**

| File | Why |
|---|---|
| `src/identity/property_resolution_service.js` (75, 116, 136) | it resolves **by** `canonical_key` and **by** `name` — `where name = $1`. These are identity inputs, not presentation. Making resolution depend on a label an operator can edit would make identity mutable. |
| `src/identity/identify.js` (295) | identity confirmation, not a surface |

**Judgement call, recorded rather than silently decided:** `identify.js:295`
selects by **id**, then puts `p.rows[0].name` into a user-facing string —
*"Linked this file to {name}."* — falling back to `canonical_key`. By the rule
above that string is presentation. It is left unchanged anyway, because the
message is confirming **which record** was linked and the record's own name is
the honest thing to show there. If the developer disagrees after reading it,
that is a defensible one-line change — but it is **out of this contract's
scope** and does not travel with W3.

**⛔ TRAP T3 — an API output key is a contract.** A blunt rename during
migration 159 changed a response key and not the app that read it; nothing
threw and a deal page showed "Setup in progress" for an established property.
If a response key changes shape here, pin it with an assertion that reads the
key **by name**.

**Acceptance:** Skyline renders `Skyline Apartments` — not `Skyline` — on the
property surface, the leasing detail and the reporting dashboard, **after** W4
has set its canonical key. That ordering is the whole point of this item.
Browser-verified; look at the screenshot, not the test output.

---

### W4 · Canonical keys for Skyline and Greenery — identity only

Section 5's own verdict for `greenery`, `skyline`, `templenest` and `n1850`:
**"no pin, and no row for this canonical key."** For `solo` and `uno`:
**"pin and canonical key agree"** — their identity is sound and needs nothing.

Both carry `canonical_key_absent_reason = predates_canonical_identity_requirement`,
so `deal_registry.js` can resolve neither, and their leasing model reads blank
even though `properties.leasing_basis` says `bed` for Skyline.

**Do:** use the existing governed door,
`POST /registry/properties/:id/canonical-key` (`registry.js:252`). Address-
anchored by contract; 409 on collision.

| Property id | Key the registry expects |
|---|---|
| `14e41b7c-e91c-49e8-9651-10c4908a8f6a` | `1417` |
| `a29181cd-3ba1-461c-aead-cd989add1d11` | `1325-N-15` |

**What this now does, and only this:** the registry resolves, so `model`
becomes `bed`. With W3 landed, the **label is untouched by it**.

**[A2] Ordering note — W3 before W4 is marginally safer.** Either order reaches
the same end state, and neither regresses against today (both readers currently
show the lowercase internal name). But if the two ship in separate deploys,
W3-then-W4 means W4 can only ever affect the model, never the label. If W4 goes
first, there is a window where Skyline reads `Skyline` instead of
`Skyline Apartments`. **Shipping them together is fine. W4 alone is not done.**

**Do NOT** make these readers fall back to `properties.leasing_basis`.
*"NEVER inferred — if unknown, say so"* is doctrine (§5), and that column is
`unknown` for 37 of 41 rows including the real Solo and Uno. A fallback turns a
correct blank into a confident wrong.

---

### W5 · Greenery access — ✅ **COMPLETE, DO NOT EXECUTE** **[C1]**

Done by signed-in work on 2026-09-16, with SUPER ADMIN preserved. Greenery is
in the picker.

**No second access write.** Confirm it in the fresh section 7 (§2.1) and move
on: `ae68ad79-1e64-43f0-88ef-e378472deda0` active, `asset_management` still
present.

The traps below are kept because they still govern W6 — and because the reason
this item was hard is worth not re-learning:

**⛔ TRAP T2 — the obvious route cannot restore lost access.**
`PATCH /property-team-assignments/:id` (`teamaccess.js:818`) refuses at line
**830**:

```js
if (target.property_id !== me.property_id)
  return res.status(403).json({ receipt: "Not in your property scope." });
```

The caller must already be **operating that property**. You cannot restore your
own lost access through this door. The super-admin route
`PATCH /admin/users/:id/assignments/:assignmentId` (`super_admin.js:529`) is the
one that can.

---

### W6 · The demo in the owner's chooser — **D1 required**

If D1 is "no": `PATCH /admin/users/:id/assignments/:assignmentId`
(`super_admin.js:529`, `requireSuperAdmin`) on
`5c461425-8c61-41ca-9869-05246c256eec` with `{ "active": false }`.
Reversible, per-person, moves no history, deletes nothing.

**Regardless of D1, the demo is renamed in W2.** Visibility and labelling are
separate decisions; only one of them is open.

**⛔ TRAP T4 — send `active` alone. Do not send `role_key`.**
That route carries its own hardcoded `ROLE_MODULE_MAP` (`super_admin.js:533`)
— a **second** preset source beside the migration-160 presets. In it, `owner`
grants `capital`, not `asset_management`. Passing a `role_key` overwrites
`allowed_modules` from that map and would strip `asset_management`. With
`role_key` omitted, `preset` is null and `coalesce($3, allowed_modules)`
preserves what is there.

**Record, do not fix here:** two preset sources for one concept is the
divergence §40.3 warns about. Separate lane.

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

Making `properties.display_name` an input to identity resolution **[C5]**.
Letting the deal registry keep naming authority **[C4]**. Clearing a display
name to blank **[C3]**. A second Greenery access write **[C1]**.
Deletion of any record. Bulk reassignment. A new membership model —
`deal_intake_properties` exists and is many-to-many. Any organization-wide
permissions rewrite. Renaming the demo's `name` (T1). Merging by address.
Recreating a property to obtain a clean card. Converting any `leasing_basis`.

---

## 6 · TRAPS, COLLECTED

| | Trap | Where |
|---|---|---|
| T1 | Change `display_name`, never `name` — five lookups key on `name` | W2 |
| T2 | `PATCH /property-team-assignments/:id` requires you already hold the property; it cannot restore your own lost access | W5 *(closed)* |
| T3 | An API output key is a contract; pin renamed keys by name | W3 |
| T4 | Send `active` alone to the super-admin route; `role_key` reloads modules from a stale second preset map and drops `asset_management` | W6 |
| T6 | **The registry name beats `display_name` in two readers.** Setting a canonical key without fixing the label precedence makes the screen read the registry's string. W4 without W3 is not done. **[C4]** | W3, W4 |
| T7 | The 2026-09-15 figures are stale — an access write has landed since. Re-read sections 1, 4A, 5, 7 before writing anything. **[C1]** | all |
| T5 | **A deploy does not migrate.** `prestart` runs `migrate.js` verify-only and the service refuses to start on a pending file. Releasing schema is a separate deliberate act with `MIGRATION_RELEASE=1` and `EXPECTED_LEDGER_CEILING`. | any migration |

---

## 7 · DEFINITION OF DONE

Per §33, and each demonstrable rather than asserted:

1. The owner's chooser reads **Greenery Apartments · Skyline Apartments ·
   Solo on Chestnut · Uno on Chestnut**, and the entry named
   `Solo on Chestnut` resolves to `9e2bb96e…`, **by id, not by name match**.
2. The demo building is distinguishable from the real Solo in the chooser.
   Both rows still exist.
3. **Skyline returns all three facts at once, from three different owners
   [C4]:** `display_name: "Skyline Apartments"` · `canonical_key: "1417"` ·
   `model: "bed"` — on the property surface, the leasing detail and the
   reporting dashboard. **`Skyline` alone is a FAIL**, not a partial pass: it
   means the registry is still winning the label.
4. The demo reads `Property Spine Demo — Solo Shape`. No property in the
   chooser has an empty display name **[C3]**.
5. Section 4A and 4B counts for every property are **unchanged** before and
   after — diffed against the **fresh** §2.1 snapshot, not the 2026-09-15 one.
6. Section 7 differs from the fresh snapshot **only** on the assignments this
   contract names, and only for the people it names. `asset_management` is
   still on the owner's Skyline and Greenery assignments.
7. `deal_registry.js`'s header no longer claims naming authority **[A1]**.
8. Browser-verified, with the screenshot preserved — not JSON, not test output.
   Assert the app actually loaded, and that the asserted element is what
   `document.elementFromPoint` returns at its centre. A rendered element under
   a fixed overlay is invisible and `innerText` reads it perfectly.
9. **Registered for Ask Spine** if any new canonical read lands (§40.2).
   `tests/gate_ask_spine_readers.js` enforces it.
10. `docs/CURRENT_STATE.md` updated for what was built, connected, proved or
   disproved — per its CLOSING A THREAD section.

---

## 8 · SEQUENCE

```
§2.1  fresh read-only snapshot — sections 1, 4A, 5, 7      ← FIRST, always
         ↓        confirms D2/W5 complete; re-bases every count
D1 answered (demo visible or not)
         ↓
W1    governed display_name writer                  code · proofs · no blanks
         ↓
W2    four labels, demo FIRST                       data · through W1 only
         ↓
W0    read the separation of concerns
         ↓
W3    four presentation readers + registry header   code ──┐ ship together,
W4    two canonical keys                            data ──┘ or W3 first
         ↓
W6    demo visibility                    [D1]       data · trap T4
         ↓
re-run sections 1, 4A, 5, 7 · diff · browser proof · CURRENT_STATE
```

**W1 gates W2. W2 gates nothing else. W3 and W4 together complete one fact;
W4 alone is not done.** W5 is already complete and is not in this sequence.
