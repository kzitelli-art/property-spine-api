# Debt — Read Contract, Truth Walls, and Minimal Historical Schema

**2026-08-12. Phases B and C (design). FROZEN after owner corrections.**
**Phase A is closed — see `DEBT_4125_STRUCTURAL_MAP.md`.**

Everything here is forced by the 4125 specimen at authority level 1. Where a
structure is *not* forced, it is named as a seam and left unbuilt.

> **Owner corrections applied 2026-08-12.** Seven, all surgical. Each is marked
> ⚠ at the point it lands. Summary:
>
> ```text
> 1  structural protection ≠ proven wall — W5/W6/W8 still get hostile proofs
> 2  Debt proves the DISTINCTION; Ask Spine later proves LANGUAGE cannot
>    collapse it. Phrase handling never enters position().
> 3  append-only means POINT BACKWARD — no superseded_by, no rewriting old rows
> 4  extension_standing REMOVED from canonical terms
> 5  balloon_amount REMOVED — the schedule's figure is a projection
> 6  debt_obligation_requirements REMOVED from 171 entirely
> 7  debt_payments → debt_payment_observations; satisfies_requirement dropped
> ```
>
> Result: **seven tables, not eight.**

---

## PART 1 — THE TRUTH WALLS

### ⚠ Correction 1 — structural protection is not semantic proof

The prior version of this document said *"a wall that cannot be violated needs no
policing."* **That was wrong and is withdrawn.** Schema and gates make W5, W6 and
W8 *harder* to violate. They do not make them impossible:

```text
no compliance column        stops storing a bogus status.
                            Does NOT stop position() seeing that covenants
                            exist and rendering "covenants: okay".

projections not stored      stops reading a projection out of the observation
                            table. Does NOT stop a read computing a projected
                            balance and labelling it simply "balance".

funding-boundary gate       stops Debt WRITING tax payment truth.
                            Does NOT stop a Debt reader SAYING "taxes are paid"
                            because an escrow is funded.
```

**Defense in depth.** Keep every structural defense, and every one of W1–W9 gets
a read-level hostile proof in the falsification harness. Structure narrows the
attack surface; it does not discharge the obligation to prove.

### ⚠ Correction 2 — two proof layers, one wall

The prior declaration mixed the canonical distinction with natural-language
phrases. That would have taught `position()` English, which is the opposite of
the architecture.

```text
DEBT LAYER        proves the FACTUAL DISTINCTION holds in the canonical read
       ↓
ASK SPINE LAYER   proves ORDINARY LANGUAGE cannot collapse that distinction
```

**Debt proves the distinction. Ask Spine later proves language does not destroy
it.** Conversational phrase handling never enters `position()`, and Ask Spine
never decides Debt truth. The phrases are recorded in §1.3 as *the later layer's_
input, deliberately outside the Debt contract.

### 1.1 The nine walls — Debt-layer declaration

Declared as data; the domain falsification suite is generated from it.

