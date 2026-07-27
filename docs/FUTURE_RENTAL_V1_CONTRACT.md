# Future Rental V1 — calculation contract

**No code, no schema, no screens, no sequencing.** 2026-07-27.
Worked example: **Demo Building / "Solo on Chestnut"** (`a50fbdd0`), conventional multifamily
fixed 90-day horizon, **2026-07-27 → 2026-10-25**. Every figure measured live, read-only.

Companion documents: `FORWARD_RENT_ROLL_INVENTORY.md` (evidence), `PRICING_DESIGN_CURRENT.md`
(the pricing truth sheet this contract reads).

---

## 0 · Two classification axes, never collapsed

Every **locked** position decomposes on **both** axes independently.

**Proof basis** — how we know the lease is contractual truth:

| Basis | Means |
|---|---|
| `native_verified` | Executed lease verified **and** required deposit paid, through Spine |
| `confirmed_opening_import` | Accepted as the property's opening contractual truth from a governed source |
| `unproven` | Anything else. **Cannot enter any locked total** |

**Lease origin** — how the position came to be leased:

| Origin | Means |
|---|---|
| `new` | A new resident |
| `renewal` | Continues a prior lease on the same position — **must point to it** |
| `transfer` | Replaces a prior lease, resident moving between positions — **must point to it** |

Origin is **declared when the lease is created, never reconstructed** from names or dates.
Future Rental must state not only how much is locked, but **how much was locked through
renewal versus new leasing** — that is how progress against the renewal goal is measured and
how the resulting economics are understood.

An imported opening lease may be `confirmed_opening_import` **and** `renewal`; the axes do not
imply one another.

---

## 1 · Configured rentable positions

**Answers only: what are the property's configured rentable units or beds?**

| | |
|---|---|
| **Type** | Fact |
| **Source** | `spaces` joined to `units` — the configured rentable position |
| **Proof** | Structural |
| **Replaced by** | Nothing. Changes only when property configuration changes |
| **When missing** | No configured spaces → no projection at all. Never a unit-count fallback |

**Nothing is subtracted here.** Conflicts, down units, undefined statuses and evidence
disagreements are **not** deducted from inventory. They belong to eligibility, below. This
keeps the denominator understandable and stops overlapping exclusions from corrupting the
inventory arithmetic.

### The eligibility ladder

Each configured position then resolves to **exactly one** classification:

```
configured rentable position
  → locked at horizon
  → eligible for renewal projection
  → eligible for new-leasing projection
  → excluded with one stated reason
```

Exclusion reasons are single and stated: `down` · `conflicted` · `undefined_status` ·
`not_residential` · `evidence_disagreement`. An excluded position always explains itself.

---

## 2 · Locked at horizon

| | |
|---|---|
| **Type** | Fact |
| **Source** | `leases` (status + dates) resolved per position **at the horizon date**, by canonical server calculation — **not** a persisted position table |
| **Proof** | Both axes: proof basis **and** lease origin, carried per position |
| **Replaced by** | Nothing — this is the replacing layer. Signed activity moves positions **into** here and **out of** stages 4–7 |
| **When missing** | No coherent lease evidence → not locked, not projectable, excluded with a reason |

Evaluated at the horizon date, not today: a lease expiring inside the window does not lock
the horizon.

---

## 3 · Unresolved leases eligible for renewal

| | |
|---|---|
| **Type** | Fact (the expiry), not yet a decision |
| **Source** | `leases` with `end_date` inside the horizon, no successor lease on the same position |
| **Proof** | Inherits the expiring lease's proof basis |
| **Replaced by** | A signed renewal or new lease → stage 2. A notice → stage 5 |
| **When missing** | No expiries → no renewal projection. **Never** a modelled churn rate |

**This cohort defines the unit mix.** Read from positions actually coming due; never entered
by management.

---

## 4 · Historical renewal baseline — a FACT

| | |
|---|---|
| **Type** | **Fact — calculated, not editable** |
| **Source** | The comparable prior leasing cycle, or the prior 90-day expiration cohort: of the positions that came due, how many renewed |
| **Proof** | Derived from lease origin (`renewal` pointing at the prior lease). **Requires the origin classification to exist** |
| **Replaced by** | Recalculation as cycles complete. Never overwritten by hand |
| **When missing** | **Honest blank.** Never 0%, never a house average |

The assumption set may **reference** this figure. It must never turn last year's actual
renewal rate into an editable assumption.

---

## 5 · Renewal goal — an ASSUMPTION

