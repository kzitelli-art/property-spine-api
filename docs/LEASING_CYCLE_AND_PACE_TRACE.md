# Leasing cycle and pace — architecture trace

**Read-only. No code was changed by this document, and none should be until
this boundary is reviewed.** 2026-08-16, written beside the Slice 2 interval
foundation.

The owner authorized exactly two questions and nothing else:

```text
named leasing cycle  →  configured start/end interval
today's committed positions for that interval
    vs the same elapsed point in the prior comparable cycle
```

with three constraints: **no duplicate "preleased" state**, **pace computed from
dated lease truth**, and **architecture before code**.

This trace answers both questions and reports one thing it was not looking for:
**a duplicate preleased state already exists and is currently winning the
route.** That is §1, because nothing else in this document can be designed
around it.

---

## 0 · The four measurements this trace rests on

Every claim below is measured on the real Skyline population — 72 units, 160
rentable positions, the 07/31/2026 export — in the local proof database.

```text
M1  the interval read already answers the cycle question
      2026-27  contractually_free 32 · term_partially_blocked 128 · term_blocked 0
      2027-28  contractually_free 160 · term_partially_blocked 0 · term_blocked 0

M2  every committed lease carries exactly ONE recorded timing fact, and it is
    not a commitment date
      385 live leases · created_at min = max = 2026-08-16 (the import ran)
      384 of 386 source_type = 'historical_snapshot', 1 distinct source_as_of_date
      executed_lease_records: 0 rows
      leases.application_id populated: 0 rows

M3  the source artifact has no commitment date either
      the real rent roll's columns are
      Unit · Room · Unit/Room Type · Resident · Total Beds · Sq Ft ·
      Market Rent · Actual Rent · Resident Deposit · Other Deposit ·
      Move In · Lease From · Lease To · Move Out · Balance
      There is no signed, executed or application date. Not omitted by the
      importer — absent from the workbook.

M4  "committed for the cycle" has four defensible readings and they do not agree
      A  a lease STARTS inside the cycle window          91  of 160   57%
      B  a lease OVERLAPS the window at all             128  of 160   80%
      C  a lease covers the WHOLE window                  0  of 160    0%
      D  a lease covers >= 80% of the window              83  of 160   52%
```

M4 is the finding that shapes §4. Same property, same day, same governed lease
rows, and the answer to *"how preleased are we for 2026–27?"* is 0%, 52%, 57% or
80% depending on a rule nobody has written down.

---

## 1 · The duplicate preleased state already exists

**`src/leasing/leasingintel.js` publishes a preleased percentage, a goal gap and
a weekly pace-vs-target — parsed from an uploaded `.xlsx` — on the same route the
operator app calls, and it is mounted so that it shadows the canonical read.**

`server.js`:

```js
3237  app.use("/", leasingIntelModule({ pool, upload }));
3238  app.use("/", require("./src/surfaces/desks")({ pool }));   // buildLeasing
```

`leasingintel.js:401`:

```js
router.get("/properties/:propertyId/leasing-dashboard", async (req, res, next) => {
  const snap = await getSnapshot(pool, req.params.propertyId);
  if (!snap) return next();          // -> desks.js buildLeasing
  res.json({ ...snap.payload });     // the workbook wins
});
```

What that payload contains (`leasingintel.js:218–290`):

```text
headline.future_rent_roll     "Fall Prelease" %, from the workbook
future_rent_roll.future       "X% fall pre-leased"
future_rent_roll.gap          "N leases needed to reach the goal"
future_rent_roll.period       "Fall 2026"           ← a hardcoded named period
decide_now[].kind             "pace_gap"
decide_now[].title            "Weekly pace vs target"
decide_now[].next_action      "Review N signed vs 20 weekly target"
```

`demo: false`. `source: "Solo leasing log (.xlsx), parsed live"`. This is a live
operator surface, not a fixture.

### It is not sloppy, and that matters

The module's own thesis is coherent and, at the time, correct:

> the leasing log/tracker is where leasing truth is recorded at the moment it
> happens … Yardi lags it. So the leasing log is the CLAIMED side and Yardi is
> the PROVEN side; the gap is EXPOSURE.

It computes from row-level data rather than the workbook's summary tab, reports
the drift between the two as a warning, and refuses to promote applications to
proven truth because the workbook has no application rows. It is careful work
that solves a real problem: **when it was written, Spine had no dated forward
position of its own, so a spreadsheet was the only source of a preleased number
that existed.**

