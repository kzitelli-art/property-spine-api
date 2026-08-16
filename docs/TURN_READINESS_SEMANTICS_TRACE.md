# Turn readiness — target · expectation · achievement

**Read only. Nothing was changed, no migration was written.** 2026-08-16.

Three facts share one field today. This traces every writer and reader,
proposes where each fact should durably live, and stops there.

```text
TARGET                when accountable work is supposed to be finished
                      → obligations.due_at
EXPECTATION           when a named human currently believes the unit will
                      actually be ready
                      → turn_readiness_expectations  (does not exist)
PHYSICAL READINESS    when governed inspection says the unit IS ready
ACHIEVEMENT           → unit_readiness_certifications.certified_at
```

and, separately, not a readiness fact at all:

```text
TURN COMPLETED        → obligations.completed_at (module='turnover')
```

They must never share a field. Right now two of them do, and two already have
proper homes.

## 0 · The distinction the code already admits

This is not a theoretical separation. `turnovers.js` states it and even carries
the operator copy for it:

```js
// but if it was flagged down for turn work, that's resolved separately via
// the down-units flow — we do NOT auto-clear is_down here (different axis).
…
unitNote = "Turn marked ready, but unit is still flagged DOWN — resolve the
            down-unit obligation separately before it's truly rentable.";
```

So the product already knows:

```text
turn complete  ≠  unit physically ready  ≠  marketable
```

A turn can be marked ready while the unit is out of service. Any design that
lets turn completion stand in for the readiness achievement would contradict a
distinction the running code makes today, in a sentence it shows to a human.

---

## 1 · Exact writers and readers, today

### `turnovers.ready_date` — holds TARGET and a DUPLICATE ACHIEVEMENT

```text
WRITERS
  turnover_service.js:132   insert into turnovers (…, ready_date)
                            values (…, expectedReadyDate)
                            ← a TARGET, typed by whoever opened the turn.
                              Unproven, unattributed, overwritable.
  turnovers.js:203          update turnovers set status='ready',
                            ready_date=$2  ← a completion date, which is a
                            DUPLICATE of a fact the certification already owns
  readiness_service.js:65   set status='ready',
                            ready_date=coalesce($3::date,current_date)
                            ← same, from the certification path — so the
                              certification writes its own record AND a
                              second copy into the turnover

READERS
  turn_priority.js:103,188  selects it, exposes it as `ready_date`
  turn_priority.js:219      SORTS ON IT:
                              const ar = a.ready_date || "9999-12-31"
                            ← ranks targets and achievements in one order
  surfaces/unit_turn.js:123 renders it as `ready_date`
```

`status` disambiguates them in practice — `in_progress` ⇒ target, `ready` ⇒
achievement — but the column does not, nothing enforces reading them together,
and `turn_priority` already does not.

### The API field that does not exist

```text
turnovers.js:48            const { …, expected_ready_date = null } = req.body
turnover_service.js:83,94  accepted, validated as a date
```

**There is no `expected_ready_date` column.** Confirmed against the live
schema: `turnovers` has `id, property_id, unit_id, outgoing_lease_id, status,
ready_date, moveout_photos, deposit_review, needs, created_at, updated_at`.
The submitted value is silently redirected into `ready_date`. Nothing throws;
an operator who states a target sees it return as though it were a completion.

### The same value also becomes the deadline

```text
turnover_service.js:165   obligations.due_at =
                          expectedReadyDate ? new Date(…) : null
                          related_type: "turnover"
```

So one submitted date currently lands in **two** places, meaning two different
things in each. The field is named `expected_` and is used as a `due_`.

### ACHIEVEMENT already has a proper home

```text
unit_readiness_certifications
  walk_id · property_id · unit_id · certified_by_user_id · certified_at
  walked_by_user_id · senior_accountable_user_id · senior_accountable_basis
  state · note · photos · relied_on_state jsonb
```

Named human, timestamp, the walk it rests on, and what it relied on. This is
the achievement and it is already governed. `turnovers.ready_date` writing a
completion date is a **duplicate** of it, not the source.

### EXPECTATION has no home at all

Nothing anywhere records "a named human currently believes this will be ready
on <date>". The nearest thing is the target, which is not the same fact.

---

## 2 · Does an existing primitive already carry an expectation?

**Traced first, as instructed. The answer is: the PATTERN exists, the table
does not.**

```text
unit_observations              ✗ free-text + photos from a technician walk.
                                 No date being asserted about, no authority
                                 ladder. It is triage capture. 0 rows.
proposed_records               ✗ the claim layer for IMPORT resolution —
                                 staged/confirmed/promoted against a target
                                 record. An expectation is not a proposal
                                 awaiting promotion.
persons.superseded_by_person_id ✗ identity correction. Wrong shape and wrong
                                 domain.
property_pricing_versions      ✗ versioned pricing. Domain-specific.
obligations.due_at             ✓ but for the TARGET only — see §3.
```

**The precedent that fits is the OBSERVATION pattern**, already used four
times: `debt_balance_observations`, `debt_payment_observations`,
`tax_escrow_observations`, `contracted_service_financial_observations`.

