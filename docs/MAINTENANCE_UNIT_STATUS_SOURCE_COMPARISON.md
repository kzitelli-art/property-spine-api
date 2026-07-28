# Maintenance Unit-Status Capture — Preliminary Source Audit

> ## ⚠ STATUS: PRELIMINARY — PAUSED PENDING OPERATOR DISCOVERY
>
> **This document compares source against a DRAFT contract. It does not describe
> product requirements.**
>
> The Maintenance Unit-Status Capture Design Contract this audit was written against
> is **not final**. Operator discovery with Kameron has not yet been completed — how
> vacant-unit condition is actually learned today, who enters a unit and in what
> sequence, what "ready" means operationally, which conditions truly block marketing
> versus touring versus move-in, and which human judgments cannot safely be inferred
> are all **still open**.
>
> Therefore:
>
> - Every classification below (*already supported / partially supported /
>   incompatible / missing*) is a comparison against **draft language**, not a verdict
>   on the product. A section marked "missing" means *absent relative to a draft*, not
>   *required and not built*.
> - The finding, required-work, readiness, and confirmation models are **undecided**.
>   Nothing here settles them.
> - Nothing in this document authorizes implementation, and no part of it should be
>   read as an implementation plan, a work list, or a backlog.
>
> **What is durable here** is the source evidence: what current code actually does,
> where it fabricates, and which paths are demo-intercepted. Those observations stand
> on their own and are independent of any contract revision.
>
> After operator discovery, the contract will be revised. Only then should source be
> compared against the final operating contract to identify real implementation gaps.

> ## ⚠ STANDING LIMITATION OF BUILD 1 — READ THIS BEFORE TRUSTING ANY READINESS READ
>
> **Build 1 protects units that have triage evidence. It does NOT repair the legacy
> behavior where a unit with no triage evidence may still be derived as `ready` and
> `marketable`.**
>
> The availability overlay shipped in Build 1 is scoped entirely to positions carrying
> a Build 1 triage fact — a confirmed initial walk, or an open initial-walk obligation.
> Every other position falls through to the preexisting derivation unchanged.
>
> So the §5 defect below is still live in production for the whole legacy estate: a
> unit with no turnover row and no triage record continues to read `physical_readiness:
> "ready"` and can still reach `marketable_now` on no evidence at all.
>
> This is deliberate. The repair was attempted in Build 1 and withdrawn — see
> *The single most important finding* — because it would have taken marketable
> inventory to zero portfolio-wide. Fixing it correctly is separate, unowned work.
>
> **Do not read Build 1's existence as evidence that readiness is now honest. It is
> honest only where somebody has walked the unit.**

**This is an audit document, not an implementation plan.** It maps a draft
Maintenance Unit-Status Capture operating contract against current source. It designs
no schema, routes, services, or migrations, and it does not authorize implementation.

**Sources compared**
- api `kzitelli-art/property-spine-api` @ `c98d3bc` (branch `claude/mobile-code-quality-iy1u16`, fast-forwarded from `origin/main`)
- app `kzitelli-art/property-spine-app` @ `ae7abe3` — the commit `THREAD_HANDOFF.md` names as live

**Proof level of everything below: SOURCE-DECLARED and SCHEMA-LEVEL only.**
No live Neon connection was used. No HTTP was exercised. No browser was opened.
Claims about *what the code says* are proven. Claims about *what the deployed system
currently contains or does* are explicitly marked ⚠ **requires live proof**.

**Excluded by scope, deliberately untouched:** governed economic charges, the
administration-fee ruling, stale-draft behavior, and shared-runtime work belonging to
the other thread.

---

## Authority note on the app

`property-spine-api` contains a git-tracked root file named `property-spine-app`
(745 KB, HTML). The live app's `index.html` is 1.9 MB. They are different artifacts.

**Nothing in this document is sourced from that root file.** Every app claim comes from
`/workspace/property-spine-app` @ `ae7abe3`. What that root file is, and whether it can
be retired, is recorded as an open question below and was not otherwise investigated.

---

## Summary table

*Classifications are against draft contract language, not final requirements. Read
"missing" as "absent relative to the draft", never as "required and not built."*

| Draft contract section | Classification vs source |
|---|---|
| Actor | **Partially supported** |
| Trigger | **Missing** |
| Capture | **Missing** |
| Interpretation | **Missing** |
| Confirmation | **Missing** |
| Durable truth — attributed observation | **Already supported** |
| Durable truth — confirmed findings | **Missing** |
| Durable truth — physical readiness | **Incompatible** |
| Durable truth — marketability | **Partially supported** |
| Durable truth — vacancy | **Partially supported** |
| Durable truth — inspection completeness | **Missing** |
| Required work | **Partially supported** |
| Obligation and ownership | **Already supported** |
| Downstream — availability | **Partially supported** |
| Downstream — exposure | **Missing** |
| Downstream — management | **Partially supported** |
| Downstream — reporting | **Cannot determine without live proof** |
| Correction | **Partially supported** |
| Completion | **Partially supported** |

