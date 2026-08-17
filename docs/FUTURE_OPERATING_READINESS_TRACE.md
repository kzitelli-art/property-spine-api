# Future operating readiness — what Spine can and cannot say

**Read only. No schema was proposed as built, nothing was changed.**
2026-08-16, traced beside the Forward Leasing operator read.

The question:

> What evidence lets Spine say a position will be operationally ready by a
> future requested start date?

**Short answer: it cannot, and the missing thing is a real primitive rather
than a missing join.** Worse, the one dated readiness column that exists holds
two different facts in the same field.

---

## 1 · The chain, and where it stops being governed

```text
lease end date              GOVERNED · DATED      leases.end_date
        ↓
notice / scheduled move-out GOVERNED · DATED      unit_events notice_given
                                                  (status 'scheduled',
                                                   effective_date)
        ↓
possession returned         GOVERNED · ACTUAL ONLY  unit_events move_out
                                                  — recorded when it happens,
                                                    never scheduled forward
        ↓
turn work                   ░░ NOT GOVERNED ░░    no duration, no standard,
                                                  no scheduled completion
        ↓
physical readiness          GOVERNED · ACTUAL ONLY  certification, by a named
                                                  human, at the moment it is true
```

Everything above the turn is dated and governed. Everything below it is
recorded only once it has already happened. **The gap is exactly one link
wide**, and it is the link a future date depends on.

The system already says so, in its own voice. `availability_read.availableFrom`
for a position on notice returns:

```js
{ available_from: <lease end or notice date>,
  availability_confidence: "incomplete",
  blocking_fact: "no_governed_turnover_duration" }
```

with the comment: *"A future lease expiration alone does NOT prove the position
can be marketed or occupied the next day: the turn between residents is real
work, and no approved turnover duration exists as a property fact."*

That refusal is correct and is the reason the owner's correction was right:
ANDing the interval read with `availability_read` would reject a unit that
legitimately turns before a future start, because availability answers
**marketable now**.

---

## 2 · What IS governed today

```text
FACT                     WHERE                          SHAPE
notice given             unit_events notice_given       dated, scheduled
                         status='scheduled'             — a real forward date
lease end                leases.end_date                dated
possession returned      unit_events move_out           dated, ACTUAL only
turn open / in progress  turnovers.status               state, not a date
turn needs               turnovers.needs text[]         a list of work, undated
triage readiness         derived, unit_triage_service   unknown | not_ready |
                                                        (never `ready`)
triage reason            readiness_reason               why, undated
certified ready          readiness certification        dated, ACTUAL, by a
                         certified_at, certified_by     named human
out of service           units.is_down                  state, undated
```

**`unit_triage_service` cannot express `ready` at all**, by design — its header
says migration 112 *"deliberately has no readiness column. Readiness is a READ."*
Absence of a walk is absence of evidence, not readiness.

---

## 3 · The defect found while tracing

**`turnovers.ready_date` holds a TARGET and an ACHIEVEMENT in one column.**

```text
turnover_service.js:132   insert into turnovers (…, ready_date)
                          values (…, expectedReadyDate)
                          ← a date somebody TYPED when opening the turn.
                            An intention. Unproven, unowned, unverified.

turnovers.js:203          update turnovers set status='ready', ready_date=$2
readiness_service.js:65   set status='ready', ready_date=coalesce(...)
                          ← the date the turn was ACTUALLY completed.
                            An achievement.
```

`status` disambiguates them in practice — `in_progress` means the date is a
target, `ready` means it is an achievement — but the column itself does not, and
nothing enforces reading them together.

**`turn_priority.js:219` already sorts on it:**

```js
const ar = a.ready_date || "9999-12-31", br = b.ready_date || "9999-12-31";
```

That orders targets and achievements in one list as though they were the same
kind of date. It is a work-prioritisation read, so the consequence today is a
questionable ordering rather than a wrong fact on a screen. It would be a wrong
fact the moment anything forward-looking read the column.

