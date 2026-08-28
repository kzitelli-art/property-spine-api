# Release 0 — morning handoff

> ## ⚠ SUPERSEDED — 2026-08-06, design review
>
> **This brief is no longer the governing state, and its gate statement is
> wrong.** It says credential rotation is the only remaining gate. It is not.
>
> **The accurate state:**
>
> ```text
> credential rotation      BLOCKS implementation, runtime changes,
>                          deployment, and merge
> architecture-plan        CORRECTED in revision 2 of
>   correction             RELEASE_0_IMPLEMENTATION_PLAN.md (8 findings)
> app source audit         COMPLETE — RELEASE_0_APP_CLOSEOUT_AUDIT.md
> evidence-source decision OPEN — owner decision, plan §5.0
> PR #43                   NOT approved for merge
> product code / migration MAY NOT BEGIN until BOTH the design corrections
>                          are accepted AND rotation is complete
> ```
>
> Current governing documents:
> [`RELEASE_0_IMPLEMENTATION_PLAN.md`](RELEASE_0_IMPLEMENTATION_PLAN.md) (rev 2) ·
> [`RELEASE_0_APP_CLOSEOUT_AUDIT.md`](RELEASE_0_APP_CLOSEOUT_AUDIT.md) ·
> [`ASK_SPINE_BUILD_CONTRACT.md`](ASK_SPINE_BUILD_CONTRACT.md) §19c ·
> [`release-0-audit/RECEIPT.md`](release-0-audit/RECEIPT.md)
>
> Kept because §3–§6 remain the accurate record of the audit's execution,
> its command history, and its falsification evidence.


**Overnight session, 2026-08-06. Work is PAUSED at an authorization boundary,
not blocked by a defect.**

Nothing is mid-flight. No migration was written, no product behaviour changed,
no deploy happened, and **no production connection was ever opened.**

---

## 1. State

```text
branch          claude/release-0-audit-plan-55r5kd   (API repo only)
authorize       c0d995966cc24f52a20416f84c97a1244e92828a   ← see §2
base            origin/main ec9887732748e482deab21d76080a0d5f8c347c2
APP repo        UNTOUCHED — working tree clean, no commits, no branch divergence
```

Commits, oldest first:

```text
d38f600  Release 0 audit plan: the read-only definition Open Ruling 4 asks to
         authorize.
208a457  Completion-writer matrix: there are two live completion lanes, and the
         audit filter missed one.
d19cadf  Release 0 audit instrument: built, falsified, and proven against an
         isolated Postgres.
41c6c0f  Morning handoff.
b7d4262  Exercise every exit path, and fix the unguarded connect it found.
9dd28e0  Record the authorization SHA.                        (docs only)
c0d9959  Probe before any read, literally: move connection identity after the
         read-only proof in both tools.                       ← AUTHORIZE THIS
<tip>    Record the authorization SHA.                        (docs only)
```

### 1.1 Files — 11, all new except one

```text
NEW   docs/RELEASE_0_AUDIT_PLAN.md                     the authorization request
NEW   docs/RELEASE_0_COMPLETION_WRITER_MATRIX.md       source audit, no DB read
NEW   docs/RELEASE_0_MORNING_HANDOFF.md                this file
NEW   docs/release-0-audit/ISOLATED_PROOF_RECEIPT.md   falsification evidence
NEW   docs/release-0-audit/RECEIPT_TEMPLATE.md         for the real run
NEW   docs/release-0-audit/isolated_run.txt            raw tool output
NEW   tests/fixtures/release0_audit_populations.sql    edge populations
NEW   tests/fixtures/release0_audit_schema.sql         faithful schema subset
NEW   tests/unit/release0_audit_forbidden_fields.test.js    §5 enforcement
NEW   tests/unit/release0_readonly_ordering.test.js         ordering regression guard
NEW   tools/release0_proof_audit.js                    the instrument

MOD   tools/ledger_reconcile.js                        ordering + guarded connect
```