---

## The single most important finding

> ### ⚠ UNRESOLVED ARCHITECTURE ISSUE — open, not owned by BUILD 1
>
> **Status: confirmed real, attempted, reverted, and deliberately left open.**
>
> BUILD 1 attempted a repair in `position_classifier.js`
> (`turning ? "turning" : (turnComplete ? "ready" : "unknown")`) and it was **reverted
> after blast-radius review**. The reason is structural, and it is the reason this
> issue is harder than it looks:
>
> **Completed-turn evidence never reaches the classifier.** `turn_status` has exactly
> one source — `src/tenancy/space_position.js:176`:
>
> ```sql
> (select t.status from turnovers t
>   where t.unit_id=u.id and t.status='in_progress' limit 1) as turn_status
> ```
>
> The subquery filters to `in_progress`, so `turn_status` ∈ {`'in_progress'`, `NULL`}
> and can never be `'ready'`. The `turnComplete` branch was unreachable; `ready` became
> unreachable with it; **`marketable_now` would have gone to zero portfolio-wide.**
>
> Worse, it would have shipped green: `tests/cross_surface_invariants.js:163` defines
> `marketable` as requiring `physical_readiness === "ready"`, so with `ready`
> unreachable the marketable set is empty and every *"X is never marketable"* assertion
> passes **vacuously**. Same at `availability_canonical_proof.js:59`.
>
> **What a real repair requires** (none of it in BUILD 1's scope):
> the loader must carry completed-turn evidence; a decision on whether a completed
> turnover is *sufficient* to assert readiness at all; a migration story for every
> position that would reclassify at once; and invariant tests that fail loudly rather
> than vacuously on an empty marketable set.
>
> **What BUILD 1 did instead:** an availability overlay scoped strictly to positions
> carrying BUILD 1 triage evidence. Where no triage fact exists, availability falls
> through to preexisting behavior unchanged. **That protects the new slice. It does not
> repair the historical readiness architecture, and it does not reduce this issue.**

*This finding survives contract revision.* The second problem below is a §5 defect
against `PHILOSOPHY.md` doctrine directly — an unobserved unit asserting a healthy
state — and holds regardless of what the final contract says about readiness.

**Physical readiness is currently derived from the existence of a turnover row.**

`src/tenancy/position_classifier.js:98,193`

```js
const turning = row.turn_status === "in_progress";
...
physical_readiness: turning ? "turning" : "ready",
```

The contract forbids exactly this:

> *"Physical readiness must not be reduced to whether a turnover record exists or
> whether an isolated work item is open."*

Two distinct problems, and the second is more serious than the first.

**1. The derivation is the forbidden one.** Readiness is a single boolean read of
`turnovers.status`. No confirmed physical condition participates.

**2. The false branch asserts readiness rather than preserving unknown.** The ternary's
else-branch is `"ready"`, not `"unknown"`. A unit that has never been observed, never
inspected, and carries no turnover row reads **`physical_readiness: "ready"`**.

Traced through `src/surfaces/availability_read.js:50–104`, that value flows to a
marketing state. A vacant unit with no turnover row passes every guard in
`marketingState()` — not conflicted, not down, standard operating use, evidence agrees,
no activation pending, no successor, no spanning lease, possession not delivered,
`physical_readiness !== "turning"` — and resolves to **`marketable_now`**.

So **absence of evidence becomes an affirmative claim of readiness, and then an
affirmative claim of marketability.**

This inverts the rule `availability_read.js` states in its own header (lines 21–30):

> `vacant ≠ ready ≠ marketable`
> *"Absence of a lease is not evidence of availability — it is absence of evidence."*

The file honors that rule on the lease axis and has it broken underneath it on the
readiness axis. The contract's requirement that "Unknown must remain available wherever
the observation does not support a conclusion" has no representation here: the readiness
vocabulary is two-valued (`turning` | `ready`) with no third state.

⚠ **Requires live proof:** how many live positions currently read `ready` with no
turnover row and no observation behind it. The source guarantees the state is
*reachable*; only Neon can say how much of the live portfolio is in it.

---

## Section-by-section

### Actor — Partially supported

**Conforms.** `src/maintenance/maintenance.js:64–126` implements the authority seam the
contract's actor clause needs, and implements it well:

- `requireOperator` resolves an authenticated staff session on every request, no cached scope
- `requireMaintenanceModuleAccess` checks live `allowed_modules`
- `refuseClientProperty` **refuses** a mismatched client `property_id` with 403 rather
  than silently substituting the session value — the comment names the reason exactly
  (the caller believes it acted on property A while the record landed on property B)

`work_order_service.js:214` separates `reported_by_person_id` from
`affected_person_id` — "TWO people, never one."

**Gap.** The contract requires **three** separately retained roles: who observed, who
confirmed the interpretation, who owns the resulting work. Source carries **two**
(reporter, affected) plus an obligation owner. There is no confirmer role, because there
is no confirmation step (below). Ownership of resulting work is carried on the obligation.

**Parallel path.** The contract's actor rules are enforced only on `/operator/work-orders`.
The older `POST /work-orders` and `GET /work-orders` accept `property_id` as a body/query
parameter behind a shared `x-operator-key`. `maintenance.js:76–81` documents this
honestly and calls it what it is. `/supply-requests` (`maintenance.js:596–671`) has no
operator gate at all. See *Parallel paths* below for why this matters more than it looks.

---

### Trigger — Missing

The contract's trigger is *direct staff knowledge of present physical condition*, with
the explicit requirement that the user must **not** have to pre-classify the observation
as a turnover issue, work order, down-unit issue, or reporting issue.

Source requires the classification up front. The staff member must already have chosen:

| To record… | They must call |
|---|---|
| a repair | `POST /operator/work-orders` |
| a turnover | `POST /units/:id/move-out` (`turnovers.js:103`) |
| a down unit | `POST /units/:id/down` (`down_units.js:72`) |
| a supply need | `POST /supply-requests` |

Four doors, four vocabularies, chosen before capture. `down_units.js:29–42` requires a
`down_reason` from a closed 12-value list *and* a `down_blocker`, both mandatory, at
entry time.

There is no single entry point where a staff member reports what they saw and the system
performs the structural interpretation. **Missing**, not partially supported: the
absence is the entire mechanism, not a weak version of it.

---

### Capture — Missing

The contract's capture is one short natural-language statement, text or voice, with
context (actor, property, unit, time) supplied automatically.

`createWorkOrder` (`work_order_service.js:209–347`) takes pre-structured fields and
**requires `title`** (line 229). A free sentence is not an accepted input shape.

**One strong partial conformance worth preserving.** The contract requires the original
words be retained exactly, as attributed evidence, surviving interpretation, confirmation,
correction, and supersession. Source already does this for the description it does accept:

- `work_order_service.js:290` — *"the work order — description stored VERBATIM"*
- `appendClarification` (line 512) writes an append-only `work_order_clarification`
  event and the header states *"The original description is never overwritten."*

The *preservation* discipline the contract asks for exists and is proven in source. What
is missing is a natural-language statement to preserve.

**Photos.** `work_orders` carries `completion_photo` (closeout proof), not observation
evidence. There is no capture-time photo attachment on the observation. ⚠ Whether any
photo storage backend exists at all **requires live proof** — see *Proof theater* below.

**Voice.** No transcription or utterance path exists in `src/maintenance/`. Grep for
`transcri|voice_note|natural_language|free_text|utterance` across `src/` returns hits
only in identity and leasing modules, none on the maintenance path.

---

### Interpretation — Missing

No component converts an observation into a proposed structured interpretation. Nothing
in `src/maintenance/` proposes anything; every write is taken as instructed.

**The nearest precedent in the codebase is strong and worth naming.**
`src/leasing/tour_outcome.js` is a Class 1 pure resolver whose header states the
contract's exact doctrine for a different domain:

> *"Standing is the ONE thing only the agent knows. The AI was not in the room; it did
> not see the face. It may prepare, propose, and pre-stage everything around this answer,
> and it may never supply the answer itself."*
>
> *"A missing capture resolves to null — an honest blank, never a neutral default that
> quietly reads as fine."*

That is the propose-but-never-decide split the contract's Interpretation and Confirmation
sections require. It exists, it is pure, it has no I/O, and it is applied to tour
outcomes. It is not applied to unit condition.

**A related conformance already exists in the maintenance vocabulary.**
`maintenance.js:259–271` serves `GET /maintenance/observation-vocabulary` with:

```js
note: "Leave unanswered if not observed. Unanswered stays unknown; it never becomes 'no'."
```

and `work_order_service.js:342` enforces it — `if (tenant_caused === true)`, strictly,
with the comment *"an unobserved cause (null) is not an accusation and owes nothing."*

The contract's "Silence means unknown, not no" is therefore **already honored for
`tenant_caused`** and is **violated for `physical_readiness`** (above). The doctrine is
understood in this codebase; it is applied unevenly.

**Also relevant:** `maintenance.js:247–258` records that `GET /maintenance/preview-category`
was *removed* because "a preview that promises what the save will not do" caused a real
defect — an operator previewed "tenant billback", saved, and got an ordinary resident
repair. That is a documented, paid-for lesson about proposals that do not match writes.
Any interpretation step the contract introduces inherits that lesson directly.

---

### Confirmation — Missing

No confirm-before-durable gate exists on the maintenance path. `createWorkOrder` writes
the work order, the event, the obligation, and any billback obligation in one transaction
with no intermediate proposed state.

**The reusable precedent is documented and live in another domain.**
`THREAD_HANDOFF.md:82–95` describes `psEconomicDecisionCard(elId, resourceName)`:

```
truth        state chip · question · amount · 3 facts
decision     open_question { question, why_it_matters, rulings[], preselected: null }
consequence  today {...} → after_cutover {...}
next action  actions { may_approve/modify/reject, denied_reason, labels }
collapsed    audit { ids, digests, record_state, quote_state, provenance, authority }
```

with the rule *"the **server** decides state and labels; the browser renders"* and
`preselected: null`. The shape is close to the contract's confirmation card, and the
handoff explicitly notes *"Adding a governed term needs a server read, not new UI."*

Whether that contract generalizes beyond economic decisions to a physical-condition
confirmation is an open question recorded below — not a conclusion. Its `rulings[]` /
`amount` vocabulary is economic-specific on its face.

---

### Durable truths

#### Attributed observation — Already supported

Verbatim description (`work_order_service.js:290`), attributed reporter and affected
person (line 214), property, unit, `created_at`, and an append-only event trail
(`work_order_opened` / `emergency_work_order`, line 316). `appendClarification` adds
history without overwriting. This clause is met for the data the current shape accepts.

#### Confirmed physical findings — Missing

**The contract's central distinction does not exist in source.**

The contract requires four separable things:

```
Finding        = what is physically observed or confirmed
Required work  = what must be done in response
Assigned work  = required work accepted by an accountable person
Completed work = work supported by a completion claim and any required proof
```

Source has no *finding*. A `work_orders` row is the required-work item; the observed
condition behind it exists only as prose inside `title`/`description`. There is no table,
column, or service concept representing a confirmed physical condition independent of the
work responding to it.

⚠ **Schema-level claim.** Verified by reading `migrations/098_work_order_operational_facts.sql`
naming and the full `work_orders` insert column list at `work_order_service.js:292–299`.
Confirming no finding-like table exists anywhere in live Neon **requires live proof**.

#### Physical readiness — Incompatible

See *The single most important finding*. Not merely missing: the current derivation is
the one the contract explicitly forbids, and its default asserts readiness where the
contract requires unknown.

#### Marketability — Partially supported

**Strongly conforms in structure.** `availability_read.js:50–104` computes marketability
as an ordered guard chain, first match wins, one stated reason — *"so a row never shows a
queue of complaints — and the reason shown is the one that must be resolved first."*
`WRITES NOTHING` (line 32). Vacancy alone does not produce marketability; the header
states `vacant ≠ ready ≠ marketable` as a permanent rule.

**Fails on inputs, not on shape.** The chain consumes `physical_readiness` and reacts
only to `"turning"`. Confirmed physical conditions cannot block marketability because
they do not exist as durable facts. A unit with three confirmed readiness-blocking
conditions and no turnover row reads `marketable_now`.

#### Vacancy — Partially supported

**Conforms, and the discipline here is exemplary.** `turnovers.js:184–234` refuses to
encode a false surrender. A turnover beginning is not automatically possession ending;
`recordEffectivePossession` throws `NO_POSSESSION_TO_END` when the named lease had no
live move-in, and the route treats that refusal as **correct, not a failure**:

> *"A turn with no lease, or for a unit nobody currently possesses, records NO move_out —
> and that is CORRECT, not a failure."*

A savepoint isolates only that expected refusal; any other error rolls back the whole
move-out rather than vacating the occupancy cache while the canonical event failed.

This satisfies the contract's requirement that capture "must not turn physical-condition
capture into an unauthorized tenancy or possession ruling."

**Gap.** `turnovers.js:237–240` unconditionally sets `units.occupancy_status='vacant'`
outside the possession guard, labeled a "compatibility cache (downstream of the event,
not the source of truth)". Whether any read treats that cache as authority is an open
question; the contract's vacancy clause depends on the answer. ⚠ **Requires live proof.**

