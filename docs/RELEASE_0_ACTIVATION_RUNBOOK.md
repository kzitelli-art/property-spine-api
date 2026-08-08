# Release 0 — activation runbook

**The order is the frozen plan's §5.1. Nothing here reorders it.** What this adds
is what §5.1 does not carry: which PR is which boundary, what must be true before
each one, how it is verified afterwards, what stops it, and what is reversible.

**Read `tools/release0/where_are_we.js` before acting.** It reads production and
says which boundaries have actually landed — derived from the database and the
running checkout, never from a note. This release has already paid twice for
trusting a note: a PR reported merged whose later commits never landed, and a
deploy whose running SHA was not the one assumed.

---

## ⚠ THE OPERATIONAL FACT THAT WILL BITE FIRST

**A deploy does not migrate — and a build carrying an unapplied migration REFUSES
TO BOOT.**

`migrations/migrate.js` runs on `prestart` in verify-only mode. If the build
contains a migration file the target database has not applied, it prints
`✗ REFUSING TO START` and exits 1. **The service does not come up.**

So merging a branch that carries a migration is not "merge and it deploys." It is:

```bash
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<what the ledger says now> \
  EXPECTED_SHA=<the sha actually deploying> node migrations/migrate.js --apply
```

`EXPECTED_SHA` must be **the SHA that is actually deploying**, not the one you
expected. That mismatch already cost one retry — the guard refused and printed
both values, which is the guard working.

**This applies to boundary 9 (migrations 138 + 139).** They ride in the sweep
branch. Merging it without the migration release brings the API down.

---

## The boundaries, in order

| # | Boundary | Artifact | Kind |
|---|---|---|---|
| 1 | Step 1 · app proof normalizer | app, merged | done |
| 2 | Step 2 · migration 137 | merged · ledger 137 | done |
| 3 | Step 3 · canonical writer | API, merged `b4e3104` | **deploy verification OWED** |
| 4 | Transport · Twilio | external | **BLOCKER** |
| 5 | Step 4 · handset completion | `claude/step-4-production-proof` | **GATE, not a deploy** |
| 6 | Step 5 · app control removed | app **#37** | deploy + browser verify |
| 7 | Step 6 · legacy done-path closed | API **#57** | deploy + **capture the instant** |
| 8 | Step 7 · census + activation | API **#59** | **RUN ONCE** |
| 9 | Step 8 · four-state reader | API **#60** | deploy **after** activation |
| 10 | migrations 138 + 139 · §4.2 sweep | API **#61** | **migration release** + deploy |
| 11 | HTTP acceptance + `next_action` fix | API **#62** | deploy |
| 12 | App consumer release | app **#38** | deploy |
| 13a | app: consumers move to `state` | app **#39** | deploy **first** |
| 13b | app: the post-removal contract | app **#40** | deploy (stacked on #39) |
| 13c | api: `satisfied` leaves the wire | API **#63** | deploy **last of the three** |
| — | Step 4 package + this runbook | API **#64** | tooling, no product change |
| — | the composed end-to-end proof | API **#65** | tooling, no product change |

The API stack is linear: `#59 → #60 → #61 → #62 → #63`. Each merges into the one
below it, so they land in order or not at all.

---

## Boundary 3 — Step 3 deploy verification *(owed)*

**Precondition** — none; the merge already happened.

**Verify** — the running source carries the writer, not just `main`:

```bash
node tools/release0/where_are_we.js      # "Step 3 · canonical writer  LANDED"
```

**Stop** — if the running checkout has no `recordEvaluation` in
`lifecycle_service.js`, the deploy did not carry the merge. Re-deploy before
anything else; every boundary below assumes the writer is live.

**Reversible** — yes. No production row changed.

---

## Boundary 4 — Transport

**Everything downstream waits here.** With Twilio unconfigured the inbound webhook
returns 503 before reading anything, so no message reaches the technician turn.

**Verify** — `tools/step4/preflight.js` reports credential **presence** (computed
in JS, never a shell expansion — `${VAR:-no}` once put a live auth token in a
screenshot).

**Reversible** — n/a, configuration only.

---

## Boundary 5 — Step 4, the handset completion *(the load-bearing gate)*

**This is a GATE, not a deploy.** Nothing merges. See
`docs/RELEASE_0_STEP_4_PACKAGE.md` for the full package.

**Preconditions** — writer live · transport configured · one active operations
line · the tester resolves to exactly one staff user with an active maintenance
assignment · a **safe** target work order.

```bash
TEST_FROM='+1XXXXXXXXXX' node tools/step4/preflight.js       # chooses the target, prints T0
#  send ONE MMS: repair photo, completion language, naming the work order
TEST_FROM='+1XXXXXXXXXX' node tools/step4/prove_completion.js --wo <ref> --t0 '<T0>'
```

**Stop conditions**

