# Equity & Preferred Equity — Read Contract, Truth Walls, and Minimal Historical Schema

**2026-08-15. Round 4 — five structural rulings frozen, one deliberately not.**
**Specimen: 4125 Chestnut — the same property Debt is established against.**
**Migration 174 is released to production. The HTTP route and the Capital**
**Stack UI (split into Preferred Equity / Common Equity compartments) are**
**live. Real establishment for any property is still blocked — see**
**`docs/THREAD_HANDOFF.md`'s Equity banner for exactly why.**

Everything here is forced by a 15-deal portfolio equity survey (two
SharePoint sites, real executed agreements, real trial balances, real
trackers) — **not committed to this repo**: it names real individual
investors and guarantors by name with real dollar amounts across the
portfolio, and that is a data-handling judgment for the deal's owner, not
something to check into version control unilaterally. It was delivered into
the session that drafted this document; ask for it directly if it is needed
again. Every quote used as a wall's specimen below is reproduced narrowly,
in place, specifically so this document does not itself depend on the
survey being available.

## What changed between the first draft and this one

The first draft (Build 1) shipped a schema, writers, a reader, an HTTP
route and Ask Spine registration in one unattended pass, then went through
**four owner correction rounds** before anything froze. That is the normal
shape of a real design conversation working against real evidence, not a
failure of the first draft — Debt's own contract took seven corrections.
What changed, round by round:

```text
ROUND 1   classification pass over the first draft's own weak spots —
          confirmed the model was one level too generic: "preferred
          equity" was being treated as one shape when the survey shows
          three, and Common/Preferred were sharing one position table
          in a way that blurred rather than clarified.

ROUND 2   tried the theoretically clean fix — split Common and
          Preferred into separate BASE tables entirely.

ROUND 3   reversed Round 2: "I was pushing too hard toward a
          theoretically clean split." One holder-at-an-issuer is one
          KIND of fact regardless of what it holds. Common and
          Preferred stay ONE shared identity table, with separate
          economics tables underneath — never a second base table.
          This round also withdrew two tables the first draft had
          built (capital_stack_evidence, capital_stack_exposure) as
          premature generalization, and narrowed "contribution
          claims"/"capital movements" to the more honest "capital
          amount claims" — this domain has no evidence of individual
          cash movements anywhere, only period totals a source states.

ROUND 4   froze five structural rulings against a targeted document-
          falsification pass (see below) and deliberately left ONE
          piece open: MSC's Minimum Dividend relationship to its
          preferred return, pending a real read of OA §1.49.
```

## The five frozen structural rulings

```text
1  ONE SHARED IDENTITY. capital_stack_positions is a single table —
   holder, issuer, effective period — for BOTH Common and Preferred.
   position_class is an identity TAG, not a base-table split. Separate
   ECONOMIC READINGS (common_equity_class_terms / common_equity_
   position_overrides / preferred_equity_terms) live underneath it.

2  ENTITY/WATERFALL, NOT PER-HOLDER. A pro-rata preferred return AND a
   deal's default waterfall priority belong to the ISSUER — Skyline's
   7.5%, Greenery's 7%, the Skyline deal's 65/35 GP split — recorded
   ONCE in common_equity_class_terms, never duplicated onto each
   common holder's own position.

3  AN UNEXECUTED OVERRIDE IS SURFACED, NEVER APPLIED. The Lincoln side
   letter at Skyline Note Owner is real, dated, and sourced the moment
   it is written down — and it is ALSO, per the survey, still counsel's
   draft with no signature found anywhere. common_equity_position_
   overrides.execution_status carries this exactly, and
   equity_position_read.js refuses to apply anything not 'executed' to
   the current economic read, while still returning it.

4  STEPPED MECHANICS ARE REAL; TOWER'S NUMBERS ARE NOT YET GOVERNED.
   preferred_equity_terms carries current_pay_rate_bp and accrued_
   rate_bp as two separate columns because Tower Place proves a
   preferred position can genuinely pay one rate while a different
   rate accrues. Tower's own specific figures (the survey's paraphrased
   "4/4 → 6/2") are not written into this schema or any fixture — the
   columns exist for the SHAPE; the FIGURES wait on the governing
   document.

5  (Carried from Round 3, reaffirmed) NO capital_stack_evidence table,
   NO capital_stack_exposure table. One source-backed observation per
   row is disciplined enough at this scale; coverage gaps are DERIVED
   by the reader from what is absent, never separately authored.
```

