# Conversational Staff Agent Readiness Audit — Slices 1–9

**Status: QUEUED. Do not begin until Slice 10 is complete and its receipt is
written.** Owner-authored brief, preserved as issued. This document is the
instruction; it is not a summary of one, and it should not be paraphrased into
a handoff.

**This is an audit, not a build.** It produces a document and a matrix. No
code, no routes, no services, no migrations, no tools, no wrappers, no PR.

---

## Sequencing

Finish Slice 10 first: action-string classification, route integration, final
10B proof, receipt written. Do not interrupt or widen Slice 10 to accommodate
this document. Begin only after 10B is proven.

## What this is

The objective is not whether an agent can answer questions about Slices 1–9. It
is whether staff can eventually **operate those workflows conversationally while
every material result is still recorded through the existing canonical
services.**

The chain being tested, end to end:

```
employee speaks naturally
→ Spine resolves the operating context
→ Spine identifies the exact governed read or write
→ employee supplies only the missing fact, judgment, or proof
→ canonical service records it
→ durable event and receipt remain
→ obligations and projections update
→ Spine explains what changed
```

## Hard constraints

Produce no code. Do not redesign Slices 1–9 to make them look agent-ready;
preserve the canonical domain services already built.

Do not build, and do not recommend as a first step:

```
a general agent runtime
a universal write endpoint
a generic task creator
a generic event table
a second conversation ledger
a browser-side intent router
an AI-owned priority engine
```

**Rule 11 applies to the audit itself.** Read current live source. Record the
SHA of every file relied on. Do not audit from handoffs, prior summaries, slice
memory, or this document's own descriptions. Historical slice numbering may not
match the current source layout — audit by capability, not by remembered label.

**Claim discipline on every finding.** Label each Proven / Browser-verified /
Harness-proven / Locally-exercised / Built / Reported. A capability is never
"ready" because a route exists. Readiness requires the full chain through
durable receipt.

**Never write to Solo `9e2bb96e-08e2-41db-81c2-91055ceb50a3`.** This audit
performs no writes anywhere.

## Method — two passes

The full matrix across every capability is too large to ground honestly in one
sweep. A remembered matrix reads authoritative and sits at claim level Reported.
Split it.

**Pass 1 — breadth, cheap, total.** Every capability gets five facts and nothing
more:

```
capability
canonical READ service — exists? file:line
canonical WRITE service — exists? file:line
structured receipt returned? — yes / partial / no
first-look readiness class (A–I)
```

Every cell traced to current source. No inference. Where a service cannot be
located, say so — an honest gap beats a confident guess.

**Pass 2 — depth, on the shortlist.** From Pass 1, take the four to six
capabilities closest to tool-ready and run the full matrix on those only, with
SHAs. State the depth level per row. A traced row and a first-look row must
never look alike.

## Where to start

Begin with the **governed obligation-writing tool** that is already built and
proven but deliberately withheld from the live model. It is the only place in
the product where the full chain already runs, and it is the reference
implementation every other capability is measured against — resolution,
proposal, confirmation, canonical service, receipt.

Two outputs from that first inspection:

1. The concrete shape of a passing chain, described precisely enough to compare
   others against it.
2. An honest read on whether the withholding decision should be revisited —
   that is a decision to surface, not a gap to fill.

## Capabilities to inspect

```
staff identity and property entitlement
live-source and honest-empty behavior
Ask Spine and obligation attention
Person Card and staff communications
lead and person intake
tour booking
post-tour capture
follow-up obligations
application review
application approval and rejection
lease packet and execution evidence
renewal lifecycle
move-in queue and delivery gaps
availability and commitment truth
market and pricing evidence
maintenance work
unit turns and readiness
obligation acceptance, completion and reassignment
recently closed and durable receipts
```

## The Pass 2 matrix

One row per material read or write capability:

```
capability
example employee utterance
intent class
GRAIN — canonical atom the object actually lives at,
        and whether natural speech references that atom
canonical read service
canonical write service
authenticated authority
canonical object IDs required
required inputs
required human confirmation
required evidence or attachment
durable object changed
immutable event or history receipt
obligations created, updated or closed
downstream projections changed
canonical destination
honest failure states
current runtime proof level
agent-readiness classification
smallest missing seam
```

### On the grain column

This is load-bearing, not bookkeeping.

Unit-grained maintenance records feed a space-grained position model across six
tables in migrations 112–113, none carrying `space_id`. A capability can resolve
"307" perfectly, authenticate the actor, call a real service, and return a
receipt — and still write against the wrong atom. Without this column that
capability lands as A or C when it is actually a lineage gap.