**No file under `src/`, `migrations/`, or `server.js` was modified.**
`tools/ledger_reconcile.js` is the one pre-existing file changed: it ships on
`main`, it is part of the authorized sequence, and it had the same two defects.
Its reconciliation logic is untouched — it still imports the same
`classifyLedger` that `migrate.js` runs at boot, so it still cannot disagree
with what a deploy decides.

---

## 2. ⚠ The commit requiring owner authorization

```text
AUTHORIZE:  c0d995966cc24f52a20416f84c97a1244e92828a
```

**A commit cannot name its own SHA.** `c0d9959` is the commit that holds the
instrument; the commit you are reading is a documentation-only one that follows
it purely to record that number. This is the same self-referential lag
`THREAD_HANDOFF.md` documents about itself — the difference is that here the gap
is closed deliberately by a trailing doc commit rather than left to be chased.
Nothing after `c0d9959` touches the tools, the plan, the fixtures, or the tests;
`git diff c0d9959..HEAD` should show this file and nothing else.

**The SHA has moved twice, and both times for the same reason.**
`d19cadf` → `b7d4262` (guarded connect) → `c0d9959` (statement ordering). Each
change touched a tool, so each invalidated the previous authorization target.
**Authorization attaches to content, not to a filename**, so if anything is
edited after the SHA you approve, the approval no longer covers it.

What did **not** change across those two moves — verified by diff, not
asserted:

```text
the query set                                   untouched
docs/RELEASE_0_AUDIT_PLAN.md                    untouched
tests/fixtures/release0_audit_*.sql             untouched
tests/unit/release0_audit_forbidden_fields.test.js   untouched
```

Only statement ordering, connection-failure handling, their comments, the two
receipts and one new test changed. **The substance under review is the same;
the commit naming it is not.**

What is being authorized: **one read-only run of
`tools/release0_proof_audit.js` against the production database**, plus one
run of the existing `tools/ledger_reconcile.js`. Nothing else.

---

## 3. Every command run, with exit code

```text
EXIT  COMMAND
────  ──────────────────────────────────────────────────────────────────────
   0  git fetch origin main            (both repos)
   0  initdb -D <scratch>/pgdata -U postgres --auth=trust      [as postgres]
   0  pg_ctl … start                   (port 5433, loopback + unix socket only)
   0  openssl req -new -x509 …         (self-signed, to satisfy migrate.js's
                                        hardcoded ssl option without editing it)
   0  npm install --no-audit --no-fund
   1  node migrations/migrate.js --apply
        → RELEASE REFUSED — EXPECTED_LEDGER_CEILING is required.  (correct gate)
   1  EXPECTED_LEDGER_CEILING=000 node migrations/migrate.js --apply
        → 012_bank_intake.sql FAILED: column "yardi_code" does not exist
        → PRE-EXISTING. The chain is not replayable from empty. See §6.
   0  psql -f tests/fixtures/release0_audit_schema.sql
   0  psql -f tests/fixtures/release0_audit_populations.sql
   0  node tools/release0_proof_audit.js            (superuser, isolated DB)
   0  node tools/release0_proof_audit.js            (SELECT-only role)
   0  node tools/release0_proof_audit.js --json     ×2, byte-identical
   2  node <falsified: begin instead of begin transaction read only>
   1  node <falsified: savepoint removed>
   1  node <falsified test: completion_note injected into C0>
   1  psql -c "delete from work_orders"             (as release0_auditor)
        → ERROR: permission denied for table work_orders
   0  node tests/unit/release0_audit_forbidden_fields.test.js       24 passed · 0 failed
   0  node tests/verify_source_governance.js        7 gates, all exit 0
   0  git push -u origin claude/release-0-audit-plan-55r5kd    ×4

   —— morning pass: the exit paths that had been written but never run ——
   2  env -u DATABASE_URL node tools/release0_proof_audit.js
   2  DATABASE_URL=<empty database> node tools/release0_proof_audit.js
        → B1: relation "work_order_proof_attachments" does not exist
   2  DATABASE_URL=<unreachable> node tools/release0_proof_audit.js
        → was an UNHANDLED REJECTION before the fix below
   0  regression re-run: text output byte-identical to isolated_run.txt,
        --json digest unchanged, 24 + 7 assertions still pass
```

