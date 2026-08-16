# Conversational Staff Agent Readiness Audit — Slices 1–9

**Executed 2026-08-03 against `origin/main` @ `47ed0f0c134bf4a55602d0e611d0cf020163d40d`**,
read in a detached worktree so nothing in the working branch could colour it.

**No writes were performed anywhere.** No code was produced. No route, service,
migration, tool or wrapper was created. Nothing was written to Solo
`9e2bb96e-08e2-41db-81c2-91055ceb50a3` or to any other property. This document
and its two tables are the whole output, as the brief specifies.

---

## 0. Evidence limits, stated before any finding

| fact | value | confidence |
|---|---|---|
| API source audited | `47ed0f0` (`origin/main`) | **SOURCE PROVEN** |
| Deployed API identity | **NOT VERIFIED.** No production credential and no route to the production origin exist in this environment. | **UNKNOWN** |
| App source | `property-spine-app` `main` @ `357fb15`; the Future Rent Roll surface as browser-verified sits on `claude/slice-10e-browser-acceptance-t0zk33` @ `0f3e17c` | SOURCE PROVEN |
| Production database | **never read.** No row count, no population, no ledger state in this document. | **UNKNOWN** |
| Slice 10 server code | **not on `main`.** `claude/slice-10b-dated-position-rows` @ `d1279de`. Audited separately where relevant and marked. | SOURCE PROVEN |

**Deployed SHAs could not be compared**, which the brief's required-output list
asks for. That comparison is outstanding and needs someone with production
access; it is not something reading more source can close.

**Depth is marked on every row and the two levels do not look alike.**
`TRACED` means the file was opened and the cited lines read. `FIRST-LOOK` means
the module and its exported surface were located and nothing more. A FIRST-LOOK
row is a starting point for the next pass, not a finding.

---

## 1. The reference implementation, in full

The brief said to start with *"the governed obligation-writing tool that is
already built and proven but deliberately withheld from the live model."* It is
`create_staff_obligation` in `src/agent/agent.js` (blob `7f2d30ce2d69`), and the
source states its own status at `agent.js:1262–1269`:

> *"DORMANT OPERATIONAL ESCALATION PLUMBING (Slice 1). The governed
> obligation-writing tool remains implemented and proven
> (`prove_escalate_move.js`), but the live model no longer receives it. Under
> the flag model, a human-needed request stays visible in the conversation a
> human can read, and a human decides whether to create or own an actual task."*

**It is withheld structurally, not by configuration.** `ESCALATE_TOOL` is
declared at `agent.js:1270–1280`; `activeTools` is assembled at
`agent.js:1282–1285` from `INVENTORY_TOOL`, `OFFER_TOUR_SLOTS_TOOL`,
`BOOK_TOUR_TOOL` and `AREA_KNOWLEDGE_TOOL` — and never includes it. The handler
at `agent.js:1297` still filters for `tool_use` blocks named
`create_staff_obligation`, so the plumbing is intact and unreachable. There is
no flag to flip and no environment variable to set: the tool list is a literal.

### 1.1 The shape of a passing chain

Every other capability in this audit is measured against this. **TRACED.**

```
model emits tool_use{name, id, input.reason}                agent.js:1297
  → normalise the reason, derive a dedupe key                    :1493-1496
      sha256(inbound_id + ':' + lowercased-collapsed reason)
  → look for an existing obligation on that key                  :1502-1505
  → else spawnObligationFromEvent(...)                           :1509-1523
      the canonical engine — src/shared/obligation_engine.js
      owner_type 'human', assigned_role 'leasing_manager',
      module 'agent', type 'operational_escalation'
  → 23505 on the unique index (086) converges to the existing row :1528-1535
  → build a RESULT that licenses only the language the row supports :1541-1559
      ownership: accepted (assigned_user_id) > routed (assigned_role) > unassigned
      due_at:    present or null — never invented
      note:      explicit instruction on what the model MAY say
  → pair EVERY tool_use id back, not just the first               :1562-1566
```

Five properties make it the reference, and each is a testable requirement the
rest of the matrix is scored against:

1. **One narrow canonical operation.** It calls the obligation engine and
   nothing else. There is no `/agent/create-task`.
2. **Idempotency is content-derived, not caller-supplied.** The key is
   `sha256(inbound_id + ':' + normalised reason)`, so a retry converges and a
   *different* task in the same turn produces a *different* key and a second
   obligation. The comment at `:1472–1483` records that a single `.find()`
   silently dropped a second task in the same turn; the loop at `:1561–1564`
   is the fix.
3. **The receipt constrains downstream speech.** This is the property no other
   service in the codebase has. The result object does not merely report what
   happened — it states what the model is permitted to claim, and steps the
   permission down as the evidence weakens: *"SENT to the leasing team (routed,
   not yet accepted) … do NOT say someone is already working on it and do NOT
   promise a specific time."* On failure it returns `created: false` with
   *"Do NOT claim anyone is on it and do NOT promise a follow-up."*
