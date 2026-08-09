# Release 0 — from proven candidates to one release sequence

Migration 140 is **frozen at revision 5**. The work from here is not function
correctness; it is **release composition**. The failures that remain are the ones
between boundaries, where every component behaves exactly as specified and the
sequence still goes wrong.

This tracks that conversion. It is a working document, not a claim of completion.

**Status: the train is build-complete and rehearsed end to end.** What is left is
proof debt that no database read can discharge — named in §7.

---

## ✅ THE FINDING THAT BLOCKED THE TRAIN REHEARSAL — resolved

**Steps 5/6 had never been in the composed branch.**

```text
claude/step-5-6-containment  (PR #57)   NOT IN claude/release0-composed
claude/step-7-activation-candidate      IN
claude/step-8-four-state-reader         IN
claude/defect-sweep-candidate           IN
claude/http-acceptance-candidate        IN
claude/cleanup-candidate                IN
```

Both #57 and #59 were cut from `main` in parallel; the API stack
`#59 → #60 → #61 → #62 → #63` stacks on #59 and never picked up #57. In
production the ORDER is fine — merging #57 first, then the stack, gives `main`
both — but **the composed end-to-end proof had never run with the legacy writer
closed.**

#57 is now merged into `claude/release0-composed` (four files, none of them
frozen). It is composed into the rehearsal tree only; it is **not** merged to
production and **not** activated. The train rehearsal refuses to run without it:

```text
Step 6 (#57) present in the tree — rehearsing the real sequence.
```

Worth preserving: the **first** version of that detector was wrong in both
directions. Step 6 does not delete the legacy `UPDATE … status='closed'`; it puts
an unconditional 409 in front of it (§1.1.2 — containment, not a permanent ruling).
A presence test reported STILL OPEN against the branch where the path *is* closed.
The detector now tests the **order** — the `legacy_completion_retired` refusal must
precede the write — and is verified against both branch versions.

---

## 1 · Freeze the artifacts — **DONE**

`docs/release0/FROZEN_ARTIFACTS.json` pins sha256 digests for migrations 138/139/140
and the five source modules that carry the invariant, plus the canonical DB function
names and the R0001–R0006 error vocabulary.

`tests/gate_release0_frozen.js` (runs **second** on `npm run verify`, right after the
conflict-marker gate) recomputes and compares. Falsified: touching the migration
turns F1 red and prints the exact package to re-run.

The freeze is not ceremony. `tools/step12/*` is evidence **about these bytes**;
a changed predicate makes every later green run evidence about something else,
silently. Updating the digest is easy and meant to be — updating it *without*
re-running the package is the thing that is now hard to do by accident. It has
already worked twice: the gate went red on its own after the E1 fix and again
after the correction-chain fix, and both digests moved only behind a re-run.

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

## 3 · Rehearse the release train — **DONE**

```bash
TRAIN_DATABASE_URL='…' node tools/step13/rehearse_release_train.js     # 53/53
```

The production sequence, in deploy order, on one clean isolated database, with no
shortcut between branches: **B3 → B5 → B6 → B7 → B7b → B8 → B9 → B10 → B11 → B12 → B13**.
It refuses to start if Step 6 is not in the tree.

| | boundary | what actually runs |
|---|---|---|
| **B3** | Step 3 — the canonical writer | `claimCompletion` records the evaluation and the status change in one transaction |
| **B5** | Step 4 — the eight completion facts | asserted over a governed completion, not a fixture |
| **B6** | Step 5 — the app cannot complete | the app's own `no_operator_completion_proof.test.js`, 17/17 |
| **B7** | Step 6 — the legacy done-path fails closed | over a real socket, not a source grep |
| **B7b** | migration 140 | applied **before** the activation, deliberately: T1 says an inert guard is the safe ordering |
| **B8** | Step 7 — census, inventory, activation | ⚠ **IRREVERSIBLE** |
| **B9** | Step 8 — the four-state reader | over the post-cutover population |
| **B10** | migrations 138 + 139 | the §4.2 defect rail |
| **B11** | the contract as a consumer receives it | over the socket B7 opened |
| **B12** | the app's normalizer | over a body this run produced |
| **B13** | cleanup | `satisfied` has left the wire; `state` is the field of record |

**The composition check is the point, not the boundary count.** After *every*
boundary the train runs `oneTruth(label)`, which compares three independent
answers to the same question — the DB invariant audit view, the canonical reader,
and the terminal status of the row — and fails if any two disagree. That is the
check the owner asked for: *whether we ever create two meanings of truth*, not
whether each service is individually green.

**It found one.** See §3b below.

### …and the composition check is itself falsified

```bash
FALSIFYTRAIN_DATABASE_URL='…' node tools/step13/falsify_train_composition.js --variant <v>
```

