# Debt Build 1 — Phase B Architecture Position

**2026-08-12. Design, not schema. No migration written.**
**Follows `DEBT_BUILD_1_PHASE_A_SOURCE_READ.md`.**

> ## OWNER RULINGS — 2026-08-12. FROZEN.
>
> All three challenges accepted, with three constraints that narrow them. Where
> a ruling changes what this document originally argued, the section says so.
>
> ```text
> 1  borrower correction        ACCEPTED. 164 untouched. Stop here.
> 2  position is derived        ACCEPTED and FROZEN — with the cache caveat below
> 3  falsification moves up     ACCEPTED
> 4  multi-domain artifact      BOUNDARY accepted; IMPLEMENTATION kept narrow
> 5  B0                         DONE. Stop extending the gate.
> ```
>
> **Caveat on 2 — do not turn this into purity that makes every read expensive.**
>
> ```text
> canonical truth     = history          cannot be rebuilt
> derived projection  = disposable read  CAN be rebuilt, and may be materialised
> ```
>
> A materialised or cached current projection is acceptable later. The ruling is
> about which one is *canonical*, not about forbidding a cache.
>
> **Constraint on 4 — Debt must not become the router.** This corrects §3 of this
> document as originally written. See the amended §3.
>
> **Constraint on 5 — B0 is a boundary primitive, not licence to keep extending
> the gate while Debt itself is empty.** Taken; no further gate work this slice.
>
> **And the ruling that governs the whole build:** Ask Spine is not inside Debt.
> Debt owns instrument truth, terms, observations, payments, `position()`, truth
> states and its own walls. Ask Spine owns understanding the question, selecting
> a permitted read, composing the result, and preserving source/as-of/uncertainty
> boundaries. **It does not decide Debt truth.** The envelope in the charter is an
> *interface*, not a second store — Debt does not create "Ask Spine facts"
> alongside Debt facts:
>
> ```text
> canonical Debt history → standing projection → Ask Spine adapter → conversation
> ```

This document takes a position the Debt charter does not take, in three places,
and corrects one thing the Phase A read got wrong. It exists because a schema
written to the charter as literally specified would be wrong in a way that is
expensive to undo — the charter's §5C, §5G and Phase G each encode an assumption
the doctrine already refuses elsewhere.

Everything here is arguable. It is written to be argued with.

---

## The three challenges

```text
1  "Current position" cannot be a stored row. §39 already forbids it.
2  The falsification cases belong in Phase B, not Phase G.
3  A lender statement is a MULTI-DOMAIN source. Phase C assumes it is not.
```

And the correction:

```text
0  Phase A said legal_entity_properties needs a `borrower` type. That was wrong.
```

---

## 0. Correcting Phase A: borrower is not a property relationship

Phase A §5 concluded:

> `relationship_type` is `owner | operating_entity | other`. **There is no
> `borrower`.** That is a real schema touch in Phase B.

**That was wrong, and adding `borrower` there would have been a modelling error.**

`legal_entity_properties` answers *"what is this entity to this property?"*
Borrower is not an answer to that question. You do not borrow a property. You
borrow **from a lender, under an instrument, secured by a property**:

```text
WRONG    4125 Chestnut LLC  --borrower-->  4125 Chestnut Street
RIGHT    4125 Chestnut LLC  --borrower-->  loan 480010465  --secured by-->  4125
```

The distinction is load-bearing the moment a loan is cross-collateralized: one
borrower, one instrument, three properties. The property-keyed shape would
produce three "borrower" rows and no instrument, which is the exact defect §3 of
the charter exists to prevent — arriving through a different door.

**So `legal_entity_properties` is left alone.** Obligor identity is a relationship
between an entity and an *instrument*, and it belongs in the Debt domain. This
also preserves 164's meaning rather than widening it, which matters because Taxes
already depends on it.

---

## 1. "Current position" is a reading, not a row

The charter's §5C lists *current principal balance · balance as-of date · current
effective rate · next payment due · scheduled debt service · maturity remaining*
under the heading **"What is true now?"**, and §5G handles amendments separately
as "history."