| | |
|---|---|
| **Type** | Assumption |
| **Source** | The property's versioned assumption set, one **property-level** goal per horizon |
| **Proof** | Approval, effective date, approver, supersession history |
| **Replaced by** | Nothing directly — it governs the projection until superseded |
| **When missing** | No goal → no renewal projection. Stage 3 still reported as fact |

Presented against the baseline, both visible:

```
Last comparable period:  35% renewed   (fact)
Current goal:            37%           (assumption)
```

**V1 has one property-level goal.** There are no management-entered goals by unit type.

---

## 6 · Projected renewals — the cascade

The goal is applied to the **actual unresolved cohort**, and reality is removed from that
cohort as it arrives:

```
actual leases coming due
  → signed renewals already locked      (fact — leaves the cohort, enters stage 2)
  → remaining renewal goal              (goal minus what is already signed)
  → remaining unresolved unit-type mix  (read from the positions still unresolved)
  → projected renewals                  (assumption, allocated across that real mix)
  → projected turnover                  (the remainder)
```

| | |
|---|---|
| **Type** | Assumption applied to a factual cohort |
| **Replaced by** | Every signed renewal replaces its projected position **one-for-one**. The projection shrinks; it never sums with reality |
| **When missing** | Blank if the goal is missing. The cohort itself is still reported |

**No unit type may be introduced because it exists on the pricing sheet.** Only the mix
actually present in the remaining unresolved cohort is allocated against.

---

## 7 · Projected turnover requiring new leasing

| | |
|---|---|
| **Type** | Derived — fact and assumption components, reported separately |
| **Source** | Fact: positions vacant, uncommitted, not excluded. Assumption: stage 3 minus stage 6 |
| **Proof** | Inherits per component; never merged into one number |
| **Replaced by** | A signed new lease → stage 2 |
| **When missing** | Only the fact component is reported; the assumption component stays blank |

---

## 8 · Renewal and new-lease economics — from the pricing truth sheet

| | |
|---|---|
| **Type** | Assumption applied to fact |
| **Source** | The **approved Pricing & Concessions version**, by **actual unit type** — renewal economics for projected renewals, new-lease economics for projected turnover, including effective pricing, concessions and effective dates |
| **Proof** | Pricing version id, effective dates, publisher authority |
| **Replaced by** | Actual signed rent, which supersedes the sheet for that position |
| **When missing** | **Honest blank.** Never `units.market_rent`, never last year's rent, never an average of in-place rents |

**The assumption set references the pricing version; it never copies pricing into itself.**
One pricing truth, not forecast pricing duplicated into a second object.

---

## 9 · Target occupancy and remaining projected vacancy

| | |
|---|---|
| **Type** | Assumption |
| **Source** | Assumption set: target occupancy for property and horizon |
| **Proof** | Approval, effective date, supersession |
| **Replaced by** | Actual occupancy as positions lock |
| **When missing** | Blank. Occupancy reported as achieved against locked positions only, no target line |

---

## 10 · Projected future rental

Always decomposed, never blended:

```
contractually locked            (fact, by proof basis × lease origin)
+ projected renewal revenue     (assumption, pricing version cited)
+ projected new-lease revenue   (assumption, pricing version cited)
= projected future rental       (only when every component resolves)
```

**When any component is blank, the total is blank.** Unresolved pieces are never added
together and labelled a total.

### But the surface still states, independently and always

- Contractually locked rental
- Rental expiring within the horizon
- Vacant positions that are factual today
- **Which projection components are unavailable, and why**

A missing projection never suppresses the facts that are known.

---

## Worked example — Demo Building, 2026-07-27 → 2026-10-25

### Inventory (no subtraction)

**283 configured rentable positions** — 283 units × 1 space each. By-bed capable; 1:1 here.

### Eligibility ladder

| Classification | Positions | Monthly rent |
|---|---:|---:|
| Locked at horizon | 131 | $222,540.83 |
| Eligible for renewal projection (coming due) | 92 | $151,370.00 |
| Eligible for new-leasing projection (vacant, uncommitted) | 2 | — |
| Excluded, one stated reason | 66 | — |

Exclusion reasons: `evidence_disagreement` 52 · `conflicted` 7 · `down` 4 · `undefined_status` 3.

**These sum to 291 against 283 positions — 8 positions currently qualify for more than one
bucket** (locked or expiring leases sitting on structurally excluded positions). The ladder
must assign exactly one classification per position. **The precedence between "conflicted" and
"locked" is not yet ruled and is a decision owed** — a contested position arguably cannot be
locked, because which lease governs is unknown. I have not assumed an answer.

