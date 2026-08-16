# Slice 2 — Forward Leasing · Architecture Trace

**READ ONLY. Nothing was designed into the tree, no schema was proposed, no
writer was touched.** 2026-08-16, against the working tree at the Slice 1
close-out (`5db0bd8` app / `234e347` API).

Governed by [`PHASE_1_NORTH_STAR.md`](PHASE_1_NORTH_STAR.md), which is already
frozen and which this trace must not contradict. Where the two meet, the north
star wins.

The question Slice 2 answers:

> What can we lease for the requested period, which exact rentable positions
> can support it, and how is the building positioned for that leasing period?

---

## 1 · Current authoritative services

Everything that answers vacancy, availability, future occupancy, successor,
Current/Next or dated position state. Searched `src/`, `server.js`, `tools/`,
`seeds/` — the whole repo, not a subfolder.

### The canonical spine (one truth, four readers)

```text
                    leases · unit_events · turnovers · spaces · units
                                        │
                    src/tenancy/space_position.js      ← THE ONE LOADER
                      spacePosition(pool,{property_id, as_of})
                      ONE SQL query. Loads EVERY lease per space,
                      json_agg'd, ordered by start_date. NO DATE FILTER
                      IN SQL — the date is applied afterwards, in JS.
                                        │
                    src/tenancy/position_classifier.js ← THE ONE MEANING
                      classifyPosition(row,{asOf,personNames})  PURE
                      owns: datesSpan · isFuture · rangesOverlap ·
                            leaseIsValid · proofBasis · successor ·
                            future_commitment · conflict_state
                                        │
                    src/tenancy/dated_positions.js     ← THE ONE PROJECTION
                      datedPropertyPositions(pool,{property_id, as_of})
                      + opening_truth, unit attrs, down state
                                        │
        ┌───────────────┬───────────────┼───────────────┬──────────────┐
        ▼               ▼               ▼               ▼              ▼
  rent_roll_       future_rent_    availability_   renewals_    tenancy_position_
  unit_view.js     roll_facts.js   read.js         read.js      read.js
  (Slice 1 ledger) (facts at a     (marketability) (90-day      (Ask Spine
                    future date)                    cohort)      standing)
```

**Authority is not in dispute.** `position_classifier.js` is pure, was extracted
verbatim in July after `notice_given` was found re-derived three ways, and is
covered by `tests/position_classifier_characterization.js` (which runs the
pre-extraction implementation and the current one against the same live data
and asserts deep equality). It is the correct home for anything that means
*"what is contractually true about this position."*

### The two that are NOT on the spine

```text
src/leasing/leasing_inventory.js   availableUnits({property_id, bedrooms, …})
    The PROSPECT-FACING one. Does NOT call spacePosition. Reads the
    denormalized units.occupancy_status='vacant' + is_down=false, then a
    NOT EXISTS over ANY non-terminal lease on any space in the unit.
    · UNIT-grained, not position-grained — cannot answer a by-bed question
    · DATE-BLIND — no as_of, no interval, no lease dates read at all
    · Its own header says so: "offerable_now = occupancy_status='vacant'
      AND is_down=false … callers must say 'vacant and not down,' never
      imply more."
    This is the surface that quoted unit 530 to nine prospects while it
    carried a started lease. The blanket NOT-EXISTS was the fix.

property-spine-app/index.html   the client-side forward projection
    Recorded in FORWARD_RENT_ROLL_INVENTORY.md (2026-07-27) with an owner
    ruling already attached: "useful product evidence, not authority."
    Nothing here changes that.
```

### One name collision worth stating

`POST /leasing/availability` and `GET /properties/:id/leasing/availability`
(`leasingleads.js`) are **tour-slot calendar** availability — `tour_availability`
rows, `starts_at`/`ends_at` timestamps. Nothing to do with inventory. The
inventory route is `GET /operator/leasing/availability-canonical`.

---

## 2 · Point-in-time logic found

