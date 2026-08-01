# Slice 9 API — Required Corrections Before the App Build

**Owner review of `dbf8350`, 2026-08-01.** The API foundation is accepted
*directionally*. It is **not a settled contract** and the app renderer must not
be built against it. Three current outputs overstate canonical truth.

> The API has the right architecture, but the current conversion numbers are
> not yet safe to put in front of an operator.

## Verified against the code at `dbf8350`

| # | Finding | Confirmed |
|---|---|---|
| 1 | Funnel 2 is not journey-correlated | `conversion.js` iterates `f2cohort` (journeys) and credits a journey whenever **the lead** has any submitted application. Two completed journeys + one application ⇒ two conversions. |
| 2 | Milestone truth insufficient | `reached()` returns `milestone === "submitted" && status !== "draft"` for terminated rows — but `status` there is already `declined`/`withdrawn`, so the guard never fires. **Every withdrawn application counts as submitted.** Approved-then-withdrawn also loses its approval. |
| 3 | `as_of` claimed but not honoured | The route accepts a client `as_of`; lead selection filters only on the window, and no-show/cancel counts read current final status. |
| 4 | Sections do not share one snapshot | `Promise.all` over separate pool connections — three different committed states. |
| 5 | Journey truth built twice | `resolveChains` runs in both `tour_demand.js` and `conversion.js`. |
| 6 | Pending inconsistent | The commit message claimed every funnel returns pending. **Funnel 2 passes only `untrackable`.** Funnel 1 treats an active lead with no tour as a non-conversion. |
| 7 | Metric contract under-enforced | `buildMetric()` permits negatives, non-integers, `numerator > denominator`, NaN/Infinity; count-only metrics put the count in `denominator`. |
| 8 | Timezone governance not append-only | `reason` optional, `actor_person_id` nullable, audit rows mutable, idempotency not payload-aware. |
| 9 | Unbounded reads | Tour Demand and Conversion load all property history into Node. |

## Rulings to implement

1. **Rename and re-grain Funnel 2** to
   `s9.conversion.completed_tour_opportunity_to_submitted_application.v1`.
   Denominator: distinct opportunities with ≥1 completed journey in the window.
   Numerator: those with ≥1 submitted application by server report time.
   Multiple tours and applications collapse to the opportunity. Journey counts
   stay in Tour Demand; this is not journey-level conversion until applications
   carry a direct journey correlation.

2. **Add canonical `submitted_at` / `approved_at`** — nullable, write-once,
   authored in the same transaction as the transition, never inferred from
   `created_at`, no guessed backfill. Existing nulls are **untrackable**.
   **Delete `LIFECYCLE_ORDER` and `reached()` from the evidence domain** —
   evidence does not own application lifecycle hierarchy. Audit every status
   writer.

3. **Current-reporting only.** Reject a client `as_of` with
   `historical_as_of_not_supported`. Capture server `as_of` once per request.
   Internal injection stays for deterministic tests. Cap all origin events at
   `min(window_end_utc, as_of_utc)`.

4. **One `READ ONLY REPEATABLE READ` transaction**, one client, one `as_of`.
   Keep failure isolation with `SAVEPOINT` per section, not separate snapshots.
   Never surface raw SQL errors to an operator.

5. **One canonical appointment-journey builder** consumed by both modules,
   emitting `journey_id, root_tour_id, lead_id, opened_at, booking_attempts,
   reschedule_count, final_status, completed_at, no_show_at, cancelled_at,
   outcome_state, trackability_state, trackability_reason`. A chain ending in
   `rescheduled` with no successor is **broken/untrackable**. Untrackable counts
   are journeys, cohort-scoped. Outcome capture binds to the completed leg.

6. **Define pending from the owning lifecycle**: not converted and not
   canonically terminal — never from elapsed time or the presence of a
   scheduled tour. Every funnel returns `converted_count`, `pending_count`,
   `terminal_nonconversion_count`, `unknown_count`, `untrackable_count`.

