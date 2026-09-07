# Occupancy meaning and presentation — Fable, 2026-09-07

Return to QB task 01a076e5-512c-70c3-a237-e8ca01c528f0. Evidence branch
`claude/occupancy-meaning-evidence-20260907`, cut from API `edceeb5`
(`codex/claim-relay-20260907`), app read at `8d1da84`. Isolated worktree; no
merge, no rebase; no product file edited. No space hold, space retirement,
status, formula or dashboard.

```text
. run1/env_all.sh        # nonce-owned DB spine_proof_<nonce>, ledger 192, no pending DDL
node run1/multi.js '[["occupancy measures","tests/proofs/occupancy_measures_under_holds.db.js"],
                     ["hold closeout","tests/proofs/hold_vs_inventory_closeout.db.js"]]'
  → PASS  occupancy measures   30 passed, 0 failed
  → PASS  hold closeout        34 passed, 0 failed   (assertions corrected, see §5)
node tests/e2e/proof_boundary.js cleanup   → owned database dropped
```

Fixture (direct rows, synthetic): one bed property, eight positions. 301
Room1 occupied (active lease 850), Room2 vacant. 302 Room1 occupied (900),
Room2 vacant. 303 Room1 **contested** (two overlapping active leases), Room2
**unresolved** (source row says occupied, Spine holds no lease). 304 both
vacant. No July, Skyline or private data; zero actual-source confirmations;
no provider call left the process; **no browser claim** — screen labels
below are read from `index.html` at 8d1da84 and are a source rung.

## 1. Each measure, its set, and where a person sees it

