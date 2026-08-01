# Lifecycle Authority — exact correction spec (isolated pass)

**Resume:** `claude/slice-9-demand-evidence` @ `264ea98`
**Scope lock — the ONLY files this pass may change:**

```
src/applications/application_lifecycle.js
docs/slices-6-to-10/deployment_b/125_application_lifecycle_enforcement.sql
tools/application_milestone_baseline.js
new isolated lifecycle proofs
new status-group drift proof
review/correction documentation
```

**No production caller may be modified.** Re-run the zero-caller check against
the **completed tree, immediately before the commit** — not earlier in the
session. That ordering is the actual ruling; checking early and committing late
is how `9b920a3` came to contradict itself.

## Writer exports — exactly five

```
createSubmittedApplication
markLeaseReadyFromApproval
markTermConfirmationRequiredFromExecutedLease
markActiveFromConfirmedTerm
markTerminal
```
Read-only exports may include `STATUS`, `LADDER`, status groups,
`assessTransition`.

**Delete callable writers for** exact `approved`, `tenant_signed`,
`countersigned`. Those statuses stay **readable** as historical vocabulary.
They are not writable acts until the product has a real operating event and a
canonical evidence source.

## The module creates no obligations and no events

| Caller owns | Authority owns |
|---|---|
| authority check · application lock · event creation · obligation create/complete · commit | transition admissibility · companion-fact verification · status + milestone statement · transition receipt |

It must not import or invoke the obligation engine, event service, Express,
session resolution, or a database pool. It receives an **already-open
transaction client**.

## Operation contracts

### `createSubmittedApplication`
One `INSERT` carrying `status='submitted'`, `submitted_at=transaction_timestamp()`.
No insert-then-update. Preserves existing birth payload behaviour and DB defaults.
Receipt: `applied` · from `null` · to `submitted` · authored_now `[submitted_at]`
· present_after `[submitted_at]` · full returned row.

### `markLeaseReadyFromApproval(applicationId, termsReviewObligationId)`
From `submitted | approved`. **Verify before writing:** obligation `id` matches,
`related_id = applicationId`, `related_type = lease_application`,
`type = terms_review`, `status in (open, in_progress)`.

One statement sets `status='lease_ready'` and `terms_review_obligation_id`.
Crossing from `submitted` authors `approved_at = transaction_timestamp()`.
From historical `approved`: **`approved_at` and `submitted_at` remain exactly as
found.** Never repair a missing historical milestone.

### `markTermConfirmationRequiredFromExecutedLease(applicationId, executedLeaseRecordId, termRequiredObligationId)`
From `approved | lease_ready | tenant_signed | countersigned` — retired statuses
accepted as **historical origins**, which does not create writers for them.

Verify: executed-lease record id matches, `application_id = applicationId`,
`record_state = verified`, and it is the currently **live** verified record;
obligation matches with `type = term_required`, `status in (open, in_progress)`.

Writes `status='accepted_term_required'` **only**.
**Must NOT write** `countersigned_at`, `executed_at`, `submitted_at`,
`approved_at`. Execution time belongs exclusively to the executed-lease record.

### `markActiveFromConfirmedTerm(applicationId, leaseId, termRequiredObligationId)`
From `accepted_term_required`. Verify `leases.id = leaseId` with
`leases.application_id = applicationId`, and the `term_required` obligation is
`complete`.

Writes `status='active'`,
`activated_at = coalesce(activated_at, transaction_timestamp())`.
Populates no missing submission or approval milestone.

### `markTerminal(applicationId, terminalCode, decisionReason, actorUserId)`
```
declined  : submitted | approved | lease_ready
expired   : submitted | approved | lease_ready
withdrawn : draft | submitted | approved | lease_ready
```
**Refuse** from `accepted_term_required`, `active`, and any existing terminal
status other than exact idempotent replay.

One statement authors `status`, `terminal_code`, `terminal_at`,
`decision_reason`, `decision_by_user_id`, `decided_at`, `updated_at` — all
database instants from the same transaction clock.

`actorUserId` may be null (legacy actorless doors exist). The later caller
cutover must prove **no request-body user id is passed as authority**.

## Transition outcomes — four, never collapsed

```
applied | already_at_target | already_beyond_target | refused
```
Writers return receipts for the first three. A refusal **throws** a controlled
error carrying `transition_state: refused`, `code`, `from_status`, `to_status`,
`application_id`. A no-write result has `milestones_authored_now = []`.

Callers later branch on `already_beyond_target` before creating any
target-specific event or obligation — collapsing it into ordinary idempotency
is how an `active` row gets a second admission event.

## Receipt semantics

```
application_id · from_status · to_status · transition_state
milestones_authored_now   ← derived from locked before-row vs returned after-row
milestones_present_after  ← non-null submitted_at, approved_at, terminal_at, terminal_code
application
```
Never report a `coalesce()` target as newly authored when it was already present.

## Staged 125 additions

Refuse: `draft` carrying `submitted_at`; `draft` or `submitted` carrying
`approved_at`; a terminal row whose `submitted_at` was null **acquiring** one
through an ordinary update; same for `approved_at`.

Do **not** prohibit legitimate terminal history — `submitted → declined` keeps
`submitted_at`; `approved → withdrawn` keeps both. A later historical repair
requires a dedicated migration or governed repair mechanism, never a runtime
update.

## Baseline additions — two must-be-zero categories

```
pre_submission_status_carrying_submitted_at   (nonterminal, NOT in submission group)
pre_approval_status_carrying_approved_at      (nonterminal, NOT in approval group)
```
**Terminal rows are excluded from both.** A withdrawn application may
legitimately preserve a prior approval milestone. Mutation controls must prove
each new category blocks Deployment B.

## Status-group drift harness

Parse **executable** SQL and JS definitions — not comments — from migration
124's compatibility trigger, `application_lifecycle.js`, and staged 125.
Require exact equality of the submission, approval and terminal groups. Then:
mutate each source independently, prove the harness fails for **every**
single-source mutation, restore, and verify the working tree is clean.

## Isolated real-Postgres proof matrix

Run **twice**: with 124 active, then again after applying staged 125 manually.

Birth · approval (incl. wrong obligation type / wrong lineage / closed / missing
refused; historical null `submitted_at` survives; historical null `approved_at`
stays null) · executed-lease admission (voided, superseded, wrong-application
refused; `countersigned_at` **byte-identical** before and after; `active →
accepted_term_required` = `already_beyond_target` with **zero write**) ·
activation (wrong lease lineage refused, open obligation refused, historical
nulls remain null) · terminal (every allowed transition accepted, every unruled
one refused, `draft → withdrawn` keeps `submitted_at` null, `approved →
withdrawn` retains `approved_at`, exact replay writes nothing, different
disposition refused, `active`/`accepted_term_required` refused) · receipt and
clock (authored-now differs from present-after; replay moves no timestamp; no
JS clock supplies any instant; module opens no connection or transaction) · 125
(all false shapes rejected, historical exceptions survive, compat trigger
absent, strict triggers present).

## Commit discipline

Explicit paths — **never `git add -A`**. That is what swept the cutovers into
`9b920a3`.

Before: `git status --short`, `git diff --name-only`, `git diff --cached --name-only`.
After: `git show --name-only --format=` and the zero-caller grep.

## Handback contains ONLY

corrected isolated authority commit · five exported writers · isolated Postgres
totals before and after staged 125 · baseline category results · drift proof and
mutation results · staged-125 enforcement results · zero-production-caller proof
· exact changed-file list.

**No production cutover.** A–E resume one path and one commit at a time only
after this handback passes review.
