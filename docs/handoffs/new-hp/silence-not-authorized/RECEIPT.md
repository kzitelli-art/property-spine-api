# A reader you may not read is not a reader that did not return (§40.7)

Lane `claude-opus/silence-not-authorized-20260914`, over board `f680a365`.
App pin `b0be9f4` unchanged. **One product change, in one place:** the
`composite_silence` computation in `src/agent/ask_spine_answer.js`. No schema,
no deployment, no production read.

## First red — already pinned on the board

`witness/first_red.txt`, run bare at `f680a365`. The entitlement matrix
recorded the defect as today's behaviour rather than letting it pass:

```
── FOUND · §40.7 · NOT_AUTHORIZED still reads as BLIND ──
ok    leasing_person refuses an unentitled session with an inner envelope
ok    FOUND (open): that envelope still makes composite_silence read BLIND
ok    FOUND (open): and the stated reason is false for an entitlement refusal
143/143 passed

leasing_person    = {"read_state":"NOT_AUTHORIZED","note":"This session does not
                     hold the leasing or management entitlement at this property."}
composite_silence = {"state":"BLIND",
                     "unread":[{"domain":"leasing_person","read_state":"NOT_AUTHORIZED"}],
                     "why":"at least one required reader did not return,
                            so silence cannot mean health"}
```

A session that merely lacked an entitlement was told, about the whole
property, that silence could not mean health — when nothing about the
property was unknown. Only the caller's authority was limited.

## The correction

`NOT_ESTABLISHED`, `READ_FAILED`, `READ_TIMED_OUT` and `QUIET` are facts about
**the property** and about **Spine**. `NOT_AUTHORIZED` is a fact about **the
caller**. Folding the fifth into the four made every restricted session read
as BLIND.

A withheld reader is now **not required for this caller**: excluded from the
readers whose return decides health, excluded from `pending`, and reported
separately.

```
composite_silence = {"state":"QUIET",
                     "why":"every reader this session may read returned and
                            none reports anything pending",
                     "withheld":[{"domain":"leasing_person",
                                  "reason":"not_authorized"}]}
```

Three details that are load-bearing:

- **The QUIET reason changes when something was withheld.** *"Every reader
  returned"* would be a quiet overstatement when one was never read. It now
  says *"every reader this session may read"*, and the proof asserts that
  wording rather than trusting it.
- **`withheld` appears only when there is something to report.** A key on
  every answer would be a contract change for every consumer. With nothing
  withheld the payload is byte-identical to before — asserted.
- **`withheld` is spread into the BLIND branch too.** A caller who is both
  refused one domain and failed by another must see both facts.

## Flipped, not deleted

The three FOUND assertions became the positive wall, in the same block, so
removing the fix goes red here. Five more were added beside them:

| assertion | guards |
|---|---|
| the envelope still exists | the refusal is still made, sayably |
| composite_silence is **not** BLIND because of it | the fix itself |
| the domain appears under `withheld` with its reason | the caller can be told *"Spine did not read X for you"* |
| it is **not** counted as pending either | entitlement is not attention |
| the QUIET reason names *"may read"* | the health claim says what it checked |
| an **absent** domain is not reported as withheld | absence ≠ refusal |
| no `withheld` key when nothing was refused | the shape is unchanged otherwise |
| a genuine failure is **still BLIND** | the fix narrows blindness by exactly one value |

**The whole 8 × 6 matrix still passes and the compliance row is unchanged.**
Compliance is *absence* — its branch never runs for an unentitled session, so
it leaves no envelope, appears in no `withheld` list, and is still
not-a-silence. Absence and withheld are different facts and both now read as
not-a-silence, by different routes; the proof asserts compliance's route
explicitly so this lane cannot have quietly converted one into the other.

## ⚠ Correction to the assignment: the SMS matrix asserts no silence shapes

The brief said `skyline_ask_spine_sms_matrix` *"asserts composite_silence
shapes"* and asked which assertions I had to change. **It asserts none** —
`grep -n composite_silence tests/unit/skyline_ask_spine_sms_matrix.test.js`
returns nothing. It passes 157/157, unchanged, and that is **not** evidence
about this change.

**No test assertion anywhere had to be changed.** The real source-only
consumer is `tests/unit/required_work_standing.test.js`, and it is the one
that matters:

- `assert.deepEqual(facts.composite_silence.domains, ['maintenance'])` — a
  strict deep-equal that would have failed had an extra key appeared when
  nothing was withheld. It passes.
- `assert.equal(failed.composite_silence.state, 'BLIND')` for both `BROKEN`
  and `READ_TIMED_OUT`. It passes — genuine failures are untouched.

Two further consumers (`tests/proofs/triage_work_scope.db.js`,
`tests/proofs/prospect_match_basis.db.js`) need Postgres and run in CI; both
assert ATTENTION/pending shapes that this change does not reach.

## The compliance projection test that never existed

`tests/unit/compliance_ask_spine.test.js` — class 1, registered in
`verify_all.sh`, **8/8**. Built in the shape of `debt_ask_spine`: a synthetic
canonical reading injected through the reader seam, no database.

Compliance was named as a regression target twice before anyone checked the
file was there. Every other registered Asset Management domain had one. The
entitlement matrix covers *who* may read compliance; nothing covered *what
they get when they may*.

It asserts the contract envelope (`contract_version`, `as_of`,
`capability_classes` with comparison and cause explicitly false,
`composition_authorization: unsolved`, `coverage`), that every item keeps
`standing / why / unresolved / next / attention`, that `not_established`
does not read as fine, that evidence reaches the model as **role and label
only**, and that **no record id, source id or opener token escapes** — with
those ids seeded into the fixture so their absence is a measurement, not an
empty-fixture artefact. Plus a failed read reading `READ_FAILED` rather than
zero items, and the unentitled path across four module sets.

## Proof

| rung | result |
|---|---|
| entitlement matrix | **148 run · 148 passed · 0 failed · EXIT 0** (was 143) |
| `compliance_ask_spine` | **8/8 · EXIT 0** |
| `required_work_standing` | EXIT 0, unchanged |
| `skyline_ask_spine_sms_matrix` | **157/157**, unchanged (asserts no silence shapes) |
| `ask_spine_answer`, `personal_attention_convergence`, `tenancy_ask_spine`, `debt_vocabulary_subject` | all EXIT 0 |
| Ask Spine reader gate · falsification | EXIT 0 · EXIT 0 |
| `node tests/verify_source_governance.js; echo EXIT=$?` | `✓ PASS — all 56 source-governance gates exited 0` · `PARENT EXIT 0` · **EXIT=0** |

## What this would miss

- **BLIND + withheld together is unreachable today, so it is not proven.**
  `leasing_person` is the only writer of a `NOT_AUTHORIZED` envelope, and
  nothing else gathers in its subject, so a caller cannot currently be both
  refused one domain and failed by another. The code spreads `withheld` into
  the BLIND branch for the next writer; that path is written, not witnessed.
  Saying otherwise would be claiming a proof I do not have.
- **`withheld` is a new key with no consumer yet.** Nothing in the prompt or
  any surface reads it. The answer *can* now say "Spine did not read X for
  you"; nothing makes it.
- **The instruction block was not changed.** The model is told how to read
  `composite_silence`; it is not yet told what `withheld` means. Left
  deliberately to one place per lane — see the owner decision.