For every row, state the atom the truth lives at, the atom the utterance
naturally names, and whether they match. Where they do not, the capability is
not agent-eligible until the grain is reconciled, regardless of how complete the
rest of the chain looks.

## Intent classes

```
READ · RECORD CLAIM · CONFIRM FACT · EXECUTE ACTION · MAKE DECISION
CORRECT RECORD · COMMUNICATE · NAVIGATE · UNSUPPORTED
```

Keep execution and decision separate. A technician completes a work item. A
manager decides a disputed or exceptional condition. The agent must never
convert one into the other.

## Readiness classifications

Exactly one per capability:

```
A — TOOL READY
    Canonical read/write, authority, confirmation boundary and receipt all exist.
B — READ READY
    The agent can explain the governed truth; no safe conversational write exists.
C — WRITE SERVICE EXISTS, WRAPPER MISSING
    The canonical mutation exists but needs a typed tool contract, confirmation
    schema, object-resolution rules, or structured receipt.
D — RECORDING GAP
    The real-world fact belongs in Spine, but no canonical service records it safely.
E — LINEAGE GAP
    The service exists, but conversational context cannot resolve one exact
    canonical object — including grain mismatch.
F — AUTHORITY OR PROOF GAP
    The object is known, but required authority, evidence, or confirmation is
    not governed.
G — BROWSER-TRAPPED
    Material interpretation, routing, or mutation meaning exists only in the app.
H — NOT AGENT ELIGIBLE
    Should remain a dedicated controlled surface, or is not presently safe.
I — COMPETING CANONICAL PATHS
    Two or more services claim the same truth and can disagree. No agent tool
    may be issued until one path wins.
```

Class I exists because the codebase currently contains a parallel raw-insert
work-order path alongside the canonical service, and two disagreeing
availability models. A capability in that state is not C and not D — it is
blocked on a ruling.

## Cross-cutting contracts to verify

**1. Canonical reference resolution.** For every tool candidate, record what the
employee may naturally say (`Unit 302 · Sarah · the renewal · that application ·
the disposal job · the one due today · the lease we just discussed`) against the
exact structured reference required (`property_id · person_id · space_id ·
unit_id · conversation_id · tour_id · application_id · renewal_id · lease_id ·
work_id · obligation_id`).

Conversational reference ("the first one," "her") is permitted only where the
prior turn retained the canonical ID. The model must never resolve ambiguity by
taking the first database row.

```
more than one qualifies → one narrow clarification
none qualifies         → state that no qualifying record was found
```

Never silently create a person, lease, work order, or obligation.

**2. Multi-intent utterances.** Real speech carries more than one operation:
*"307 is done and I need a part for 412."* Determine whether the architecture
decomposes these — each fragment getting its own object resolution, proposal and
confirmation — or refuses them. State which, and why. A completion write hidden
inside a compound sentence is the failure mode to design against.

**3. Confirmation boundary.** For each write, classify as one of:

```
executed immediately · confirmed once · confirmed with a consequence summary
confirmed with evidence · manager-authorized · not conversationally executable
```

```
"Add that Sarah prefers natural light."  → low-consequence attributed relationship fact
"Mark the renewal fully executed."       → exact renewal + execution evidence + confirmation
"Unit 307 is ready."                     → cannot bypass work completion, proof, or final-walk authority
"Change the rent to $2,150."             → not executable unless an authorized contractual
                                           or pricing service governs it
```

Ask only for the missing judgment or proof. Never make the employee repeat
context Spine already holds.

**4. Stated versus inferred facts in a proposal.** The stated risk is asking too
much. The real risk is the inverse: Spine fills four fields from context, gets
one wrong, and the human confirms because it is mostly right. Confirmation
fatigue turns "confirmed once" into a rubber stamp on Spine's own guesses.

*Requirement:* in any write proposal, facts the human stated and facts Spine
resolved from context must be distinctly marked. The human is confirming Spine's
inference — that is the thing at risk, not their own words returned to them.

*Requirement:* any proposal containing a number the human spoke — unit, rent,
date, amount — is read back before write. Voice-to-text mangles digits, the
utterance is the evidence, and a mistranscribed number reaching a durable write
is unrecoverable in a way a wrong sentence is not. Transcription risk raises the
confirmation boundary independently of consequence.

**5. Claim versus institutional truth.** Every write candidate identifies what
the employee supplied:

```
an observation · a reported statement · a preference · an operational claim
a contractual claim · a completion claim · a managerial decision · a correction
```

The raw utterance may be retained as attributed evidence. It must never
automatically become the strongest institutional truth state. For each,
determine: claim strength on receipt · what validates or promotes the claim ·
what proof is required · who may confirm it · how it can later be corrected.

