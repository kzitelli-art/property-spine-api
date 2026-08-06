# Ask Spine — Maintenance Agent Build Charter

**Version 3 — Canonical Truth, Declared Coverage, Frictionless Operation**

This is the build charter. Read it before writing any Ask Spine code.
Companion: [`ASK_SPINE_SLICE_2_DESIGN_INPUT.md`](ASK_SPINE_SLICE_2_DESIGN_INPUT.md) —
the premortem and schema audit behind it.

The first release is maintenance-specific. It creates the operating pattern later
domains — including money — can follow, without prematurely pretending that
maintenance and accounting use identical facts. The build must preserve the
discipline that got Property Spine here while making the operator experience
substantially simpler.

```text
employee      ask → understand → see the work → act → receive confirmation

system        resolve identity and authority → resolve the intended question
              → execute the published intent contract
              → identify the complete candidate population
              → read canonical maintenance truth
              → evaluate source outcomes and evidence quality
              → state only supported conclusions
              → preserve the decision receipt
              → perform an authorized action
              → preserve the action receipt
```

The operator should not need to understand this machinery.

State at authoring:

```text
RENDER_GIT_COMMIT   a04a1df      api main tip, deployed
app main            6220ca5      deployed
migration ceiling   136          reconciled, EXIT 0
communication_lines 1 row        property_facing, provider_configured = f
                                 NO operations row · no carrier wiring
```

---

## 1. Product objective

> Ask Spine about maintenance work, understand what is true, and take the next
> valid action.

The operator should not need to know which module contains the answer, which
lifecycle field matters, whether assignment and acceptance differ, where proof is
stored, how a candidate population was selected, which source failed, which policy
produced the conclusion, or which service performs the action.

They ask naturally. Spine quietly states what question it understood, answers from
governed facts, keeps the supporting work visible, and offers only actions that are
currently valid.

---

## 2. Product character

### 2.1 Frictionless on the surface

Supported questions sound like ordinary work — *"What was reported done but still
needs proof?"*, *"What is blocked?"*, *"Who has the work in Unit 302?"*, *"Show me
the leak job."* No internal codes, special syntax, complex filters or module
knowledge.

### 2.2 Strict underneath

The model may determine what the operator meant, which record was referenced,
whether clarification is required, and which governed intent should execute.

The model does **not** freely state factual operating truth. Statements about
lifecycle, completion, proof, assignment, acceptance, urgency, priority, authority,
and communication preparation/sending/delivery come from structured fields through
controlled renderers.

### 2.3 Useful honesty

Surface uncertainty when it changes what the person should believe or do.

```text
DECISIVE   The facts support the requested conclusion.
BOUNDED    A narrower conclusion is supported, but the broader one is not.
BLOCKED    The requested conclusion cannot be supported because a required fact
           is missing, unusable, conflicting, outside scope, or unavailable.
```

Detailed evidence and receipts remain available behind the answer.

### 2.4 Conversation does not replace the operating field

Persistent cards preserve the records involved, why they appeared, current
lifecycle, assignment, acceptance, proof state, last meaningful evidence, and the
available action. **The transcript is not the queue.**

---

## 3. Stable intent identities

**Intent numbering is prohibited.** Numbers changed between contract drafts and are
not safe identifiers for immutable policies or durable receipts.

```text
maintenance.completion_without_valid_proof
maintenance.blocked_work
maintenance.ownership_and_acceptance
maintenance.attention                        ← not frozen
```

Every receipt carries `intent_slug`, `intent_contract_version`,
`intent_contract_digest`.

---

## 4. Initial supported intents

### 4.1 `maintenance.completion_without_valid_proof`

**Work orders only.** It does not combine the work-order proof lane with the
unit-turn lane — `work_completion_claims.proof_satisfied` is a preserved verdict
under the rule in force at claim time; the work-order lane recomputes. The two must
not be collapsed into one answer.

The answer distinguishes:

1. completion claimed but not completed;
2. no proof attachment;
3. attachment referenced but bytes not preserved;
4. attachment fetch failed;
5. attachment not preserved;
6. attachment unclassified;
7. valid classified evidence;
8. historical completion governed by legacy treatment;
9. **post-release completion missing a required evaluation.**

A successful proof-table query does not mean valid proof exists.

### 4.2 `maintenance.blocked_work`

May show the work order, blocker, assignment, acceptance, latest qualifying
progress, and whether a valid next action is recorded.