## The one deliberately unfrozen piece — MSC's Minimum Dividend

MSC's 12.5% preferred return at 4125 is unusually well governed — Interest
Holder OA §1.60 and §1.42 state it directly, and `current_pay_rate_bp` on
that position's `governed_read` row carries it. The survey **separately
paraphrases** a "Minimum Dividend" schedule stepping 8% → 9% → 10% → 11% →
12% → 12.5% — but only paraphrases it. The actual governing clause is OA
**§1.49**, and it has not been read. Whether the Minimum Dividend is
**additive** to the 12.5%, an **offset** against it, or something else
entirely is genuinely unknown from what has been read so far.

`preferred_equity_terms.minimum_dividend_relationship_to_preferred_return`
exists to hold exactly that unknown, and defaults to `'not_established'` in
the schema itself — a caller may only move it to `additive` / `offset` /
`other` once §1.49 itself has been read, never from the survey's paraphrase,
however specific that paraphrase reads. This is §38 applied at the first
schema conversation: a recorded fact (12.5%, from the OA) and a derived
attribution (what the Minimum Dividend *does* to it) are different kinds of
thing, and only the first is governed here. The model this domain must be
able to truthfully render, and now can:

```text
MSC Return                 12.5% — established (governed_read)
Minimum Dividend schedule  8% → 9% → 10% → 11% → 12% → 12.5% — observed
                           from the survey, source clause (§1.49) pending
Relationship between them  NOT ESTABLISHED
Accrued preferred balance  NOT ESTABLISHED
```

---

## PART 1 — THE TRUTH WALLS

Ten walls, not nine — the eleventh candidate (three different things all
called "preferred equity") turned out to be a **vocabulary** problem, not a
collapsing-two-facts problem, resolved by Round 4's shared-identity
structure rather than by a wall (see Part 1.2).

### 1.1 The ten walls — Equity-layer declaration

