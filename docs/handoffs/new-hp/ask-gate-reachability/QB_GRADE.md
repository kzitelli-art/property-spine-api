# QB grade — Opus lane #3 `claude-opus/ask-gate-reachability-20260914`

Graded 2026-09-14 at lane head `3485fdb6`, one commit over board `7dbfd5a`.
Every verdict below was formed by reading the diff and running the gates on
the merged board tree here, plus the CI log read from this side (Opus's
container could not fetch the raw log; it said so rather than quoting a line
it had not read, which is the right call).

**Verdict: INTEGRATED.** Harness only, exactly as assigned: `git diff
7dbfd5a..3485fdb6 -- src/ migrations/ server.js` is empty. The gate now
proves that a `registered` domain is reachable by a question the live
subject router actually yields, not merely that an assignment exists in
source. The first red is witnessed on the exact dead-branch shape row 76 had
to correct, and the falsification scenario now goes red on it.

## Verified here, on the merged board tree

| check | result |
|---|---|
| `gate_ask_spine_readers.js` | 154 run · 154 passed · 0 failed · exit 0; 14 domains, 8 registered, 6 pending; sixteen `is reached by` lines, two per registered domain, all `ok` |
| `scenarios/ask_spine_reader_gate_falsification.js` | 30/30 · exit 0 · "red 8 ways and green again"; the tree is byte-identical afterwards |
| `gate_current_state.js` | 8/0 · exit 0 · rows 1..77 contiguous |
| `verify_source_governance.js`, run bare | `✓ PASS — all 56 source-governance gates exited 0`, process exit 0, read explicitly, not through a pipe |
| CI at `3485fdb6` | run 550, job `104009040334`, **success**; `ALL REQUIRED ASSERTIONS PASSED` · `operator app: matched at b0be9f46…` · no `SKIPPED`, no `NOT RUN`, no `── … FAIL` line. The governance step line itself sits earlier than the log window either side could fetch (Opus said so; the same was true from here). Run 547 on the previous lane proved the suite goes red when that scenario fails, so a green run is evidence the step passed, and the bare local run above is the direct reading |
| committed evidence | scrubbed clean: no UUIDs, tokens, phones, hostnames, scratch paths or database names in the added lines |

## Claims graded

| claim | grade | evidence |
|---|---|---|
| First red: the unchanged gate passes a registered domain whose branch no subject reaches | CONFIRMED | `witness/dead_branch.first_red.txt` quotes the gate's own `115/115` and `GATE EXIT = 0` on the mutated tree; the mutation is the exact shape of `aafe963`'s branch |
| Detector calls the live `questionSubject`, never string-matches the router | CONFIRMED | `loadQuestionSubject()` requires the composer lazily and calls the exported function; a load failure is a named assertion failure |
| Guard extraction is static and fails safe | CONFIRMED with the stated limit | nearest preceding `if (subject === …)`; an assignment under no guard, or a guard written as a switch or lookup, reports as undeclared rather than passing. Six self-tests, including the comment-only guard |
| All eight registered domains reach; none moved to pending; nothing in the composer changed to make that true | CONFIRMED | sixteen `ok … is reached by` lines here; product diff empty |
| Counts 115 → 154 assertions, rungs unchanged | CONFIRMED | gate output here |
| Falsification 6 → 8 mutations, 30/30 | CONFIRMED | run here |
| Gate no longer dies when a standing read is deleted | CONFIRMED | lazy guarded loader; the scenario's delete mutation now reports on the assertion that names the file |

## Recorded, not blocking

- **`reached_by` is a declared sample, written by the same hand as the
  guard.** Opus says this itself (weakness a). The debt sentence was chosen
  to fit the router's literal vocabulary, and Opus recorded the gap rather
  than widening the router from a harness lane. That is the correct
  discipline; the gap is a product finding, below.
- **The extractor slices the condition to the first `{` after the `if`.** A
  condition containing an object literal would truncate. No such guard
  exists today; the self-tests do not cover it. Fine as a known edge.
- **Reaching a branch is not an entitled answer, and not a correct
  projection.** Row 76's note stands: `prospect_match` through the composer
  is only ever the term-less refusal. This gate cannot tell a reachable
  domain that answers nothing from one that answers well; it was never
  asked to.

## Rulings on the packet's owner decisions (QB, 2026-09-14)

1. **Debt vocabulary gap.** A product defect of the class this gate exists to
   find: "when does the loan mature", "when does the debt mature" and "what
   is the outstanding principal" route to `work`, because `DEBT_TERMS`
   matches only the literal forms `loan maturity`, `maturity date` and
   `principal balance`. Nothing in the router's comments says the narrow
   vocabulary is deliberate. **Ruling: widen it in a small product lane
   (Opus #4), first red through the gate itself** — add those three
   sentences to debt's `reached_by`, watch the gate go red, then widen the
   regex with morphology (`matur(?:e|es|ed|ity)`, `outstanding principal`)
   and controls that non-debt sentences keep their subjects. Not before the
   15 Sept walkthrough; the board is a candidate and the demo runs on
   production.
2. **Gate-dies-on-import sweep.** Accepted as a bounded harness item for a
   later Opus lane: list every gate under `tests/gates/` that requires
   product code at load, and give each the same lazy guarded shape or a
   reason it needs none. Not before the 15 Sept walkthrough.