**Every inventory answer in the system is point-in-time.** Three predicates
carry it, all in `position_classifier.js`, all taking a single `asOf`:

```js
datesSpan(lease, asOf)   lease.start_date <= asOf && (!end_date || end_date >= asOf)
isFuture(lease, asOf)    lease.start_date > asOf
current    = leases.find(CURRENT_ECONOMIC_STATUSES.has(status) && datesSpan(…))
future     = leases.find(isFuture(…))                      ← FIRST future lease
```

`availability_state` is then decided from `current` / `activationPending` /
`possessed` / `turning` / `future` — five branches over **one date**.

### Measured, on the real 07/31 Skyline export

```text
72 units · 160 rentable positions, at as_of = 2026-07-31

  occupied   (a lease spans that DATE)        37
  "open"     (no lease spans that DATE)      123
     …of which already committed              91
     …genuinely uncommitted                   32
```

**123 is the number the Rent Roll screen shows, and it is correct** — it is a
statement about one date. It is also the number that would be catastrophic if a
Forward Leasing surface reused it as "what is left to lease." The honest answer
for the 2026–27 period is **32**, and the difference is 91 positions that are
already spoken for.

### Where point-in-time silently errs, in both directions

```text
UNDER-OFFERS   availability_read suppresses ANY position carrying ANY future
               lease (`committed_future` → successor_pending). A bed free
               Aug–Dec with a commitment starting Jan 1 is not offerable for a
               four-month Aug–Dec request it could serve perfectly.

OVER-OFFERS    tenancy_state === 'open' (123 above) counts a position as open
               because no lease spans one date. 91 of those are committed from
               8/3. Any surface reading `open` as leasable inventory is wrong
               by 91 beds on this building today.

BLIND          leasing_inventory.availableUnits excludes a space carrying ANY
               non-terminal lease regardless of dates — so a bed whose last
               lease ended two years ago in status 'active' is suppressed
               forever, and a bed free for the requested period is suppressed
               because of a commitment outside it.
```

---

## 3 · Interval logic already present

**One predicate, and it is already governed, shared and correct.**

```js
// position_classifier.js — the ONE definition of a contested position
function rangesOverlap(a, b) {
  if (!a || !b || !a.start_date || !b.start_date) return false;
  const aEnd = a.end_date ? String(a.end_date) : "9999-12-31";
  const bEnd = b.end_date ? String(b.end_date) : "9999-12-31";
  return String(a.start_date) <= bEnd && String(b.start_date) <= aEnd;
}
```

It exists to detect **two leases colliding**. The Slice 2 question is the *same
predicate with one side being a requested interval instead of a second lease.*

Run against the hostile matrix as it stands today, unchanged:

```text
exact adjacent, no overlap                    free
adjacent, prior ends ON requested start       COLLIDES
one-day overlap at the front                  COLLIDES
one-day overlap at the back                   COLLIDES
commitment INSIDE the requested interval      COLLIDES
request inside a longer lease                 COLLIDES
prior lease ends before requested start       free
open-ended lease (no end_date)                COLLIDES
open-ended REQUEST (no end_date)              COLLIDES
both open-ended                               COLLIDES
```

**Every case is already right.** Including the closed-interval convention:
`end_date` is the last day the lease governs (`datesSpan` uses `end_date >= asOf`),
so a lease ending 07-31 and a request starting 07-31 **do** collide. That is
existing governed policy, consistent with the successor rule
(`start_date >= governing.end_date && !rangesOverlap(…)`, so a successor must
start strictly after). **Slice 2 invents no interval policy. It reuses this.**

### And the loader already has the data

`spacePosition`'s SQL loads **every** lease per space with no date filter —
`where l.space_id = s.id`, `order by l.start_date`. The whole dated right-set for
every position is already in memory on every Rent Roll read. The interval
question needs **no new query, no new table, no new column.**

### Proved, not argued

