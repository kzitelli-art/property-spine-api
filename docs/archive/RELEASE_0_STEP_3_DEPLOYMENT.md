# Release 0 — Step 3 deployment: the canonical completion writer

**One production boundary. Code only. No migration.**

Depends on Step 2 being applied and verified in production first. What the writer
*is* and why is in `RELEASE_0_STEPS_2_3_CANDIDATE.md` — including the four
findings from the critical pass. This file is only about getting it live.

---

## Why this deploy is simpler than Step 2

Step 2 had a failed prestart and a restart window because it moved the ledger.
Step 3 moves no ledger, so the deploy gate is satisfied in both directions before
it starts:

```text
$ node migrations/migrate.js        (verify mode, what prestart runs)
  ✓ SCHEMA VERIFIED — 136 migrations, all applied. Ledger ceiling 137.
    (both directions checked: every file is in the ledger, and every
     ledger version has its file)
  exit 0
```

Measured on the Step 3 branch against a database at 137. **No failed deploy, no
window, one clean boundary.** That is the whole reason the migration went first.

---

## Sequence

```text
0  PRECONDITION — Step 2 verified in production
   node tools/steps23/verify_137_applied.js   → L1–L7 green, ledger 137,
                                                zero rows written
   Do not proceed on a remembered result. Re-run it.

1  MERGE THE STEP 3 PR
   → Render builds, prestart verifies clean, the service boots with the
     canonical writer live.

2  VERIFY AND STOP
   The writer is live but nothing has exercised it. Confirm only what is
   true at this point:

     · the service is up
     · ledger still 137, nothing applied by this deploy
     · work_order_proof_evaluations still EMPTY — no completion has
       happened yet, so an evaluation would be a fabrication

3  STOP. The real handset completion proof is a separate step.
```

**Nothing about this deploy proves the writer works in production.** It proves
the writer is *present*. The handset completion is what proves it, and that is
step 5 of the objective, not this one.

---

## The one-way door, and the backstop that is not the plan

`recordEvaluation` **fails closed** with `SCHEMA_MISSING` if migration 137 is
absent, so deploying Step 3 without Step 2 refuses to complete work rather than
completing it without proof.

**That is a backstop, not a sequence.** If it ever fires in production, the
ordering was wrong and technicians are being refused. Check the precondition;
do not rely on the guard.

---

## What changes for a technician the moment this is live

Honest about the behaviour change, because this is the boundary where product
meaning actually moves:

```text
before   "done" + any stored attachment of class repair_photo, condition or
         UNCLASSIFIED closed the work order. No evaluation was recorded.
after    "done" closes it only on evidence that passes the strict gate —
         stored bytes present (content, byte_size, sha256, stored_at), a MIME
         verified against what the carrier SERVED, and the corrected
         classification array with 'unclassified' REMOVED.
         The close now also writes a proof evaluation, the evaluation→
         attachment links, and the obligation closure, all in one transaction.
```

**So some completions that would have succeeded before will now be refused.**
That is the intended change, but it is worth being precise about *which*, because
the strict gate narrows the old one on **four** axes, not one:

```text
1  classification   'unclassified' no longer counts. An unclassified photo is
                    not proof of a repair (§3.1).
2  stored bytes     content, byte_size, sha256 and stored_at must ALL be
                    present. The old gate asked only storage_state='stored',
                    so a row marked stored with no bytes behind it passed.
3  MIME             must be one of the allowed types, verified against what
                    the carrier SERVED. The old gate did not look at MIME.
4  property scope   the query is scoped on (work_order_id, property_id)
                    together. A composite FK already makes the mismatched
                    state unrepresentable, so this is defence in depth and
                    not expected to refuse anything.
```

**Only axis 1 was counted in production.** §3.1 recorded **zero** rows carrying
`unclassified`, so that axis is expected to refuse nothing. **Axes 2 and 3 were
not measured**, and a legacy row marked `stored` from before those columns
existed would be refused by axis 2. I do not know whether any such row exists.

The symptom, if one does, is a technician being told a photo is missing when they
believe they sent one. That is a refusal to **investigate** — read the attachment
row and see which clause rejected it — not a completion to force by relaxing the
gate.

Measuring axes 2 and 3 before this deploy is a read-only production query and a
reasonable precondition to ask for. It is not built here, because it is a Step 3
precondition rather than part of the writer, and nothing about it changes the
code being deployed.

---

## Proof

```text
tools/steps23/prove.js       98 / 98   exit 0   twice, clean baselines
tools/steps23/falsify.js     25 / 25   exit 0   twice, identical
npm run verify (10 gates)    PASS      exit 0
verify mode at schema 137    exit 0    — the deploy boots
```

```bash
bash tools/steps23/baseline_136.sh
PROVE_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/steps23/prove.js

bash tools/steps23/baseline_136.sh
PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
FALSIFY_DATABASE_URL='...' node tools/steps23/falsify.js
```

`tools/steps23/prove_step2_boundary.js` **refuses on this branch, exit 3.** That
is correct: it asks about schema 137 against the *old* writer, which is not the
state this branch describes. Run it at the Step 2 commit.

### What 98/98 does NOT establish

Carried forward unchanged, because a count is not a scope:

```text
NOT proven   any HTTP path. Every assertion calls the service directly. The
             Twilio webhook, tenantlink's transaction wrapper and the receipt
             write are covered by governance gates and by reading source.
NOT proven   any browser. Per §33 this is PROVEN, one rung below done.
NOT proven   production data, Twilio media fetch, or scale.
proven only  the service contract against a real PostgreSQL at schema 137,
             including real overlapping transactions.
```

---

## Rollback

**Revert the code. Leave the schema.**

Migration 137 is additive and the old writer runs against it — proven by
`prove_step2_boundary.js` `O1`–`O3`, which is exactly the reverted state. Dropping
137 would strand any evaluation already written and is never the rollback path.

Evaluations written before the revert stay. They are append-only by design, the
old writer ignores them, and no production reader consults them yet. An orphaned
truthful record is not a defect.

---

## Boundary

```text
included      lifecycle_service (the canonical writer) · evidence_service (the
              strict gate) · proof_evaluation_service (the chain) · the writer
              gate · prove/falsify tooling
NOT included   the four-state reader — nothing reads evaluations yet
NOT included   any activation row, the cutover inventory, the legacy 409
NOT included   retiring the legacy closeout path (Step 6)
NOT included   app changes
```

After this, the next step is the **real handset completion proof** — which needs
the text line confirmed alive. See the open debt at the top of
`THREAD_HANDOFF.md`.
