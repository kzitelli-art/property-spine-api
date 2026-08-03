# APPOINTMENT-JOURNEY BUILDER — AUDIT

**Audit and design only. No code, no migration, no implementation.**
Returned for a ruling before any build.

---

## 0 · REPOSITORY STATE

| | API | App |
|---|---|---|
| `origin/main` | `f85f70b` | `30e550b` |
| Working branch | `claude/slice-9-demand-evidence-mcxvav` @ `0168f9a` | same name @ `340bbc8` |
| Ahead / behind main | 38 / 0 | 2 / 0 |
| Clean | yes | yes |

### Ask Spine — inspected directly, not from the prior census

| | |
|---|---|
| Branch | `claude/ask-spine-slice-1` @ `17c5a68` · 7 ahead / 0 behind |
| Landed on main? | **No.** `origin/main` is still `f85f70b`; zero `ask_spine` files on main |
| Current file set (re-read) | `docs/ASK_SPINE_SLICE_1_RECEIPT.md` · `server.js` · `src/agent/ask_spine.js` · `src/agent/ask_spine_service.js` · `tests/ask_spine_{contract,db,http}_proof*` · `tools/ask_spine_e2e_seed.js` |
| **Named-file overlap with Slice 9** | **`server.js` only** — unchanged from the earlier check |

No rebase is due: Ask Spine has not landed. The junction remains their mount
insertion (~line 3150) against my deleted mount (was 3174). **A shared junction
file is not shared product authority.**

### Other branches touching journey-adjacent files

`fix/prospect-text-punctuation…` (789 ahead), `fix/scheduling-adapter-seam-require`
(793), `agent/governed-terms-review-big-build` (674), `tools/qa_provision.js`
(444). These are hundreds of commits ahead of main and are **not active lanes** —
they appear to predate a history rewrite. They touch `leasingscheduling.js`,
`tour_outcome.js`, `tour_chips.js`, `schedulingAdapterSeam.js` and migrations
096/097. **Flagged as a collision risk to re-check before implementation**, not
treated as current.

Every journey-adjacent file on my branch (`src/evidence/*`,
`leasingconversion.js`, `leasingleads.js`) came from the **inherited 27
commits**. My 11 commits touched none of them.

---

## 1 · CANONICAL GRAIN — proposed: the **leasing opportunity**, with a stated
## attribution rule

### What the schema actually says

There are **TWO parallel appointment models with no foreign key between them**:

| | `leasing_tours` (native) | `scheduled_tours` (external ingest) |
|---|---|---|
| Anchor | `lead_id → leasing_leads` | `person_id` + `property_id` |
| Unit | `unit_id` | *none* |
| Status vocabulary | requested · scheduled · confirmed_by_prospect · checked_in · completed · no_show · cancelled · rescheduled | scheduled · rescheduled · cancelled |
| Attendance | `checked_in_at` · `completed_at` · `no_show_at` | **cannot be expressed** |
| Reschedule | `rescheduled_from` self-FK → **chain** | `previous_start/end` + `reschedule_count` → **counter only** |
| History | `tour_events` (immutable, typed, actor-typed) | `scheduled_tour_revisions` |
| Origin | `origin`: scheduled \| walk_in | `source_system`, `external_appt_id`, `authority` |

`scheduled_tours` **has no attended/no-show vocabulary at all.** An external
appointment can be scheduled, moved or cancelled — never observed. That is a
hard boundary on what any journey can claim about imported appointments.

### The opportunity already flattens ONE appointment onto itself

`leasing_conversions` carries: `origin_tour_id → leasing_tours`,
`scheduled_tour_id → scheduled_tours`, `scheduled_tour_host_user_id`,
`actual_tour_host_user_id`, `tour_outcome`, `tour_notes`,
`feedback_recorded_by_user_id`.

**The single-appointment assumption is baked into the schema**, and the source
already knows it — `leasingleads.js:1911`:

> *"origin_tour_id, because a second tour reuses the first tour's conversion and
> origin_tour_id would miss it entirely."*

That comment is the audit's central finding, written by the codebase about
itself.

### Why opportunity, not appointment

- **Not appointment**: an appointment is a row; a reschedule chain is the same
  journey continuing. Appointment grain would report one prospect moving twice
  as three journeys — the exact error `tour_demand.js` already corrects.
- **Not person × property**: `leasing_conversions_one_active` is UNIQUE on
  `(person_id, property_id) WHERE status='active'`, so at most one *active*
  opportunity exists per pair, but **historically many**. Person × property
  would merge a prospect's 2025 enquiry with their 2026 one.
- **Opportunity** is what Funnel 2 is being re-grained to, and it is a real
  durable object with an open/close window (`opened_at`, `closed_at`).

### The attribution problem — the load-bearing unknown

Tours attach to the **lead**, opportunities attach to the **lead**. There is no
`conversion_id` on either tour table.

```
leasing_leads ──< leasing_tours          (many)
      └────────< leasing_conversions      (many over time, one active)
```

So *"which opportunity does this tour belong to?"* has **no durable answer**
today. Candidate rules, none free:

| Rule | Cost |
|---|---|
| `origin_tour_id` | Misses every tour after the first — source says so explicitly |
| Time window (`opened_at` ≤ `scheduled_for` ≤ `closed_at`) | Inference from proximity in time — forbidden by question 7 |
| One-conversion-per-lead assumption | False; the schema permits many |
| New durable link | **Migration — forbidden in an audit** |

> **STOP CONDITION CANDIDATE.** If the ruling requires per-opportunity
> attribution of *every* appointment, that needs a durable
> tour → conversion link and therefore a migration. I have not chosen a rule.

---

## 2 · SOURCES OF FACT — recorded vs inferred

| Journey fact | Recorded where | Inferred? |
|---|---|---|
| scheduled | `leasing_tours.scheduled_for` + `tour_events(scheduled)` · `scheduled_tours.scheduled_start` | recorded |
| rescheduled | `leasing_tours.rescheduled_from` (chain) + `tour_events(rescheduled)` · `scheduled_tours.previous_start/end`, `reschedule_count` | recorded, **two incompatible shapes** |
| cancelled | `cancelled_at` + `tour_events(cancelled)` · `scheduled_tours.status='cancelled'` | recorded |
| attended | `checked_in_at`, `completed_at` + `tour_events(checked_in\|completed)` | recorded — **native only** |
| no-show | `no_show_at` + `tour_events(no_show)` | recorded — **native only** |
| **actual host** | `leasing_conversions.actual_tour_host_user_id` | **recorded on the OPPORTUNITY, not the appointment** — unattributable when there are several |
| scheduled host | `leasing_tours.leasing_agent_id` · `scheduled_tours.scheduled_host_user_id` · `leasing_conversions.scheduled_tour_host_user_id` | recorded in **three** places |
| outcome captured | `leasing_conversions.tour_outcome` (+`tour_notes`, `feedback_recorded_by_user_id`); prompt lifecycle in `tour_outcome_prompts` | **recorded on the OPPORTUNITY** — same flattening |
| units shown | `tour_units_shown(tour_id, unit_id, shown_order)` | recorded, appointment-grained |
| conversion/application consequence | `lease_applications.conversion_id`, `application_intents`, `leasing_conversion_obligations` | recorded |
| correction / reopen | `leasing_conversation_tour_links.unlinked_at` + `unlink_reason`; `scheduled_tour_revisions` | recorded — **only for `scheduled_tours`** |

**Two writers of `tour_outcome`**: `leasingleads.js:2331` and
`leasingconversion.js:244`. Both write the opportunity column, not the
appointment.

---

## 3 · MULTIPLE APPOINTMENTS — prior art exists and must be composed

`src/evidence/tour_demand.js` **already** resolves reschedule chains to a root,
iteratively, with a visited set, and reports cycles / missing parents /
cross-property parents as **untrackable rather than guessing**. Its doctrine:

> *A scheduled tour is a CLAIM. A completed tour is PROOF. A no_show is
> EXPOSURE. A cancellation is a LOST APPOINTMENT. A reschedule is the SAME
> journey continuing.*

The builder should **consume this, not restate it**. What it does *not* do is
attribute chains to an opportunity — it is lead-grained.

Proposed precedence for several appointments under one opportunity, **stated,
never first-row/latest-row**:

1. Collapse each reschedule chain to its root → one *appointment journey*.
2. Report journeys as a **list**, never a single status.
3. Derive opportunity-level facts only where a governed rule exists:
   - **any** journey `completed` → the opportunity has an observed visit;
   - **no** journey completed and ≥1 `no_show` → exposure;
   - **all** journeys cancelled → lost appointments, no visit;
   - **none** resolved → `unknown`.
4. Two journeys with **contradictory** outcomes → `conflict`, both named, no
   winner picked.
5. Untrackable chains stay untrackable and are excluded from rates with a count.

---

## 4 · PENDING vs OCCURRED vs TERMINAL — kept separate

| Axis | Source | Never |
|---|---|---|
| scheduled future work | `scheduled_for` > now, status scheduled/confirmed | written into history as though it occurred |
| observed event | `tour_events` rows, `completed_at`/`no_show_at`/`checked_in_at` | inferred from a future date passing |
| current opportunity state | `leasing_conversions.current_stage`, `status` | used as evidence a visit happened |
| terminal opportunity evidence | `closed_at`, `status` | conflated with an appointment outcome |
| open obligation | `leasing_conversion_obligations` | treated as an occurrence |

**A past `scheduled_for` with no observed event is `unknown`, not
`no_show`.** `no_show` is an affirmative recorded fact (`no_show_at`), and
inferring it from a lapsed clock is exactly the forbidden move.

---

## 5 · EXISTING AUTHORITY — compose, do not duplicate

| Module | Lines | Answers |
|---|---|---|
| `src/evidence/tour_demand.js` | 192 | reschedule chains → journeys; claim vs proof; untrackable |
| `src/evidence/conversion.js` | 240 | the four funnels as **origin cohorts** with pending reported |
| `src/evidence/metric_contract.js` | 232 | the metric envelope every evidence number uses |
| `src/leasing/tour_outcome.js` | 576 | outcome capture + prompt lifecycle |
| `src/shared/tour_window.js` | 153 | property-local windowing |
| `src/leasing/leasing_desk_loader.js` | — | one repeatable-read snapshot composition |