That premise expired at commit `11b0bb1`. `intervalPropertyPositions` now derives
the same concept from governed dated lease truth. Two sources for one number, on
one route, with the non-canonical one taking precedence.

### The precise statement of the conflict

```text
CLAIMED-vs-PROVEN is a legitimate distinction — a lease signed today and not
yet in Yardi is a real exposure, and leasingintel measures it honestly.

PRELEASED % IS NOT THAT DISTINCTION. It is a count of governed dated rights
over an interval. Spine can now compute it. A workbook figure for it is not
"the claimed side" — it is a second answer to a question that has a canonical
one.
```

### The ruling this trace proposes, and it is a prerequisite

**Pace does not ship until the workbook's preleased and pace fields stop being
served.** Not the whole module — the Yardi-exposure half is genuinely
claimed-side and stays. Three fields and one `decide_now` entry:

```text
REMOVE   headline.future_rent_roll · headline.future_occupancy
         future_rent_roll.{current,future,gap,period}
         decide_now[kind='pace_gap']
KEEP     yardi_control / incomplete_leases / proof_gates    (claimed vs proven)
         renewals_unresolved                                (row-level)
         applications_pending                               (already provisional)
```

Shipping a canonical pace read while the workbook still answers the same
question on the same route is not "two systems that will converge." It is the
`leasing_inventory` situation again — a new correct engine beside an old wrong
one — and that one is already written down as the thing that must not survive
(`docs/PROSPECT_INVENTORY_CUTOVER.md` §0).

---

## 2 · Named cycle → configured interval

### What exists, and what it is not

`migrations/073_property_leasing_calendar.sql` created
`property_leasing_calendar`:

```sql
property_id                 uuid not null unique
preferred_lease_end_anchor  text        -- 'MM-DD', e.g. '07-31'
allowed_lease_end_anchors   text[]      -- {'07-01','07-15','07-31'}
approved_move_in_options    jsonb
delivery_window_days        integer
recommendation_reason       text
```

Its own header says what it is for: *"the leasing rhythm config that drives
lease-end recommendations and the delivery-window severity … NO analytics, NO
forecasting, NO capacity model."*

**It is adjacent to a cycle and it is not one.** It says *when a lease should
end*. A cycle says *which dated span is being sold, under what name*. It is also
`unique (property_id)` — one row per property, no history — so it cannot hold
`2026–27` and `2027–28` side by side, which is the whole point of a cycle.

Do not extend it. A cycle is not a rhythm anchor with more columns, and the
uniqueness constraint would have to be dropped to pretend otherwise.

### What Phase 1 already froze

`docs/PHASE_1_NORTH_STAR.md`, forbidding-clause 2:

> **No season, cycle or academic year in the core.** Not in a column, not in an
> enum, not in a route, not in a reserved name. The durable primitive is a dated
> period. Named cycles are configuration a property declares over periods. A
> `leasing_season` anywhere in `src/tenancy` is the Skyline branch arriving under
> a different word (§22).

And `dated_positions.js:296`, at the interval read itself:

> No named cycles or seasons — the durable primitive is a pair of dates and a
> named period is configuration resolved to dates **ABOVE** this read.

So the shape is already ruled. This trace does not get to re-decide it; it gets
to say where the configuration lives.

### The proposed primitive

```text
property_leasing_cycles
    id
    property_id            → properties(id)
    label                  '2026–27'   — what a human calls it, free text
    cycle_start            date        — the dated span, the durable part
    cycle_end              date
    commitment_basis       text        — see §4. NOT NULL. No default.
    prior_cycle_id         → property_leasing_cycles(id)  nullable
    established_by_user_id · established_at · event_id
    superseded_by_id       → property_leasing_cycles(id)  nullable
```

Five properties of that shape, each load-bearing:

```text
CONFIGURATION, NOT CORE      it lives beside the property, above src/tenancy.
                             The interval read never learns the word "cycle";
                             a caller resolves label → (start, end) and passes
                             two dates, exactly as today.

PLURAL AND HISTORICAL        many rows per property. This is why it cannot be
                             property_leasing_calendar.

COMPARABILITY IS DECLARED    prior_cycle_id is a stated judgment, not an
                             inference from "the row 365 days earlier". A
                             property that changes its term structure has
                             cycles that are NOT comparable, and Spine must be
                             able to say so rather than silently compare them.

SUPERSESSION, NOT MUTATION   a cycle's dates are a decision with a date and an
                             author. Editing them in place would silently
                             restate every historical pace number derived from
                             them. Same rule the turn-readiness expectation
                             table got, for the same reason.

BASIS IS MANDATORY           commitment_basis is NOT NULL with no default,
                             because of M4. A cycle that does not say what
                             "committed" means is a cycle that will be read
                             four different ways.
```

**No `is_current` flag.** Which cycle is current is `cycle_start <= today <=
cycle_end` — derivable, and a flag would be a second answer that can go stale.

**Solo-first, never Solo-special** (§22): a rolling multifamily property simply
has no rows here, and every pace read returns `NOT_ESTABLISHED` for it. Not a
branch, an absence.

---

## 3 · Today's committed positions — already answerable

M1 shows this needs no new storage and no new query:

```text
resolve label → (cycle_start, cycle_end)          new: config lookup
  → intervalPropertyPositions(pool, {...})        exists, 11b0bb1
    → apply commitment_basis                      new: one pure function
      → committed / remaining / total             the pace numerator today
```

A signed future lease moves this number because it moved `leases`. There is no
pace writer, no `preleased` column, no tracker status, and there must not be —
`PHASE_1_NORTH_STAR` forbidding-clause 3 already frozen this.

`2027-28  contractually_free 160 · term_blocked 0` is a real, publishable answer
today: **zero of 160 positions are committed for 2027–28.** Honest, computable,
and useful — an operator can act on it. It requires nothing this trace proposes
except the basis.

---

## 4 · The basis, which is the actual architecture question

§40.10: *comparing requires a basis — per unit, per SF, per coverage limit — and
the basis is a model nobody recorded.*

M4 is that ruling arriving in leasing. Four honest readings of the same rows:

```text
A  a lease STARTS inside the cycle window          91 / 160   57%
B  a lease OVERLAPS the window at all             128 / 160   80%
C  a lease covers the WHOLE window                  0 / 160    0%
D  a lease covers >= 80% of the window              83 / 160   52%
```

### Why C is zero, and why that is not a bug

The configured window is `2026-08-01 → 2027-07-31`. The actual leases are:

```text
2026-08-03 → 2027-07-26     156      the twelve-month student term
2026-08-03 → 2026-12-28      78      the fall-only term
2026-07-27 → 2027-07-26      48
2026-07-27 → 2026-12-28      30
```

**A full-year lease starting August 3rd does not cover a window starting August
1st.** Real leases never tile a configured interval exactly — they are anchored
to move-in weekends, not to the first of the month. So `term_blocked` is the
wrong basis by construction, and reading pace off the interval read's totals
without saying so would report 0% preleased for a property that is 57% leased.

That is not a rounding problem. It is the difference between an operator
believing they have sold nothing and believing they have sold more than half.

### The proposed ruling

**Basis A — a governed dated right whose `start_date` falls inside the cycle
window — is the recommendation, and it is a recommendation, not a decision.**

```text
WHY A     "this lease belongs to this cycle" is what a leasing operator means
          by preleased. A lease sold FOR next year starts next year. It is the
          only basis that is stable under the cycle window's exact endpoints —
          shifting the window by two days moves B and D and does not move A.

WHY NOT B overlap counts a lease that is ENDING inside the window as a
          commitment FOR it. The 78 fall-only leases ending 12/28 would be
          counted as 2026–27 commitments and then vanish mid-cycle.

WHY NOT C zero, for the reason above.

WHY NOT D a coverage threshold is a tunable, and a tunable in a definition is
          how "62% preleased" becomes unfalsifiable. Whose 80%?
```

**But A is wrong for some properties**, and that is why `commitment_basis` is a
column rather than a constant. A conventional multifamily property running
rolling twelve-month terms has no cycle at all. A property selling a
January–December calendar year with mid-year starts may genuinely mean B. The
basis is a property's declaration about its own leasing model, recorded once,
visible in every number derived from it.

**The basis must be printed with the number, everywhere, in the UI and in Ask
Spine.** *"91 of 160 committed"* is not a fact until it says *"committed = a
lease starting inside 2026-08-01 → 2027-07-31."* Same rule as
`term_partially_blocked` never rendering as "partly available."

