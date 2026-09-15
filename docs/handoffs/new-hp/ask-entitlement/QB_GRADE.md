# QB grade — Opus lane #5 `claude-opus/ask-entitlement-proof-20260914`

Graded 2026-09-14 at lane head `0f66c663`, one commit over board `0ae2602`.
Verdicts formed from the diff, from reading the composer, and from running
the proof and gates on the merged board tree here; CI read from this side.

**Verdict: INTEGRATED.** Proof only, as assigned: the diff under `src/`,
`migrations/` and `server.js` is empty. The matrix is delivered as a table,
every unentitled cell is absence or refusal, and the one gap is declared in
the registry and pinned by the proof rather than hidden by it.

## Verified here, on the merged board tree

| check | result |
|---|---|
| `tests/proofs/ask_spine_entitlement_matrix.test.js` | exit 0; the 8 × 6 table prints; compliance row reads `READ_FAILED` in its four unentitled cells, every other unentitled cell `absent` |
| `gate_ask_spine_readers.js` | 161/161 · exit 0 (counts unchanged; eight `entitled_by` declarations added) |
| `scenarios/ask_spine_reader_gate_falsification.js` | 30/30 · exit 0; the `tenancy` anchor preserved by placing the declaration after the state line |
| `gate_current_state.js` | 8/0 · rows 1..79 contiguous |
| `verify_source_governance.js`, run bare | `✓ PASS — all 56 source-governance gates exited 0`, `PARENT EXIT 0`, process exit 0 read explicitly |
| CI at `0f66c663` | run 554, job `104044346215`, **success**; the new step runs early in `verify_all.sh` and sits outside the fetchable log window, as with lanes #3 and #4 |
| committed evidence | scrubbed clean |

## The finding, confirmed by reading the composer

`gatherFacts` guards utility, debt and equity on `asset_management` and
guards the leasing branches on `leasing` or `management`; the compliance
branch is `if (subject === "compliance") {` with no module check. The
`answer()` door refuses compliance, utility, contracted service, debt and
equity without `asset_management` before gathering, so through the door
nothing leaks. Opus measured both layers and stated the blast radius as
bounded; that is CONFIRMED. The module's own comment says the inner guard
is kept because `gatherFacts` is exported and independently callable, which
is exactly the rule the compliance branch breaks.

## Claims graded

| claim | grade | evidence |
|---|---|---|
| 47 of 48 cells behave; every unentitled cell is absent; none produced a fact | CONFIRMED | proof output here; the hostile db throws on every use, so an entitled branch shows `READ_FAILED` and an unentitled one shows nothing |
| Unentitled absence is not counted by `composite_silence` | CONFIRMED | asserted per cell; the first-red witness shows the silence assertion failing beside the disclosure one when a guard is removed |
| First red: removing debt's guard turns 9 cells red, tree byte-identical after | CONFIRMED as witnessed | `witness/first_red.txt`; product diff empty |
| Declaring compliance from the door, not from `gatherFacts` | CONFIRMED, ruling B below | |
| "No database touched" deliberately not claimed as the §40.8 property | CONFIRMED | the maintenance unentitled cell queries the attention queue, which scopes by module inside its own service; asserted apart |
| Deleting the divergence declaration turns 8 cells red; fixing the composer also turns the pin red | PLAUSIBLE | reported both ways; the second direction is what Opus #6 will exercise |

## Recorded, not blocking

- **Absence versus refusal.** Seven of eight domains answer an unentitled
  session with absence; only `leasing_person` carries an explicit
  `NOT_AUTHORIZED` envelope. Both satisfy §40.8. An envelope is the more
  sayable shape for the model and for a composed answer that must explain
  why a domain is missing; the door's pre-gate already says it sayably
  today. Carried as a later harmonisation, not a defect.
- **Fact-level entitlement (§40.4)** remains unproven at any altitude; this
  proves the branch gate. Ruling C below.

## Rulings on the packet's owner decisions (QB, 2026-09-14)

- **A. The compliance guard.** Yes: product lane, one branch, Opus #6. The
  `composer_divergence` block is retired in the same commit and the matrix
  proof is the acceptance test.
- **B. Declaration source.** Confirmed: where the two layers disagree, the
  registry declares the door's contract and names the divergence. Writing
  `gatherFacts`'s behaviour into the registry would have recorded a defect
  as the contract.
- **C. Fact-level entitlement.** Stays declared, not built, until the first
  genuinely cross-domain answer is designed (§40.8 says to design it
  deliberately at that point, not before). The matrix proof is the floor
  that answer will be measured against.
- **D. Cross-domain composition.** Unchanged, unsolved by design.
