# Forward Leasing → Forward Rent — reconciliation and architecture trace

**Read-only. No product behaviour changed.** 2026-08-16. Acceptance evidence:
`Temple Tracker 2026-2027.xlsx`, sheets `Skyline 2026-2027 RR` and
`Skyline 2026-2027 RR Stats`, against Skyline's canonical lease truth.

Run as a command, not read by hand:

```sh
DATABASE_URL=… node tools/leasing_basis_discovery.js \
  --property <skyline-id> --cycle-start 2026-08-01 --cycle-end 2027-07-31 \
  --tracker "Temple Tracker 2026-2027.xlsx" --tracker-sheet "Skyline 2026-2027 RR"
```

---

# PART 1 · TRACKER RECONCILIATION

## 1.1 · Spine reads Mike's file back to him, exactly

Parsed from the detail sheet, compared against the Stats sheet he maintains
separately:

```text
                          SPINE READ    MIKE'S STATS SHEET
total bed rows                   160                   160
signed                           140                   140
pending                            4                     4
signed + pending                 144            144  (90.0%)
remaining                         16                    16
signed rent                 $113,687                     —
pending rent                  $3,500                     —
signed + pending rent       $117,187              $117,187
Full Year                        100                   100
Fall Only                         44                    44
remaining 2BR / 3BR            11 / 5                11 / 5
```

Every figure reproduces, including the split you gave. **The 16 remaining beds
match your list exactly** — `101A 101B 101C 102A 102B 104B 115A 115B 209A 215A
215B 315A 315B 316C 412B 416A`.

`$113,687` and `$3,500` are computed here for the first time. The Stats sheet
publishes only the combined `$117,187`, so the signed/pending split you asked to
preserve **does not exist anywhere in the tracker** — it is derivable from the
detail rows and nowhere presented.

## 1.2 · Two beds are mis-identified, and the tracker cannot see it

```text
row  76   Unit cell "212A - Reno"   Room cell "B"   [Signed]
row 141   Unit cell "405B"          Room cell "A"   [Pending]
```

**Neither column is reliable alone, and they disagree in opposite directions.**
Row 76's unit cell is wrong; row 141's room cell is wrong. Each conflict
double-counts one bed and leaves another unnamed, which is why 160 rows resolve
to **159 distinct beds**, and why Spine's `1417-212 Room2` is never named.

Consequence, stated plainly:

```text
144 committed rows  →  143 distinct committed beds
one Pending row worth $1,100 sits on a bed identity that does not resolve
```

Detectable only by cross-checking the two columns. A single-column reader — the
tracker itself, and my first version of this tool — reports 144 and is wrong by
one bed and by $1,100 of pending rent. This is not a criticism of the file; it
is precisely the class of error that disappears when identity is `space_id`
instead of a typed string.

## 1.3 · The rule that reproduces the set

Bed-for-bed, against canonical dated lease truth:

```text
RULE                          match   spine-only   tracker-only
A  start inside the window       89            2             54
A2 start within ±45d of start   120            2             23
B  OVERLAPS the cycle window    126            2             17
C  covers the whole window        0            0            143
D  covers ≥ 80%                  81            2             62
E  ends within ±45d of end       70            2             73
```

**B is the closest, and the residue is not disagreement.** Decomposed:

```text
17 tracker-only beds
   17 have NO live lease in Spine at all          ← STALENESS
    0 have a lease that rule B rejects            ← BASIS DISAGREEMENT

 2 spine-only beds
    1  1417-212 Room2   the identity conflict above — the tracker never
                        names this bed, so it cannot appear in its set
    1  1417-416 Room1   a genuine disagreement, §1.4
```

**Zero beds are classified differently by rule B and by Mike anywhere Spine has
data.** The 17 are leases signed after 2026-07-31; the rent roll is `As Of =
07/31/2026` and cannot contain them. (The second rent-roll file supplied is
byte-identical to the first — same as-of date. There is still no fresher
rent-roll truth.)

So the honest statement is:

> **Rule B — a governed dated right overlapping the cycle window — reproduces
> Mike's committed set on every bed where Spine has evidence.** It is not yet
> frozen, because 17 of 144 beds were tested against absent data, not against
> agreeing data.

**What freezes it:** one fresh rent roll dated after the last signing. If the 17
resolve and the count reaches 144 with no new residue, B is the basis and
`commitment_basis` is recorded. That is one file, not another investigation.

### Why B and not A, restated from evidence

A misses 54 beds. Skyline leases in one wave — 122 of 160 beds start between
2026-07-13 and 2026-08-17 — and an August 1 window edge cuts through it. B does
not have an edge inside the cohort, which is why its count is also flat under
±30d window shifts while A's collapses from 121 to 1.