```text
E1  GOVERNING SCHEDULE ≠ ACTUAL HOLDERS
    distinction  what an executed Schedule I / Exhibit A states vs. who
                 actually holds the interest today
    specimen     4125 Chestnut Holdings LLC Schedule I: "[OWNERSHIP/INVESTOR
                 INFORMATION MAINTAINED BY MANAGING MEMBER]" — 100% of the
                 $9,048,350 common tier, zero names
    equity proof position() returns a holder only if a capital_stack_
                 positions row names them. Holdings LLC's own common tier
                 carries governed pro-rata terms (common_equity_class_
                 terms) but zero position rows — read back as a DERIVED
                 coverage_gaps entry, never an inferred name.

E2  TRACKER FIGURE ≠ GOVERNING-DOCUMENT FIGURE
    distinction  a rate, percentage or compounding convention recorded in an
                 operating spreadsheet vs. what the executed operating
                 agreement actually states
    specimen     4125: the MSC HoldCo Pay Schedule computes MONTHLY
                 compounding; Interest Holder OA §1.60 states QUARTERLY,
                 actual/360. Both real documents, both currently maintained,
                 disagreeing.
    equity proof both are stored as separate dated rows in preferred_
                 equity_terms with distinct source_authority (governed_read
                 for the OA, tracker_claim for the spreadsheet). position()
                 never merges them into one "the rate is X" — a caller sees
                 both, dated, attributed, disagreeing.

E3  ACCRUED PREFERRED RETURN ≠ BOOKED PREFERRED RETURN
    distinction  a contractual accrual formula existing vs. any dollar amount
                 actually computed and recorded anywhere
    specimen     4125 Trial Balance, Dec 2025: MSC is distinguished from
                 common equity by a bare "-01" GL suffix. No accrued-
                 preferred liability account exists at ANY surveyed deal.
    equity proof there is no accrued_balance column, anywhere in this
                 schema, and position() does NOT compute one from
                 current_pay_rate_bp, accrued_rate_bp, or a Minimum
                 Dividend schedule — unconditionally, for every preferred
                 position. accrued_preferred_return is always
                 NOT_ESTABLISHED at the read layer for Build 1.

E4  CONTRIBUTED CAPITAL PER DOCUMENT ≠ PER BOOKS ≠ PER TRACKER
    distinction  independent sources answering "how much was actually
                 contributed" or "what percentage is held," routinely
                 disagreeing, never reconciled — and kept as TWO different
                 kinds of claim, never merged into one row even when the
                 same source states both
    specimen     Skyline GL `3110` ($1,006,580) vs. Exhibit A ($23,313) —
                 43×. A verbal internal estimate ("their interest plus
                 preferred accrual is about $3.7MM") that the first draft
                 mislabeled as a tracker claim for lack of anywhere else to
                 put it.
    equity proof capital_amount_claims carries EXACTLY ONE of amount_cents
                 or ownership_percent per row, one row per source's claim,
                 including claim_source = 'internal_note' with an
                 asserted_by_text naming who said it. position() never
                 picks a winner and never averages.

E5  A MEMBER LOAN IS DEBT, EVEN WHEN FUNDED BY EQUITY HOLDERS
    distinction  a loan from a member to the entity is debt, structurally,
                 regardless of who sits on both sides of it
    specimen     Skyline's B-Note is held by the borrower's own equity and
                 managed by the borrower's own GP. 1850's entire
                 recapitalization is an 18% Member Loan senior to all
                 equity.
    equity proof this schema carries no interest rate, no maturity, no lien
                 position, no payment schedule — Debt's shape, not Equity's.
                 A member loan cannot be entered as an equity position no
                 matter how it is funded or who is on the other end.

E6  THE SAME DOLLARS CAN BE DEBT IN ONE DOCUMENT AND EQUITY IN ANOTHER
    distinction  two governing sources can genuinely, currently disagree
                 about what KIND of fact a dollar amount is
    specimen     `1417 Note Purchase - Summary.docx`: "...re-contributed as
                 equity in Skyline Note Owner LLC." The Carlisle trial
                 balance, same dollars: `2525 Loan from Shafran $338,000` —
                 a liability, and $50 off the equity-side figure.
    equity proof capital_stack_conflicts holds both characterizations, each
                 with its own source — never resolved by picking a side.

E7  A DOCUMENTED TRANSFER ≠ A LATER SOURCE NAMING A DIFFERENT HOLDER
    distinction  an assignment executed under the OA's own transfer
                 provisions vs. a K-1 or distribution list that simply shows
                 someone else's name later, with no instrument behind it
    specimen     Skyline Minority's 2024 K-1s go to Aryeh Lightstone in the
                 slot Schedule I assigns to Joel Shafran. §10.2(b) of the
                 governing LPA: such transfers are "deemed void and of no
                 force or effect."
    equity proof a capital_stack_positions row is superseded only by
                 another position row citing an actual transfer or
                 assignment instrument. A K-1 or tracker naming a
                 different holder, with no assignment on file, is recorded
                 as a capital_stack_conflicts row — visible, never a
                 silent supersession.

E8  A SIDE LETTER OVERRIDES ONE HOLDER'S TERMS, NEVER THE DEAL'S WATERFALL
    distinction  the deal's default waterfall priority vs. one specific
                 holder's bespoke terms, agreed outside the OA and not
                 reflected in it
    specimen     the Lincoln side letter at Skyline Note Owner exempts that
                 one holder from the promote — counsel's own framing:
                 "consistent with how we've handled this in the past," with
                 no execution found.
    equity proof (Ruling 2 + Ruling 3) the deal-level default lives ONCE in
                 common_equity_class_terms, issuer-scoped. Lincoln's
                 override lives in common_equity_position_overrides,
                 position-scoped, carrying execution_status — layered over
                 the class default, never replacing it, and APPLIED only
                 when execution_status = 'executed'.

E9  A PLEDGED INTEREST IS NOT AN UNENCUMBERED INTEREST
    distinction  who Exhibit A says holds an interest vs. whether that
                 interest currently sits as loan collateral
    specimen     Skyline Apartments GP LLC's interest, and the Retaining
                 Partners' interests, pledged to a lender, September 2025.
    equity proof encumbrance is its own dated fact (capital_stack_pledges)
                 on a position row, never inferred and never silently
                 absent.

E10 A REDACTED OR UNRESOLVED SCHEDULE IS A COVERAGE GAP, NEVER A GUESS
    distinction  "Spine does not know who holds this, or how much" vs.
                 inventing or normalizing a plausible-looking cap table to
                 fill the blank
    specimen     4233 GP Holdco: 100% of the Class A preferred, zero names,
                 zero amounts by name. 1417 Note Owner's Schedule I lists
                 ONE member at $0 / 0.000% and then asserts
                 `TOTALS $1,550,000.00 / 100.000%`.
    equity proof (Round 3) there is no exposure table to backfill. What is
                 unknown is DERIVED at read time from what the rest of the
                 schema actually holds — an issuer with class terms and no
                 named holder, a named holder with no ownership_percent
                 claim, a preferred position with a Minimum-Dividend-shaped
                 field left not_established — never a hand-authored row
                 that can drift from the truth underneath it.
```