There is no path by which a *physical-condition* observation records or reaffirms
vacancy, which the contract requires be possible when the observation supports it.

#### Completeness of inspection — Missing

No representation of partial versus complete observation exists. The contract's default —
*"These conditions were observed"*, never *"These are the only conditions requiring
work"* — has no field, and Example 5 ("I only checked the kitchen") has nothing to write
to. This directly disables the contract's Completion rule that listed-work completion must
not imply readiness when the capture was partial.

---

### Required work — Partially supported

**Conforms.** A work order is a specific item with its own identity, status, and
completion state. Closed vocabularies (`CAUSES`, `WORK_NATURES`,
`work_order_service.js:131–142`) refuse unrecognized values with an honest 400 naming
the allowed set, mirrored by `ck_wo_cause` / `ck_wo_work_nature` at the DB layer.
Required work can exist with no owner, cost, schedule, or completion date — `est_cost`
is nullable and `assigned_to` is optional.

**Conforms strongly on not inventing money.** Migration 098 removed the derived
`gl_category` from the work-order path entirely. `work_order_service.js:85–111` explains
why at length: *"A work order does not author money meaning"*, and *"money is a layer
THROUGH capture surfaces, reporting READS confirmed truth and never authors it."* This
aligns with the contract's non-goals (no costs, no vendor, no billback architecture).

