# Turn readiness — target · expectation · achievement

**Read only. Nothing was changed, no migration was written.** 2026-08-16.

Three facts share one field today. This traces every writer and reader,
proposes where each fact should durably live, and stops there.

```text
TARGET        when we want the turn finished
EXPECTATION   when a named human currently believes it will actually be ready
ACHIEVEMENT   when it was actually certified ready
```

They must never share a field. Right now two of them do, and the third has a
proper home already.

---

## 1 · Exact writers and readers, today

### `turnovers.ready_date` — holds TARGET and ACHIEVEMENT

```text
WRITERS
  turnover_service.js:132   insert into turnovers (…, ready_date)
                            values (…, expectedReadyDate)
                            ← a TARGET, typed by whoever opened the turn.
                              Unproven, unattributed, overwritable.
  turnovers.js:203          update turnovers set status='ready',
                            ready_date=$2  ← an ACHIEVEMENT
  readiness_service.js:65   set status='ready',
                            ready_date=coalesce($3::date,current_date)
                            ← an ACHIEVEMENT, from the certification path

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
              conditioned_on jsonb       the recorded `needs` at the moment
                                         it was stated — so a later reader
                                         can see the expectation was about a
                                         different scope of work
              stated_by_user_id · stated_at · note
              NO update path. A changed belief is a NEW ROW. The current
              expectation is the latest row; the prior one is still there.
              NEVER derived. No "typical turn = N days" writer exists or
              may exist — enforced by a source gate, not by memory.

ACHIEVEMENT   unit_readiness_certifications, ALONE.
              It already carries the named human, the walk and the moment.
              `turnovers.ready_date` becomes `completed_at` OR is dropped in
              favour of reading the certification — see §4, which is a
              census question, not a design one.
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

STEP 1  SPLIT WITH NO INTERPRETATION
        add turnovers.completed_at (date, null)
        add turn_readiness_expectations (empty)
        keep ready_date, untouched, unread by new code

STEP 2  BACKFILL ONLY WHAT GOVERNED EVIDENCE SUPPORTS
        completed_at ← ready_date ONLY where a certification corroborates it
                       (or where status='ready' AND the census shows the
                        pattern is unambiguous — decided from the numbers,
                        not in advance)
        expectations ← NOTHING. Historical expectation cannot be
                       reconstructed: the value that was typed is
                       indistinguishable from the target it also became.
                       It stays UNKNOWN, and unknown is a valid answer.

STEP 3  MOVE THE READERS
        turn_priority → obligations.due_at
        unit_turn     → completed_at, plus latest expectation as its own field
        readiness_service / turnovers.js → completed_at

STEP 4  RETIRE ready_date
        Removal condition: no reader remains and the census-backed backfill
        has been reviewed by a human. Until then it is legacy, read by
        nothing, and says so in a column comment.
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
```

---

## 6 · What this unlocks, and it is deliberately small

The smallest future-readiness projection this makes possible:

```text
readyByDate(unit_id, requested_start) →
  { state: 'expected_ready'      current expectation ≤ requested_start
         | 'expected_after'      current expectation > requested_start
         | 'NOT_ESTABLISHED'     no expectation recorded
    expected_ready_date, basis, source_authority,
    stated_by, stated_at, conditioned_on,
    target_ready_date          from obligations.due_at, for contrast
    achievement                 from the certification, if it exists }
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