**One defect found by closing that gap.** `client.connect()` sat outside the
try block, so an unreachable database threw an unhandled promise rejection and
printed a Node stack trace. It exited 1, so a table of exit codes looked right
while the operator could not distinguish *the audit failed* from *the audit
crashed*. Now guarded; refuses in the tool's own voice with exit 2.

### Pre-authorization correction — statement ordering (owner review)

Both tools ran `select current_database(), current_user` **before** opening the
read-only transaction and **before** the write probe. Postgres's read-only
transaction was and remains the substantive mutation barrier; what was wrong is
that each tool printed *"a write was attempted and refused before any read"* and
*"Nothing was read"* while having already issued a query. Narrowly false — and a
safety sentence that is narrowly false is not a safety sentence.

```text
EXIT  COMMAND
────  ──────────────────────────────────────────────────────────────────────
   —  moved the identity query in BOTH tools to after the refusal branch
   —  guarded client.connect() in ledger_reconcile.js
   0  node tools/release0_proof_audit.js      (log_statement='all' captured)
        → server received: 1. begin transaction read only  ← FIRST
                           2-4. savepoint · probe · rollback to savepoint
                           5. select current_database()    ← AFTER the proof
                           6-17. domain queries · 18. rollback
   2  falsified (begin instead of begin transaction read only)
        → server received 5 statements: begin, savepoint, probe, rollback to
          savepoint, rollback. NO identity query. NO domain query.
   0  node tools/ledger_reconcile.js          7 statements, same ordering
   2  falsified ledger_reconcile              5 statements, probe only
   2  ledger_reconcile, unreachable database  refuses in its own voice
   2  ledger_reconcile, DATABASE_URL unset
   0  node tests/unit/release0_readonly_ordering.test.js   18 passed · 0 failed
   1  falsified: identity query moved back above the read-only begin
        → 3 assertions fire, and they are the right 3
   0  regression: findings byte-identical, --json digest unchanged b73aada8,
        24 forbidden-field assertions pass, 7 governance gates pass
```

Evidence is the PostgreSQL statement log — what the server actually received —
not a source reading. Full detail in
`docs/release-0-audit/ISOLATED_PROOF_RECEIPT.md` §4.6–4.8.

**`tools/ledger_reconcile.js` is now modified.** It is an existing tool that
ships on `main`, and it is part of the authorized sequence, so it had to meet
the same contract. Its reconciliation logic is untouched — it still imports the
same `classifyLedger` as `migrate.js`.

**Never run:** any query against production. `tools/ledger_reconcile.js` was
**not** executed — it requires the production connection this handoff is asking
to authorize.

---

## 4. Falsification evidence

Full detail in `docs/release-0-audit/ISOLATED_PROOF_RECEIPT.md` §4.

| Guard | What was broken | Result | Exit |
|---|---|---|---|
| Read-only transaction | `begin transaction read only` → `begin` | `REFUSED — this transaction accepted a write. Nothing was read.` | 2 |
| Savepoint wrapper | both savepoint lines deleted | `current transaction is aborted` — the documented incident, reproduced | 1 |
| Forbidden-field test | `completion_note` injected into C0's select list | caught, 1 failure, and the **presence** check on the same column still passed | 1 |
| Read-only role | independent `delete` attempt | `permission denied for table work_orders` | — |

Determinism: two `--json` runs byte-identical,
`sha256 b73aada89c035a965e4d72b2f0cf9ce2607c1aa5676dc1e011daf9be0ca4d508`.

---

## 5. Completion-writer matrix

Full version: `docs/RELEASE_0_COMPLETION_WRITER_MATRIX.md`.

