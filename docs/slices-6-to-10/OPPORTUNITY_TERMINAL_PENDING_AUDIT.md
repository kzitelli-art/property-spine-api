# SLICE 9 — OPPORTUNITY TERMINAL AND PENDING TRUTH — SOURCE AUDIT

**HALTED AT THE AUDIT. Stop conditions 1 and 2 are both triggered.**
Documentation only. No implementation, no migration, no route, no renderer.

Branch `claude/slice-9-demand-evidence-mcxvav` @ `9901979` · API `main` `f85f70b`
Ask Spine: `ask-spine-slice-1` @ `17c5a68` (7 ahead, not landed) ·
`ask-spine-source-audit` @ `d2f14c5` (landed). No overlap. Not touched.

---

## 1 · THE FINDING IN ONE LINE

**Pending truth is available at opportunity grain today. Terminal truth is not.**

The codebase already contains an excellent append-only lifecycle rail with
governed reason codes, explicit reopen, sequence ordering under a lock and
correction events — everything the phase asks for **except the grain**. It is
keyed on `conversation_id`, and a conversation is unique per
`(property_id, person_id)`, so it is strictly coarser than an opportunity.

---

## 2 · INVENTORY — CURRENT SOURCES AND WRITERS

| act | where it lives today | grain | is it an event? |
|---|---|---|---|
| opportunity creation | `leasing_conversions` insert (`leasingconversion.js`) | **opportunity** | no — a row, `opened_at` |
| close-not-fit | `leasing_lead_lifecycle_events.closed_not_fit` (`leasing_lifecycle_service.js`) | **conversation** | **yes**, governed |
| declined / lost | `leasing_leads.status='lost'`; `lead_events.lost` | lead | label + lead event |
| duplicate | `reason_code='duplicate'` on `closed_not_fit` | conversation | yes, governed |
| withdrawn | `lease_applications.status='withdrawn'` | **application** | no |
| expired | **does not exist** for leasing opportunities | — | — |
| leased / converted | `leasing_leads.status='leased'`; `leasing_conversions.status='converted'` | lead / opportunity | no — labels |
| reopen | `leasing_lead_lifecycle_events.reopened` | **conversation** | **yes** |
| correction | only `tour_link_corrected` — **no terminal correction event** | conversation | partial |
| pending follow-up | `leasing_conversion_obligations` + `leasing_conversion_obligation_events` | **opportunity** | **yes** |
| pending appointment | `leasing_tours.conversion_id` / `scheduled_tours.conversion_id` (migration 127) | **opportunity** | yes, via journey |
| pending application | `lease_applications.conversion_id` (migration 051) | **opportunity** | no — status |

### Vocabularies

`leasing_lead_lifecycle_events.event_type` — `closed_not_fit · reopened ·
tour_linked · tour_cancelled · tour_link_corrected`
`reason_code` — `budget_mismatch · program_mismatch · move_timing · location ·
duplicate · no_longer_interested · other` (**governed, not free text**; `other`
requires a non-empty note)

`leasing_leads.status` — `new · ai_responded · tour_requested · tour_scheduled ·
human_takeover · applied · leased · lost`
`leasing_conversions.status` — `active · converted · released`
`lead_events.event_type` — `lead_received · ai_text_sent · ai_response_prepared ·
prospect_replied · tour_requested · tour_scheduled · human_takeover ·
application_started · lease_signed · lost`

---

## 3 · CLASSIFICATION OF EVERY TERMINAL-LIKE READ

