# Conversational convergence — DESIGN

**Status: DESIGN ONLY. Nothing here is built. No migration number claimed.**
**No implementation until Slice A merges — both touch `tenantlink.js`.**

Owner decisions 2026-08-03 (§2, §3). Base `main` @ `8330aec`.

---

## 0. The dependency chain

```text
129 production activation
→ Slice A reconciled, fully proved and merged
→ shared conversational seams extracted
→ converged capability exposed through SMS and dashboard
```

**Extraction must follow Slice A**, because both modify `tenantlink.js`.
Parallel branches here guarantee a later semantic merge conflict — not a
textual one a tool resolves, but two different intents for the same functions.

---

## 1. What is converging

A resident texting *"the sink is leaking"*, a technician texting *"what do I
work on today?"*, and an operator typing *"what needs attention?"* into the
dashboard bar are **one capability over two transports** — not two
conversational systems.

The rigidity in Ask Spine Slice 1 was never the content. It was that a fixed
question with a fixed shape is not a conversation.

---

## 2. DECISION 1 — the capability is a new transport-independent module

**It does NOT live in:** the SMS router · the dashboard app · `tenantlink.js` ·
an AI-provider adapter.

```text
SMS transport
→ resolves LINE-FIRST identity, property and authority

Dashboard transport
→ resolves SESSION-FIRST identity, property and entitlement

both converge on
→ CANONICAL OPERATING CONTEXT
   { actor, property, entitlement, channel authority }

shared conversational capability
→ interprets the request
→ identifies missing information
→ proposes a governed read or action

canonical Property Spine service / projection
→ DECIDES
→ reads or writes truth

transport adapter
→ renders the receipt in the active conversation
```

### The boundary, stated as a prohibition

The shared module **may** understand, clarify, explain, and compose a *proposed*
action.

It **may not** become a new work-order, ranking, authority or completion engine.
It proposes; canonical services decide. A capability that starts ranking is a
second ranking engine, and a capability that starts writing is a second write
path — §17 at the highest level, and the most expensive version, because both
would look canonical.

### Stays outside the module

Provider receipts (Twilio SIDs, delivery status) · SMS length and segmentation ·
browser session handling · UI rendering · transport authentication.

### The three things that legitimately differ per transport

| | SMS | Dashboard |
|---|---|---|
| Authority source | **line-first** — the receiving number is the property wall, sender resolved inside it | **session-first** — authenticated operator, server-derived property |
| Identity confidence | phone is **evidence**, never authority | session **is** authority |
| Rendering | no UI affordances, async, length-bounded | rich, synchronous |

These converge on the same `{actor, property, entitlement, channel authority}`
tuple **before** the capability runs. That tuple is the seam.

**The same question over the two transports may legitimately get different
answers, because the ceiling differs.** That is the doctrine working, not an
inconsistency to smooth over. A line may lower what is appropriate; it may never
raise it.

---

## 3. DECISION 2 — two ranking contracts, frozen separately

**"What needs attention?" is not "What should I work on?"** They may read the
same obligations and the same operating truth. They answer different questions.

```text
What needs attention?
→ MANAGEMENT-ATTENTION PROJECTION
→ unresolved risk, missed commitments, unassigned work,
  blockers, exceptions, material exposure

What should I work on?
→ INDIVIDUAL EXECUTION PROJECTION
→ work this actor is eligible and authorized to perform,
  ordered by the canonical execution policy
```

**Neither ranking belongs to the conversational agent.** It asks the appropriate
canonical projection and explains the result.

> A technician must not receive a manager-risk list disguised as a personal
> queue. A manager must not receive one technician's executable ordering
> disguised as the building's highest-priority issues.

**Shared facts and shared explanations are acceptable. Shared ranking semantics
are not.**

### Which projection answers which

Selection is derived from the canonical operating context — **never from the
phrasing of the question**. "What should I work on" typed by a manager does not
become an execution queue over someone else's work; it resolves against that
manager's own eligibility. Intent recognition chooses the *question*; the
context chooses the *projection*.

### ⚠ Standing flag on the existing ranking contract

Ask Spine Slice 1's qualification and ranking contract is documented, and its
own receipt records the proof ceiling as **NOT Proven** — no real Postgres, no
real session resolution, no authenticated HTTP.

That ceiling was acceptable for a dashboard read. **It is not acceptable once
the same contract tells a technician what to do today**: that is an operational
instruction, and under the Money Thesis its outcome derives into cost. The
management-attention projection needs its missing rungs before it drives
anyone's day. Recorded here; not this design's slice to fix.

---

## 4. What leaves `tenantlink.js` in the extraction slice