| Writer | Sets status to | Writes `kind='completed'`? | Proof lives in |
|---|---|---|---|
| `technician/lifecycle_service.js:178` | `'complete'` | **YES** (`:192`) | attachment rows |
| `maintenance/maintenance.js:553` | **`'closed'`** | **NO** | `completion_photo` column |
| `maintenance/maintenance.js:500` | `'needs_followup'` | NO | n/a |
| `comms/tenantlink.js:1652` | whitelisted `open`/`scheduled`; refuses `complete` | n/a | n/a |
| `maintenance/work_order_service.js:588,634` | does not write status | n/a | urgency only |
| `maintenance/readiness_service.js:313` | writes `obligations` | n/a | not a WO writer |

`work_order_progress` has exactly one insert site in the repository, and
`kind='completed'` has exactly one caller.

### 5.1 The consequence that changed the audit

`PATCH /work-orders/:id/closeout` is **live** (`server.js:2985`). It completes
work under a different status value, with a different proof model, and writes
no completion timestamp.

`lifecycleStateOf` tests `status === 'complete'` and nothing else, so a work
order closed through that route — with a photo — renders as **`scheduled`**
with `proof.satisfied = false`, and the operator is told to *"Assign or accept
the work."*

**That is a live confident-wrong on the current board, independent of Release 0
and not fixed by correcting line 90.** It was found by source reading, not by a
database query, and it invalidated the audit's own `where status = 'complete'`
filter — an audit that ran with it would have reported a completed-work census
missing an entire lane, and reported it as clean.

---

## 6. Remaining unresolved classifications

**None of these was decided overnight. Each is a ruling.**

1. **What a work order with no completion timestamp emits.** Open Ruling 1's
   predicate reads `completed_at`; `work_orders` has no such column, and the
   value is derived from a `kind='completed'` progress row that migration 134
   introduced. Without one, neither branch of the frozen predicate applies and
   the row resolves to **none of the four published proof states**.
2. **Whether a `status='closed'` work order is completed work for Release 0.**
   These never reach the classification at all.
3. **Whether Ruling 2's four states cover column-stored photo proof.** It is a
   third proof model the attachment-based reader cannot see.
4. **Whether the closeout route should keep writing `'closed'`.** Changing it
   is a product-behaviour change and was explicitly out of scope.

Items 1–3 are why **the proof-state writer was not built.** Building it would
mean implementing a four-state contract whose coverage of the real completion
population has not been established — and establishing that is what the audit
is for. This is the "do not build ahead of that fact" boundary, held.

### 6.1 Carried forward, not from tonight

- **The ledger below version 109 has never been reconciled**, and the boot gate
  evaluates the entire ledger. Release 0 adds a migration; one orphan row below
  109 means the deploy **refuses to boot**, inside the window, after the
  app-first release has shipped. `tools/ledger_reconcile.js` answers this
  read-only and must run **first**.
- **Migration 012 is not replayable from an empty database** (`yardi_code`).
  Pre-existing, unrelated to Release 0, and the reason the isolated proof uses
  a faithful schema subset rather than the full chain. Worth its own slice.
- **Query F was removed from this audit** — whether the 100-row list cap is
  already hiding work orders. Real defect, but it is charter §6's candidate
  population contract and belongs to Ask Spine Build 1.

---

## 7. The next action

Grant or refuse Open Ruling 4 against commit `d19cadf`.

**On grant**, the sequence is fixed and the first step can stop the rest:

```text
1.  node tools/ledger_reconcile.js          ← STOP if non-zero
2.  node tools/release0_proof_audit.js --json
3.  fill docs/release-0-audit/RECEIPT_TEMPLATE.md from the real output
4.  return for the Release 0 design review with §6.1–6.3 answered by facts
```

**On refusal**, nothing needs unwinding. No production state was touched and
the branch contains only documents and a dormant tool.

---

## 8. What must not be inferred from this work

- **No number in the isolated receipt says anything about production.** Every
  count there is synthetic. B2's `flipping_work_orders = 3` is a property of a
  13-row fixture, not an estimate.
- **Nothing here informs the activation boundary.** Under the frozen Ruling 1
  it is *captured* at the writer's verified-live instant, never derived from
  production data — and an audit is exactly the kind of source that ruling
  forbids.
- **The tool is proven, not run.** Proven against an isolated Postgres is a
  different rung of the §33 ladder than proven against production, and this
  handoff does not merge the two.
