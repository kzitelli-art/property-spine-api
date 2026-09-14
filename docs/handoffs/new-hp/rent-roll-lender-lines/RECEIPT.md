# Three lender-facing lines on the canonical rent roll read

Lane `claude-opus/rent-roll-lender-lines-20260914`, over board `bf99e5c8`.
App pin `b0be9f4` unchanged. Reader only. No schema, no deployment, no
production read.

First red: `docs/handoffs/new-hp/lender-read/SKYLINE_LENDER_READ_20260914.md`
and CURRENT_STATE row 80, reproduced here the same way before anything
changed — owned nonce database (name scrubbed) at ledger 198, labelled
fixtures applied before any business action,
`current_rent_roll_reconciliation.db.js` **63 passed / 0 failed**, then
`currentRentRoll(pool, { property_id })` as of today.

## The three lines, red then green

```
                              RED (bf99e5c8)                  GREEN (this lane)
1  tenancy_summary            sum 146 of 160                  sum 160 of 160
                              DOES NOT BALANCE (missing 14)   BALANCES
2  claimed_rent_unverified    undefined                       78200 over 92 positions
   contractual_rent_trusted   26350 / 31                      26350 / 31  (unchanged)
3  tenancy_state              unresolved: 102                 occupied_terms_not_established: 92
                                                              unresolved: 10
   contested claim dates      {"start":"Sat Aug 01",          {"start":"2026-08-01",
                               "end":"Mon Jul 26"}             "end":"2027-07-26"}
```

The unit-basis "Other Shape" property balances too (3 of 3) and carries its
own `claimed_rent_unverified` — no property-specific branch exists or was
added.

## 1 · The tenancy summary balances

`tenancy_summary` gains **two** buckets, not one. `activation_pending` (14
positions — a commenced lease awaiting economic activation) was the missing
14 the board found. `occupied_terms_not_established` (92) is finding 3's
state, and it has to appear here or the summary would balance while still
calling an accepted occupancy a mystery.

## 2 · Unverified revenue has a magnitude, counted nowhere

`totals.claimed_rent_unverified` = **$78,200 over 92 positions**, beside
`contractual_rent_trusted` = **$26,350 over 31**, which is unchanged.

Sourced from the accepted claim's proposal (`basis_ref.proposal_id` →
`proposed_records.normalized_json->>'rent'`), projected onto the row as
`claimed_rent`. It mirrors `contested_claims.implicated_rent` exactly:
**visible without being counted.** Asserted, not asserted-by-assumption — the
proof recomputes the total from the proposals directly and compares, because
a total checked against itself checks nothing.

It enters nothing: every one of the 92 rows has `current_rent === null` and
`contributes_trusted_rent === false`, and the occupancy numerator is still 31.

**Null, never 0, when the source carried no rent.** Proved by removing the
rent from one already-established claim and re-reading: `claimed_rent` reads
`null`, `positions_claimed_without_rent` becomes 1,
`positions_with_claimed_rent_unverified` drops to 91, and the total drops by
exactly that claim's rent. The evidence edit is then restored and the read
re-asserted, so the section leaves the database as it found it. That edit is
to retained *evidence* after establishment already happened through the real
doors in sections A–F — it is not fixture SQL manufacturing an outcome ahead
of a business action.

## 3 · The contractual axis says what the row knows, and dates are dates

### (a) A distinct tenancy value, not a sub-object on the summary

The ruling offered two shapes: report the split beside the total
(`unresolved: { total, opening_claim_occupied, inconclusive }`), or introduce
a distinct tenancy value and discharge three obligations. **I took the
distinct value.** Why:

1. **A per-row surface needs a per-row value.** `rent_roll_institutional.js`
   labels each row for a lender. A sub-object on the summary cannot drive
   that label, so those 92 rows would have kept reading *"Unresolved
   occupancy evidence"* — the exact sentence the finding calls wrong — while
   the summary quietly said otherwise. The read would then disagree with
   itself, one altitude apart.
2. **The complaint was about a row, not a total.** The board's words:
   *"A position the operator explicitly accepted as occupied reads
   `unresolved` on the contractual axis, which to a lender means 'we do not
   know if anyone lives there'."* That is a defect in what the row says.
3. **The row already carries the distinction durably** (`basis_type:
   opening_claim_occupied`), so the axis was the one place still collapsing
   two facts §40.7 keeps apart. Deriving the split only in the summary
   would leave the collapse in place and paper over it downstream.

The cost is a vocabulary change with consumers, which is real — and is
exactly what the obligations exist to control. All three are discharged: the
header axis list below, the grep table, and this paragraph.

**The header's axis list is updated.** It listed four values while the code
yielded five; it now lists six, and says of `activation_pending` that it had
been yielded for some time while the list said four — which is how it
reached `tenancy_summary` with no bucket and fourteen positions went missing
from a lender's column. The two split values carry an explicit note that
merging them *was* the defect.

