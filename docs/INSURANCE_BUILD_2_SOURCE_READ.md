# Insurance Build 2 — source read and the split call

**Status: PROPOSAL. Measured in the tree at API `f12ce41` / APP `41279e9`
(Add Current Insurance merged to the build branch, ledger ceiling 162 pending
release).** File:line references are real. Where I did not look, I say so.

---

## 1 · What already exists

### The economic chain — built, and not to be disturbed

```text
161  insurance_programs · insurance_coverages · insurance_coverage_identifiers
     insurance_property_allocations
162  insurance_coverage_properties          participation, no amount
     FK allocations → participation          allocation implies participation

src/asset/insurance_program_service.js      establishProgram · establishCoverage
                                            recordIdentifier · recordParticipation
src/asset/insurance_allocation_service.js   openSlice · correctSlice
src/asset/insurance_position_read.js        readPosition · readCompleteness
                                            readHistory · readParticipation
src/asset/insurance_establishment.js        POST evidence · POST establish
src/asset/insurance_document_read.js        propose() — label scan, no authority
```

`tests/gate_insurance_economic_independence.js` scans all seven and **fails the
build** on financing, escrow, installment or payment vocabulary.

### ⚠ F1 · NO FUNDING PRIMITIVE EXISTS ANYWHERE. Measured.

A repo-wide search for `ipfs|premium_financ|installment|escrow` over
`migrations/` and `src/` returns **only files that mention it to refuse it** —
161, the two insurance services, `asset_management.js`'s Cash & Financing
`reserved` spec — plus two unrelated hits:

```text
migrations/012_bank_intake.sql   bank_accounts · bank_transactions · vendors
src/money/explain.js:36          "escrow_paid" as a REASON CODE in the
                                 cash-vs-accrual explain vocabulary
```

`escrow_paid` is a label in an explain enum. It is not a primitive, it is not
attached to insurance, and it stores nothing. **Part 2 is greenfield.**

### ⚠ F2 · THE RENEWAL RAIL THAT EXISTS IS A DIFFERENT FACT

`migrations/119_renewal_operating_rail.sql` and `src/leasing/renewal_lifecycle.js`
are **resident lease renewal**: `module='leasing'`, `type='renewal_decision'`,
`renewal_cases`, `lease_offers` with `scope='renewal'`, resident decision,
execution.

Same English word, unrelated fact. **Insurance renewal must not touch
`renewal_cases` or `lease_offers`** — that would be the "two different fours"
merge `CLAUDE.md` warns about, at the schema level.

What IS reusable is 119's ruling, verbatim: *"ONE OWNERSHIP MACHINE, NOT TWO.
Renewal ownership, assignment, due and escalation reuse the canonical
`obligations` table… We do NOT invent a second assignment/owner field."*
`obligations.related_type`, `.module` and `.type` are open `text` with **no
CHECK constraint** (`001_baseline.sql:317-321`), so insurance can ride it
without a migration.

### ⚠ F3 · THE BINDING MECHANISM ALREADY SHIPPED

This is the finding that shrinks Part 1 to almost nothing.

The brief says renewal is complete only when there is *evidence the next term
is bound* — a policy, a binder, or clear carrier/broker binding confirmation.

**A bound next term is just another coverage with a later period, established
through the path Build 1 shipped.** Upload next year's binder → confirm →
`establishCoverage` + `recordParticipation`. That IS binding evidence, it
already carries `observed_in_artifact_id` provenance, and it is already
governed and attributed.

So "is the next term bound?" is a **query**, not a new fact:

```sql
-- does this property participate in a coverage that starts at or after
-- the current one ends?
```

No schema. No second writer. No workflow.

### What the states can be derived from today

| state input | source | exists |
|---|---|---|
| current coverage | `insurance_coverages` via `readParticipation` | ✅ |
| expiration date | `coverage_period_end` | ✅ |
| evidence | `observed_in_artifact_id` → `source_artifacts` | ✅ |
| next term bound | a later coverage the property participates in | ✅ (F3) |
| accountable human | `obligations` (existing machine) | ✅ |
| "broker is working on it" | **nothing** | ❌ |

Only the last row has no home — and it is also the row closest to the
project-management board the brief says not to build.

---

## 2 · Minimum changes actually required

### Part 1 — Good standing + renewal: **ZERO SCHEMA**

```text
src/asset/insurance_standing.js     NEW. Pure derivation. No table, no writer.
  standingOf({ coverages, asOf })   → state + milestone + why + what resolves it
src/asset/insurance_position_read.js
  readParticipation already returns every coverage with its period. Add
  nothing to it; the standing function consumes what it already emits.
src/surfaces/asset_management.js    emit standing on the insurance payload
app asset-management-door.js        render it in the position strip + stack
```