**6. Canonical write services only.** The agent invokes the same services as the
screens. Never `POST /agent/update-record`, `/agent/complete-anything`,
`/agent/create-task`. Each tool calls one narrow canonical operation — record
post-tour outcome, submit application, record application decision, attach
execution evidence, admit executed lease, accept turn work, claim turn-work
completion, record unable-to-complete outcome, send governed communication,
complete exact obligation, record correction. Where no service exists, classify
it as a recording gap. Do not design a generic substitute.

**7. Structured write proposals.** Before a consequential write:

```
operation · target object · facts to record (stated vs. inferred, marked)
evidence supplied · facts still missing · consequences
obligations affected · projections affected · confirmation required
```

The model may phrase this naturally. The proposal itself must be structured and
server-verifiable.

**8. Receipts.** Every successful write returns a structured receipt:

```
operation performed · authenticated actor · property · canonical target IDs
before state where material · after state · evidence IDs · event IDs
obligations created/changed/closed · projections expected to change
occurred_at · recorded_at · idempotency or replay identity
```

The conversational response is rendered from that receipt. The agent never says
*Done · Recorded · Sent · Completed · Updated* unless a canonical service
returned a successful durable receipt. Provider delivery and durable recording
remain separate facts.

**9. The durable agent-interaction record.** Section 8 covers the receipt of the
domain write. This covers the record of the interaction that produced it —
currently unspecified anywhere. Determine what must be retained, and whether
anything today could hold it:

```
thread id · staff actor · property · channel · raw utterance
canonical IDs resolved, and how · tools invoked · proposal presented
confirmation given, by whom, at what time · resulting receipt IDs
prompt / model revision
```

This is the provenance for *why does Spine believe Sarah wants September 15* —
and the answer must be that a named human said it and confirmed this exact
proposal at this time, reachable from the record. It is also what the correction
lane must reach when a transcript was wrong.

*Constraint:* retained utterances scope to the operation they produced. A
general archive of staff speech attached to persons is the dossier the Person
Card doctrine forbids.

**10. Recovery and idempotency.** For every write service, determine behavior
when: the request times out · the browser loses connection · the write succeeded
but the receipt was not received · the employee repeats the instruction · a
voice transcript is resubmitted.

Correct recovery is: reread canonical truth → find the idempotency or event
identity → recover the actual result. Never blindly repeat a consequential
write.

**11. Honest non-answer states.** Every tool preserves the distinction between:

```
no qualifying record · ambiguous record · unsupported intent · missing authority
missing required evidence · conflicting truth · source unavailable · forbidden
write failed · write outcome unknown pending reread
```

Never collapsed into *I couldn't do that · Nothing found · Something went
wrong.* The conversational layer may simplify the language; the typed state must
survive.

**12. Scope of read.** A conversation has no empty slots. If the agent does not
mention money, the operator cannot distinguish *money was clean* from *money was
unreadable* from *money was never looked at* — all three produce a sentence with
no money in it. Every honest-blank protection in the product assumes a slot
where the blank renders. Prose has none.

Determine what it would take for an answer to carry its own scope of read —
which tools ran, which were unavailable, which were never called — without
turning every response into an audit report. **Flag this as requiring a product
ruling.** It is the conversation-specific replacement for the honest-blank rule.

**13. Communication and the line boundary.** `COMMUNICATE` crosses the
number-split boundary. *"Tell Sarah we're set for Thursday"* is a staff member on
the operations line causing an outbound to a resident on the property line.
Determine and state: which line an agent-initiated send leaves from · whether the
operations-line authority ceiling permits it · whether the property line can
carry a staff-authored message · what receipt distinguishes dispatch from
recommendation. This is the existing line doctrine applied to a new caller, not
a new safety model. Where the answer is not already structural, classify the
capability as authority-gap.

## High-value loops to test

**Leasing**

```
"What should I follow up on?" · "Open the oldest one."
"Sarah toured 405 and wants September 15." · "Send her the application."
"She submitted it." · "I approved it." · "The signed lease came back."
"Why isn't it on the Forward Rent Roll?"
```

**Move-in**

```
"What move-ins are blocked?" · "What is missing for Unit 204?"
"The welcome packet was delivered." · "Open the lease."
"Mark the delivery obligation complete."
```

**Maintenance and turns**

```
"What work is assigned to me?" · "Open 307."
"I replaced the disposal and tested it." · "Here's the completion photo."
"I can't finish because the part is unavailable."
"What is still blocking the unit?"
"The final walk failed because the refrigerator is not cooling."
```

**Management**

