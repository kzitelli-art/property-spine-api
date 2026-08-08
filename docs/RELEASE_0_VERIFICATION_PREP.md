# Release 0 — verification prep

**Prepared, not run.** Four things that must happen around the activation, built
now so none of them is improvised on the day.

1. Step 3 running-checkout verification *(owed)*
2. Live HTTP + browser acceptance checklist
3. Focused review of the inverted assertions
4. The release-order sheet, Step 3 → cleanup

---

## 1 · Step 3 running-checkout verification *(owed since the merge)*

Step 3 merged as `b4e3104` (PR #54) and **the deploy was never verified** — the
sandbox proxy denied the production host. Every boundary after it assumes the
canonical writer is live.

```bash
# in the Render shell, on the deployed checkout
node tools/steps23/verify_step3_deployed.js
```

**A green deploy event is not evidence.** It proves a build ran, not that the
running checkout is the reviewed one — and this release has already been bitten by
exactly that gap (`EXPECTED_SHA` named a commit that was not the one deploying). So
the tool reads the bytes that are running and compares them to the digests of the
merge:

```text
src/technician/lifecycle_service.js          06bb9633…
src/maintenance/proof_evaluation_service.js  bbdd3e4b…
src/maintenance/work_proof.js                de92e170…
```

**And a digest is not behaviour.** So each digest is paired with an assertion about
the running source:

```text
2.1  claimCompletion records a proof evaluation
2.2  …BEFORE it sets the status — the ordering §4 requires, and the same
     ordering that lets migration 140 admit the canonical writer
2.3  …and the evidence gate uses the corrected classification array
2.4  the evaluation service refuses a state outside the writable two
3.1  the ledger is at 137 or beyond
3.2  the proof chain tables exist
```

**§4 is reported, never asserted.** Zero proof evaluations in production is the
*expected* state until Step 4 passes — Twilio is unconfigured, so nothing has
reached the writer. **Step 3 being deployed and Step 3 having been exercised are
different facts, and only the first is checked here.** Asserting the second would
make this red for a reason that is not about Step 3.

---

## 2 · Live HTTP + browser acceptance checklist

Everything below is **currently proven against isolated Postgres only**. The
Definition of Done (§33) makes browser verification part of "done" for operator
workflows, and **nothing has yet rendered a live four-state response in a browser.**

### 2a · Live HTTP — after boundary 9 (the reader) deploys

Against the deployed API with a real operator session:

```text
□  GET /operator/work-orders/status              200, property_id is the SESSION's
□  every row carries `proof.state`               §3.3 — the board depends on it
□  GET /operator/work-orders/<id>/status         200 for a work order at that property
□  list and detail agree on state for every row  the L-section claim, live
□  a work order at ANOTHER property              404, and no row leaks in the body
□  ?property_id=<other>                          403, naming the property acted on
□  no x-staff-session header                     401, never an empty 200
```

**Before activation, expect `read_status: "unavailable"` with `state` and
`satisfied` ABSENT** (§3.2.1) — that is correct, not a failure. **Check
`next_action` on any `completion_claimed` row**: it must say the read is
unavailable, not "Obtain repair photo before completion". That was a real defect
and it is the one most likely to reappear if #62 is not in the same release as #60.

### 2b · Browser — the operator's own path (§7.3, §17)

Signed in as a real operator, on the live app:

```text
□  the work board renders, live data, no fixture fallback
□  a `legacy_indeterminate` row and a `missing_evaluation_defect` row render
   DIFFERENTLY — different sentence, and only the defect in the `exc` tone
□  neither reads as "photo required"              they are not proof failures
□  an unavailable read shows "Proof state unavailable", never a fabricated state
□  console carries NO `[proof-normalizer] CONTRACT FAILURE` lines
□  no app path completes a work order             Step 5's claim, verified live
□  the NOT-DONE path still works                  closeoutNotDone is untouched
□  screenshot each of the above                   §30 requires a preserved receipt
```

**The console line is the load-bearing check.** A legitimate `unavailable` and a
contract failure look identical to the operator and are distinguished only there —
one is a known condition, the other is a bug someone has to fix.

### 2c · What cannot be checked in a browser yet

The technician SMS boundary. Its HTTP door is the Twilio webhook, and Twilio is
unconfigured. **Step 4 is the gate for that, and it is a handset, not a browser.**

---

## 3 · Focused review of the inverted assertions

I flipped assertions from *"this must fail"* to *"this must pass"* in five files.
**That is the change shape most likely to erase a safety property**, so here is the
exact surface, generated from the diffs rather than from memory.

### 3a · App, on `claude/proof-state-consumer-migration` (#39)

```text
proof_normalizer_contract.test.js       5 assertion lines removed, 7 added
proof-normalizer.js                     the rule itself
proof_presentation_contract.browser.js  N2 moved sides → X1/X2
work-lifecycle-door.js                  3 reads moved to `state`
```

**The one rule that changed:** `satisfied` was REQUIRED on the new contract; it is
now OPTIONAL, and still cross-checked when present.

**What to check when reviewing:**

- The cross-check survives. A state and a boolean that **disagree** must still be a
  `contract_failure` — `state_boolean_mismatch`. If that is gone, a server sending
  `state: "satisfied", satisfied: false` would be accepted.
- The **old contract is untouched**. There `satisfied` is the only signal there is,
  and it must still be REQUIRED. There is an explicit assertion for this; confirm
  it is testing the old shape (no `read_status` key) and not the new one.
- `null` still means null. `false` may never stand in for it, for legacy or defect.
- The door's three reads are equivalent substitutions: `build()` sets
  `satisfied = EXPECTED_BOOLEAN[state]`, so `satisfied === true` ⟺
  `state === "satisfied"`, and `unavailable()` sets both null. **Verify that
  equivalence holds in the normalizer before accepting the door change.**

### 3b · API, on `claude/cleanup-candidate` (#63)

```text
tools/step8/prove_step8_reader.js        C1–C4 → absence + mapping; C5, C7, X3
tools/step10/prove_http_acceptance.js    H·×4, H5, H7, D14
tests/gate_proof_compatibility_field.js  G2 re-anchored; G6 inverted
src/release0/proof_state.js              the field leaves the wire
```

**What to check when reviewing:**

- `SATISFIED_FOR` is still **exported and unchanged**. Retiring the field must not
  change the meaning. `G9` and `C4a`/`C4b` assert this; `mapping-deleted` falsifies it.
- `X3` became *"`satisfied` never appears on any shape"*. That is **stronger** than
  the mismatch check it replaced — a mismatch is unrepresentable once the field is
  gone — but confirm the new assertion actually iterates every shape and state.
- `G2` was re-anchored onto **literal samples** because its old anchor was the very
  thing being removed. Confirm the samples still match what the pattern must catch,
  and that it still ignores `proof_satisfied` (the unrelated work-acceptance column).
- `G6` inverted from "still published" to "no longer published". `G8` must still
  assert `state` is emitted, or the release could remove the contract itself.

### 3c · The question worth asking about all of them

For each inverted assertion: **what would now pass that should not?** If the answer
is "nothing — the property moved to a different assertion", it is a correct
inversion. If the answer is "a server that sends X", the inversion lost something.

---

## 4 · The release-order sheet

Full detail per boundary in `docs/RELEASE_0_ACTIVATION_RUNBOOK.md`. This is the
order on one page.

```text
                                                    artifact          kind
──────────────────────────────────────────────────────────────────────────────
 0  Step 3 running-checkout verification            (tool)            VERIFY  ← owed
 1  Transport · Twilio configured                   external          BLOCKER
 2  Step 4 · handset completion proof               #64 tooling       GATE
 3  Step 5 · app completion control removed         app #37           deploy
 4  Step 6 · legacy done-path fails closed          API #57           deploy
     └─ CAPTURE THE ACTIVATION INSTANT HERE, and only here (§5.4)
 5  migration 140 · completion guard                API #66           APPLY    ← before 7
 6  Step 7 tooling                                  API #59           deploy
 7  census + activation transaction                 (run once)        IRREVERSIBLE
 8  Step 8 · four-state reader                      API #60           deploy   ← after 7
 9  migrations 138 + 139 · §4.2 sweep               API #61           APPLY + deploy
10  HTTP acceptance + next_action fix               API #62           deploy   ← with 8
11  App consumer release                            app #38           deploy
12  live HTTP + browser acceptance                  §2 above          VERIFY
13  cleanup: consumers move to `state`              app #39           deploy
14  cleanup: post-removal contract                  app #40           deploy
15  cleanup: `satisfied` leaves the wire            API #63           deploy
    LATER  the normalizer's old-contract branch — blocked on no deployed
           API being able to emit the boolean-only shape
```

### The four places order is not a preference

**5 before 7.** Migration 140 is inert until activation, so it is safe to apply any
time — and the window it protects opens the instant the activation transaction
commits. Applying it afterwards leaves a gap in which any of the 67 write-capable
unguarded scripts can manufacture a defect.

**8 after 7.** §5.1: the reader deploys only once activation and inventory exist.
Earlier, every terminal work order reads `unavailable`.

**10 with 8.** #60 introduced the `next_action` defect and #62 fixes it. The
ordering above closes the systematic window, but split them and it reopens.

**13 → 14 → 15.** Merge the API removal first and the board renders `UNAVAILABLE`
for every work order the moment the first response arrives without `satisfied`.

### Where migrations are applied, not merged

```bash
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<what the ledger says now> \
  EXPECTED_SHA=<the sha actually deploying> node migrations/migrate.js --apply
```

**A build carrying an unapplied migration REFUSES TO BOOT.** That applies to steps
5 and 9. Merging either without the release variables brings the API down.

### The two that cannot be taken back

```text
 7  activation + inventory   append-only, trigger-enforced. A wrong inventory
                             cannot be edited out.
 9  the sweep's obligations  an accountability fact about a human; the sweep
                             cannot close what it raised. Dry-run first.
```

Everything else on this sheet is a deploy you can revert.

### The instrument

```bash
node tools/release0/where_are_we.js
```

Reports every boundary as LANDED from the database and the running checkout, checks
the stop conditions, and names the next boundary. Exit 1 on any stop condition, so
a script cannot chain past one without noticing.
