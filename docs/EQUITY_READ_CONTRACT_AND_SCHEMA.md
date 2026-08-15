# Equity & Preferred Equity — Read Contract, Truth Walls, and Minimal Historical Schema

**2026-08-15. Design, drafted unattended against a 15-deal portfolio survey.**
**Specimen: 4125 Chestnut — the same property Debt is established against.**
**Not frozen. No owner correction pass has happened yet — read it that way.**

Everything here is forced by a 15-deal portfolio equity survey (two
SharePoint sites, real executed agreements, real trial balances, real
trackers) — **not committed to this repo**: it names real individual
investors and guarantors by name with real dollar amounts across the
portfolio, and that is a data-handling judgment for the deal's owner, not
something to check into version control unilaterally. It was delivered into
the session that drafted this document; ask for it directly if it is needed
again. Every quote used as a wall's specimen below is reproduced narrowly,
in place, specifically so this document does not itself depend on the
survey being available. Where a structure is *not* forced by that evidence,
it is named as a seam and explicitly left unbuilt, the same discipline Debt
used for Solo, Ask Spine, and the covenant engine.

## Why this domain reads differently from Debt before a single wall is stated

Debt had one governing party (Lument, as servicer) publishing one monthly
statement that mostly agreed with the loan documents. That let Debt's walls
be about **collapsing two real but distinct facts** (principal vs. payoff,
observed vs. projected). Equity does not have that luxury, and pretending
otherwise would be the confident-wrong failure mode this whole project exists
to refuse.

The survey's own words, verbatim, because paraphrasing would soften them:

> *"For no deal in this estate is that question answerable from recorded
> facts alone. Not one."*
>
> *"The cap table does not exist as a document at any deal. It exists as a
> promise that a document will be maintained elsewhere."*
>
> *"Nothing accrues in any general ledger, anywhere."*
>
> *"Every tracker that exists disagrees with its own governing document."*