**The system must not claim blocked work has a next owner when no next owner is
recorded.** No such field exists today; the gap is exposed honestly and becomes a
later slice.

### 4.3 `maintenance.ownership_and_acceptance`

The answer preserves the differences between assigned user, accepted user,
responsible role, unassigned, and assigned-but-not-accepted. "Owner" may be
understood conversationally; it cannot flatten these facts in the rendered answer.

### 4.4 `maintenance.attention`

**Not frozen.** Depends on operational rulings covering the eligible work pool,
operator role, time horizon, urgency treatment, blocked-work treatment, meaningful
progress, override authority and ranking hierarchy. The architecture may support it
earlier; the policy may not be published until the business meaning is settled.

---

## 5. Canonical truth and intent execution are separate layers

| Layer | Answers | Owns |
|---|---|---|
| **Canonical maintenance derivation** | What is true about this work order? | lifecycle · proof condition · assignment · acceptance · progress · coordination · delivery · valid next actions |
| **Intent execution** (domain-neutral) | What did this question require, what was checked, what may be concluded? | immutable contracts · candidate selection · source declarations · evidence timestamps · source outcomes · fact usability · result limits · coverage · supported and withheld conclusions · read receipts |

Ask Spine becomes another consumer of the canonical derivation. **It does not create
a parallel interpretation of work-order truth.**

The intent layer stays separate from the maintenance reader. It is the architecture
that may later apply to money, where the underlying facts involve transactions,
accounting periods, budgets, evidence, accrual treatment and approval.

---

## 6. Candidate population contract

Every intent contract declares its candidate predicate. The predicate identifies the
population relevant to the question — **not an arbitrary recent window.**

> The system may not answer *"No matching work exists"* after examining only the
> most recent 100 work orders.

This is not hypothetical: `readPropertyWorkOrderStatuses`
(`src/surfaces/work_order_status_read.js:325`) selects the latest 100 work orders and
derives each in a loop. Built on as-is, a property whose only unproven completion
falls outside that window returns a confident, fully-receipted `valid_empty`.

Each candidate process produces:

```text
total_matching
selected_count
result_cap
candidate_predicate_version
```

The predicate executes **in SQL**. The cap is enforced in SQL **and again in the
service**. The total is counted over the same predicate used to select candidates.

When results exceed the cap: *"Showing 20 of 147 matching work orders."* The answer
is `bounded`, never `complete`.

**A presentation limit cannot silently become the definition of the question.**

---

## 7. Versioned intent contracts

```text
intent_slug          candidate_predicate      supported_conclusions
version              required_sources         withheld_conclusions
digest               optional_sources         renderer_contract
scope                evidence_time_rules
consequence_class    result_cap
```

Published versions are immutable; a material change creates a new version.
**Reducing required sources is a reviewed policy change**, because it weakens the
basis for the answer.

Whether a response requires a durable read receipt is decided by
`consequence_class` in the contract — not by the renderer.

---

## 8. Source outcomes and fact usability

```text
source outcome    answered · failed · unauthorized · not_applicable

fact usability    present_and_valid · present_but_unverified
                  present_but_incomplete · present_but_conflicting · missing
```

**A source answering successfully does not establish that the underlying evidence is
valid.**

---

## 9. Evidence age

For direct database reads the query is current. The concern is whether meaningful
operating evidence has been recorded recently.

```text
evidence_as_of · evidence_age · no_recent_evidence          not: is_stale
```

Each source in the contract identifies the timestamp supplying `evidence_as_of` —
`work_orders.updated_at`, qualifying `work_order_progress.occurred_at`, attachment
`received_at`/`stored_at`, proof evaluation `evaluated_at`.

**The contract must not substitute query time for evidence time.** A statement like
*"No meaningful progress has been recorded for three days"* must rest on an
explicitly identified evidence timestamp and a qualifying-event policy. The
qualifying `work_order_progress.kind` values are enumerated inside the policy
version — `en_route` is probably not one.

---

## 10. Coverage and visible answer states

Coverage is computed mechanically from the immutable contract, the complete
candidate population, source outcomes, fact usability, evidence age, conflict state
and the result cap. **The renderer cannot choose the coverage result.**

Internal receipt states:

```text
complete · bounded · insufficient_for_conclusion · conflicting
valid_empty · unavailable · unauthorized · unsupported · clarification_required
```

