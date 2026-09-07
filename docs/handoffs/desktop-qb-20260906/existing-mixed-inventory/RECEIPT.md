# Existing mixed inventory — what an authorized person can truthfully do today — Fable, 2026-09-07

Return to QB task 01a076e5-512c-70c3-a237-e8ca01c528f0. Evidence branch
`claude/existing-mixed-hold-evidence-20260907`, cut from QB's `43d30ed`
(`codex/claim-relay-20260907`, the new-writer guard). **No product file
edited.** One proof file plus this directory.

**Answer, in one line: today an authorized person can stop the disputed
position being *offered* only by the source-correction path, and even that
leaves it counted as a rentable position with unknown occupancy in the Rent
Roll and in what Ask Spine grounds on. Every other existing hold is
unit-grained and takes the real rooms down with it. No position-level
retirement exists.**

```text
. run1/env_all.sh                      # nonce-owned DB spine_proof_<nonce>, ledger 192, no pending DDL
node run1/multi.js '[["existing mixed hold","tests/proofs/existing_mixed_inventory_hold.db.js"]]'
  → PASS  existing mixed hold   30 passed, 0 failed
node tests/e2e/proof_boundary.js cleanup   → owned database dropped
```

## Source custody

- Fixture: the recorded historical shape, built from direct rows the way
  `tests/e2e/property_fixture.sql` builds it: bed property, unit 301 with
  `(whole unit)` retained beside Room1 and Room2, all three confirmed vacant
  with `import_source_rows` lineage under one established baseline; unit 302
  with Room1 and Room2 as the property-level neighbour. **Not** a new import
  (the materializer now refuses that). Synthetic rows only. No July, Skyline
  or private originals; zero actual-source confirmations.
- Runtime: owned server on the owned database, fake SMS and Anthropic
  preloads, operator key `e2e-key` for the keyed door.

## Rung by consumer

