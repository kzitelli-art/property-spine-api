# QB grade — Opus lane #6 `claude-opus/compliance-guard-20260914`

Graded 2026-09-14 at lane head `34068706`, one commit over board `571892d`.
Verdicts from the diff, from the composer's own silence rule, and from
running the proof and gates on the merged board tree here; CI read from
this side.

**Verdict: INTEGRATED, with the deviation ratified.** One condition in one
branch: the compliance gather now requires `asset_management`, matching its
four siblings. The `composer_divergence` declaration is retired in the same
commit, and the matrix pin that recorded the gap is inverted into the wall
that keeps the guard in place.

## The deviation, ratified

The assignment asked for leasing_person's inner `NOT_AUTHORIZED` envelope
and, in the same breath, for that envelope not to be counted by
`composite_silence`. Those conflict, and Opus measured it rather than
picking one: the composer's silence rule is `blind = gathered.filter(v =>
v.read_state !== "OK")`, so any envelope that is not `OK` makes the property
read BLIND for the caller. That is a §40.7 collapse of "you may not read
this" into "this did not return". Absence, which is what the four sibling
domains already do, is the correct shape until the silence rule changes.
Ratified. The assignment's instruction 2 was wrong as written; instruction
4 was the one that mattered, and Opus kept it.

## Verified here, on the merged board tree

| check | result |
|---|---|
| `tests/proofs/ask_spine_entitlement_matrix.test.js` | 143/143 · exit 0; compliance row `absent · absent · absent · absent · E READ_FAILED · E READ_FAILED`, identical to utility; the three `FOUND (open)` §40.7 assertions on leasing_person pass as pins |
| `gate_ask_spine_readers.js` | 161/161 · exit 0; 14 domains, 8 registered, 6 pending, unchanged |
| `scenarios/ask_spine_reader_gate_falsification.js` | 30/30 · exit 0; tree byte-identical afterwards |
| `gate_current_state.js` | 8/0 · rows 1..81 contiguous after the renumbering below |
| `verify_source_governance.js`, run bare | `✓ PASS — all 56 source-governance gates exited 0`, `PARENT EXIT 0`, process exit 0 read explicitly |
| CI at `34068706` | run 556, job `104075391047`, **success** |
| committed evidence | scrubbed clean: no UUIDs, tokens, phones, hostnames, scratch paths or database names in the added lines |

## Claims graded

| claim | grade | evidence |
|---|---|---|
| One condition, one place; pre-gate, siblings and reader untouched | CONFIRMED | `git diff 571892d..34068706 -- src/` is the guard plus its comment |
| The pin announced the fix (137/138, exit 1) and was inverted, not deleted | CONFIRMED | proof diff: "discloses NO compliance facts", "ABSENT, not a NOT_AUTHORIZED envelope", "does not make the property read BLIND" |
| Compliance row now identical to utility's | CONFIRMED | proof output here |
| Guard does not over-block an entitled session | CONFIRMED as stated | asserted with a synthetic reader; the door's "unavailable" under the null-model harness is the harness, identical on the baseline |
| leasing_person's envelope makes an unentitled session read BLIND | CONFIRMED | pinned as three FOUND assertions; the rule is one line in the composer |
| `compliance_ask_spine` was named as a regression target and does not exist | CONFIRMED, and the error was the QB's | the assignment named it from pattern, not from a listing. Opus ran the seven compliance unit tests that do exist and the db-backed compliance proofs ran in CI |

## Board-side edits in this merge

- Both the board and the lane added a row 80 (the board's lender read at
  `bf99e5c`, the lane's compliance guard). The lane's row is renumbered
  **81**; its text is otherwise untouched.

## Rulings on the packet's owner decisions (QB, 2026-09-14)

- **A. Absence versus envelope.** Absence, ratified above. The envelope
  becomes correct only once the silence rule stops treating
  `NOT_AUTHORIZED` as a failed read; that is the next lane's job, and a
  later harmonisation may then give every domain the envelope.
- **B. The §40.7 silence fix.** Own lane, red-first, Opus #8: exclude
  `NOT_AUTHORIZED` from `blind`, report it as `withheld`, flip the pin.
  Runs after Opus #7 (the rent roll lines matter more before the walkthrough).
- **C. The missing test.** Yes, a compliance projection-shape unit test in
  the shape of debt's; folded into Opus #8 as a small item.
- **D. Fact-level entitlement (§40.4).** Unchanged: declared, not built,
  until the first genuinely cross-domain answer is designed.