- **Never target work order 1006.** It carries the Gate 8 evidence photo, so a bare
  "done" closes it instantly. The preflight excludes it by number.
- **Never target a work order that already has a stored photo.** It would close
  before the tester sent a picture — proving the writer but never exercising MMS
  ingress, which under Option A is the point.
- A receipt is emitted **only** if every named fact holds. One absent fact, no
  receipt.

**§7.4's surface clause may not be dischargeable yet.** With no activation the
reader correctly reports `read_status: "unavailable"` and omits `state` (§3.2.1),
so *"the operator surface reflects it"* cannot be closed. `prove_completion.js`
reports `surface_clause_discharged: false` rather than accepting it. **Either run
Step 7 first, or re-run this afterwards.** That is a sequencing decision, and it is
the owner's.

**Reversible** — the *proof* is read-only. The **completion it proves is not**: a
real work order closes, with a real evaluation, permanently. Choose the target
deliberately.

---

## Boundary 6 — Step 5, the app's completion control (app #37)

**Precondition** — boundary 5 passed. §5.1 is explicit: *"unreachable code and API
paths must not be retired until the replacement rail is REAL — unreachable is not
the same as absent, and an un-retired path is recoverable."*

**Verify** — browser: no app path completes a work order, and the **not-done** path
still works. `closeoutNotDone` is untouched and must stay that way.

**Reversible** — yes, by revert. Nothing persistent changes.

---

## Boundary 7 — Step 6, the legacy done-path fails closed (API #57)

**Precondition** — boundary 6 deployed.

**Verify** — the route answers 409 naming the canonical path, writes nothing, and
the not-done path on the same route still succeeds. Proven in isolation by
`tools/step56/prove_step6_legacy_closed.js` (19/19, real HTTP).

### ⚠ CAPTURE THE ACTIVATION INSTANT HERE, AND ONLY HERE

§5.1 and §5.4. Only now can the legacy writer no longer create `closed` rows.
Capturing earlier leaves a window in which a legacy `closed` row would be terminal,
absent from the inventory, and rendered `missing_evaluation_defect` — **a defect the
system caused itself.**

Record the instant. It is `$1` in the activation transaction and is **never**
`now()` (§6.1).

**Reversible** — yes, by revert. The captured instant is just a value until
boundary 8 persists it.

---

## Boundary 8 — Step 7, census and activation (API #59) · **RUN ONCE**

**Preconditions** — boundary 7 deployed and verified; the instant captured there.

**The census must be fresh and specifically authorized** (§6.2). The August 6 audit
may **not** be used as the deployment-time expected set. `tools/step7/census.js`
refuses without `R0_CENSUS_AUTHORIZATION` naming who authorized it, and that name
is printed into the receipt.

**The activation transaction** — one transaction, the captured instant as `$1`, and
an **exact-set comparison in both directions** inside it. Proven in isolation:
`prove_step7_activation.js` 37/37, `prove_step7_concurrency.js` 11/11, three
falsification variants.

**Stop conditions**

- Census set ≠ expected set, in **either** direction → the transaction refuses. Do
  not widen the comparison; re-census and find out what moved.
- Any legacy `closed` row created after the instant → boundary 7 is not actually
  closed. Stop and fix that first.

**Reversible — NO. This is the irreversible boundary.** `release_0_activation_history`
and `release_0_legacy_cutover_inventory` are append-only with `forbid_mutation`
triggers: no UPDATE, no DELETE, enforced by the database. A wrong inventory cannot
be edited out. Everything above this line exists to make sure it is right the first
time.

---

## Boundary 9 — Step 8, the four-state reader (API #60)

**Precondition — activation and inventory EXIST.** §5.1: *"deployed ONLY after
activation and inventory exist."* Deploying earlier makes every terminal work order
read `unavailable`, and the release cannot tell legacy history from a writer defect.
`where_are_we.js` treats reader-live-without-activation as a stop condition.

### ⚠ #60 introduced a defect. Its fix is in #61/#62.

`next_action` was derived from `proof.satisfied`, which Step 8 made **absent** on a
failed read — `undefined` is falsy, so the API answered *"Obtain repair photo before
completion"* on the same payload that said the proof state was unavailable, and the
app prints `next_action` verbatim.

The systematic window is closed by the ordering above (a failed read requires no
activation, and the reader deploys after activation). **But a failed read can also
come from a transient error, so the fix matters regardless.** `where_are_we.js`
raises a stop condition if the four-state reader is live without it.

**Prefer to land #60 and #62 in one release.** If they must be split, verify
`nextActionFixed` on the running checkout before calling boundary 9 done.

**Reversible** — yes, by revert. The reader writes nothing.

---

## Boundary 10 — migrations 138 + 139, and the §4.2 sweep (API #61)

**⚠ This is the boundary the boot gate bites.** #61 carries `138` and `139`.
Merging without the migration release **brings the API down** — see the top of this
document.

