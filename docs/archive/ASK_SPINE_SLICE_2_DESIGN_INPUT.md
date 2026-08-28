# Ask Spine Slice 2 — design input

> ## ⚠ STATUS — 2026-08-12. DESIGN INPUT FOR A BUILD THAT WAS NOT RELEASED.
>
> The state block below (`a04a1df`, ledger ceiling 136) is many releases stale.
> This is the premortem behind the parked maintenance charter
> (`ASK_SPINE_BUILD_CONTRACT.md`), not a description of what shipped.
>
> **Still live:** the schema audit and the coverage-state vocabulary — a read
> reports its own status and `coverage_state` is computed, never chosen by a
> renderer. That principle survives into `PHILOSOPHY.md` §40's four silences.
>
> **Superseded:** the state block, and the intent-coverage contract as the
> governing design. Current: §40, then `ASK_SPINE_CANONICAL_READ_LAYER.md`.

Written at the close of the Ask Spine Slice 1 thread, as the direct input to the
build of the **intent coverage contract**. Nothing here is built. This is the
record of what was decided, what was audited against the schema, and what will
break the design if it is not handled.

State at the time of writing:

```text
RENDER_GIT_COMMIT   a04a1df      api main tip, deployed
app main            6220ca5      deployed
migration ceiling   136          reconciled, EXIT 0
communication_lines 1 row        property_facing, active, provider_configured = f
                                 NO operations row · no carrier wiring · nothing reachable
```

---

## 1. The contract, as agreed

Each supported intent **declares its required sources before any read**. Each read
reports a status. `coverage_state` is **computed** from those statuses — never
chosen by a renderer.

```text
read status     answered · failed · unauthorized · not_applicable
coverage_state  complete · partial_safe (bounded but usable)
                · insufficient_for_conclusion · unavailable · valid_empty
                · disputed
```

The governing sentence:

> Property Spine does not merely answer from available data. It declares what
> must be known, proves what it checked, gives only the conclusion those facts
> support, and leaves a receipt showing why.

**`valid_empty` is load-bearing.** It is the named state for "I checked, and there
is nothing." Without it, an honest empty and a swallowed failure render the same,
which is the exact lie the 2 Aug 2:06 PM abort caught.

---

## 2. The premortem — where this fails

**The weakest part: every rung proves the process. Nothing proves the premises.**

Two premises carry the design and neither has an oracle:

1. **`required_sources` is a human declaration that nothing checks.** Under-declare
   and the answer returns `complete`.
2. **`answered` means "the source responded" — not current, not correct.**

Both failures push the system toward *more* confidence. An under-declared intent
reading stale data produces the highest-confidence state in the vocabulary, and
the qualified-answer-rate metric records it as a win. **`complete` is the most
dangerous state in the system.** `insufficient_for_conclusion` is the safe one —
it gets read and argued with. Nobody audits a green.

### The six-month failure story

Eight intents ship. Weeks 1–3 they refuse a lot, correctly. By week 5 refusing is
annoying, and the cheapest fix is never to add a source — it is to edit the
declaration. A required source becomes optional. Another becomes `not_applicable`
for "properties like this one." No schema changed, no migration ran, no proof rung
went red, because none of those things watch the declaration.

By month 4 most intents declare one or two required sources, nearly everything
returns `complete`, and the qualified-answer-rate reads 94%. Then an answer is
wrong in a way that costs money — and the receipt is *correct*. The system did
what it declared. The declaration was the lie.

The second version has nobody editing anything: a source starts returning 200 with
three-week-old rows. `answered`, `answered`, `answered`, `complete`. The receipt
proves the reads happened. Nothing in it says **when the facts were true**.

### Ranked failure modes and the fix for each

