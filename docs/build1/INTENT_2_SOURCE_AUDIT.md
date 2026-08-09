# Intent 2 — source audit

Read against live schema and shipped services on the Build 1 branch (RC `f6873d7`
+ Capability 1). **No code was written for either candidate.** The question is only:
*could this intent answer from canonical facts without reconstructing operating
meaning?*

**Verdict up front:**

| candidate | governed? | decision |
|---|---|---|
| `maintenance.blocked_work` | **No** — onset without resolution | **not ready.** Missing foundation named below |
| `maintenance.ownership_and_acceptance` | **Yes, for current state** — over the *obligations* rail | **selected as Intent 2** |

---

## 1 · `maintenance.blocked_work` — NOT READY

### What exists

`work_order_progress.kind = 'blocked'` is a real durable fact, and better than
expected:

| question | answer |
|---|---|
| durable blocked state/event | **yes** — `work_order_progress` row, `kind='blocked'`, append-only in practice |
| what object is blocked | **yes** — `(work_order_id, property_id)`, composite FK |
| blocker start / effective time | **yes** — `occurred_at`, distinct from `created_at` |
| property scope | **yes** |
| authenticated actor | **yes** — `reported_by_user_id`, FK to `users` |
| distinct from open/overdue/unassigned | **yes** — `work_orders.not_done_reason` is set to `'blocked'`, so it is not merely "still open" |
| is the classifier a model? | **No.** `src/conversation/technician_intent.js` is a **deterministic regex lexicon** (`/\b(?:blocked\|stuck\|held\s*up)\b/i`). No model client. This was the first thing I checked and it is genuinely good news |

### What does not exist, and why it disqualifies the intent

**There is no clearing event.** The `kind` vocabulary is frozen by CHECK constraint
at `en_route · no_access · blocked · finding · completion_claimed · completed`.
There is **no `unblocked`, no `resumed`, no `blocker_cleared`.** A repo-wide search
for such a concept finds nothing in `src/`.

And `not_done_reason` is cleared in exactly one place —
`lifecycle_service.js:311`, on **completion**:

```sql
update work_orders set status = 'complete', not_done_reason = null, …
```

So the state machine is:

```text
blocked ──────────────────────────────► complete        (the only exit)
   │
   └── work resumes in the real world ──► NOTHING IS RECORDED
```

A work order blocked in March, unblocked by a part arriving in April, and still open
in May **still reads `blocked`**. Answering *"what is blocked right now"* therefore
requires interpreting the event sequence — is a later `en_route` a resumption, or a
second attempt that failed again? — which is precisely the interpretation the ruling
says disqualifies a candidate.

**Two further gaps, smaller but real:**

- **No governed blocker reason.** The only detail is `note`, free text from an SMS
  body. There is no reason vocabulary, so "blocked on parts" vs "blocked on access"
  vs "blocked on a decision" cannot be distinguished without reading prose.
- **No expected resolution time.** No `blocked_until`, no follow-up commitment. So
  the intent could not say whether a blockage is stale.

### The missing foundation, stated precisely

> **Blocked has an onset and no terminus.** To make `maintenance.blocked_work`
> answerable, the work-order progress rail needs a governed **resolution** fact —
> minimally a `blocker_resolved` kind written by the same canonical writer, and a
> `blocker_reason` from a frozen vocabulary rather than free text. That is a
> Property Spine foundation change, not an Ask Spine one, and it is exactly the
> kind of thing Ask Spine must not paper over.

---

## 2 · `maintenance.ownership_and_acceptance` — READY, with limits

### The finding that changes the picture

**Work-order ownership is not `work_orders.assigned_to`.** That column is free text,
and nothing governed writes it (`work_order_service.js:227` sets it to `null`).
`vendor_id` is a nullable FK with no lifecycle.

Ownership is carried by the **obligations rail**:

```sql
obligations where related_type = 'work_order' and module = 'maintenance'
```

`src/technician/conversation.js:92` reads exactly this to find a technician's work,
which is the product confirming it.

### The durable objects, and their writers