The visible vocabulary is deliberately narrower.

| | Visible |
|---|---|
| **Module-level denial** | *"You do not have maintenance access for this property."* |
| **Record-level denial** | **Concealment preserved** — bounded scope statement, valid empty, or not found, as appropriate |

The operator must not be told that a protected work order exists. The receipt may
record the true authorization result internally. **Internal audit vocabulary and
visible operator vocabulary are not identical.**

---

## 11. Clarification and intent correction

Ambiguity is not unsupported behavior. When the question cannot be resolved safely
the system returns `clarification_required`. A clarification round creates **no**
decision-grade read receipt, because no operating conclusion has been made.

Every completed answer displays a quiet resolved-intent label — *"Answering: work
reported complete without valid proof."* A correct answer to the wrong interpreted
question is still a bad answer.

When the user corrects it, record an **intent-correction event** linked to the
original turn, original resolved intent, corrected intent or requested domain,
actor, timestamp, and related read receipt where one exists. This is the primary
operating signal for intent-resolution quality, and it must not require mining chat
transcripts.

---

## 12. Controlled factual rendering

The model produces no visible factual operating prose. The renderer receives
`resolved_intent`, `answer_state`, canonical facts, source outcomes, fact usability,
evidence age, supported and withheld conclusions, supporting records, available
actions, receipt status and renderer version — and produces concise operator
language.

> **Answering: work reported complete without valid proof**
> Two work orders were reported complete but cannot be closed. One has no
> attachment. One has an attachment that was not preserved.

The detailed machinery stays on the cards and the receipt.

---

## 13. Read receipts

Decision-grade answers create durable receipts recording the structured basis, not
the displayed sentence:

```text
actor · property · question reference
intent slug · contract version · contract digest
candidate predicate version · total matching · selected count · result cap
required sources · optional sources · source outcomes · fact usability
evidence timestamps · evidence-age determinations · record references used
supported conclusions · withheld conclusions · coverage outcome
renderer version · created_at
```

**Receipt-write failure is non-fatal** when the operating answer can still be
produced safely. The result carries `receipt_status: not_written` and the interface
shows *"Answer available · audit receipt could not be saved."* The failure cannot be
silent.

---

## 14. Persistent work cards

Cards ship with the read experience; they do not wait for governed actions.

```text
Unit or location · Issue · Why it appeared · Lifecycle
Assigned to · Accepted by · Proof condition · Last meaningful evidence
Available action
```

Expandable into evidence, provenance, progress history, evidence age, withheld
conclusions and the read receipt.

---

## 15. Governed actions

Only actions with a known canonical consequence, a current-state reread, authority
enforcement, a canonical service, and a durable write receipt.

Potential first actions: open the work order · assign eligible staff · review
existing proof · open the full Work Orders workspace.

**"Request valid proof" is unresolved.** If it creates an obligation or queue item
through a canonical service it may ship. If it sends a technician message it is
deferred until a real **operations** communication line and provider configuration
exist. **One label may not hide two different consequences.**

Resident communication actions remain deferred where no real transport exists. With
no provider-configured line, never say *"Resident asked at 10:04 AM · waiting for
reply"* — say **"Resident update prepared at 10:04 AM · not sent because the line is
not configured."** Do not offer coordinate-access when the same no-access cause
already produced the resident update; `residentCoordinationFor` already performs this
check and migration 136's unique index remains the final safety boundary.

---

## 16. Release sequence

### Release 0 — canonical proof correction

**Separate from Ask Spine.** It changes live Work Orders behavior and requires its
own production-derived audit, migration and schema work, API change, app
compatibility change, deployment window, browser verification and rollback plan.

**App-first** if the response shape changes from a boolean into a multi-state proof
result. The app must safely understand the new shape before the API emits it. (The
obligation authority release aborted at 2:06 PM on 2 Aug for exactly this class of
mismatch.)

Acceptance:

- `unclassified` does not satisfy valid proof;
- valid classified evidence still satisfies proof;
- historical completed work renders as legacy where appropriate;
- post-release missing evaluations render as **defects**, not legacy;
- no proof evaluations were backfilled;
- the existing Work Orders surface remains truthful under the new shape;
- exactly one canonical implementation determines proof validity.

Evaluations are **append-only** — a re-evaluation creates a new superseding row —
scoped by the composite `(work_order_id, property_id)` foreign key, storing supporting
attachments as FK-backed rows rather than an ID array, and recording who or what
performed the evaluation.

