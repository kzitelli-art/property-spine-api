# Debt — Read Contract, Truth Walls, and Minimal Historical Schema

**2026-08-12. Phases B and C (design). No migration written.**
**Phase A is closed — see `DEBT_4125_STRUCTURAL_MAP.md`.**

Everything here is forced by the 4125 specimen at authority level 1. Where a
structure is *not* forced, it is named as a seam and left unbuilt.

---

## PART 1 — THE TRUTH WALLS, DECLARED AS DATA

Per §40.5 the walls are a declaration, not prose, because **the falsification
suite is generated from the declaration** — that is what makes them survive the
next domain instead of being re-litigated.

Nine walls. Each names the collapsing vocabulary that triggers it, and what the
read must do instead.

```text
W1  PRINCIPAL ≠ PAYOFF
    collapses on   "what do we owe" · "pay it off" · "payoff"
    specimen       principal established; NO payoff statement exists
    rule           payoff is NOT_ESTABLISHED unless a payoff observation exists.
                   Principal may never be returned in a payoff role.

W2  SCHEDULED REQUIREMENT ≠ ACTUAL PAYMENT
    collapses on   "are we current" · "paid" · "up to date"
    specimen       requirement known to 2030; latest payment evidence 2025-07-03
    rule           payment standing derives ONLY from payment observations.
                   A requirement with no matching payment is not "current".

W3  CONTRACTUAL MATURITY ≠ EXTENSION
    collapses on   "when does it mature" · "when is it due"
    specimen       2030-08-01; NO extension option evidenced at authority 1
    rule           maturity is the contractual date. Extension standing is a
                   separate value and is never added to the maturity date.

W4  RATE FORMULA ≠ OBSERVED EFFECTIVE RATE
    collapses on   "what's our rate"
    specimen       3.28% FIXED — the floating case is unexercised here
    rule           a fixed rate IS the effective rate. A formula (index+spread)
                   is not, and yields NOT_ESTABLISHED without an index
                   observation. Structural only; build no index machinery.

W5  COVENANT EXISTS ≠ COVENANT SATISFIED
    collapses on   "are we in compliance" · "any covenant issues"
    specimen       Article VI ordinary borrower covenants exist
    rule           existence is governed truth; compliance is NOT_ESTABLISHED.
                   ⚠ ENFORCED BY SCHEMA: there is no compliance column to write.

W6  ESCROW FUNDED ≠ UNDERLYING OBLIGATION PAID
    collapses on   "are the taxes paid" · "is insurance covered"
    specimen       tax + insurance imposition reserves exist and are funded
    rule           Debt states the loan REQUIRES the escrow. It never states,
                   implies or authors that the tax or premium was paid.
                   ⚠ ENFORCED BY gate_funding_boundary.js.

W7  STALE OBSERVATION ≠ PRESENT-DAY OBSERVATION
    collapses on   "what's the balance" · "currently" · "today"
    specimen       newest observation 2025-08-01 — twelve months old TODAY
    rule           every observation returns with its as_of. The read never
                   presents an observation as a present-day value.

W8  PROJECTED BALANCE ≠ OBSERVED BALANCE
    collapses on   "the balance"
    specimen       observed $27,745,265.77 (2025-08-01)
                   projected $27,131,874.12 (2026-08-01)
    rule           both are legitimate and carry different source authority.
                   ⚠ ENFORCED BY SCHEMA: projections are not stored, so a
                   projection cannot be read out of the observation table.

W9  DEBT SERVICE ≠ TOTAL MONTHLY PAYMENT
    collapses on   "monthly payment" · "what do we pay" · "debt service"
    specimen       $123,411.40 P&I  vs  $132,269.71 total (incl. $8,858.31 escrow)
    rule           debt service is P&I. The total includes escrow and reserve
                   funding that is not the cost of the debt. Answering with the
                   total overstates debt cost by 7% and imports funding into an
                   economic answer.
```

