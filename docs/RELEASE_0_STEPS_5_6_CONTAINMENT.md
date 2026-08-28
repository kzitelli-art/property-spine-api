# Release 0 — Steps 5 & 6: containment

**⛔ BUILD-AHEAD. NEITHER STEP MAY DEPLOY UNTIL STEP 4 PASSES.**

Step 4 is the real-handset completion proof, and it is blocked on SMS transport.
This is built, proven and falsified now so that when the gate opens the question
is whether to deploy a proven package — not what still needs building. §5.6 of
the implementation plan explicitly permits exactly this: *"MAY PROCEED NOW —
isolated proof, documentation and runbook preparation."*

```text
STEP 5   APP — remove the operator completion control    property-spine-app
STEP 6   API — the legacy done-path fails closed         property-spine-api
```

---

## ⚠ WHY THE GATE SURVIVES EVEN THOUGH THE CONTROL IS ALREADY DEAD

The plan is blunt about this and it is the single most important line here
(§5.5):

> **Unreachable code is recoverable; retired code is not.** Until a real
> replacement rail exists, keep the option.

The legacy operator completion path is *already* unreachable in production, and
the SMS rail has no configured transport. So production has **no usable
completion path right now**. Retiring the dead one before the live one is proven
converts "temporarily unreachable" into "permanently gone" while nothing has
replaced it.

Step 5's *justification* changed — it is cleanup of a dead path, not the removal
of a live one. Its *gate* did not.

---

## Step 6 — the API refuses, and writes nothing

`PATCH /work-orders/:id/closeout` with `done` anything but `false` now returns:

```json
{
  "error": "legacy_completion_retired",
  "message": "This path can no longer complete a work order. Completion is
              recorded by the technician in the field, through the operations
              text line, which writes the proof evaluation and the completion
              event in one transaction.",
  "canonical_path": "technician/lifecycle_service.claimCompletion",
  "still_available": "PATCH /work-orders/:id/closeout with done=false — log a
                      reason and route the follow-up. That path is unchanged.",
  "wrote": null
}
```

### The refusal is in front of `pool.connect()`, deliberately

"Writes nothing" is a claim. Refusing before the pool is touched makes it a
property of the code path: **no transaction is opened, no row is locked, and
there is no ordering in which a write could precede the refusal.** A guard after
the lock would have to be trusted; this one cannot be wrong.

`gate_completion_writers.js` `D2` asserts the *position*, not just the presence —
scoped to this route, because the first version of that assertion searched the
whole file, found some other route's `pool.connect()`, and made a correctly
placed guard look misplaced.

### What is NOT retired

The **not-done path is untouched**. That is the paired control: it is what proves
this 409 is a governed refusal of one verb rather than a dead route, a broken
mount or a lost database. `closeoutNotDone` is not a completion and survives
permanently.

### The dead branch stays in the file until Step 9

The `update work_orders set status='closed'` below the guard is now unreachable
and is **left there on purpose**. Step 9's separate cleanup release deletes it.
Same reasoning as the gate above: unreachable is recoverable, deleted is not.

The register in `gate_completion_writers.js` records it as
`RETIRED — UNREACHABLE DEAD CODE` with that removal condition, so the entry
cannot rot into an implied control that is not there.

---

## Step 5 — the app stops declaring completion

Removed: `Mark done — close`, `attachStubPhoto`, `woStubPhotos`, `closeoutDone`,
and the `woPhotoState` element.

That control minted `stub://closeout-photo/<id>/<ts>` and handed it to the API as
`completion_photo`. The API stored the string. **Nothing ever held bytes**, so no
later process could turn one into proof — and a work order closed on one was
indistinguishable, afterwards, from one closed on a real photo.

Deleted rather than disabled: a fabricated-evidence helper left in the file is
one call site away from being live again.

### The panel is renamed, not emptied

A box still headed *"Close it out"* that cannot close anything is a worse lie
than the button was — it tells the operator their job is unchanged and only the
mechanism broke. It now states what it does (route work that is **not** done) and
where completion actually happens.

### §1.1.2 — what this does NOT rule

This is Release 0 **containment**, not a permanent doctrine that operator
completion authority is abolished. A governed operator or manager acceptance
surface may well be right later — vendor work, SMS outages, supervisory
inspection, higher-risk clearance — distinguishing who may report completion, who
may provide evidence, who may accept the work, and who grants final clearance.

**That is a later product ruling. It is not invented inside Release 0.**

---

## Proof