| concept | durable object | writer | governed? |
|---|---|---|---|
| **assignment** | `obligations.assigned_user_id` / `assigned_role` (`role_name` enum) | obligation creation + `PATCH /operator/obligations/:id/claim` (self-claim, session-derived actor) | **yes** |
| **acceptance** | `obligations.accepted_by_user_id` · `accepted_at` · `acceptance_key` | `src/technician/acceptance_service.js` — *"THE canonical work-acceptance write… There is no second path"*, called from the SMS path | **yes** |
| **unassigned** | `assigned_user_id is null` | — | **yes**, structurally |
| **authenticated actor** | session-derived (`resolveStaffSession`) | — | **yes** |
| **accountable** | — | — | **NO. Not modelled** |

### Assignment and acceptance cannot be collapsed — the database refuses

This is the part that makes the intent honest rather than merely convenient:

```sql
ck_oblig_acceptance_paired    (accepted_by_user_id IS NULL) = (accepted_at IS NULL)
ck_oblig_accepted_not_open    accepted_at IS NULL OR status <> 'open'
ck_oblig_accepter_is_owner    accepted_by_user_id IS NULL OR
                              assigned_user_id = accepted_by_user_id
```

`ck_oblig_accepter_is_owner` is the one worth naming: **only the assigned owner can
be the accepter.** So `assigned` and `accepted` are distinct states with an enforced
relationship, and there is a genuine third state — *assigned but not accepted* —
that the system can report truthfully. Acceptance is also replay-safe:
`uq_obligations_acceptance_key` on the inbound provider message id.

### What must be withheld

- **No reassignment history.** There is no obligation event table for the general
  case (`leasing_conversion_obligation_events` is leasing-specific;
  `obligation_input_proofs` is about inputs). So *"who owned this before"* and
  *"when was it reassigned"* are **unanswerable** and must be withheld conclusions.
- **`ownership_origin` / `owner_eligibility_state` are not universal.** They are
  constrained only for `billback_decision`, `prepare_application_link` and
  `send_application_link`. For a work-order routing obligation they may be null, so
  they cannot carry meaning.
- **Accountability.** `missed_at` / `missed_threshold_at` exist and are tempting.
  An assigned owner who has not accepted is **not** a person at fault, and the same
  ruling that governs Capability 1 applies unchanged.

---

## 3 · Why this is the right Intent 2, on the owner's own test

**It is a second body of governed truth, not the same projection wrapped twice.**
Capability 1 reads the Release 0 proof rail (`release_0_completion_invariant_
violations`, `proof_state.deriveProofState`). Intent 2 reads the **obligations
rail** — different tables, different writers, different invariants, built by a
different release. Nothing is shared but the executor.

**It forces genuinely new executor seams:**

| dimension | Capability 1 | Intent 2 |
|---|---|---|
| canonical source | Release 0 proof rail | obligations rail |
| predicate shape | a canonical **view**, property-filtered | **state combinations** on a table (assigned/accepted/unassigned) |
| answer shape | two lanes (current vs historical) | **three ownership states**, not lanes |
| answerability gate | activation authority | **none needed** — obligations do not depend on the Release 0 cutover. This is the seam that proves required-source checking is contract-driven rather than Release-0-shaped |
| optional source | none | the related **work order** is genuinely optional context — a natural, uninvented `PARTIAL` |

That last row matters most: Capability 1's `unavailable` came from Release 0's
activation. If Intent 2 needs no such gate and still works, the executor's
answerability machinery is proven generic. If it *cannot* be built without an
`if (intent_slug === …)`, we will have learned the abstraction is fake — which is
the point of building it.

---

## 4 · What I am NOT proposing

No obligations redesign. No new writer. No blocked-work foundation work. No
`work_orders.assigned_to` cleanup. Intent 2 reads what already exists and withholds
what does not.

**And one honest flag for the owner:** the governed object is the **obligation**,
which *relates to* a work order. The intent therefore answers *"who owns and has
accepted the maintenance work"* by reading obligations — not by reading a
work-order assignment field, because that field is not truth. If the product
intends work-order ownership to be a work-order-level fact rather than an
obligation-level one, that is a foundation ruling, and it should be made before
this intent freezes its contract.