So Equity's first job is not "record the cap table." It is **record what is
actually known, exactly as reliably as it is known, from exactly the source
that knows it — and make the size and shape of what is NOT known a first-class,
visible fact**, not a blank space nobody notices. §5 ("honest blank beats
confident wrong") is not a background principle for this domain. It is close
to the entire design problem.

---

## PART 1 — THE TRUTH WALLS

Ten walls, not nine — the eleventh candidate (three different things all
called "preferred equity") is a **vocabulary** problem, not a collapsing-two-
facts problem, and is handled in Part 3's type system instead of here.

### 1.1 The ten walls — Equity-layer declaration

```text
E1  GOVERNING SCHEDULE ≠ ACTUAL HOLDERS
    distinction  what an executed Schedule I / Exhibit A states vs. who
                 actually holds the interest today
    specimen     4125 Chestnut Holdings LLC Schedule I: "[OWNERSHIP/INVESTOR
                 INFORMATION MAINTAINED BY MANAGING MEMBER]" — 100% of the
                 $9,048,350 common tier, zero names
    equity proof position() returns NOT_ESTABLISHED for any holder the
                 governing schedule does not itself name. A tracker row or a
                 K-1 filename is never promoted to holder-of-record.

E2  TRACKER FIGURE ≠ GOVERNING-DOCUMENT FIGURE
    distinction  a rate, percentage or compounding convention recorded in an
                 operating spreadsheet vs. what the executed operating
                 agreement actually states
    specimen     4125: the MSC HoldCo Pay Schedule computes MONTHLY
                 compounding; Interest Holder OA §1.60 states QUARTERLY,
                 actual/360. Both real documents, both currently maintained,
                 disagreeing.
    equity proof both are stored as separate dated observations with
                 distinct source_authority (governed_read for the OA,
                 tracker_claim for the spreadsheet). position() never merges
                 them into one "the rate is X" — a caller sees both, dated,
                 attributed, disagreeing.

E3  ACCRUED PREFERRED RETURN ≠ BOOKED PREFERRED RETURN
    distinction  a contractual accrual formula existing vs. any dollar amount
                 actually computed and recorded anywhere
    specimen     4125 Trial Balance, Dec 2025: MSC is distinguished from
                 common equity by a bare "-01" GL suffix. No accrued-
                 preferred liability account exists at ANY surveyed deal.
    equity proof there is no accrued_balance column, anywhere in this
                 schema, and — unlike Debt's projected balance —
                 position() does NOT compute one from the stated rate and
                 convention either. Debt could safely derive a projection
                 because the day-count math was proven against 120 real
                 published rows from one authoritative source. Equity
                 cannot: at 4125 itself, the OA states quarterly
                 compounding and the servicer's own tracker computes
                 monthly, disagreeing at the SAME deal. Computing a number
                 from a disputed convention would be E2's confident-wrong
                 trap wearing E3's name. accrued_preferred_return is
                 always NOT_ESTABLISHED at the read layer for Build 1 —
                 the raw dated terms are exposed so a human (or Ask Spine,
                 later, explicitly not computing either) can read them,
                 never a Spine-computed figure presented as settled.

E4  CONTRIBUTED CAPITAL PER DOCUMENT ≠ PER BOOKS ≠ PER TRACKER
    distinction  three independent sources answering "how much was actually
                 contributed," routinely disagreeing, never reconciled
    specimen     Skyline GL `3110` ($1,006,580) vs. Exhibit A ($23,313) —
                 43×. Greenery QuickBooks ($3,701,824) vs. tracker
                 ($4,091,501) vs. Schedule I ($4,100,000) — $389,677
                 unexplained.
    equity proof each source's figure is its own dated, sourced observation.
                 position() never picks a winner and never averages. A
                 caller asking "how much was contributed" against
                 disagreeing sources gets all of them, each attributed —
                 not a synthesized number nobody actually stated.

E5  A MEMBER LOAN IS DEBT, EVEN WHEN FUNDED BY EQUITY HOLDERS
    distinction  a loan from a member to the entity is debt, structurally,
                 regardless of who sits on both sides of it
    specimen     Skyline's B-Note is held by the borrower's own equity and
                 managed by the borrower's own GP — the same two people sit
                 on both sides. 1850's entire recapitalization is an 18%
                 Member Loan senior to all equity. Greenery's own OA bars
                 member loans at the borrower while requiring them one tier
                 up.
    equity proof this schema carries no interest rate, no maturity, no lien
                 position, no payment schedule — Debt's shape, not Equity's.
                 A member loan cannot be entered as an equity position no
                 matter how it is funded or who is on the other end. Mirrors
                 the funding-boundary discipline that already keeps Capital
                 Stack from importing Tax or Insurance funding truth.

E6  THE SAME DOLLARS CAN BE DEBT IN ONE DOCUMENT AND EQUITY IN ANOTHER
    distinction  two governing sources can genuinely, currently disagree
                 about what KIND of fact a dollar amount is
    specimen     `1417 Note Purchase - Summary.docx`: "...re-contributed as
                 equity in Skyline Note Owner LLC." The Carlisle trial
                 balance, same dollars: `2525 Loan from Shafran $338,000` —
                 a liability, and $50 off the equity-side figure.
    equity proof this is not resolved by picking a side. Both
                 characterizations are recorded, each in its own domain's
                 shape, each with its own source — and the disagreement
                 itself is a visible fact this schema can hold, never
                 smoothed into one number.

E7  A DOCUMENTED TRANSFER ≠ A LATER SOURCE NAMING A DIFFERENT HOLDER
    distinction  an assignment executed under the OA's own transfer
                 provisions vs. a K-1 or distribution list that simply shows
                 someone else's name later, with no instrument behind it
    specimen     Skyline Minority's 2024 K-1s go to Aryeh Lightstone in the
                 slot Schedule I assigns to Joel Shafran. No assignment, no
                 GP consent, no amended schedule found anywhere. §10.2(b) of
                 the governing LPA: such transfers are "deemed void and of
                 no force or effect."
    equity proof a party row is superseded only by another party row citing
                 an actual transfer or assignment instrument. A K-1 or
                 tracker naming a different holder, with no assignment on
                 file, is recorded as a CONFLICT against the standing party
                 — visible to a reader — never a silent supersession.

E8  A SIDE LETTER OVERRIDES ONE HOLDER'S TERMS, NEVER THE DEAL'S WATERFALL
    distinction  the OA's stated distribution priority vs. one specific
                 holder's bespoke terms, agreed outside the OA and not
                 reflected in it
    specimen     the Lincoln side letter at Skyline Note Owner exempts that
                 one holder from the promote — counsel's own framing:
                 "consistent with how we've handled this in the past."
    equity proof waterfall and priority terms are attachable PER POSITION,
                 not only per deal. A side letter is its own dated term row
                 scoped to the one party it names, layered over — never
                 replacing — the deal-level terms every other holder reads.

E9  A PLEDGED INTEREST IS NOT AN UNENCUMBERED INTEREST
    distinction  who Exhibit A says holds an interest vs. whether that
                 interest currently sits as loan collateral
    specimen     Skyline Apartments GP LLC's interest, and the Retaining
                 Partners' interests, pledged to a lender, September 2025 —
                 changing "who holds what" for anyone relying on Exhibit A
                 alone.
    equity proof encumbrance is its own dated fact on a position row, never
                 inferred and never silently absent. "Who holds what" is
                 incomplete without it, and this schema has a place for it.

E10 A REDACTED OR UNRESOLVED SCHEDULE IS EXPOSURE, NEVER A GAP TO GUESS SHUT
    distinction  "Spine does not know who holds this, or how much" vs.
                 inventing or normalizing a plausible-looking cap table to
                 fill the blank
    specimen     4233 GP Holdco: 100% of the Class A preferred, zero names,
                 zero amounts by name. 1417 Note Owner's Schedule I lists
                 ONE member at $0 / 0.000% and then asserts
                 `TOTALS $1,550,000.00 / 100.000%`.
    equity proof this is CLAUDE.md's Exposure contract, not a table to
                 backfill: what, magnitude if known, why unresolved, what
                 resolves it, as-of, owner-or-UNASSIGNED. What is unknown is
                 recorded AS unknown. No synthesized holder list, ever.
```

### 1.2 What the eleventh candidate wall actually is — vocabulary, not a wall

The survey is explicit that *"preferred equity"* names three different real
shapes at different deals, and warns against blurring them:

```text
1  a preferred RETURN shared pro rata by all common holders — not a class,
   no separate holder (Skyline 7.5%, Greenery 7%, 4233 Holdings 8%)
2  a genuine preferred CLASS — its own holders, its own waterfall priority
   (4233's Class A, MSC at 4125, 100 Mile/Procida at 4240)
3  a stepped priority return with a paid/accrued split (Tower Place)
```

This is not two facts a reader could collapse into one — it is three
genuinely different economic shapes wearing the same English phrase. A wall
cannot fix a vocabulary problem; a type system can. See Part 3's
`position_kind` / `preferred_shape` design.

### 1.3 What the Equity harness must prove

Real Postgres, before any UI, before any conversation — same standard as
Debt's 17/17 schema falsification suite:

```text
E1–E10 each get a hostile fixture drawn from the ACTUAL survey text, not an
invented one, and an assertion that position() refuses to collapse the
distinction — including E3, E5 and E9, whose structural defenses (no
accrued-balance column, no debt-shaped columns, an encumbrance field that
must be explicitly populated) are narrowing the attack, never discharging
the proof. Same correction Debt's own doc had to apply to itself.
```

### 1.4 Deferred to the Ask Spine layer — NOT Equity's concern

Recorded so it is not lost, exactly as Debt's doc does:

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
structure is read as **every capital-stack entity tied to that property,
each carrying its own positions, as of a date**. The caller never needs to
already know an entity's name to ask about a property.

```text
INPUT    property_id · as_of

RESOLVES every equity_capital_entity in this property's ownership chain
         every equity_position in force at each entity, as_of
         each position's party (entity XOR attributed name — same rule as
           Debt's guarantors; reading an operating agreement never mints a
           durable Spine person, PHILOSOPHY §12)
         each position's preferred/common shape and terms IN FORCE at as_of
         every open conflict on that position (E4, E6, E7) — never silently
           dropped in favor of one source
         every Exposure item (E10) for what this property's structure could
           not establish

RETURNS  every value with: value | truth_state · source_authority · as_of ·
         (conflict: [ ... other sourced claims ], when one exists)
```

### The standing projection (§40.6)

```text
property               which deal, which capital-stack entities exist
positions               N rows: holder (or NOT_ESTABLISHED) · common/
                        preferred · contribution (per source, may disagree)
                       · preferred terms in force, if any · encumbrance
preferred obligations   rate · convention · compounding — AS STATED, per
                        source, never merged
accrual                 NOT_ESTABLISHED unless an authoritative accrual
                        observation exists — which, portfolio-wide, it
                        currently never does
open conflicts          E4/E6/E7-shaped: two sources, same fact, disagreeing
exposure                E10-shaped: redacted schedules, unresolved amounts,
                        unresolved identity, each with the 6-part contract
important unknowns      including "no governing document located" per §5's
                        source-scoped Definition of Done, distinct from
                        "governing document located and it says nothing"
```

On 4125 today, EVERY common holder is `NOT_ESTABLISHED` by name (E1/E10) and
the MSC accrual is `NOT_ESTABLISHED` by amount (E3) even though the MSC
*position itself* — holder, rate structure, redemption date, Make-Whole
formula — is unusually well governed. **Both of those are correct output for
the same property**, and a reader must be able to tell them apart at a
glance: known structure, unknown number, for one holder; unknown structure
AND unknown holders, for the other 77.57%.

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

Equity claims **less** than Debt did at the same build stage, on purpose.
Debt could claim retrieval broadly because 4125's loan is well-governed by
one clean source. Equity's own specimen property shows a well-governed
preferred position sitting beside a completely undocumented common tier —
claiming broad retrieval here would misrepresent the domain's actual
reliability, which is exactly what §40.10 exists to prevent.

### Equity does not solve authorization-under-composition (§40.8)

Same unsolved status Debt recorded, inherited rather than re-litigated:
endpoint-level entitlement, composes with nothing yet. Equity is a domain
composition will eventually pull into a cross-domain answer just as readily
as Debt is — flagged here so it isn't discovered by an Equity answer being
the one that leaks.

### What Ask Spine receives — and does not

```text
canonical Equity history → standing projection → Ask Spine adapter → conversation
```

Not the operating agreements, not the trackers, not a summarization of the
survey. It computes no Equity value and reconciles no conflict — reconciling
E4/E6/E7's conflicts is a human decision (whose owner, per the Exposure
contract, may currently be `UNASSIGNED`), never a model's.

