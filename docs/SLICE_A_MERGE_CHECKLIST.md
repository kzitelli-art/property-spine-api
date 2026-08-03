# Slice A — merge / reconciliation checklist

**Do not begin any step until the migration-129 activation receipt is clean.**
Nothing here is a feature. This is the exact sequence and the exact commands for
the day 129 is activated.

| | |
|---|---|
| Branch | `claude/sms-work-order-handoff-qo3s8i` |
| SHA that earned 61/61 | `95f13c7` |
| Current tip / merge candidate | `edd6647` — **not proven at this SHA** |
| Base at build time | `main` @ `a792b9f` |
| Migration claimed | **130** (unreleased) |
| Prerequisite | migration **129** activated **and receipted** in production |

---

## ⚠ Two things to know before starting

**1. Reconcile by MERGE, never by rebase.** The branch is pushed and shared. A
rebase rewrites shared history, which the owner ruled against and which
`THREAD_HANDOFF.md` records as a trap that nearly destroyed 19 unmerged commits.
Merge `origin/main` into the branch.

**2. Merging Slice A makes `main` un-deployable again until 130 is released.**
Exactly the 129 pattern: 130 will be in the build and in no ledger, so the verify
gate refuses and Render keeps serving the previous build — production looks
healthy while running older code. This is expected, not a regression, and the fix
is to release 130, not to revert. Sequence it: **merge → release 130 → deploy.**

---

## Step 1 — fetch current `origin/main`

```bash
cd property-spine-api
git fetch origin --prune
git log --oneline -3 origin/main
git rev-list --left-right --count origin/main...origin/claude/sms-work-order-handoff-qo3s8i
```

Record what `main` actually is. If it moved past `a792b9f`, step 2 is a real
merge and step 4 is mandatory rather than confirmatory.

---

## Step 2 — reconcile without rewriting shared history

```bash
git checkout claude/sms-work-order-handoff-qo3s8i
git merge origin/main            # MERGE. Never rebase, never force-push.
```

Conflicts to expect if `main` moved: `src/comms/communications_boundary.js` and
`src/comms/tenantlink.js` are the files Slice A changed. Resolve by keeping both
intents, then re-run step 4 in full — a conflict resolution is a code change and
inherits no prior proof.

---

## Step 3 — confirm 130 is still free and consistent with the live ledger

```bash
# a. repository ceiling and all-branch scan
git ls-tree --name-only origin/main migrations/ | grep -oE '[0-9]{3}' | sort -n | tail -1
for b in $(git branch -r | grep -v HEAD); do
  git ls-tree -r --name-only "$b" migrations/ 2>/dev/null; done \
  | grep -oE '^migrations/[0-9]{3}' | sort -u | tail -3

# b. any branch holding 130 or 131 (docs included)
for b in $(git branch -r | grep -v HEAD); do git ls-tree -r --name-only "$b" 2>/dev/null; done \
  | grep -E '(^|/)(130|131)_' | sort -u

# c. the live ledger — read-only, whole ledger, same decision module as the boot gate
DATABASE_URL="<prod>" node tools/ledger_reconcile.js
```

**Required:** `130` absent from every branch, and `ledger_reconcile.js` exits 0
with `✓ RECONCILED` and applied ceiling **129**.

**If Slice 10B has taken 130:** renumber THIS branch to the next free number. Do
not renumber or overwrite their work. Renaming touches
`migrations/130_communication_lines.sql` and the `M("130_…")` reference in
`tests/communication_lines_slice_a.db.js`; re-run step 4 afterwards.

---

## Step 4 — re-prove on the reconciled tree

Proof does not survive a merge. Re-run everything.

### Runs locally (these harnesses build their own scoped schema)

```bash
export HARNESS_DATABASE_URL="postgresql://postgres@127.0.0.1:55432/postgres"
unset DATABASE_URL

node tests/communication_lines_slice_a.db.js      # expect 61 run · 61 passed · exit 0
node tests/property_line_hardening.db.js          # expect 41 run · 41 passed · exit 0
node tests/migration_ledger_inverse_gate.db.js    # expect 24 run · 24 passed · exit 0
node tests/migration_ledger_verdict.test.js       # expect 40 run · 40 passed · exit 0
node tests/migration_release_gate.test.js         # expect 11 passed · 0 failed
node tests/obligation_engine_one_implementation.test.js   # 14/0
node tests/obligation_engine_import_smoke.test.js
node tests/gate_closure_boundary.js               # PASS
node tests/gate_no_raw_bridge_joins.js            # PASS
```

### ⚠ Requires a provisioned full-schema database — ONE governed command

These five build **no** schema of their own. Run them through the suite runner,
which enforces every precondition and preserves each harness's own evidence and
exit code:

```bash
HARNESS_DATABASE_URL="postgres://…<disposable full-schema branch>…" \
  node tests/slice_a_full_schema_suite.js
```