7. **Strengthen `metric_contract`**: add `metric_kind` (`count | rate |
   duration`). Count metrics carry `value`, with numerator/denominator/rate
   null. Rate metrics require non-negative integers, `numerator <= denominator`,
   no NaN/Infinity. **Refuse** invalid metrics rather than publishing them.

8. **Harden timezone governance**: `reason` required and non-blank;
   `actor_person_id` required and fail-closed when unresolved; `idempotency_key`
   required; same key + same payload returns the original receipt, same key +
   different payload returns **409**; audit rows append-only via database
   trigger refusing UPDATE and DELETE. Store a payload digest.

9. **Bound the reads.** Cap accepted windows, load only origin cohorts and
   linked outcomes, use recursive SQL for the relevant reschedule chains, share
   the journey dataset, prove indexes, and return
   `EXPLAIN (ANALYZE, BUFFERS)`, query count and timing on a materially
   enlarged fixture.

## Negative controls required

```
two completed journeys + one application ⇒ ONE conversion
withdrawn draft is NOT submitted
approved-then-withdrawn RETAINS the approval milestone
created in July / submitted in August belongs to AUGUST
a status transition after report as_of does not appear before it
all sections reconcile inside one snapshot
a final rescheduled leg with no successor is untrackable
untrackable counts are cohort-scoped
invalid metric shapes are refused
same idempotency key with a different timezone/reason is rejected (409)
audit UPDATE and DELETE are refused
```

## Sequence

```
correct the truth boundaries on claude/slice-9-demand-evidence
→ rerun full API proofs and regressions
→ FREEZE the API response contract
→ then build the app renderer
→ API PR only after the correction pass is complete
```

**Do not open the API PR before this pass is done.**

---

# CORRECTION-PASS RULINGS (settled 2026-08-01)

These supersede the broader first-pass instructions above where they differ.

### 1. Milestone backfill — conditional, never global

`approved_at = decided_at` **only** when `decided_at` is non-null **and** the
current row proves approval was reached (`approved`, `lease_ready`,
`tenant_signed`, `countersigned`, `active`) **and** nothing contradicts it.

Never backfill `approved_at` for `declined`, `withdrawn`, `draft`, `submitted`,
or ambiguous rows. For a declined row `decided_at` supports a **decline
terminal time**, not an approval. Approved-then-withdrawn stays **untrackable**
unless an append-only event proves the original approval instant.

**Never globally backfill `submitted_at` from `created_at`.** A path-specific
backfill is permitted only where the writer audit proves that path created the
row directly in `submitted` state and `created_at` was transactionally the
submission instant. Otherwise `submitted_at = null`.

Migration handback must report: rows backfilled per category, and rows
**rejected** from each backfill with the reason.

### 2. Application milestone repair — IN Slice 9 scope

Narrow application-domain repair only. **Not** a workflow or UI redesign.
Separate additive migration **`124_application_lifecycle_milestones.sql`**
adding `submitted_at`, `approved_at`, `terminal_at`, `terminal_code`
(`declined` | `withdrawn`).

Database protections: milestone timestamps cannot be cleared or moved once
set; a transition crossing a milestone authors its timestamp in the same
transaction; terminal state carries both `terminal_at` and `terminal_code`;
untouched historical rows may stay null; **no trigger may invent a timestamp**.

`LIFECYCLE_ORDER` and `reached()` are **deleted from the evidence domain**.

### 3. Terminal vocabulary — not one blunt counter

Replace `terminal_nonconversion_count` with `terminal_count` +
`terminal_breakdown`, each item carrying `code`, `outcome_class`, `count`.
Outcome classes: `lost` · `closed_without_target` · `advanced_without_target`.

Every funnel returns: `converted_count`, `pending_count`, `terminal_count`,
`terminal_breakdown`, `unknown_count`, `untrackable_count`.

**Lead terminal truth comes from `lead_events`, not `leasing_leads.status`** —
the schema itself states status is a projection.