Read as a table, that is a mutable status row. §39 refuses it in terms:

> One economic consequence accumulates multiple dated facts and relationships.
> These stages are **READINGS** of that history, not statuses on one row.
>
> A single mutable status column cannot represent what routinely happens.

Phase A found four things that break the row, on the *simple* specimen:

```text
two balances      $27,745,265.77 observed (2025-08-01 statement)
                  $27,131,874.12 projected (schedule, 2026-08-01)
                  both true, different source authority, neither is "the balance"

two regimes       interest-only through 2024-08-01, level $123,411.40 after
                  one row cannot hold a term that changed on a known date

three payment     AMT DUE / AMT RECEIVED / AMT REMAINING are three columns
truths            on the statement itself

stale as normal   the newest statement is twelve months old, today
```

### The proposal

```text
STORED              effective-dated TERMS        (append-only, superseding)
                    dated OBSERVATIONS           (append-only, never updated)
                    dated PAYMENTS               (append-only)

DERIVED             position(instrument, as_of)  ← every "current" value
```

Nothing named `current_*` is ever stored. `current_balance`, `current_rate`,
`current_maturity` are all `position(instrument, as_of = today)`.

### Why this is worth the extra work

**It answers the charter's own hardest question for free.** §5G asks:

> We need to be able to answer later: *What was the maturity before the
> modification?* without reconstructing it from PDFs.

With a stored current-terms row plus an amendment log, that is a reconstruction —
replay the log backwards and hope it is complete. With effective-dated terms it
is `position(instrument, as_of = <day before the amendment>)`. The same read,
different parameter. **The historical question and the current question are the
same query**, which is the only way the historical answer stays correct as the
system grows.

**It makes the schedule-vs-observation wall structural rather than remembered.**
Store only observations; derive projections. A projection cannot be mistaken for
an observation because it is not a row — there is nothing to mis-read. Compare
the alternative, where both are rows in one table distinguished by a `kind`
column that one careless query forgets to filter.

**One mechanism covers three charter sections.** IO→amortizing (§5B), amendments
(§5G) and extension exercise (§6) are all *the terms in force changed on a date*.
The original note itself establishes two term periods; an amendment establishes a
third. `term_source` distinguishes `original | amendment | extension_exercised |
assumption` without needing three mechanisms.

### The cost, stated honestly

A read is more expensive than a column, and the position logic becomes a place
bugs can live. Two mitigations, both with precedent in this repo:

- **Pin the servicer's published schedule and require the derivation to
  reproduce it.** This is exactly what `philadelphia_tax_rules.js` does with the
  City's U&O calendar, and the reason is on the record: *"a published date can
  never mask a broken rule — which it did, once, during falsification."* Lument's
  amortization schedule is 120 published rows of ground truth. A derivation that
  cannot reproduce all 120 is broken, and we will know.
- **§40.6's standing projection stays cheap** — latest observation is one indexed
  row, terms-in-force is one row, next requirement is one row. The full 120-row
  walk is the detail projection, which is precisely the split §40.6 exists for.

---

## 2. The falsification cases belong in Phase B

The charter's §20 opens: *"These are requirements, not nice-to-have tests."*
Agreed — and then the phase order puts every one of them after Phase G, because
each is phrased as an Ask Spine question.

That is five phases between designing a wall and testing it. Every wall defect
surfaces at the end, in the most expensive place to fix it, on the surface
furthest from the cause.

**Seven of the eight falsification cases are assertions about the canonical
read, not about the conversation.** They need no model and no UI:

```text
principal ≠ payoff            position() must not expose a payoff field
                              when no payoff observation exists
maturity ≠ extension          position() returns contractual maturity;
                              extension is a separate, unexercised term
scheduled ≠ actual payment    position() cannot report "current" from a
                              requirement with no matching payment
escrow ≠ obligation paid      Debt cannot author a tax payment — already
                              structural via gate_funding_boundary.js
floating rate unknown         terms establish the formula; effective rate
                              needs an index observation that does not exist
covenant ≠ satisfied          threshold is a term; compliance is a
                              determination with its own inputs
stale balance                 position() carries as_of; it never says "today"
```

