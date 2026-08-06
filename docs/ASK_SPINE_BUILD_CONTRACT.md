# Ask Spine — Maintenance Agent Build Contract

**This is the build charter. Read it before writing any Ask Spine code.**
Companion: [`ASK_SPINE_SLICE_2_DESIGN_INPUT.md`](ASK_SPINE_SLICE_2_DESIGN_INPUT.md) —
the premortem and schema audit this contract was derived from.

Owner ruling, closing the Ask Spine Slice 1 thread. Sections 1–7 are decided.
Section 8 lists rulings still owed; nothing in Build 1 may be frozen until they
are answered.

State at authoring:

```text
RENDER_GIT_COMMIT   a04a1df      api main tip, deployed
app main            6220ca5      deployed
migration ceiling   136          reconciled, EXIT 0
communication_lines 1 row        property_facing, provider_configured = f
                                 NO operations row · no carrier wiring
```

---

## 1. Purpose

Let an operator understand and move real maintenance work through ordinary
conversation, without weakening the authority, evidence and receipt discipline
already built underneath.

```text
operator      ask → understand → see the work → act → receive confirmation

institution   resolve actor and property → resolve the intended question
              → declare required sources → execute canonical reads
              → judge source outcomes, fact usability and evidence age
              → determine supported conclusions → render controlled language
              → preserve a read receipt → perform an authorized action
              → preserve a write receipt
```

The employee should not need to understand the machinery. The system must still
be able to prove exactly what happened.

**The practical product test.** The system must never confuse:

- a successful query with a complete candidate population;
- an attachment with valid evidence;
- no evaluation with a failed evaluation;
- no recent operating event with stale data;
- unauthorized access with permission to reveal record existence;
- a request to create work with a request to send a message.

Each of those is a failure this codebase has actually produced.

---

## 2. Release 0 — canonical proof correction

**Ships before Ask Spine, as its own release with its own deployment, browser
proof and rollback path.**

- `unclassified` no longer satisfies valid completion proof.
  (`src/surfaces/work_order_status_read.js:90` currently includes it.)
- Audit existing open and completed work orders **first**.
- Do not reopen historical completions automatically.
- Add durable proof evaluations **only for new completion attempts**.
- **Do not backfill evaluations.** No evaluation row means legacy treatment.
- Evaluations are **append-only**; a re-evaluation creates a new superseding row.
- Scope evaluations with the composite `(work_order_id, property_id)` foreign key,
  matching `fk_wop_work_scope` in migration 134.
- Store supporting attachments through FK-backed rows, not an ID array.
- Record who or what performed the evaluation.

### The claim Release 0 may make

> There is one canonical implementation of work-order proof validity, and the
> existing Work Orders surface uses it correctly.

Ask Spine agreement is proven later. It cannot be proven here — Ask Spine does
not exist yet.

### Acceptance

- `unclassified` does not satisfy proof;
- valid classified evidence does;
- legacy completed work renders as **legacy**, not newly failed;
- no evaluation rows were backfilled.

### Ordering — app first

The reader emits `proof: { satisfied: <bool> }` today and the app consumes it.
Release 0 makes it at least three-valued: satisfied · not satisfied ·
legacy-indeterminate. That is a shape change to a live operator surface.

**The app handles the tri-state before the API emits it**, with a mismatch check
at the gate. The obligation authority release aborted at 2:06 PM on 2 Aug for
exactly this class of mismatch; that scar is the reason for this rule.

Release 0 therefore has an app deliverable, not only a rule change — *"legacy
renders as legacy"* is a rendering claim.

---

## 3. Build 1 — intent contracts and canonical reads

Freeze three intents. **Identify them by stable slug, never by number** — the IDs
are published immutably and written into every receipt, and the numbering has
already drifted once between contract revisions:

```text
maintenance.completion_without_valid_proof     freeze
maintenance.blocked_work                       freeze
maintenance.ownership_and_acceptance           freeze
maintenance.attention                          NOT frozen — see §7
```

Each intent contract declares:

```text
intent_contract slug / version / digest
candidate predicate
required and optional sources
source evidence-time columns
evidence-age rules
result cap
supported and withheld conclusions
consequence class
```

