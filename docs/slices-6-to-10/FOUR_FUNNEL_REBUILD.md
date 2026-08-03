# SLICE 9 — FOUR-FUNNEL EVIDENCE REBUILD

All four funnels now read the same canonical opportunity, appointment,
application and lifecycle truth. No renderer, no route, no new charts, no
leasing analytics.

## 1 · WHAT EACH FUNNEL READ BEFORE

| funnel | grain before | authority before | defect |
|---|---|---|---|
| 1 opportunity → completed tour | **lead** (`leasing_leads` received) | `leasing_tours.status` via `journeyFinalStatus` | lead-grained; a "completed-looking" status, not an observed visit; pending inferred from a live-looking tour status |
| 2 completed tour → application | chain / lead | — | fixed in the prior cut |
| 3 submitted → approved | application | **a PRIVATE ladder inside `conversion.js`** | second copy of the vocabulary; cohorted on `created_at` |
| 4 approved → executed lease | application | same private ladder | cohorted on `decided_at` — which a DENIAL also sets |

Two concrete findings:

**A second lifecycle ladder existed.** `conversion.js` defined its own
`LIFECYCLE_ORDER`, `TERMINATED` and `reached()`. `application_lifecycle_read.js`
exists specifically to prevent that — *"A second copy is how the nine private
ladders this module replaces came to exist."*

**A stale limitation.** `conversion.js` carried the note *"lease_applications has
no submitted_at, so created_at is used as the submission instant."* Migration
124 — already on this branch — added `submitted_at`, `approved_at`, `terminal_at`
and `terminal_code`. The note was never updated and the columns were never
adopted, so an application drafted in one window and submitted in the next was
attributed to the wrong window.

## 2 · WHAT THEY READ NOW

| funnel | grain | authority |
|---|---|---|
| **1** opportunity → **observed visit** | `leasing_conversions.id` | appointment-journey projection; pending from the **lifecycle** authority |
| **2** opportunity w/ observed visit → submitted application | `leasing_conversions.id` | same rows as Funnel 1 |
| **3** submitted → approved | `lease_applications.id` | canonical ladder **by reference**; `submitted_at` / `approved_at` |
| **4** approved → executed lease | `lease_applications.id` | `approved_at` (not `decided_at`); admitted, non-void execution record |

**Funnels 1 and 2 are two questions about ONE shared read**, taken under one
coherent snapshot — so they cannot disagree about what happened.

`reached()` survives only as a thin adapter over `reachedSubmission` /
`reachedApproval` because the evidence proof imports it. It defines nothing.

### Honest consequences, not smoothed over

- **Funnel 1 pending changed meaning.** It was "has a tour whose status still
  looks alive". It is now a real unresolved act from the lifecycle authority.
- **Undateable milestones are untrackable, never assumed.** An application that
  reached submission with no `submitted_at` (pre-milestone history) cannot be
  placed in a window, so it is counted as untrackable and makes the metric
  `partial` — the same rule Funnel 4 already applied to undated approvals.
- **Source attribution stays lead-keyed.** `lead_source_touches` is a lead-grained
  fact and was NOT re-grained. One touch attributes every opportunity that lead
  opened in the window; overlapping by construction, never additive.

## 3 · FIXTURE CORRECTION

The evidence fixture seeded leads and tours but **no opportunities**, so the
re-grained Funnel 1 correctly produced an empty cohort. It now seeds the real
shape: a conversation and a durable `leasing_conversion` per prospect, with tours
attributed by `conversion_id`.

It also now sets `scheduled_for` as well as `created_at`. Those are different
facts — `created_at` is the booking instant tour demand cohorts on;
`scheduled_for` is what the journey authority reads to decide pending vs past —
and conflating them was masking the pending case.

## 4 · PROOF TOTALS

Evidence proof **61 / 0**. Full suite twice on a clean database: **896 / 0** and
**896 / 0**, zero properties before and after.

## 5 · REMAINING MUTABLE-STATUS READS

| read | classification |
|---|---|
| `leasing_leads.status` in the queue projection | queue position / display — legitimate |
| `leasing_conversions.status` in the funnel row | compatibility only; drives `label_disagrees_with_events` |
| `lease_applications.status` in `reached()` | milestone predicate **by reference** from the canonical writer; the durable timestamps are the cohort authority |
| terminal reads in the lifecycle projection | none |

## 6 · CONFIRMATIONS

No renderer, route, mount, migration, deployment or Slice 10 work. `server.js`
and `src/agent/` untouched. Ask Spine untouched. Migration ceiling **128**;
migration 125 untouched.