```text
A position whose only lease is 2027-01-01 → 2027-12-31, asked at 2026-08-01:

  current_lease_position   null            ← point-in-time: nothing here
  availability_state       committed_future
  available_from           2027-01-01
  conflict_state           clear

  rangesOverlap({2026-08-01 → 2027-07-31}, that lease)   =  true

  POINT-IN-TIME says open. THE INTERVAL says taken. Same data, same file.
```

And across the real building, using only the existing predicate:

```text
requested 2026-08-01 → 2027-07-31   ·   32 of 160 positions can support it
requested 2026-08-01 → 2026-10-31   ·   32 of 160
requested 2027-09-01 → 2028-07-31   ·  160 of 160
```

Genuinely interval-sensitive — the year after next is wide open, this one is not.

---

## 4 · What constitutes a conflicting dated right

**Traced from what tenancy already governs. No new business policy.**

A recorded right collides with a requested interval when **all** of:

```text
1  leaseIsValid(lease)      lease_status NOT IN (cancelled, terminated,
                            rescinded, void, expired, superseded)
                            ← the EXISTING TERMINAL_LEASE_STATUSES set, and it
                              FAILS CLOSED: a status nobody anticipated counts
                              as a live right and withholds the position
2  rangesOverlap(requested, lease)   ← the EXISTING predicate, §3
```

Notably **`lease_status` is not narrowed to 'active'.** A `pending` future lease
is a real dated right — that is the whole unit-530 lesson, and
`CURRENT_ECONOMIC_STATUSES = {active, commercial}` is deliberately *not* the
right filter here. Economic currency and contractual claim are different
questions.

### What the collision's PROOF is — carried, never collapsed

`proofBasis(lease)` already answers "how do we know this is true", and Slice 2
must carry it rather than flatten it:

```text
native_verified            executed through Spine AND move-in funds cleared
confirmed_opening_import   accepted opening truth from a governed source
unproven                   anything else — never counts as locked
```

A collision with an `unproven` right is still a collision (the position is
spoken for) but it is a **weaker** claim than a collision with a
`native_verified` one, and an operator deciding whether to double-book needs to
see which. Slice 2 reports the colliding rights with their proof basis; it does
not decide that an unproven right may be overridden. **That is a human decision
and stays one.**

### When the question cannot be answered

```text
conflict_state === 'conflicted'    two non-terminal leases already overlap each
                                   other on this position. Which governs is
                                   unknown, so whether it can take the request
                                   is also unknown. NOT "available", NOT
                                   "committed" — unresolved, with the
                                   conflicting_lease_ids named.
evidence_state === 'inconclusive'  opening truth never resolved. The position
                                   may be occupied by someone Spine cannot see.
```

Both already exist as governed fields. Slice 2 reports them; it does not resolve
them.

---

## 5 · The conceptual proof

```text
GIVEN   a rentable position with no lease spanning 2026-08-01
        and one recorded future commitment 2027-01-01 → 2027-12-31
ASKED   can it support a lease 2026-08-01 → 2027-07-31 ?

point-in-time at 2026-08-01     tenancy_state = 'open'      ← says yes
                                availability = committed_future (suppressed)
interval 2026-08-01→2027-07-31  rangesOverlap = TRUE        ← says NO

ANSWER  NOT AVAILABLE for that interval.
        It IS available for 2026-08-01 → 2026-12-31.
```

Two things this shows, and they are different:

1. **Point-in-time vacancy is insufficient.** `open` at a date says nothing
   about a span.
2. **Point-in-time availability is also insufficient, in the other direction.**
   `availability_read` suppresses this position entirely, so it can never be
   offered for the Aug–Dec window it genuinely has. Suppression is the safe
   error, but it is still an error, and on a student property where most beds
   carry a next-cycle commitment it suppresses nearly the whole building.

Which is why the answer is not a boolean. The north star already named the four
states, and they fall straight out of the existing predicate:

```text
contractually_free       no valid lease overlaps the interval
term_blocked             a valid lease covers the ENTIRE interval
term_partially_blocked   a valid lease overlaps PART of it
                         → report the free sub-spans, which is the operating
                           answer ("this bed is yours Aug 1 – Dec 31")
unresolved               competing claims, or opening evidence that disagrees
```

> **Renamed after this trace was written.** It first proposed `available` /
> `committed` / `partially_conflicted`. `available` was overloaded (owner
> ruling: contractual ≠ offerable) and `partially_conflicted` collided with
> `conflict_state`, which already means a CONTESTED position — two rights
> competing, which governs unknown. An ordinary lease overlapping part of a
> term is not a dispute. Renamed while the read had two consumers.

---

## 6 · How a newly signed future lease changes the answer

**With no Forward Leasing writer, because there is no forward store.**

```text
src/tenancy/tenancy_anchor_service.js
    THE one canonical countersign + confirm-term implementation. Its header
    is explicit: "there is exactly ONE countersign implementation and ONE
    confirm-term implementation, ONE authority decision, ONE write path."
    A signed lease becomes a row in `leases`.
                    │
                    ▼
spacePosition's SQL loads every lease per space, no date filter — the new
row is in the set on the very next read
                    │
                    ▼
classifyPosition / classifyPositionForInterval recompute from that set
                    │
                    ▼
Rent Roll · Availability · Renewals · Future Rent Roll · Forward Leasing ·
Ask Spine — all move together, because none of them stores a position
```

Exactly **five product files** write `insert into leases` — four of them
onboarding/import/seed paths, one the native signing path:

```text
src/tenancy/tenancy_anchor_service.js    the native signing path
src/shared/snapshot_loader.js            rent-roll import
src/identity/activation.js               onboarding
src/onboarding/activation_service.js     onboarding
src/shared/seed_snapshot.js              seed
```

*Scope of that count, stated:* whole repo, `.js`/`.sh`/`.sql`, excluding
`node_modules` and `.git`. It also matches 23 files under `tests/` and
`tools/activation/gate_tools_falsify.sh`, which are harnesses and a
falsification script, not product paths. **This count is not comment-stripped**
— a mention in a comment would inflate it, and none was found on inspection.

A cancellation is the same in reverse: `lease_status` moves into
`TERMINAL_LEASE_STATUSES` through `lease_void_service.js`, `leaseIsValid`
returns false, and the position frees up on the next read. **Nothing edits a
forward figure, because no forward figure is stored.**

This is north-star ruling 3 and ruling 6 holding: *"a commitment enters through
the governing writer or it does not exist"* and *"derived numbers stay derived."*

---

## 7 · Existing forward surfaces — consumers, not authority

Examined as context. **None of these becomes the Slice 2 authority merely
because it already renders something forward-looking.**

```text
future_rent_roll_facts.js   datedPropertyPositions at a SELECTED FUTURE DATE.
                            Still one date. Facts only, no projection — its
                            header forbids assumptions and pricing. It is the
                            money-shaped sibling of the Rent Roll, not an
                            inventory engine. CONSUMER.

renewals_read.js            "which leases expire in the next 90 days." A
                            horizon FILTER over expiry dates, not an interval
                            question. Already successor-aware after the rev-2
                            correction (49 of 92 positions had been shown as
                            open renewal decisions while already re-let).
                            Its cohort is a WORK LIST. CONSUMER.

availability_read.js        marketability at one date + a `within_horizon`
                            boolean that is `available_from <= horizonEnd` on a
                            single scalar date. Owns readiness, possession,
                            turnover, operating_use, down. Slice 2 must NOT
                            reimplement any of that — see §9. CONSUMER, and
                            the natural place to compose with.

leasing_inventory.js        the prospect-facing list. Date-blind, unit-grained,
                            off the canonical spine. This is the one Slice 2
                            should eventually REPLACE rather than consume —
                            but replacing it is its own slice with its own
                            proofs, not a side effect of this one.

index.html forward view     already ruled "product evidence, not authority"
                            (FORWARD_RENT_ROLL_INVENTORY.md, 2026-07-27).
```