Published versions are immutable. **Reducing the required source set is a governed
and reviewed change**, because it weakens the basis on which a conclusion may be
drawn. The receipt records the exact version and digest used.

### 3.1 Candidate sets — the defect this exists to prevent

`readPropertyWorkOrderStatuses` (`work_order_status_read.js:325`) selects **the
latest 100 work orders** and derives each one in a loop (~5 queries apiece). Used
as-is, an intent answers over a recency window rather than the property: a
property with 300 work orders whose only unproven completion is #250 returns
`valid_empty` — a confident, fully-receipted, wrong answer.

**A fully successful read can still answer the wrong population.** No coverage
state catches a silently truncated candidate set.

Therefore:

- the predicate runs **in SQL** and expresses the actual condition — for Q1, the
  completion/proof condition, not a recency window;
- the same predicate produces **selected records, total matching count, and the
  capped result set**;
- the cap is enforced **in SQL and again in the service**;
- exceeding the cap forces coverage `bounded`, **never** `complete`, and the
  count is stated: *"Showing 20 of 147 matching work orders."*

The cap is a presentation limit. It is never a hidden definition of the question.

### 3.2 Two layers, kept separate

Do **not** put intent execution inside `work_order_status_read.js`.

| Layer | Answers | Owns |
|---|---|---|
| **Canonical maintenance derivation** | What is true about this work order? | lifecycle · proof · assignment · acceptance · progress · coordination · delivery · valid next actions |
| **Intent execution** (domain-neutral) | What did this question require, what was checked, what conclusion is supported? | candidate predicate · source declaration · source outcomes · evidence age · coverage · supported and withheld conclusions · read receipts |

Ask Spine uses the generic intent layer, which calls the maintenance derivation.
That gives money a reusable contract engine later without pretending maintenance
and accounting have identical facts.

### 3.3 Evidence age, not staleness

For a live database read the query is current. The concern is that **no new
operating evidence has been recorded**. Each source declares its evidence
timestamp:

```text
work_orders.updated_at
latest qualifying work_order_progress.occurred_at
attachment received_at / stored_at
proof evaluation evaluated_at
```

Results carry `evidence_as_of`, `evidence_age`, `no_recent_evidence` — **not**
`is_stale`, which implies a cached or outdated read.

This supports *"No meaningful progress has been recorded for three days."* It does
not falsely claim the database returned old data.

**Meaningful progress** must enumerate its qualifying `work_order_progress.kind`
values inside the policy version. `en_route` is probably not one. The qualifying
set is an explicit policy decision, not an assumption.

### 3.4 Source outcomes, usability, coverage

```text
source outcome     answered · failed · unauthorized · not_applicable
fact usability     present_and_valid · present_but_unverified
                   present_but_incomplete · present_but_conflicting · missing
evidence           evidence_as_of · evidence_age · no_recent_evidence

coverage           complete · bounded · insufficient_for_conclusion
                   · conflicting · valid_empty · unavailable
                   · unauthorized · unsupported
```

Coverage is computed mechanically from the immutable contract. **The renderer
cannot choose or soften it.**

### 3.5 Internal states and visible states differ

The audit receipt may record `unauthorized`. The operator must not be told that a
protected record exists.

| | Visible |
|---|---|
| **Module-level denial** | *"You do not have access to maintenance for this property."* |
| **Record-level denial** | **Concealed** — bounded scope, valid empty, or not found, depending on the request |

The receipt preserves the real refusal internally. The UI preserves record
concealment.

### 3.6 Clarification and corrections

Add a distinct non-decision state: `clarification_required`. An ambiguous question
is **not** unsupported, and creates no decision-grade read receipt.

Every answer displays a quiet resolved-question label in operator language —
*"Answering: work reported complete without valid proof"* — so a misroute is
correctable without exposing internal codes. A correct answer to the wrong
interpreted question is still a bad answer.

When the operator corrects it, record a **correction event** linked to the
original turn, the original resolved intent, the corrected intent or requested
domain, the actor and the timestamp. That is the strongest real signal of intent
quality, and it must not require mining chat transcripts.