Only the eighth — *reader failure must not read as health* — is genuinely about
Ask Spine, and it is already covered by §40.7's four silences.

**Proposal: the seven become `tests/proofs/debt_position_falsification.db.js`, written
against real Postgres in Phase B, before any UI exists.** Phase G then proves the
*conversational* rendering of walls that are already proven to hold in the read.
That is also the honest reading of "the walls are the product": they are the
product of the *domain*, and the conversation inherits them.

---

## 3. A lender statement is a multi-domain source artifact

The charter's Phase C is `upload → retain → read → propose → confirm → canonical
Debt write`. Single destination, implied by the name.

The 2025-08-01 Lument statement is not a Debt document. It is one document
carrying governed facts for **three** domains:

```text
Principal $45,046.44 · Interest $78,364.96      → DEBT
Principal balance $27,745,265.77 as of 8/1       → DEBT
Replacement Reserve $1,763.00 / bal $104,017.00  → DEBT (lender reserve under this loan)
Tax escrow $4,076.24 / balance $22,262.35        → TAX FUNDING
Insurance escrow $3,019.07 / balance $42,266.98  → INSURANCE FUNDING
```

If Phase C writes all of it to Debt, Debt has just authored a tax funding
position and an insurance funding position. `gate_funding_boundary.js` would not
catch it — the wall it enforces is *"funding may not author economics"* and this
is the mirror: an economic domain authoring another domain's funding.

### ⚠ AMENDED BY RULING — Debt must not become the router

This section originally proposed that extraction call each destination's writer:
*"debt writer → tax funding writer → insurance funding writer."* **That is
refused, and correctly.** Debt calling Tax's writer creates precisely the
coupling the wall exists to prevent — the boundary would be respected on paper
while Debt became the orchestrator of three domains.

The boundary is right; the plumbing was wrong. The permanent shape:

```text
retained source artifact
        ↓
source interpretation
        ↓
domain-scoped PROPOSED CLAIMS      Debt · Tax · Insurance
        ↓
each OWNING domain confirms and governs its own truth
```

**The artifact is shared. Authority is not.** No domain writes, or triggers a
write to, another domain's canonical truth.

### What Debt V1 actually does — deliberately smaller

```text
same artifact retained ONCE
Debt claims          → proposed and establishable now
Tax / Insurance      → retained as domain-scoped CANDIDATE claims
                     → NOT written into Debt
                     → NOT silently promoted into Tax/Insurance truth
```

Candidate claims are retained rather than discarded because capture-once matters
and the escrow line is genuinely governed information. They are inert until the
owning domain establishes them.

**If the existing proposal machinery can carry a destination domain cheaply, use
it. If carrying it requires inventing a generic multi-domain orchestration
framework, stop** — the permanent rule matters more than completing every future
workflow in this slice.

It remains true, and remains the uncomfortable part, that **Debt is not the owner
of the escrow balances it can see.** Debt owns *"this loan requires monthly tax
escrow of $4,076.24"* — a contractual term of the instrument. It does not own
what is in the account, and it does not put it there.

---

## Designing the answer before the schema (§40.6, taken literally)

Doctrine says the standing projection constrains schema. So it is written first,
and the schema is judged by whether it can serve this cheaply.

```text
DEBT STANDING PROJECTION — 4125, as of 2026-08-12

  instrument        Senior mortgage · Lument · loan 480010465
  borrower          4125 Chestnut LLC
  original          $28,250,000 · originated 2020, first payment 2020-09-01
  balance           $27,745,265.77   OBSERVED as of 2025-08-01
                    ⚠ latest observation is 12 months old
  rate              3.28% fixed
  debt service      $123,411.40 level P&I  (NOT the $132,269.71 total payment)
  next payment      NOT_ESTABLISHED — no 2026 statement retained
  maturity          2030-08-01 contractual
  extension         NOT_ESTABLISHED — loan agreement unread
  payment standing  NOT_ESTABLISHED — latest evidence 2025-07-03
  covenants         NOT_ESTABLISHED — loan agreement unread
  attention         balance observation stale >12mo
