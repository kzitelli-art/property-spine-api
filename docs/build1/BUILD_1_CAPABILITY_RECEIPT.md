# Build 1 — first capability receipt

**`maintenance.completion_without_valid_proof`**, built ahead on
`claude/build-1-completion-proof-intent`, cut from the Release 0 RC
**`f6873d7`**.

**Not shipped.** Build 1 does not ship ahead of Release 0 activation and
acceptance. This is a build-complete candidate, not a live capability.

```text
npm run verify                                                    17/17 gates
BUILD1_DATABASE_URL='…'    node tools/build1/prove_completion_proof_intent.js      59/59
FALSIFYB1_DATABASE_URL='…' node tools/build1/falsify_completion_proof_intent.js    53/53
Release 0 regression, unchanged on this branch          48 runs · 0 non-zero · 757
```

---

## Against ruling 20's sixteen

| | criterion | evidence |
|---|---|---|
| 1 | immutable intent contract | `src/askspine/contracts/…json`, digest pinned in `docs/build1/FROZEN_INTENTS.json`, enforced by `gate_ask_spine_contract_frozen.js` (17th gate, same runner). Four mutations proven to turn it red — N section |
| 2 | predicate covers the full property population | D1/D4 — 130 rows, total counts all of them, and a match **beyond position 100** is still found. No recent-N sample anywhere |
| 3 | canonical Release 0 truth consumed, not reimplemented | lane A **is** `release_0_completion_invariant_violations`; per-record verdicts are `proofState.deriveProofState`. Gate A8 forbids an evidence predicate in the executor, and S1 proves that gate fires |
| 4 | all required answer states honest | K1 unavailable · K2 broken source → unavailable · K5 valid_empty · decisive · unsupported (H4). Three distinct answers where a lesser design would give one zero |
| 5 | current vs pre-cutover preserved | C1–C8, L6–L9. Counted separately, rendered separately, never summed |
| 6 | caps bounded and disclosed | cap in SQL (`limit $2`), re-enforced in the service (`.slice(0, cap)`), disclosed per lane in the answer. M1–M4 prove the renderer is not the cap |
| 7 | source coverage mechanical | `coverage_state` computed from per-source read statuses; never chosen by a caller or renderer |
| 8 | evidence timing explicit | `executed_at` ≠ `evidence_as_of`, separate columns, with `evidence_as_of_basis`. Null when unknown — never `now()` |
| 9 | server-derived authority | F1/F3/F7/F8/F9. A client `property_id` gets **403**, not silence |
| 10 | durable read receipt | migration 141, append-only. E1–E12, Q1–Q9 |
| 11 | renderer cannot exceed supported conclusions | frozen sentence table; an unknown code **throws** (H3, P4). A3 checks contract and renderer agree |
| 12 | real Postgres proof | every assertion above runs against a real isolated Postgres |
| 13 | authenticated real HTTP proof | F section — real socket, real `issueStaffSession` token, real route |
| 14 | falsification suite | 53 assertions across K/L/M/N/P/Q/R/S |
| 15 | no domain mutation | the only write is the receipt. No work order, obligation, assignment, evaluation or evidence is touched |
| 16 | no composer/cards/actions; no attention semantics | one GET. No conversational state, no persistence beyond the receipt, no ranking. `attention()` untouched — byte-identical |

---

## Decisions made while building, and why

**The cap is per lane, not shared.** Found by measurement: with 130 current and 1
historical row the first version selected 21 against a cap of 20 and would have
violated its own receipt constraint. The fix was a ruling, not a patch — a shared
budget lets a large pre-cutover history crowd current integrity failures off the
page, and the current lane is the urgent one. Contract moved to **1.1.0**; the
receipt's `selected_count <= result_cap` check was removed as a rule the product
does not have, and `selected_count <= total_matching` kept as the one that would be
a lie if violated.

**This corrects my own earlier advice.** `BUILD_1_FIRST_CAPABILITY.md` T4 said
*"reuse the existing `MAX_ITEMS`"*. Wrong: `result_cap` is a contract field, so a
shared constant would let one intent's cap change another's with neither digest
moving. `MAX_ITEMS` stays with `attention`. One cap **mechanism**, one value per
frozen contract.

**Both canonical answers travel per record.** `canonical_proof_state` (the JS
reader) *and* `canonical_db_proof_status` (the DB validator). When they disagree —
a reader saying `satisfied` over a row the validator calls ungrounded — that
disagreement **is** the finding. Ruling 9: 140 making a state unreachable is not a
licence to conceal it. L2 manufactures a terminal `not_satisfied` through the guard
window and requires the intent to surface it.

**Answerability is checked before the population, and there is a gate for it.**
The invariant view is empty before activation *by construction* — its own predicate
requires a stamped epoch. A reader that looked there first would count zero and call
it an answer. A11 asserts the ordering in source; A7 asserts at runtime that the
population was never even read.

---

## Two things the build changed outside itself

Both additive, both surfaced rather than absorbed:

1. **`tests/verify_source_governance.js`** — registers the 17th gate.
2. **`tools/step12/terminal_writers.js`** — `tools/build1/` added to the named
   proof-harness list. The W3 check flagged the two new harnesses as production
   utilities that write terminal statuses, which is the check **working**: a new
   directory under `tools/` is flagged until someone decides what it is. The
   decision is that these are proof harnesses of the same kind as `tools/step12/`'s.
   It was **not** widened to a blanket `tools/*`, which would remove the question
   instead of answering it. The falsification package was re-run afterwards
   (47/22/18/29, all green) because the scanner is part of its machinery.

**No frozen Release 0 artifact was modified.** Verified mechanically against the
manifest: zero of the eight pinned files appear in the diff against `f6873d7`.

---

## What is deliberately absent

The generic executor's hypothetical plugin framework · the other two frozen intents
· maintenance projections · clarification and correction flow · concealment rules ·
Property Home · work cards · any action · any money linkage · `PARTIAL` exercised by
an invented optional source (the contract declares `optional_sources: []` and says
why).

`PARTIAL` is *supported* by the executor and legitimately unreachable for this
intent's first version — genericity does not mean forcing every branch to execute in
the first capability.

## The ship gate

Release 0 production activation. Before it, this capability answers
`unavailable` — correctly, and that is a passing behaviour, not a defect. After it,
the same code becomes decisive with no flag, no fake activation path, and no
Build-1-specific switch.
