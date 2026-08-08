# Release 0 — Step 2 deployment: migration 137

**One production boundary. Schema only. No writer, no reader, no behaviour change.**

After this lands, completion means exactly what it meant before. The *capacity*
to record proof exists; nothing records it. `prove_step2_boundary.js` `O4`/`O5`
assert that by running the old writer against the new schema and finding the
evaluation tables empty.

---

## The migration was derived, not authored

`migrations/137_release_0_completion_proof.sql` is the exact DDL bytes of the
artifact the 100k-row scale proof measured:

```text
tools/scale/137_release_0_payload.sql
sha256 ae4b9b774cd9be8568ea24219d4ee4a98350b2bce3a03baf8de33d0cfcc2ea4d
```

Produced by removing that file's own `begin;`/`commit;` and replacing its header.
Nothing else — retyping it would have made the scale proof a statement about a
different file. `tests/gate_migration_137_promotion.js` compares them statement
by statement, 85 units, on every `npm run verify`.

**The wrapper had to come out.** `migrate.js` inserts the `schema_migrations` row
*inside* its transaction. A `commit;` in the migration would land the DDL before
the ledger row, so a crash between them leaves 137 applied with nothing recording
it — the exact split-brain the ledger exists to prevent.

---

## ⚠ THE SEQUENCE IS NOT OBVIOUS. READ THIS BEFORE MERGING.

`prestart` runs `migrate.js` with **no** `--apply`. That is verify-only, and it
refuses to boot on a mismatch **in either direction**. Both refusals are measured
in `prove_step2_boundary.js`, not inferred from reading the script:

```text
D1–D3   file in the build, ledger at 136   → REFUSING TO START, applies nothing
W1–W2   ledger at 137, no file in build    → LEDGER VERSION MISSING FROM THIS
                                              REPOSITORY, refuses to start
```

**A deploy therefore cannot migrate production BY ACCIDENT.** That is deliberate —
migrations 121 and 126 reached production exactly that way, by a branch being
deployed to test it.

It can migrate production *on purpose*, and the runbook below uses that: three
environment variables naming the expected ledger state and the exact build. The
distinction is the whole design. An unconfigured deploy refuses; a deploy carrying
an explicit, pinned authorisation applies. Nothing in between.

Either way Step 2 and Step 3 cannot collapse into one deploy, because Step 3
carries no migration at all.

### The consequence to expect rather than discover

**Merging this PR makes the Render deploy FAIL at prestart.** It will say
`REFUSING TO START` and name `137_release_0_completion_proof`. **This is the gate
working, not an incident.** The old instance keeps serving; nothing is migrated.

That failure is not something to fix — it is the state you apply the migration
from.

---

## ⚠ THIS RUNBOOK REPLACES AN EARLIER ONE

The first version said: merge, let the deploy fail, apply from an external
checkout, then redeploy. That works, but it opens a window where the ledger has
137 and the live build has no file for it — and a restart in that interval
refuses to boot (`W1`/`W2`).

**`migrate.js` already supports a better path, and the support is deliberate.**
APPLY is chosen from the *environment* (`MIGRATION_RELEASE=1`), and when
`RENDER_GIT_COMMIT` is present it additionally demands `EXPECTED_SHA` — a branch
that exists solely to pin a release to one deployed build. So `prestart` *can*
apply, but only for a named commit, authorised by someone who read the ledger.

**One deploy therefore applies the migration and then boots. The window never
opens.** Measured: `A1`/`A2`.

---

## The sequence

```text
0  PICK A QUIET WRITE WINDOW
   Still required: the lock_timeout guard fails the release fast rather than
   queueing behind live writers.

1  MERGE THIS PR
   → Render builds, then FAILS at prestart with REFUSING TO START, naming
     137. Expected. The old instance keeps serving. Ledger still 136.
   → If it says anything else, STOP.

2  SET THREE ENVIRONMENT VARIABLES on the Render service

     MIGRATION_RELEASE=1
     EXPECTED_LEDGER_CEILING=136
     EXPECTED_SHA=<the commit Render is deploying>

   EXPECTED_SHA must be the commit Render actually deploys, not necessarily
   this PR's merge commit — anything merged after it moves the head. A prefix
   is accepted. If it does not match, the release refuses and names both
   values (A4), so a mismatch costs a re-run, not a wrong migration.

3  DEPLOY
   Saving the variables triggers one. prestart now applies 137 and the
   service boots in the same deploy.
   → refuses on the ceiling → something applied migrations since you looked.
     RE-INSPECT, DO NOT OVERRIDE.
   → refuses on a lock timeout → write traffic is not quiet. Wait, redeploy.
     Do not retry in a loop.

4  DELETE THE THREE VARIABLES
   NOT optional. Left set, the NEXT deploy REFUSES on the now-stale ceiling
   and the service does not boot (A3). Deleting them triggers a redeploy,
   which is convenient rather than annoying: it proves the ordinary boot path
   works immediately instead of leaving it to be discovered later (V1).

5  VERIFY AND STOP
     node tools/steps23/verify_137_applied.js

   Read-only and proven read-only. Expect L1–L7 green: ledger 137, four
   tables, two views, ten triggers, four indexes, ZERO rows written, no
   activation row.

   Then stop. Step 3 is a separate boundary.
```