It refuses to start unless: `HARNESS_DATABASE_URL` is set (no fallback); it does
not resolve to the same target as `DATABASE_URL`; no carrier credentials are
present; `SMS_SEND_MODE=disabled`; and the harness ledger matches this tree in
**both** directions. It prints branch, exact SHA, a dirty-tree warning, and safe
database identity, then runs the five individually with stdio inherited — it
**orchestrates, it does not reinterpret**. First non-zero exit stops the suite and
becomes the suite's exit code.

**This is the highest-risk gap in the merge.** Slice A changed
`resolveInboundSmsContext` — the exact function `resident_sms_route_proof.js`
exercises. Its 31/0 predates that change.

> **"Previously green before the resolver changed" is not evidence for the
> changed resolver.**

**If any of the five cannot execute, Slice A does not merge.**

---

### ⚠ An isolation gap found while building the runner

`work_order_authority_proof.js` and `work_order_canonical_path_proof.js` read
`process.env.DATABASE_URL` **directly** — no `harnessConnectionString()` guard,
no run receipt — and **both COMMIT fixtures**. The convention in
`DB_HARNESS_ISOLATION.md` covers `*.db.js`; these are named `*_proof.js`, so it
missed them. **On Render, `DATABASE_URL` is production.** Run by hand on a box
where it is set, those two write to whatever it points at — the same shape as the
incident that put synthetic rows in the live database.

`slice_a_full_schema_suite.js` closes this at the orchestration layer: it deletes
`DATABASE_URL` from every child environment and re-supplies the already-verified
harness target only to the two that read it.

**Required follow-up, deliberately not done here:** move both to
`harnessConnectionString()`. It was not done in this session because the change
could not be executed to verify it, and shipping a guard that has never run is
the failure this project keeps rediscovering. **Removal condition:** closed when
both call `harnessConnectionString()` and have been executed against a
provisioned full-schema database.

Until then: **never run those two by hand. Use the suite runner.**

---

## Step 5 — merge

```bash
git checkout main
git merge --ff-only claude/sms-work-order-handoff-qo3s8i
git push origin main
```

---

## Step 6 — release 130, then verify startup

```bash
# read the ledger first; 129 must now be applied
DATABASE_URL="<prod>" node tools/ledger_reconcile.js

MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=129 \
EXPECTED_SHA=<merge sha> \
node migrations/migrate.js --apply

DATABASE_URL="<prod>" node migrations/migrate.js     # verify → ceiling 130, exit 0
```

Note the ceiling is **129**, not 128 — 129 will have been applied by its own
activation. If the release refuses on the ceiling, something moved since you
looked; re-inspect rather than override.

Then confirm:

| Check | Expected |
|---|---|
| ledger contains `130` exactly once | name `communication_lines` |
| `communication_lines` populated | one `property_facing` row per property holding a line |
| no operations line created | activation is a separate governed act |
| projection intact | `properties.sms_number` matches the canonical value for every property |
| legacy write refused | a direct `update properties set sms_number` raises |
| verify mode | `✓ SCHEMA VERIFIED`, ceiling 130, exit 0 |
| API starts | Render deploy reaches live |
| deployed identity | `echo $RENDER_GIT_COMMIT` equals the merge sha — not the dashboard label |
| no unrelated migration applied | ceiling exactly 130 |

---

## Proof identity — the rule this checklist exists to enforce

```text
95f13c7   → Slice A implementation proof: 61/61
edd6647   → current branch tip and eventual merge candidate
<merge>   → the SHA the FINAL receipt must attach to
```

`7135e84` and `edd6647` are documentation-only on top of `95f13c7`
(`git diff 95f13c7..edd6647 -- src/ migrations/ tests/ server.js` is empty). That
makes inherited proof *plausible*. It does not make it *evidence*.

**The exact artifact being advanced must be the artifact that earned the proof.**
Re-run at the reconciled SHA. Do not describe any commit as proven 61/61 unless
the suite has run at that exact SHA.

---

## Step 7 — stop and report

**Do not begin Slice B or the technician loop.** Report the receipt with source
SHA, merge SHA, deploy action, deployed identity and verification time as
**five separate facts**.

Then the proof language may move to:

> Slice A is merged and production-active. The authority ceiling is structural in
> production. Slice B, the operations-number activation and the technician loop
> remain unbuilt.

**Not before.** Until every step above is complete the exact statement is:

> Slice A is built and proven on branch `7135e84` (61/61, isolated PostgreSQL
> 16.13 and real HTTP). It is not on `main` and not in production.

---

## The rule that governs what comes next

```text
conversation understands and proposes
  → canonical Property Spine service decides and writes
  → receipt explains the resulting truth
```

**No interpreted message may itself become operating truth.**

After Slice A merges, the next design step is the operations-number activation
and the technician capability boundary — and its **first task is extraction of
the shared conversational seams**, not copying `processInboundClaim`. See
`docs/AGENT_CAPABILITY_SEAMS.md` §5 for the exact extraction trigger.