4. **Failure is a distinct state, not an empty success.** `:1554–1559`.
5. **Ownership is never invented.** `unassigned` is a first-class result value.

### 1.2 What it does NOT have, and this matters for the matrix

- **No confirmation boundary.** The write happens inside the model turn. No
  human sees a proposal. That is defensible for *this* operation — putting work
  on a team is low-consequence and reversible — and it is exactly why this tool
  cannot be the template for a completion claim or a lease admission.
- **No object resolution.** The only input is a free-text `reason`. It resolves
  no unit, no lease, no person beyond the conversation's own `person_id`. It
  never had to solve the problem every staff capability has.
- **No agent-interaction record.** `dedupe_key` carries a one-way hash of the
  inbound id and the source says so at `:1516–1521`: *"NOT an inspectable audit
  link."* You cannot get from the obligation back to the utterance.
- **It is prospect-facing, not staff-facing.** The actor is an unauthenticated
  texter, not an authenticated operator with property entitlement.

### 1.3 Should the withholding be revisited?

**A decision to surface, not a gap to fill — and the honest read is: not yet,
and not for this reason.**

The stated reason for withholding — *"a human-needed request stays visible in
the conversation a human can read, and a human decides"* — is a **weaker**
control than the tool it replaced, not a stronger one. A flag on a conversation
is not an obligation: it has no owner, no due state, no closing act and no
recovery window (§11). The tool wrote a real obligation with `assigned_role`
and idempotency. Withholding it moved a governed write into an ungoverned
reading habit.

But reinstating it as-is would be wrong for a different reason: **it is
prospect-triggered.** An unauthenticated texter would be causing an obligation
to appear on a staff board, with a label they authored, and no human
confirmation anywhere in the chain. That is a spam and authority surface, and
the fact that the write itself is governed does not make the *trigger*
governed.

**Recommended framing for the ruling:** the question is not *"turn the tool back
on?"* but *"what authenticated actor may cause an obligation, and where does the
confirmation sit?"* Under a staff agent, the same handler with an authenticated
operator as actor and a confirmation step is a correct Class A candidate. Under
the prospect agent, it is not. **Both answers can be true at once, and today the
codebase has one tool trying to serve both.**

---

## 2. PASS 1 — breadth. Every capability, five facts.

Five columns exactly, per the brief. Nothing inferred. Where a service could not
be located, the cell says so.

