# Hold versus inventory — close-out on the current candidate — Fable, 2026-09-07

Return to QB task 01a076e5-512c-70c3-a237-e8ca01c528f0. Evidence branch
`claude/hold-vs-inventory-evidence-20260907`, cut from API candidate
`139e696` (`codex/claim-relay-20260907`). Isolated worktree; no merge, no
rebase; no product file edited. The 8791791 proof is carried in unchanged
as `tests/proofs/existing_mixed_inventory_hold.db.js` (not rerun here; its
`.retired.length` read is corrected below, not in that file). New proof:
`tests/proofs/hold_vs_inventory_closeout.db.js`.

```text
. run1/env_all.sh        # nonce-owned DB spine_proof_<nonce>, ledger 192, no pending DDL
node run1/multi.js '[["hold closeout","tests/proofs/hold_vs_inventory_closeout.db.js"]]'
  → PASS  hold closeout   33 passed, 0 failed
node tests/e2e/proof_boundary.js cleanup   → owned database dropped
```

Source custody: the same directly-built historical fixture as 8791791
(`(whole unit)` confirmed beside Room1/Room2 on 301; Room1/Room2 on 302),
plus a real active lease on 302 Room1 at 850 (the nonzero sibling) and a
governed leasing cycle 2026-08-01..2027-07-31 so forward rent can be read.
Synthetic rows only; no July, Skyline or private originals; zero
actual-source confirmations; no provider call left the process; no browser
claim.

## 1. What ran over HTTP and what stayed a service

| Over HTTP (owned server) | Service rung |
|---|---|
| availability-canonical · leaseable-units · rent-roll/units · rent-roll/canonical · leasing/forward-rent · rent-roll/future-facts · leasing-dashboard (operator key) · ask-spine/ask · deal-setup upload/activation/read-source/activation-read/confirm/establish · units/:id/down and /down/resolve (operator key) · triage/confirm (foreign session, refused) · leaseable-units (maintenance-only seat, refused) | `readTenancyStanding` and `gatherFacts(subject: tenancy)` — the reader Ask grounds on; `occupancyByBasis` — the primitive the desks call; `retireInventoryUnits` / `reinstateInventoryUnit` — no HTTP caller exists |

The Ask door returned 200 with `outcome: unavailable` and no `grounded_on`
under the e2e sentinel. That proves no grounded answer was produced; it
proves nothing about what Ask would say. The standing counts below are the
service rung.

Consumer assertions from 8791791 reproduced on `139e696` (section 1 and 2
of the proof): placeholder offered and application-eligible at baseline;
after source correction `occupancy_unknown`, dropped from the selector,
rooms and 302 untouched, standing `PARTIALLY_ESTABLISHED` "4 of 5 … 1 do
not". Controls: wrong operator key 401, foreign-property session 403,
maintenance-only seat 403 at the leasing selector.

## 2. The financial claim, closed with actual reads

I wrote on 8791791 that "occupancy, vacancy loss and forward rent are still
computed over the phantom". That sentence was not backed by a read. Here is
what each canonical owner calculates and what it returned, before and after
the source correction, with the sibling lease as the nonzero control.

| Owner | What it calculates | Before | After correction | Changed? |
|---|---|---|---|---|
| **Inventory count** — `readTenancyStanding.position.rentable_positions`; canonical `totals.inventory` | every space of every non-retired unit | 5 / 5 | 5 / 5 | no |
| **Occupancy primitive** — `leasing_occupancy_facts.occupancyByBasis` (bed grain: spaces with an active lease ÷ spaces, excluding labels matching model/down/offline) | 1 ÷ 5 = 0.20 | 1 ÷ 5 | 1 ÷ 5 | no. It reads labels and leases only, never basis, `is_down` or retirement |
| **Leasing desk occupancy** — `/properties/:id/leasing-dashboard` `headline.occupancy` | the primitive above | 20% | 20% | no |
| **Canonical rent roll occupancy ratio** — `rent_roll_canonical.totals.confirmed_contractual_occupancy` (occupied ÷ (inventory − down − contested)) | 1 of 5 = 20%; placeholder `vacant` | 1 of 5 = 20%; placeholder **`unresolved`**, reported beside as `unresolved_positions: 1` | ratio no; classification yes. `unresolved` stays in the denominator |
| **Contractual rent sum** — `totals.contractual_rent_trusted` (rent of contractually occupied positions with available economics) | 850 from 1 position | 850 from 1 position | no |
| **Forward rent** — `/operator/leasing/forward-rent` (`forward_leasing.positions` = every space of every live unit in the cycle; `committed_rent.contractual` from cycle leases and tracker claims; `open_bed_assumption` from stated asking rents) | positions 5, remaining 4, contractual `NOT_ESTABLISHED` (0), assumptions 0 lines | identical | no. The placeholder is one of the 4 "remaining" open beds both times |
| **Future facts** — `/operator/rent-roll/future-facts?as_of=2026-12-01` (`totals.positions`, `open_or_uncovered`, `monthly_contractual_rent_known`) | 5 / 4 / 0 | 5 / 4 / 0 | no |
| **Asking-rent assumptions** | `open_bed_assumption.read_state: ok`, 0 lines, monthly 0 | same | no; none exist here, so nothing is assumed over the phantom in this fixture |
| **Vacancy loss** | **no canonical owner exists.** Searched `src/` for vacancy loss, loss to vacancy, economic vacancy, gross potential; the only hit is a sample string in `document_ingest.js` | not readable | not readable | not claimed |

Correction to 8791791: "vacancy loss" is withdrawn as a claim; nothing in
Spine computes it. The supported statement is narrower: **source correction
changes no financial figure.** The phantom stays in every count and every
denominator; its only movement is from `vacant` to `unresolved` in the
canonical rent roll and from `open` to no bucket on the unit Rent Roll.