---

## 8 · Proposed canonical boundary

### Not the straw-man signature, and here is why

```js
canPositionSupportInterval(space_id, requested_start, requested_end)   // ✗
```

Per-position means a query per call. The Forward Leasing ledger asks about 160
positions at once, exactly as the Rent Roll does — that signature is an N+1 by
construction, and it hides that the operator's real question is always *"show me
the ledger for this period."* It also puts the boundary at `space_id`, which
would invite a second loader beside `spacePosition`.

### The boundary the existing architecture already implies

**Two additions. Both pure or near-pure. No SQL, no schema, no table.**

```js
// ── 1 · position_classifier.js  (PURE — the meaning) ──────────────
classifyPositionForInterval(row, { start_date, end_date, personNames })
  → { space_id, unit_id, unit_number, space_label,
      interval_state,            // available | committed |
                                 // term_partially_blocked | unresolved
      colliding_rights: [        // every valid lease that overlaps
        { lease_id, start_date, end_date, lease_status,
          proof_basis, tenants } ],
      free_spans: [ {from, to} ],   // computed, only when term_partially_blocked
      conflict_state, conflicting_lease_ids }  // carried, not re-derived

//   ⚠ evidence_state is NOT available at this layer. evidenceState() lives in
//   dated_positions.js (it reads the imported occupancy claim, which the
//   classifier never sees), so `unresolved` on evidence grounds is decided one
//   level up — in intervalPropertyPositions, exactly where
//   datedPropertyPositions decides it today. Putting it in the classifier
//   would mean moving a definition, which is a bigger change than this
//   boundary needs and would touch the Rent Roll.

// ── 2 · dated_positions.js  (the projection, mirroring its sibling) ──
intervalPropertyPositions(pool, { property_id, requested_start, requested_end })
  → { property_id, requested_start, requested_end, count,
      opening_truth, positions: [ … ] }
```

`spacePosition`'s single SQL query is extracted into a shared `loadSpaceRows()`
used by **both** `spacePosition` (date) and the interval entry point. One query,
one loader, two classifications. That extraction is the only structural change.

The per-position question the straw man wanted is then a filter over this read,
not a second door.

### Why this home and not a new module

```text
· rangesOverlap, leaseIsValid, proofBasis, TERMINAL_LEASE_STATUSES already
  live in position_classifier.js. The interval answer is composed entirely
  from them — putting it elsewhere would mean importing the vocabulary out
  of the classifier, which is how a second meaning starts.
· The classifier is PURE, so the whole hostile matrix (§10) is testable with
  no database at all. That is what makes an exhaustive edge-case suite cheap.
· datedPropertyPositions and intervalPropertyPositions become the two
  parameterizations of one model — which is north-star ruling 1 stated in
  code: "as_of is a PARAMETER OF A READ, never a property of the model."
· By-bed and by-unit need no branch. The loader is per `spaces` row; a
  whole-unit property has one space per unit. §22 holds for free.
```

### The time model

```text
DURABLE PRIMITIVE       requested_start, requested_end — dates, nothing else
PROPERTY CONFIGURATION  a named period ("2027–28") is a label a property
                        declares OVER a pair of dates, resolved to dates
                        BEFORE the read is called
```

No `leasing_season`, no `cycle`, no academic year anywhere in `src/tenancy` —
north-star ruling 2. The core never learns that Skyline is student housing.

---

## 9 · What the boundary explicitly does NOT own