| capability | canonical READ | canonical WRITE | structured receipt | class | depth |
|---|---|---|---|---|---|
| staff identity & property entitlement | `identity/staff_session_service.resolveStaffSession` (`eef56d64…`), used at `obligations/operator_obligations.js:35–39` | `issueStaffSession` (same module) | partial — session + scope, no receipt envelope | **B** | TRACED |
| live-source & honest-empty behaviour | `obligations/operator_obligations_service.list` `:46–76`; `agent/ask_spine_service` | n/a | n/a — read-only | **B** | TRACED |
| Ask Spine / obligation attention | `agent/ask_spine_service.attention` (`1cd99e60…`), route `agent/ask_spine.js` | none | n/a | **B** | TRACED |
| Person Card & staff communications | `GET /operator/leasing/person-card`, `operator.js:2049` | `POST …/conversations/:id/reply` → `leasinginteractions.recordOutboundText`, `operator.js:813` | partial — the reply route returns the interaction, not a typed receipt | **C** | TRACED |
| lead & person intake | `leasing/leasingleads.js`, `comms/prospect_capture.js` | same modules | **not established** | **C** | FIRST-LOOK |
| tour booking | `leasing/leasingscheduling.js`; `GET /leasing/tours/:tourId` | `POST /leasing/leads/:leadId/tour/request`, `…/confirm`, `…/reschedule` | **not established** | **C** | FIRST-LOOK |
| post-tour capture | `leasing/tour_outcome.js` (`2554c794…`) — `resolveTourOutcome`, `ATTENDANCE`, `STANDING`, `NEXT_MOVE` vocabularies | `POST /operator/leasing/tours/:tourId/complete`; `…/correct-outcome` | **not established** — vocabularies traced, receipt not | **C** | FIRST-LOOK |
| follow-up obligations | `GET /operator/leasing/follow-ups`; `leasing/followup_ladder.js` | `leasing/followup_runner.js`; `POST /leasing/rungs/:obligationId/resolve` | **not established** | **C** | FIRST-LOOK |
| application review | `applications/application_review.buildReviewList` / `buildReviewDetail` `:363` | `POST /operator/leasing/applications/:id/proposed-terms` → `proposed_terms_service` | **not established** | **C** | FIRST-LOOK |
| application approval & rejection | as above | `POST /operator/leasing/applications/:id/approve`; `POST /applications/:id/deny` | **not established** | **C** | FIRST-LOOK |
| lease packet & execution evidence | `GET /lease-packets/:id`; `applications/execution_evidence.js` | `applications/executed_lease_service.verifyExecutedLease` `:656`; `POST …/executed-lease/verify` | **yes** — `evaluateExecutedLeaseAdmission` is recomputed inside the transaction, never trusted from storage (`:658–659`) | **C** | TRACED (exports + admission note) |
| renewal lifecycle | `leasing/renewals_read.js`, `leasing/renewal_lifecycle.js` (`6c40dd7a…`) — `deriveStage`/`deriveOperating`/`deriveDueState`; `GET /operator/leasing/renewals` | **none located.** The module exports only derivations. | n/a | **D** (write) / **B** (read) | TRACED (exports) |
| move-in queue & delivery gaps | `tenancy/move_in_queue.js`; `GET /operator/leasing/leases/:leaseId/move-in-state` | `POST …/delivery/keys-ready`, `…/keys-handed-over`, `…/activate-tenancy`, `…/move-in-charges/confirm`, `POST /movein/:obligationId/satisfy` | partial | **C** | FIRST-LOOK |
| availability & commitment truth | `surfaces/availability_read.availabilityRead` (`0eef5d10…`) over `tenancy/dated_positions.datedPropertyPositions` (`850e7c79…`) | n/a — derived by recomputation | n/a | **B** | TRACED |
| market & pricing evidence | `GET /operator/pricing/evidence`, `…/effective`, `…/authority` | `POST /operator/pricing/draft` → `review` → `publish` | partial | **F** — separately gated authority | FIRST-LOOK |
| maintenance work | `GET /work-orders`, `GET /operator/work-orders` | `maintenance/work_order_service.createWorkOrder` `:216` | **yes** — event + routing obligation per write | **C** | TRACED |
| unit turns & readiness | `unit_triage_service.readUnitTriageState` `:522`; `unit_turn_scope_service.readTurnFlow` `:473`; `readiness_service.readGateState` `:157` | `confirmTriage` `:271`, `confirmScope` `:161`, `recordWalk` `:189`, `correctCertification` `:465` | **yes, and the strongest in the codebase** | **A / C** — see §3 | TRACED |
| obligation acceptance, completion, reassignment | `GET /operator/obligations` (`c07fec8e…`) | `work_acceptance_service.acceptWork` `:202`, `claimCompletion` `:268`, `reopenWork` `:413`; `POST /operator/obligations/:id/claim`; `POST /operator/leasing/tasks/:id/{resolve,reassign,reopen,change-due}` | **yes** — see §3.1 | **A / E** | TRACED |
| recently closed & durable receipts | `GET /operator/leasing/tasks/recently-closed` | n/a | n/a | **B** | FIRST-LOOK |

**Pass 1 counts.** 19 capabilities inspected. Canonical reads located for 18;
canonical writes located for 15. Structured receipts confirmed for 4, partial
for 4, not established for 8, not applicable for 3.

**The single most common finding is not a missing service. It is a missing
receipt.** Fifteen capabilities have a canonical write. Four of them return
something a conversational layer could render an honest sentence from.

---

## 3. PASS 2 — depth. The five closest to tool-ready.

Chosen because each already has a canonical write, a real authority check, and
at least a partial receipt. All five are **TRACED**.

### 3.1 `work_completion` — claim completion of one work item

| column | finding |
|---|---|
| example utterance | *"307 is done. I replaced the disposal and tested it. No leak."* |
| intent class | **EXECUTE ACTION** |
| **GRAIN** | The truth lives at `required_work.id` (work item). The utterance names a **unit**. **THEY DO NOT MATCH.** A unit may carry many open work items; `work_acceptance_service.loadWork` `:122` takes `{work_id, property_id}` and has no unit-level resolver. |
| canonical read | `readUnitFlow` `:511`, `readWorkState` `:477` |
| canonical write | `claimCompletion` `:268` |
| authenticated authority | `assertEligible` `:137`, `assertMaintenanceOperator` `:166`, `assertActionable` `:184` — three checks, all server-side |
| canonical IDs required | `work_id`, `actor_user_id`, `property_id` |
| required inputs | `outcome` (done / unable), `unable_reason` from a governed vocabulary, completion proof |
| human confirmation | **confirmed with evidence** — `proof_requirement` is returned by `acceptWork` `:264` and a verdict is computed on claim |
| evidence | completion proof attachments; metadata returned, **bytes stay behind a governed read route** (`:396`) |
| durable object | `work_completion_claims`, and the work item closes |
| immutable history | a `work_*` event row per act |
| obligations | the commitment obligation closes; `dedupe_key: work_commitment:<acceptance_id>` (`:270`) |
| projections | `flow` is recomputed and returned; `unlocked_stages` names what this opened (`:383–388`) |
| canonical destination | `POST /operator/turn-work/:workId/claim` |
| honest failure states | `UNABLE_REASONS` / `UNABLE_NEXT_ACTION` produce a `next_action_proposal` carrying *"Nothing has been ordered, scheduled, or sent to anyone."* (`:398–401`) |
| runtime proof | **Proven** (service + HTTP harnesses in `tests/`); **browser-verified** for the operator door via the Build 3/4 app harnesses |
| classification | **E — LINEAGE GAP (grain).** Everything else is Class A. |
| smallest missing seam | a governed **unit → open work item** resolver that returns *one* item, a narrow clarification when several qualify, and `no_qualifying_record` when none does. It must not take the first row. |