```
"What should I focus on?" · "Why is this first?" · "Who owns it?"
"What is waiting on me?" · "Which units lose rent next month?"
"Why is 302 excluded?" · "Open the underlying record."
```

Work the two canonical examples in full:

```
"Sarah toured 405. She likes the light, is worried about parking,
 and wants to move September 15."

→ Can Spine resolve Sarah, the tour, and Unit 405 exactly?
→ Is post-tour capture a canonical service?
→ Which parts are facts, claims, preferences, judgments?
→ What may be recorded immediately? What requires confirmation?
→ What obligation is created or updated?
→ What Person Card event appears?
→ What receipt proves the write?
```

```
"307 is done. I replaced the disposal and tested it. No leak."

→ Can Spine resolve one exact open work item?
→ At what grain does that work item live, and does "307" name it?
→ Can the authenticated actor complete it? Is proof required?
→ Which canonical completion service performs the write?
→ What happens if two disposal jobs are open?
→ What event and completion receipt remain?
→ What downstream readiness state changes — and at what grain?
```

## Special attention areas

**Ask Spine.** Audit the current secured attention endpoint as a reusable read
tool, not as the finished agent. Confirm: server-derived actor and property ·
module entitlement · honest unavailable state · stable ranking · canonical
result IDs · canonical destinations · follow-up reference support.

Record explicitly that a safe read does not by itself provide free-form
interpretation, conversation state, write proposals, write confirmation, or a
durable agent-interaction receipt.

Also record what the ranking does **not** know — waiting parties, move-in risk,
money impact, missing proof, blocking relationships, commitments, safety
sensitivity — and whether the operator's disagreement with a ranking could
itself be captured as an operating fact rather than tuned by hand.

**Person Card and communications.** Likely the strongest foundation. Verify
whether it can supply shared conversational context: person and property,
current relationship, messages, tour, application, renewal, lease, resident
state, open obligations, attributed non-message history. Keep the communication
ledger separate from operating events. A staff message saying work occurred is
not proof the domain operation occurred.

**Maintenance field work.** Audit the actor-scoped read gap already identified. A
conversational technician requires Spine to answer *"What is assigned to me?"*
without downloading all property work and filtering in the browser. Confirm
whether `assigned=me` or its current equivalent exists in landed source. Verify
that work instructions are plain and executable, not merely scope labels.

**Slice 9 truth contracts.** Treat lifecycle, availability, commitment, and
evidence contracts as agent-readable truth. No conversational write may modify
them through a read projection. Identify the exact canonical services that would
legitimately change application lifecycle, lease admission, availability,
pricing, commitment, and conversion evidence. Where the service does not exist or
remains separately gated, classify the instruction as unsupported or
authority-missing.

## Required output

```
source SHAs audited · deployed SHAs compared
Pass 1 table — every capability, five columns, depth level marked
Pass 2 matrix — shortlist only, full columns, SHAs

capabilities inspected
canonical reads found · canonical writes found
tool-ready · read-only · wrapper-missing
recording gaps · lineage gaps (incl. grain) · authority/proof gaps
browser-trapped meaning · competing canonical paths
unsupported conversational actions

canonical receipt contracts found
idempotency behavior found
conversation-reference requirements
agent-interaction record: what exists, what is missing

top ten staff utterances now supportable
top ten high-value utterances still blocked
smallest follow-up build packets
areas where no new code is needed
areas requiring a product ruling
```

Every finding carries its claim level. Nothing is called ready because a route
exists.

## Follow-up build discipline

Do not turn the audit into one large agent build. After the matrix, recommend
narrowly bounded packets. Illustrative only — the audit determines the real
order:

```
conversational reference and tool envelope
read-only governed tool registry
structured receipts and recovery
post-tour conversational capture
maintenance completion conversational capture
lease-execution conversational capture
authenticated composer and thread
voice transcription boundary
```

Each packet proves one complete loop:

```
utterance → object resolution → proposal → confirmation
→ canonical service → durable receipt → reread truth
```

**One ordering exception to weigh.** The tools-before-chat-box discipline is
correct, and a composer must not ship ahead of the domain tools and receipts. But
if the composer sits at the end of the packet list, months of wrapper work could
land before anyone tests whether the conversation is better than the screen.
Recommend where a thin, read-only composer over the first three or four proven
read tools should sit — it is cheap, reversible, and the only place that
question gets answered.

## Final standard

The audit succeeds when it can say, capability by capability:

```
Spine already knows the context.
The employee supplies the one fact Spine cannot know.
The system asks only for necessary confirmation or proof.
The canonical service records the truth.
The employee receives a receipt.
Every other surface updates from the same truth.
```

And, where that is not true, exactly which link in the chain is missing and what
the smallest seam is that closes it.
