# Release 0 — from proven candidates to one release sequence

Migration 140 is **frozen at revision 4**. The work from here is not function
correctness; it is **release composition**. The failures that remain are the ones
between boundaries, where every component behaves exactly as specified and the
sequence still goes wrong.

This tracks that conversion. It is a working document, not a claim of completion.

---

## ⛔ THE FINDING THAT BLOCKS THE TRAIN REHEARSAL

**Steps 5/6 have never been in the composed branch.**

```text
claude/step-5-6-containment  (PR #57)   NOT IN claude/release0-composed
claude/step-7-activation-candidate      IN
claude/step-8-four-state-reader         IN
claude/defect-sweep-candidate           IN
claude/http-acceptance-candidate        IN
claude/cleanup-candidate                IN
```

Both #57 and #59 were cut from `main` in parallel; the API stack
`#59 → #60 → #61 → #62 → #63` stacks on #59 and never picked up #57. So:

- **In production the ORDER is fine.** Merging #57 to `main` first, then the
  stack, gives `main` both. The runbook already sequences boundary 7 before
  boundary 8.
- **But the composed end-to-end proof has never run with the legacy writer
  closed.** `prove_release0_composed.js` composes #59–#63 against a checkout where
  `maintenance.js` still writes `status='closed'`.

That is exactly the gap item 3 exists to close, and it cannot be closed by
asserting it — the train rehearsal has to run against a tree that contains #57.

**Recommended:** merge #57 into the composed branch (or rebase the stack onto a
`main` that has it) *before* building the train rehearsal, so the rehearsal
composes what production will actually run. Doing it the other way round would
rehearse a sequence that is missing a boundary.

This was found by the new preflight, which reported `Step 6 · legacy done-path
STILL OPEN` against this checkout — and it is worth noting that the **first**
version of that detector was wrong in the other direction: Step 6 does not delete
the legacy `UPDATE … status='closed'`, it puts an unconditional 409 in front of it
(§1.1.2 — containment, not a permanent ruling). A presence test reported STILL OPEN
against the branch where the path is closed. The detector now tests the **order** —
the `legacy_completion_retired` refusal must precede the write — and is verified
against both branch versions.

---

## 1 · Freeze the artifacts — **DONE**

`docs/release0/FROZEN_ARTIFACTS.json` pins sha256 digests for migrations 138/139/140
and the five source modules that carry the invariant, plus the canonical DB function
names and the R0001–R0005 error vocabulary.

`tests/gate_release0_frozen.js` (runs **second** on `npm run verify`, right after the
conflict-marker gate) recomputes and compares. Falsified: touching the migration
turns F1 red and prints the exact package to re-run.

The freeze is not ceremony. `tools/step12/*` is evidence **about these bytes**;
a changed predicate makes every later green run evidence about something else,
silently. Updating the digest is easy and meant to be — updating it *without*
re-running the package is the thing that is now hard to do by accident.

**Deliberately not** a digest in `assertContainmentGuardPresent`: that checks
substance, because a digest at the irreversible boundary would make a comment edit
a production incident. Different jobs — safety gate vs change control.

---

## 2 · The production preflight — **DONE**

```bash
node tools/release0/preflight_production.js
```

One command. **Read-only by construction**: everything runs inside
`BEGIN TRANSACTION READ ONLY`, which the server enforces, and rolls back. A bug in
it cannot write to production; it can only fail.

Answers, from the real runtime: running SHA · frozen-artifact drift · Step 3 writer
present · ledger ceiling · 138/139/140 applied · activation present/absent ·
epoch present and agreeing with the activation · all seven triggers present,
enabled and deferred · all four guard predicates correct by substance · terminal
population by proof state · the invariant audit · Step 6 legacy path ·
live status vocabulary · whether a writer or idle-in-transaction session makes
activation unsafe right now.

`exit 0` clean · `exit 1` contradiction, do not proceed · `exit 2` could not read.

**It refuses to guess the running SHA.** If `RENDER_GIT_COMMIT`/`GIT_SHA` is absent
it says `UNKNOWN` rather than reporting the local checkout's SHA as production's —
this release has already paid twice for a deploy whose running SHA was not the one
assumed.

---

## 3 · Rehearse the release train — **BLOCKED, see above**

Not built. It should run the production sequence in deploy order on one clean
isolated database, with no shortcuts between branches. It is blocked on the #57
composition gap: rehearsing without Step 6 would rehearse a different release.

---

## 4 · Attack the transitions — **DONE**

```bash
TRANSITION_DATABASE_URL='…' node tools/step13/falsify_release_transitions.js
```

26/26, nine transitions characterised. Each reports **OBSERVED · STATE · RECOVERY**,
and the recovery is the point — "roll back" is not an answer when the boundary is
irreversible.

| | transition | state | recovery |
|---|---|---|---|
| **T1** | 140 applied, deploy never ships | **safe and inert** — no activation, guard returns immediately | none; this is the designed ordering |
| **T2** | build ships, migration not applied | **outage, loud** — prestart exits 1, `REFUSING TO START`; no partial state | migration release, then redeploy |
| **T3** | activation with a writer in flight | **safe** — `WRITERS_IN_FLIGHT` in ~1ms, nothing recorded | wait, **re-run the census**, retry; do not loop |
| **T4** | activation commits, reader deploy fails | **degraded, not damaged** — guard armed and correct, completions work, data right; operators lose the four-state rendering | **roll forward only.** The activation cannot be reversed |
| **T5** | API restarts mid-sequence | **safe** — no process state; every fact read per transaction | none |
| **T6** | old app, new API | **broken surface, intact truth** — `proof.satisfied` is `undefined`, block degrades to blank | strict 13a→13b→13c order; redeploy the app |
| **T7** | new app, old API | reachable only out of order; **fails safe** — normalizer calls it a contract failure, renders unavailable | add-then-consume, consume-then-remove |
| **T8** | guard armed, pre-Step-6 instance still serving | **contained** — the old instance's write gets `R0003`; nothing written, no defect manufactured | finish the rollout; redo the work through the canonical path |
| **T9** | rollback | **140 is reversible. The activation is not.** Dropping the guard works (measured); the audit view keeps reporting violations because it derives from a function, not the triggers | re-apply 140 to restore; resolve named rows by hand |

The single most important line: **everything upstream of boundary 8 is revertible;
nothing downstream of it is.**

---

## 5 · Step 4 live proof — packaged, blocked on transport

`docs/RELEASE_0_STEP_4_PACKAGE.md` and `tools/step4/*` already give
`preflight → handset action → DB assertions → eight facts → HTTP read → receipt`,
rehearsed 48/48 in isolation with every fact falsified. Twilio remains an external
gate. Nothing about the test design should need debugging in production.

---

## 6 · The acceptance receipt — not built

One artifact answering: what was activated · at what instant · what population was
grandfathered · what writer is canonical · what old writers are impossible · what
DB invariant protects completion · what evidence is immutable · what the reader
says · what the operator sees · what remains intentionally outside Release 0.

Most of its inputs already exist as the preflight's read set; it is the same facts
rendered as a durable receipt rather than a go/no-go sheet.