### Why step 4 is a step and not advice

Arming `MIGRATION_RELEASE` is the 121/126 failure mode — a deploy that migrates
production. What the guards actually do about a leftover release env is measured,
not assumed:

```text
A3   stale EXPECTED_LEDGER_CEILING  → next deploy REFUSES, service does not boot
A4   EXPECTED_SHA naming another build → REFUSED, both values printed
A5   EXPECTED_SHA missing on a Render deploy → REQUIRED, refuses
A6   EXPECTED_LEDGER_CEILING missing → REQUIRED, refuses
```

Every failure mode is **loud**. Forgetting to clean up costs a failed deploy, not
a silent migration. That is the right shape — but a failed deploy is still an
outage on the next push, so remove them.

### The out-of-band path, if you ever need it

From a checkout with the production `DATABASE_URL`:

```bash
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=136 \
  node migrations/migrate.js --apply
```

`EXPECTED_SHA` is not required here — it is demanded only when
`RENDER_GIT_COMMIT` is set. **This opens the restart window** (`W1`–`W2`), so
prefer the deploy-time path above. If you are inside that window and the closing
deploy fails, **do not roll the migration back** — 137 is additive and dropping
it would strand anything already written. The only symptom is "cannot restart";
the running instance serves normally. Push forward to a good deploy.

---

## The lock timeout is a control, not a runbook line

```text
default         10s, per migration transaction (set local)
override        MIGRATION_LOCK_TIMEOUT — validated at startup; a malformed
                value EXITS rather than being silently ignored, because a bad
                interval would otherwise mean no timeout at all
on contention   the release FAILS. No retry loop — retrying into live write
                traffic is how a fail-fast guard becomes a slow-motion outage.
```

**Why it is needed:** 137 creates foreign keys referencing `work_orders`, which
takes `SHARE ROW EXCLUSIVE`. An ordinary `INSERT` holds `ROW EXCLUSIVE`. They
conflict, and because PostgreSQL queues lock waiters, a migration waiting on a
long transaction stalls every writer arriving behind it.

Measured, not assumed — the first version of this check asserted "a concurrent
writer still works" and would have shipped a comfortable claim that is false.

```text
concurrent READER held open across the migration   unaffected
concurrent WRITER held open                        BLOCKS the migration
no competing writer                                ~30 ms on empty tables
```

`prove_migration_lock_timeout.js` proves the guard by measurement in **both**
directions, 11/11: refused in ~2.1 s with a writer holding the lock, ledger still
136, no objects created, the live writer's own transaction unharmed; then a clean
apply with no competitor. A guard never observed to fire is indistinguishable
from no guard.

---

## Proof

```text
tools/steps23/prove_step2_boundary.js            22 / 22   exit 0   twice
tools/steps23/prove_migration_lock_timeout.js    11 / 11   exit 0   twice
npm run verify (9 gates)                         PASS      exit 0
```

```bash
bash tools/steps23/baseline_136.sh
STEP2_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/steps23/prove_step2_boundary.js

bash tools/steps23/baseline_136.sh
LOCKPROVE_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/steps23/prove_migration_lock_timeout.js
```

`prove_step2_boundary.js` exists because the Steps 2–3 candidate proved schema
137 against the **new** writer, and that is not the state Step 2 creates. This
branch carries `src/` from `main` untouched — `B1`/`B2` assert that hard — so
`O1`–`O5` prove the actual post-Step-2 combination by running it: the old writer
records a field fact, the savepoint replay still works, the **legacy** completion
path still closes a work order, and the evaluation tables stay empty.

### What this does NOT establish

```text
NOT proven   the migration against production ROW COUNTS. ~30 ms on empty
             tables forecasts nothing about a full work_orders. The scale
             proof measured 100k rows; production is neither.
NOT proven   Neon. These are local PostgreSQL 16 measurements on local disk.
NOT proven   any HTTP path or browser.
proven       the DDL is byte-identical to the measured payload; the deploy
             gate refuses in both directions; the lock guard fires; and the
             old writer is unharmed by the new schema.
```

---

## Rollback

**Rolling Step 2 back does not mean dropping 137.** It is additive, every object
is new, and the old API runs against it — `O1`–`O3`. Dropping it would strand any
evaluation later written and is never the rollback path.

If Step 2 must be undone, revert the *code* PR and leave the schema. The ledger
stays at 137 and the build keeps the file, so the boot gate stays satisfied in
both directions.

---

## Boundary

```text
included      migration 137 · the migrate.js lock timeout · the promotion gate
              · Step 2 proof and deployment tooling
NOT included   the canonical completion writer (Step 3, separate PR)
NOT included   any proof evaluation being written — the tables stay empty
NOT included   the four-state reader, any activation row, the cutover inventory
NOT included   retiring the legacy closeout path (Step 6)
```

Step 3 must not merge until this is applied and `verify_137_applied.js` is green
in production. `recordEvaluation` fails closed with `SCHEMA_MISSING` if 137 is
absent, so the wrong order refuses to complete work rather than completing it
without proof — but that is a backstop, not the plan.