```text
W1  PRINCIPAL ≠ PAYOFF
    distinction  principal balance and payoff amount are different concepts
    specimen     principal established; NO payoff statement exists
    debt proof   position() exposes no payoff value. Principal is never
                 returned in a payoff role. Payoff = NOT_ESTABLISHED.

W2  SCHEDULED REQUIREMENT ≠ ACTUAL PAYMENT
    distinction  what is contractually due vs what a payment source observed
    specimen     requirements derivable to 2030; latest observation 2025-07-03
    debt proof   payment standing derives ONLY from payment observations.
                 A derived requirement with no observation is not "current".

W3  CONTRACTUAL MATURITY ≠ EXTENSION
    distinction  the contractual date vs any option to move it
    specimen     2030-08-01; no extension option evidenced at authority 1
    debt proof   maturity is the contractual date, always. Extension is never
                 added to it, and is reported as not-evidenced (see ⚠4).

W4  RATE STRUCTURE ≠ OBSERVED EFFECTIVE RATE
    distinction  a formula is not a rate until observed
    specimen     3.28% FIXED — the floating case is unexercised here
    debt proof   a fixed rate IS the effective rate. A formula without an index
                 observation yields NOT_ESTABLISHED. Structural only.

W5  COVENANT EXISTS ≠ COVENANT SATISFIED
    distinction  existence is governed truth; compliance is a determination
    specimen     Article VI ordinary borrower covenants exist
    debt proof   position() returns NO compliance value and NO aggregate
                 covenant health. Not "okay", not green, not silent-implies-fine.
    structural   no compliance column exists — necessary, NOT sufficient (⚠1)

W6  ESCROW FUNDED ≠ UNDERLYING OBLIGATION PAID
    distinction  funding an escrow is not paying the tax or the premium
    specimen     tax + insurance imposition reserves exist and are funded
    debt proof   position() states the loan REQUIRES the escrow and returns NO
                 value asserting a tax or premium was paid, at any confidence.
    structural   funding-boundary gate blocks the WRITE — not the SENTENCE (⚠1)

W7  STALE OBSERVATION ≠ PRESENT-DAY VALUE
    distinction  an observation is true as of a date, not now
    specimen     newest observation 2025-08-01 — twelve months old today
    debt proof   every observation returns with its as_of. No read presents an
                 observation as a present-day value, and staleness is surfaced.

W8  PROJECTED BALANCE ≠ OBSERVED BALANCE
    distinction  a derivation from terms vs a fact someone recorded
    specimen     observed $27,745,265.77 · projected $27,131,874.12
    debt proof   every balance carries observed|projected and its authority.
                 A projection is never returned as "balance" unqualified.
    structural   projections are not stored — necessary, NOT sufficient (⚠1)

W9  DEBT SERVICE ≠ TOTAL MONTHLY PAYMENT
    distinction  P&I is the cost of the debt; escrow moves through the lender
    specimen     $123,411.40 P&I vs $132,269.71 total (incl. $8,858.31 escrow)
    debt proof   debt service returns P&I only, labelled. The total is never
                 returned as debt service.
```

### 1.2 What the Debt harness proves

Real Postgres, before any UI, before any conversation:

```text
W1–W9 each get a hostile fixture and an assertion that position() refuses to
collapse the distinction — INCLUDING W5, W6 and W8, whose structural defenses
are treated as narrowing the attack, never as discharging the proof.
```

### 1.3 Deferred to the Ask Spine layer — NOT Debt's concern

Recorded so it is not lost, and explicitly outside `position()`:

```text
W1  "what do we owe" · "pay it off"
W2  "are we current" · "up to date"
W3  "when does it mature"
W5  "are we in compliance" · "any covenant issues"
W6  "are the taxes paid"
W7  "what's the balance" · "currently"
W9  "what do we pay monthly"
```

Debt does not learn these. Ask Spine proves, later, that they do not collapse a
distinction Debt already holds.

---

## PART 2 — THE READ CONTRACT

### `position(instrument, as_of)`

The single canonical read. Every "current" value is this function at
`as_of = today`; every historical question is the same function at another date.
Nothing named `current_*` is stored.

```text
INPUT    instrument_id · as_of

RESOLVES terms in force at as_of        derived from term history
         party roles in force at as_of  originator · holder · servicer
         latest balance observation     at or before as_of, with its own as_of
         payment standing               from payment observations only
         next requirement               derived from terms in force
         reserve requirements in force

RETURNS  every value with: value | truth_state · source_authority · as_of
```

Answers *"what was the maturity before the modification?"* as the same read with
a different parameter — not a reconstruction.

### The standing projection (§40.6)

The shape it must be able to express. **Not** a field list, and **not** one field
per anticipated question.

```text
instrument            kind · loan number · originator · holder · servicer
borrower              legal entity
original principal    with origination date

principal position    value · as_of · authority · observed|projected
rate position         contractual structure · effective rate if established
debt service          P&I only, labelled
next requirement      dated, with component split
contractual maturity  date
extension             NOT_ESTABLISHED — no option evidenced in reviewed
                      governing source            ⚠ narrative, not a stored state
payment standing      from observations, or NOT_ESTABLISHED
reserve requirements  categories in force
important unknowns    including stale-observation flags
canonical open target
```

On 4125 today roughly half is `NOT_ESTABLISHED`, and that is the correct output.

### Capability classes Debt Build 1 claims — all three, explicitly

§40.10 now names **three** classes, not two, and says each is claimed explicitly
or not at all. Debt's earlier receipts addressed retrieval and causal explanation
and were **silent on comparison**. Silence is no longer a permitted answer.

```text
RETRIEVAL              CLAIMED
                       "what is our debt service" · "when does it mature" ·
                       "what is the balance, as of when"

COMPARISON             NOT CLAIMED
                       "compare debt across the portfolio" ·
                       "is 4125's rate high" · "which loans are outliers"

CAUSAL EXPLANATION     NOT CLAIMED — hooks preserved
                       "why did debt service increase"
```