### 1.2 What the eleventh candidate wall actually was — resolved structurally, not by a wall

The survey is explicit that *"preferred equity"* names three different real
shapes at different deals:

```text
1  a preferred RETURN shared pro rata by all common holders — not a class,
   no separate holder (Skyline 7.5%, Greenery 7%, 4233 Holdings 8%)
2  a genuine preferred CLASS — its own holders, its own waterfall priority
   (4233's Class A, MSC at 4125, 100 Mile/Procida at 4240)
3  a stepped priority return with a paid/accrued split (Tower Place)
```

Round 4 resolved this without a wall: shape 1 is `common_equity_class_terms`
(issuer-scoped, attaches to nothing but the issuer itself); shape 2 is a
`capital_stack_positions` row with `position_class = 'preferred'` carrying
its own `preferred_equity_terms`; shape 3 is the SAME table as shape 2, with
`current_pay_rate_bp` and `accrued_rate_bp` populated as two distinct
columns rather than one. Three shapes, two structures — never the same
column wearing three meanings.

### 1.3 What the Equity harness proves

Real Postgres, before any UI, before any conversation — 46/46 in
`tests/equity_position_falsification.db.js`, covering E1–E10 AND the five
Round-4 rulings against real survey specimens, including hostile fixtures
that assert the schema itself refuses to store a collapsed distinction (an
`'executed'` override with no execution date; a capital amount claim
stating both an amount and a percentage in one row).

### 1.4 Deferred to the Ask Spine layer — NOT Equity's concern

```text
E1   "who actually owns this deal"
E3   "what do we owe MSC" · "what's the preferred balance"
E4   "how much has been contributed"
E7   "did that transfer go through"
E10  "who's the missing 62 investors"
```

Equity does not learn these. Ask Spine proves, later, that ordinary language
asking them does not quietly collapse a distinction Equity already holds —
most of all E3 and E10, which are exactly the two an eager conversational
layer would be tempted to answer with a plausible-sounding number.

