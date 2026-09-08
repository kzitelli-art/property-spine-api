# Uncertain occupancy must not become an offer — Defect B candidate — Fable, 2026-09-07

Return to QB task 01a076e5-512c-70c3-a237-e8ca01c528f0. Candidate branch
`claude/defect-b-unresolved-offer-20260907`, cut from API `3df9ed9`
(`codex/claim-relay-20260907`) in an isolated worktree; no merge, no rebase.
App unchanged (`22d705d` read only; no state was added, so its state pin and
grouping need nothing).

## The change (one owner, one existing state)

`src/surfaces/availability_read.js`, `marketingState`: after the
`occupancy_unknown` and `evidence_unreconciled` guards and before the triage
overlay,

```js
if (p.evidence_state === "uncorroborated")
  return { state: "occupied", reason: "opening_claim_occupied_uncorroborated" };
```

and in `availableFrom`'s `occupied` branch the blocking fact carries the same
reason when there is no lease end date. The classification consumed is the
one the dated position already supplies: `dated_positions.evidenceState`
returns `uncorroborated` exactly when the accepted opening claim says
occupied and Spine holds no lease; `rentRollBucketOf` already buckets that
position `occupied` and standing counts it occupied. No other reader is
called, no truth store, no source row touched, no tenancy state invented, and
the claim is never reinterpreted as vacancy.

**Why `occupied` and not another state.** `evidence_disagrees` is the
contradictory case (Spine holds a lease against a vacant claim) and stays
separate: uncorroborated and contradictory remain different facts, and the
reason names which. `occupancy_unknown` is for no basis at all; this position
has an accepted basis. `occupied` is what the Rent Roll and standing already
say. What the knowledge supports is the claim: the position is treated as
occupied because the accepted opening truth says so. What it does not support
is an offer, which needs a lease end or a governed vacancy. The row carries
`evidence_state: uncorroborated` and the reason, so a reader can tell it from
a lease-backed occupancy.

## Proof

```text
node --test tests/unit/availability_occupancy_basis.test.js
   parent (3df9ed9, test copied in):  pass 4  fail 1   — expected 'occupied', actual 'marketable_now'
   candidate:                          pass 5  fail 0

. run1/env_all.sh   # nonce-owned DB spine_proof_<nonce>, ledger 192, no pending DDL
node run1/multi.js '[["uncorroborated successor","tests/proofs/availability_uncorroborated_claim.db.js"], …]'
   successor  18 passed, 0 failed
   regressions on the candidate, same server: onboarding_space_availability PASS ·
   availability_readiness_axis 13/13 · opening_claim_relay_edges 12/12 ·
   opening_claim_unattached 14/14 · opening_claim_identity 17/17
PROOF_EXPECT_DEFECT=1 PROOF_BUSINESS_ROOT=<3df9ed9 worktree> PROOF_SERVER_ROOT=<same> node run1/drive.js tests/proofs/availability_uncorroborated_claim.db.js
   witness    18 passed, 0 failed   (server and modules from the parent)
node tests/e2e/proof_boundary.js cleanup   → owned database dropped
```

`tests/e2e/verify_all.sh` runs the successor proof inside the owned-server
block, after `proof_boundary.js wait` reports the server UP and beside the
other HTTP proofs (mixed-grain writer, retained source authority, leasing
occupancy retirement, canonical occupancy under holds). See "QB review
repairs" below for the runner evidence.

## Source custody and fixture classification

Synthetic rows only; no July, Skyline or private originals; zero actual-source
confirmations; no provider call left the process. **Section 0 of the proof
exercises the current confirmation writer** (retained-source activation
ingest → confirm → establish on an occupied row): it creates a lease and the
position reads `evidence_state: confirmed`, `contractually_occupied`. The
defect shape is therefore built from directly promoted rows and is classified
as retained data from older promotions or direct status writes. Direct rows
do not demonstrate current-writer reachability, and this proof does not claim
it.

## 1. The exact old failure, exercised (witness on 3df9ed9)

303 Room2: accepted opening claim says occupied, no lease. Over HTTP on the
parent: `availability-canonical` row `marketable_now`, `available_from`
2026-07-31, `blocking_fact` null, while the same row already carried
`evidence_state: uncorroborated`, `tenancy_state: unresolved`,
`basis_type: opening_claim_occupied`. `leaseable-units` listed `303|Room2` as
an eligible target. `resolveApplicationTarget` said `offerable: true`. The
earlier selector statement is now an exercised selector, not a composition
inference.

One observation from the witness: 306 Room1, the same shape on a unit with a
pending initial walk, read `readiness_unknown` on the parent. A readiness
overlay, not the occupancy fact, was holding it. On the candidate it reads
`occupied`.

## 2. Successor and preserved invariants (same fixture, both modes)