### Build 1 — contract-driven reads

Freeze and implement the three intents. Build intent contracts, candidate predicates,
total counts, result caps, evidence-time rules, the generic intent executor,
maintenance projections, read receipts and concealment rules.

### Build 2 — Property Home experience

Real composer · visible property context · resolved-intent label · concise controlled
answers · persistent work cards · clarification · correction flow · complete,
bounded, empty, unavailable, conflicting, concealed and unsupported states ·
transition into Work Orders. **Do not build a blank full-screen chatbot.**

### Build 3 — governed actions

Only actions with complete operating consequences and receipts.

### Build 4 — maintenance attention

After the operational rulings: define the eligible pool, audience and time horizon,
urgency treatment, meaningful progress, blocked-work treatment and override
authority; publish the immutable ranking policy; enable `maintenance.attention`.

Ranking applies **inside maintenance only** — no universal numerical score. Each
result carries `ranking_policy_id`, `ranking_version`, `policy_digest`,
`priority_class`, `priority_reason_code`, `priority_facts`, `ranked_at`.

**Urgency and provenance.** Distinguish confirmed emergency · confirmed regular ·
needs confirmation · conflicting urgency facts · migration-derived historical
urgency. `needs_confirmation` is not equivalent to regular or low priority; it is an
unresolved operating condition. `obligations.severity` defaults to `'normal'` — a
default is not a decision — and migration 078's backfill set `urgency_decided_by =
'operator'` for every pre-existing row, recording a provenance claim that is not
true. The migration ledger may be a declared source: an urgency-decision timestamp
predating 078's `applied_at` is migration-derived, not an operator decision. The
system must not claim provenance is unreliable unless it computed that from declared
evidence.

**Dispute primitive — later slice.** First-class conflict records: subject ·
conflicting claims · conflict type · resolution owner · open/resolved · resolution ·
resolving actor · timestamps. Ask Spine may expose conflicts before this slice. **It
may not invent who is right or silently reconcile them.**

---

## 17. Browser and production acceptance

Acceptance begins where the employee begins:

```text
sign in → open Property Home → type a natural question → see what Spine understood
→ receive the answer → inspect the supporting work → take a valid action
→ see the work refresh → retrieve the receipt
```

Required cases: complete answer · bounded answer caused by result cap · refused
conclusion · conflicting facts · **valid empty over the full candidate predicate** ·
source failure · no recent evidence · stale screen content removed · module-level
denial · record-level concealment · clarification · intent correction ·
receipt-write failure visible and non-fatal · navigation through the real operator
path · visible rendering, not DOM presence alone · action performed against the
correct record · unavailable action not offered · **Work Orders and Ask Spine
agree** · `unclassified` does not satisfy proof · legacy determination renders as
legacy · post-release missing evaluation renders as a defect.

---

## 18. Money carried forward

Establish reusable operating concepts: stable intent slugs · immutable intent
contracts · candidate predicates · declared sources · fact usability · evidence
timestamps · supported and withheld conclusions · read receipts · controlled
renderers · persistent evidence cards · intent corrections · internal-versus-visible
authorization states.

**Implementation remains concrete to maintenance.** Do not prematurely generalize
around currency, rounding, accounting periods, accrual, budgets, chart-of-accounts
mapping or general-ledger posting. Extract when the money domain provides the second
real implementation.

---

## 19. Explicit open rulings

Not silently decided by this charter. Each must be closed before the affected
release begins.

**Open Ruling 1 — time-bounded legacy proof. RULED, FROZEN.**

The legacy boundary is an **explicit Release 0 activation timestamp stored durably
in the database**. It is not inferred from the migration `applied_at`, the commit
time, a documentation date, or the hosting deploy time.

Release order:

```text
1.  Deploy the app compatibility change.
2.  Apply the Release 0 schema.
3.  Deploy and verify the API proof-evaluation writer.
4.  Record the immutable Release 0 activation timestamp in the database.
```

Classification:

```text
no evaluation row AND completed_at <  activation timestamp   → legacy determination
no evaluation row AND completed_at >= activation timestamp   → missing-evaluation
                                                                writer defect