| Funnel | Converted | Terminal | Pending |
|---|---|---|---|
| Opportunity → completed tour | completed journey exists | `lost` before conversion → `lost`; `lease_signed` with no completed tour → `advanced_without_target` | neither |
| Completed-tour opportunity → submitted application | submitted application exists | lost after tour before submission → `lost_after_tour`; `lease_signed` with no tracked application → `advanced_without_tracked_application` | otherwise |
| Submitted → approved | `approved_at` exists, regardless of later status | `declined`/`withdrawn` before `approved_at` | `submitted_at` exists, neither occurred. Missing submission timestamp ⇒ **untrackable** |
| Approved → executed | admitted, non-void execution | `declined`/`withdrawn` after `approved_at`, before execution | `approved_at` with no execution or terminal |

A **cancelled or no-show tour is NOT terminal** — the prospect may rebook.
A **void execution record or expired offer is NOT terminal** — either may be
repaired or superseded. An application `active`/`countersigned` without the
admitted execution fact is **unknown / inconsistent**, neither terminal nor
converted.

### 4. Window bounds

Max **366 property-local calendar days**. Default **current property-local
month-to-date** — never to a future month end. Over 366 days ⇒ `400`,
`reporting_window_too_large`, `max_days: 366`. **Reject, never clamp** —
clamping silently answers a different question. Client `as_of` rejected;
server captures one `as_of_utc`; an `end_local` after the property's current
local date is rejected; every query bounded by the earlier of window end and
server `as_of`.

### 5. Scale proof — event volume, not ceremonial units

Target property: **50k opportunities · 75k tour legs · 20k applications · 10k
executions**, 366 days, realistic reschedule/no-show/cancel/missing-correlation
distributions. Noisy neighbours across unrelated properties: **+200k / +300k /
+80k / +40k**.

Gates: two warmups, 20 measured requests. Current-month **p50 ≤ 500 ms,
p95 ≤ 1 s**; 366-day **p50 ≤ 1.5 s, p95 ≤ 3 s**. Constant query count
regardless of row count, **≤ 12 data queries** total, no N+1, no all-history
Node loads, no disk-spilling sort/hash, no cross-property full scan, response
**< 100 KB**. Return `EXPLAIN (ANALYZE, BUFFERS)` per load-bearing query, query
count, fixture cardinalities, environment description, p50/p95/max.

### 6. Coverage — no percentage threshold

The section **always renders**. Metric states: `ok` · `partial` · `empty` ·
`unsupported` · `unavailable` · `error`.

`partial` = missing milestone or correlation truth could change the result ⇒
**`rate = null`**, showing `trackable_count`, `untrackable_count`,
`coverage_rate`, `reason`. **Never publish a rate computed over only the
trackable subset** — a biased subset presented as the property's conversion
rate is the failure this avoids. `empty` = cohort complete, denominator zero ⇒
`rate = null`. `unsupported` = no canonical source at all.

A metric becomes `ok` naturally once a window contains only canonically
timestamped records. No manual switch.

### 7. Migration numbering

```
121 — reserved, AI leasing operating context (commit 5d2b2ad, unmerged)
122 — merged governed economics
123 — Slice 9 property operating timezone
124 — Slice 9 application lifecycle milestones
```

Do **not** renumber 123 into the gap, and do not compress if 121 is abandoned.
Before the PR: rebase, enumerate every prefix, prove exactly one file each for
121–124, leave the gap if 121 is still absent, rerun migrations and proofs from
the rebased tree.

---

## STATUS-WRITER AUDIT — completed, stop condition NOT triggered

Ruling 2 said to stop only if a genuinely separate application lifecycle
authority exists that cannot be safely consolidated inside this PR. **It does
not.** Every writer is inside the applications domain plus one tenancy service:

| File | Writes |
|---|---|
| `src/applications/applicationSubmission.js` | 2 — parameterised `set status=$1` (the general transition path) |
| `src/applications/executed_lease_service.js` | 3 — incl. `set status='accepted_term_required'` |
| `src/applications/applications.js` | 1 — `set status='lease_ready'` |
| `src/applications/proposed_terms_service.js` | 1 |
| `src/tenancy/tenancy_anchor_service.js` | 1 — `set status='active'` |

