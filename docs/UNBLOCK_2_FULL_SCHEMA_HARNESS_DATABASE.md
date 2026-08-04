# UNBLOCK PACKET 2 — the full-schema harness database

**For an authorized operator. Self-contained: you do not need the thread that
produced this.**

---

## What this clears

Five harnesses build **no schema of their own**. They assume a complete database,
so they cannot run against the scoped fixtures the Slice A harness builds — and
they were therefore **never executed against the Slice A changes**.

That matters specifically: Slice A changed `resolveInboundSmsContext`, the exact
function `resident_sms_route_proof.js` exercises. Its 31/0 predates the change.

> **"Previously green before the resolver changed" is not evidence for the
> changed resolver.**

The same database also unblocks repairing the two unsafe harnesses, which is a
**merge requirement** for Slice A.

---

## 1. Required database

| | |
|---|---|
| Engine | **PostgreSQL 16.x** (16.13 is what every local proof used) |
| Provisioning | a **disposable branch of production**, or an equivalent full-schema copy |
| Lifetime | disposable — these harnesses **COMMIT** fixtures and do not clean up |
| Must NOT be | production, or any database another service reads |

**Why a branch of production rather than a rebuilt schema:** the migration chain
**cannot rebuild from an empty database**. `012_bank_intake.sql` fails on
`column "yardi_code" does not exist`, reproduced against real Postgres 16.13 —
`create table if not exists vendors` silently discards every column when the
table already exists. That is a known, owned defect (Appendix H,
`DB_CONNECTION_INVENTORY.md`) and it is **not** this packet's job to fix. It is
the reason "just build a fresh schema" is not an option.

## 2. Required migrations present

The harness database must match the tree being proven, **in both directions**.
Verify with the same decision module the boot gate uses:

```bash
DATABASE_URL="<harness>" node tools/ledger_reconcile.js
```

Required: `✓ RECONCILED`, exit 0, with **129 and 130 applied** (130 arrives with
Slice A). The suite runner enforces this itself and refuses to start otherwise —
a proof run against a schema the code does not match proves nothing.

## 3. Required environment

```bash
export HARNESS_DATABASE_URL="postgres://…<disposable full-schema branch>…"
unset DATABASE_URL          # never leave an ambient production URL in scope
```

**`HARNESS_DATABASE_URL` only. There is deliberately no fallback to
`DATABASE_URL`.**

## 4. Production-target refusal

Everything refuses to start if the harness target resolves to the **same
host / port / database** as `DATABASE_URL` — compared as a target, not as a
string, so a different user or a trailing `sslmode` cannot defeat it.

The suite runner additionally refuses when carrier credentials
(`TWILIO_*`, `SMS_ACCOUNT*`, `MESSAGING_SERVICE*`) are present, or when
`SMS_SEND_MODE` is anything but `disabled`. **It will not set that for you** —
silently disabling a send mode is the runner deciding what the evidence means.

---

## 5. FIRST — repair the two unsafe harnesses (merge requirement)

```text
tests/work_order_authority_proof.js
tests/work_order_canonical_path_proof.js
```

Both read `process.env.DATABASE_URL` **directly** — no guard, no run receipt —
and **both COMMIT fixtures**. On Render that variable is production. The suite
runner contains this at the orchestration layer, but **containment is not
repair**: run either by hand where `DATABASE_URL` is set and it writes to
whatever it points at.

Each must, after repair:

- require `HARNESS_DATABASE_URL`;
- have **no fallback** to `DATABASE_URL`;
- refuse when the harness target matches production;
- print safe database identity, branch and exact SHA;
- print assertion-start and assertion-complete receipts;
- preserve its own exit code;
- use no real transport or reachable phone numbers.

Then run each **directly** *and* **through the suite runner**. Both must pass
both ways.

**Do not patch them before this database exists.** A guard that has never
executed is a claim, not a control — the failure this repository has recorded
three times.

When repaired, **remove both entries from `FROZEN_INVENTORY`** in
`tests/gate_harness_isolation.js`; the gate fails if a repaired entry is left
behind, so the register shrinks honestly.

---

## 6. THEN — the five required full-schema harnesses

One governed command:

```bash
HARNESS_DATABASE_URL="postgres://…" node tests/slice_a_full_schema_suite.js
```

```text
resident_sms_work_order_proof.js
resident_sms_route_proof.js
work_order_authority_proof.js
work_order_canonical_path_proof.js
operator_obligations_security_proof.db.js
```

The runner **orchestrates; it does not reinterpret.** Children run with stdio
inherited so each harness's own evidence reaches the terminal unmodified; the
first non-zero exit stops the suite and becomes the suite's exit code. There is
no `--continue` and no path that turns a red harness green.

**If any of the five cannot execute, Slice A does not merge.**

## 7. Cleanup

- The database is **disposable** — the harnesses commit fixtures and never clean
  up. Delete the branch after the run; do not reuse it for a later proof.
- **Never point these at production**, and never at a database another service
  reads.
- The suite runner creates and drops nothing outside its own children; the
  Slice A harness creates and drops its own scratch database.

---

## 8. Success receipt

```text
DATABASE     PostgreSQL ____   branch/endpoint ____________  (sanitized)
LEDGER       tools/ledger_reconcile.js   exit ____   RECONCILED? ____
               applied ceiling ____ (expect 130)

REPAIRED     work_order_authority_proof.js
               direct run      exit ____   assertions ____ / ____
               via runner      exit ____
             work_order_canonical_path_proof.js
               direct run      exit ____   assertions ____ / ____
               via runner      exit ____
             FROZEN_INVENTORY entries removed?  ____

SUITE        tests/slice_a_full_schema_suite.js   exit ____
               resident_sms_work_order_proof.js          exit ____
               resident_sms_route_proof.js               exit ____
               work_order_authority_proof.js             exit ____
               work_order_canonical_path_proof.js        exit ____
               operator_obligations_security_proof.db.js exit ____

branch ________   exact SHA ________   tree clean? ________
run at ________
```

## 9. Failure receipt

Report the **first** failure and stop; do not continue past it.

```text
FAILED       harness ____________________
             exit code ____   (the harness's own, preserved)
             harnesses NOT RUN ____
             evidence: <the harness's own output, unmodified>
```

A refusal (`exit 2`, nothing executed) is **not** a failure of the code under
test — it means a precondition was not met. Fix the precondition and re-run;
do not work around the refusal.

---

## 10. What this does NOT clear

Slice A still additionally requires: **migration 129 activated** (Packet 1), the
branch reconciled with current `main`, **130 confirmed still free**, and every
local *and* full-schema proof run at the **exact final branch SHA** that merges.

The remaining **85** unguarded scripts in the frozen debt register are not
touched here. Their remediation is its own governed slice after Slice A, and it
must not be a mass textual replacement — that would create 85 unexecuted safety
claims.