```text
MARKETABILITY        readiness, possession, turnover, operating_use, down,
                     use_type. availability_read.js owns all of it and the
                     permanent rule stands: vacant ≠ ready ≠ marketable.
                     Slice 2 answers "is this position contractually free for
                     the period." Whether it can be SHOWN is a composition of
                     the two, and composing them is a later, deliberate step.
PRICING              market rent, concessions, quotes. Parked by the brief.
PERSON PLACEMENT     which prospect goes where, screening, applications.
PACE / PRELEASED %   derived from this read later; never stored (ruling 6).
NAMED CYCLES         configuration above the boundary, resolved to dates.
CAUSAL EXPLANATION   why a period is behind. No causal linkage is recorded.
COMPARISON           against last cycle, another property, or a market —
                     needs a basis nobody has recorded yet (§40.10).
RESOLVING CONFLICTS  a contested position is reported unresolved, never
                     silently resolved to the first matching lease.
OVERRIDING PROOF     an `unproven` colliding right is still a collision. Only
                     a human may decide to write over it, through the
                     governing writer.
```

`tenancy_position_read.js` already declares this wall in its
`does_not_establish`: *"Whether an open position can be marketed or leased —
that is availability, and it needs readiness and turnover facts this read does
not consult."* Slice 2 does not move that wall; it fills in the half about
dated rights.

---

## 10 · Proposed hostile proof matrix

Pure-function cases first (no database), then the DB rung. Every case names the
governed fact it rests on.

### H · Interval arithmetic — `classifyPositionForInterval`

| # | case | expected |
|---|---|---|
| H1 | exact adjacent terms, no overlap (`…07-31` then `08-01…`) | `available` |
| H2 | prior lease ends ON requested start | `term_blocked`/`term_partially_blocked` — closed interval, existing convention |
| H3 | one-day overlap at the front | not `available` |
| H4 | one-day overlap at the back | not `available` |
| H5 | commitment strictly INSIDE the requested interval | `term_partially_blocked`, two free spans reported |
| H6 | request strictly inside a longer lease | `term_blocked` |
| H7 | lease ends the day before requested start | `available` |
| H8 | open-ended lease (`end_date` null) starting before request | `term_blocked` |
| H9 | open-ended REQUEST against a future commitment | not `available` |
| H10 | requested_end before requested_start | refused — a malformed interval is not an answer |
| H11 | requested_start === requested_end (one day) | answered, not special-cased |

### R · Which rights count

| # | case | expected |
|---|---|---|
| R1 | overlapping lease in every `TERMINAL_LEASE_STATUSES` value | `available` — terminal rights are not rights |
| R2 | overlapping `pending` lease (unit-530 shape) | not `available` |
| R3 | overlapping lease with an unrecognised status | not `available` — fails closed |
| R4 | overlapping `native_verified` vs `unproven` | both collide; `proof_basis` differs in the output |
| R5 | current occupant whose lease expires BEFORE requested start | `available`, and the expiring lease is NOT reported as colliding |
| R6 | current occupant + successor, request after both | `available` |
| R7 | successor lease sitting inside the request | `term_partially_blocked` |

### U · When it must refuse to answer

| # | case | expected |
|---|---|---|
| U1 | `conflict_state === 'conflicted'` overlapping the request | `unresolved`, `conflicting_lease_ids` named — never resolved to the first match |
| U2 | conflicted claims OUTSIDE the requested interval | answerable — the conflict does not touch this period, and saying `unresolved` would be a different kind of wrong |
| U3 | `evidence_state === 'inconclusive'` | `unresolved`, with the reason distinct from U1. Decided in `intervalPropertyPositions`, not the classifier — see §8 |
| U4 | position with no leases at all | `available` — and this must be distinguishable from a property with no inventory (`NOT_ESTABLISHED`) |
| U5 | property with no rentable positions | `NOT_ESTABLISHED`, never "0 available" |

### G · Grain and scope

| # | case | expected |
|---|---|---|
| G1 | by-bed property (Skyline, 160 positions in 72 units) | per-position answers, no unit-level collapse |
| G2 | by-unit property, same service, no branch | one position per unit, identical code path (§22) |
| G3 | one unit where bed 1 is free for the period and bed 2 is not | the unit is neither available nor unavailable — the POSITION is the answer |
| G4 | `property_id` from the session only | a client-supplied one is refused, not ignored (§21) |