### Locked, axis one — proof basis

| Basis | Positions | Monthly rent |
|---|---:|---:|
| `confirmed_opening_import` | 130 | $220,690.83 |
| `native_verified` | 1 | $1,850.00 |
| `unproven` | 0 | — |

### Locked, axis two — lease origin

| Origin | Positions |
|---|---:|
| `new` · `renewal` · `transfer` | **unknown — 131** |

**The origin classification does not exist in governed data.** No renewal marker on `leases`;
the only lineage pointer anywhere is `executed_lease_records.supersedes_record_id`, which
tracks document supersession within one lease, not lease-to-lease continuation.

### Expiring cohort shape

92 positions, $151,370.00/mo, expiries 2026-07-29 → 2026-09-30 —
**0–30 days: 69 · 30–60: 22 · 60–90: 1.** Heavily front-loaded.

Mix by bedrooms: **0BR 49 · 1BR 36 · 2BR 4 · 3BR 3**.
*(Bedrooms is not a unit type. `units` has no unit_type column — shown only to prove the mix
is derivable from real positions.)*

### Where the projection stops

| Stage | Output | Why |
|---|---|---|
| 4 · Historical baseline | **BLANK** | Not computable — see below |
| 5 · Renewal goal | **BLANK** | No assumption set exists |
| 6 · Projected renewals | **BLANK** | Depends on 4 and 5 |
| 7 · Projected turnover | **2 positions (fact only)** | Vacant, uncommitted, not excluded |
| 8 · Economics | **BLANK** | `property_pricing_versions` = 0 rows, published = 0. Also no unit_type join key |
| 9 · Target occupancy | **BLANK** | No assumption set |
| 10 · Projected future rental | **BLANK** | Components unresolved |

### Why the historical baseline is blank, not zero

The prior comparable 90-day cohort is **10 expiring leases**. Of those, **7 have a successor
lease** on the same position — but **0 of those successors share a tenant** with the expiring
lease.

Computed naively, that yields a **0% renewal baseline**. That number is almost certainly
false: it reflects the **absence of renewal classification**, not an absence of renewals.
**The baseline must therefore be an honest blank until lease origin is declared at creation.**
This is the clearest demonstration in the contract of why origin is a required permanent fact.

### The honest V1 output today

> **$222,540.83 monthly rental is locked at 2026-10-25** — 130 positions from confirmed
> opening import, 1 natively verified. Lease origin is unknown for all 131.
>
> **$151,370.00 of current monthly rental expires inside the window** — 92 positions,
> 69 of them within 30 days.
>
> **2 positions are vacant and uncommitted today.**
>
> **The remaining projection is unavailable** because no approved pricing version and no
> assumption set exist, and the historical renewal baseline cannot be calculated without
> lease-origin classification.
>
> **66 positions are excluded**, each with a stated reason.

No total is presented, because no total is known.

---

## Invariants

1. **Inventory is never reduced by eligibility.** Stage 1 answers configuration only.
2. **Mix comes from positions coming due** — never entered, never assumed.
3. **No unit type may appear unless that inventory exists in the horizon.** The pricing sheet cannot introduce inventory.
4. **Locked replaces assumption one-for-one.** Signed activity shrinks the projected set; it never adds alongside it.
5. **Pending leases, applications, leads and tours are outside V1** — including the 48 pending-only positions above, which are excluded, not counted.
6. **Contractual and projected economics are never blended.**
7. **Conflicted, down, non-revenue, undefined and evidence-disagreeing positions cannot silently enter** — one stated reason each.
8. **No client-side forecast authority, no fixture fallback.** Precedence computed once, server-side; the renderer displays the decision.
9. **Neither classification axis is ever collapsed.** Any locked total decomposes by proof basis **and** by lease origin.
10. **Facts survive missing assumptions.** Locked, expiring and vacant are always stated, even when the projection is unavailable.

---

## Blocking inputs

The contract is complete. It cannot execute until these exist:

1. **Lease origin** (`new` / `renewal` / `transfer` + prior-lease pointer), declared at creation. Blocks axis two, the historical baseline, and the renewal cascade.
2. **Unit-type resolution** — `units` has no unit_type column, so stage 8 has no join key.
3. **An approved pricing version** — zero exist for any property.
4. **A versioned assumption set** — renewal goal, target occupancy, referenced pricing version, effective date, approver, supersession. It references the baseline; it does not contain it.

## Open decision

**Precedence between `conflicted` and `locked`.** 8 positions currently qualify for more than
one ladder bucket. Ruling owed before the ladder can assign exactly one.