### 3.7 Read receipts

Decision-grade answers create durable read receipts recording the structured
basis, not merely the rendered sentence: actor · property · question reference ·
resolved intent · contract slug/version/digest · required and optional sources ·
source outcomes · fact usability · evidence timestamps and ages · record
references used · supported and withheld conclusion codes · coverage outcome ·
ranking policy details where applicable · renderer version · created_at.

Whether an answer is decision-grade is set by **the intent contract**, not the
renderer.

**Receipt-write failure is non-fatal.** If the answer can be produced safely the
operator still receives it, the structured result states `receipt_status:
not_written`, and the interface shows *"Answer available · audit receipt could not
be saved."* The failure cannot be silent.

---

## 4. Build 2 — Property Home experience

One prominent composer · visible property context · visible resolved question ·
concise answer · persistent cards · clarification and correction flow · complete,
bounded, empty, unavailable, conflicting and concealed cases · direct transition
into Work Orders.

**Do not build a blank full-screen chatbot.** Ask Spine is embedded in the
operating day.

**Cards ship with the read layer**, not with the actions. A card may show: unit or
location · issue · why it appeared · lifecycle state · assigned to · accepted by ·
proof condition · last meaningful progress · available action. It expands into
evidence, provenance, history, source freshness, withheld conclusions and the
receipt. The default stays concise.

The conversation is not the queue. The operator should not have to reconstruct the
day from a transcript.

---

## 5. Build 3 — governed actions

Only actions with fully known canonical consequences and receipts.

Each consequential action names the affected work order, states the consequence,
rereads current state, verifies actor authority, executes through the canonical
service, returns a structured write receipt, and refreshes the answer and cards.

**"Request proof" is not automatically an action.** Resolve what it does. If it
creates an obligation or queue item through a canonical service, it can ship. If
it sends a technician message, it waits for the real **operations** communication
line and provider configuration — which do not exist. The UI must never present
one label for two materially different consequences.

**Deferred:** retry resident communication · send resident updates · state or
promise delivery · anything depending on a real carrier.

### Resident coordination wording

Distinguish preparation, sending and delivery. With no provider-configured line,
never say *"Resident asked at 10:04 AM · waiting for reply."* Say **"Resident
update prepared at 10:04 AM · not sent because the line is not configured."**
"Waiting for reply" requires evidence the message was actually sent.

Do not offer a coordinate-access action when the same no-access cause already
produced the resident update. `residentCoordinationFor` already performs this
check; migration 136's unique index remains the final safety boundary, and the
interface should prevent the duplicate before the database has to refuse it.

---

## 6. Build 4 — maintenance attention

`maintenance.attention` waits for the operational rulings in §7. The read
architecture may support it earlier; **the ranking contract cannot be published
before the operating meaning is settled.**

Ranking, when it comes, applies **inside maintenance only** — no universal
numerical score. Each result carries `ranking_policy_id`, `ranking_version`,
`policy_digest`, `priority_class`, `priority_reason_code`, `priority_facts`,
`ranked_at`. Published versions are immutable.

### Urgency and provenance

Maintenance carries more than one urgency-related fact and the build may not
silently choose between them. Distinguish: confirmed emergency · confirmed regular
· needs confirmation · conflicting urgency facts · migration-derived historical
urgency.

`needs_confirmation` is **not** equivalent to regular or low priority. It is an
unresolved operating condition.

`obligations.severity` defaults to `'normal'` — a default is not a decision.
Migration 078's backfill set `urgency_decided_by = 'operator'` for every
pre-existing row, recording a provenance claim that is not true. The **migration
ledger may be used as a declared source**: where an urgency-decision timestamp
predates 078's `applied_at`, the fact is classified as migration-derived rather
than a genuine operator decision. The system must not claim provenance is
unreliable unless it has computed that state from declared evidence.

### Dispute primitive — later slice

First-class conflict records: subject · conflicting claims · conflict type ·
resolution owner · open/resolved status · resolution · resolving actor ·
timestamps. **Ask Spine may expose conflicts before this slice. It may not invent
who is right or silently reconcile them.**