There is also a **schema/API mismatch worth naming**: the route and the service
both accept `expected_ready_date` (`turnovers.js:48`, `turnover_service.js:83`)
and there is **no `expected_ready_date` column**. The value is silently
redirected into `ready_date`. Nothing throws, and an operator who supplies a
target sees it come back as though it were a completion date.

**Not fixed here.** It is a migration, it is outside the Forward Leasing read,
and migration 175 is already unreleased. Recorded, with the recommendation in §5.

---

## 4 · Is a canonical future-readiness projection possible today?

**No, and the honest reasons are three:**

```text
1  NO GOVERNED TURN DURATION. Nothing in the schema says how long a turn
   takes at this property, for this unit type, for this scope of work.
   The only way to produce a date would be to invent one — which is
   exactly what this trace was told not to do.

2  NO SCHEDULED COMPLETION. `needs` is an undated list. Work orders carry
   due dates, but a work order is not the turn and completing every open
   work order is not readiness — the certification exists precisely
   because "no open tasks" was never allowed to mean ready.

3  NO FORWARD POSSESSION DATE. move_out is recorded when it happens.
   Notice gives a forward date for the RESIDENT leaving; it does not give
   a date for possession being returned, and the two differ in practice.
```

What Spine **can** honestly say about a future date today:

```text
· the lease governing this position ends on <date>              GOVERNED
· notice was given, effective <date>                            GOVERNED
· a turn is open, with <n> recorded needs                       GOVERNED
· nobody has walked it / a walk found blockers                  GOVERNED
· it is out of service                                          GOVERNED
· whether it will be READY by <future date>                     NOT ESTABLISHED
```

That last line is a product answer, not a gap to be papered over. On the Forward
Leasing surface it reads as *"contractually open for these dates — physical
readiness by 8/1 is not established"*, which is more useful to an operator than
a confident date, and is the only version a prospect may be told.

---

## 5 · The smallest missing primitive

Not a forecast engine. **A governed, dated, proof-carrying EXPECTATION of
readiness, kept distinct from both the target and the achievement.**

```text
what it is        a stated expectation that a position will be physically
                  ready on or before a date
who states it     a named human with maintenance authority — never derived,
                  never defaulted, never "typical turn = N days"
what it carries   the date · who committed to it · when · what it is
                  conditioned on (the recorded needs at that moment)
how strong        its own proof basis, exactly as a lease has one:
                    committed    a named human stated it
                    projected    derived from something governed (nothing
                                 qualifies today — reserved, not built)
                  and NEVER `certified`, which is the achievement
what it is not    a completion. Certification stays the only thing that
                  says a position IS ready.
```

Two properties make it safe:

```text
· absence is NOT_ESTABLISHED, never a date. A position with no stated
  expectation reports unknown, and Forward Leasing shows unknown.
· it never overrides certification, and certification never backfills it.
  Target, expectation and achievement are three facts.
```

**Sequenced first, before any of that:** split `turnovers.ready_date` into the
target and the achievement, or drop the target write entirely. Building an
expectation primitive on top of a column that already conflates two facts would
bury the defect under the new thing rather than fix it.

---

## 6 · What this means for composition

The composed answer the owner described stays exactly as described — three
ingredients, all inspectable, none manufactured:

```text
CONTRACTUAL         intervalPropertyPositions      BUILT · PROVEN
   do the dates fit?

OPERATING (NOW)     availabilityRead               BUILT
   can it be shown today?

OPERATING (FUTURE)  ░░ MISSING PRIMITIVE ░░        §5
   will it be ready by the requested start?

        ↓
OFFERABLE POSITION      ← cannot be computed honestly yet, and must not be
                          approximated by substituting "marketable now"
```

Until §5 exists, `offerable` is not a fact Spine has. Forward Leasing composes
what it does have and **names the missing ingredient on screen** rather than
resolving it to a boolean. That is the whole point of keeping the ingredients
inspectable: the operator can see that the dates fit, that the unit is currently
turning, and that nobody has committed to a ready date — and decide. A flat
`offerable: false` would have told them none of it.
