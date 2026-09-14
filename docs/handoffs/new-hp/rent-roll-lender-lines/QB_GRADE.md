# QB grade — Opus lane #7 `claude-opus/rent-roll-lender-lines-20260914`

Graded 2026-09-14 at lane head `371a460a` (two commits over `bf99e5c`).
**Verdict: INTEGRATED.** The three lender lines from row 80 are closed.

Verified here: the functional diff is an ISO-date helper used for both
contested-claim dates; a sixth tenancy value `occupied_terms_not_established`
assigned in `dated_positions.js` when the accepted claim says occupied and
evidence is uncorroborated, with the header's axis list corrected to six;
`tenancy_summary` gains that value and `activation_pending` so it balances;
`claimed_rent` projected per row from the accepted proposal's normalized
rent (null when absent, never 0) and `totals.claimed_rent_unverified` beside
trusted rent, entering no other total; the institutional row label
"Occupied — terms not established". The occupancy denominator is untouched.
CI 560 green at the head after CI 559 caught two consumers of the old value
in `tests/proofs/` that the first sweep missed; Opus recorded that as its
own error against the repo's "a count is a claim about a search" rule.
Merged three-way from base `bf99e5c`: the compliance guard from lane #6
survives (checked by reading the merged file). On the merged tree here:
current-state gate 8/0 rows 1..82 (lane row renumbered 81 → 82), matrix
143/143, Ask gate 161/161, falsification 30/30. The DB-backed rent roll
proofs ran in CI 560; not re-run here.

Recorded: `skyline_rent_roll_model` and `rent_roll_canonical_proof` read
32 passed / 6 failed on both baseline and lane in Opus's local runtime
(identical, environmental); green in CI. The distinct-value route was taken
with all three obligations discharged (reason in receipt, header updated,
whole-repo consumer sweep). Acceptable on the per-row lender label argument.
