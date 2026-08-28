# Parallel build silos — two workstreams, one repository

Two builds are running against `property-spine-api` at once. They do not
conflict often, but where they touch they touch **production**, so the boundary
is written down rather than remembered.

```text
SILO A   RELEASE 0 — completion truth
         migration 137 (DONE) · the canonical completion writer · proof
         evaluations · the four-state reader (later)

SILO B   TEXT LINE — A2P 10DLC registration
         tenant consent capture · the public legal pages · Twilio campaign
         registration and the two open carrier errors (30896/30907, 30034)
```

**Neither silo edits the other's files. Neither silo answers for the other's
production state.** If a change needs both, it stops and is agreed first.

---

## Files, by owner

```text
SILO A ─ Release 0
  migrations/137_release_0_completion_proof.sql
  src/technician/lifecycle_service.js
  src/technician/evidence_service.js
  src/maintenance/proof_evaluation_service.js
  tests/gates/gate_completion_writers.js
  tests/gates/gate_migration_137_promotion.js
  tools/steps23/**
  tools/scale/**
  docs/RELEASE_0_*

SILO B ─ text line
  src/identity/legal_routes_block.js
  server.js            (the legal-routes mount only)
  docs/  A2P / consent / campaign documents
```

### The one genuinely shared file

**`src/comms/tenantlink.js`.** It holds two unrelated things, and the split is
by region, not by file:

```text
SILO B   the TENANT SETUP PAGE — its markup, its inline script, the consent
         checkbox and disclosure. Resident-facing self-signup.

SILO A   the INBOUND SMS HANDLER — `/inbound-sms`, the operations-turn
         transaction wrapper (`begin` / `runOperationsTurn` / `commit` /
         `rollback`), and its 23505 duplicate-suppression branch.
```

That wrapper is load-bearing for Release 0: the savepoint fix in `appendProgress`
is only safe because the caller rolls back on any throw, and
`prove_progress_replay.js` `T1`/`T2` assert exactly that. **A change to the
inbound handler's error handling is a Silo A change even if Silo B is the one
editing the file.**

---

## Shared surfaces, and the rule for each

### Migrations — one allocator

```text
ledger ceiling now   137 (applied to production 2026-08-08)
next free number     138
```

Two branches both authoring `138_*.sql` is not a merge conflict — it is a
**number already spent**, and `migrate.js` refuses to run at all when the ledger
name and the file disagree. Whoever takes 138 records it here **before** writing
it. Silo A has no further migration planned; 138 is available to Silo B.

### Render environment variables

```text
SILO B owns    TWILIO_* and anything the text line needs. Permanent.
SILO A owns    MIGRATION_RELEASE / EXPECTED_LEDGER_CEILING / EXPECTED_SHA.
               TRANSIENT — set for one deploy, deleted immediately after.
```

**Saving any variable triggers a deploy.** So the panel is single-user while a
migration release is in flight: a Twilio variable saved during that window
either applies a migration early or fails the deploy on a stale ceiling. Outside
that window the panel is Silo B's.

Silo A holds the panel only during a migration release, announces it, and hands
it back by deleting the three variables.

### `tests/verify_source_governance.js`

Both silos add gates here. It is an append-only list — **on a conflict, keep
both entries.** A gate dropped to resolve a merge is a control silently removed.

### Deploys are shared, always

Render deploys `main`. There is no per-silo deploy. So **every merge ships
whatever the other silo has already merged**, and each PR must be independently
safe rather than safe-in-a-particular-order.

The 2026-08-08 migration deploy is the worked example: `e8d6143` carried
migration 137 *and* Silo B's tenant-page fix, legal routes and consent gate. That
was checked before it shipped — no second migration, and nothing touching
`work_orders` or the inbound handler — rather than assumed.

**Before merging, check what is already on `main` that you did not put there.**

---

## Freezing `main`

A freeze is for **migration releases only**, because those pin `EXPECTED_SHA` to
one commit and any new commit invalidates it.

```text
who       Silo A, and only for a migration
starts    before the three environment variables are set
ends      when they are DELETED — not when the migration applies
signal    say so explicitly; the other silo should not infer it
```

Silo B does not need a freeze. Its deploys carry no schema.

---

## What each silo may claim about production

Neither silo speaks for the other's state, and neither infers it.

```text
SILO A may say    migration 137 is applied and inert (verify_137_applied.js,
                  7/7, read-only proven, run in production 2026-08-08)
SILO A may NOT    that the text line works, that a technician receives a reply,
                  or that A2P registration is progressing
SILO B may say    what the carrier console and the browser show
SILO B may NOT    that a completion is recorded, that an evaluation exists, or
                  that Release 0 has advanced
```

### The overlap that is real

**Release 0's remaining verification depends on Silo B finishing.** The savepoint
fix and the completion writer both need a live text line and a real handset to
reach "done" on the §33 ladder. That debt is recorded at the top of
`THREAD_HANDOFF.md`.

That is a **dependency, not a merge**: Silo A does not work on Twilio, and Silo B
does not deploy Release 0 code to unblock it. Silo A waits, and says it is
waiting.

---

## Current state, 2026-08-08

```text
SILO A   137 applied and verified in production, inert
         PR #54 (the writer) OPEN AS DRAFT — not merged, not deployed
         PR #55 (Step 2 runbook correction) open, docs only
         owed: SMS verification of the savepoint fix, blocked on Silo B

SILO B   e8d6143 live: tenant setup page fixed, /legal/privacy and
         /legal/sms-terms mounted, consent gate shipped
         open: 30896/30907 campaign resubmission, 30034 number registration
```
