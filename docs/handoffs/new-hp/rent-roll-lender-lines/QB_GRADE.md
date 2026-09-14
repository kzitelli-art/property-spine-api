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

---

## Second read, 2026-09-14 evening — two findings the first grade did not carry

Added by the incoming QB thread after the lane was already integrated at
`6eb1c70`. The verdict is unchanged: **INTEGRATED**. Nothing below reverses
the first grade; both items are additions to the record, and the first is a
defect the packet's prose does not mention and a reviewer does not see by
reading the diff alone.

### 1. `isoDate` is wrong ahead of UTC — line (3b) is closed only at or behind UTC

The helper renders a `Date` with `toISOString().slice(0,10)`. node-postgres
decodes a `date` column to **local** midnight, so in any timezone ahead of
UTC the UTC calendar date is the previous day. Measured, not reasoned:

```text
TZ unset (UTC)      isoDate(pg DATE 2026-08-01)  ->  2026-08-01
TZ=Europe/Berlin    isoDate(pg DATE 2026-08-01)  ->  2026-07-31
```

That is the same off-by-one class of wrong value the line was opened to
remove. CI and the deployed host both run UTC, so the witnessed payload is
correct and **nothing observed today is wrong** — the defect is latent, not
live, and it did not warrant reversing an integration.

The helper's comment asserts the opposite: *"Uses the UTC calendar date …
a local-time slice can move them a day."* For a `date` column carrying no
time and no zone it is the **local** calendar components that are correct,
and the comment will send the next reader the wrong way. Fix is
`getFullYear/getMonth/getDate` for the `Date` branch, with a pinned test
under a non-UTC `TZ`; the string branch is already right.

Left for a scoped lane rather than patched at integration — a lender-facing
reader should not take an unproven edit, and the lane boundary is not the
QB's to cross.

### 2. The new lender figures are not askable (§40.2)

`tenancy_summary` is consumed only by `rent_roll_canonical.js`. No Ask Spine
standing read carries it, so the two new buckets and
`claimed_rent_unverified` are readable on the screen and not through the
conversational reader. The underlying fact stays reachable as
`evidence_state = uncorroborated`, so no domain regressed and the reader gate
is correctly green — but a lender-facing number a person can see and cannot
ask for is the §40.2 asymmetry one altitude above where the gate looks.
Recorded for the next planning pass, not charged to this lane, which was
scoped to a reader.

### Also checked, and clean

- The summary balances **structurally**, not by fixture: `tenancyState`
  returns exactly one of six values and all six are counted.
- The new state's predicate is **ordering-safe**: `activation_pending`
  returns before it, so the 12 rows sharing the reason code cannot be
  reclassified. The lane's 104-vs-92 reasoning holds independent of the
  fixture.
- One correction to the lane's reasoning, not its behaviour: given the
  earlier `current_lease_position` return, `evidenceState` cannot reach a
  `disagrees` branch at that point, so the `uncorroborated` conjunct is
  **structurally implied** rather than doing the excluding work its comment
  claims. Defensive and harmless; the stated rationale is overstated.
- The consumer sweep was re-run independently across the whole repo **and the
  pinned app**. Complete. The app at `b0be9f4` holds no consumer of
  `tenancy_state`; its `_rrTruthCategory` is a label matcher on the forward
  horizon surface and falls back to the conservative bucket.
- `current_rent_roll_reconciliation.db.js` is **117 added, 0 removed**, so no
  existing assertion could have been altered.
- Scrub re-run over all five committed artefacts: clean.
