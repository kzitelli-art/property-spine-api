# OPPORTUNITY SELECTION REQUIRED — THE INBOUND REPLY SEAM

Closes the operating seam left by migration 128's controlled refusal.
No renderer, no route, no mount, no new task system, no CRM workflow.

## 1 · CURRENT INBOUND BEHAVIOUR — PROVEN, NOT ASSUMED

Measured against real Postgres *before* anything was built:

| question | answer |
|---|---|
| message durably written? | **yes** — `comm_events` row survives |
| lifecycle event written? | **no** — correctly, nothing is guessed |
| waiting/control state changed? | **no** |
| conversation back in a visible queue? | **NO** |
| obligation created or reopened? | **none — 0** |
| who owns the next action? | **nobody** |
| discoverable without searching? | **no** |
| existing action to select an opportunity and reopen? | **none** |

The queue projection's own rule is `case when is_closed then 'none'` — a closed
conversation waits on no one. So `commercial_state='closed_not_fit'`,
`waiting_on='none'`, and the reply was **durable and invisible**. Before this
cut the auto-reopen cleared `is_closed` and the reply resurfaced; the refusal
removed that without replacing it.

**The Conversations door was not enough**, exactly as the ruling anticipated.

## 2 · WAS AN EXISTING PRIMITIVE SUFFICIENT? — YES

The canonical obligation engine (`spawnObligationFromEvent`) already carries
property, person, related object, explicit owner **or** `UNASSIGNED`, created and
due times, required proof inputs, dedupe key, parent/correction lineage. **No new
table, no second task rail.** One new obligation *type* is added through that
engine:

`resolve_inbound_opportunity` — *"Identify which leasing opportunity this inbound
reply concerns, then reopen that exact opportunity if appropriate."*

It is deliberately **not** written to `leasing_conversion_obligations`, because
that table requires the `conversion_id` we do not have and may not invent. It
links to the **conversation** until a human names the opportunity.

### One real schema limitation, stated rather than fudged

`obligations.source_event_id` references **`events`**, not `comm_events`, and
`obligations` has no comm-event column and no metadata jsonb. Writing the inbound
id there would violate the FK or claim a reference to a different object. So it
stays NULL and the inbound message rides the **dedupe key** —
`resolve_inbound_opportunity:<comm_event_id>` — which is durable, stable and
parseable (`inboundEventIdOf()`), and is repeated in the resolution proof.
**Promotion condition:** if `obligations` gains a comm-event reference, move it
there and delete the note.

## 3 · THE OPERATOR EXPERIENCE

> **This person replied after the opportunity was closed. Choose which
> opportunity this reply belongs to.**

Asserted to contain no "conversion", no "grain", no "lifecycle event".

## 4 · CANDIDATES — OFFERED, NEVER SELECTED

`listOpportunityCandidates` returns every exact candidate for the conversation's
person at that property, in stable `opened_at` order, each with its
**event-derived** closed state and last close reason. There is no `limit`, no
ranking, no "best match", and `auto_selected` is always `null`.

- **one candidate** → still `selection_required: true`
- **zero candidates** → unresolved and visible; not resolvable by choosing nothing
- **several** → unresolved until the operator chooses
- **wrong property** → structurally excluded; a cross-property read refuses

## 5 · RESOLUTION ORDER

Reopen **first**, close the decision only if the reopen succeeded — never close
on a promise.

1. reopen the exact opportunity via the canonical `reopenInTransaction`
2. record the attributed decision and actor as a durable proof event
3. complete the decision obligation
4. the inbound message and the prior terminal event are untouched

**Failure:** the reply stays visible, the decision stays **open** with the exact
blocked reason, and nothing is marked handled.

## 6 · PROOF TOTALS

**Inbound decision proof: 52 / 0.** Full suite twice on a clean database:
**895 / 0** and **895 / 0**, zero properties before and after.

All fourteen required cases proven, including duplicate-delivery idempotency,
message persistence through refusal, selective reopen isolation, decision closure
with proof, failed reopen leaving the decision open, and explicit `UNASSIGNED`.

Two guards were found over-broad while proving this and were tightened to test
behaviour rather than prose: the inbound reference assertion (which encoded a
column that means something else) and the "latest-creation pick" guard (which was
matching a per-candidate *display* lookup, not an opportunity selection).

## 7 · CONFIRMATIONS

- the operator always receives **one visible next decision**, owned or explicitly `UNASSIGNED`
- **no opportunity is ever inferred** — verified absent: last-active, latest-creation, message-timing, appointment-proximity
- `server.js`, `src/agent/` and all Ask Spine files untouched
- migration ceiling remains **128**; migration 125 untouched