```

Two things to notice, because they are the point.

**Half of it is `NOT_ESTABLISHED`, and that is the correct output.** Not a
degraded one. A projection that filled those with schedule projections would be
the confident-wrong §5 forbids, and it would be *more* convincing precisely
because the other half is real.

**Every established line carries its authority.** `OBSERVED as of` is doing work
that a bare number cannot do. This is §40.4's envelope showing up in the shape of
the read, not bolted on at the conversation.

---

## The durable shape

Conceptual, not DDL. Named so it can be argued with.

```text
debt_instruments             what legally exists
                             kind · lender · servicer · loan number · original
                             principal · currency · origination · provenance

debt_instrument_properties   COLLATERAL, many-to-many, effective-dated
                             ⚠ carries the EVIDENCE that established the link.
                               Never the loan's name (Phase A §3: "LVL 4125")

debt_instrument_parties      obligor & guarantor
                             legal_entity_id for entities;
                             attributed NAME TEXT for natural-person guarantors,
                             which does NOT mint a durable person (§12)

debt_terms                   EFFECTIVE-DATED, append-only, superseding
                             rate kind/index/spread/floor/cap · day-count ·
                             amortization kind · level payment · maturity ·
                             balloon · prepayment · default rate
                             term_source: original | amendment |
                                          extension_exercised | assumption

debt_schedule_publications   the servicer's published schedule, retained
                             the derivation MUST reproduce it (tax precedent)

debt_balance_observations    APPEND-ONLY dated facts, with source authority
                             ⚠ projections are NOT stored here. They are derived.

debt_payments                dated, with application split, and
                             satisfies_requirement — migration 167's precedent,
                             filled where unambiguous and REFUSED where not

debt_escrow_requirements     the loan REQUIRES escrow — a contractual term
                             ⚠ NO BALANCES. Tax and Insurance own those.
```

**Derived, never stored:** `position(instrument, as_of)` · projected balance ·
next requirement · payment standing · maturity remaining.

---

## What this refuses to build

Restating the charter's non-goals, plus what this design adds to them:

```text
no generic "standing obligation" engine    Debt is the second instance after
                                           base rent, not the abstraction. The
                                           seam is NAMED, not extracted — and
                                           the extraction condition is a THIRD
                                           instance, not a second.
no covenant compliance engine              thresholds are terms; compliance is
                                           a determination Spine cannot make yet
no reserve module                          only debt-linked reserve facts
no payoff calculator                       payoff without a payoff statement is
                                           NOT_ESTABLISHED, permanently
no rate index feed                         floating-rate effective rate needs a
                                           governed observation, not a lookup
no causal explanation                      §40.10 — hooks preserved, capability
                                           not claimed
```

---

## Revised Phase B sequence

```text
B0  declare Debt in gate_funding_boundary.js          ← before any Debt file
B1  standing projection contract, written as the answer above
B2  schema + canonical writers
B3  position(instrument, as_of) read
B4  derivation reproduces all 120 published schedule rows
B5  falsification harness — the seven read-level cases, real Postgres
```

B0 has precedent and costs nothing: Taxes was declared in the wall before its
schema existed, deliberately, because *"the wall has to be executable before the
thing it guards is written, or the first commit is the one deciding where the
wall goes."* Debt is the third domain and the first to approach the wall from the
economic side.

---

## Rulings this needs before B2

```text
1  Is position-as-derived-reading accepted, or is a current-position row
   wanted for pragmatism? This is the big one and it is expensive to change later.

2  Does the lender statement route escrow facts to Tax/Insurance funding writers,
   or does Debt V1 simply NOT extract them? Both respect the boundary.
   Not extracting is smaller; routing is the one that stops double entry.

3  Read the closing binder for STRUCTURE before B2 — does an extension exist,
   are there covenants, is there an amendment chain? Not the numbers. The
   structural answers change the schema; the figures do not.
```

Item 3 is the one I would not skip. Extension options and covenants are the two
structures the charter names walls for, and both are currently `NOT_ESTABLISHED`
because a 55 MB PDF is unread. Designing their tables from imagination is the
thing Phase A exists to prevent.