### O · Operating blockers — the boundary line itself

| # | case | expected |
|---|---|---|
| O1 | position contractually free for the period but `is_down` | `available` from THIS read; the blocker belongs to availability |
| O2 | …composed with `availabilityRead` | the composed answer is not marketable, and names which read said so |
| O3 | the interval read never re-derives readiness/possession/turnover | asserted structurally, not by inspection |

### C · One truth, two readers

| # | case | expected |
|---|---|---|
| C1 | UI read and Ask Spine read, same property, same interval | byte-identical counts — the same assertion that guards the Rent Roll today |
| C2 | interval spanning today, vs `datedPropertyPositions` at today | the interval read's collisions include everything the dated read calls occupied |
| C3 | Ask Spine registration | present in `gate_ask_spine_readers.js`, and the gate goes RED without it |

### L · The live proof

| # | case | expected |
|---|---|---|
| L1 | real 07/31 Skyline export, interval 2026-08-01 → 2027-07-31 | **32** of 160, not 123 |
| L2 | same data, interval 2027-09-01 → 2028-07-31 | **160** of 160 |
| L3 | sign one native future lease inside the interval | the count drops by exactly one, with no Forward Leasing write |
| L4 | void that lease | the count returns, through `lease_void_service` only |

L1 and L2 are already measured in this trace against the real export. L3/L4 are
the ones that prove §6 rather than assert it.

---

## 11 · Recommended first implementation slice

**One narrow, real, vertically complete slice** (§30). The question is narrow;
the depth is full.

> *Which rentable positions can support a requested period, at this property?*

```text
1  extract loadSpaceRows() from spacePosition — one query, two callers
2  classifyPositionForInterval() in position_classifier.js — PURE
3  intervalPropertyPositions() in dated_positions.js
4  hostile pure suite — the whole of §10 H/R/U/G, no database
5  DB proof against the real 07/31 export — L1, L2, L3, L4
6  GET /operator/leasing/positions-for-period?start=&end=
     property from the session only; a client property_id is refused
7  compact standing projection + Ask Spine registration, and the gate
     falsified for it exactly as tenancy's was
8  the Forward Leasing ledger — Rent Roll grammar, same columns, same
     stable space_id, one extra: POSITION FOR PERIOD
9  browser proof: desktop + narrow, keyboard + mouse, reusing the
     semantics the a11y fix just established
```

**Explicitly NOT in the first slice**, and each is its own later decision:

```text
named cycles / period presets      configuration above the boundary
leasing pace / preleased %         derived later from this same read
prospect placement                 needs person + preference matching
composition with marketability     O2 above — deliberate, not incidental
replacing leasing_inventory.js     its own slice, its own proofs
```

### The one thing to decide before writing code

**Does `available` from this read mean "contractually free" or "offerable"?**

This trace recommends **contractually free**, with marketability composed on
top by an explicit later step — because that keeps one meaning per read, keeps
`vacant ≠ ready ≠ marketable` intact, and keeps this boundary testable with no
database. But it means the first Forward Leasing screen shows positions that are
contractually free and physically not ready, and it must **say which** rather
than implying they can be leased tomorrow.

The alternative — folding readiness in — makes the first screen more immediately
useful and permanently couples the interval engine to turnover state. That is
the trade, and it is the owner's call.

---

## 12 · What this trace did not examine

Stated so the scope is not mistaken for completeness.

```text
· the app-side forward projection in index.html, beyond confirming the
  2026-07-27 ruling still stands
· pricing, money and the economic reads (money/*) — parked by the brief
· AI leasing strategy modules (src/leasing/ai_leasing_*) — read only far
  enough to confirm they consume rather than define availability
· whether `units.occupancy_status` should exist at all now that positions
  are canonical. Real question, adjacent, recorded and left alone.
· migration/schema work of any kind. None is proposed and none is needed
  for the boundary above.
```