| # | Failure | Fix |
|---|---|---|
| 1 | **Declaration drift.** `required_sources` erodes under refusal fatigue. | Version and digest it exactly like the ranking policy. A *reduction* is a receipted, reviewed change — not config. **Sample the greens, not the reds.** |
| 2 | **`answered` hides staleness.** | Every read reports `as_of`. Each source carries a staleness threshold. Past it, the status is not `answered`. |
| 3 | **`not_applicable` is unfalsifiable.** The only status that is a claim about the world rather than a report of an attempt — so it absorbs every inconvenient failure. | Reason from a closed set of recorded facts ("module not enabled", "no units in this state"). If establishing the reason needs a read, that read is required. Never a default, never free text. |
| 4 | **`unauthorized` collides §5 with §21.** Cannot say `complete` without reading it; cannot say "there is data you can't see" without leaking that it exists. | Yield a **scoped** answer with a stated boundary — "within maintenance and leasing" — describing the answer's scope, never the withheld source's existence. Never `complete`. |
| 5 | **`disputed` is sticky and has no adjudicator.** `failed` self-heals when the source returns; `disputed` needs human labour, and the queue is unbounded at n=1. | Give it a conclusion path: state the conflict, then conclude from the *agreeing* subset if one exists. Plus expiry. |
| 6 | **Receipts turn a read surface into a write surface.** Fatal receipt failure means a receipt outage takes down reads. Non-fatal means the audit trail has holes exactly during the incidents that need it. | Non-fatal, but the failure is recorded **on the answer** (`receipt: not_written`). Honest blank applied to the audit trail itself. |
| 7 | **Acceptance cases prove states are reachable, not that the right one is chosen.** Every failure that matters is a *successful read of wrong data*, and no case covers it. | Add an adversarial case: a source returning 200 with stale/partial content must not produce `complete`. |
| 8 | **Refusal is a UX cliff — the one that kills the product.** An operator who gets "I can't conclude" with no next action texts the tech instead, and does not come back. The thesis is removing the translation layer; a dead-end refusal *reinstates* it. | Every refusal names the missing fact **and** the action that supplies it. A refusal is a work item. |
| 9 | **The metric assumes adjudication labour nobody has.** | Five sampled `complete` answers a week. If that cannot happen, do not ship the metric — an unaudited accuracy number is worse than none. |

---

## 3. Schema audit — the plan is better supported than it knows

The maintenance-first plan proposes six judgment rules. **Five are already recorded
facts.** Verified against the migration set at ceiling 136:

| Rule | Recorded fact | Migration |
|---|---|---|
| emergencies first | `work_orders.urgency_status` ∈ `emergency`/`regular`/`needs_confirmation`, + `urgency_basis`, `urgency_decided_by` | 078 |
| overdue **and unassigned** | `obligations.due_at`, `assigned_user_id`, `assigned_role`; **plus** `accepted_by_user_id`/`accepted_at` | 001, 131 |
| no access → coordination | `work_order_progress.kind = 'no_access'` | 134 |
| failed delivery ≠ completion | `comm_delivery_attempts.outcome` ∈ `sent`/`failed`/`refused`, + `failure_reason` | 135 |
| missing proof prevents closure | `completion_claimed` vs `completed`; `work_order_proof_attachments.storage_state`, `proof_classification` | 134 |
| blocked needs a next owner | `kind = 'blocked'` recorded — **no next-owner field exists** | 134 |

**Consequence for the build order.** "Maintenance truth" is not a phase. What is
missing is the *read*, not the record. Define maintenance truth as exactly the
recorded facts the shipped questions require, derived backwards from the question
list — otherwise it is unbounded and it is where the slice slips.

### 3a. One rule is schema-backed and fact-empty

`comm_delivery_attempts` exists and will stay empty: one `communication_line`,
`property_facing`, `provider_configured = f`, **no `operations` line at all**.

Therefore **"retry communication" cannot be built**, and "failed delivery is
separate from operating completion" can only be proven against a fixture. Sequence
it after carrier wiring, or mark it deferred — but keep it out of the acceptance
contract. A fixture-backed pass on a delivery rule is the false green this whole
discipline exists to prevent.

### 3b. `disputed` must not be dropped — the first case already exists

Two recorded facts answer the same real-world question, with no reconciliation:

```text
obligations.severity          low | normal | high | emergency     default 'normal'
work_orders.urgency_status    emergency | regular | needs_confirmation
```

Neither is clean:

- `severity` defaults to `'normal'`, so most rows carry a value nobody chose. **A
  default is not a decision.**
- Migration 078's backfill sets `urgency_decided_by = 'operator'` for every
  pre-existing row. That records a provenance claim that is not true — a migration
  decided, not an operator. Ranking "emergencies first" on that field means ranking
  partly on a fact the schema asserts and history does not support.

And `needs_confirmation` is a third thing: urgency **undecided by design**. That is
a coverage input, not a ranking input. Rule 1 must state what it does when urgency
is unconfirmed — promote, demote, or decline to order — and say so in the answer.

### 3c. The best question is the one that breaks the naive contract

**"What was reported complete but still lacks proof?"** should lead. It is fully
backed and has at least four distinct honest answers already modelled:

1. `completion_claimed` with no `completed` and no attachment
2. `storage_state = 'referenced'` — a row exists, the bytes do not
3. `storage_state = 'fetch_failed'` / `'not_preserved'` — preservation failed
4. `proof_classification = 'unclassified'` — evidence exists, of nothing in particular

Cases 2–4 are the premortem's `answered ≠ true` sitting in the schema **today**.
The read succeeds; the proof is not there. A naive contract returns `complete` and
is wrong. Build this question early precisely because it breaks the naive version.

### 3d. Landmine in the action list

"Coordinate access" is a **third writer** on the cause migration 136 exists to
guard. Its own comment names the failure: the derived resident update and the
operator control both fired on one `no_access`, and the resident got the same
sentence twice. The unique index on `derived_from_progress_id` now makes that
unrepresentable — so the action will hit a constraint, not send a duplicate.

The requirement is therefore a **UI** one: show *"the resident has already been
asked"* as a recorded fact **before** offering the action. Not an error after the
click.

---

## 4. Question readiness

| Question | Status |
|---|---|
| What was reported complete but still lacks proof? | **Ready, richest, lead with it** |
| What is blocked? | Ready — but "next owner" is not a recorded field |
| What needs attention? | Shipped (Slice 1); needs re-scoping to maintenance |
| Who owns Unit 302? | Backed but ambiguous (assigned / accepted / role), and it returns a person, not work cards — a different answer shape |
| What is waiting on a resident? | **Blocked on carrier wiring** |

---

## 5. Carried rulings

- **Cards land with the read, not after actions.** The cards *are* the operating
  field the answer produces; they belong in the read slice.
- **Two sources minimum in the first slice.** With one, `complete` and `unsupported`
  are the only states reality can reach and every acceptance case is synthetic.
- **Ship `as_of` and the declaration digest in the same slice as the contract.**
  Retrofitting freshness into a status vocabulary already in use is a migration
  across every receipt ever written.
- **Make one intent deliberately over-declare.** Prove
  `insufficient_for_conclusion` on a real question with real data before proving it
  on a fixture.
- **Operating result and delivery result stay two facts.** Always.
- **A refused question is a required acceptance case**, tested as seriously as the
  successful one.
- **This slice does not depend on SMS activation.** It reads code deployed at
  `a04a1df`.

### On the pilot

"Real managers" is n=1, and n is the author. *"Do they still text someone after
asking Spine"* survives that — it is the real product metric and it is observable
with one person. *"How often they correct the facts"* and *"how often they override
the ordering"* do not survive it. Name a second operator before the pilot, or drop
those two signals rather than collecting numbers that cannot mean anything.

---

## 6. The thesis this serves

> The real product is the removal of the translation layer between what is
> happening at the property and what the company knows. It is the operating memory
> and judgment of the organization — radical ease on the surface, uncompromising
> discipline underneath.

Confess better first, so it can judge better without becoming dangerous. Judge
decisively inside proven boundaries. State the boundary whenever it affects the
decision. **Refuse only the conclusion that the missing facts prevent.**