Fifty-three green assertions do not establish that `oneTruth` can go red, and this
release has already been bitten by exactly that — the Step 7 concurrency proof
measured a simulation and passed after a lock was added that it never looked at. So
a divergence is manufactured on purpose and the **shipped, byte-identical** train is
required to notice. The fault is injected into the train's dependencies by
`_train_fault.js` via `--require`, not by a flag inside the train.

| variant | injected | must go red |
|---|---|---|
| `honest-control` | nothing | **nothing** — exit 0, no FAIL lines |
| `guard-dropped` | a real hollow completion, both witnesses honest | **Z1** only. They *agree* it is wrong, so the agreement assertion stays silent — which is what proves the two checks are complementary, not redundant |
| `reader-blind` | the same row; the reader calls it `satisfied` | the **agreement** assertion |
| `audit-blind` | the same row; the audit view emptied | the **agreement** assertion, from the other direction |

Each variant also asserts it failed for the *right* reason. What the train prints:

```text
FAIL  §T  after B8 — the guard is now ARMED: the DB audit and the canonical
          reader name the same rows
      → audit ["2774…d94a"] vs reader [] — TWO MEANINGS OF TRUTH. The database
        and the surface disagree about which work orders are wrong, which is
        worse than either being wrong alone.
```

It fires at the boundary where the divergence appears, not at the end.

---

## 3c · The migration sequence, run through the real runner

```bash
SEQUENCE_DATABASE_URL='…' node tools/step13/prove_migration_sequencing.js   # 15/15
```

The runbook orders schema by **boundary**; `migrations/migrate.js` orders it by
**file present in the build**. Those are not the same rule, and the difference is
only visible from a real ledger. Two findings, both measured by spawning the shipped
runner:

1. **Boundary 10's documented command was refused verbatim.** It hardcoded
   `EXPECTED_LEDGER_CEILING=137` — the ceiling *before the release starts*. Boundary
   7b applies 140 and moves the ceiling to 140, so the runner answered
   *"You expected ceiling 137; the database says 140."* The gate was right; the
   document was wrong. Fixed, and boundary 7b already had it right.
2. **The two-release split is a property of the merge order, not of the boundary
   numbering.** On the composed tree all three migrations are pending in one deploy,
   so a single release applies 138, 139 and 140 together. That is safe — 138 is an
   index, 139 widens a check constraint, neither writes a row, and the sweep is
   manual — but it means `where_are_we.js`, not the boundary list, is the authority
   on where you actually are. Now stated in the runbook.

Neither is an invariant failure. Both are the kind of thing that only shows up when
you run the real thing in the real order, which is what the rehearsal is for.

---

## 3b · E1 — the composition failure the rehearsal found

`update release_0_activation_epoch set activation_id = null` **succeeded**, and it
was the worst-shaped defect available:

- the guard read the epoch, found `null`, and returned early — **inert**;
- `release_0_activation_current` still reported an activation — **activated**;
- so the surface classified every terminal row against the invariant and the
  database judged none of them.

Demonstrated end to end, not argued: the guard refuses a bad write while the epoch
is stamped; the *identical* write commits once the epoch is nulled; the reader then
calls the result `missing_evaluation_defect`. **Two meanings of truth from one
UPDATE**, and no error anywhere.

Migration 140 revision 5 gives the epoch the append-only discipline the other two
truth tables already had (R0006).

The first freeze written for it was **too blunt** — it also refused Step 7's
governed supersession, so a legitimate correction could no longer move the epoch to
the new head (`prove_step7_activation` O4, `prove_step7_concurrency` R4/R6 went red
and were right to). That is the same mistake the evidence freeze was explicitly
warned about, one table over: *a gate that fails the fix is worse than no gate.*
The shipped rule refuses any **clear** and any **repoint**, but permits movement to
an activation that actually supersedes the incumbent:

```sql
and not exists (select 1 from release_0_activation_history h
                 where h.id = new.activation_id
                   and h.supersedes_id = old.activation_id)
```

---

## 4 · Attack the transitions — **DONE**

```bash
TRANSITION_DATABASE_URL='…' node tools/step13/falsify_release_transitions.js   # 26/26
```

Nine transitions characterised. Each reports **OBSERVED · STATE · RECOVERY**,
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

---

## 4b · Reversibility, measured per boundary — **DONE**

```bash
REVERSIBILITY_DATABASE_URL='…' node tools/step13/prove_boundary_reversibility.js   # 20/20
```

The runbook's claim was *"everything before boundary 8 is revertible."* That
sentence is **true about code and false about meaning**, and the difference is the
whole risk. Each boundary now answers four questions from measurement:

| | CHANGED | ROLLBACK | IN FLIGHT | SEMANTICS |
|---|---|---|---|---|
| **B3** | code **+ rows**, no DDL | the **code** yes; the **rows** no | nothing — a redeploy does not touch open transactions | ⚠ **code only.** Evaluations already written are append-only. "Revert Step 3" returns the writer, never the data |
| **B7** | code only (one 409 ahead of the legacy write) | fully | nothing — the route refuses before opening a transaction | restored **before** the activation. **After** it, reverting restores the ROUTE but not its EFFECT: 140 refuses post-cutover `closed` with R0003 whichever build serves. **Reversible in isolation, not in sequence** |
| **B7b** | DDL only — 1 table (1 row), 9 functions, 7 guard triggers + the stamp trigger, 1 view; **no existing row modified** | fully, measured **both ways**: drop the triggers → disarmed; re-apply → restored | a concurrent writer is unaffected; deferred checks apply only to transactions committing after | restored completely while inert. Dropping the triggers does **not** silence the audit view — it derives from a function |
| **B8** | **rows** in two append-only tables + the epoch stamped in the same transaction. No DDL | ❌ **not possible** — 8 undo mechanisms attempted, **all refused** | the activation refuses to run while a writer holds `work_orders` (NOWAIT); once committed, older in-flight transactions are refused at *their* commit (40001) | ❌ **irreversible in both senses.** No old code to return to and no old meaning to restore |
| **B9–B13** | code only; 138/139 add additive DDL and write no rows | fully | nothing — read paths and a manually-run rail | restored, with one honest caveat: reverting the **reader** after the activation shows pre-Release-0 surfaces over post-cutover truth. That is T4 — roll **forward** |

The eight refusals at B8, each with the message that stopped it: DELETE the
activation · UPDATE the activation instant · DELETE the inventory · UPDATE the
inventoried status · INSERT a second genesis · reset the epoch (E1) · repoint the
epoch · DELETE the epoch row.

> **B8 is the line.** Above it, a redeploy undoes the boundary but never the rows
> it wrote. Below it, nothing undoes anything.

---

## 5 · Step 4 live proof — packaged, blocked on transport

`docs/RELEASE_0_STEP_4_PACKAGE.md` and `tools/step4/*` already give
`preflight → handset action → DB assertions → eight facts → HTTP read → receipt`,
rehearsed 48/48 in isolation with every fact falsified. Twilio remains an external
gate. **Nothing about the test design should need debugging in production** — when
the transport clears, this is a mechanical run, not a build.

---

## 6 · The acceptance receipt — **DONE**

```bash
node tools/release0/acceptance_receipt.js            # human
node tools/release0/acceptance_receipt.js --json     # durable
```

Read-only by the same construction as the preflight. Every field is either a fact
this run observed or the word `UNKNOWN` **with the reason** — there is no field
that defaults to a hopeful value, and it refuses to report the local checkout's SHA
as production's.

It states, from evidence: what was activated · at what instant · what population
was grandfathered · what writer is canonical · what old writers are impossible ·
what DB invariant protects completion · what evidence is immutable · what the
reader says · what remains intentionally outside Release 0.

**It also detects contradictions inside itself and exits 1** — the three that
matter: 140's DDL present but the ledger not recording it (applied by hand; the
next deploy will refuse to boot), an activation recorded against an unstamped epoch
(the E1 shape), and a non-empty invariant audit.

Its own first version had exactly the defect it now catches: it used `to_regclass`
to look for the canonical **function**, and `to_regclass` finds relations. It
printed "the validator is not installed" one line above "guard ARMED."

**And it caught a real one on its first honest run.** Against a fully rehearsed
database it reported *"migration 140's DDL is PRESENT but the ledger does not record
it as applied"* — because the train applied migration SQL directly and never wrote
the ledger. In production that pair means schema applied by hand, and the next deploy
refuses to boot. The train now records the ledger the way a migration release does,
so the rehearsal leaves behind the state production leaves behind.

`docs/release0/REHEARSAL_RECEIPT.json` is that receipt, preserved. **It is not
production** — it is the shape the production receipt will take, captured now so any
difference is visible rather than argued. Zero contradictions; one honest `UNKNOWN`
(the running SHA, which only the deployed instance can answer).

---

## 7 · What Release 0 does **not** yet have

Precise remaining proof debt. None of it is dischargeable from a database read,
which is why the receipt names it rather than omitting it:

1. **Step 4 over the real handset** — blocked on Twilio, packaged and rehearsed.
2. **Browser verification of the four-state block** against a post-cutover
   population (§33 requires it for operator workflows).
3. **The production run itself.** Everything above is rehearsal on isolated
   Postgres clones. **No build-ahead activation work in this stack has been run
   against production** — no deploy, none of 138/139/140 applied, no activation —
   and it must not be until the owner runs it. Stated that way on purpose:
   earlier Release 0 work (the read-only production audit under Open Ruling 4,
   the Gate 4/8/9 tools deploy) *did* reach production, and "Release 0 has not
   touched production" would be false.
4. **Retention / privacy / storage lifecycle** for evidence frozen by R0005 —
   parked deliberately (`RELEASE_0_COMPLETION_GUARD.md` §11), not solved.