The receipt here is the best in the codebase and is worth copying verbatim as a
contract: it returns the claim, the work, the event, whether the item closed,
the proof verdict, proof metadata, the recomputed flow, the stages this
unlocked, and a standing sentence — *"Closing this item does not make the unit
ready. Readiness comes from the final walk, which this build does not perform."*
(`:403`). **That last line is a receipt refusing to let its own success be
over-read**, which is precisely what a conversational layer needs and almost
never gets.

### 3.2 `initial_triage` — record what a first walk found

| column | finding |
|---|---|
| example utterance | *"Just walked 412. Carpet's shot, fridge is missing, needs full paint."* |
| intent class | **RECORD CLAIM** |
| **GRAIN** | Unit. The utterance names a unit. **MATCH.** |
| canonical read | `readUnitTriageState` `:522` |
| canonical write | `confirmTriage` `:271` |
| authority | `resolveEligibleOwner` `:148` — resolves an eligible owner, excluding the actor where required |
| required inputs | findings text; photos optional and **never inspected** (migration 117 `:66–68`: *"There is no computer vision here and none planned"*) |
| human confirmation | **confirmed once**, through `staff_agent_service.confirmProposal` `:305` |
| durable object | `unit_triage_findings`, `unit_triage_required_work` |
| obligations | `OBLIGATION_TYPES` from the module; `spawnInitialWalk` `:225` |
| honest failure | `deriveReadiness` / `READINESS` vocabulary; a photo without sufficient text yields a **clarification**, never a confident physical finding |
| runtime proof | **Proven**; **browser-verified** through the Build 1 door |
| classification | **A — TOOL READY** |
| smallest missing seam | none for the write. What is missing is the *envelope* — see §4.7. |

### 3.3 `turn_scope` — state the scope of a turn

Structurally identical to 3.2: `confirmScope` `:161`, `readTurnFlow` `:473`,
`resolveScopeOwner` `:112`, `inheritedWork` `:435`. Grain is the unit and
matches the utterance. **Classification: A — TOOL READY.**

One finding worth recording: **a scope correction needs no new mechanism.**
`staff_agent_service.js:46–50` states it plainly — *"actually, it needs full
paint" is a new scope statement, and Build 2 supersedes the old scope and keeps
it in history. That is the correction mechanism, and it already exists, which is
why this module does not grow one.* Correction is the one cross-cutting concern
this codebase has already solved for a whole domain.

### 3.4 `obligation attention` — "what needs attention?"

| column | finding |
|---|---|
| example utterance | *"What should I follow up on?"* → *"Open the oldest one."* |
| intent class | **READ**, then **NAVIGATE** |
| **GRAIN** | `obligations.id`. Natural speech references it by ordinal or description. Conversational reference is permitted only where the prior turn retained the ID. |
| canonical read | `ask_spine_service.attention` — server-derived actor and property, module entitlement, canonical result IDs, canonical destinations via `navigationFor` `:46–55` |
| canonical write | none |
| authority | shares the staff agent door's session seam |
| honest failure | ranking is **recorded facts only**: overdue+unassigned > overdue > unassigned > due soonest. Money impact, waiting parties and blockage are **deliberately absent** and the source says why (`ask_spine_service.js:21–25`) |
| runtime proof | **Proven** + **browser-verified** (`ask_spine_*.browser.js` in the app repo) |
| classification | **B — READ READY** |
| smallest missing seam | **an actor-scoped filter.** See §5.3 — this is the single highest-value, lowest-cost gap in the audit. |

`navigationFor` is a model for honest destinations: a unit is returned as
**context and never as a link**, because the app has no general unit opener.
It refuses to emit a destination it cannot honour.

### 3.5 `lease execution evidence` — admit an executed lease

| column | finding |
|---|---|
| example utterance | *"The signed lease came back for 405."* |
| intent class | **CONFIRM FACT** with evidence |
| **GRAIN** | `executed_lease_records` keys on `space_id` (NOT NULL) and `application_id`. The utterance names a **unit**. **MISMATCH on a multi-space unit.** |
| canonical write | `verifyExecutedLease` `:656`; admission recomputed by `evaluateExecutedLeaseAdmission` |
| receipt | **yes, and structurally strong** — `payload_hash`, `document_sha256`, `verified_by_user_id`, `event_id`, `supersedes_record_id`, `record_state` |
| human confirmation | **confirmed with evidence** — document identity is CHECK-enforced: `executed_lease_document_identity_ck` requires either a `document_sha256` or a provider document+version pair |
| honest failure | `admission_status ∈ {pending, admitted, blocked}` |
| classification | **F / E** — authority and evidence are governed, but the utterance cannot name the space, and no conversational path can supply a document hash |
| smallest missing seam | not conversational. A document arrives through a file channel; speech can at most *point at* one already received. |