**Gap — one sentence cannot become several items.** The contract requires
*"304 needs paint and cleaning. The faucet is leaking."* to produce three separately
identified required-work items, and forbids combining unrelated work into one generic
item merely because it came from one sentence. `createWorkOrder` produces exactly one
`work_orders` row per call. There is no unit-readiness scope grouping several items while
each retains its own identity and completion state.

**Gap — no finding→work derivation**, because there are no findings.

---

### Obligation and ownership — Already supported

This is the contract clause current source satisfies most completely.

- **Every work order gets a routing obligation.** `work_order_service.js:9` —
  *"a routing obligation for EVERY work order (owner or honest UNASSIGNED)"*, spawned in
  the same transaction as the work order and its event (line 326).
- **Obligations are born only from events** — consistently, across `maintenance.js:424`,
  `turnovers.js:146`, `work_order_service.js:316`.
- **UNASSIGNED is honest and structurally distinguished from unasked.**
  `work_order_service.js:388–391`:
  ```js
  ownership_origin: "observation_spawn",
  owner_eligibility_state: "unassigned",
  ```
  with the comment *"so 'nobody is eligible' and 'nobody asked' are different facts"*,
  paired by `ck_oblig_billback_ownership`.
- **Ownership is never invented.** `obligationSpecFor` sets `assigned_role: "maintenance"`
  and lets the engine resolve a person or leave it unresolved —
  *"That unresolved-but-owned-by-role state IS the honest UNASSIGNED"* (lines 158–161).
  Nothing assigns the submitting staff member by default, satisfying contract Example 4.
