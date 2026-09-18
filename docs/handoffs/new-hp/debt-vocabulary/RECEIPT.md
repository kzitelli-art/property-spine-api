# Debt questions an operator actually types now reach the Debt reader

Lane `claude-opus/debt-vocabulary-20260914`, over board `169175da`.
App pin `b0be9f4` unchanged. One product file, one constant.

## What was wrong

`DEBT_TERMS` in `src/agent/ask_spine_answer.js` held only the literal forms
`loan maturity`, `maturity date` and `principal balance`. Three sentences a
lender-facing asset manager types without thinking fell through every named
domain and landed on `work`:

```
when does the loan mature          → work
when does the debt mature          → work
what is the outstanding principal  → work
```

Debt was registered, gathered, gate-green under the reachability detector's
two declared sentences — and unreachable by the question actually asked.

## What the first red actually showed — and a correction to the assignment

The assignment named six sentences as failing. **Four of them already
reached `debt` on the board and needed no change**: `what do we owe on the
mortgage`, `who is the lender`, `what is the interest rate on the loan`,
`is there an extension option`. `mortgage`, `lender`, `interest rate` and
`extension option` were already in the constant. `when does the mortgage
mature` also already worked, because `mortgage` matches on its own.

So the real defect was narrower than reported: **two morphological gaps**,
not six missing sentences. Reporting it as six would have credited this lane
with four fixes it did not make.

First red: `witness/first_red.txt` — nine declared sentences, **161 run ·
158 passed · 3 failed · GATE EXIT = 1**, each failure naming the produced
subject:

```
FAIL  debt is reached by "when does the loan mature"
        questionSubject produced "work", but the branch is guarded by
        ["debt"] — nothing an operator types this way reaches debt.
```

The witness also records the produced subject for all eleven sentences
tested, so the four that already worked are visible as already working.

## The correction

Morphology, not a sentence table. Added to `DEBT_TERMS`:

| added | catches |
|---|---|
| `(?:loan\|debt\|mortgage)s?\s+matur(?:e\|es\|ed\|ing\|ity)` | "when does the loan mature", "when does the debt mature" |
| `matur(?:e\|es\|ed\|ing\|ity)\s+(?:date\s+)?(?:of\|on)\s+(?:the\|our\|its\s+)?(?:loan\|debt\|mortgage)` | "what is the maturity of the loan" |
| `outstanding principal` | "what is the outstanding principal" |
| `principal (?:balance\|outstanding)` | "what is the principal outstanding" (`principal balance` was already there and is preserved) |

**The maturity verb is bound to a debt noun on purpose.** The obvious
widening — a bare `matur(?:e|es|ed|ity)` — steals `when does the lease
mature`, which is tenancy's. A lease maturing is an occupancy fact; answering
it from the Debt reader would be a confident wrong answer about the wrong
instrument (§5).

No other `TERMS` constant was touched. The order of checks in
`questionSubject` is unchanged. No schema, no deployment, no production read.

## Controls — a widening is only correct if it steals nothing

`tests/unit/debt_vocabulary_subject.test.js` (class 1, registered in
`verify_all.sh`) — **22/22**. Three groups:

- **gained** — the two morphological gaps, plus inflections nobody
  enumerated (`when did the loan matured`, `what is the maturity of the loan`),
  which is the evidence that this is morphology and not a list;
- **unchanged** — the six debt sentences that already worked;
- **not stolen** — `when does the lease mature` → `tenancy`,
  `what work is outstanding` → `work`, `which work orders are open` → `work`,
  `what is the rent roll` → `tenancy`, `how many beds are open` → `tenancy`,
  `are our licenses current` → `compliance`, `what is the water bill` →
  `utility`, `who holds common equity` → `equity`.

Plus one the assignment did not ask for and should have:
`how many beds are open, and when does the loan mature` →
**`composition_unavailable`**. A wider debt vocabulary must not let debt *win*
a two-domain sentence; the §40.8 composition guard must still see both and
refuse. It does.

The gate cannot check theft — it checks that declared sentences arrive, not
that undeclared ones stay away. That half is this file's job, which is why
it exists rather than being folded into the gate.

## Proof

| rung | result |
|---|---|
| Ask Spine reader gate, bare | **161 run · 161 passed · 0 failed · EXIT 0** · 14 domains / 8 registered / 6 pending / 0 waived |
| reachability falsification | **30/30 · EXIT 0** — "the gate goes red 8 ways and green again" |
| `node tests/verify_source_governance.js; echo EXIT=$?` | `✓ PASS — all 56 source-governance gates exited 0` · `PARENT EXIT 0` · **EXIT=0** |
| debt vocabulary controls | **22/22 · EXIT 0** |

Every gate run bare, never through a pipe: a pipeline's exit status is the
last stage's, so a real `1` never reaches the reader.

## Nearest regressions

Found by grep, not by guess — `grep -rln "questionSubject" tests/` and
`grep -rln "ask_spine_answer\|/ask\b\|answerQuestion" tests/`.

Every non-DB test that calls `questionSubject` or the composer, run at head:

```
EXIT=0  ask_spine_answer.test.js            EXIT=0  tenancy_ask_spine.test.js
EXIT=0  contracted_service_ask_spine.test.js EXIT=0  economics_ask_spine.test.js
EXIT=0  tour_schedule_ask_spine.test.js      EXIT=0  leasing_knowledge.test.js
EXIT=0  application_terms_ask.test.js        EXIT=0  required_work_standing.test.js
EXIT=0  terms_attribution_model_boundary.test.js
EXIT=0  skyline_ask_spine_sms_matrix.test.js   157 run · 157 passed · 0 failed
EXIT=0  personal_attention_convergence.test.js  29 run ·  29 passed · 0 failed
```

`skyline_ask_spine_sms_matrix` is the load-bearing one here: 157 routed
sentences across every domain, green at head.

Three exited 1 — `debt_ask_spine`, `equity_ask_spine`, `utility_ask_spine`.
**Not mine, and measured rather than assumed:** all three exit 1 identically
on a clean `169175da` checkout, with **zero assertion failures on both sides**
(they die on the database connection before asserting). They need Postgres;
CI runs them with it. `tests/e2e/leasing_ask_spine.e2e.js` needs a running
server and is likewise left to CI.

## What this would miss

- **The declared set is still a sample.** Nine sentences reach debt. The
  gate proves those nine arrive, never that the next phrasing an asset
  manager invents does. `what is our LTV`, `when is the rate cap up`,
  `are we in covenant` were not tested and are not claimed.
- **Reaching the reader is not an entitled answer.** `asset_management`
  module entitlement on debt is still unevaluated here, as it was in the
  reachability lane.
- **Retrieval only.** Debt's declared capability class is unchanged:
  retrieval on governed history. "Why did debt service increase" is not
  promised and did not ship (§40.10).
- **The bound maturity pattern is positional.** It wants the debt noun
  adjacent to the verb or joined by `of`/`on`. "When does the loan we took
  out in 2019 mature" does not match. Widening that safely needs a
  proximity rule, not a longer alternation, and is not attempted here.