---

## PART 2 — THE READ CONTRACT

### `position(property_id, as_of)`

Property-scoped, not instrument-scoped — Equity has no single governing
document the way one loan agreement anchors Debt. A property's capital
structure is read as **every capital_stack_positions row tied to that
property, each carrying its own class/preferred economics, as of a date**.

```text
INPUT    property_id · as_of

RESOLVES every capital_stack_positions row in force at as_of — the shared
           identity, common and preferred alike
         for a COMMON position: the issuer's class terms (pro-rata
           preferred return, default waterfall) and any holder-specific
           overrides, split into applied (execution_status = 'executed')
           and surfaced_not_applied (everything else, with why)
         for a PREFERRED position: every in-force preferred_equity_terms
           row, each with its own source_authority — never merged
         every capital amount claim (E4), amount and ownership_percent
           kept as separate lists, never merged
         every open conflict (E6, E7) — never silently dropped in favor
           of one source
         every DERIVED coverage gap (E1, E10) — computed from the same
           rows above, never a stored Exposure item

RETURNS  every value with: value | truth_state · source_authority · as_of ·
         (conflict: [ ... other sourced claims ], when one exists)
```

### The standing projection (§40.6)

```text
property               which deal, which capital-stack positions exist
positions               N rows: shared identity (holder · issuer ·
                        position_class) · capital amounts (per source,
                        may disagree) · encumbrance
common economics        issuer class terms (rate · waterfall, AS STATED,
                        never merged) · overrides, applied vs. surfaced
preferred economics     current-pay and accrued rate, AS STATED, per
                        source · Minimum-Dividend-shaped fields, left
                        NOT_ESTABLISHED unless a governing-document read
                        has changed them
accrual                 NOT_ESTABLISHED, unconditionally, for Build 1
open conflicts           E4/E6/E7-shaped: two sources, same fact, disagreeing
coverage gaps            DERIVED: unnamed tiers, unrecorded ownership
                        percentages, unresolved Minimum-Dividend-shaped
                        relationships — never a hand-authored row
important unknowns      including "no governing document located" per §5's
                        source-scoped Definition of Done, distinct from
                        "governing document located and it says nothing"
```

On 4125 today, MSC's *position itself* — holder, rate structure,
redemption date, Make-Whole formula — is unusually well governed, while
Holdings LLC's own common tier (one level up the chain) has no named
holder at all. **Both are correct output for the same property**, and a
reader must be able to tell them apart at a glance.

### Capability classes Equity Build 1 claims

```text
RETRIEVAL              CLAIMED, narrowly
                       "who is on record as holding equity here" ·
                       "what does the governing document say the preferred
                       rate is" · "what is currently unresolved"

COMPARISON             NOT CLAIMED
                       "is this deal's preferred rate high" · "compare
                       equity structures across the portfolio" — no basis
                       for comparison was recorded, and a stated rate isn't
                       even single-valued at most deals (E2)

CAUSAL EXPLANATION     NOT CLAIMED
                       "why did MSC's position increase" — no accrual is
                       ever booked (E3), so there is no recorded number to
                       explain a change in
```

### Equity does not solve authorization-under-composition (§40.8)

Same unsolved status Debt recorded, inherited rather than re-litigated.

### What Ask Spine receives — and does not

```text
canonical Equity history → standing projection → Ask Spine adapter → conversation
```

Not the operating agreements, not the trackers, not a summarization of the
survey. It computes no Equity value and reconciles no conflict.

---

## PART 3 — THE MINIMAL HISTORICAL SCHEMA (sketch — migration is authoritative)

### Tables

