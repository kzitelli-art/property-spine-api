# Phase 1 — Forward Leasing Position

**DO NOT BUILD THIS YET.** Slice 1 closes first. This is recorded now for one
reason: so the last Slice 1 decisions do not quietly make Phase 1 harder or
force a second model. It is a **constraint on the present**, not a plan for
the future.

Recorded 2026-08-16, from Kameron's brief, verbatim in substance.

---

## What Phase 1 is

```text
Slice 1 answers    What IS this property?
Phase 1 answers    What can we LEASE next?
```

For Skyline this is the operating problem Mike's leasing tracker has solved by
hand for years. Property Spine takes that operating logic and makes it native
to the Rent Roll truth Slice 1 established.

## The three jobs

**1. What do I still have left to lease?** Not "what is physically vacant
today" — *for the lease period we are selling, what rentable positions remain
uncommitted?*

```text
2027–28 Leasing
160 beds · 104 committed · 56 remaining
```

Every number resolves back to the same rentable positions Slice 1 established.

**2. Where can I put this prospect?** Given desired move-in / lease period,
party size, budget and preferences, Spine determines which actual rentable
positions can accommodate them. The operator tracker makes it obvious; the AI
later consumes **the same answer**. No second inventory source for AI.

**3. How are we tracking through the leasing cycle?** Not `62% preleased` but
`62% preleased today vs 65% at the same point last cycle`. Pace becomes
visible. Spine does not make the pricing decision.

## One rent roll, not two systems

There is no forward database and no tracker database.

```text
Property → Unit → Rentable Space → dated lease / occupancy rights
```

Phase 1 is another operating projection over that one truth. A signed future
lease changes the forward position **automatically**. A cancellation changes it
through the governing domain action — never by editing the tracker.

## Time model — the trap

Skyline operates in named student cycles (`2026–27`, `2027–28`). Property Spine
**must not** make student leasing season the universal architecture.

```text
DURABLE PRIMITIVE       requested lease period: start_date, end_date
PROPERTY CONFIGURATION  named cycles declared OVER those periods
```

Conventional multifamily may be rolling instead. No Skyline branch and no
student-housing branch in the core availability engine (§22).

## Period-aware availability

Today's architecture is point-in-time. Phase 1 must answer the harder
question: *can this position support the ENTIRE period being offered?* — not
"is it open on August 15."

```text
fully available for the requested period
fully committed
partially conflicted
unresolved
```

A space free Aug–Dec but committed Jan–Jul is **not** available for a twelve
month Aug–Jul lease. The engine reasons over the whole interval and must not
flatten that into today's vacancy status.

## Human interface

The horizontal Rent Roll grammar established in Slice 1 is the reference. The
default Phase 1 view is a compressed leasing ledger — dense, horizontal,
aligned, scannable, filterable, institutional when expanded.

```text
UNIT · ROOM · POSITION FOR PERIOD · NEXT RESIDENT · RENT · LEASE STATUS
```

Same inventory, same language, same stable position IDs, different question.

## Leasing pace

Enough durable history to compare progress at equivalent points in successive
cycles, **derived from actual dated commitments**. Do not store a manually
updated `% preleased` if it can be derived. Not the analytical layer — the
simple operating comparison first.

## What Phase 1 is NOT

Cash forecasting · accrual accounting · debt-service forecasting · concession
accounting · automated pricing · AI prospect placement · screening ·
e-signature · application redesign · portfolio analytics. Real future layers,
intentionally parked.

## AI relationship

```text
canonical Rent Roll truth
  → period-aware availability
    → human leasing tracker proves the answer
      → AI consumes the same canonical read
```

The AI never has its own availability logic.

## Acceptance

Mike opens Skyline, chooses the period being sold, and answers in seconds: how
much is left to lease · which actual beds · where a prospect can go · ahead or
behind last cycle. Every answer resolves to Slice 1's canonical truth.

---

# ════ WHAT THIS FORBIDS IN THE REST OF SLICE 1 ════

This is the operative half of the document. Each line is a decision that is
still open today and would cost a rewrite later.

**1. `as_of` is a PARAMETER OF A READ, never a property of the model.**
`datedPropertyPositions(pool, { property_id, as_of })` is point-in-time and
that is correct for Slice 1. Phase 1 needs an interval sibling —
`(start_date, end_date)` — over the same positions and the same classifier.
Nothing in the remaining Slice 1 work may assume a single date is the only
question the model can be asked. Concretely: the tenancy standing read must
carry its `as_of` as an input it reports back, not bake "today" into its
shape, and must leave room for a period-shaped answer beside it.

**2. No season, cycle or academic year in the core.** Not in a column, not in
an enum, not in a route, not in a reserved name. The durable primitive is a
dated period. Named cycles are configuration a property declares over periods.
A `leasing_season` anywhere in `src/tenancy` is the Skyline branch arriving
under a different word (§22).

**3. `next` stays the classifier's, and stays singular in meaning.** Phase 1
reads the same `successor` / `future_commitment` the Rent Roll does. Do not
add a parallel "commitment" store, a tracker status, or an editable forward
field. A commitment enters through the governing writer or it does not exist.

**4. Stable position identity is load-bearing beyond this slice.**
`space_id` is what lets the Rent Roll, the leasing tracker and the AI agree
they are talking about the same bed. It is already carried on every row; it
must stay on every projection added from here.

**5. Person identity across cycles is a Phase 1 dependency, not just a Slice 1
tidiness issue.** "Ahead or behind last cycle" and "returning vs new resident"
are unanswerable if the same human becomes a new `persons` row each import.
This is why the external-identity design (Slice 1 item 1) blocks establishment
— see `docs/EXTERNAL_IDENTITY_PROPOSAL.md`.

**6. Derived numbers stay derived.** No stored `% preleased`, no stored
`remaining`, no stored `committed` count. If it can be computed from dated
commitments, computing it is the design.

**7. One visual grammar.** The Slice 1 ledger is the reference for the leasing
tracker. Fixing its accessibility defect before it propagates (Slice 1 item 3)
is cheaper now than in five surfaces.