---

## 7. Deferred, and why

| | Reason |
|---|---|
| `maintenance.attention` | operating meaning not yet ruled (§8) |
| *"What is waiting on a resident?"* | no carrier wiring. A prepared update is not a sent update. **No fixture-backed delivery behavior belongs in the production acceptance contract.** |
| Unit-turn proof questions | different semantics — `work_completion_claims.proof_satisfied` is a preserved verdict; the work-order lane recomputes. The two must not be collapsed into one answer. |
| Cross-domain ranking | each domain first needs capture, governed reads, coverage contracts, decision rules, receipts and real-user proof |

---

## 8. Rulings still owed

### 8.1 Open engineering rulings — block Build 1 freeze

**a. Legacy must be bounded by time, not absence alone.** After Release 0 ships, a
completion that misses the evaluation writer also has no row, and would be
silently absorbed into "legacy" instead of surfacing as the defect it is.

```text
no evaluation row AND completed_at <  release_0_deployed_at   → legacy
no evaluation row AND completed_at >= release_0_deployed_at   → DEFECT, loud
```

The second state needs a name and must never render as legacy.

**b. Q2's SQL predicate collides with one-canonical-derivation.** "Blocked" is not
a column — `lifecycleStateOf` decides it in JS from the latest progress per kind.
A SQL predicate for "currently blocked" implements the lifecycle rule a second
time, which §3.2 forbids.

Proposed resolution: the predicate selects a **superset** (any work order with a
`blocked` progress event, capped in SQL); the canonical derivation confirms current
state per candidate; the **confirmed** count is reported and the superset count
never reaches the operator. Q1 and Q3 do not have this problem — their conditions
are real columns.

**c. The Release 0 production audit needs clearance.** Only
`tools/ledger_reconcile.js` and `tools/property_line_preflight.js` are cleared to
run against production. A new audit script needs explicit authorization and must
be provably read-only — no transaction capable of writing, counts only.

### 8.2 Open operational rulings — block `maintenance.attention` only

- what "needs attention" means, and which work belongs in the pool;
- what facts move one job ahead of another;
- treatment of unconfirmed urgency;
- which events count as meaningful progress;
- who may override priority;
- how blocked work receives a next owner;
- which actions require confirmation;
- what "done" means by work category;
- who resolves disputes.

These do not block the three frozen intents.

---

## 9. Money carried forward

Money is the next domain. This build should produce reusable concepts — versioned
intent contracts, declared source coverage, fact usability, evidence age,
controlled and withheld conclusions, durable read receipts, versioned policy
receipts, conflicts, persistent evidence cards.

**Implementation stays concrete to maintenance.** Do not prematurely generalize
around currency, accounting periods, accrual, rounding, budgets or general-ledger
behavior. Extract shared abstractions when the second domain is built and the true
common shape is known.

Whether Property Spine feeds Yardi, maintains an operating subledger, produces
journal support, or eventually becomes the general ledger is **outside this
build**.

---

## 10. Definition of done

A signed-in operator asks a normal supported maintenance question from Property
Home and:

- Spine states what question it understood;
- the correct immutable intent contract drives the reads;
- the candidate population is the real one, not a recency window;
- every required source is accounted for;
- source availability is not confused with valid evidence;
- evidence age is evaluated;
- conflicting facts are surfaced, not reconciled;
- `unclassified` evidence is not treated as proof;
- no evaluation is not treated as a failed evaluation, and no evaluation was backfilled;
- only supported conclusions are stated, and withheld conclusions are named when material;
- unauthorized records are concealed at record level;
- supporting work remains visible;
- a valid authorized action can be completed;
- an unavailable or already-completed action is not falsely offered;
- the answer leaves a recoverable read receipt; the action leaves a recoverable write receipt;
- a receipt failure is visible and non-fatal;
- **Ask Spine and Work Orders agree**;
- the complete employee path is browser-proven;
- production behaves like the proven build.

**The rejection test.** Does this remove an operating handoff or re-entry step
while making the resulting truth easier to understand and more accountable? If it
only creates an impressive answer, do not ship it.