**The unit view and the standing read mirror the BUCKET axis, not this one.**
`rent_roll_unit_view.js` counts `occupied / activation_pending / open /
needs_review`, which key on `basis_type`; the proof asserts every one of the
92 still buckets as `occupied`. `tenancy_position_read.js` keys on
`evidence_state` and `interval_state`. Neither needed a change, and neither
got one.

### (a·ii) `occupied_terms_not_established`

92 positions move off `unresolved`. **`unresolved` keeps its meaning** for
the 10 genuinely unreconciled positions, and the proof asserts every one of
those 10 has `evidence_state === "unreconciled"`.

It is carried exactly as `unresolved` is: inside the occupancy denominator
(147), never vacant, reported beside in
`confirmed_contractual_occupancy.reported_beside` and in `exceptions`. The
operating bucket is untouched — those beds still read `occupied`, because
`rentRollBucketOf` keys on `basis_type`, not on this axis.

**⚠ The predicate is NOT literally `bucket_reason_code`, and that matters.**
The assignment specified rows whose `bucket_reason_code` is
`OPENING_OCCUPANCY_ACCEPTED_TERMS_UNKNOWN`. Measured on the fixture, **104**
rows carry that code but only **92** are accepted occupancies: the other
**12 are `activation_pending`** — beds holding a commenced lease, which
reach the code through a different branch. Keying on the code literally
would have reclassified 12 positions that hold a lease, destroying the
`activation_pending` bucket and **re-breaking the very balance finding 1
exists to fix**. The state is keyed instead on the same condition the code's
accepted branch uses: an accepted `occupied` claim with `uncorroborated`
evidence. The proof asserts the 12-row difference and that every one of them
is `activation_pending`, so the divergence is measured rather than assumed.

### (b) Dates

One helper, `isoDate`, used in both places. `String(date).slice(0, 10)` is
right for a string and wrong for a JS `Date`: node-postgres returns `date`
columns as Date objects and no type parser is configured, so `String(d)` was
`"Sat Aug 01 2026 …"` and the slice yielded `"Sat Aug 01"`.

**No global pg type parser** — that would change how every date in the
process is decoded, for every consumer, to fix a rendering bug in two fields.

**Witnessed over the real HTTP door** (`witness/http_dates.txt`), staff
session, owned server, no fixture path:

```
HTTP 200 GET /operator/rent-roll/canonical
  tenancy_summary : {"contractually_occupied":31,"vacant":0,
                     "occupied_terms_not_established":92,"unresolved":10,
                     "activation_pending":14,"contested":13,"total":160}
  buckets sum     : 160 of 160
  trusted         : 26350 / 31
  claimed_unverif : 78200 / 92 | without rent: 0
  FIRST CLAIM OVER THE WIRE: {"start_date":"2026-08-01","end_date":"2027-07-26"}
  claims with a non-ISO start_date: 0 of 30
```

## ⚠ My first consumer sweep was incomplete, and CI caught it

**This is the important correction in this receipt.** My first sweep ran
`grep -rn "tenancy_state" src/ server.js property-spine-app` and, for tests,
only `tests/unit/` and `tests/gates/`. It did not cover `tests/proofs/`.
I then claimed a complete consumer list. CI run 559 went red and named the
gap: `availability_uncorroborated_claim.db.js` pins the old value in two
assertions. This repo's own rule — *a count is a claim about a search;
search the whole repo, not a subfolder* — is the one I broke.

The sweep below is the corrected one, run over the whole repository:

```
grep -rn 'tenancy_state\s*===\|tenancy_state\s*!==\|\.tenancy\s*===' \
  --include=*.js --include=*.sh --include=*.html .
```

Four real consumers of the old value existed. Two were in `src/` and I found
them; **two were in `tests/proofs/` and I did not**:

| consumer | what I did |
|---|---|
| `tests/proofs/availability_uncorroborated_claim.db.js:215` | **MISSED, then updated** — pinned `tenancy === "unresolved"` for 303 Room2 |
| `tests/proofs/availability_uncorroborated_claim.db.js:239` | **MISSED, then updated** — same row through the canonical read; its sentence now says the row reads `occupied_terms_not_established`, keeping its intent (the claim supports occupancy, nothing supports an offer, no measure was forced to agree) |
| `tests/proofs/rent_roll_canonical_proof.js:25` | **updated** — a `TENANCY` vocabulary allowlist that named four values. It was already missing `activation_pending`; it now names all six |
| `tests/proofs/rent_roll_canonical_proof.js:75` | **updated** — "an imported occupied claim with no spanning lease stays unresolved, never vacant". Its subject is now the new state; both states are checked so the never-vacant guarantee still covers every row it covered before |
| `tests/proofs/skyline_rent_roll_model.db.js:225` | **updated** — `vacantPos` is the complement of `contractually_occupied` and is summed against it to 160; the new state belongs to that complement |