- **No invented clock.** `spawnBillbackDecision` sets `due_at: null` with the reasoning
  *"there is no defensible SLA for deciding a billback, and an invented clock would be a
  fake number"* (lines 382–384).
- **An observation can owe a decision without becoming one.** `tenant_caused === true`
  spawns a `billback_decision` obligation in the same transaction, born `open`, "never
  born complete" (line 375). This is precisely the contract's
  observation → obligation → decision shape, already built — for billback.

**Gap.** The obligation type the contract needs — *resolve the unit-readiness scope* —
does not exist, because the scope does not exist. Current obligations attach to one work
order (`related_type: "work_order"`) or one turnover (`related_type: "turnover"`), never
to a multi-item readiness scope.

**Gap.** `spawnBillbackDecision`'s own comment records that *"no operator surface lists
this obligation yet either — see migration 099, note 4."* An obligation nobody can see is
a live instance of the contract's concern about accountability that exists only in the
database. ⚠ Whether any live billback obligations are currently orphaned this way
**requires live proof.**

---

### Downstream consequences

#### Availability — Partially supported

The read exists, is write-free, and explains itself with a server-authored plain-language
label (`HUMAN`, `availability_read.js:142–157`). `availableFrom` (lines 114–140) refuses
to invent a ready date and returns `availability_confidence: "incomplete"` with the exact
missing fact (`no_governed_turnover_duration`, `turnover_completion_not_scheduled`).
That satisfies the contract's "It must not invent a ready date or financial amount."

**Gap.** The contract requires the read to enumerate the open scope:

```
Unavailable
Physical work remains
Open scope:
- Paint
- Clean
- Repair faucet
```

The current read returns exactly one `blocking_reason` and no item list. The
first-match-wins design is deliberate and defensible, but it structurally cannot show a
scope. Reconciling "one stated reason" with "list the open scope" is an open question
recorded below.

#### Exposure — Missing

The contract's "vacancy exposure" has no implementation. `src/money/exposure.js` is a
different concept under a colliding name: it aggregates **unproven money** (deposits,
ledgers, bank intake) as the counterpart to NOI. Grep for
`readiness|work_order|turnover|scope` in that file returns **0**.

Nothing computes vacancy exposure, and nothing distinguishes the four things the contract
requires be distinguished (known vacancy exposure, known readiness blockers, unknown
completion timing, unresolved ownership).