---

## PART 3 — THE MINIMAL HISTORICAL SCHEMA (sketch — migration is authoritative)

### The type system that resolves §1.2's vocabulary problem

```text
equity_capital_entities.entity_kind
    tic_interest | llc_membership | lp_interest | condo_interest |
    other

equity_positions.position_kind
    common | preferred_class

equity_preferred_terms  (zero, one, or more rows PER position)
    attached to a `common` position     → shape 1: a preferred RETURN
                                           shared pro rata by that same
                                           holder. No separate party — the
                                           common holder and the pref-return
                                           holder are the same position.
    attached to a `preferred_class`     → shape 2: a genuine class. Its own
    position                              party, its own waterfall priority,
                                           independently redeemable/callable.
    multiple rows, one position,        → shape 3: a stepped priority
    different effective_from              return (Tower Place's paid/
                                           accrued split) — the SAME kind of
                                           fact as shape 1 or 2, just more
                                           than one dated row in force
                                           across the position's life.
```

Three shapes, two `position_kind` values — shape 3 was never a third kind of
position, only a position with more than one dated terms row, which the
append-only `equity_preferred_terms` table already had to support anyway
(E2, E8). No redundant enum value.

This is the direct fix for §1.2: "preferred return" and "preferred class"
are never the same column with different values, because collapsing them is
exactly the blur the survey warned against.

