# SPINE CONVERSATIONAL SURFACE — READ AND RECOMMEND FIRST

**Status: DOCUMENTATION ONLY. No product code, no migration, no agent runtime,
no SMS, no write tools.**

One question, traced against current sources:

> **"What should I do today?"**

Not a generic agent. Not a priority engine. A briefing assembled from reads
that already exist, or an honest statement that a source is not good enough yet.

---

## 1 — Which objects can legitimately appear

Nine candidates. Each is classified in §10; none is assumed.

| # | object | the operational fact |
|---|---|---|
| 1 | **assigned obligations** | work owed by this employee |
| 2 | **overdue work** | past `due_at`, still open |
| 3 | **due-soon work** | approaching `due_at` |
| 4 | **unresolved maintenance** | open work orders |
| 5 | **tour follow-up** | conversion rungs owed after a tour |
| 6 | **application decisions awaiting action** | a decision gate is open |
| 7 | **unit-turn blockers** | a turn cannot proceed |
| 8 | **availability conflicts** | tour slots vs reality |
| 9 | **failed or reopened work** | `work_reopenings`, failed walks |

## 2 — The authoritative read for each

Read from the route registry. **No new query is proposed for any of these.**

| # | authoritative source | notes |
|---|---|---|
| 1–3 | `GET /operator/obligations` (`src/obligations/operator_obligations.js:60`) | the general obligation read |
| 5 | `GET /operator/leasing/follow-ups` | the cadence due-engine — **the strongest source here** |
| 5 | `GET /operator/leasing/task-queue` | conversion tasks, cursor-paged |
| 4 | `GET /operator/work-orders` (`src/maintenance/maintenance.js`) | filters on **property and status only** |
| 6 | `GET /operator/leasing/applications-review` · `/application-next` | |
| 7 | `GET /operator/readiness/queue` · `/operator/units/:id/turn-flow` · `/operator/unit-triage/open-walks` · `/operator/leasing/turn-priority` | four surfaces, not one |
| 8 | `GET /operator/leasing/availability-canonical` · `/operator/leasing/tours/today` | |
| 9 | `work_reopenings` · `/operator/unit-triage/risk` | no single operator read located for reopenings |

**Finding.** Every candidate has *a* source. Not every source carries enough
to rank or route confidently — which §10 is about.

## 3 — Authenticated actor scope

Already solved, and this packet inherits it rather than redesigning it.

`resolveStaffSession(x-staff-session)` → a real `users` row. The
write-authority packet made the actor **server-derived on every active staff
write**, and the same seam governs reads. The conversational surface calls
governed operator routes **as the employee**; it never queries around them.

**Consequence:** the agent can only ever see what that employee could already
see by opening the app. That is the correct ceiling and should not be widened
to "make the briefing better."

## 4 — Property scope

`req.operator.property_id`, server-derived. Every operator route already walls
on it.

**Open question, not answered here:** an employee assigned to several
properties. Is the briefing per-property, or merged with the property named on
each row? The row format in §11 carries `property` explicitly so either works,
but the choice is a product decision.

## 5 — Assigned directly to the employee

`obligations` carries a genuinely rich assignment model:

```
assigned_user_id · assigned_role · owner_type · ownership_origin
escalates_to_role · escalates_to_user_id
```

Direct assignment is `assigned_user_id = session user`. Unambiguous, and
`UNASSIGNED` is a real recorded state rather than a null nobody accounts for.

## 6 — Visible because the employee may cover or manage it

**This already exists and is better than expected.**
`GET /operator/leasing/follow-ups` resolves, per row, through the canonical
`resolveStaffIdentity`:

```
owner_basis  eligible_assignment | eligibility_lapsed | unassigned
```

Plus `obligations.owner_eligibility_state` and `escalates_to_role`.

So the system can already distinguish *owned by you* · *owned by someone whose
eligibility has lapsed* · *owned by nobody*. **That is the authority axis, and
it was not invented for this packet.**

## 7 — Dates and statuses that drive urgency