---

## 4. Cross-cutting contracts

**4.1 Canonical reference resolution — the binding constraint of the whole
audit.** No general resolver exists. Each service takes an exact ID. The only
resolution code found is `space_position.recordEffectivePossession`, which
resolves a space from a unit **only when the unit has exactly one space** and
otherwise throws `AMBIGUOUS_SPACE`. That is the correct pattern and it exists in
exactly one place. **Every capability whose utterance names a unit and whose
truth lives at work-item or space grain is Class E until a resolver with that
same refusal exists.**

**4.2 Multi-intent utterances — the architecture REFUSES them, and says so.**
`staff_agent_intent.js:220` — *"classifyIntent — PURE. One message → one
candidate governed action."* *"307 is done and I need a part for 412"* produces
one proposal or `unclear`. **This is the safest possible current answer** — a
completion write hidden inside a compound sentence is exactly the failure mode
to design against, and one-intent-per-message cannot produce it. It is also a
real usability ceiling. It should stay until per-fragment resolution,
per-fragment proposal and per-fragment confirmation all exist.

**4.3 Confirmation boundary.** Two live patterns and they disagree, correctly:
`create_staff_obligation` **executes immediately**; `staff_agent_service`
**confirms once** with an attributed proposal. Build 6B tightened the second
further — four intents (`work_acceptance`, `readiness_request`,
`failed_final_walk`, `correction`) now classify as `redirect` and write **no
proposal row at all**. The source explains why that is stronger than refusing
later: *"with no row, there is nothing to confirm, nothing to mis-render as
pending, and nothing a future surface could quietly start honouring."*
`RETIRED_REFUSAL` names the structured door that owns each act instead.

**4.4 Stated versus inferred facts — NOT IMPLEMENTED, and this is the highest
unaddressed risk in the audit.** `staff_agent_proposals.proposed` is a single
opaque JSONB blob (migration 117 `:103`). Nothing distinguishes what the human
said from what Spine resolved from context. `unknowns text[]` records what could
*not* be established — genuinely good, and the schema comment is exactly right:
*"confirming something you were not told was uncertain is not consent"* — but
its inverse is missing. There is no read-back of spoken numbers anywhere.
**Requires a product ruling and a schema addition.**

**4.5 Claim versus institutional truth — partially solved, and well.**
`staff_agent_messages.body` retains the raw utterance with a `role` check
distinguishing staff speech from Spine's reply, and the schema states *"An agent
reply is not evidence of anything except that Spine replied."* The raw text
never becomes truth: only a confirmed proposal invokes a canonical service, and
the service writes its own record. Claim strength for the resulting domain fact
is the service's business, not the agent's.

**4.6 Canonical write services only — HELD, and enforced against source.**
`staff_agent_service.js:15–17` states that there are no raw inserts into any of
seven domain tables *"anywhere in this module. The harness asserts that against
this source, not against intent."* All four domain services are **required**
constructor dependencies, so the module *cannot be built* in a configuration
where it would fall back to a raw insert (`:24–27`). That is a structural
guarantee, not a convention.

**4.7 Structured write proposals.** Present in schema, incomplete in content.
`staff_agent_proposals` carries intent, proposed, unknowns, clarification,
status, and `resulting_kind`/`resulting_id`/`resulting_summary` as
**references, never copies**. Missing from the brief's list: evidence supplied,
consequences, obligations affected, projections affected — and the
stated-versus-inferred split of §4.4.

**4.8 Receipts.** Four capabilities return a receipt a conversational layer
could render honestly. `claimCompletion` is the exemplar (§3.1).
`create_staff_obligation` is the only one that **constrains what may be said**
about it. **No service returns `occurred_at` / `recorded_at` as a pair**, and
none returns a replay identity in its receipt even where one exists internally.

**4.9 The durable agent-interaction record — MOSTLY EXISTS.** This is the
audit's most positive surprise. Migration `117_staff_agent_capture.sql` covers
seven of the brief's nine fields:

```
thread id                staff_agent_threads.id                    ✓
staff actor              staff_agent_messages.user_id              ✓
property                 staff_agent_messages.property_id          ✓
raw utterance            staff_agent_messages.body                 ✓
tools invoked            proposals.intent → INTENT_SERVICE map     ✓ (by mapping)
proposal presented       proposals.proposed / unknowns / clarification ✓
confirmation + who + when confirmed_by_user_id, confirmed_at        ✓
                          CHECK ck_sap_confirmed_is_attributed enforces both
resulting receipt IDs    resulting_kind / resulting_id / resulting_summary ✓
channel                  — MISSING
canonical IDs resolved, and HOW  — partial (unit_id only; no resolution basis)
prompt / model revision  — MISSING
```