**Three of the nine are enforced structurally rather than by assertion** — W5 by
having no compliance column, W8 by not storing projections, W6 by the existing
funding-boundary gate. A wall that cannot be violated needs no policing.

---

## PART 2 — THE READ CONTRACT

### `position(instrument, as_of)`

The single canonical read. Every "current" value is this function at
`as_of = today`; every historical question is the same function at another date.
Nothing named `current_*` is stored.

```text
INPUT    instrument_id · as_of

RESOLVES terms in force at as_of        from effective-dated terms
         latest balance observation      at or before as_of, with its own as_of
         payment standing                from payment observations only
         next requirement                derived from terms in force
         reserve requirements in force
         covenant/reporting requirements in force
         party roles in force            originator · holder · servicer

RETURNS  every value with: value | truth_state · source_authority · as_of
```

**Answers the charter's hardest question for free:** *"what was the maturity
before the modification?"* is `position(instrument, as_of = <before>)` — the same
read, a different parameter, not a reconstruction.

### The standing projection (§40.6)

Small, cheap, gathered routinely. Detail is a second read. This is the shape it
must be able to express — **not** a field list to build one-per-question.

```text
instrument            kind · loan number · originator · holder · servicer
borrower              legal entity
original principal    with origination date

principal position    value · as_of · source_authority · observed|projected
rate position         contractual structure · effective rate if established · as_of
debt service          P&I only, and labelled as such
next requirement      dated, with its component split
contractual maturity  date
extension standing    not_evidenced | exists_unexercised | exists_exercised
payment standing      derived from observations, or NOT_ESTABLISHED
reserve requirements  categories in force
covenant standing     requirements exist; compliance NOT_ESTABLISHED
important unknowns    including stale-observation flags
canonical open target
```

**On the 4125 specimen today, roughly half of this is `NOT_ESTABLISHED`, and that
is the correct output** — not a degraded one. A projection that filled those from
the schedule would be more convincing and less true.

### What Ask Spine gets — and does not

```text
canonical Debt history → standing projection → Ask Spine adapter → conversation
```

Ask Spine receives the projection. It does **not** receive the closing binder,
OCR output, a document parser, or the Debt schema, and it computes no Debt value.
The envelope is an **interface**, not a second store — Debt does not create "Ask
Spine facts" beside Debt facts.

---

## PART 3 — THE MINIMAL HISTORICAL SCHEMA

Eight tables. Each justified by what 4125 forces at authority 1. Conceptual
shape, not final DDL.