### Tables, at the level Debt's own doc sketched before its migration

```text
equity_capital_entities     one row per tier in a property's ownership chain
                            (property_id · entity_kind · legal_entity_id ·
                            effective_from/to · source_artifact_id)

equity_positions            one row per holder-at-an-entity, append-only,
                            effective-dated, points backward on transfer —
                            same supersedes_*_id / no superseded_by
                            discipline as Debt. party is entity XOR
                            attributed name (E1, E7).

equity_preferred_terms      rate · convention (E2) · waterfall priority ·
                            redemption/call terms · make-whole, if any —
                            effective-dated, one row per SIDE LETTER (E8)
                            layered over the deal-level row it doesn't
                            replace

equity_contribution_claims  APPEND-ONLY, one row per SOURCE's claim of an
                            amount (E4) — never one "contributed_amount"
                            column. Governed source, GL source, tracker
                            source are three rows, not a reconciliation.

equity_conflicts            structural home for E6/E7 — two claims, same
                            fact, disagreeing, both retained, neither
                            deleted to make room for the other

equity_exposure             E10's six-part contract, structural — this is
                            the ONLY table in Capital Stack, so far, that
                            exists expressly to hold what Spine cannot yet
                            stand behind, rather than what it can
```

**⚠ Deliberately absent, same discipline as Debt's `debt_obligation_
requirements` removal:** no `accrued_balance` column anywhere (E3). No
`current_ownership_percent` column anywhere (E1/E10 — a percentage implies a
100% base that is, at most surveyed deals, not itself established). No
member-loan/debt-shaped columns (E5).

### Not built — seams named, subsystems refused

```text
NOT   the full recursive N-tier entity graph as a generalized structure —
      equity_capital_entities is flat, one row per named tier, not a
      generalized company-structure engine. Deep enough for 4125's four
      tiers because they're each named; not a graph database.
