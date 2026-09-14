# QB grade — Opus lane #4 `claude-opus/debt-vocabulary-20260914`

Graded 2026-09-14 at lane head `09e54623`, one commit over board `169175d`.
Verdicts formed from the diff and from running the gates on the merged board
tree here; CI read from this side.

**Verdict: INTEGRATED.** One product file, one constant, exactly as scoped:
`git diff 169175d..09e54623 -- src/` touches only `DEBT_TERMS` in
`src/agent/ask_spine_answer.js`. The maturity verb is bound to a debt noun so
"when does the lease mature" stays tenancy's, and that binding is asserted in
a class-1 unit test registered in `verify_all.sh`, not left to a comment.

## Verified here, on the merged board tree

| check | result |
|---|---|
| `tests/unit/debt_vocabulary_subject.test.js` | 22/22 · exit 0 (gained · unchanged · not stolen · composition guard) |
| `gate_ask_spine_readers.js` | 161/161 · exit 0; nine `debt is reached by` lines all `ok`; 14 domains, 8 registered, 6 pending |
| `scenarios/ask_spine_reader_gate_falsification.js` | red 8 ways and green again · exit 0 · tree byte-identical afterwards |
| `gate_current_state.js` | 8/0 · rows 1..78 contiguous |
| `verify_source_governance.js`, run bare | `✓ PASS — all 56 source-governance gates exited 0`, `PARENT EXIT 0`, process exit 0 read explicitly |
| CI at `09e54623` | run 552, job `104020058050`, **success**; `ALL REQUIRED ASSERTIONS PASSED` · `operator app: matched at b0be9f46…` · zero `SKIPPED`, no `NOT RUN`, no `── … FAIL` line. The new unit step and the governance step run early in `verify_all.sh` and sit outside the log window either side could fetch; the run is green and both were executed here bare |
| committed evidence | scrubbed clean: no UUIDs, tokens, phones, hostnames, scratch paths or database names in the added lines |

## Claims graded

| claim | grade | evidence |
|---|---|---|
| First red through the gate: 161 run · 158 passed · 3 failed, each naming `work` | CONFIRMED | `witness/first_red.txt`, and the three sentences do fail against the board's constant by reading it |
| Repair is morphology bound to a debt noun, not a sentence table | CONFIRMED | the regex as committed: `(?:loan\|debt\|mortgage)s?\s+matur(…)` and `matur(…)\s+(?:date\s+)?(?:of\|on)\s+(?:the\s+\|our\s+\|its\s+)?(?:loan\|debt\|mortgage)`; the packet's paraphrase dropped a `\s+` that the source has |
| No sentence stolen from another domain; composition guard survives | CONFIRMED | unit test groups C and D, 22/22 here |
| "The assignment's premise was wrong in four of six cases" | REJECTED as worded, and it does not matter | the assignment named three sentences as broken (Opus's own finding) and asked for at least three more as `reached_by` additions, listing four examples. The four examples already reached debt, which the witness shows honestly. Row 78 is worded to match; nothing else needs correcting |
| Three DB proofs exit 1 identically on head and baseline with zero assertion failures | CONFIRMED as stated, not re-run here | they need Postgres; CI 552 supplies it and is green |
| Nearest non-DB regressions green, including the 157-sentence SMS matrix | PLAUSIBLE | reported; not re-run here beyond the gates above |

## Rulings on the packet's owner decisions (QB, 2026-09-14)

- **A. Correct the note.** Done in row 78 at integration (above). No other
  board text claimed six.
- **B. Widen further (LTV, rate cap, covenant, a proximity rule)?** Not now.
  The two real gaps are closed and the vocabulary is no longer narrow by
  accident. Further widening waits for questions an asset manager actually
  asks, recorded from use, not invented; "covenant" in particular may not be
  debt's. Kameron's call when that list exists.
- **C. Entitlement on debt.** Two different things. Single-domain module
  entitlement is enforced in the gather (`subject === "debt" &&
  allowed_modules.includes("asset_management")`) by reading the composer;
  whether a proof asserts the unentitled path per registered domain is the
  next harness lane (Opus #5), proof-only. Cross-domain composition
  authorization stays declared unsolved, by design, until the first
  genuinely cross-domain answer is built (§40.8).