**Obligations** — `due_at` · `status` · `priority` · `severity` ·
`missed_at` / `missed_threshold_at` · `required_inputs` ·
`escalation_interval_minutes` · `requires_acknowledgment` / `acknowledged_at`

`missed_at` deserves note: the product ruled that **missedness is orthogonal to
lifecycle**. A missed obligation keeps its status and stays visible, because
the work still has not happened. The briefing must honour that — *missed* is
not *closed*.

**Follow-ups** — already computes `due_state` and counts
(`open`, `overdue`, `due_today`, `unassigned`, `anchors`, `siblings`).

**Work orders** — `urgency_status` · `urgency_basis` ·
`urgency_decided_by` / `urgency_decided_at` · `is_emergency` ·
`needs_pm_review` · `not_done_reason`

`urgency_basis` and `urgency_decided_by` matter: urgency here is a **recorded
human decision with an author**, not a computed guess. The briefing should
surface the basis, never substitute its own.

**No new urgency scoring is proposed.** Where a source already ranks
(`follow-ups`, `turn-priority`), that ranking is authoritative.

## 8 — Objects lacking sufficient authority or lineage

Named plainly, from the receipts audit and the reads above.

| gap | consequence for the briefing |
|---|---|
| `GET /operator/work-orders` filters on **property + status only** | cannot say "assigned to you" or "overdue" without a different read or a query change |
| `work_orders.assigned_to` exists but its semantics were not traced | must not be rendered as ownership on an unverified reading |
| **`events` has no actor and no application_id** | cannot say *who* decided or *which* application from history |
| **application approval records no actor anywhere** | cannot answer "who approved this" |
| tour events carry **no `property_id`** | property is a join, fine for display, not for scoping |
| **no single operator read for `work_reopenings`** | "failed or reopened work" has no assembled source |
| unit-turn state is spread across **four** surfaces | no single authoritative "is this turn blocked" answer |

## 9 — Exact destination per result

A row without a destination is a notification, not a briefing. **Every row must
open something.**

| object | destination |
|---|---|
| obligation / task | My Work → the obligation |
| follow-up | Person Card → the conversion |
| work order | the work-order detail |
| application decision | Application review → the application |
| unit turn | the turn page for the unit |
| tour follow-up | the tour workspace |
| availability conflict | the availability surface |

**Not verified in this packet:** that each destination accepts a deep link to a
specific record. Several app surfaces open from a board rather than by id. That
is a real gap and is listed in §14 rather than assumed away.

## 10 — Grounding classification

**SUPPORTED** — canonical source and exact destination exist

```
assigned obligations          /operator/obligations
overdue and due-soon work     due_at + status, both sources
tour follow-up                /operator/leasing/follow-ups — owner_basis,
                              due_state and counts already computed
application decisions         /operator/leasing/applications-review
```

**PARTIAL** — the fact exists; assignment, urgency or destination is incomplete

```
unresolved maintenance   work orders exist; the operator read carries no
                         assignment or due filter. Showable as "open work at
                         this property", NOT as "assigned to you"
unit-turn blockers       four surfaces, no single blocked/not-blocked answer
availability conflicts   the canonical read exists; what counts as a conflict
                         was not traced
```

**BLOCKED** — mutable, ambiguous, unscoped, or not reliably attributable

```
failed or reopened work  no assembled operator read located
"who did this"           events has no actor column; approval records none
"was this completed"     eleven of twelve writes have no recoverable receipt
```

## 11 — Proposed first-answer contract

**Structured facts, not prose.** Rendering is the channel's job.

```
You have 3 things that need attention:

1. Work order 1042 — overdue
   Unit 307 · assigned to you
   Next step: open the work order

2. Application for Jane Smith — waiting 18 hours
   Decision required · you have authority
   Next step: review the application

3. Unit 4B turn — blocked
   Final walk failed · maintenance follow-up open
   Next step: open the turn
```

Every row carries, as data:

```
canonical_object        type + id
property                property_id + name
reason_it_appears       overdue | due_soon | decision_required | blocked | …
urgency_basis           the SOURCE's basis, never a computed score
authority_basis         assigned_to_you | available_to_cover |
                        needs_manager | visible_not_actionable |
                        blocked_missing_information
destination             the exact surface + record id
source_timestamp        the date that made it urgent, named
```

### Priority and authority stay separate

An item may be **urgent but not yours**. Five authority states, not a boolean:

```
assigned to you
available for you to cover
needs manager attention
visible but not actionable
blocked by missing information
```

The existing `owner_basis` (`eligible_assignment` | `eligibility_lapsed` |
`unassigned`) maps onto the first three today.

### Fact and recommendation stay separate

```
FACT            Work order 1042 is overdue and assigned to you.
                — from the canonical read, attributable, storable

RECOMMENDATION  Complete it before starting the lower-priority inspection.
                — the agent's suggestion, NOT institutional truth,
                  never persisted as a fact
```

A recommendation must never be phrased so it could be quoted back as something
the system recorded.

## 12 — What the surface may explain but not act on

**May:** read · rank · summarise · explain why something is urgent · explain
who owns it · explain what is blocking it · link to the exact surface.

**May not:** complete work · approve or deny applications · send communications
· reassign tasks · change due dates · record tour outcomes · create financial
facts.

### Write eligibility, recorded

```
recoverable, potentially agent-eligible
  executed_lease.verify

NOT broadly agent-eligible
  tour operations            (5 — access path)
  application decisions      (2 — no immutable decision record)
  obligation/task operations (4 — no payload binding)
  reminder, outcome correction (2 — canonical write cannot execute)
```

**No conversational button is proposed around `executed_lease.verify`.** It is
eligible only because its record happens to be well built — it is a rare,
high-consequence action and a poor first agent experience.

**The agent must not imply an unavailable action can be completed
conversationally.** Sentences it must be able to say:

```
I can see this needs attention, but I cannot determine who owns it.
I cannot confirm whether that action was completed.
Open the application to review its current state.
```

The receipts audit is why: eleven of twelve active writes cannot produce a
payload-bound recoverable receipt, so the agent cannot honestly report
completion.

## 13 — Channel boundary

```
governed facts → ranked briefing → structured destinations → channel rendering
```

**One reasoning contract.** Dashboard is the primary design context; SMS is a
later delivery channel over the *same* briefing.

**Not solved here, deliberately:** SMS identity, confirmation, timeout and
recovery. Those are harder in every dimension and solving them prematurely
would contaminate the reasoning contract with channel concerns.

## 14 — Open questions before this becomes a slice

1. Multi-property employees — per-property briefing or merged?
2. Do the destinations in §9 accept deep links by record id? **Unverified.**
3. Should PARTIAL items appear with an honest caveat, or be withheld?
4. What is the right count — three items, or everything overdue?
5. Is "today" the operating day in the property's timezone?
   (`properties.operating_timezone` exists and is governed.)
6. Does the briefing read the six sources live per request, or is one assembled
   read needed? **No new read is proposed here** — this is a design question.
7. Is `work_orders.assigned_to` a user reference with ownership semantics? Not
   traced.

---

## The honest assessment

**"What should I do today?" is grounded enough to be worth attempting, and not
grounded enough to answer completely.**

The strongest column is leasing follow-ups — `/operator/leasing/follow-ups`
already computes ownership basis, due state and counts, which is most of a
briefing row. Obligations and application decisions are close behind.

The weakest is maintenance, and not because the data is poor —
`work_orders` carries urgency with a recorded human author, which is better
than most systems manage. The operator *read* simply does not expose
assignment or due filters.

**The recommendation, stated as a recommendation:** a first slice built only on
SUPPORTED sources would be genuinely useful and completely honest. Adding
PARTIAL sources would roughly double coverage and introduce the first place the
agent could mislead — by implying assignment it cannot verify.

Which of those two is the right first slice is the decision this document
exists to inform.

---

**No product code. No migration. No agent runtime. No SMS. No write tools.
No money changes. No Slice 10 changes.**