Forward rent's `contractual` is 0 in both states even though the sibling
lease exists, because that figure comes from cycle-committed rows and
tracker claims, neither of which this fixture has. Recorded, not asserted.

## 3. The down hold against the two occupancy owners

Marking 301 down over HTTP: canonical rent roll reports `down: 3`,
`leasable: 2`, occupancy **1 of 2 = 50%** (it subtracts down rows); the
occupancy primitive and the leasing desk still say **1 of 5 = 20%** (they
exclude by label only). Two owners of "occupancy" disagree under a hold,
and the hold also removes both real rooms. Resolving the down restores
every consumer and financial read to the post-correction values.

## 4. History and restore, strengthened

Retirement on the corrected property (so an artifact hash exists):
`retireInventoryUnits()` returns `retired: 1` (a **number**; the 8791791
proof read `.retired.length`, which is `undefined`, and its JSON shows
`retired: null` for that reason) with reason
`superseded_by_corrected_inventory_grain`, the only governed reason;
`REASONS_DATE_SENSITIVE` is empty. While retired, all three 301 positions
leave every consumer and every financial read (inventory 2, occupancy 1 of 2,
forward positions 2, future positions 2), except the occupancy primitive,
which still counts 5 because it does not carry the `NOT_RETIRED` predicate.

After `reinstateInventoryUnit`, a byte-for-byte comparison of the snapshot
before and after: 5 spaces (id, unit id, label, kind, use), 9 proposals
(id, key, status, confirmed_by, confirmed_at, evidence link, activation), 9
evidence rows (id, produced unit, produced space, note), both opening
baselines with `superseded_by_id` / `superseded_at`, both import batches,
the artifact `sha256` / size / name, the sibling lease (id, space, rent,
dates, status), and the governed cycle: **identical**. Every consumer and
financial field equals its pre-retirement value. The retirement row remains
as history, reversed, carrying `original_unit_number = '301'`.

## 5. Pre-build ruling: two facts, two owners, two next actions

An authorized person may have established one of two different things, and
the fixture cannot tell them apart. Neither a file omission nor the sentinel
label establishes the second.

### Outcome A — "this position is disputed; do not offer it while we resolve the evidence"

- **What is true today:** occupancy is what it is; marketing is held.
- **Existing owner of the fact:** none at the position grain. The two
  marketing-axis holds that exist (`units.is_down` through
  `POST /units/:id/down`; triage through `POST /operator/units/:id/triage/confirm`)
  are unit-grained. Source correction is space-grained but says the wrong
  thing: it replaces the occupancy fact with "unknown".
- **Explainable without touching occupancy or readiness?** Yes, and the
  reads already show it for Room1 under the down hold: availability says
  `basis_state: established` and `marketing_state: down / out_of_service`,
  the Rent Roll bucket stays `open`. Open vacancy and held marketing are two
  axes, both true at once. What is missing is only the grain: a down-style
  marketing fact that names a space rather than a unit, with the same
  actor, reason, event and resolve semantics `down_units.js` already has.
- **Least destructive action now:** the down hold on the unit if the two
  rooms can be spared from offering for the dispute's duration, else
  nothing: source correction should not be used to express a dispute,
  because it changes the occupancy truth of a position whose occupancy is
  not in doubt.

### Outcome B — "this record never represented an independent rentable position"

- **What is true today:** the position should not be in any count.
- **Existing owner of the fact:** `inventory_retirement.js`, and only it.
  Its meaning is exactly this (never-was inventory), its predicate excludes
  at every `as_of`, it refuses date-sensitive reasons, it refuses while a
  lease is held, and reversal is a correction of the correction, not a
  temporary hold. It is unit-grained; the disputed thing is a position.
  Actor attribution in it is not HTTP authorization: no live caller exists,
  so no permission rule is inherited.
- **What establishes the fact:** a person's decision, recorded with a
  rationale, after the evidence is resolved. Not the corrected file (which
  only omits the row), not the label (which is not identity), not the
  writer guard (which only stops new shapes).
- **Least destructive action now:** none that is position-grained exists.
  Retiring the unit takes the two real rooms with it; source correction
  leaves the count. The missing connection is the retirement owner's grain,
  with everything else about it kept: reason vocabulary, lease refusal,
  every-`as_of` exclusion, reversal, and the readers that already import
  `NOT_RETIRED_SQL`. The occupancy primitive would need to adopt that
  predicate too, since it ignores retirement today.

### What must not happen

A blanket rule on the sentinel label. It cannot say which of A or B a
person decided, records no actor or rationale, has no reversal object, and
keys on a label the writer receipt showed is not physical identity.

## Strongest surviving counterexample

That Outcome A already has a truthful home and needs nothing: the
down hold. It expresses "vacant and not marketable" on both axes today, it
is reversible with history, and taking the two sibling rooms off the market
for the life of a dispute is an operating cost, not a truth defect. If the
owner rules that a dispute about one bed may hold the unit, the A gap
closes with no build. The reply is that the canonical rent roll then
reports 50% occupied over a denominator of 2 while the desk reports 20%
over 5, so the unit-grained hold moves the occupancy ratio for a reason
that is not occupancy.

## Limits

- Ask: door exercised, answer unavailable by design; facts via its reader.
- Forward rent and future facts were read with no tracker and no asking
  assumptions, so their rent figures are 0 / NOT_ESTABLISHED both times;
  only their position counts carry evidence here.
- Vacancy loss: not computed anywhere; nothing claimed.
- Turnover and use-type paths not exercised (unit-grained in source; no
  governed use-type writer). Source-only.
- Proof kept out of `verify_all.sh`: it pins the shapes it argues about.