| read | classification |
|---|---|
| `leasing_leads.status in ('leased','lost')` | **UNAUTHORIZED SUBSTITUTE FOR AN EVENT.** Mutable, latest-wins, lead-grained, no reason code, no history, no actor. `leasing_lifecycle_service.js` states it outright: *"leasing_leads.status owns opportunity existence + exits."* |
| `leasing_conversions.status='released'` | **UNAUTHORIZED SUBSTITUTE.** Opportunity-grained but a bare label — no event, no reason, no time, no actor, no reopen history. |
| `leasing_conversions.status='converted'` | **UNAUTHORIZED SUBSTITUTE** for terminal-by-lease. |
| `leasing_lead_lifecycle_events.closed_not_fit` | **HISTORICAL EVIDENCE** — correct in kind, wrong in grain. |
| `leasing_lead_lifecycle_events.reopened` | **HISTORICAL EVIDENCE** — correct in kind, wrong in grain. Preserves the prior close (append-only, never deleted). |
| `lead_events.lost` | **HISTORICAL EVIDENCE**, lead-grained, no reason code. |
| `leasing_leads.status` in the queue projection | **QUEUE POSITION / DISPLAY STATE** — legitimate for that use. |
| `tour_demand` `final_status` | **DISPLAY STATE** of an appointment, not of an opportunity. Correctly scoped. |
| `conversion.js` `TERMINATED = {declined, withdrawn}` | **APPLICATION** lifecycle, not opportunity terminal truth. Correctly scoped. |
| `f1pending` (Funnel 1) | **INFERRED** — "has a live-looking tour status". Not an obligation, not an event. |
| Funnel 2 `no_appointment` | honest, but conflates "still live, nothing booked" with "over, never toured" — the gap this phase was to close. |

Funnels 3 and 4 read application and lease state only; neither reads opportunity
terminal truth. **No funnel currently reads a terminal *event*.**

---

## 4 · STOP CONDITION 1 — TERMINAL TRUTH CANNOT BE ATTRIBUTED TO AN EXACT OPPORTUNITY

`leasing_lead_lifecycle_events` columns: `id · conversation_id · property_id ·
event_sequence · event_type · actor_type · actor_id · reason_code · reason_note ·
source_comm_event_id · tour_id · correction_reason · idempotency_key ·
occurred_at · recorded_at · metadata`.

**There is no `conversion_id`.** `lead_events` has none either — its columns are
`id · lead_id · event_type · event_at · actor_type · actor_id · comm_event_id ·
metadata · created_at`.

## 5 · STOP CONDITION 2 — THE EVENTS CANNOT DISTINGUISH TWO OPPORTUNITIES

Demonstrated against real Postgres, not argued:

```
TWO opportunities, one person, one property:
  o1 older  (released): 9d2ddac0
  o2 current (active) : 6feb330f

the terminal event, as recorded:
  event_type:      closed_not_fit
  reason_code:     budget_mismatch
  conversation_id: b55114f5-…
  tour_id:         null

conversations for this person+property: 1   (unique index enforces exactly 1)
opportunities  for this person+property: 2

WHICH opportunity did closed_not_fit close?  UNANSWERABLE.
```

The enforcing constraints:

- `conversations_property_id_person_id_key` — **UNIQUE (property_id, person_id)**
- `leasing_conversions_one_active` — UNIQUE (person_id, property_id)
  **WHERE status='active'** — one *active* opportunity, but **many over time**

So one conversation necessarily spans every opportunity a person ever has at a
property. This is not a rare edge: the Slice 9 journey fixture already carries
two opportunities on one lead, and the accepted Funnel 2 contract requires them
to remain two distinct rows.

Attributing a conversation-grained close to an opportunity would require picking
"the opportunity active at the time" — inference from time and status, which is
exactly what this phase forbids.

---

## 6 · WHAT IS **NOT** BLOCKED

Pending truth is already opportunity-grained and needs no new structure:

| pending condition | canonical opportunity-grained source | exists? |
|---|---|---|
| future appointment scheduled | appointment journey, `conversion_id` (migration 127) | **yes** |
| observed visit awaiting outcome | `tour_events` via the journey projection | **yes** |
| explicit follow-up obligation open | `leasing_conversion_obligations.conversion_id` | **yes** |
| application process underway | `lease_applications.conversion_id` (migration 051) | **yes** |
| another governed decision open | `leasing_conversion_obligations` rungs | **yes** |

Real conditions, not "not terminal". No generic *active prospect* state is
needed or wanted.

---

## 7 · THE NARROW OPTIONS, FOR THE RULING

Not implemented. Presented so the decision is yours.

