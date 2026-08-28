# Release 0 — Activation Tools: read-only hardening

**Date** 2026-08-07 · **Branch** `claude/release-0-audit-plan-55r5kd`

## Why this exists

Three activation tools connect to the **production** `DATABASE_URL`.
`gate_harness_isolation.js` refused them as NEW unapproved consumers, which was
correct. The gate offers two remedies: add an entry to `PRODUCTION_APPROVED`
with a reason, or route through `harnessConnectionString()`. These tools cannot
use a harness connection — proving what production is running is the entire
point — so they take the first path.

But three of the four existing approvals earn their place by **proving** they
cannot write, not by asserting it in prose. These tools run against production,
in the owner's hands, under time pressure. They are held to the same standard.

## What changed

```text
NEW  tools/activation/_readonly.js          the guard
NEW  tools/activation/readonly_falsify.js   15 assertions, real Postgres
MOD  tools/activation/verify_deployment.js  guard + savepoint-per-read + U5 repair
MOD  tools/activation/rotation_proof.js     guard
MOD  tools/activation/signature_controls.js guard on the census connection
MOD  tests/gates/gate_harness_isolation.js        three PRODUCTION_APPROVED entries
```

No production source changed. `src/comms/sms.js` and
`src/technician/evidence_service.js` are byte-identical to the digests
authorized in PR #45.

## The guard

`begin isolation level read committed read only`, then a savepoint-wrapped
`create temporary table` probe, **before any read**. Both lessons this repo has
already paid for are encoded: the probe runs first (a check after the read is a
report, not a guard), and it is savepoint-wrapped (a failed statement aborts the
whole block, and a read-only smoke once aborted itself and reported nothing,
which read as a clean run).

**The isolation level is pinned, not inherited.** `signature_controls.js` holds
this transaction open while production writes through its own governed route,
then counts the rows. At `REPEATABLE READ` the census would be frozen at the
opening snapshot, every control would report "wrote nothing", and a **passing**
security control would be reported as a failure. `READ COMMITTED` does not
weaken the guarantee — read-only is enforced by the transaction's read-only
mode, not by its isolation level.

## Why signature_controls is read-only *and* still writes

Its own connection cannot write and proves it. Control B's write happens
**inside production**, through the governed route, by design. Every assertion in
that script is a delta between two censuses; if the measuring connection could
write, a delta would be ambiguous evidence. Proving the census read-only makes
every row that appears attributable to production by elimination. The
`PRODUCTION_APPROVED` reason says exactly this rather than claiming read-only
without qualification.

## Proof

```text
tools/activation/readonly_falsify.js        15 / 15   exit 0   real Postgres 16
tools/activation/verify_signature_generation.test.js   6 / 6   exit 0
npm run verify (7 source-governance gates)            PASS     exit 0
```

Positive: a real `INSERT` inside the guarded transaction is refused with
SQLSTATE **25006** (`read_only_sql_transaction`) — the code is asserted, not the
message, so it cannot pass on an unrelated error — and the row count is
unchanged afterwards.

Negative, the part that matters: two surgical variants of `_readonly.js` are
compiled **in memory** (the file on disk is never edited, and its digest is
re-checked afterwards). Removing `read only` makes the guard refuse with *"this
transaction ACCEPTED a write"*. Breaking the savepoint makes it refuse with
*"the write probe could not be run"* rather than passing. The guard has been
**observed to refuse**.

Snapshot: a concurrent committed `INSERT` on a second connection **is** visible
to a later read inside the held-open guarded transaction.

## Three defects found by running this

**A negative control that proved nothing.** The first version of the
falsification pre-opened a `READ WRITE` transaction and expected the guard's own
`BEGIN` to be a no-op inside it, on the documented behaviour that `BEGIN` inside
a transaction only warns. Measured, PostgreSQL 16 warns **and still applies the
transaction characteristics** — `transaction_read_only` went `off` → `on`. The
guard refused the probe, so the negative case "passed" backwards and the
condition it claimed to create never existed. Replaced with in-memory variants,
which can actually fail.

**A cascade that would have misreported a rollback decision.** In
`verify_deployment.js` the six post-deploy invariants shared one transaction, so
a single failing read would make the other five report *"current transaction is
aborted"* — five misleading failures from one real one, on the tool that decides
whether to roll production back. Each read is now savepoint-wrapped and reports
`UNREADABLE:<sqlstate>`. Exercised against a database with none of the tables:
six independent failures, each carrying `42P01`.

**An assertion that could not fail.** `U5` read
`base.replace(/\/+$/, "") === base || true` — decoration counted as a check, and
it inflated the pass count. Replaced with a real one: the signed URL is built as
`base + req.originalUrl`, so a **path** in `APP_BASE_URL` is appended rather than
replaced, and `https://host/api` would sign `https://host/api/communications/...`
and fail every message with a correct-looking 403. U5 now passes on a bare
origin, passes with a trailing slash (which the transport strips, reported as a
note rather than asserted), and **fails** on `/api`.

## Deployment note

Nothing under `tools/` is reachable at runtime: no `require` of `tools/` exists
in `server.js`, `src/`, `migrations/` or `package.json`; `prestart` runs
migrations and `start` runs `server.js`. Deploying these files adds no runtime
behaviour and does not change either authorized digest.

They must nonetheless reach the deployed checkout, because Gates 7, 8 and 10 run
them in the Render shell and they are far too large to paste. Node must be able
to resolve `pg` and `twilio`, which it can only do from inside the project tree —
a previous attempt to run from `/tmp` failed for exactly that reason.
