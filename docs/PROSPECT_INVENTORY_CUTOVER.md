# Prospect Inventory — cutover to the canonical answer

**Plan only. No code was changed by this document.** 2026-08-16, written
beside the Slice 2 foundation.

The destination, from the owner ruling:

```text
DATED RIGHTS
    ↓
INTERVAL CONTRACTUAL POSITION        ← built, proven, this branch
    +
CANONICAL MARKETABILITY              ← exists: availability_read.js
    ↓
OFFERABLE INVENTORY                  ← does not exist yet
    ├── operator Forward Leasing
    └── prospect / leasing agent
```

What must not survive:

```text
new correct Forward Leasing engine   +   old wrong prospect inventory engine
```

---

## 1 · What is actually there today

`src/leasing/leasing_inventory.js` → `availableUnits({ property_id, bedrooms,
bathrooms, max_rent, limit = 5 }, client?)`.

**One consumer, and it is the prospect-facing one.** `src/agent/agent.js:1303`,
inside the `check_inventory` tool of the AI leasing agent. The units it returns
become `offeredUnits`, which are handed to the model and then to a real
prospect, and the durable offered set is what `matchConfirmationToOffer` later
matches the prospect's reply against.

Its predicate, in full:

```sql
property_id = $1
and occupancy_status = 'vacant'
and coalesce(is_down,false) = false
and bedrooms is not null
and not exists (select 1 from spaces sp join leases lz on lz.space_id = sp.id
                 where sp.unit_id = units.id
                   and lz.lease_status not in
                       ('cancelled','rescinded','void','superseded','terminated','expired'))
```

Four properties of that, each of which the cutover has to answer:

```text
DATE-BLIND       no as_of, no interval, no lease dates read at all
UNIT-GRAINED     returns `units` rows; a by-bed property has no answer here
OFF THE SPINE    reads the denormalized units.occupancy_status, not
                 datedPropertyPositions
CONFLATED        "vacant and not down" is treated as offerable, which folds
                 contractual and operating availability into one flag
```

**It is not sloppy — it is honest about being narrow.** Its own header says
*"callers and receipts must say 'vacant and not down,' never imply more"*, and
the `not exists` guard was added deliberately after unit 530 was quoted to nine
prospects while carrying a started lease. The blanket exclusion is a **fail-
closed patch over a missing date model**, and it is the right patch to have
made. It is the wrong thing to keep once the date model exists.

What the patch costs today, stated as behaviour:

```text
a bed whose last lease ended two years ago in status 'active' is suppressed
  forever — no terminal status was ever written
a position free for the requested period is suppressed because of a
  commitment OUTSIDE that period
a by-bed property cannot be answered at all, at any grain
```

---

## 2 · What is missing, and it is exactly one thing

Not a rewrite. `intervalPropertyPositions` (contractual) and `availabilityRead`
(operating) both exist and both read the canonical spine. Nothing composes them.

```js
// src/leasing/offerable_inventory.js — the ONE composition, proposed
offerableInventory(pool, {
  property_id,            // server-derived, always
  requested_start,        // required — see §5, the open decision
  requested_end,          // null = open-ended
  bedrooms, bathrooms, max_rent, limit,
})
```

Its whole job:

```text
for each rentable position
    contractual = intervalPropertyPositions(...)     contractually_free |
                                                     term_partially_blocked | …
    operating   = availabilityRead(...)              marketable_now | not_ready |
                                                     down | contested | …
    offerable   = contractual is contractually_free
                  AND operating is marketable_now

    and when it is NOT offerable, it says WHICH ONE said so
```

That last line is the point. `offerable: false` is useless to an agent and to an
operator; *"contractually free, physically not ready — turnover in progress"* is
actionable and is two true facts kept apart. Both reads already produce their own
reason (`interval_state` + `colliding_rights`, `marketing_state` +
`blocking_reason`); the composition carries both and invents no third vocabulary.

**It does not re-derive either half.** If it needs logic neither read has, that
logic is missing from one of them and belongs there.

---

## 3 · The cutover, in four steps

Each step is separately shippable and separately provable. No step leaves two
answers live for customer-facing inventory.

