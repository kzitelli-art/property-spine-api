# Slice 10 → Forward NOI — transition handoff

**Slice 10 is an as-of-dated contractual-position engine. It answers the
governed leasing and contractual-rent position for one selected date.**

It is **not** a complete forward projection, and nothing in this document should
be read as claiming it is.

**Status of every forward-looking proposal below: EXPLORATORY.** Not an owner
ruling, not an accounting policy, not an implementation contract. The record of
what Slice 10 *actually does* is the exception — that part is measured from the
implementation and is stated as fact.

---

## 1 — The three framings, kept apart

```
In-place rent roll     today's contractual position
Slice 10               ANY selected date's governed contractual position
Forward projection     a series across dates, with explicit assumptions
                       filling contractual gaps
```

Slice 10 is the second. The name "Forward Rent Roll" invites a reader to expect
the third, and that gap is the single most likely source of future
misunderstanding. **"Forward NOI" would compound it**, because that phrase reads
as the third to nearly everyone, and Slice 10 can only ever supply the second.

Where precision matters, prefer **dated contractual position** for what exists,
and reserve *forward* for anything that explicitly carries assumptions.

---

## 2 — What Slice 10 provides

Recorded from the implementation, not from a description of it.
Source: `src/tenancy/dated_position_rows.js`,
`src/tenancy/forward_rent_roll_summary.js`, `src/tenancy/forward_rent_roll_page.js`.

```
one row per leaseable space              one row per spaces.id
space → unit → property lineage          spaces has no property_id; the join is
                                         always through units
current and admitted future terms        governing_lease_id · successor_lease_id
                                         · successor_state
term dates                               governing_lease_end
selected-date occupancy position         occupancy · position_state (17 states)
dated base-rent authority                a single applicable base_rent for the
                                         selected month
dated concession credits                 concession_credit, negative by check
                                         constraint, netted against base
dated fee waivers                        fee_waiver, same treatment
qualified legacy rent                    leases.rent + legacy_qualification
missing authority                        rent_authority = missing
conflicting authority                    rent_authority = conflict ·
                                         conflicting_lease_ids
uncovered notice and vacancy             carried among the 17 position states ·
                                         possession_outstanding ·
                                         possession_without_current_lease
non-revenue inventory                    denominator_class = non_revenue
                                         (revenue = residential, commercial)
source lineage                           rent_lineage carries schedule_id,
                                         line_id, line_type, effective_month,
                                         application_id, source_offer_id
```

### The four authority states

```
dated_economic_line    a dated lease_economic_lines row governs the month.
                       The strongest rail. Fully attributable through lineage.

legacy_lease_rent      leases.rent, an undated number. QUALIFIED — trustworthy
                       only in the month the lease starts, because a dated step
                       would live in a schedule this lease does not have. Beyond
                       that it is returned and labelled beyond_provable_period.
                       It is NOT a peer authority to the dated rail.

missing                no governed amount reaches this position on this date.

conflict               more than one base rent applies in the month, or
                       incompatible leases cover the date. NO amount is selected.
```

**A missing or conflicting amount remains withheld. It is not estimated.**

The same discipline governs the summary: `dated_authority_subtotal` and
`qualified_legacy_subtotal` are reported **separately** from `combined_total`,
and a total containing legacy amounts discloses that it is not an entirely
dated-authority total. The occupancy rate is withheld — never computed —
whenever any blocker exists.

`units.market_rent` is **never read**.

---

## 3 — What Slice 10 does not provide

```
a multi-period forecast          cash collections
bad debt                         vacancy assumptions
renewal probability              market rent for unleased space
late-fee forecasts               other non-lease revenue
operating expenses               NOI
valuation                        accounting recognition
period close
```

None of these exists anywhere in the repository. `money_events` and
`ledger_entries` are present and empty.

---

## 4 — Recurring and one-time fees

Recorded as the implementation currently behaves.

```
recurring_fee    present in contractual lineage
                 DELIBERATELY EXCLUDED from the monthly contract-rent total

one_time_fee     present in lineage where applicable
                 EXCLUDED from a monthly position total
```

The engine comments the choice at the point it is made: *"recurring_fee and
one_time_fee are deliberately not monthly contract rent."* Both are visible;
neither is totalled.

`one_time_fee` being outside a *monthly* rail is a grain argument — a one-time
charge belongs to a period, not to a monthly position — and is unlikely to be
revisited. `recurring_fee` is a definition question, and it is open:

> **Owner question, carried forward and deliberately unanswered.** Should
> recurring lease charges such as parking and pet rent become part of a broader
> contractual-revenue total outside the base-rent roll?

This is a question about what "rent" means, not a data gap. The amounts are
already recorded and already lineage-bound.

---

## 5 — Reconciliation state

`lease_economic_lines` already carries:

```
reconciliation_state   not_yet_due · posted_and_matched · partially_matched ·
                       reversed_or_superseded · in_exception
matched_actual_ref     text
```

**Slice 10 does not read either.** Verified: zero occurrences of
`reconciliation_state` in the row engine.

Classify this as **existing but unused accounting-reconciliation vocabulary**.

It is *unread*, not *missing* — a meaningful difference when scoping later work.
But it is **not** a finished scheduled-versus-actual bridge: nothing writes the
states in a governed path, nothing reconciles against them, and no consumer
depends on them. Treat it as a vocabulary that already exists and would need
governing, not as a component that already works.

---

## 6 — Proposed transition sequence

```
Dated contractual position
  → Forward contractual-revenue series
    → Forward revenue bridge
      → Forward NOI projection
        → Indicated forward value
```

**Only the first stage is implemented.** The second is a series of reads at N
dates against the engine that already exists; the remaining three do not exist
in any form.

### Keep the two contracts separate

**Contractual-position contract** — what Slice 10 is today:

```
governed contractual facts
qualified legacy facts
missing facts
conflicts
lineage
```

**Projection contract** — a different object, not an extension of the first:

```
vacancy assumptions          renewal assumptions
market rent                  collection loss
bad debt                     other revenue assumptions
expense assumptions
```

Every projection input must eventually carry:

```
assumption identity
author
effective period
basis
version
correction or supersession
```

### Why the separation is the load-bearing decision

Slice 10's whole value is that **a withheld number stays withheld**. A scenario
input never has an honest blank — it always has a default. Put one in the same
contract as `contractual_rent` and §5 breaks quietly, because a withheld number
and an assumed number become indistinguishable to the consumer.

**Do not let assumptions enter the contractual-position contract.** The
projection should *reference* the rent roll, not extend it.

The precedent for authored assumptions already exists in the product:
`work_orders.urgency_basis` / `urgency_decided_by` record urgency as a human
decision with an author rather than a computed guess. A projection input should
be recorded the same way.

---

## 7 — In-place and forward framing

**Candidate framing, not settled accounting architecture.**

```
In-place revenue or NOI       current or trailing financial baseline
Forward contractual revenue   dated contractual leasing changes
Forward NOI                   baseline + known changes + explicitly
                              declared assumptions
```

Accounting actuals may eventually provide the in-place baseline. The
authoritative relationship between Property Spine and any accounting system
**remains exploratory**.

No selection is made here between Property Spine becoming:

```
the accounting system      an operational subledger
an accounting-system feed  a reconciliation layer
a reporting layer
```

That product-boundary question comes first, and it is unanswered. See
`MONEY_INTEGRATION_DISCOVERY_QUESTIONS.md` §1.

---

## 8 — Value relationship

Recorded as a conceptual relationship only.

```
Forward NOI ÷ valuation cap rate = indicated forward value
```

**Cap rate is an external valuation assumption.** It is not a Property Spine
fact and should never be recorded as one.

The potential value is not the arithmetic — it is that Property Spine could
explain the NOI bridge through **exact sources**:

```
lease · space · move-in · move-out · concession ·
vacancy assumption · revenue assumption · expense assumption
```

Slice 10 already carries that quality of lineage on the contractual side: each
row names the schedule, line, effective month, application and source offer that
produced its amount. That is materially more provenance than a rent roll
normally carries, and it is the component most likely to survive intact into
whatever comes next.

**No valuation functionality is designed here.**

---

## 9 — Conversational connection

The reasoning pattern is channel-independent and already accepted:

```
governed fact → explanation → exact source → destination
```

Questions a future Spine might answer once the series exists:

```
What changed in the dated rent position?
Why is contractual revenue lower next month?
Which leases drive the change?
Which spaces are uncovered?
Which portions of Forward NOI are assumptions?
```

**Do not add these to the current operational briefing slice.** That slice is
accepted, frozen, read-only, and scoped to "what should I do today?" — a
different question with a different source set.

The last question is the important one architecturally: it is only answerable if
the projection contract keeps assumptions separable from facts. A system that
merges them cannot answer it at all.

---

## 10 — What the current framing over- and understates

**Overstates:** the word *forward*. And `combined_total` — the disclosure that
it mixes dated and legacy authority is a **field**, and fields get dropped by
consumers. A single number that can be lifted out of its disclosure is a §5
hazard even when the disclosure is correct.

**Understates:**

- **The lineage.** Stronger than a rent roll normally carries, and most likely
  to survive whatever gets decided.
- **`reconciliation_state`.** Five states and `matched_actual_ref`, already
  modelled and constrained. Unread, not absent.
- **"7 of 10 declared states reachable."** Three reserved, defensively consumed,
  no faked producer. That is stronger discipline than most systems manage, and
  the receipt is somewhat harsh on itself about it.

---

**No product code. No migration. No money implementation. No conversational
implementation. Slice 10 is not relabelled or rebuilt by this document.**