| Consumer | Door | Rung |
|---|---|---|
| Canonical availability | `GET /operator/leasing/availability-canonical` | real HTTP |
| Application selector | `GET /operator/leasing/leaseable-units` | real HTTP |
| Unit Rent Roll | `GET /operator/rent-roll/units` | real HTTP |
| Standing / Ask | `POST /operator/ask-spine/ask` returns 200 with `outcome: unavailable` and **no `grounded_on`** because the e2e sentinel refuses the model; the grounding facts were therefore read through `gatherFacts(subject: tenancy)` and `readTenancyStanding`, the exact reader Ask calls (`ask_spine_answer.js:940`). Rung: HTTP for the door, services for the facts |
| Source correction | `POST …/source` → `…/activation` → `…/read-source` → `…/proposals/:id/confirm` → `…/establish` | real HTTP |
| Down unit | `POST /units/:id/down`, `PATCH /units/:id/down/resolve` (operator-key door) | real HTTP |
| Triage | `POST /operator/units/:id/triage/confirm` | real HTTP |
| Retirement | `retireInventoryUnits` / `reinstateInventoryUnit` | services only. No HTTP caller exists (QB's finding, confirmed) |

## Baseline (the historical shape as it reads today)

Placeholder `marketable_now` beside two marketable rooms. Selector lists
three targets on 301. Rent Roll: three rentable positions, placeholder
bucketed `open`. Standing: `ESTABLISHED`, 5 rentable positions, 5 open.

## The four things an operator can do, distinguished

| Path | What it is | Availability | Application selector | Rent Roll | Standing / Ask | Neighbour Room1/Room2 on 301 | History |
|---|---|---|---|---|---|---|---|
| **A. Source correction** — corrected file naming Room1/Room2 only, new setup | a statement about occupancy evidence, not about inventory | placeholder `occupancy_unknown`, rooms `marketable_now` | placeholder dropped, rooms kept | placeholder **still a rentable position**, basis `not_established`, no bucket, denominator 3 | `PARTIALLY_ESTABLISHED`, "4 of 5 rentable positions have an established basis; 1 do not"; unknowns: `positions_with_unresolved_occupancy_evidence: 1` | **untouched** | first baseline superseded, promoted claim intact |
| **B. Mark unit down** | an out-of-service fact about the unit | all three `down` | nothing on 301 | placeholder still `open` | still 5 open | **held with it** | event kept; resolve restores |
| **C. Severe triage** | a readiness fact about the unit | all three `not_ready_confirmed` | nothing on 301 | placeholder still `open` | still 5 open | **held with it** | confirmation rows kept |
| **D. Retirement** | inventory superseded, unit grain | all three gone | nothing on 301 | unit gone | 2 positions, 1 unit | **retired with it** | reversible; reinstatement restores all three |

Only A is space-grained. A is not a position removal: the placeholder is
still one of three positions on 301, and a renamed upload leaves both
physical positions exactly as they were. "Occupancy unknown" is the truthful
state for a position whose only claim is superseded; it is not the truth
about a position that should never have been one.

## Controls (nonzero)

- Neighbour: 302 Room1/Room2 stay `marketable_now` and offerable through
  A, B, C and D. 301 Room1/Room2 stay marketable through A and are held
  through B, C and D, which is the finding.
- Entitlement: wrong `x-operator-key` on the down door → 401 (that door is
  keyed, not property-scoped by session, and is the operator's own
  contract, recorded not judged). A session on another property at the
  triage door → 403. A maintenance-only seat at the leaseable-units selector
  → 403.

## Meaning that fails to travel to the standing / Ask reader

`rentRollBucketOf` (`dated_positions.js:262–291`) buckets by basis, conflict
and evidence only. Availability's `down`, `not_ready_confirmed` and any
marketing state never reach the Rent Roll line or the standing tally. So B
and C stop the offer at the two leasing consumers while Ask still reports
five open positions. A does travel, but as `not_established`, which Ask
renders as "1 do not have an established basis" and as an unresolved
occupancy-evidence unknown, never as a disputed position.

## Last green, first red

Goal: stop offering the disputed position, keep the rooms, keep the history.

- **Last green:** path A through availability and the application selector.
  Space-grained, reversible, history preserved, neighbours untouched.
- **First red:** the same path at the Rent Roll and the standing read. The
  position remains in `rentable_positions`, and the denominator every
  economic read is computed over still says three on 301 and five on the
  property.

## Smallest missing connection versus a broad reader rule

**Smallest connection.** Inventory retirement is the existing owner of "this
is no longer current inventory" and already has actor, reason vocabulary,
rationale, reversal, and a `NOT_RETIRED_SQL` predicate that the loader and
materializer import. It is unit-grained. The disputed thing is a
*position*. The smallest connection is that grain: retirement at the
position, with the same authority, reason, reversal and predicate, so the
readers that already exclude retired inventory exclude a retired position.
This is a design note for QB, not a patch. I did not draft it.

**Broad reader rule** (hold any sentinel-labelled position that sits beside
named positions). It would hold the correct target here, and would also:
hold the e2e fixture's unclaimed placeholder (harmless, already
`occupancy_unknown`); hold a whole-unit position that legitimately carries
lease history beside beds added later by hand (the C5 shape from the writer
receipt); and key on a label, which the fixture and the writer receipt both
show is not physical identity. It also adds no history: a rule cannot say
*who* decided the position is not real or *why*, and reversal has no object.

## Strongest counterexample to my preferred conclusion

That path A is already enough and the denominator is a reporting concern,
not an operating one: the rooms lease, the phantom cannot be offered or
applied for, and "1 not established" is an honest blank (§5). The reply is
that an honest blank about *occupancy* is being used to say something about
*inventory*, and every count computed over rentable positions (occupancy,
vacancy loss, forward rent) still divides by the phantom. Path A tells the
truth about the wrong question.

## Limits

- The Ask door was exercised and answered `unavailable` by design of the
  sentinel; the facts Ask grounds on were read through its own reader, not
  through a model answer. No provider call left the process.
- Turnover-in-progress was not exercised; it is unit-grained in source
  (`turnovers.unit_id`) like B and C and would read the same way.
  Source-only.
- `spaces.use_type` has no governed writer in `src/` (only the materializer
  coalesce and seeds), so "not a residential use" cannot be stated by an
  operator today. Source-only.
- Proof kept out of `verify_all.sh`: it pins the shapes it argues about.