**A · Add `conversion_id` to `leasing_lead_lifecycle_events` (additive, mirrors
migration 127).** Same shape already accepted for appointments: nullable FK,
partial index, no backfill by inference, writer sets it from the server-resolved
opportunity. Historical events stay NULL and honestly `untrackable`. Reuses the
existing rail, its governed codes, its reopen semantics and its lock discipline.
Needs a migration → **stop condition 5 does not apply** (it creates no new
lifecycle system), but it is a migration and therefore your call.

**B · Ship pending truth now, leave terminal unknown.** No migration. Funnel 2's
`no_appointment` splits into real pending conditions; terminal stays
`coverage_state: unknown` with the gap named. Smaller, honest, and leaves the
central question open.

**C · Derive terminal from `leasing_conversions.status`.** **Rejected** — it is
the mutable latest-wins label the phase exists to stop reading.

A recommendation, since one is owed: **A**, because it is the same additive
bridge already accepted at 127, against a rail that is otherwise exactly right;
with **B** as its first deployable step if a migration is not wanted in this cut.

---

## 8 · NOT DONE

No implementation, no migration, no route, no mount, no renderer, no funnel
aggregation change, no Slice 10 work. `server.js`, `src/agent/` and every Ask
Spine file untouched. Migration 125 untouched; ceiling remains 127.

---

# PART 2 — IMPLEMENTED (Option A ruling)

## 9 · MIGRATION AUTHORITY — ASSIGNED **128**