```text
capital_stack_positions          ONE SHARED IDENTITY (Ruling 1). One row
                                 per holder-at-an-issuer, property-scoped,
                                 append-only, effective-dated, points
                                 backward on transfer. position_class
                                 ('common'|'preferred') is an identity tag,
                                 not a table split. Holder is a legal
                                 entity XOR an attributed name (E1, E7).
                                 There is no separate entities table and
                                 no tier_order column — a tier is just
                                 another position row whose holder becomes
                                 the next row's issuer; the chain is data.

common_equity_class_terms        ISSUER-SCOPED (Ruling 2). Pro-rata
                                 preferred return AND default waterfall
                                 priority, once per issuer, never
                                 duplicated per holder.

common_equity_position_overrides POSITION-SCOPED (Ruling 3), the opposite
                                 scope from the table above. A side letter
                                 overriding ONE holder, carrying
                                 execution_status — the reader applies it
                                 only when 'executed'.

preferred_equity_terms           POSITION-SCOPED, preferred positions only.
                                 current_pay_rate_bp / accrued_rate_bp as
                                 two columns (Ruling 4 — Tower's shape, not
                                 Tower's numbers). minimum_dividend_
                                 schedule_text / minimum_dividend_
                                 relationship_to_preferred_return for MSC's
                                 shape, defaulting to not_established (the
                                 deliberately unfrozen piece).

capital_amount_claims            APPEND-ONLY, one row per SOURCE's claim of
                                 EITHER an amount OR an ownership
                                 percentage (E4) — never one column, never
                                 both in one row. claim_source includes
                                 'internal_note' with asserted_by_text.

capital_stack_pledges            E9 — a dated fact, never a column on the
                                 position.

capital_stack_conflicts          E6/E7 — two claims, same fact, disagreeing,
                                 both retained, kept as a durable table
                                 (Round 3) rather than a UI state.
```

**⚠ Deliberately absent:** no `accrued_balance` column anywhere (E3). No
member-loan/debt-shaped column anywhere (E5). No `capital_stack_evidence`
shared-provenance table (Round 3 — one source-backed observation per row is
disciplined enough until real cases prove otherwise). No
`capital_stack_exposure` table (Round 3 — coverage gaps are derived, never
separately authored).

### Not built — seams named, subsystems refused

```text
NOT   the full recursive N-tier entity graph as a generalized structure —
      the chain is flat, position-by-position, not a graph database.
NOT   waterfall distribution CALCULATOR (recording the terms is in scope;
      computing what a capital event pays out is not) · document reader ·
      reconciliation engine for E4/E6/E7's conflicts · Ask Spine gathering
      (registry entry exists; see docs/THREAD_HANDOFF.md) · SOLO
NOT   real establishment for any property — the schema, route and UI are
      live; establishing real data still requires real retained
      governing documents, which do not exist in production yet
```

---

## PART 4 — THE BUILD, AND ITS FENCES

```text
branch from clean main
→ migration (schema) — RELEASED to production
→ minimal canonical writers
→ real 4125 + Skyline establishment — proving all five Round-4 rulings
  against real survey specimens (TEST fixtures only — no real 4125 data
  has been established in production)
→ position(property_id, as_of)
→ E1–E10 hostile falsification proofs, against real survey specimens —
  46/46 against real Postgres
→ HTTP route (GET /operator/equity/standing) — LIVE
→ Capital Stack UI, split into Preferred Equity / Common Equity
  compartments — LIVE, browser-verified
```

```text
NOT   distribution waterfall calculation · document reader · reconciliation
      of any E4/E6/E7 conflict · covenant-style compliance engine ·
      generalized entity graph · SOLO · Ask Spine gathering ·
      real establishment for any property
```

### This document is now under Round 4's freeze — with one exception

Five structural rulings above are frozen and should not be re-litigated
without new evidence. MSC's Minimum Dividend relationship is deliberately
NOT frozen and stays `not_established` in both schema and every fixture
until OA §1.49 itself — not the survey's paraphrase of it — has been read.
The schema, route and UI are live; that is not permission to establish
real data from anything short of the real governing documents.
