# Build 1 — the proposed first narrow capability

**Proposal. Nothing here is built.** Direction set by the owner: the governed
read/intelligence layer over canonical operating truth. Read-only first,
deterministic and governed answers, **no new action authority, no second task
system.**

Governed by `docs/ASK_SPINE_BUILD_CONTRACT.md` — §4.1, §5, §7, §10, §13. This
proposes *where to start*, and names the traps that will bite if we start badly.

---

## The proposal

> **One intent, end to end: `maintenance.completion_without_valid_proof`.**
> Work orders only. One read. One receipt. No actions.

### Why this one and not another

**It is the only intent whose subject matter already has a governed writer.**
Release 0 made work-order completion canonical: one writer, evidence frozen when
cited, validated at commit by one SQL function. Every other candidate intent —
blocked work, ownership and acceptance, attention — reads facts that have **no**
governed writer behind them yet. `status='open'` is a column. `assigned_to` is free
text. Building intelligence over those is reconstruction with a better sentence
around it, which is the failure mode the whole product exists to avoid.

Two supporting reasons:

- **`maintenance.attention` cannot be the anchor** — §3 marks it *not frozen*, and
  Ask Spine Slice 1 already built it. A first capability should be a frozen intent
  so the contract, the version and the digest mean something.
- **Read-only makes the hardest constraint structural.** A non-empty proof-gap
  answer is a *system-integrity* signal, not a person's failure — the ruling already
  settled for the §4.2 sweep. An intent that cannot act cannot turn that into an
  accountability item by accident.

### Shape

```text
resolve intent   (model may do this)
      ↓
governed executor → structured facts from the canonical reader + DB validator
      ↓
controlled renderer → sentences built from fields
      ↓
receipt: intent_slug · contract_version · contract_digest · total · cap · authority
```

`coverage_state` is **computed** from per-source read statuses, never chosen by a
renderer (Slice 2's contract, unchanged). Answer posture is `DECISIVE` / `BOUNDED`
/ `BLOCKED` per §2.3.

**Build the executor for this one intent, shaped so a second is additive.** Do not
build the generic executor speculatively — a generic executor with one caller is a
guess about the second caller.

---

## The traps

Ordered by how expensive they are to discover late.

### T1 · Before activation, the honest answer is "unavailable", not "none"

The canonical reader returns `read_status: "unavailable"` — with `state` and
`satisfied` **absent**, not null — until Release 0 is activated. The intent must map
that to the `unavailable` coverage state, **never** to `valid_empty`.

*"Nothing needs proof"* and *"I cannot tell you what needs proof"* are different
answers, and shipping the first when the second is true is the exact defect Release
0 spent itself preventing.

**Consequence for sequencing, stated plainly:** this capability can be built and
proven before activation, but it cannot give a decisive answer until Release 0 runs
in production. That is not a reason to pick a different intent — it is a reason to
build it now so it is ready, and to make its blocked state honest and legible.

### T2 · The two lanes must never be collapsed

§4.1 is explicit and Release 0 widened the gap rather than closing it:

| | work-order lane | unit-turn lane |
|---|---|---|
| source | `work_order_proof_evaluations` + cited evidence | `work_completion_claims.proof_satisfied` |
| meaning | derived under **today's** rule, validated at commit | a **preserved verdict** under the rule in force at claim time |
| authority | `release_0_evidence_qualifies` | whatever was true then |

One number computed under two definitions is two meanings of truth wearing one
label. **Work orders only**, and the answer says so.

### T3 · There are five categories, not four

§4.1 lists four (claimed-not-completed · no attachment · referenced-not-preserved ·
fetch failed). Release 0 adds a fifth that must stay separate:

**`legacy_indeterminate` — pre-cutover work whose proof was never required.** It is
not "completion without valid proof." Folding it in manufactures a defect population
on day one, which is precisely the error the reader's `unavailable` design was
written to prevent. Per the settled ruling it is an operator/internal state: it may
appear on this surface, and it never travels outward under that name.

### T4 · Result caps must ship their own honesty

A capped list without its uncapped total reads as "that's all of them." Reuse the
existing `MAX_ITEMS` in `ask_spine_service.js` — **do not introduce a second cap
constant.** The answer carries `total`, `returned`, and the cap that applied.

### T5 · Do not build a second freeze mechanism

§7 requires `intent_contract_digest` on every receipt. The repo already has a
digest-freeze that works and has caught two real changes this release:
`docs/release0/FROZEN_ARTIFACTS.json` + `tests/gate_release0_frozen.js`, running
inside the same 16-gate `npm run verify`.

Extend it — one more manifest section, one more gate in the same runner. A parallel
intent-freeze system would be a second answer to "what is frozen and how do I know",
and collapsing complexity means having one.

### T6 · "The model does not state operating truth" needs to be structural

§2.2 is a constraint, not a style note. If any sentence about lifecycle, completion,
proof, assignment or authority *can* originate in model output, it eventually will.
This wants a source-governance gate — the renderer's factual sentences must come
from named fields — not a review habit. Slice 1's property-input receipt is the
precedent: it proved a negative about the source, mechanically.

### T7 · Property authority is already proven; do not regress it

Slice 1's receipt establishes: no request-body property, no query-string property,
no fallback, no default constant. Server-derived scope (§21). A new intent inherits
that shape and should be checked the same way, in the same receipt format.

### T8 · The long-term one — recomputed answers drift, preserved verdicts do not

This has already bitten twice (preserved claim verdicts vs recomputation; `closed`
as historical vocabulary). An intent that **recomputes** will, years later, answer
differently about the same past work as the rules evolve — which is correct for
"what is true now" and *wrong* for "what did we report in March."

So: **decide per intent, explicitly and in the contract, whether the answer is
recomputed or preserved.** §4.1 already splits the two lanes on exactly this axis.
And a receipt must record the `intent_contract_version` **that produced it**, not
the current one — that is the only thing that makes an old answer re-readable.

### T9 · A Release 0 dividend worth using deliberately

Cited evidence is frozen the moment an evaluation cites it (R0005). So the evidence
behind an answer **cannot silently change under a receipt.** That is what makes a
read receipt meaningful months later, and it is a property no other domain in this
codebase has yet. Build 1 should lean on it — and should notice that intents over
un-frozen evidence will not have it.

### T10 · Scope fence

No work cards, no queue behaviour, no persistent conversation state — those are
Build 2 (§16), and building them early creates the second task system the direction
explicitly forbids. **The transcript is not the queue** (§2.4), and the safest way
to honour that in Build 1 is to have no durable conversation object at all.

---

## Definition of done for the capability

Per §33 and §17: real Postgres → real authenticated HTTP → browser observation.
With one honest qualifier: **before activation the browser-verified answer will be
the `unavailable` state**, and that is a pass, not a failure. The decisive answer is
verifiable only after Release 0 runs.

## What this proposal does NOT include

The generic intent executor · the other two frozen intents · maintenance
projections · clarification and correction flow · concealment rules · Property Home
· any action, governed or otherwise · any money linkage (parked — see
`NEXT_BUILD_REPORTING_INPUT.md` R4).