Eight statements across five files. Consolidatable. **Proceed.**

### Two facts the audit surfaced that change the plan

1. **The live status vocabulary is wider than migration 033.** It is
   `draft, submitted, approved, lease_ready, tenant_signed, countersigned,
   active, declined, withdrawn, expired` **plus** `accepted_term_required`.
   `expired` is a third terminal-ish state the ruling's `terminal_code`
   vocabulary (`declined | withdrawn`) does not cover — **needs a ruling**.

2. **`lead_events` may be better submission evidence than `created_at`.** It
   carries `event_type` including `application_started`, `lease_signed` and
   `lost`, each with a semantic `event_at`. If `application_started` reliably
   marks submission on a given path, it satisfies ruling 1's "existing semantic
   fact" test far better than row-creation time — and would rescue historical
   `submitted_at` coverage. To be evaluated during the writer audit.

---

## FINAL TWO RULINGS (settled 2026-08-01)

### A. `expired` is an application terminal disposition

`terminal_code` vocabulary is **`declined | withdrawn | expired`**.
`expired` carries `outcome_class: closed_without_target`.

An expired application is **not reopened in place** — a later pursuit is a new
application record, so one row never represents two attempts.

Three objects stay distinct:

| Object | Meaning |
|---|---|
| expired **invitation** | replaceable link; **not** an application terminal |
| expired **offer / packet** | may be superseded; **not** automatically terminal |
| expired **application** | this attempt closed without execution ⇒ `terminal_code = expired` |

Funnel treatment: `approved_at` present + `terminal_code = expired` ⇒ Funnel 3
**still converted** (approval was reached; later expiry does not erase it), and
Funnel 4 records expiration as terminal before execution. `approved_at` null +
expired ⇒ terminal without approval.

Backfill: `terminal_at = decided_at`, `terminal_code = 'expired'` where
`decided_at` exists and the row is consistently an application-level
expiration. **Never** derive `approved_at` from expired status alone.

`accepted_term_required` is **not terminal** — blocked/waiting work.

### B. `lead_events.application_started` is NOT submission evidence — ruled NO

Two reasons, both accepted:

1. **Started ≠ submitted.** A person can open an application and never submit.
   Reinterpreting it would inflate the Funnel 3 denominator and make
   incomplete applications look submitted.
2. **It is vocabulary, not canonical evidence.** The AI-leasing audit already
   found `application_started` has no canonical opportunity-linked event
   source. The submission service writes `events.type = application_submitted`,
   but that generic event carries no `application_id`, so it cannot be matched
   historically when multiple attempts are possible.

**Forbidden correlation:** same person · same property · nearest timestamp ·
same unit · matching note text. That is inferred lineage.

Future authority is `lease_applications.submitted_at`, authored in the
submission transaction, with `leasing_lead_id` supplying opportunity
correlation. Historical backfill only from direct application-specific
evidence carrying `application_id`, or a deterministically proven
born-submitted path. Everything else stays null ⇒ `partial` / untrackable.

No new lead event is added for Slice 9.

---

## MIGRATION 124 — LANDED AND PROVEN AT THE DATABASE LEVEL

`124_application_lifecycle_milestones.sql` applies clean and idempotent.
Adds `submitted_at`, `approved_at`, `terminal_at`, `terminal_code` with
write-once triggers, transition-authoring triggers, and the conditional
backfill.

Enforcement probed against real Postgres — all eight behave correctly:

| # | Probe | Result |
|---|---|---|
| 1 | clear `submitted_at` | REJECTED — write-once |
| 2 | move `submitted_at` | REJECTED — write-once |
| 3 | cross into `approved` with no `approved_at` | REJECTED |
| 4 | cross into `approved` **with** `approved_at` | accepted |
| 5 | terminal status with no `terminal_code` | REJECTED |
| 6 | terminal with both code and instant | accepted |
| 7 | **`approved_at` after withdrawal** | **RETAINED** |
| 8 | invalid `terminal_code` | REJECTED |