**`src/identity/operator.js` is the only file reading BOTH tour tables** — the
existing de-facto junction, and the place duplicated meaning would appear first.

---

## 6 · WHAT FUNNEL 2 ACTUALLY NEEDS

Funnel 2 is *completed tour → submitted application*. `conversion.js` currently
joins `leasing_leads` + `leasing_tours` — **lead-grained**, which is precisely
why it needs re-graining. Minimum outputs, nothing more:

1. `opportunity_id`
2. `appointment_journeys[]` — root id, state, first scheduled, observed at,
   host, units shown, `untrackable` flag
3. `observed_visit` — `true | false | unknown | conflict`
4. `observed_at` — governed timestamp or null
5. `attributed_host_user_id` — or `UNASSIGNED` / `ambiguous`
6. `outcome` — recorded value or `not_captured`
7. `application_consequence` — application id or `none`
8. `evidence_state` — `complete | incomplete | conflict | untrackable`
9. `external_appointments_present` — boolean, because those can never be observed

Deliberately **excluded**: tour counts as a headline, conversion percentages,
agent leaderboards, no-show rates by hour, calendar rendering. Those are
reporting-software instincts, not Funnel 2 inputs.

---

## 7 · DISAGREEMENT AND ABSENCE

The builder must expose `conflict`, `unknown`, `untrackable`, `incomplete` and
explicit absence, and must **never** infer attendance, outcome, conversion or
responsibility from labels, time proximity, conversation text or current status.

Known disagreement shapes already present:

- `leasing_conversions.tour_outcome` set while **no** native tour reached
  `completed` → **conflict**, not an outcome.
- `actual_tour_host_user_id` set on an opportunity with **several** completed
  journeys → **ambiguous**, not attributed to the latest.
- `scheduled_tour_id` and `origin_tour_id` both set → two appointment universes
  claiming the same opportunity → **conflict**, both reported.
- External appointment with a past start and no revision → **unknown**, never
  attended and never no-show.

---

## 8 · SMALLEST PURE READ-SIDE IMPLEMENTATION

One module, one function, no routes, no writer:

```
src/leasing/appointment_journey.js
  appointmentJourney(q, { property_id, opportunity_id | lead_id, as_of })
```

Reads only. Composes `tour_demand`'s chain resolution, `tour_window`'s
property-local windowing and `metric_contract`'s envelope. Writes nothing,
mounts nothing, adds no status, creates no table.

**No `server.js` mount in the implementation commit.** If a route is ever
needed, it is isolated in its own final integration commit after Ask Spine has
landed and Slice 9 has rebased.

---

## 9 · REAL-POSTGRES FIXTURE PLAN

Extend the existing `tests/fixtures/` pattern with a transaction-scoped
opportunity fixture — named scenarios, asserted population before behaviour,
rolled back, never Demo Building:

single completed · reschedule chain ×3 → one journey · cancelled-then-rebooked ·
no-show then completed · two completed with conflicting outcomes · scheduled
future only · past scheduled never observed (**unknown**) · cyclic chain
(**untrackable**) · parent in another property · external appointment only ·
external + native both present · outcome recorded with no completed tour
(**conflict**) · walk-in with no scheduled row · opportunity with zero
appointments · closed opportunity with a later appointment.

---

## 10 · STOP CONDITIONS ENCOUNTERED

1. **Tour → opportunity attribution has no durable link.** Per-opportunity
   attribution of every appointment requires a migration. *Ruling needed.*
2. **`scheduled_tours` cannot express attendance.** External appointments can
   never be `observed_visit: true`. Either they are reported as a separate,
   explicitly unobservable class, or they are out of scope for Funnel 2.
   *Ruling needed.*
3. **`actual_tour_host_user_id` and `tour_outcome` are opportunity-grained.**
   With several appointments they cannot be attributed to one. Either accept
   `ambiguous`, or a migration moves them to the appointment. *Ruling needed.*

---

## 11 · COMPONENT CLASSIFICATION

| Component | Class |
|---|---|
| `appointment_journey.js` read module | **1 · permanent** |
| Composition of `tour_demand` chain resolution | **1 · permanent** (reused, not copied) |
| Opportunity attribution rule | **2 · temporary** — removal condition: a durable tour→conversion link lands |
| External-appointment unobservable class | **2 · temporary** — removal condition: `scheduled_tours` gains observed vocabulary |
| Opportunity fixture + journey proof | **3 · test infrastructure** |
| `leasing_conversions.origin_tour_id` / `scheduled_tour_id` / `tour_outcome` / `actual_tour_host_user_id` as journey sources | **4 · delete-on-activation** — superseded once appointment-grained facts exist |

---

## STATUS

Audit complete. **Three stop conditions require rulings before code**, chiefly
the attribution grain. No migration, no renderer, no new statuses, no journey
table, no scheduling redesign, no Funnel 2 implementation. Slice 9 remains
frozen at `0168f9a`; `server.js` and `src/agent/` untouched.