---

## 5 · Pace against the prior cycle — the clock does not exist

The second question needs, for a date D inside the prior cycle:

> as of D, how many positions were already committed?

That requires a durable **commitment date** on each governed right. M2 and M3
say what Spine has instead.

### The three candidate clocks, and why each fails

```text
leases.created_at
    WHAT IT IS   when the row entered Spine
    MEASURED     all 385 live leases: 2026-08-16, one value, the import
    VERDICT      it dates the IMPORT, not the commitment. Using it would say
                 every lease at Skyline was signed on the same afternoon —
                 a confident wrong number, and a spectacular one.

leases.source_as_of_date
    WHAT IT IS   the as-of date of the snapshot the lease was observed in
    MEASURED     384 populated, 1 distinct value (2026-07-31)
    VERDICT      it dates the OBSERVATION. Every lease shares it. It answers
                 "when did Spine last see this true", never "when was it
                 agreed". Correct provenance, wrong question.

executed_lease_records.executed_at
    WHAT IT IS   the canonical governed execution date. Append-only,
                 record_state verified/superseded/voided, supersedes_record_id,
                 verified_by_user_id, event_id (migration 088)
    MEASURED     0 rows
    VERDICT      THE RIGHT PRIMITIVE, EMPTY. It already exists, it already
                 keeps four execution times distinct, and it is already
                 append-only — so "as of D, what was executed" is answerable
                 from it WITHOUT any snapshot table. It has simply never been
                 written for an imported population.
```

### And it cannot be backfilled

M3 is the hard stop. The rent roll carries `Move In · Lease From · Lease To ·
Move Out` and no signing date. The prior cycle's commitment dates were not lost
by Spine — **they were never in the artifact Spine was given.**

So there is no migration, no census and no inference that produces them. Every
available proxy is a restatement of the same three facts above:

```text
"use start_date"          →  says every lease was committed on its own move-in
                             day. At Skyline that is 156 leases "committed" on
                             2026-08-03, which is the day they BEGIN.
"assume signings were     →  the modelled churn rate this repo already forbids
 evenly distributed"         (FUTURE_RENTAL_V1_CONTRACT §3: never a modelled
                             rate), wearing a leasing hat.
"infer from lease_status  →  status is a current state, not a history. This is
 transitions"                the same error the turn-readiness trace just
                             corrected: a field that holds one value cannot
                             answer a question about a past value.
```

### The ruling

```text
PACE-WITHIN-A-CYCLE            buildable now. It compares today's committed
                               count against the cycle's own total. No history
                               required. This is §3 plus a basis.

PACE-VERSUS-A-PRIOR-CYCLE      NOT_ESTABLISHED for every cycle Spine did not
                               operate, permanently. Not "pending a backfill" —
                               the evidence does not exist and will not appear.
                               It becomes answerable for the FIRST cycle Spine
                               operates end to end, and only from then.
```

**Say the second one in the product, not only in a document.** An operator
asking *"are we ahead of last year?"* must be told **"Spine did not operate
2025–26 — there is no recorded commitment history to compare against"**, which is
a true and useful sentence. A blank, a zero, or a hidden feature are all worse:
the first two are `honest blank beats confident wrong` violated in the confident
direction, and the third makes the operator think Spine cannot do it at all.

### What starts the clock — measured, and it covers one path in four

The smallest thing that makes next year's comparison possible:

```text
every lease that becomes committed FROM NOW ON writes an
executed_lease_records row with a real executed_at
```

That is not a pace feature. It is the existing governed execution-evidence path
being on the live commitment route. **It is wired, and it covers one of the four
reachable ways a lease is created.**

Every `insert into leases` in this repository — searched across `src/`,
`server.js` and `migrations/`, not a subfolder:

```text
src/tenancy/tenancy_anchor_service.js:281   ✓ LINKED. The application →
                                              executed-lease path. It even
                                              back-fills
                                              executed_lease_records.lease_id.
                                              Route is live and app-wired:
                                              POST /operator/leasing/applications
                                              /:id/executed-lease/verify
                                              (index.html:9020).

src/shared/snapshot_loader.js:574           ✗ rent-roll import.
                                              source_type='historical_snapshot'.
                                              No executed record — correctly,
                                              since M3 shows the artifact has no
                                              execution date to record.

src/onboarding/activation_service.js:569    ✗ rent-roll ledger activation.
                                              source_type='rent_roll_ledger'.
                                              Same reason.

src/shared/seed_snapshot.js:190             ✗ QA/demo seed. Not a commitment
                                              path (§19–20).

src/identity/activation.js:431              — NOT MOUNTED. No require, no
                                              app.use; activation_service.js's
                                              own header records that it was the
                                              superseded design. Listed so the
                                              count is a claim about a search,
                                              not about a subfolder.
```

So the answer is **not "not always" — it is "for applications, yes; for a lease
established from a rent roll, no, and correctly so."** The two import paths have
nothing to record: the workbook carries no execution date (M3). Refusing to
invent one is `honest blank beats confident wrong` working as intended.

What this means for pace is precise and slightly uncomfortable:

```text
the commitment clock starts, per position, when that position is next
committed THROUGH THE APPLICATION PATH — not when Spine begins operating
the property
```

A property whose opening truth is an import has 160 positions with no
commitment date, and gains one per position as each is re-leased. So the first
cycle Spine can compare against is **the first cycle whose commitments were
executed in Spine**, and a mid-cycle cutover produces a partial history that
must be reported as partial, never as a complete prior cycle. That is a P-case,
not a footnote:

```text
P12  a cycle with SOME executed-lease history and some imported positions
     asks for comparison → report the covered fraction and refuse the
     comparison, or report it explicitly bounded to the covered positions.
     Never silently compare 40 recorded commitments against 160 positions.
```

**No new writer is proposed.** If a commitment route is later added that does not
produce execution evidence, that is a defect in lease commitment, not in pace,
and it belongs in the commitment path — which is the correct outcome of a pace
trace that found its missing fact one layer down.

---

## 6 · Truth walls

Declared as data, per §40.5, in the domain's own collapsing vocabulary:

```text
preleased  ≠  occupied              a committed 2027–28 bed is empty today
committed  ≠  offerable             §PROSPECT_INVENTORY_CUTOVER — contractual
                                    is not marketable
committed  ≠  signed                until executed_lease_records is populated,
                                    Spine knows a right EXISTS, not that it was
                                    executed, and never when
ahead       ≠  on target            pace vs a prior cycle is a comparison to a
                                    FACT. A goal is an assumption
                                    (FUTURE_RENTAL_V1_CONTRACT §5) and the two
                                    must be shown side by side, never merged
no prior cycle ≠ pace of zero       the four silences (§40.7): this is
                                    NOT_ESTABLISHED, not a quiet zero
cycle       ≠  lease term           a cycle is a configured span; a lease term
                                    is a governed dated right. M4 exists
                                    because they are not the same interval
```

---

## 7 · Ask Spine

A domain is not done until Ask Spine can read it (§40.2). The compact standing
projection (§40.6), which constrains the schema above and is why
`commitment_basis` is a column:

```text
current position      "2026–27: 91 of 160 committed, 69 remaining
                       (committed = a lease starting inside 2026-08-01 →
                       2027-07-31)"
important unknowns    "no prior-cycle commitment history — Spine did not
                       operate 2025–26"
next milestone        the current cycle's end date, and the next cycle's start
```

Capability classes claimed, explicitly (§40.10):

```text
RETRIEVAL             CLAIMED.  "how many beds are committed for 2027–28"
COMPARISON            CLAIMED ONLY WITHIN A CYCLE, and only with the basis
                      named in the same sentence. Cross-cycle comparison is
                      NOT claimed and must not be implied.
CAUSAL EXPLANATION    NOT CLAIMED. "why are we behind" requires recorded
                      causal linkage that does not exist. Do not let a pace
                      number imply Spine knows the reason.
```

---

## 8 · Hostile cases the proof must carry