```bash
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=137 \
  EXPECTED_SHA=<the sha actually deploying> node migrations/migrate.js --apply
```

**138 and 139 are one boundary.** 138 alone lets the defect obligation be raised
but not closed as `no_longer_applicable`; `where_are_we.js` stops on that split.

**The sweep is a governed MANUAL runner. There is no scheduler.** Until a human
runs it, a post-cutover defect is visible in the reader and has no obligation
against it. The reader is honest either way; recurring execution does not exist.

```bash
node tools/run_proof_defect_sweep.js                 # DRY RUN — read what it WOULD do
node tools/run_proof_defect_sweep.js --raise         # only after reading that
```

**Stop conditions** — the service refuses without an activation
(`ACTIVATION_ABSENT`) and without 138 (`IDEMPOTENCY_INDEX_MISSING`). Both are exit
2 with prose, not a stack trace. **Do not work around either.** Without an inventory
the sweep would raise an obligation against every terminal work order in the
property.

**Reversible** — the code, yes. **The migrations and any obligation raised, no.**
An obligation is an accountability fact about a human; the sweep cannot close what
it raised, by design. Dry-run first, every time.

---

## Boundary 11 — HTTP acceptance and the `next_action` fix (API #62)

**Precondition** — boundary 9. Carries the fix for the defect boundary 9 introduced.

**Verify** — `tools/step10/prove_http_acceptance.js` (63/63 in isolation) and four
falsification variants. In production, `where_are_we.js` reports
`next_action fixed` on the running checkout.

**Reversible** — yes. Read-path only.

---

## Boundary 12 — the app consumer release (app #38)

**Precondition** — boundary 11 deployed, so the contract the app's capture records
is the contract production emits.

**Verify** — `release0_api_capture_consumer.test.js` (72/72) and the full app suite
(1035/0). The API-side proof fails if the app's capture is not byte-identical to
what the API emits, so cross-repo drift is caught in CI, not in production.

**Reversible** — yes.

---

## Boundary 13 — cleanup, retiring `proof.satisfied` (app #39 → app #40 → API #63)

**Three deploys, and the order is not a preference.** Merge the API removal first
and the board renders `UNAVAILABLE` for **every work order** the moment the first
response arrives without `satisfied` — the app's normalizer treated its absence as a
contract failure until #39 changed that.

```text
13a  app #39   the door reads `state`; the normalizer TOLERATES an absent
               `satisfied` and still cross-checks a present one
13b  app #40   the post-removal capture           (stacked on #39)
13c  API #63   `satisfied` leaves the wire        (the field, never the MEANING —
               SATISFIED_FOR stays exported, because it is the definition
               consumers derive from)
```

**Verify after each** — the app suite is green at every step, and
`gate_proof_compatibility_field.js` on the API side asserts `state` is still emitted
and the mapping is still exported (`G8`/`G9`). Falsified in both directions:
putting the field back, and deleting the mapping. **The second is the dangerous
one** — the wire still carries `state`, so the API looks completely fine while
nothing can derive the boolean any more.

**Still blocked, and not on a code question.** The normalizer's OLD-CONTRACT branch
may not be removed while any deployed API can still emit the boolean-only shape.
That is a later release than these three. See `docs/RELEASE_0_CLEANUP_CANDIDATE.md`.

---

## After every boundary — the composed proof (API #65)

```bash
bash tools/steps23/baseline_136.sh
PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
STEP11_DATABASE_URL='...' node tools/step11/prove_release0_composed.js
```

Runs the whole path in one process — writer → the eight facts → census and
activation → the four-state reader over real HTTP → the sweep through the governed
manual runner → **the app's own normalizer over those live bodies** → the
production-state invariants. It is the only place the two repos meet without a
capture between them.

**It is an isolated-Postgres proof, not a production check.** Use
`tools/release0/where_are_we.js` for production.

---

## Rollback, honestly

```text
BOUNDARIES 3, 6, 7, 9, 11, 12   revert the deploy. Nothing persistent changed.
BOUNDARY 5                      the PROOF is read-only; the completion it proves
                                is a real, permanent completion of a real work order.
BOUNDARY 8                      NOT REVERSIBLE. Append-only, enforced by triggers.
BOUNDARY 10                     migrations are forward-only; a raised obligation is
                                an accountability fact and the sweep cannot close it.
```

**One boundary is irreversible and one writes accountability facts about people.**
Everything else in this release is a deploy you can take back. Treat 8 and 10
accordingly: they are the two where "run it and see" is not available.

---

## The instrument

```bash
node tools/release0/where_are_we.js
```

Reports every boundary as **LANDED / not** from the database and the running
checkout, checks the stop conditions that actually bite, and names the next
boundary. It is proven read-only before it reads, decides nothing, and changes
nothing. Exit 1 when any stop condition holds, so a script cannot chain past one
without noticing.