**And the retention scope constraint is already honoured.** Utterances attach
to a thread scoped to `(property_id, user_id)` and to the proposal they
produced — not to a person. The general archive of staff speech attached to
persons that the Person Card doctrine forbids has not been built.

**Missing: the resolution basis.** `unit_id` is stored, but not *how* it was
resolved. *"Why does Spine believe Sarah wants September 15"* is answerable;
*"why does Spine believe this message was about unit 412"* is not.

**4.10 Recovery and idempotency — present per service, absent as a contract.**
Twenty-plus modules carry `dedupe_key` or `idempotency_key`. Three distinct
patterns were traced: content-derived hash (`agent.js:1493–1496`), deterministic
composite (`work_commitment:<acceptance_id>`), and caller-supplied. **No service
returns its idempotency identity in its receipt**, so the correct recovery — *reread
canonical truth → find the replay identity → recover the actual result* — cannot be
performed by a caller that received no receipt. **A write that succeeded but
whose receipt was lost is not recoverable through any current interface.**

**4.11 Honest non-answer states — strong per service, absent as a shared
vocabulary.** Each service types its own refusals well. There is no cross-service
enum, so a tool layer would have to map N vocabularies into the brief's eleven
states. Slice 10's `RESULT_STATE` (`qualifying_result_exists`,
`no_qualifying_result`, `unavailable`, `authority_missing`) is the closest thing
to a general one and is the right seed — with the caveat, proven in the Slice 10
receipt §4, that it currently declares one value it never returns.

**4.12 Scope of read — NOT ADDRESSED ANYWHERE. Flagged as requiring a product
ruling, exactly as the brief instructs.** No mechanism exists for a prose answer
to carry which tools ran, which were unavailable, and which were never called.
Every honest-blank protection in the product assumes a slot where the blank
renders — the Future Rent Roll surface is the proof of what that costs: its
95-assertion browser acceptance is largely *about* making absence render, and it
found six defects where a typed absence had collapsed into silence on screen.
**Prose has no slots at all.** This is the conversation-specific replacement for
the honest-blank rule and nothing in the codebase anticipates it.

**4.13 Communication and the line boundary — the doctrine holds, and the new
caller has no answer.** `communications_boundary.sendPropertySms` (`118b6f83…`)
derives the sending line server-side at `:545–553`: **no line → no send**, never
a Messaging Service default. Consent is checked by `canSendSmsForRecord`
`:555–562`, and a refusal is stamped on the record. `POST
/operator/leasing/conversations/:id/reply` (`operator.js:813`) is described in
source as *"a THIN staff-session adapter over `recordOutboundText` — the one
interaction ledger + the one communications boundary. The browser supplies only
body text."*

**What is not answered:** whether an *agent-initiated* send is distinguishable
from an operator-typed one in the ledger, and which line a staff-agent message
leaves from. `properties.sms_number` is a single property-facing line and is
already classified a **temporary adapter** in `THREAD_HANDOFF.md` §5 —
*"cannot express an organisation-owned operations line."* Until the canonical
communication-line model lands, **`COMMUNICATE` is Class F — authority gap.**

---

## 5. Special attention areas

**5.1 Ask Spine.** Confirmed as a reusable read tool: server-derived actor and
property, module entitlement, honest unavailable, stable ranking, canonical
result IDs, canonical destinations, follow-up reference support.

**Recorded explicitly, as the brief requires:** a safe read provides **none** of
free-form interpretation, conversation state, write proposals, write
confirmation, or a durable agent-interaction receipt. It is one tool, not an
agent.

**What the ranking does not know**, from its own source (`:21–25`): waiting
parties, move-in risk, money impact, missing proof, blocking relationships,
commitments, safety sensitivity. All seven are absent **because no recorded fact
supports them**, which is the right reason. The interesting question the brief
raises — whether an operator's disagreement with a ranking could itself be
captured as an operating fact rather than tuned by hand — has **no
representation anywhere in the schema today.** It is a genuine product idea and
a genuine gap.

**5.2 Person Card and communications.** Confirmed as the strongest conversational
foundation. `operator.js:2032–2048` states the contract: a **lens, not a table**,
assembling attributed entries from the real systems of record into
RELATIONSHIP / NEXT / HISTORY; HISTORY sorts by `occurred_at`, never write time;
every entry is verb-first with a named actor; actual-host entries carry
`claim_strength='asserted'`. The property wall is enforced by a presence check
across five sources (`:2064–2076`).

**The communication ledger is already separate from operating events** —
`comm_events` versus the domain event tables. A staff message saying work
occurred is not proof the domain operation occurred, and the schema keeps them
apart by construction.