| Owner | Set it measures | Baseline on this fixture | Visible consumer at 8d1da84 (source rung) |
|---|---|---|---|
| **Occupancy primitive** `leasing_occupancy_facts.occupancyByBasis` | spaces of non-retired units with an active lease ÷ spaces, excluding labels matching `model|down|offline` | 3 of 8 = 37.5% (the contested bed has a lease, so it counts) | Leasing desk and Management desk `headline.occupancy` → "37.5% occupied", note "N of M beds carry an active lease — lease-based, not a confirmed-status walk". The Management home's hero uses this only as a **fallback** (`dailyCurrentOccupancy`) |
| **Condition facts** `/operator/leasing/condition` | the primitive, with `basis`, `occupied`, `rentable`, `excluded` stated | 37.5% | `leasingConditionStrip` inside `leasingPageHero`, which the authenticated operating home does not paint (owner correction at 21497). **No visible signed-in consumer today** |
| **Canonical rent roll** `rent_roll_canonical.totals.confirmed_contractual_occupancy` | `contractually_occupied` rows ÷ (inventory − `is_down` rows − contested rows); `unresolved` stays in the denominator | 2 of 7 = 28.57% | Institutional rent roll totals table: "Confirmed contractual occupancy: 2 of 7" beside "Total canonical rentable positions: 8" and "Positions down: 0". The denominator's basis (leasable minus contested) is **not stated** on the screen or in the CSV |
| **Legacy snapshot** `/operator/rent-roll` `summary` (`summarizeRows`) | published source rows by their **status word** (`current|occupied|notice|commercial` = occupied) ÷ current rows; `leasable_occupancy_pct` subtracts `model|down` status rows | 4 of 8 = 50% (the unresolved row's file status is "current") | **Management home "Current occupancy" cell**, computed in the browser by `rentRollStats()` over these rows, sub-label "N of M occupied", and overridden by `summary.residential_inventory / residential_occupied` when `reconciled` |
| **Standing / Ask** `readTenancyStanding.position` | Rent Roll buckets: `occupied`, `open`, `needs_review`, `not_established` — counts, no percentage | 3 occupied, 4 open, 1 needs review of 8 | Ask Spine grounding (service rung here; Ask door returned `unavailable` under the sentinel) |
| **Availability** `availability_read.headline` | marketing states — no percentage by design ("No percentage occupied" is written into the Market & Pricing renderer) | 5 marketable, 1 contested, 0 blocked | Market & Pricing workspace, "positions marketable now" |

Three percentages for one property at one date, each a different set: 28.57,
37.5, 50. Two of them are shown to an operator under labels that do not name
the set: "Current occupancy" (Management home) and "Confirmed contractual
occupancy: N of D" (institutional totals). The desks' "37.5% occupied" is the
one label that carries its basis in its note.

## 2. Under holds — numerator and denominator membership

| State | Canonical `occupied / denominator = pct`, `down` | Institutional label | Primitive, desks | Legacy | Standing |
|---|---|---|---|---|---|
| baseline | 2 / 7 = 28.57, down 0 | "2 of 7" | 3 of 8, 37.5% | 4 of 8, 50% | 3 / 4 / 1 |
| down 301 (Room1 has an operative lease) | **2 / 5 = 40**, down 2 | **"2 of 5"** | unchanged | unchanged | unchanged |
| down 301+302+303 | **2 / 1 = 200**, down 6 | **"2 of 1"** | unchanged | unchanged | unchanged |
| all four units down | **2 / −1 = −200**, down 8 | **"2 of −1"** | unchanged (37.5% with the whole building down) | unchanged | unchanged |
| all resolved | 2 / 7 = 28.57 | "2 of 7" | 3 of 8 | 4 of 8 | 3 / 4 / 1 |

Every owner returned exactly its baseline after resolution, and no lease row
changed at any point. On the availability row for 301 Room1 under the hold:
`marketing_state: down`, `tenancy_state: contractually_occupied`, `lease_id`
present. **A hold did not become evidence of a tenancy change** anywhere.

## 3. First actual defects

**Defect A — canonical occupancy ratio: numerator and denominator draw from
different sets.** `rent_roll_canonical.js:72–73` counts `occupied` over all
rows including `is_down` rows; `:101–103` builds the denominator as
`inventory − down − contested`, where `contested.length` also counts down
rows. A hold on a unit with an operative lease therefore raises the ratio
(28.57% → 40%), holding every occupied and contested unit yields 200%, and
an all-down building yields a denominator of −1 and −200%, rendered on the
institutional screen and CSV as "Confirmed contractual occupancy: 2 of −1".
The `pct` guard (`occupancy_denominator ? … : null`) never reaches null
because the denominator goes negative rather than zero. Three of the four
requested properties fail here: membership, ratio above 100%, honest zero.

**Defect B — one position, three meanings.** 303 Room2 (source says occupied,
Spine holds no lease) is `unresolved` in the canonical rent roll (out of the
numerator, in the denominator), **`occupied`** in the unit Rent Roll bucket
and in standing/Ask (`occupied: 3`), and **`marketable_now`** in availability
and therefore in the application selector. The Rent Roll and Ask tell an
operator a bed is occupied while Market & Pricing offers it. Caveat on
reach: the current confirmation writer creates a lease when it confirms an
occupied row, so this shape needs a promotion that did not pass through
that writer (old writer, direct status write) — the same residue class as
the identity receipts. It is a real shape in retained data, not a new-import
shape.

**Not a defect, but a labelling gap.** The 37.5 / 28.57 / 50 spread is three
legitimate measures. Two of their labels hide the set.

## 4. Smallest existing-owner correction (proposed, not implemented)

**For A**, in `rent_roll_canonical.js`, the owner of the figure: derive the
occupancy ratio from one set. Either count `occupied` over rows that are in
the denominator (`!is_down && not contested`), or subtract `contested` only
where not already subtracted as `down`. Then `pct` reaches its null branch
at zero and the institutional line reads "0 of 0" with `excluded_from_denominator`
explaining why. No new formula: the same fraction, one population. The
institutional reshaper (`rent_roll_institutional.js`) and CSV follow with no
change. Counterexample: an operator who wants "occupied beds over leasable
beds" as a **stress** measure would lose the 40% reading; but that reading
was never labelled as such, and the 200% and −200% outputs show it was not a
designed measure.

**For B**, the owner is `dated_positions.js` classification: `tenancyState`
returns `unresolved` for an occupied claim without a lease while
`rentRollBucketOf` returns `occupied` for the same claim and `marketingState`
falls through to `marketable_now` because it consults `p.lease` only. The
smallest correction is to make availability read the same `tenancy_state`
the Rent Roll reads, and hold `unresolved` out of `marketable_now` with a
named reason — the same shape as the `occupancy_unknown` guard already in
`marketingState`. Counterexample: a bed whose lease was executed outside Spine
and is truly occupied would then stop being offered; that is the correct
direction, since offering an occupied bed is the worse error.

**For the labels**, the owners are the renderers: the Management home
"Current occupancy" cell should say which population (published source rows
by status word, or the desk primitive when it falls back), and the
institutional line should say "of N leasable, contested excluded". Copy
only; no formula, no widget.

## 5. The closeout proof, corrected

`hold_vs_inventory_closeout.db.js` on this branch: the bucket assertion now
compares against the recorded pre-hold values (placeholder bucket, Room1
bucket, standing open), not against itself; the resolve assertion now
compares the full consumer and financial payloads, matching its wording.
Its retirement note records that on `edceeb5` the occupancy primitive
counted 2 rentable while the unit was retired — QB's predicate is applied —
where `139e696` counted 5. 34/34. The 53d3117 evidence is untouched.

## Rungs

HTTP: condition, leasing and management dashboards (operator key),
rent-roll/canonical, rent-roll/institutional, legacy rent-roll,
availability-canonical, rent-roll/units, ask-spine/ask, down and resolve,
wrong-key 401, maintenance-only 403. Services: `occupancyByBasis`,
`readTenancyStanding`. Screen labels: source read of `index.html` at
8d1da84, no browser run. Ask `unavailable` is not a grounded answer.

## Strongest surviving counterexample

That Defect A is a presentation problem only: the canonical read exposes
`excluded_from_denominator: { down, contested }` beside the ratio, so a
reader of the payload can reconstruct the sets. The reply is that the
institutional screen and CSV print "2 of −1" without that object, and a
negative denominator is not a presentation choice.
