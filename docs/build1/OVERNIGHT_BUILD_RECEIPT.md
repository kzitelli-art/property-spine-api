# Ask Spine — the overnight build

Two governed capabilities, one generic executor, a real composer, and an honest
frontier. Built ahead on `claude/build-1-completion-proof-intent`, cut from the
Release 0 RC `f6873d7`.

**Not shipped.** Build 1/2 do not ship ahead of Release 0 activation and
acceptance. **No production activation was run.**

```text
gates                              17/17
prove_completion_proof_intent      59/59   Capability 1, unchanged
falsify_completion_proof_intent    53/53   Capability 1, unchanged
attack_obligation_ownership_rail   32/32   the rail, before trusting it
prove_ownership_intent             47/47   Capability 2
prove_ask_spine_turn               49/49   the conversational layer
ask_spine_turn.browser.js          20/20   real Chromium, real API, real Postgres
leaked database clones                 0
```

---

## What it does now

An operator types a question into the existing Ask Spine block and gets:

```text
Understood as: ownership and acceptance
2 current maintenance obligations: 1 unassigned, 1 assigned and accepted.
  WO 1001 · proof evaluation missing · Unassigned
  WO 1001 · work order routing · Assigned to Alice · Accepted
```

Ask *"which completed work doesn't have valid proof?"* in a database where
Release 0 is not activated and it says **"I can't answer that from governed
truth right now"** — not zero. Ask *"what's blocked?"* and it says why that
question is not supported. Ask *"what's wrong with maintenance?"* and it asks
which of the two you meant.

---

## The genericity test — the point of a second intent

Capability 1 reads the Release 0 proof rail. Capability 2 reads the obligations
rail. Different tables, writers, invariants, entity type, answer shape, and
answerability. The evidence that the abstraction is real:

```text
E1  this database has NO Release 0 activation
E2  Capability 1 is therefore honestly UNAVAILABLE
E3  ★ Capability 2 is DECISIVE in the SAME database
E4  …and never consulted the activation authority
E5  …because its contract declares no Release 0 source
```

**The seam the second intent forced:** answerability *used to be*
`proofState.activationAuthority` — hard-coded, so every intent inherited Release
0's cutover whether it read Release 0 data or not. Prechecks are now keyed by
**source id** (shared vocabulary); adapters are registries keyed by slug
(dispatch tables, not business branches). Gates A14–A17 assert no
`intent_slug === …` in the executor, registry lookups present, prechecks never
keyed by slug, and each contract's Release 0 dependency **declared rather than
inherited**.

The one genuinely new generic concept is **facets** — counts over the full
population, separate from the cap. Capability 1 declares none.

---

## Findings, in the order they were found

**1 · The obligation rail had a real hole (migration 142).**
`update obligations set assigned_user_id = null` **committed**, leaving
`accepted_by = Alice, assigned_user = NULL` — an acceptance owned by nobody.
`ck_oblig_accepter_is_owner` could not catch it because a CHECK passes when its
expression is NULL. No shipped writer can reach it, so it is the psql-session
class that Release 0 argues belongs in the database. Added `NOT VALID` so it
binds new writes without risking a deploy on legacy rows.

**2 · Cardinality is many, structurally.** No unique index ties a work order to
one obligation. One work order carries a routing obligation assigned to Alice,
an unassigned proof-defect obligation, and a follow-up assigned to Bob.
`work_order.owner` is not a thing that exists — proven, and the renderer is
asserted never to name one.

**3 · Claim and accept are sequentially incompatible.** The self-claim route
sets `status='in_progress'`; `acceptWork` requires `'open'` and refuses
`not_open`. A claimed obligation can therefore never reach ASSIGNED_ACCEPTED.
**Product ruling for the owner** — Ask Spine reports what is recorded and infers
nothing.

**4 · An accepted obligation cannot be reassigned at all.** The database refuses
the shipped claim UPDATE and no writer clears acceptance. Safe, but reassignment
after acceptance has no governed path. Recorded as a foundation gap.

**5 · "Who is accountable for this?" resolved to assignment.** The lexicon
matched `who is` and answered a *different question than the one asked*, in the
exact area where the difference is the whole point. An explicitly unsupported
topic now wins over a lexicon match: refusing the right question beats answering
the wrong one confidently.

**6 · The browser caught intent-neutral wording.** Asked *"who is assigned?"*
with the obligations source broken, the shared `unavailable` sentence said
*"I can't determine completion **proof** right now"* — naming Capability 1's
subject in answer to Capability 2's question. A conclusion code shared by every
intent may not have words belonging to one. Phase 12 freezes the contract, not
the English, so the sentence changed and both capabilities stayed green.

---

## The model boundary

**There is no model on this path to turn off.** Intent resolution is a
deterministic lexicon, the same discipline the technician SMS path has used
successfully. W1/W2 prove a full governed turn completes with every model
credential removed; the source scan proves none of the four modules imports a
model client. A model may later produce the same three-value output — `resolved`
/ `clarification_required` / `unsupported` — and nothing downstream changes.

## What is preserved, and what is not

`ask_spine_read_receipts` (141) and `ask_spine_interpretations` (143) are
append-only. A **correction adds a row naming the one it corrects** and never
edits it, because the pair is what makes a correction meaningful. V5/V6 prove
the distinction that matters: after governed truth legitimately moves, a new
answer reflects it while the old receipt still says exactly what it said, with
the contract version that produced it.

There is **no conversation memory** — no thread, no summary, no state machine.
Reload rebuilds a completed answer from its receipt, never from a transcript.

## Boundaries held

No actions of any kind. Y1 proves that after four turns — supported, supported,
ambiguous, unsupported — no work order, obligation, evaluation, progress row or
acceptance changed. Ask Spine knowing an obligation is unassigned does not give
it authority to assign it.

No Release 0 artifact was modified. No second Ask Spine page, no new app shell,
no Property Home, no work cards. `maintenance.attention` is untouched and a
vague question deliberately does **not** fall through to it.

`maintenance.blocked_work` is **not built**, and the resolver refuses it by name
with its reason. The missing foundation: block onset is governed, block
resolution is not, blocker reason is free text.

## Harness hygiene (phase 24)

`tools/build1/run_isolated.sh` creates one disposable clone per run and destroys
it in a trap on success, failure and interrupt, terminating leftover backends
first — a live connection is how 848 clones once accumulated. It preserves the
child's exit code exactly, and self-heals the local cluster, which this
environment stops between turns. **The database is destroyed from outside**: a
harness that could clean up after itself would be a harness that can delete
history. Proven both ways, including a child that fails holding an open
connection. Zero clones leaked across the final suite.
