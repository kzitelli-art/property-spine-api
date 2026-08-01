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
