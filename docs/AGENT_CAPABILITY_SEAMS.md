# Agent capability seams — standing requirement

**Status: doctrine. Recorded 2026-08-03. Nothing here is a build instruction.**

The SMS work-order path is **the first bounded capability of the Property Spine
agent**, not a standalone text parser. This file records the requirement and an
honest audit of how far the shipped source already meets it, so the next slice
extends it rather than deepens the fusion.

---

## 1. The requirement

Do **not** hardwire the experience as:

```text
message in → work order row out
```

Build it as:

```text
message in
  → the agent understands the request
  → a governed Property Spine action
  → a receipt back into the conversation
```

**The conversation never invents the work, its priority, its owner, or its
completion.** Property Spine remains the truth and decision layer underneath: it
determines what work exists, what order it belongs in, what information is
missing, what the person is authorized to do, and what proof is required. The
agent makes that truth easy to understand and act on in normal conversation —
nothing more.

The current slice stays narrow: someone texts the line, describes an issue,
Spine gathers **only the missing information**, confirms what it understood,
creates the canonical work order, and returns a clear receipt. But the same
conversation must later be able to carry:

```text
"What should I work on next?"
"Why is Unit 302 first?"
"Let the resident know I'm on my way."
"I finished it — attach these photos."
"What is still open in this unit?"
```

None of those may be answerable by the conversation itself. Each is a **read or
a governed action against canonical truth**, phrased conversationally.

---

## 2. The six pieces that must stay separate and reusable

| # | Piece |
|---|---|
| 1 | The raw inbound message and durable conversation thread |
| 2 | Resolved sender, property, and channel authority |
| 3 | Structured intent and referenced property records |
| 4 | Any clarification or confirmation before a write |
| 5 | The canonical work-order action itself |
| 6 | The execution receipt and updated property truth |

---

## 3. Honest audit against current source (`95f13c7`)

**Three of six are genuinely separate. Three exist but are private to the SMS
transport.** The distinction matters: the first group is reusable today, the
second is *separable* but not *separated*.

| # | Piece | Where it lives | Verdict |
|---|---|---|---|
| 1 | Raw message + conversation thread | `comm_events` insert in T1 (`tenantlink.js:1102`), carrying `conversation_id` | **SEPARATE.** Durable, its own record, written before any interpretation. T1 commits the claim flagged `needs_human=true` before processing begins. |
| 2 | Sender, property, channel authority | `commBoundary.resolveInboundSmsContext` + `communication_lines.lineAuthority` | **SEPARATE.** Its own module, its own proof. Strengthened by Slice A: authority is now a property of the *line*, structurally. |
| 3 | Structured intent + referenced records | `classifyMessage()` — a **private closure** in `tenantlink.js:809` | **CO-LOCATED.** It produces a structured object, but nothing outside the SMS route can call it. Unit/`place` resolution is entangled in the processing step. |
| 4 | Clarification before a write | `workOrderService.appendClarification` (canonical) + `recognizeAnswer()` — private closure at `:867` | **SPLIT.** The write half is canonical and shared; the recognition half is private. |
| 5 | Canonical work-order action | `workOrderService.createWorkOrder` | **SEPARATE.** The strongest seam. Every tenant work order produces an event and a routing obligation; the two raw inserts that bypassed this were removed in the SMS slice. |
| 6 | Execution receipt + updated truth | `reply` composed inside `processInboundClaim()`; the T2 `comm_events` update at `:1121` | **CO-LOCATED.** The receipt is composed at the same place the decision is made. |

### What this means concretely

`module.exports` returns **only a router**. `classifyMessage`,
`recognizeAnswer`, `processInboundClaim` and `runInbound` are closures inside the
module factory — not exported, and reachable only through the SMS route and the
browser door.

So an agent could not today call *"understand this request"* or *"produce this
receipt"* without going through an inbound SMS webhook.

**The good news, and it is the expensive part:** the canonical service boundary is
intact. Work is created, deduplicated, evented and routed by
`workOrderService` — not by the conversation. That is the seam that would have
been costly to undo, and it was never crossed. `processInboundClaim` decides
*whether* to act and *what to say*; it does not decide what a work order **is**.

**The risk, stated plainly:** `processInboundClaim` fuses intent → decision →
action → reply in one function and returns `{ c, createdType, createdId, reply }`.
That is the piece that would need **extraction, not rebuild** — and it is the
piece the technician loop will be tempted to copy rather than lift.

---

## 4. The rule for the next slices

1. **Do not deepen the fusion.** No new intent, clarification, or receipt logic
   goes into `processInboundClaim` or any sibling private closure. When the
   technician loop needs to understand a message, that understanding is
   extracted first and then used — by both callers.
2. **Every new conversational capability is a read or a governed action**,
   never a new source of truth. "What should I work on next?" is a read of the
   obligation engine's ordering. "Why is Unit 302 first?" is that ordering
   explaining itself. Neither is the agent deciding.
3. **Authority comes from the line and the person, never from the message.**
   Slice A made the ceiling structural; a conversational request may lower what
   is appropriate and may never raise it.
4. **A receipt is a projection of canonical truth**, not a sentence composed
   alongside the decision. When seam 6 is extracted, the receipt reads the
   durable record rather than restating what the writer believed it wrote.
5. **Clarification is a governed pause, not a parsing retry.** It already keys
   on the outbound question actually sent, never on `obligations.person_id`.
   Keep that.

---

## 5. Classification (§18)

| Component | Class | Removal / extraction condition |
|---|---|---|
| Seams 1, 2, 5 | permanent, reusable | — |
| `classifyMessage` as a private closure | **temporary co-location** | extracted to its own module when a second caller needs intent — expected at the technician loop |
| `recognizeAnswer` as a private closure | **temporary co-location** | extracted with seam 4 when a second caller needs confirmation |
| Receipt composition inside `processInboundClaim` | **temporary co-location** | extracted when a receipt must be produced for a non-SMS channel, or when any receipt must survive a re-read |

None of these is a defect today. Each is recorded so that "we'll separate it
later" has a written condition attached rather than being a hope.

---

## 6. Not a build instruction

This slice does not extract anything. The audit above is the deliverable: the
next thread inherits a map of which seams are real and which are co-located,
instead of discovering it mid-build.

**We are not building the full agent. We are making sure the first SMS workflow
becomes one of the tools that agent can safely use later, rather than something
that has to be torn apart and rebuilt.**