## 1.4 · The one genuine disagreement

```text
1417-416 Room1   Spine: lease ACTIVE 2026-08-03 → 2027-07-26, rent NULL
                 Mike:  remaining (416A is on his open list)
```

One bed, and the shape is already known to this repo: a lease with no terminal
status that nobody closed. `docs/PROSPECT_INVENTORY_CUTOVER.md` §1 names this
exact pathology as the reason the old prospect predicate blanket-excluded any
non-terminal lease. **It is a data-integrity finding, not a basis finding**, and
it is the kind of thing the tracker is currently right about and Spine is wrong
about.

## 1.5 · `Semester` is derivable — do not add a field

You said the `Full Year` / `Fall Only` classification is evidence about how Mike
thinks, not automatically a durable field. Measured:

```text
Spine: cycle lease ending before 2027-03-01        44 beds
Mike:  Semester = "Fall Only"                      44 beds
bed-for-bed intersection                           43
   differences: 405#1 and 416#3 — both already explained above
                (the row-141 identity conflict, and the 416 disagreement)
```

**A term shape is what the lease dates already say.** `Fall Only` is
`end_date < the following spring`; `Full Year` is `end_date ≈ cycle_end`. Adding
a `semester` column would create a second, editable statement of a fact the
dated right already carries — the same error as `turnovers.ready_date` holding
two meanings. If a named term shape is wanted for display, it is a **projection
of the dates**, computed, never stored.

---

# PART 2 · FORWARD RENT — THE READ

## 2.0 · The finding that governs this whole section

**Spine does not currently hold the contracted rent for the 2026–27 cycle. Not
"partially" — essentially not at all.**

```text
07/31 rent roll, 251 bed rows
  Market Rent populated                        251
  ACTUAL Rent populated                          7
  Lease From populated                         128

Spine, live leases for the cycle (start ≥ 2026-06-17)      122
  rent populated                                             1
  rent NULL or 0                                           121
```

This is not an import defect. **A rent roll as of 07/31 reports the rent being
collected on 07/31**, and a lease beginning in August is not collecting anything
yet. The forward dated *terms* imported correctly; the forward *rents* were never
in the artifact.

Mike's tracker has them — `Monthly Rent` per bed, summing to `$117,187`.

```text
FORWARD LEASE DATES        Spine has them          (canonical, from the rent roll)
FORWARD CONTRACTED RENT    Spine does NOT have it  (only in the tracker)
```

**That is the one fact Spine is missing**, and it is the answer to the residue
question in the sharpest possible form: the missing fact is not a status, a flag
or a `preleased` state. It is *the rent on a lease that has not started yet*.

Every number in §2.2 below is computable **only** once that is recorded. Until
then, Contracted Gross Rent is `NOT_ESTABLISHED` — not zero, and not the
tracker's figure quoted as if it were canonical.

## 2.1 · Proposed canonical boundary

```text
src/leasing/forward_rent.js          NEW — the ONLY composer
forwardRent(pool, { property_id, cycle_start, cycle_end, pricing_basis_id })
```

It composes and authors nothing:

```text
intervalPropertyPositions(...)     which exact beds, contractually        EXISTS
       +
canonical lease rent by bed        the contracted amount                  MISSING (§2.0)
       +
pricing assumption for open beds   asking rent, governed and versioned    MISSING (§2.4)
       ↓
CONTRACTED · PENDING · ASSUMED · PROJECTED, never merged
```

**No second rent store and no second preleased store.** The bed set comes from
the interval read built in `11b0bb1`; the rent comes from `leases.rent`; the
assumption comes from a governed pricing record. If this composer needs logic
none of the three has, that logic is missing from one of them and belongs there.

## 2.2 · The output shape, with truth and assumption visibly apart

```text
CONTRACTED GROSS RENT        signed leases, canonical lease rent
  beds                       140                    ← today: 143 resolvable
  monthly                    $113,687               ← today: NOT_ESTABLISHED

PENDING RENT                 pending leases, kept separate and NEVER
  beds                         4                      silently upgraded
  monthly                    $3,500

OPEN POSITIONS               beds with no governed right for the cycle
  beds                        16    (11 × 2BR, 5 × 3BR)

PRICING ASSUMPTION           explicit, versioned, attributable
  2BR                        $850/bed
  3BR                        $799/bed
  assumed monthly            $13,345

PROJECTED FULL-SELL-OUT      contracted + pending + assumed
  monthly run rate           $130,532
```

**`Pending` is never folded into signed.** Mike groups them for the leasing
headline and that is a correct operator compression; Spine keeps the proof
distinction underneath, so *"how much is actually signed?"* answers `$113,687`
and not `$117,187`.