```text
P1   cycle window shifted by two days → basis A's count does not move;
     B and D do. This is the M4 argument, executable.
P2   a fall-only lease (2026-08-03 → 2026-12-28) is counted once under A and
     disappears from the position mid-cycle. Both facts visible, neither
     smoothing the other.
P3   a cancelled lease inside the window is not committed — same terminal-status
     set the interval read uses, not a second list.
P4   a property with no cycle row asks for pace → NOT_ESTABLISHED with a
     sayable reason, never 0%.
P5   a cycle with no prior_cycle_id asks for comparison → NOT_ESTABLISHED,
     distinct from "prior cycle exists and had zero commitments".
P6   a superseded cycle row is not counted twice, and a pace number derived
     under the old dates is not silently restated.
P7   two cycles overlap (a property mid-transition) → refuse, or report both
     with their own bases. Never sum them.
P8   commitment_basis is null → the read refuses. It cannot default, because a
     default IS a basis, chosen silently.
P9   the same question through the operator UI and Ask Spine returns the same
     count AND the same basis string. One read, two projections (§40).
P10  a lease signed today changes the committed count with no pace writer
     touched — the Slice 2 property, re-proved one level up.
P11  a property whose leases all start before the cycle window (rolling
     multifamily) reports 0 committed under basis A and says so with the basis,
     rather than looking broken.
P12  a cycle with SOME executed-lease history and some imported positions asks
     for comparison → report the covered fraction and refuse, or report the
     comparison explicitly bounded to the covered positions. Never silently
     compare 40 recorded commitments against 160 positions. (§5 — this is the
     mid-cutover shape, and it is the likely one at Skyline.)
```

---

## 9 · Build order

```text
0  REMOVE THE DUPLICATE           §1. The workbook's preleased/pace fields stop
                                  being served. Prerequisite, not cleanup — a
                                  canonical pace read shipping beside a
                                  spreadsheet one is the leasing_inventory
                                  situation repeating.

1  property_leasing_cycles        config + supersession + mandatory basis. One
                                  migration, one table, no columns elsewhere,
                                  nothing added to src/tenancy.

2  cycle-resolved pace read       label → dates → intervalPropertyPositions →
                                  basis. Pure composition; §3 shows no new
                                  query is needed.

3  THE HONEST REFUSALS            cross-cycle → NOT_ESTABLISHED with the
                                  reason; partial history → bounded or refused
                                  (P12). These are product copy, so they are
                                  the browser rung's job, not JSON's.

4  operator surface + Ask Spine   registered, basis printed in both, same count
                                  from both.
```

**The read that was step 1 is done** — §5 answers it: the execution clock is
wired and covers the application path only, which is correct, and its
consequence (P12) is now inside the design rather than ahead of it.

Steps 1–4 are the buildable slice. Step 0 gates all of them.

---

## 10 · What this trace did not do, deliberately

```text
· did not design pricing, concessions or rate recommendations
· did not design prospect placement
· did not propose a `preleased` column, a tracker status, or any forward store
· did not propose extending property_leasing_calendar (§2 — it is a rhythm
  anchor, unique per property, and cannot hold two cycles)
· did not touch turn readiness — the census is still the blocker there
· did not touch the interval read. §3 shows it needs nothing.
· did not decide the basis. It recommends A, measures why C is disqualified,
  and makes the basis a declared column so the decision is recorded rather
  than assumed.
· did not verify whether production has a leasingintel snapshot uploaded.
  §1's route precedence is a structural fact from source; whether it is
  currently firing for a given property is a production read.
· did not propose any new lease writer. §5 measured the four reachable
  commitment paths and found the one gap is correct behaviour, not a defect.
```

### Where this trace looked, and where it did not

```text
LOOKED   src/ (all), server.js, migrations/ (all), docs/, and
         property-spine-app/index.html for callers — the whole-repo rule,
         because server.js defines routes at the root and a src/-only search
         is how "four property-creation doors" was once reported for five.
DID NOT  production. Every number here is from the local proof database
         holding the real 07/31/2026 Skyline export. M1/M2/M4 are claims
         about THAT population. Production may differ, and the basis
         decision in §11 should be taken against production's own numbers.
DID NOT  open PRs and parked branches beyond docs/. Frozen decisions may
         exist there that this trace did not check.
```

## 11 · The one decision this trace cannot make

**Does `2026–27` at Skyline mean 91 committed, or 128?**

This document recommends 91 (basis A), shows why 0 (basis C) is disqualified by
the actual lease dates, and shows why 128 (basis B) counts leases that end
mid-cycle as commitments to it. But the property's leasing operator is the
authority on what their own cycle means, and the number will be read by people
who will act on it.

Recording it as `commitment_basis` is what makes the answer reviewable instead
of embedded. **Whichever is chosen, the number must never be shown without it.**