```sql
-- debt_balance_observations, the shape to copy
observed_balance_cents · as_of_date · observation_source (CHECK)
source_authority (CHECK: governed_read | transcript_claim |
                        email_claim | user_assertion)   ← §40.4 ladder
source_artifact_id · provenance_note
recorded_by_user_id · recorded_at
```

Append-only. Each row is a statement someone made at a moment. History is kept
by adding, never by overwriting — which is exactly the requirement that
"changing it must preserve the prior expectation rather than overwrite
history."

**So: no general forecasting platform, and no three mutable columns. One
turnover-owned append-only observation table, copying a shape this repo has
already used four times.**

---

## 3 · Proposed durable ownership

```text
TARGET        obligations.due_at, ALONE.
              The obligation engine already owns deadlines, escalation and
              accountability (§11). The turnover must not duplicate the
              deadline into its own column — that is the duplication that
              created this defect. `turnovers.ready_date` stops receiving it.
              The API field is renamed `target_ready_date` to say what it is.

EXPECTATION   turn_readiness_expectations  (NEW, append-only)
              turnover_id · unit_id · property_id
              expected_ready_date        the date being asserted
              basis        CHECK ('walk_assessment','vendor_commitment',
                                  'scope_review','operator_judgement')
              source_authority           the §40.4 ladder, same CHECK
              conditioned_on jsonb       EVIDENCE EXPLAINING THE
                                         EXPECTATION, not a second mutable
                                         copy of current turn scope. It
                                         records what the expectation relied
                                         on WHEN STATED; a later scope change
                                         never rewrites it, it produces a new
                                         expectation row or none at all.
              stated_by_user_id · stated_at · note
              NO update path. A changed belief is a NEW ROW. The current
              expectation is the latest row; the prior one is still there.
              NEVER derived. No "typical turn = N days" writer exists or
              may exist — enforced by a source gate, not by memory.

PHYSICAL      unit_readiness_certifications.certified_at, ALONE.
READINESS     It already carries the named human, the walk, the moment and
ACHIEVEMENT   what it relied on. Nothing else may claim this fact.

TURN          obligations.completed_at, where module='turnover' and
COMPLETED     type='move_out' and related_id = the turnover.
              A SEPARATE OPERATIONAL FACT, and it is NOT readiness.
              It already has a durable home — traced, not assumed: the
              ready route completes that obligation through the shared
              completeObligation helper (turnovers.js:184), which sets
              completed_at = now() (obligation_engine.js:166) after
              enforcing the move-out proof gate.

              ⚠ SO NO `turnovers.completed_at` IS PROPOSED, AND THE
              EARLIER DRAFT OF THIS TRACE WAS WRONG TO SUGGEST ONE.
              Adding it would have split one fact into two homes in the
              same change that exists to stop a field doing exactly that.
              One obligation row already carries the TARGET (due_at) and
              the TURN COMPLETION (completed_at), which is coherent: an
              obligation has a deadline and a completion. Neither of them
              is readiness.
```

**`turn_priority` then ranks against the target it means to rank against.**
Today it sorts on the overloaded column; after the split it reads
`obligations.due_at` for the deadline and may show the latest expectation
beside it. Those are different columns because they are different facts, and
a turn whose expectation has slipped past its target is precisely the row that
should sort to the top — a signal the current single column cannot express.

---

## 4 · Migration and backfill — census first

**Do not backfill by status and call it truth.** `status='ready'` ⇒
achievement and `status='in_progress'` ⇒ target is a plausible rule and it is
still a guess about what a human meant when they typed a date.

```text
STEP 0  CENSUS PRODUCTION, and publish the counts before writing semantics
        · how many turnovers exist, by status
        · how many carry a non-null ready_date, by status
        · of the in_progress ones, how many have an obligation with a due_at
          that EQUALS ready_date (that pair is strong evidence the value was
          a target, because turnover_service wrote both from one input)
        · how many ready ones have a matching unit_readiness_certifications
          row (that pair is strong evidence the value was an achievement)
        · how many match NEITHER pattern ← these are the honest unknowns

STEP 1  ADD ONE TABLE. ADD NO COLUMNS.
        add turn_readiness_expectations (empty)
        keep ready_date, untouched, unread by new code
        NO turnovers.completed_at — turn completion already lives on
        obligations.completed_at, so a new column would be the same
        two-homes mistake this whole repair exists to undo.

STEP 2  BACKFILL NOTHING THAT EVIDENCE DOES NOT SUPPORT
        expectations ← NOTHING. Historical expectation cannot be
                       reconstructed: the value that was typed is
                       indistinguishable from the target it also became.
                       It stays UNKNOWN, and unknown is a valid answer.
        readiness    ← NOTHING. The certification is already the record.
                       A turnover row is not evidence a unit was inspected.

STEP 3  MOVE THE READERS TO THE FACT THEY MEAN
        turn_priority   → obligations.due_at            (the deadline)
        unit_turn       → obligations.completed_at      (turn completion)
                          + certified_at                (readiness)
                          + latest expectation, as its own field
        readiness_service / turnovers.js → stop writing ready_date

STEP 4  RETIRE ready_date
        Removal condition: no reader remains, and the census (§0 of this
        step) has been reviewed by a human. Until then it is legacy, read
        by nothing, and says so in a column comment. It is NOT migrated
        into a new column — every fact it was overloaded with already has
        a home, so the honest end state is deletion, not relocation.
```

