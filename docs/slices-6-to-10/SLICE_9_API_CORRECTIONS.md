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