```

**The activation timestamp may be written once and must never be silently
changed.** "Never silently changed" is a schema obligation, not a convention —
make a second row or an in-place edit unrepresentable, in the manner of migration
136, rather than merely discouraged. A correction, if one is ever needed, must
supersede visibly and leave the original readable.

*Why this differs from §16's urgency provenance.* §16 permits the migration
ledger's `applied_at` as a declared source, and this ruling forbids the same
inference for proof. They are not in tension: urgency provenance is a
**retrospective** judgment about rows that already exist, where no better fact was
ever recorded and the ledger is the least-wrong evidence available. The proof
boundary is **prospective** — it governs a cutover we control — so the real fact
can be recorded instead of inferred, and inferring it would be choosing a worse
source on purpose.

*Residual gap to close during implementation.* Step 4 records activation after
step 3 verifies the writer. Any completion landing in that gap has a live writer,
so it should carry an evaluation row — but if one does not, `completed_at` still
precedes the activation timestamp and the defect is absorbed into legacy, silently.
The window is minutes, and it is the same class of hole this ruling exists to
close. **Capture the writer's verified-live instant at step 3 and persist that
value at step 4**, so the boundary has no gap.

**Open Ruling 2 — app-first tri-state proof contract.** The reader emits a boolean
today; Release 0 requires at least satisfied · not satisfied · legacy-or-
indeterminate. The exact API shape, compatibility period, mismatch gate and
deployment order must be finalized before implementation.

**Open Ruling 3 — blocked-work candidate predicate.** "Currently blocked" is derived
by canonical lifecycle logic, not stored as a column. Proposed: SQL selects a capped
superset of work orders with blocked progress; canonical derivation confirms current
blocked state; only confirmed results are counted and shown; the superset count is
never presented as the answer. Confirm before publishing the contract.

**Open Ruling 4 — production audit authorization.** The audit must be explicitly
authorized, structurally read-only, run outside the unsafe harness paths, output only
the counts and identifiers needed for review, and perform no mutation. **No
production audit script may run merely because it is named "audit" or "proof."**

**Open Ruling 5 — request-proof consequence.** Determine whether it creates a
canonical obligation or queue item, sends a technician communication, or is two
separate actions. It cannot appear in the first action set until its consequence,
authority, transport dependency and receipt are defined.

### 19a. Raised in review, not yet ruled

**Open Ruling 6 — "assign eligible staff" has the same transport question as
request-proof.** If a technician learns of assignment only by SMS, assignment depends
on the same missing operations line. The write is honest either way, but the
interface must not imply the technician was told. Resolve whether assignment's
operating consequence is *recorded* or *recorded and communicated* — and if the
latter, defer it alongside request-proof.

**Open Ruling 7 — the internal→visible state mapping is currently the renderer's
choice.** §10 forbids the renderer choosing coverage, but nine internal states map to
three visible levels and nothing specifies the mapping. Does `conflicting` render
BOUNDED or BLOCKED? Does `valid_empty` render DECISIVE? **Put the mapping in the
contract's `renderer_contract` and freeze it with the version**, or the renderer is
choosing the answer level after all.

**Acceptance gap.** §17 tests `valid_empty` over the full candidate predicate, which
proves the empty case. The dangerous case is the **non-empty** one: a genuine match
placed deliberately outside the old recency window must be found. That is the direct
regression test for the defect §6 exists to prevent, and it is not currently listed.

**Ownership of §19.** Rulings 1, 2, 3, 5, 6 and 7 are engineering rulings. Ruling 4
is an owner authorization. None is assigned in this charter.

---

## 20. Definition of done

A signed-in operator asks a supported maintenance question from Property Home and:

- Spine states what question it understood;
- the immutable intent contract drives the execution;
- the full candidate population is defined, and result limits are visible and bounded;
- every required source is accounted for;
- evidence age is evaluated from real operating timestamps;
- source availability is not confused with evidence validity;
- attachments are not confused with valid proof;
- legacy absence is not confused with a broken writer;
- record-level denial does not reveal protected records;
- ambiguity triggers clarification, and intent corrections are recorded;
- only supported conclusions are stated, and material withheld conclusions are identified;
- supporting work remains visible;
- valid actions use canonical services;
- reads and writes leave recoverable receipts, and receipt failures are visible and non-fatal;
- **Work Orders and Ask Spine agree**;
- the complete operator path is browser-proven;
- production behaves like the proven build.

**The rejection test.** Does this remove an operating handoff or re-entry step while
making the resulting truth easier to understand, harder to misstate, and easier to
audit? If it only creates an impressive answer, do not ship it.
