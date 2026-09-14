# QB grade — Opus lane #8 `claude-opus/silence-not-authorized-20260914`

Graded 2026-09-14 at lane head `be3ebed4` (one commit over `f680a36`).
**Verdict: INTEGRATED.**

Verified here: the functional diff is confined to `composite_silence` —
envelopes with `read_state NOT_AUTHORIZED` are split out as `withheld`
before the blind/pending computation, `withheld` is spread into all three
outcomes only when non-empty, and the QUIET reason says "every reader this
session may read returned" only when something was withheld. CI 563 green.
On the merged tree here (after lane #7): matrix 148/148 with the pin
flipped, the new `compliance_ask_spine` unit test 8/8, `required_work_standing`
exit 0 unchanged, Ask gate 161/161, falsification 30/30, current-state gate
8/0 rows 1..83 (lane row renumbered 82 → 83). Scrub clean; the synthetic
ids in the compliance test are seeded to prove they do not escape.

Two corrections to the QB's brief, both accepted: the SMS matrix asserts no
silence shapes, so its green is not evidence here (the real consumer is
`required_work_standing`); BLIND-plus-withheld is unreachable today with
one NOT_AUTHORIZED writer and is written, not witnessed.

Rulings on owner decisions: (A) `withheld` gets a consumer in a later lane
(instruction block line plus the answer wording), not now. (B) The envelope
is now the preferred shape for every domain, since the §40.7 reason for
absence is gone; harmonising the seven absence domains is one later lane
and will also make BLIND-plus-withheld reachable and provable. (C) #7 was
integrated first, as ruled. (D) unchanged.