**5.3 Maintenance field work — the actor-scoped read gap is REAL and OPEN.**
`GET /operator/obligations` accepts exactly one client input: `status`
(`operator_obligations.js:60–66`), whitelisted to five values
(`operator_obligations_service.js:32`). There is **no `assigned=me`, no
`assignee`, no actor predicate.** The SQL at `:66–72` filters on `property_id`
and `module` only.

So a conversational technician asking *"what is assigned to me?"* can only be
served by downloading every obligation the property's modules expose and
filtering in the browser — which is the browser-trapped meaning this doctrine
forbids, and at scale is the same transport failure Slice 10D existed to fix.

**This is the smallest, highest-value seam in the entire audit.** The service
already receives `property_id` and `allowed_modules` as server-derived
arguments; adding an actor predicate derived from the same session — never from
the request — is a narrow change to one function with an existing test surface.

Work instructions are plain and executable, not scope labels: `acceptWork`
carries `work_text` into the obligation label (`:252`) and
`proofRequirementFor(w)` is returned with the acceptance.

**5.4 Slice 9 / Slice 10 truth contracts as agent-readable truth.** The
availability and position reads are **recomputations, never stored
projections** — `dated_positions.js` header: *"Facts at a later date replace
facts at an earlier one by RECOMPUTATION — never by stored cleanup."* No
conversational write can modify them through a read projection because there is
nothing to write to. That is a structural guarantee.

The services that would legitimately change the underlying facts are the lease,
application, execution, possession and classification services — each already
governed and separately gated. **Any instruction of the form *"mark 302
available"* or *"change the occupancy"* is UNSUPPORTED, and correctly so: those
are derived facts and there is no service that sets them.**

---

## 6. Required output

**Capabilities inspected:** 19. **Canonical reads found:** 18. **Canonical
writes found:** 15.

```
TOOL READY (A)               2   initial_triage · turn_scope
READ READY (B)               5   Ask Spine · obligations read · availability
                                 & commitment · live-source behaviour ·
                                 recently-closed
WRAPPER MISSING (C)          8   maintenance work orders · person card reply ·
                                 lead intake · tour booking · post-tour ·
                                 follow-ups · application review · application
                                 decision · move-in delivery
RECORDING GAP (D)            1   renewal lifecycle — derivations only, no write
LINEAGE GAP incl. GRAIN (E)  2   work completion (unit vs work item) ·
                                 lease execution (unit vs space)
AUTHORITY / PROOF GAP (F)    2   pricing publication · COMMUNICATE across the
                                 line boundary
BROWSER-TRAPPED (G)          1   "what is assigned to me" — no server filter
                                 exists, so the filter can only live in the app
NOT AGENT ELIGIBLE (H)       1   readiness certification — Build 6B removed it
                                 from the message path deliberately
COMPETING CANONICAL PATHS (I) 0   see below
```

**Class I is EMPTY, and that is a finding.** The brief anticipated two: a
parallel raw-insert work-order path, and two disagreeing availability models.
**Neither survives on `47ed0f0`.**

- `grep -rn "insert into work_orders" src/ server.js` returns **exactly one
  hit** — `work_order_service.js:299`, inside `createWorkOrder`. The two raw
  inserts the SMS lane removed are gone, verified against source rather than
  taken from the handoff.
- Availability is one model with two readers in the correct dependency
  direction: `availability_read.js` consumes `datedPropertyPositions` and its
  header states *"CONSUMES, NEVER RE-DERIVES."* `leasing_occupancy_facts.js` is
  a lower-level primitive that `desks.js` and `leasing_condition_facts.js`
  depend on, and its header states the direction explicitly. They answer
  different questions at different grains, both declared.

**Unsupported conversational actions**, each because no service sets the fact:
set occupancy · set availability · set a rent · certify readiness by message ·
accept work by message · record a failed final walk by message · correct a
confirmed action by message (the last four are Build 6B `redirect`s that name
their structured door).

**Canonical receipt contracts found:** `claimCompletion` (richest),
`acceptWork`, `createWorkOrder`, `verifyExecutedLease`,
`create_staff_obligation` (only one that constrains downstream language).

**Idempotency behaviour found:** three patterns, none surfaced in a receipt.

**Conversation-reference requirements:** the prior turn must retain the
canonical ID; a resolver must return one record, one narrow clarification when
several qualify, or `no_qualifying_record`; never the first row; never a silent
create.

**Agent-interaction record:** exists as migration 117 — seven of nine fields.
Missing: channel, prompt/model revision, and the resolution basis for every
canonical ID.

### Top ten staff utterances supportable now

Supportable means the full chain exists today, subject to the noted gate.