```text
1  debt_instruments
   kind · loan_number · original_principal · currency · origination_date ·
   first_payment_date · provenance · source_artifact
   ⚠ currency NOT NULL, NO DEFAULT — the repo has no governed currency context,
     so Debt resolves it explicitly or refuses. It does not inherit USD by luck.

2  debt_instrument_parties                    EFFECTIVE-DATED
   instrument · role · legal_entity_id NULL · party_name_text NULL ·
   effective_from · effective_to · source_artifact
   roles: borrower · guarantor · originator_lender · holder_assignee · servicer
   ⚠ FORCED: ORIX originated, Freddie Mac holds by assignment, Lument services.
     Assignment is a dated event, so roles are effective-dated like terms.
   ⚠ Five guarantors are NATURAL PERSONS → party_name_text, attributed to the
     guaranty. Debt does not mint durable people (§12).

3  debt_instrument_properties                 COLLATERAL
   instrument · property · lien_position · effective_from/to ·
   established_by_source_artifact
   ⚠ FORCED by the ruling even though 4125 has one property, and it carries the
     evidence that established the link — never the loan's name ("LVL 4125").

4  debt_terms                                 EFFECTIVE-DATED, APPEND-ONLY
   instrument · effective_from · effective_to · term_source ·
   rate_kind · fixed_rate · index/spread/floor/cap (all NULL here) ·
   day_count_convention · payment_frequency · amortization_kind ·
   level_payment_amount NULL · maturity_date · balloon_amount ·
   extension_standing · superseded_by · source_artifact
   term_source: original | amendment | extension_exercised | assumption
   ⚠ FORCED: the ORIGINAL instrument establishes TWO periods — IO through
     2024-08-01, then level $123,411.40. Two rows, both term_source=original.
   ⚠ day_count stored, never assumed: actual/360 drives every interest figure.

5  debt_reserve_requirements                  EFFECTIVE-DATED
   instrument · reserve_kind · amount · basis · effective_from/to · source
   kinds: tax_imposition · insurance_imposition · replacement · debt_service
   ⚠ FORCED: $1,763/mo replacement AND the $1,110,703 COVID-19 debt service
     reserve. A requirement is a row, not a Reserves & Escrows module.
   ⚠ NO BALANCE COLUMNS. Tax/insurance balances are those domains' funding truth.

6  debt_obligation_requirements               COVENANT + REPORTING, CATEGORIES
   instrument · requirement_family · category · effective_from/to · source
   ⚠ NO THRESHOLD COLUMN. NO COMPLIANCE COLUMN. NO TEST-DATE COLUMN.
     That absence IS the enforcement of W5 — compliance is unrepresentable,
     so it can never be reported. Adding a compliance column is the moment
     this becomes a covenant engine, and it needs its own ruling.

7  debt_balance_observations                  APPEND-ONLY, NEVER UPDATED
   instrument · observed_balance · as_of_date · observation_source ·
   source_authority · source_artifact · recorded_by · recorded_at
   ⚠ PROJECTIONS ARE NOT STORED HERE OR ANYWHERE. They are derived. This is
     what makes W8 structural rather than remembered.

8  debt_payments                              APPEND-ONLY
   instrument · payment_date · amount_received ·
   applied_principal · applied_interest · applied_escrow · applied_other ·
   satisfies_requirement · source_artifact · source_authority
   ⚠ satisfies_requirement follows migration 167's precedent: filled where
     unambiguous, REFUSED where the payment could satisfy several.
   ⚠ due / received / applied are three facts — they are three columns on the
     servicer's own statement.
```

### Derived, never stored

```text
position(instrument, as_of) · projected balance · next requirement ·
payment standing · maturity remaining · debt service figure
```

A materialised cache of any of these is acceptable later. **Canonical is history;
a projection is a disposable reading that can be rebuilt.**

### Not built — seams named, subsystems refused

```text
schedule publication table   pinned as a TEST FIXTURE instead, on the tax
                             precedent (philadelphia_tax_rules.js pins the City
                             calendar in code, not a table). The derivation must
                             reproduce all 120 published rows.
covenant thresholds/tests    W5 above — needs its own ruling
reserve balances / draws     a reserve domain, later, forced by a second specimen
index observations           no floating-rate instrument exists here
cross-collateral pool        affirmatively excluded by the Loan Agreement
supplemental loan            affirmatively excluded by the Loan Agreement
```

---

## PART 4 — WHAT COMES NEXT, AND WHAT DOES NOT

```text
NEXT   migration 168 + canonical writers          (branch only — see below)
       position(instrument, as_of)
       derivation reproduces all 120 published rows
       falsification harness: W1–W9 against real Postgres, before any UI

NOT    document reader / OCR            Phase E, scoped by evidence we lack
       multi-domain router              artifact shared, authority never
       Reserves & Escrows               a requirement is a row
       covenant monitoring              existence is not permission
       SOLO / second specimen           4125 first, and 4125 is closed
       Ask Spine implementation         constrains this schema; ships at H
```

### ⚠ Migration 168 cannot merge to `main`

Production ledger ceiling is **167**, and `prestart` verifies rather than applies.
**Merging a pending migration to `main` is a failed production deploy** — the
trap that has already cost time twice. Migration 168 lands on a branch and stays
there until a deliberate release runs, with `EXPECTED_LEDGER_CEILING` read from
the ledger rather than typed from this document.