#### Management — Partially supported

`src/surfaces/management_read.js:237` carries `readiness: p.physical_readiness` — one
field, inheriting the incompatible derivation above. Of the contract's seven required
management elements, source supports the unit, a readiness value (wrongly derived), and
marketability via the availability read. Absent: unresolved required work, accountable
owner or UNASSIGNED, next action, and scope age.

The contract's stated goal — *"Management should not need to reconstruct the unit's
condition from work-order notes, texts, or conversations"* — is not met, because condition
lives in work-order prose.

#### Reporting — Cannot determine without live proof

`src/money/reporting.js` was not examined; reporting implementation is outside the
contract's own scope and outside the narrow scope set for this comparison. What reporting
reads *consume* is determined by the readiness and marketability defects above; whether
any reporting projection currently reads the affected fields is unverified.

---

### Correction — Partially supported

**The exact pattern the contract requires exists, and is excellent — in three places,
none of them physical condition.**

`work_order_service.js:397–501` implements append-only correction for billback decisions:

- `appendBillbackEntry` — *"Append-only: there is deliberately no update path and no
  delete path on this table, here or anywhere else."*
- `recordBillbackCorrection` requires `supersedes_id` — *"a correction must say what it
  corrects"* (line 454)
- Every entry requires a `reason` — *"A charge with no stated reason is a silent charge"*
- Every entry requires `actor_user_id` — *"A human decided, or it did not happen"*
- `readBillbackState` — *"CURRENT STATE IS A READ, never a stored status. The latest
  entry that nothing supersedes wins."*

That is, clause for clause, the contract's Correction section: original preserved,
correcting actor, correction time, reason, revised current truth, history intact.

The same `supersedes_id` / `entry_kind` shape appears in `migrations/099_billback_decision.sql`,
`migrations/092_person_attributes_provenance.sql`, `src/identity/person_facts.js`, and
`migrations/111_governed_charge_rulings.sql`.

**Gap.** Four independent implementations of one pattern, no shared rail, and none
covering physical findings, readiness, marketability, or required work. Whether the
contract's correction requirement should reuse an existing rail or whether a fourth
instance is acceptable is an open question — recorded, not answered.

**Gap.** Contract Example 6 (replace-faucet corrected to tighten-handle) requires
withdrawing or superseding a required-work item with an attributed reason. `work_orders`
has no supersession path; correcting a work order today means editing status columns.

**Gap.** Contract Example 6's wrong-unit case ("Unit 304 was selected accidentally; the
observation applies to 305") has no representation.

---

### Completion — Partially supported

**Conforms — the proof gate is real and refuses.** `maintenance.js:484–494` refuses
closeout without **both** `completion_photo` and `completion_note`, returning 409
`cannot close without proof` naming the missing inputs. `turnovers.js:362–386` refuses
`POST /turnovers/:id/ready` when required inputs are outstanding, returning
`INPUTS_OUTSTANDING` — *"you can't mark a turn ready with proof still owed."*

**Conforms — a not-done close cannot dead-end.** `NOT_DONE_REASONS`
(`maintenance.js:186–236`) is a closed list where each entry declares `follow_type`,
`follow_role`, `escalates_to`, and a human `follow_label`. A wrong reason is rejected,
never silently coerced (lines 416–422). The follow-up obligation is spawned through the
shared engine in the same transaction. This is the contract's "one accountable next
obligation" discipline, already built for work-order stalls.

**Incompatible with the contract's final transition.** The contract requires:

```
Required work completed
→ Spine proposes that the unit is physically ready
→ authorized human confirms readiness
→ marketability is recalculated
→ availability and downstream reads update
```

Source has no proposal and no human readiness confirmation. `POST /turnovers/:id/ready`
sets `status='ready'` directly once gates are satisfied, and readiness then follows
mechanically from `turn_status !== 'in_progress'`. The contract's explicit prohibition —
*"Spine must never infer: all listed work complete = unit ready"* — is what the current
derivation does by construction.

**One partial conformance worth noting.** `turnovers.js:399–405` does refuse to
over-claim across axes: if the unit is still flagged down, the response says *"Turn marked
ready, but unit is still flagged DOWN — resolve the down-unit obligation separately before
it's truly rentable."* The instinct the contract wants is present; it operates between
turnover and down-unit, not between completed work and readiness.

---

## Fixtures, demo intercepts, dormant code, and parallel paths

This section answers the scope item directly. Findings are ordered by how much they
distort the appearance of working software.

### 1. The app's entire maintenance surface is intercepted before it reaches the API

`index.html:9677`

```js
if(DEMO){
  // simulate the network but run synchronously against the in-memory backend
  try{ return demoRespond(path, opts); }
```