§18 killed a speculative index once in this repo for exactly this reason: no
query in the slice used that shape. The same applies here — **do not create a
`renewal_milestones` table for milestones that are a pure function of a date
and today.**

The one honest gap to state rather than fill: Spine cannot say "the broker is
working on it", because nobody has recorded that. It says `COVERAGE NOT
CONFIRMED` and names what would resolve it. That is the correct V1 answer and
it is not a stub.

**If an accountable human is needed**, use `obligations` with
`related_type='insurance_coverage'` — no migration, and it is the machine 119
already ruled for.

### Part 2 — Cash & financing: a new schema family, OUTSIDE the gated chain

```text
migration 163   insurance_funding_arrangements
                  how a coverage/program is funded: direct | escrow | financed
                  evidence artifact, effective dating, attribution
                premium_finance_agreements
                  provider, down payment, principal financed, finance charge,
                  installment count/amount, first payment date
                insurance_escrow_arrangements
                  escrowed y/n, lender/servicer, evidence

src/asset/insurance_funding_service.js   NEW canonical writer
src/asset/insurance_funding_read.js      NEW read
```

**The gate boundary is the architectural act of Part 2.** These files
necessarily contain `installment`, `down_payment`, `finance_charge`, `escrow`
— every token
`tests/gate_insurance_economic_independence.js` fails on. They therefore must
sit **outside** `CHAIN`, and the gate needs a second, inverse assertion:

```text
CHAIN            may not mention financing          (exists)
FUNDING FILES    may not be imported by CHAIN       (NEW — the real guard)
```

Without that inverse gate, adding financing files silently weakens the wall
that migration 161 exists to hold. **The gate as written would still pass while
the seam rotted**, because it only looks at the economic side.

`insurance_position_read.js` must not change at all in Part 2. Its accrual stays
`property allocated cost ÷ coverage term months`. A finance charge is financing
cost and never enters insurance expense.

---

## 3 · THE CALL: split into two vertical slices. Part 1 first.

**Recommendation: two slices, not one.** Five reasons, strongest first.

1. **They have opposite risk profiles, and bundling makes the safe one wait on
   the dangerous one.** Part 1 is pure derivation over existing data — no
   migration, no writer, no release, and it cannot corrupt anything. Part 2
   touches the exact seam the whole 161 build exists to protect. Shipping them
   together means a zero-risk improvement is gated behind the riskiest change
   in the domain.

2. **Part 1 needs no migration; Part 2 needs a deliberate release.** 162 is not
   yet released. Bundling would put a no-schema slice behind another
   `MIGRATION_RELEASE` ceremony — the trap this repo has now paid for three
   times.

3. **The gate boundary in Part 2 deserves its own attention.** Defining where
   the economic chain stops and the funding chain starts, and writing the
   inverse gate that keeps them apart, is the single most consequential
   decision in Build 2. It should not be made at the end of a long slice that
   started somewhere else.

4. **Each is independently useful.** Part 1 answers *are we insured, are we in
   good standing, what happens next.* Part 2 answers *how is it paid.* Neither
   needs the other to be worth shipping.

5. **§30.** One narrow, real, vertically complete slice at a time.

### What I would build first, exactly

```text
SLICE A — GOOD STANDING          no schema · no migration · no release
  standingOf()  →  CURRENT · RENEWAL APPROACHING (90/60/45/30)
                   COVERAGE NOT CONFIRMED · EXPIRED
  a bound next term = a later coverage the property participates in (F3)
  never healthy from absence: no evidence ⇒ COVERAGE NOT CONFIRMED, never CURRENT
  proof: deterministic date-table + real HTTP + browser

SLICE B — CASH & FINANCING       migration 163 · new writer · inverse gate
  direct · escrow · financed, rendered distinctly
  accrual PROVEN unchanged across every funding shape
  finance charge PROVEN absent from insurance expense
```

### One thing I would rule now, before either

**`NEEDS ATTENTION` should not be a state in V1.** The other four are
derivable facts. "Needs attention" is a judgement about someone's workload,
and with nothing recording renewal progress it would mean only "approaching
and not yet bound" — which `RENEWAL APPROACHING` + `not confirmed` already
says, more precisely and without implying Spine knows something it does not.
Adding it would be the first step toward the board the brief forbids.

Four states, each defensible from data that exists:

```text
CURRENT                 bound, in force, outside the 90-day window
RENEWAL APPROACHING     in force, inside 90/60/45/30 — milestone named
COVERAGE NOT CONFIRMED  no in-force coverage Spine can evidence
EXPIRED                 in-force coverage ended, no bound successor
```