**What stays unknown, stays unknown.** A turnover whose date matches neither
pattern gets no `completed_at` and no expectation. The screen shows "not
recorded", which is true, rather than a date inherited from a guess.

---

## 5 · Hostile cases

```text
T1   a turn opened with a target, never completed
     → target on the obligation, no expectation, no achievement
T2   a turn opened with NO target
     → obligation with due_at null. Not "today", not a default.
T3   a target stated, then a walk finds more work and a human states a
     later expectation
     → both rows readable; the expectation is later than the target and
       THAT IS THE SIGNAL. Nothing overwrites anything.
T4   an expectation stated, then revised twice
     → three rows. The current one is the latest; the first two are still
       there, each with who said it and when.
T5   completion BEFORE the expectation
     → achievement stands, expectation stays as stated. A stale expectation
       is not an error, it is what somebody believed at the time.
T6   completion with no certification
     → this is the ambiguity that produced the defect. Achievement is
       NOT_ESTABLISHED; do not synthesise one from the turnover row.
T7   a certification with no turnover
     → certification stands alone. The achievement does not require a turn.
T8   two expectations on the same day by different people
     → both rows. Latest by stated_at wins for "current"; the disagreement
       is visible, not resolved by the schema.
T9   an expectation for a unit whose turn was already completed
     → accepted and recorded, flagged as after-the-fact. Never silently
       reopens the turn.
T10  a reader asks "will this be ready by <future date>"
     → answers from the CURRENT expectation only, with its basis and its
       authority. No expectation ⇒ NOT_ESTABLISHED. Never derived from a
       target, because a target is what we want, not what we believe.
T11  someone tries to write an expectation from a computed default
     → refused. A source gate asserts no writer derives an expectation.
T12  the census finds a ready_date on an in_progress turn with a matching
     obligation due_at
     → strong target evidence, still not backfilled into expectation.
T13  turn completed, unit still flagged DOWN
     → turn_completed_at set, readiness NOT_ESTABLISHED, is_down true.
       Three true facts. The one the code already prints a sentence about,
       and the case that forbids turn completion standing in for readiness.
T14  a certification exists with no turnover at all
     → CERTIFIED. Readiness does not require a turn to have happened.
T15  obligations.due_at has passed with no expectation behind it
     → NOT_ESTABLISHED, and the passed target is SHOWN beside it. That row
       is exactly what an operator should look at, and the target still
       does not upgrade the answer.
```

---

## 5a · The reader rule — a deadline is not a belief

```text
CERTIFIED         a certification already establishes readiness
EXPECTED          the CURRENT governed expectation supports readiness by the
                  requested start — with who stated it, its basis and its
                  source authority
NOT_ESTABLISHED   no governed expectation supports that date
```

**A TARGET never upgrades that answer.** `obligations.due_at` means *we want it
done by then*. It never means *we believe it will be done by then*, and a read
that let a deadline satisfy a readiness question would be manufacturing
judgment out of accountability. The target may be SHOWN beside the answer —
a target that has already passed with no expectation behind it is exactly the
row an operator should look at — but it never changes the state.

## 6 · What this unlocks, and it is deliberately small

The smallest future-readiness projection this makes possible:

```text
readyByDate(unit_id, requested_start) →
  { state: 'expected_ready'      current expectation ≤ requested_start
         | 'expected_after'      current expectation > requested_start
         | 'NOT_ESTABLISHED'     no expectation recorded
    expected_ready_date, basis, source_authority,
    stated_by, stated_at, conditioned_on,
    target_ready_date          from obligations.due_at, shown for contrast
                               and NEVER used to reach `expected_ready`
    certified_at               from unit_readiness_certifications, if it
                               exists — which short-circuits to CERTIFIED
    turn_completed_at          from obligations.completed_at, carried as
                               operational context and NOT as readiness }
```

That is enough for Forward Leasing to stop saying *"physical readiness is not
established"* on every row and start saying it only where it is true — and to
say, on the others, *"expected ready 7/15, stated by Dana on 6/2, conditioned
on the scope recorded then."* Inspectable ingredients, not a boolean.

**It is still not `offerable`.** Offerable is the composition of contractual
interval + operating readiness, and it earns `may_promise: true` only when
both are established for the requested dates. This trace unlocks the second
ingredient; it does not create the composition.

---

## 7 · What this trace did not do

```text
· write a migration, or propose a migration number
· census production — no DATABASE_URL in this environment. STEP 0 is
  written as work, not as findings.
· touch pricing, pace, prior-cycle comparison, cycles or placement
· change any turnover writer or reader
```