`demoRespond` intercepts and answers locally, from an in-memory `DEMO_DB` declared at
`index.html:9325`:

| Line | Endpoint | Behavior |
|---|---|---|
| 9508 | `GET /work-orders` | returns `DEMO_DB.work_orders` |
| 9502 | `GET /down-units` | returns `DEMO_DB.down_units` |
| 9503 | `GET /turnovers` | returns `DEMO_DB.turnovers` |
| 9504 | `GET /supply-requests` | returns `DEMO_DB.supply_requests` |
| 9507 | `GET /obligations` | returns `DEMO_DB.obligations` |
| 9522 | `PATCH /work-orders/:id/closeout` | reimplements the proof gate in JS |
| 9544 | `POST /work-orders/:id/notify-status` | returns a canned receipt |
| 5477 | `GET /work-orders` | returns `[]` |

⚠ **Requires live proof:** under what conditions `DEMO` is truthy for a signed-in
operator on a live property. Source establishes the intercept exists and what it returns;
only a browser session can establish whether a live operator can reach it. **This is the
single highest-value live check to run**, because §19–20 forbids fixture-fallback on a
signed-in operator surface, and the answer decides whether that is currently violated.

### 2. Invented operating metrics presented as a dashboard headline

`index.html:9497` — the `/maintenance-dashboard` intercept returns:

```js
avg_time_to_close:'1.8 days', tenant_satisfaction:'4.6 / 5',
avg_turnover_time:'8.5 days', avg_unit_downtime:'12 days',
compliance_due:3, current_inventory:24
```

These are hardcoded string literals. No computation, no source. §5 forbids faking a
number. A `__demo:true` flag is set on the headline object, so the *intent* to mark it is
present; whether any rendered surface honors that flag ⚠ **requires browser verification.**

### 3. A fabricated dispatch receipt

`index.html:9544`

```js
if(/^\/work-orders\/[^/]+\/notify-status$/.test(clean) && method==='POST')
  return { receipt:'Tenant notified (demo).' };
```

The operator is told a tenant was notified. No notification occurred. §5 forbids faking a
dispatch. The string contains "(demo)", which is a partial mitigation and not a
correction — the receipt is still returned to a caller that asked to notify someone.

### 4. The demo path is behind the canonical architecture it mirrors

`demoRespond`'s supply-request write calls `demoDeriveCategory(...)` and writes
`gl_category` onto the row (`index.html:9518`). Migration 098 **removed** derived
`gl_category` from the canonical path, and `work_order_service.js:85–111` explains at
length why storing it was wrong. The demo path still produces it.

This is the exact failure mode `maintenance.js:247–258` documents as already having cost
real money: a surface that promises what the canonical write will not do. It was fixed on
the server and survives in the client's parallel implementation.

### 5. The app does not use the authority-scoped path

Every app call site targets ungated routes — `/work-orders/:id/closeout`
(`index.html:13294`, `13307`), `/work-orders/:id/respond` (13252),
`/work-orders/:id/notify-status` (13314). Grep for `operator/work-orders` across
`index.html` returns **no call sites**.

The api built `/operator/work-orders` specifically so a signed-in human's property
authority is server-derived and cannot cross a building boundary
(`maintenance.js:64–82`). The live app calls the older path instead — the one that
"accept[s] property_id as a parameter, so a single key reads any building."

The seam exists, is well-built, and is unused by its intended consumer.

### 6. Closeout photo proof is a stub in the app

`index.html:11186` — *"(Photo is a stub here, same scope decision as the work-order
closeout photo.)"*

The api's proof gate requires a truthy `completion_photo` (`maintenance.js:486`). It
checks presence, not that the value is a real photo. A stub value satisfies a gate whose
stated purpose is photo proof. ⚠ Whether live closeouts carry real photo references
**requires live proof.**

### 7. Dormant code, deliberately and honestly marked

Recorded for completeness; each is documented at its site with a removal or activation
condition, consistent with §18:

- `deriveCategories` — survives for `supply_requests` only, with an explicit Class 4
  removal condition (`work_order_service.js:68–69`)
- `recordBillbackDispute` — deliberately absent; the table accepts the shape so the
  system does not migrate twice, but no resident surface exists (line 503–506)
- `gl_category` column — left in place, unwritten, awaiting one migration rather than two
- `uq_gc_one_live_owner` — provably unreachable, defence in depth (`THREAD_HANDOFF.md:52`)

These are not defects. They are correctly classified temporary components and are listed
so the contract comparison does not later mistake them for gaps.

### 8. Seed data in the app repo

