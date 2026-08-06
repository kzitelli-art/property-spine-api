# Release 0 — morning handoff

**Overnight session, 2026-08-06. Work is PAUSED at an authorization boundary,
not blocked by a defect.**

Nothing is mid-flight. No migration was written, no product behaviour changed,
no deploy happened, and **no production connection was ever opened.**

---

## 1. State

```text
branch          claude/release-0-audit-plan-55r5kd   (API repo only)
final SHA       d19cadf34769fc0f15075ba57f8854f9da535b44
pushed          yes — origin/claude/release-0-audit-plan-55r5kd
base            origin/main ec9887732748e482deab21d76080a0d5f8c347c2
APP repo        UNTOUCHED — working tree clean, no commits, no branch divergence
```

Three commits, oldest first:

```text
d38f600  Release 0 audit plan: the read-only definition Open Ruling 4 asks to authorize.
208a457  Completion-writer matrix: there are two live completion lanes, and the
         audit filter missed one.
d19cadf  Release 0 audit instrument: built, falsified, and proven against an
         isolated Postgres.
```

### 1.1 Files changed — 9 files, all new, 2282 insertions

```text
docs/RELEASE_0_AUDIT_PLAN.md                     699   the authorization request
docs/RELEASE_0_COMPLETION_WRITER_MATRIX.md       157   source audit, no DB read
docs/RELEASE_0_MORNING_HANDOFF.md                 —    this file
docs/release-0-audit/ISOLATED_PROOF_RECEIPT.md   309   falsification evidence
docs/release-0-audit/RECEIPT_TEMPLATE.md         118   for the real run
docs/release-0-audit/isolated_run.txt            101   raw tool output
tests/fixtures/release0_audit_populations.sql     98   edge populations
tests/fixtures/release0_audit_schema.sql         179   faithful schema subset
tests/release0_audit_forbidden_fields.test.js    214   §5 enforcement
tools/release0_proof_audit.js                    407   the instrument
```

**No file under `src/`, `migrations/`, or `server.js` was modified.**

---

## 2. ⚠ The commit requiring owner authorization

```text
AUTHORIZE:  d19cadf34769fc0f15075ba57f8854f9da535b44
```

`d19cadf` contains both the plan and the instrument it authorizes. The plan
file itself was last modified at `208a457`; `d19cadf` carries it unchanged and
adds the proven tool.

**`d19cadf` is not the branch tip** — this handoff is a later, documentation-only
commit on top of it, and writing this file moved the tip again. That is the same
self-referential lag `THREAD_HANDOFF.md` documents about itself, and it is not a
mistake to chase. Authorize the content SHA, not whatever `git log -1` happens to
show. Nothing after `d19cadf` touches the plan, the tool, the fixtures, or the
test.

**Authorization attaches to a commit, not to a filename.** If the plan is
edited after the SHA you approve, the approval no longer covers it.

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
   0  node tests/release0_audit_forbidden_fields.test.js       24 passed · 0 failed
   0  node tests/verify_source_governance.js        7 gates, all exit 0
   0  git push -u origin claude/release-0-audit-plan-55r5kd    ×3
```

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
