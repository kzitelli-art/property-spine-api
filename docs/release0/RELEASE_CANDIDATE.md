# Release 0 — the release candidate

**One answer to: *what exact source is Release 0?***

```text
branch   claude/release-0-rc
tag      release-0-rc1              (annotated, immutable — a branch tip moves)
```

The PR stack stays open for review and history. **This tree is what runs.** If a
question about Release 0's content cannot be answered by reading this branch, the
question is about something other than Release 0.

This is a naming and proving act, not a new layer. There is no RC tooling, no RC
build step, no RC abstraction — a branch, a tag, and this page.

---

## What is in it

Composed from the six candidate branches, in the production merge order:

| branch | tip at composition | boundary |
|---|---|---|
| `claude/step-5-6-containment` (#57) | `f3daed3` | 6 · 7 — the app's completion control removed, legacy done-path fails closed |
| `claude/step-7-activation-candidate` (#59) | `ec5fb4a` | 8 — census, inventory, activation |
| `claude/step-8-four-state-reader` (#60) | `88b8539` | 9 — the four-state reader |
| `claude/defect-sweep-candidate` (#61) | `43cda06` | 10 — migrations 138 + 139, the §4.2 rail |
| `claude/http-acceptance-candidate` (#62) | `099759d` | 11 — HTTP acceptance |
| `claude/cleanup-candidate` (#63) | `1c2de00` | 13 — `satisfied` leaves the wire |

Plus **migration 140, frozen at revision 5** — the post-activation completion
guard. It lives on `claude/completion-guard` for review of that PR alone; the
bytes here are identical to it, which is checked rather than asserted (see below).

`claude/release0-composed` is the tree this was cut from and stays as the
rehearsal history. The RC is the answer; the composed branch is how it was found.

---

## What makes it the RC rather than a branch that looks like one

**1 · The frozen artifacts are pinned by digest, and the gate bites.**
`docs/release0/FROZEN_ARTIFACTS.json` carries sha256 digests for migrations
138/139/140 and the six source modules that carry the invariant.
`tests/gate_release0_frozen.js` recomputes them on every `npm run verify` and
exits non-zero on any drift. Changing one requires re-running the falsification
package **and** moving the digest **in the same commit**. It has already caught
two real changes this release.

**2 · Migration 140 here is byte-identical to the guard branch.**
Not "the same change" — the same bytes:

```bash
git show origin/claude/completion-guard:migrations/140_post_activation_completion_guard.sql | sha256sum
sha256sum migrations/140_post_activation_completion_guard.sql
# 0d34c0f10799f771cb9ff25f493a3fbd8ea52b280167f22281aad9c018c1dcbe
```

**3 · It is proven as a tree, not as six pieces.**
`tools/step13/rehearse_release_train.js` runs boundaries B3 → B13 in production
order on one clean database and **refuses to start** if Step 6 is not in the tree.
After every boundary it compares three independent answers to the same question —
the DB invariant audit, the canonical reader, and the row's terminal status — and
fails if any two disagree. That check is itself falsified four ways
(`falsify_train_composition.js`), because a check that cannot fail is decoration.

---

## Reproducing the proof

Every harness gets its own clone of the ledger-137 baseline; no harness inherits
another's residue.

```bash
npm run verify                                            # 16 source-governance gates
TRAIN_DATABASE_URL='…'         node tools/step13/rehearse_release_train.js
REVERSIBILITY_DATABASE_URL='…' node tools/step13/prove_boundary_reversibility.js
TRANSITION_DATABASE_URL='…'    node tools/step13/falsify_release_transitions.js
SEQUENCE_DATABASE_URL='…'      node tools/step13/prove_migration_sequencing.js
FALSIFYTRAIN_DATABASE_URL='…'  node tools/step13/falsify_train_composition.js --variant <v>
```

Recorded against this tree: **48 harness runs · 0 non-zero exits · 757
assertions**; 16/16 gates; train 53/53; reversibility 20/20; transitions 26/26;
sequencing 15/15; falsification package 18 runs / 194 assertions; app
`release0_api_capture_consumer` 107/107 and `no_operator_completion_proof` 17/17.

---

## Before it runs

```bash
node tools/release0/preflight_production.js     # read-only. exit 0 / 1 / 2
```

Then `docs/RELEASE_0_ACTIVATION_RUNBOOK.md`, in order. **Boundary 8 is
irreversible** — measured, not inherited: eight undo mechanisms attempted, eight
refused. Boundary 3 is one-way in the direction that matters; reverting Step 3
returns the writer, never the data.

**No build-ahead activation work in this stack has been run against production.**
No deploy, none of 138/139/140 applied, no activation. (Earlier Release 0 work —
the read-only production audit and the Gate 4/8/9 tools deploy — did reach
production; that record stands.)

## What this tree cannot discharge

Named rather than omitted, because a release candidate that implies completeness
it does not have is the same defect as a confident wrong number:

1. **Step 4 over a real handset** — blocked on Twilio. Packaged and rehearsed
   48/48; mechanical when transport clears.
2. **Browser verification** of the four-state block over a post-cutover
   population (§33 makes it part of "done" for operator workflows).
3. **The production run itself.**
4. **Retention / privacy / storage lifecycle** for evidence frozen by R0005 —
   parked deliberately, not solved.
