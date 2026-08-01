# Lifecycle Authority Review — corrections required before any cutover

**Reviewed:** `c9ae519` · `src/applications/application_lifecycle.js`
**Status:** cutover **PAUSED**. No production file calls this module yet, so the
pause is clean — `git diff origin/main..HEAD -- src/applications src/tenancy`
shows only the authority file itself.

The database-clock and caller-owned-transaction decisions are right. The
exported authority is too broad, and several companion invariants are optional.

> The target is not "eight operations". It is **one writer for every real
> lifecycle act, and no writer for an act Property Spine does not perform.**

## 1. Dormant write capability — remove three operations

Verified in the module's own source: line 94 records that
`/applications/:id/sign` is **410 Gone**, and it exports `markTenantSigned`
anyway. A status existing in the historical vocabulary does not justify a
callable writer.

**Remove:** `approveApplication` (exact `approved`), `markTenantSigned`,
`markCountersigned`. The live approval path jumps straight to `lease_ready`;
sign and countersign have no canonical evidence source.

**Export only:**
```
createSubmittedApplication
markLeaseReadyFromApproval
markTermConfirmationRequiredFromExecutedLease
markActiveFromConfirmedTerm
markTerminal
```
Keep the retired statuses **readable** in `STATUS`/`LADDER` for historical rows.

## 2. Remove the fabricated countersign fact

`application_lifecycle.js:543` writes
`countersigned_at=coalesce(countersigned_at, now())` inside the executed-lease
admission path — while the executed-lease service itself states the act is
never acceptance or countersigning. That is a manufactured legal-semantic fact.
Real execution time already lives on `executed_lease_records.executed_at`.

```
executed lease admitted → status = accepted_term_required
                        → DO NOT touch countersigned_at
```
Historical values stay readable as legacy evidence. Add a source audit proving
no new production writer authors `countersigned_at`.

## 3. Companion truth cannot be optional

`markLeaseReady` currently accepts `termsReviewObligationId = null`, permitting
`lease_ready` without the obligation that gives the state its meaning.

| Operation | Must require and VERIFY |
|---|---|
| `markLeaseReadyFromApproval` | open/in-progress `terms_review` obligation, linked to this application |
| `markTermConfirmationRequiredFromExecutedLease` | live verified executed-lease record with exact application lineage **and** an open `term_required` obligation |
| `markActiveFromConfirmedTerm` | `leaseId` whose `application_id` matches, **and** a completed `term_required` obligation |

Create the admission event and obligation **before** the status change, in the
same transaction. If the obligation service is unavailable, Phase-1
executed-lease evidence may still commit but admission returns **blocked** and
the application does not advance.

## 4. Preserve the transition outcome

`gate()` collapses two different facts into `already_in_state: true`, discarding
what `assessTransition()` knew. `active` asked to become
`accepted_term_required` must neither regress **nor** emit another admission
event or `term_required` obligation.

```
transition_state: applied | already_at_target | already_beyond_target | refused
```
Callers branch before creating any target-specific event or obligation.

## 5. Do not widen terminal authority

```
declined  : submitted | approved | lease_ready
expired   : submitted | approved | lease_ready
withdrawn : draft | submitted | approved | lease_ready
```
`draft → withdrawn` is valid and leaves `submitted_at` **null**.

`accepted_term_required` and `active` **cannot** be closed by generic
application disposition — once verified executed-lease evidence exists,
correction belongs to executed-lease or tenancy governance.

**No `decided_by_user_id` from the request body.** Server-derived staff actor,
or an honest null on a legacy actorless door.

## 6. Staged 125 still permits false milestone shapes

Refuse:
```
draft carrying submitted_at
submitted carrying approved_at
a terminal row acquiring a previously-null submitted_at or approved_at
  through an ordinary runtime update
```
A later evidence-backed historical repair must be an explicit migration or
governed repair mechanism, never a normal application update.

Add two **must-be-zero** baseline categories:
`pre_submission_status_carrying_submitted_at`,
`pre_approval_status_carrying_approved_at`.

## 7. Receipt must distinguish authored from present

`coalesce()` currently reports a milestone as authored even when the column was
already populated and nothing was written. Derive from the locked before-row and
the returned after-row:
```
milestones_authored_now
milestones_present_after
```

## 8. Prove the three status-group copies cannot drift

The groups now exist in **three** places: migration 124's compatibility trigger,
`application_lifecycle.js`, and staged migration 125. Add a contract harness
parsing all three and requiring exact equality for the submission, approval and
terminal groups. **A mutation to any one copy must fail the harness.**

## Cutover order — one domain path at a time

```
A. both submitted-application births
B. live approval to lease_ready
C. terminal application disposition
D. executed-lease admission
E. confirmed-term activation
```
Run the per-path adversarial proof **immediately after each**, not after all
five have changed — otherwise which path drifted is a guess. Then the
raw-status-write audit, requiring zero unauthorized production writers, before
continuing into the journey builder and conversion corrections.