Seven seed JSON files ship in the app repo root (`solo_4233_seed.json` 558 KB,
`temple_nest_seed.json` 316 KB, `skyline_1417_seed.json` 249 KB, `greenery_seed.json`,
`berks_1850_seed.json`, `1438_seed.json`, `1439_seed.json`), plus
`emergency_calls.json` (52 KB). §19 permits demo data and forbids demo paths. Item 1
above is the demo *path*; these are the data. ⚠ Which properties load which seed at
runtime **requires live proof.**

---

## Open questions

**Not a work list.** These are recorded, not answered, and none is designed here.

Several are **product questions that operator discovery should answer, not technical
questions source can settle** — what "ready" means operationally, which conditions
truly block marketing versus touring versus move-in, and how work is divided, checked,
and reopened will determine most of what follows. They are listed here only because
the source comparison surfaced them; source structure must not lead that discussion.

**On findings and readiness**

1. Does `physical_readiness` become a three-valued axis (`ready` / `not_ready` /
   `unknown`), or does `unknown` become the absence of a readiness assertion rather than
   a value? The contract requires unknown be preserved; it does not say by which
   mechanism.
2. What is the correct readiness value for the ~portfolio of units that today read
   `ready` purely because no turnover row exists? Any change to the ternary at
   `position_classifier.js:193` reclassifies every such position at once. Is that a
   migration concern, a backfill concern, or an accepted read-time change?
3. Does a finding attach to a unit, to a space, or to a position? `dated_positions` and
   `availability_read` are space-anchored (`space_id`); `work_orders` and `turnovers` are
   unit-anchored (`unit_id`). The contract says "unit" throughout. These two anchorings
   already coexist and the contract does not resolve which one a finding uses.

**On the confirmation gate**

4. Does the `psEconomicDecisionCard` contract generalize to a physical-condition
   confirmation, or is its `rulings[]` / `amount` / `quote_state` vocabulary
   economic-specific? `THREAD_HANDOFF.md` claims adding a governed term needs "a server
   read, not new UI" — that claim has been proven for economic terms only.
5. Where does an unconfirmed proposed interpretation live between capture and
   confirmation? The contract requires one confirmation before durable truth, which
   implies a non-durable intermediate state. `maintenance.js:247–258` records what
   happened last time a proposal and a write disagreed.
6. Does confirmation require the `maintenance` module entitlement, or is observing a
   unit's condition a broader staff capability? The contract's actor clause says the
   actor "does not need authority to perform or assign the resulting work" — the current
   gate (`requireMaintenanceModuleAccess`) is an authority to operate the module.

**On scope and obligation**

7. Can an existing obligation type carry "resolve the unit-readiness scope", or does the
   contract's one-obligation-over-many-items shape require a new `related_type`? Current
   obligations point at exactly one work order or one turnover.
8. How does a unit-readiness scope relate to an existing open `turnover`? Both would
   claim to represent "what this unit needs before it is ready." `turnovers.js:126–133`
   already refuses a second in-progress turnover per unit.
9. Does the contract's scope replace, wrap, or run alongside the down-unit model?
   `down_units.js` has its own 12-value closed reason list and its own obligation, and
   `availability_read.js:56` treats `is_down` as more blocking than readiness.

**On correction**

10. Should correction reuse an existing append-only rail (billback, person attributes,
    governed-charge rulings) or add a fourth instance? Four implementations of one pattern
    already exist with no shared abstraction.
11. Contract Example 6's wrong-unit correction moves an observation between units. Does
    that supersede-and-recreate, or does an observation carry a correctable unit
    reference?

**On the availability read**

12. How does "one stated blocking reason, most-blocking first" (current, deliberate)
    coexist with the contract's "Open scope: Paint, Clean, Repair faucet"? These are
    different presentation contracts over the same row.

**Outside the contract, surfaced by this comparison**

13. What is the git-tracked `property-spine-app` root file in the api repo, and can it be
    retired? It is 745 KB of HTML against the live app's 1.9 MB `index.html`. Not
    investigated beyond establishing it is not the live app.
14. Should `src/money/exposure.js` (unproven-money exposure) and the contract's "vacancy
    exposure" share a name? They are unrelated concepts.

---

## What was NOT verified

Stated plainly so the proof level of this document is not overread.

- **No live Neon connection.** Every schema claim comes from `migrations/` and
  `schema.sql`, which describe intended schema, not deployed schema.
- **No HTTP exercised.** No route was called. Refusal behavior (403/409 paths) is
  proven as written, not as served.
- **No browser verification.** Per §33 this document reaches **Reported** on the
  contract-mapping claims and does not claim any rung above it for behavior.
- **`src/money/reporting.js` not examined** — outside the narrow scope set for this pass.
- **`DEMO` truthiness for a live signed-in operator not established** — the single most
  consequential unverified item, flagged in *Parallel paths* item 1.
- **The api-repo root `property-spine-app` file was not read**, per instruction, beyond
  `file(1)` type detection and byte size.