1. *"What needs attention?"* — Ask Spine, Proven + browser-verified.
2. *"Why is this first?"* — the ranking reason is a recorded fact, not a score.
3. *"Who owns it?"* — `assigned_user_id` or an honest `UNASSIGNED`.
4. *"Open the person on that one."* — `navigationFor` emits a canonical person destination.
5. *"Just walked 412 — carpet, fridge, full paint."* — `confirmTriage`, Class A.
6. *"The turn needs full paint and appliance replacement."* — `confirmScope`, Class A.
7. *"Actually make that a full paint."* — supersession, already governed.
8. *"What is the position of this property on 1 September?"* — Slice 10, browser-verified (branch, not `main`).
9. *"Why is the occupancy percentage withheld?"* — typed blockers with counts.
10. *"What can I honestly market right now?"* — `availabilityRead`, with `vacant ≠ ready ≠ marketable` enforced.

### Top ten high-value utterances still blocked

1. *"What is assigned to me?"* — no actor-scoped server read (§5.3).
2. *"307 is done."* — unit → work-item resolver missing (§3.1).
3. *"307 is done and I need a part for 412."* — one intent per message (§4.2).
4. *"Sarah toured 405 and wants September 15."* — post-tour capture has no traced receipt; multi-fact utterance; stated-vs-inferred unmarked.
5. *"Send her the application."* — `COMMUNICATE` crosses the line boundary (§4.13).
6. *"I approved it."* — approval exists; no receipt contract traced.
7. *"The signed lease came back."* — evidence cannot arrive by speech (§3.5).
8. *"Mark the delivery obligation complete."* — needs exact obligation resolution.
9. *"Which units lose rent next month?"* — Slice 10 answers it, and is not on `main`.
10. *"Why is 302 excluded?"* — the row-level answer exists in the Slice 10 contract; nothing exposes it conversationally.

### Areas where no new code is needed

Correction (supersession already governs it) · property-scope enforcement ·
module entitlement · the recomputation guarantee · claim-versus-truth separation
in the staff-agent schema · utterance retention scope.

### Areas requiring a product ruling

1. **Scope of read in prose** (§4.12) — the brief's own flag, and the most
   consequential.
2. **Stated versus inferred marking, and number read-back** (§4.4).
3. **`create_staff_obligation`: which authenticated actor may trigger it, and
   where the confirmation sits** (§1.3) — not "on or off".
4. **Which line an agent-initiated send leaves from** (§4.13).
5. **Whether disagreement with a ranking is itself an operating fact** (§5.1).
6. **Whether a technician's own work list is a filter or a distinct capability**
   (§5.3).

### Smallest follow-up build packets, in the order the audit supports

1. **Actor-scoped obligations filter.** One predicate, server-derived, in one
   function that already receives its scope as arguments. Unblocks the single
   most common technician utterance. Smallest packet with the largest effect.
2. **Canonical reference resolution and the tool envelope.** One resolver
   contract: one record, one narrow clarification, or `no_qualifying_record`.
   Never the first row. Never a silent create. Unblocks work completion and
   every later write.
3. **Structured receipts and recovery.** A shared receipt shape carrying actor,
   property, target IDs, before/after where material, event IDs, obligations
   changed, `occurred_at`/`recorded_at`, and the replay identity. Retro-fit to
   the four services that already return most of it.
4. **Read-only governed tool registry** over Ask Spine, the obligations read,
   availability, and the Person Card.
5. **Agent-interaction record completion.** Add channel, prompt/model revision,
   and resolution basis to migration 117's shape.
6. **Post-tour conversational capture** — the first *new* write capability, and
   only after packets 2 and 3.

### The ordering exception, weighed

The tools-before-chat-box discipline is correct and a composer must not ship
ahead of the domain tools. But if the composer sits at the end, months of
wrapper work land before anyone learns whether the conversation beats the
screen.

**Recommendation: a thin, read-only composer after packet 4, over the four
proven read tools.** It writes nothing, so it cannot create a bad record; it is
cheap and reversible; and it is the only place the question gets answered.
Explicitly **not** after packet 1 — a composer over one filter answers nothing —
and **not** after packet 6, by which point the answer arrives too late to change
anything.

---

## 7. Final standard, capability by capability

The brief's success test is whether the audit can say, for each capability:
*Spine already knows the context · the employee supplies the one fact Spine
cannot know · the system asks only for necessary confirmation or proof · the
canonical service records the truth · the employee receives a receipt · every
other surface updates from the same truth.*

**Two capabilities satisfy all six today: `initial_triage` and `turn_scope`.**

**One satisfies five and fails the second: `work_completion`.** Spine knows the
context, the service records the truth, the receipt is the best in the codebase,
and every surface updates. It fails on *the employee supplies the one fact Spine
cannot know* — because the employee says "307" and Spine cannot turn that into
one work item.

**Everything else fails at the receipt, the resolver, or the confirmation
boundary** — and in that order of frequency.

The chain is not far from working. **It is one resolver and one receipt shape
away from working for most of the maintenance domain**, and further than that
for leasing, where the writes exist but their receipts have never been shaped
for a caller who has to say something true afterwards.

---

**One Property. One Truth State. One Next Action.**