**Trended is not built.** `average achieved rent × 160` (= $130,207.78) discards
the bed-level economics Spine has and replaces them with a mean. It is a
sanity check a human may run; it is not a canonical read.

## 2.3 · The dated monthly schedule — the real destination

The workbook multiplies the run rate by 12. **Spine must not**, and the tracker
itself says why: 44 of 144 beds are Fall Only, and Spine's dated leases confirm
it — 44 beds end 2026-12-26/28/31, and a further 9 end in May/June. `× 12` bills
a Fall Only lease for a spring it does not govern.

```text
MONTH      CONTRACTED   PENDING   ASSUMED OPEN   PROJECTED
Aug 2026        $A         $B          $C           $A+B+C
…
Dec 2026        $A         $B          $C           …
Jan 2027        ↓ the 44 Fall Only beds stop contributing here
…
Jul 2027
```

Each bed contributes rent to a month **only where its lease actually governs**,
from `start_date`/`end_date` — the same dated rights the interval read already
reads. A ten-month lease contributes for ten months. No blanket annualization
anywhere in the chain.

This is what makes the number defensible rather than plausible: the January
column falling by the Fall Only cohort is a fact the property will actually
experience, and the `× 12` version hides it completely.

## 2.4 · Pricing assumption — governed, never lease truth

```text
known lease rent            governed contractual fact       leases.rent
asking rent on open bed     pricing ASSUMPTION              needs a home
projected gross rent        fact + stated assumption        computed, never stored
```

The assumption needs: a value per unit type, an effective date, who set it, and
supersession — the same shape as every other governed statement in this repo. It
must never be written into `leases.rent`, and a projected figure must never be
persisted as though it were contracted.

`FUTURE_RENTAL_V1_CONTRACT.md` §5 already froze the parallel ruling for renewal
goals: an assumption is presented **against** the fact, both visible, neither
overwriting the other.

## 2.5 · Sensitivity stays a scenario

95% / 92.5% / 90% / 80% applied to the run rate are scenario outputs. They are
never the forward leasing position, never stored beside it, and never allowed to
answer *"how leased are we?"* — that question has one answer, and today it is
144 beds.

## 2.6 · Ask Spine

```text
Q  why is projected gross rent $130,532?
A  $113,687 is contracted on 140 signed beds and $3,500 is pending on 4 more.
   The remaining 16 beds contribute $13,345 if 11 two-bedroom beds lease at
   $850 and 5 three-bedroom beds at $799 — an asking-rent assumption, not a
   contracted amount.

Q  how much is actually signed?
A  $113,687.
```

Capability classes (§40.10): **retrieval** claimed. **Comparison** only with the
basis named. **Causal explanation** not claimed — Spine can say the projection
fell, not why a bed did not lease.

---

# PART 3 · PROOF OBLIGATIONS

```text
P1   denominator is 160 rentable positions, from canonical inventory
P2   by-bed grain end to end; no unit-level collapse anywhere
P3   signed ≠ pending — separate counts, separate money, no silent upgrade
P4   asking ≠ contracted — an assumption never lands in leases.rent
P5   Fall Only contributes rent only through its real end date; nothing
     multiplies a monthly figure by 12
P6   one changed lease moves BOTH the forward leasing position and forward
     rent, with no writer in either — the Slice 2 property, one level up
P7   no second preleased store; no second rent store
P8   contracted rent is NOT_ESTABLISHED where the lease carries no rent —
     never 0, never market rent, never the tracker's figure restated as
     canonical
P9   a bed named two different ways is refused, not silently resolved (§1.2)
P10  the tracker is acceptance evidence, never an input to a canonical read
```

---

# PART 4 · WHAT REMAINS UNKNOWN

```text
CONTRACTED RENT FOR THE CYCLE   the blocking gap. 121 of 122 cycle leases
                                carry no rent. Needs a governed way to
                                record a forward lease's rent — the rent
                                roll cannot supply it (§2.0).

THE 17 UNTESTED BEDS            signed after 07/31. One fresh rent roll
                                dated after the last signing freezes rule B
                                or refutes it.

1417-416 Room1                  Spine says leased, Mike says open. A
                                data-integrity finding to resolve, not a
                                basis question.

PACE VS PRIOR CYCLE             unchanged and still blocked. When each bed
                                BECAME committed is not in any artifact
                                supplied. 90% today is not a historical
                                clock.

PRICING ASSUMPTION HOME         where $850/$799 live, who sets them, how
                                they supersede. Named, not designed here.
```

**Not built and not designed:** NOI, NCF, debt service, other income, expenses,
occupancy sensitivity as an operating number, or any Money model. This trace
stops at gross rent, inside Leasing, deliberately.
