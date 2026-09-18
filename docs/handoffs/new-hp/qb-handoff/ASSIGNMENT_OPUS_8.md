ASSIGNMENT OPUS #8 — a reader you may not read is not a reader that did not return (§40.7)

Lane: claude-opus/silence-not-authorized-20260914, branched from board
claude/board-20260914 at f680a36. App pin b0be9f4 unchanged. Product
change allowed in ONE place: the composite_silence computation in
src/agent/ask_spine_answer.js (the `blind` filter and, if needed, the
`pending` filter beside it). No schema, no deployment, no production read.
Push only to your lane. Run AFTER Opus #7 if both are queued; #7 matters
more before the 15 Sept walkthrough.

Your own FOUND A from lane #6, ruled a product defect: composite_silence
classifies every fact whose read_state !== "OK" as BLIND, so an unentitled
session with leasing_person's NOT_AUTHORIZED envelope is told "at least one
required reader did not return, so silence cannot mean health" about a
property where nothing is unknown. Entitlement is not silence. The four
silences (NOT_ESTABLISHED, READ_FAILED, READ_TIMED_OUT, QUIET) are about the
property and Spine; NOT_AUTHORIZED is about the caller.

Build, red first:

1. FIRST RED is already pinned on the board: the entitlement matrix's
   "FOUND (open): that envelope still makes composite_silence read BLIND"
   block. Run it bare at the board sha and quote it.

2. THE CORRECTION. In composite_silence, a fact with read_state
   "NOT_AUTHORIZED" is neither blind nor pending: it is excluded from the
   readers whose return decides health, and reported separately as
   `withheld: [{ domain, reason: "not_authorized" }]` so the answer can say
   "Spine did not read X for you" without claiming the property is
   unreadable. QUIET stays computable only when every REQUIRED reader
   returned; a withheld reader is not required for this caller.

3. FLIP THE PIN, DO NOT DELETE IT. The three FOUND assertions in the matrix
   proof become the positive wall: the envelope exists; composite_silence is
   not BLIND because of it; the domain appears under `withheld`. Then the
   whole 8 × 6 matrix must still pass, and the compliance row (absence)
   must be unchanged by this — absence and withheld are different facts and
   both must read as not-a-silence.

4. Regressions: skyline_ask_spine_sms_matrix (it asserts composite_silence
   shapes; list every assertion you had to change and why), ask_spine_answer,
   personal_attention_convergence, leasing_ask_spine (CI), the entitlement
   matrix, reachability gate and falsification, governance bare with the
   exit code read.

5. Receipt under docs/handoffs/new-hp/silence-not-authorized/RECEIPT.md,
   one CURRENT_STATE row (next contiguous number — check the board head
   first; rows were added out of lane order today), CI at your head.

Also, in this lane: a compliance projection-shape unit test does not exist
(the QB named one that was never there). Add tests/unit/compliance_ask_spine
.test.js in the shape of debt's, asserting the compliance projection's
envelope fields and that no record id escapes, registered in verify_all.sh.

Rules unchanged: synthetic data only; scrub every committed artefact; commit
trailers as before; no model identifiers in repo artefacts.

RETURN PACKET, same template: lane head sha · CI run and conclusion · the
pin red then flipped, quoted · the matrix unchanged elsewhere · SMS matrix
assertions changed and why · FOUND items you did not fix · OWNER DECISIONS
you need.