```text
STEP 1  BUILD THE COMPOSITION, CONSUME NOTHING
        src/leasing/offerable_inventory.js + hostile suite + DB proof
        against the real 07/31 export.
        The prospect path is untouched. Nothing can regress.
        PROVES: composed answers agree with both halves, and every
        not-offerable position names which half refused it.

STEP 2  ADAPTER, NOT REWIRE — the app-first rule (Open Ruling 2)
        availableUnits() keeps its exact signature and its exact output
        shape { units:[{id,unit_number,bedrooms,bathrooms,square_feet,
        market_rent}], qualification } and becomes a thin projection over
        offerableInventory. The agent changes NOT AT ALL in this step.
        Interval defaults per §5.
        PROVES: the same call, the same shape, on the canonical spine —
        and the unit-530 case still refused, now for the right reason.
        THIS IS A BRIDGE. What removes it is step 4.

STEP 3  GIVE THE AGENT AN INTERVAL
        `check_inventory` gains requested_start / requested_end. The
        leasing conversation already carries a desired move-in; extracting
        it is existing intent work, not new architecture. Until a prospect
        states one, §5 governs.
        PROVES: two prospects asking for different periods get different
        inventory from the same property on the same day.

STEP 4  DELETE THE ADAPTER AND THE OLD PREDICATE
        availableUnits' SQL — occupancy_status, the blanket not-exists,
        the bedrooms-not-null guard — is removed. attachSelectedUnit and
        matchConfirmationToOffer stay; they are about the offered SET and
        the prospect's words, not about deciding availability.
        REMOVAL CONDITION for step 2's bridge: this step. Named here so
        "it works now" does not quietly become the architecture.
```

### Grain, which step 2 cannot dodge

`availableUnits` returns units; `offerableInventory` returns **positions**. On a
by-unit property those are the same thing and the adapter is a rename. On a
by-bed property they are not, and the honest adapter behaviour is to return the
unit **with the count of offerable positions inside it**, never to collapse three
beds into one offer. A prospect being offered "1417-101" when only Room2 is free
is the same class of error as unit 530.

**This is why step 3 matters more than it looks.** The prospect-facing surface
has never been able to express a bed, and Skyline is a bed property.

---

## 4 · What each step must prove

```text
C1  the composed answer never says offerable where either half refuses
C2  a not-offerable position names WHICH half refused it, and why
C3  contractually free + physically not ready is TWO facts on the wire,
    never one false
C4  the unit-530 shape stays refused — a started pending lease
C5  the two-years-stale 'active' lease no longer suppresses forever
C6  a position free for the requested period is OFFERED even when it
    carries a commitment outside that period      ← the whole point
C7  by-bed and by-unit through one code path, no branch (§22)
C8  the same interval question produces the same answer for the operator
    surface and for the agent — one read, two projections (§40)
C9  property_id server-derived; a client-supplied one refused (§21)
C10 no second availability predicate exists anywhere after step 4 —
    enforced by a gate, not by memory
```

C10 wants a source gate in the shape of `gate_person_ingress.js`: one door for
"decides whether inventory may be offered", everything else declared with a
reason and a removal condition. Worth writing at step 1, so steps 2–4 cannot
quietly add a fifth answer.

---

## 5 · The one decision this plan cannot make

**What does the prospect path ask for when the prospect has not said a date?**

Today the question does not arise, because the path is date-blind. The moment it
becomes interval-aware, something has to be passed.

```text
A  REQUIRE AN INTERVAL. The agent must establish a move-in date and term
   before it may offer anything. Most honest, matches how a lease is
   actually sold, and makes the agent ask a question a human agent asks
   first anyway. Cost: an extra conversational turn before any inventory.

B  DEFAULT TO TODAY, OPEN-ENDED. Safest possible answer — an open-ended
   request collides with every future commitment, so almost nothing is
   offered. At Skyline in August that is close to zero units, which reads
   as a broken agent rather than a careful one.

C  DEFAULT TO TODAY FOR ONE DAY. Reproduces today's point-in-time
   semantics exactly, so nothing regresses and nothing improves. It is
   the old answer wearing the new engine, and it would offer the 91
   committed beds Slice 2 exists to exclude. NOT RECOMMENDED.

D  DEFAULT TO THE PROPERTY'S CURRENT PERIOD. Requires named periods,
   which are configuration above the boundary and deliberately not built.
   Available later, not now.
```

Recommendation: **A**, with B as the behaviour when an interval genuinely cannot
be established — an agent that says *"I need your move-in date before I can tell
you what is open"* is behaving correctly, and one that offers a bed it cannot
honour is the failure this whole slice exists to prevent.

---

## 6 · What this does not touch

```text
matchConfirmationToOffer   the offered→selected matcher. Deliberate,
                           conservative, and about words rather than
                           availability. Unchanged.
attachSelectedUnit         governed attachment. Unchanged.
tour_availability          `POST /leasing/availability` is the TOUR-SLOT
                           calendar and has nothing to do with inventory.
                           Same word, different domain; do not merge them.
pricing                    market_rent is carried through as a filter and
                           a display value, exactly as today. No pricing
                           decision moves.
screening, applications    untouched.
```

---

## 7 · Sequencing against Slice 1

**This is behind activation.** The prospect path is live, and rewiring it while
Skyline's opening truth is unestablished would change a customer-facing answer
using data nobody has confirmed. Step 1 is safe to build now — it consumes
nothing. Steps 2–4 wait for the activation sequence in
`docs/THREAD_HANDOFF.md`.