| step | evidence |
|---|---|
| API `main` | **moved during this session**: `f85f70b` → `10c43b3` (security-obligations lane, PR #32) |
| did that deploy add a ledger row? | **No** — `git diff f85f70b..main -- migrations/` is **empty**. No migration file changed, so the deploy could not have recorded one. |
| Neon ledger | last supplied: max **126**, `121 = ai_leasing_operating_context`. Still current by the line above. |
| all-branch, all-path scan | `125` staged only (`docs/slices-6-to-10/deployment_b/`), `126` on main, `127` mine (unmerged). **Nothing at 128+ anywhere.** |
| Ask Spine | `ask-spine-slice-1` `17c5a68` — 7 ahead, **not landed**, tops out at 126. `ask-spine-source-audit` `d2f14c5` — landed. **Zero migration overlap.** |
| Migration 125 | md5 `b4b817a5c3d65a01fef0783ccdc968b4`, still outside `migrations/`. **Untouched.** |

**Stated limitation:** I could not re-query Neon directly (production credentials
are out of scope). Currency is derived from main changing no migration file. The
runner's own "number already spent" guard is the backstop if that inference is
ever wrong. Independent corroboration: main's own commit `f6ab9f6` says
*"migration 121 has no file"* — the same finding reached separately.

## 10 · WRITER CENSUS AND CUTOVERS

| caller | can it supply exact identity? | outcome |
|---|---|---|
| `POST /operator/…/close-not-fit` | **yes** — route now takes `conversion_id` | cut over; **refuses 400** without it |
| `POST /operator/…/reopen` | **yes** | cut over; refuses 400 without it |
| `demo_reset.js` | **yes** — now enumerates OPPORTUNITIES and derives each conversation | cut over |
| `linkTour` / `cancelTour` / `correctTourLink` | **yes** — from the event's OWN named tour | carry `scheduled_tours.conversion_id` |
| `maybeReopenOnQualifyingInbound` (agent.js, leasingleads.js) | **NO** | **CONTROLLED REFUSAL** |

**Direction matters.** conversation → opportunity is one-to-many and forbidden.
opportunity → conversation is many-to-one and unambiguous; `demo_reset` walks
that direction, so each close is an explicit act against a named opportunity.

**`src/agent/` and `server.js` were NOT modified.** The inbound signature
defaults `conversionId` to `null`, so those callers refuse without being touched.

## 11 · STOP CONDITION 1 — TRIGGERED, HANDLED PER THE RULING

An inbound text identifies a **conversation**, not an opportunity. It cannot
supply exact identity, and choosing "the active one" is the guess this cut
removes. Per *"stop that path with a controlled refusal"*, it now writes no
event and returns `refusal_code: "opportunity_identity_required"`.

It does **not throw** — it runs inside the inbound-persistence transaction, so
throwing would roll back the prospect's message. The message is the real fact and
survives; only the unattributable reopen is withheld.

**BEHAVIOUR CHANGE, STATED PLAINLY:** a closed opportunity no longer reopens
automatically when a prospect replies. An operator reopens explicitly, naming the
opportunity. Restoring automation requires the inbound path to carry an
opportunity — separate governed work. **This is the one item that most deserves
your review.**

## 12 · HISTORICAL ATTRIBUTION COUNTS

Permitted evidence is exactly one thing: an event's **own named tour**
(`tour_id` → `scheduled_tours.conversion_id`, migration 127). Following a pointer
the event already carries is lineage, not inference.

| bucket | count (proof fixture) |
|---|---|
| exactly attributable | **0** |
| already correct | 0 |
| conflicting | 0 |
| **untrackable from existing evidence** | **1** (all historical `closed_not_fit` / `reopened`) |
| written | **0** |

`closed_not_fit` and `reopened` carry **no** source object naming an opportunity,
so no exact evidence exists for them — permanently, absent an explicit governed
correction. Verified absent from the backfill: active-conversion lookup,
person+property, lead, time-proximity.

## 13 · CONTRACTS

**Terminal** — `lifecycle_state` ∈ `no_terminal_event · terminal ·
reopened_after_terminal · conflict · incomplete · untrackable`, plus
`terminal_code`, `terminal_occurred_at`, `terminal_event_id`,
`reopened_after_terminal`, `latest_reopen_event_id`, full `terminal_history`,
`conflict_codes`, `coverage_state`, `source_event_ids`, `as_of_utc`.

Ordering uses the rail's existing per-conversation `event_sequence`, filtered by
exact `conversion_id`. **The rail was not rewritten.** `occurred_at` is used only
for as-of windowing, never to order two events — clock skew is not chronology.

**Pending** — `pending_basis` ∈ `future_appointment_scheduled ·
observed_visit_awaiting_outcome · open_follow_up_obligation ·
application_process_underway`; `pending_state` ∈ `pending · no_known_pending_act ·
pending_unknown`. **"Not terminal with nothing pending" is its own answer and is
never called "active".**

## 14 · FUNNEL 2 INTEGRATION

`no_appointment` — which conflated "still live, nothing booked" with "over, never
toured" — now splits by **events only**:

```
terminal_never_toured · live_with_pending_act · live_no_known_pending · lifecycle_unknown
```

The split reconciles exactly to the bucket it partitions (asserted, and
recomputed independently). A row with missing or unusable lifecycle evidence
lands in `lifecycle_unknown`; it is **never** repaired from
`leasing_leads.status` or `leasing_conversions.status`.

Query count **12 = 10 material + 2 snapshot probes**, still constant — the
journey snapshot is *shared* with the lifecycle authority, not taken twice, so
the two projections cannot disagree about what was scheduled.

## 15 · REMAINING MUTABLE-STATUS READS

| read | classification | status |
|---|---|---|
| `leasing_leads.status` in the queue projection | queue position / display | **legitimate**, untouched |
| `leasing_leads.status` in Funnel 1 `f1pending` | inferred pending | **still inferred** — Funnel 1 not rebuilt in this cut, per the ruling |
| `leasing_conversions.status` in the funnel row | **compatibility only**, carried for comparison | never evidence; drives `label_disagrees_with_events` |
| `lease_applications.status` in Funnels 3/4 | application lifecycle | correctly scoped, not opportunity terminal truth |
| terminal reads in the new projection | **none** | 0 code-level `leasing_leads` references |

## 16 · PROOF TOTALS

**Full suite twice against a clean database: `843 / 0` and `843 / 0`.** Zero
properties before and after. New: opportunity lifecycle **61/0**; funnel now
**92/0**; evidence **60/0**.

All seventeen required cases proven, including two opportunities sharing one
conversation classified independently, close/reopen isolation, terminal → reopen
→ terminal, stale-label-cannot-override, and stable as-of reads.

## 17 · BOUNDARIES

No renderer, no route, no mount, no generic lifecycle framework, no new CRM
status, no deployment, no Slice 10. `server.js` and `src/agent/` untouched in
this cut. Ask Spine untouched, re-verified at assignment time. Migration 125
untouched.