Probe 7 is the review's headline defect closed at the database level: an
application approved and later withdrawn **keeps its approval milestone**.

Backfill deliberately NOT performed: `submitted_at` (no proven direct-submit
path yet), withdrawn terminal time (no ruling establishes `decided_at` as the
withdrawal instant), and `approved_at` for withdrawn/expired rows (original
approval time is not recoverable from current status).

## REMAINING WORK ON THIS BRANCH

```
migration 124 schema            DONE, proven
writer audit                    DONE, stop condition cleared
─────────────────────────────────────────────────────────────
author milestones in the 8 writers across 5 files   NOT STARTED
canonical appointment-journey builder               NOT STARTED
re-grain funnel 2 to opportunity                    NOT STARTED
pending/terminal from lead_events                   NOT STARTED
READ ONLY REPEATABLE READ snapshot + savepoints     NOT STARTED
metric_contract: metric_kind + refusals             NOT STARTED
reject client as_of; 366-day cap                    NOT STARTED
timezone hardening (append-only, payload idempotency) NOT STARTED
bounded reads + scale fixture + EXPLAIN             NOT STARTED
delete LIFECYCLE_ORDER / reached() from evidence    NOT STARTED
eleven negative controls                            NOT STARTED
app renderer                                        NOT STARTED
```

---

## MIGRATION 124 AMENDED — structural holes closed (2026-08-01)

Amended in place rather than superseded: 124 is branch-only and has never been
recorded in any shared environment (verified — no `main` history for the file).

Four holes, all confirmed against the live code before fixing:

| Hole | Reality that exposed it |
|---|---|
| Enforced on `UPDATE` only | `applicationSubmission.js` **INSERTs directly at `'submitted'`** — the trigger never fired |
| Matched exact labels `submitted` / `approved` | `applications.js:455` advances **straight to `'lease_ready'`** — approval was never caught |
| No jump detection | `submitted → lease_ready` crossed the approval boundary unchecked |
| `terminal_code` unconstrained vs status | `status='declined'` with `terminal_code='withdrawn'` was accepted |

**Now enforced by three immutable group functions** (`ps_app_reached_submission`,
`ps_app_reached_approval`, `ps_app_is_terminal`) so boundaries are membership
tests, not string matches — a future status added to a group is covered without
a new trigger. The authoring trigger fires **`before insert or update`**.

Also added: a terminal application **cannot reopen** into a non-terminal status
(a later pursuit is a new application record).

### Ten negative controls, all correct

```
1  INSERT submitted without submitted_at          REJECTED
2  INSERT lease_ready without milestones          REJECTED
3  INSERT submitted with submitted_at             accepted
4  submitted → lease_ready without approved_at    REJECTED
5  submitted → lease_ready with approved_at       accepted
6  terminal status with mismatched code           REJECTED
7  terminal with matching code                    accepted
8  declined → submitted (reopen)                  REJECTED
9  approved_at survives the decline               RETAINED
10 draft → withdrawn, never submitted             accepted, submitted_at NULL
```

Control 10 matters: terminal status alone does not prove submission. A
withdrawn draft keeps `submitted_at` null rather than acquiring a fabricated
one.

### ⚠️ SUPERSEDED — "merge together" was not sufficient

Merging the migration and the writers in one commit does **not** remove the
risk. A rolling deployment runs the migration while the PREVIOUS application
instance is still serving traffic, and that instance inserts at `'submitted'`
with no `submitted_at`. Real prospect applications would fail for the length
of the rollout. Only **sequencing** removes it.

**124 is now expansion only. Enforcement moved to 125.**

| | Deployment A | Deployment B |
|---|---|---|
| Migrations | 123, **124 expansion** | **125 enforcement** |
| Code | canonical lifecycle writer + all 8 cutovers + corrected evidence API | none |
| Gate | every instance running A | proven in production |

`124` must stay compatible with today's writers — proven below. `125` must not
apply until every production instance runs A.

#### Proven in deployment order against real Postgres