**Why comparison is not merely a bigger retrieval here.** Comparing debt needs a
basis — per unit, per square foot, per dollar of value, per year of remaining
term — and that basis is a model nobody recorded. Change it and the answer
changes with no underlying fact having moved. *"4125's rate is high"* is not a
fact about 4125; it is the output of a comparison whose parameters were chosen,
and §38 requires it to render as a visibly different class naming its basis.

**The read seam already makes this structurally hard, and that is deliberate.**
`GET /operator/debt/standing` is scoped to the operator's own property, so there
is no cross-property surface to aggregate over. A portfolio comparison would need
a new read with a declared basis — not a wider filter on this one.

### Debt does not solve authorization-under-composition (§40.8)

Recorded as a known limitation rather than solved locally, per the ruling.

Debt's entitlement is **endpoint-level**: actor → server-derived property →
Asset Management module → this property's instruments. That holds at the door and
composes with nothing.

```text
"why is this deal underperforming?"
   → debt · insurance · payroll · maintenance · resident history, in one answer
```

Each domain individually entitled; the composed answer may still disclose what
none would alone. **Debt is one of the domains that composition will pull**, and
the read seam does nothing to prevent it. Flagged here so the eventual composition
boundary is not discovered by a Debt answer being the one that leaked.

### What Ask Spine receives — and does not

```text
canonical Debt history → standing projection → Ask Spine adapter → conversation
```

Not the binder, not OCR output, not a parser, not the schema. It computes no Debt
value. The envelope is an **interface**, not a second store.

---

## PART 3 — THE MINIMAL HISTORICAL SCHEMA

**Seven tables.** Conceptual shape, not final DDL.

```text
1  debt_instruments
   kind · loan_number · original_principal · currency · origination_date ·
   first_payment_date · provenance · source_artifact
   ⚠ currency NOT NULL, NO DEFAULT — the repo has no governed currency context,
     so Debt resolves it explicitly rather than inheriting USD by luck.

2  debt_instrument_parties                    APPEND-ONLY, POINTS BACKWARD
   instrument · role · legal_entity_id NULL · party_name_text NULL ·
   effective_from · supersedes_party_id NULL · source_artifact
   roles: borrower · guarantor · originator_lender · holder_assignee · servicer
   ⚠ FORCED: ORIX originated, Freddie Mac holds by assignment, Lument services.
   ⚠ Correction 3 — NO superseded_by. A later assignment inserts a new row that
     points BACKWARD; the earlier row is never rewritten.
   ⚠ Five guarantors are NATURAL PERSONS → party_name_text, attributed to the
     guaranty. The role exists because the table exists; build no guarantor
     workflow and no durable-person machinery.

3  debt_instrument_properties                 COLLATERAL
   instrument · property · lien_position · effective_from ·
   established_by_source_artifact
   ⚠ FORCED by ruling even with one property, and carries the evidence that
     established the link — never the loan's name ("LVL 4125").

4  debt_terms                                 APPEND-ONLY, POINTS BACKWARD
   instrument · effective_from · effective_to NULL · term_source ·
   rate_kind · fixed_rate · index · spread · floor · cap ·
   day_count_convention · payment_frequency · amortization_kind ·
   level_payment_amount NULL · maturity_date ·
   supersedes_term_id NULL · source_artifact

   ⚠ Correction 3 — effective_to is populated ONLY where the governing
     instrument itself established the end. The IO period legitimately carries
     2024-08-01 because the ORIGINAL instrument says so. A later amendment
     NEVER back-writes effective_to on an earlier row; it inserts a new row
     with supersedes_term_id, and "in force at as_of" is DERIVED from history.

   ⚠ Correction 4 — extension_standing REMOVED. 4125 forces no extension
     object. The standing read narrates "no option evidenced in reviewed
     governing source"; there is no canonical extension state field. Model a
     real extension object when a specimen produces an extension right or an
     exercise event.

   ⚠ Correction 5 — balloon_amount REMOVED. $24,716,182.48 is what the
     servicer's schedule PROJECTS assuming every payment occurs — a W8
     projection, not a contractual figure. What the instrument establishes is
     that the loan does not fully amortize and all remaining principal is due
     at maturity; that is carried by amortization_kind + maturity_date. The
     dollar figure is derived and lives in the proof fixture. Add a stored
     balloon amount only if an executed instrument states that exact number.

   ⚠ FORCED: the ORIGINAL instrument establishes TWO periods — IO through
     2024-08-01, then level $123,411.40. Two rows, both term_source=original.
   ⚠ day_count stored, never assumed: actual/360 drives every interest figure.
   ⚠ index/spread/floor/cap are PASSIVE representation only. Zero index-feed
     and zero rate-reset machinery. A cheap seam, not a subsystem.

5  debt_reserve_requirements                  APPEND-ONLY, POINTS BACKWARD
   instrument · reserve_kind · amount · basis · effective_from ·
   supersedes_requirement_id NULL · source_artifact
   kinds: tax_imposition · insurance_imposition · replacement · debt_service
   ⚠ FORCED: $1,763/mo replacement AND the $1,110,703 COVID-19 debt service
     reserve. A requirement is a row, not a Reserves & Escrows module.
   ⚠ NO BALANCE COLUMNS. Tax/insurance balances are those domains' funding truth.

6  debt_balance_observations                  APPEND-ONLY, NEVER UPDATED
   instrument · observed_balance · as_of_date · observation_source ·
   source_authority · source_artifact · recorded_by · recorded_at
   ⚠ PROJECTIONS ARE NOT STORED, here or anywhere. Necessary but not sufficient
     for W8 — the read-level proof still runs (⚠1).

7  debt_payment_observations                  APPEND-ONLY
   instrument · observed_as_of · period · amount_due · amount_received ·
   amount_remaining · applied_principal · applied_interest · applied_escrow ·
   applied_other · observation_source · source_authority · source_artifact

   ⚠ Correction 7 — renamed from debt_payments. This is the LENDER/SERVICER's
     observation of payment standing, not a cash-settlement primitive. The
     statement's own columns are AMT DUE / AMT RECEIVED / AMT REMAINING plus
     the application split, and that is exactly what this holds.

   ⚠ satisfies_requirement DROPPED. There is no canonical requirement row for
     the reference to mean — requirements are DERIVED from terms — and
     inventing one drags toward a payment engine.

   Preserves the four distinct facts:
       contractually due  ≠  cash left the bank  ≠  lender received  ≠  lender applied
```