NOT   UI · waterfall distribution CALCULATOR (recording the terms is in
      scope; computing what a capital event pays out is not) · document
      reader · reconciliation engine for E4/E6/E7's conflicts · Ask Spine
      implementation · SOLO
```

---

## PART 4 — THE BUILD, AND ITS FENCES

```text
branch from clean main
→ migration (schema)
→ minimal canonical writers
→ real 4125 establishment — MSC's position fully, common tier as
  E1/E10 Exposure, not fabricated
→ position(property_id, as_of)
→ E1–E10 hostile falsification proofs, against real survey specimens
```

```text
NOT   distribution waterfall calculation · document reader · reconciliation
      of any E4/E6/E7 conflict · covenant-style compliance engine ·
      generalized entity graph · SOLO · Ask Spine implementation
```

### This document is unfrozen

Debt's contract went through seven owner corrections before it froze. This
one has had zero — it was drafted end-to-end from the survey without a
review pass, while unattended, against explicit instructions to build. Read
every wall above as a strong first draft forced by real evidence, not as
settled the way Debt's nine were by the time Debt's schema shipped. The
build proceeds under it regardless, because the alternative — waiting rather
than building the narrowest real slice this evidence supports — is its own
kind of failure for this repo, but a correction pass belongs on the first
read this gets from a human.