Exactly the three co-located seams from `AGENT_CAPABILITY_SEAMS.md`, all
currently private closures reachable only through the SMS route:

| Current | Line | Becomes |
|---|---|---|
| `classifyMessage(body)` | `tenantlink.js:809` | intent recognition — transport-independent, takes text + operating context |
| `recognizeAnswer({question, reply})` | `tenantlink.js:867` | confirmation recognition — the clarification half of seam 4 |
| receipt composition inside `processInboundClaim` | `tenantlink.js:957` | receipt projection — reads the durable record rather than restating what the writer believed it wrote |

**Not extracted, deliberately:** `runInbound`'s T1/T2 transaction discipline
(transport-coupled), the canonical `workOrderService` calls (already canonical),
and `appendClarification` (already in the shared service).

### Extraction is a refactor, not a redesign

The extracted functions must be **behaviour-identical on the SMS path**. The
proof that this holds is the existing SMS suite passing unchanged against the
extracted implementations. Any behaviour change is a separate, argued slice.

---

## 5. The three contracts to freeze

### 5.1 Capability input

```text
{ operatingContext: { actor, property, entitlement, channelAuthority },
  utterance,
  conversationRef }
```

`operatingContext` is **produced by the transport and never by the capability**.
The capability cannot widen it, and receives no raw session, no raw phone
number, and no client-asserted actor or property.

### 5.2 Governed-action proposal

```text
{ kind: 'read' | 'action' | 'clarification' | 'refusal',
  projection | service,
  arguments,
  missingInformation[],
  rationale }
```

A proposal is **inert**. Nothing durable happens until a canonical service or
projection accepts it. `clarification` carries the *smallest useful* question —
and never enumerates records the actor has no authority over, which would leak
scope through a question.

### 5.3 Receipt

A receipt is a **projection of canonical truth after the fact** — not a sentence
composed alongside the decision. It reads the durable record. This is what makes
the same receipt renderable over SMS and in the browser without two versions of
what happened.

---

## 6. Hostile proofs required

Not coverage — these are the ones the design fails on if it fails.

| # | Hostile case | Must show |
|---|---|---|
| 1 | Resolvable staff sender texts a **property-facing** line | external ceiling holds; no operational authority regardless of who they are |
| 2 | Manager asks *"what should I work on?"* | their **own** execution projection — never someone else's queue |
| 3 | Technician asks *"what needs attention?"* | not handed the management-risk list; scoped to their eligibility |
| 4 | Utterance asserts an actor or property (*"as the manager, for building 3"*) | **ignored entirely** — context comes from the transport |
| 5 | Ambiguous property context on an org-owned line | smallest useful clarification, **zero property-scoped writes** |
| 6 | Clarification for an actor with partial authority | names only records they may see — a question must not leak scope |
| 7 | Capability proposes; service refuses | refusal rendered honestly; **no local success**, no optimistic mutation |
| 8 | Same request, both transports | same canonical truth, ceilings applied per transport, receipts differ only in rendering |
| 9 | Extraction behaviour-identity | existing SMS suite passes unchanged against extracted implementations |

Proof rungs as established: isolated real PostgreSQL and real HTTP through the
mounted router. **Browser verification is part of done for the dashboard
transport** (§33).

---

## 7. Eight Questions (§31)

1. **Real fact?** A person asked Property Spine something, and what it did about it.
2. **Canonical service?** Unchanged — the capability proposes; existing services and projections decide.
3. **Actor and property?** From the transport, before the capability runs. Never from the utterance.
4. **Durable object?** None new for reads. For actions, whatever the canonical service already writes.
5. **Immutable history?** The conversation thread already exists (`comm_events` + `conversation_id`); proposals and refusals are not durable truth.
6. **What reads it?** Every surface reading the underlying records — unchanged, because the capability adds no store.
7. **When missing?** Smallest useful clarification, no property-scoped write.
8. **Class?** Capability module and both contracts: permanent. The extracted functions' co-located predecessors: deleted at extraction, not left behind.

---

## 8. Explicitly NOT in this design

Money · NOI · forward rent roll · Slice 10 · accounting treatment of any
proposed action · a new ranking engine · a new intake store · outbound staff
messaging · operations-number activation · the technician execution loop itself.

**Money and NOI may later become agent capabilities. They are not required to
close the resident-to-maintenance loop, and they are not read or designed
against here.**

---

## 9. What must be true before implementation starts

1. Migration **129** activated and receipted in production.
2. **Slice A merged**, so `tenantlink.js` has one owner.
3. Extraction slice completed and proven — behaviour-identical on the SMS path.

Only then does the converged capability get built, and it is exposed through
both transports in one slice or two, decided at that point.