### ⚠ Correction 6 — `debt_obligation_requirements` REMOVED

The prior design proposed a covenant/reporting category table with no threshold,
test-date, due-rule or compliance column. **That is a taxonomy table with no
operational consequence** — it cannot answer when a report is due, what covenant
applies, what is coming up, or whether we comply. It does not earn a canonical
table in Build 1, and creating it just to say the category is represented is
exactly the drift we said to refuse.

Covenant and reporting requirements remain a **named seam**. The source artifact
stays available. W5 still holds — and holds more cleanly, because there is now no
covenant object at all for a read to over-interpret.

Useful Debt standing and attention are fully served by:

```text
next payment · maturity · stale balance
```

### Derived, never stored

```text
position(instrument, as_of) · terms in force · party roles in force ·
projected balance · next requirement · payment standing · debt service figure ·
projected balloon at maturity
```

A materialised cache of any of these is acceptable later. **Canonical is history;
a projection is a disposable reading that can be rebuilt.**

### Not built — seams named, subsystems refused

```text
covenant / reporting objects   ⚠6 — named seam, no table
extension object               ⚠4 — model it when a specimen produces one
schedule publication table     pinned as a PROOF FIXTURE on the tax precedent
                               (philadelphia_tax_rules.js pins the City calendar
                               in code). Derivation reproduces all 120 rows.
reserve balances / draws       a reserve domain, later, forced by a 2nd specimen
index observations             no floating-rate instrument exists here
cross-collateral / supplemental affirmatively excluded by the Loan Agreement
```

---

## PART 4 — THE BUILD, AND ITS FENCES

```text
branch from clean main
→ migration 171
→ minimal canonical writers
→ real 4125 establishment
→ position(instrument, as_of)
→ 120-row derivation proof
→ W1–W9 DOMAIN falsification
```

```text
NOT   UI · document reader · generic proposal router · covenant engine ·
      reserve module · SOLO · Ask Spine implementation
```

### ⚠ Migration 171 cannot merge to `main`

Production ledger ceiling is **167**, and `prestart` verifies rather than applies.
**Merging a pending migration to `main` is a failed production deploy** — the trap
that has already cost time twice. 171 lands on a branch and stays there until a
deliberate release runs, with `EXPECTED_LEDGER_CEILING` read from the ledger
rather than typed from this document.