```
after 124 expansion:
  old-style INSERT at 'submitted', no submitted_at      exit 0  (REQUIRED)
  old-style approval jump to 'lease_ready'              exit 0  (REQUIRED)

after 125 enforcement:
  old-style INSERT submitted, no submitted_at           REJECTED
  old-style jump to lease_ready, no approved_at         REJECTED
  historical declined -> withdrawn                      REJECTED
  historical declined + terminal_code 'withdrawn'       REJECTED (constraint)
  historical declined + MATCHING declined metadata      accepted
  terminal row, unrelated field, same status            accepted
  non-terminal row given terminal metadata              REJECTED
  declined -> expired                                   REJECTED
  11 historical rows with null milestones               survived untouched
```

Two holes closed this round: terminal status is now immutable **entirely**
(not merely "cannot become non-terminal"), and terminal correspondence is a
**standing table constraint**, so a historical row cannot later acquire a
mismatched `terminal_code` without changing status.

## NEXT — canonical lifecycle authority

`src/applications/application_lifecycle.js`, accepting an existing transaction
client, never opening its own. Operations: `markSubmitted`,
`markApprovedOrLeaseReady`, `markTenantSigned`, `markCountersigned`,
`markAcceptedTermRequired`, `markActive`, `markTerminal`. No generic
arbitrary-column update API. Then cut over all eight statements across the five
files, and add a source audit that fails when an unapproved source writes
`lease_applications.status` directly.

---

## ROLLOUT PROOF — WHAT IS AND IS NOT PROVEN

Correction to earlier handback language. I wrote that the rollout was "proven
end to end." It was not, and could not be.

**Proven, locally, in deployment order:**
```
migration sequencing
compatibility behaviour after 124 (old writers succeed AND author milestones)
strict refusal behaviour after staged 125
```

**NOT proven, and not provable in a local Postgres proof:**
```
every active production instance running Deployment A
BEFORE migration 125 executes
```
That is a production drain condition. It is an operational gate, verified
against the deployed fleet, not a test result.

## HISTORICAL-NULL BASELINE RECEIPT — `tools/application_milestone_baseline.js`

125 refuses future bad writes without manufacturing missing historical
milestones. Correct — and it creates a blind spot: a defective row written
during the rolling window lands in the same "milestone is null" population as
the legitimate historical exceptions, then survives enforcement unnoticed
forever.

The receipt closes it. Captured immediately after 124, re-verified before 125.
Digest is over the **sorted** id list, so it is comparable across runs and
cannot be quietly reordered into agreement.

| Category | Zero required? |
|---|---|
| submission-reached without `submitted_at` | no — legitimate historical |
| approval-reached without `approved_at` | no — legitimate historical |
| terminal without `terminal_at`/`terminal_code` | no — legitimate historical |
| `terminal_code` mismatched | **YES** |
| non-terminal carrying terminal metadata | **YES** |

**Rule: the population may shrink, never grow.** A new id is a rollout-window
truth gap.

### Proven against real Postgres

```
capture after 124   compat trigger present · strict absent
                    submission_reached_without_submitted_at   6
                    approval_reached_without_approved_at      4
                    terminal_without_terminal_metadata        1
                    terminal_code_mismatched                  0   (must be zero)
                    nonterminal_carrying_terminal_metadata    0   (must be zero)

verify, unchanged   "population did not grow" — PASS, exit 0
verify, after a defective row written with the compat trigger disabled
                    BLOCKER, offending id named, exit 1
```

The second case is the point: that row is indistinguishable from a historical
exception by shape alone. Only the id-level baseline catches it.

## STILL OUTSTANDING

```
canonical lifecycle authority + 8 writer cutovers   IN PROGRESS (workflow)
milestones must use transaction_timestamp(), never JS new Date()
canonical journey builder
Funnel 2 re-grained to opportunity
lead_events terminal truth
repeatable-read evidence snapshot
metric contract enforcement (metric_kind, invalid-shape refusal)
report-window enforcement (reject client as_of, 366-day cap)
timezone hardening
bounded reads + scale proof
API contract freeze
renderer
```