```text
API   tools/step56/prove_step6_legacy_closed.js    19 / 19   exit 0
      npm run verify (10 gates)                    PASS      exit 0
APP   no_operator_completion_proof.test.js         17 / 17   exit 0
```

```bash
# API — real Express app, real socket, real PostgreSQL at schema 137
bash tools/steps23/baseline_136.sh
PROVE_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/steps23/apply_137.js
STEP6_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/step56/prove_step6_legacy_closed.js

# APP — parses index.html, no database or network
node no_operator_completion_proof.test.js
```

### Step 6 is proven through HTTP, not source

The claim is about a **route**, so real requests go over a real socket to a real
Express mount backed by real PostgreSQL. The dependency graph is constructed the
way `server.js` constructs it — an earlier revision passed the work-order *module*
where the router wanted a *service instance* and the router refused, which is the
mount contract doing its job and is why this proof does not stub the mount. **A
proof against a stubbed mount is a proof about the stub.**

`"wrote nothing"` is measured, not asserted: a full census — status,
`completion_photo`, events, progress rows, evaluations, open obligations — is
taken before and after every refused request and compared as a whole.

```text
R1–R8   the exact legacy request, a caller that OMITS `done`, and a
        done-request with no photo/note: all 409 legacy_completion_retired,
        census identical before and after
P1–P4   done=false still succeeds, routes the work, spawns the follow-up
        obligation, and still 400s an invalid reason — unchanged
C1–C3   the canonical writer still completes, with the evaluation the legacy
        path never wrote, and closes the obligation
F1–F3   FALSIFICATION: with the guard removed in memory, the same request
        closes the work order, with NO evaluation, on a stub:// photo
Z1      maintenance.js is byte-identical after the run
```

`R8` is worth naming: a done-request with no photo used to 409 for *missing
proof*. It must now 409 for *retirement*, because telling an operator to attach a
photo implies that attaching one would work.

### Step 5's app test, and its falsification

`S1` asserts **every inline script still parses**, first, before anything else.
This change deleted two functions and a const out of one enormous inline script,
and a syntax error there does not break the closeout panel — it fails the whole
script and the app renders dead. That exact failure was found in production on
2026-08-08 in the tenant setup page, and nothing caught it because every check
read the source instead of parsing it.

**Falsified:** with the control restored on a copy, **6 of the 7** absence
assertions fail. `C5` (`woPhotoState`) was **not** exercised — the restoration
did not put that span back. That is a gap in the falsification, not in the test,
and it is recorded rather than rounded up.

### What this does NOT establish

```text
NOT proven   the browser. Step 5's DEPLOY line requires browser verification
             that no app path completes a work order and that the not-done
             path still does. That is not done here.
NOT proven   production. No production request was made; the API proof runs
             against an isolated PostgreSQL.
NOT proven   that Step 4 passed. It has not. Both steps are gated on it.
```

---

## Deployment order, when the gate opens

```text
0  STEP 4 MUST HAVE PASSED — real handset, real photo, real completion
1  APP  step 5 deploys first. Browser-verify no app path completes a work
        order and that the not-done path still does.
2  API  step 6 deploys second.
```

**Order matters.** If the API refuses first, the app still shows a completion
control that now fails — an operator-visible dead end. App first means the
control is gone before the route that served it stops answering.

§5.4 lists the further preconditions before the *activation instant* is captured
(app step 5 live, API rollout complete not merely started, old instances drained,
no in-flight legacy request able to commit, a bounded wait). **None of that is in
scope here** — Step 7 is not built and must not be, per the owner's standing
instruction not to run activation or the cutover inventory.

## Rollback

Both are code-only and independently revertible. No schema, no data.

Reverting Step 6 restores a writer that can close a work order with no proof —
so it is a rollback of last resort, and it is *not* the response to the app
showing a stale control. That is a Step 5 problem with a Step 5 fix.

---

## Logged and parked

Found while doing this, not pursued — none blocks correctness or safety here:

```text
· the same stub:// fabrication pattern exists in the INSPECTION surface
  (inspAttachPhoto, and seeded inspection findings). Different domain, not
  work-order completion, not Release 0. It is the same class of defect and
  deserves its own governed slice.
· property-spine-app has ~20 *.test.js files at the repo root and no runner
  registering them. A gate nobody invokes is documentation — the exact
  failure the API's verify_source_governance.js exists to fix.
· tests/unit/tenant_setup_page_parses.test.js (API) is not registered in
  verify_source_governance.js, so it runs only if someone remembers.
```