| Position | Shape | Parent | Candidate |
|---|---|---|---|
| 303 Room2 | occupied claim, no lease | `marketable_now`, offered, target | **`occupied` / `opening_claim_occupied_uncorroborated`**, `available_from` null, `blocking_fact` named, not a target, authority `not_offerable` |
| 306 Room1 | same, unit has a pending walk | `readiness_unknown` | `occupied` (the overlay no longer masks the claim) |
| 301 Room2, 304 Room1, 305 Room1 | confirmed vacancies | `marketable_now` | `marketable_now`, all three still eligible targets |
| 301 Room1 | native operative lease | `occupied` / `spanning_lease`, evidence `confirmed` | same |
| 304 Room2 | vacant claim + pending future lease | `successor_pending` | same |
| 303 Room1 | two overlapping active leases | `contested` | same |
| 302 Room1 | occupied claim, no lease, unit DOWN | `down` | `down` (the hold precedes the claim) |
| 305 Room2 | no claim | `occupancy_unknown` | same |
| 306 Room2 | vacant, unit has a pending walk | `readiness_unknown` | same |
| maintenance-only seat | `GET availability-canonical` | 403 | 403 |

States on the candidate: occupied 3, marketable 3, down 2, readiness_unknown
1, contested 1, occupancy_unknown 1, successor_pending 1. No lease row was
created or changed by any read.

## 3. Reconciliation with application targets and standing / Ask

- **Application targets** follow availability by construction
  (`evaluateOfferability` admits `marketable_now` only): 303 Room2 leaves the
  selector and the authority refuses with `not_offerable`. No change there.
- **Standing / Ask** counts 303 Room2 occupied (4 occupied on this fixture:
  one lease, three claims) and the unit Rent Roll buckets it `occupied`.
  Availability now agrees.
- **Canonical rent roll** keeps `tenancy_state: unresolved` and
  `evidence_state: uncorroborated` on its contractual axis. That is a
  different question (are the contractual terms established?) and it was not
  forced to agree.

Which knowledge supports what: an accepted occupied claim supports *treating
the position as occupied* and *counting it occupied*; it does not support an
offer, a contractual rent, or a lease end. A lease supports all of those. A
confirmed vacancy supports an offer.

## 4. Rungs

- Source: `marketingState` precedence, `evidenceState`, `rentRollBucketOf`,
  app grouping (`occupied` belongs to the Rent Roll, every other state has a
  group; no new state).
- Service: `resolveApplicationTarget`, `readTenancyStanding`, `unitRentRoll`,
  `currentRentRoll`, the section-0 writer classification.
- HTTP: `availability-canonical`, `leaseable-units`, `units/:id/down`, the
  maintenance-only 403.
- Browser: **not run.** The existing Market & Pricing browser phase drives its
  own fixtures from `onboarding_space_availability.db.js`; extending it to
  this fixture would mean adding a fixture entry to that proof, which is a
  change to a browser proof QB owns. Reported as not exercised, not as
  passed.

## QB review repairs (second push on this branch)

1. **Runner order (High).** On 8222c29 the step sat at the pre-server
   position (after "availability readiness axis", before `boot.sh`), where
   `E2E_API_BASE` is set but no server answers, so the proof's first fetch
   would fail in CI. Moved into the `UP` branch of the owned-server block:

   ```text
   ./tests/e2e/boot.sh > /tmp/verify_server.log 2>&1 &
   node tests/e2e/proof_boundary.js wait "$E2E_API_BASE" "$SERVER_PID" && UP=1
   … echo "── server  UP (owned PID, run nonce, database marker)"
     step "mixed-grain onboarding writer"      …
     step "retained source authority"          …
     step "leasing occupancy retirement"       …
     step "canonical occupancy under holds"    …
     step "availability uncorroborated claim"  node tests/proofs/availability_uncorroborated_claim.db.js   ← here
     step "authority chain"                    …
   ```

   Standalone runs do not prove CI wiring; the CI run on the pushed head is
   the evidence and is reported in the return message. `verify_all.sh` itself
   cannot be run in this sandbox (its `boot.sh` port guard binds IPv6, which
   is refused here), so the local runs use the same owned-server harness the
   earlier receipts used.
2. **Lease snapshot (Medium).** The proof now selects every column of every
   lease row on the property, ordered by id, before any read, and compares
   the full row set after; the count control (4 before, 4 after) is kept
   inside the same assertion. Both modes 18/18.
3. **Comment (Low).** The product comment cites
   `tests/proofs/availability_uncorroborated_claim.db.js` and is reduced to
   the governing condition, precedence and reason (10 lines).

4. **CI wiring, observed.** Run 441 (8222c29) and run 442 (8c5d02c) both
   failed at "source governance gates" before any proof ran:
   `gate_current_state.js` requires contiguous defect-row numbering, and
   this branch's row was numbered 71 after row 65 (rows 66–70 live on the
   other Fable evidence branches). The row is renumbered 66 on this branch;
   the third push carries the runner-order evidence.

## Strongest surviving counterexample

That `occupied` overstates what Spine knows: the row hides in the Rent Roll
rather than in the "contested or unresolved" group where an operator would
notice it, and a stale source row that named a resident who left will now
quietly read occupied instead of quietly reading marketable. Both readings are
wrong in some case; the candidate picks the one whose failure is a bed not
offered rather than a bed offered over someone's claimed tenancy, and the row
still carries `evidence_state: uncorroborated` for the Rent Roll to surface.
If QB rules that uncorroborated belongs beside contested and disagrees, the
same one-line guard can return `evidence_disagrees`'s neighbour instead; the
reason and the proof would not change.