Verified after the fix, each on its own freshly built database: the two
flagged assertions pass, and `availability_uncorroborated_claim` reads
**14 passed / 4 failed identically on the baseline tree and this one** — the
four remaining are a local `503` on the "down accepted" door that cascades,
present on both sides and absent in CI, where that door returns 201.

## Every other consumer of `tenancy_state`, shown unaffected

`grep -rn "tenancy_state" src/ server.js property-spine-app` — the app file
and `server.js` contain none.

| consumer | what I did |
|---|---|
| `src/surfaces/rent_roll_canonical.js` `byTenancy("unresolved")` | **updated** — the summary itself |
| `src/surfaces/rent_roll_institutional.js:78` | **updated** — see below |
| `src/surfaces/rent_roll_institutional.js:76,79` (`contested`, `vacant`) | unaffected — different values |
| `src/surfaces/rent_roll_canonical.js:120,122` (denominator/numerator) | unaffected — the new state stays in the denominator and out of the numerator, as `unresolved` did |
| `src/surfaces/rent_roll_unit_view.js:132` | unaffected — passes the value through |
| `src/surfaces/availability_read.js:635` | unaffected — passes it through; its only `unresolved` strings are a comment and an `evidence_unreconciled` label |
| `src/money/pricing_decision_packet.js:130,133` | unaffected — tests `contractually_occupied` |
| `src/money/future_rent_roll_pricing_contract.js:61,98` | unaffected — tests `contractually_occupied` |
| `src/tenancy/tenancy_position_read.js:191` | unaffected — a comment; its `evidenceUnresolved` keys on `evidence_state === "inconclusive"` and its `t.unresolved` on `interval_state` |
| `src/tenancy/dated_positions.js:1016,1029,1064` | unaffected — **a different axis**: `interval_state` in the forward/interval read, not `tenancy_state` |

**`rent_roll_institutional.js` had to change, and it is the reason this grep
mattered.** Its `statusLabel` tested `tenancy_state === "unresolved"`; once
the state was split, all 92 positions stopped matching and fell through to
the final `return "Occupied"` — silently upgrading beds with no established
rent, term or legal right to plain **Occupied**, on the one surface a lender
reads. It now returns `"Occupied — terms not established"`. This is a third
file beyond the two the assignment named; it is a reader, and leaving it
would have shipped a confident wrong answer.

## Proof and regressions

| rung | result |
|---|---|
| `current_rent_roll_reconciliation.db.js` | **78 passed, 0 failed** — the original **63 unchanged**, plus 15 new in section I |
| HTTP witness over the real door | 200, dates ISO, summary balances |
| `node tests/verify_source_governance.js; echo EXIT=$?` | `✓ PASS — all 56 source-governance gates exited 0` · `PARENT EXIT 0` · **EXIT=0** |
| Ask Spine tenancy gather, SMS matrix, `ask_spine_answer`, entitlement matrix, reader gate | all EXIT 0 |
| `availability_occupancy_basis`, `tenancy_ask_spine` | EXIT 0 |

No existing assertion was changed. The count rose 63 → 78 because section I
is additive; every one of the original 63 still runs and still passes.

**`rent_roll_canonical_proof` and `rent_roll_institutional_proof` fail — and
they fail identically on the baseline.** Measured rather than assumed: each
was run on its own freshly built database from the `bf99e5c8` tree and from
this tree, and both sides give `32 passed, 6 failed` for the canonical proof
and the same `FATAL: Cannot use 'in' operator to search for 'position' in
undefined` for the institutional one. Pre-existing, not this lane's.

The three db-backed proofs were compared the same way, each on its own
freshly built database from each tree:

```
                                    BASELINE   HEAD
rent_roll_occupancy_correction.db   EXIT 1     EXIT 1
skyline_rent_roll_model.db          EXIT 0     EXIT 0
skyline_rent_roll_read.db           EXIT 2     EXIT 2
```

Identical on both sides. `skyline_rent_roll_model.db` passes; the other two
fail on the baseline exactly as they fail here — they need the establishment
this harness does not give them, and neither was changed by this lane.

## What this would miss

- **One fixture shape, twice.** Bed basis and unit basis, both synthetic.
  A property whose accepted claims carry `actual_rent` but not `rent` would
  read `claimed_rent: null`; only the `rent` key is consulted.
- **`claimed_rent` is projected, not reconciled.** It repeats what the
  source asserted. Nothing checks it against anything, and it must never be
  read as a Spine figure — which is why it is named `claimed`.
- **The institutional CSV column set is unchanged.** The new label appears in
  `statusLabel`; no column was added, so a consumer reading the CSV sees the
  new wording and no new field.
- **`positions_claimed_without_rent` is 0 on this fixture.** The branch is
  proved by editing one claim, not by a fixture that naturally contains one.
