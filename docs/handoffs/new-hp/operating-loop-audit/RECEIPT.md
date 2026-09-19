# The operating loop, audited as one system

2026-09-19 · owned PostgreSQL 16 (migration ledger current) · owned HTTP server
on loopback · one generic **whole-unit apartment** fixture, never Skyline or
Greenery. **No production data, phone configuration or prospect communication
was touched.** No product code was changed.

```
API   73508c65  claude/rentroll-grain-refusal-20260918   (tree unchanged by the audit itself)
proof docs/handoffs/new-hp/operating-loop-audit/loop_audit.db.js   → loop_audit.out
      23 seams HOLD · 8 BREAK   (a verdict, not an exit code)

CLOSED the same night — see "The closure" at the end of this receipt:
      34c47a17  row 151  a governed move-out is a vacancy fact          CI 711 green
      31e6bb32  row 152  when a turn slips, leasing sees it               CI 712 green
      e2d4e295  row 153  one readiness truth feeds every gate             CI 713 green
      + the door-yields correction (below)
      loop_audit_after_151_153.out   29 HOLD · 2 BREAK (both labelling notes)
```

The question asked: *does Property Spine already have one connected operating
spine from a tenancy ending to the next resident's revenue, or several good
modules that still fail to close the loop?*

**Answer: several good modules on one truth path, and the loop does not close.
Three seams hold well. Three break, and one of the breaks means a position that
leaves through Spine's own move-out door can never be offered again.**

---

## The path through the actual files

```
DATED TENANCY / RENT ROLL     src/tenancy/space_position.js      loadSpaceRows: leases, possession events, notice, turn_status
                              src/tenancy/position_classifier.js classifyPosition (pure): current / activation_pending / future,
                                                                  successor, conflict, possession, physical_readiness = turning|"ready"
                              src/tenancy/dated_positions.js     positionBasis · evidenceState · tenancyState · rentRollBucketOf
        ↓
TURNOVER / READINESS          src/maintenance/turnover_service.js   openTurnover: turnovers row (unit grain), expected date → turnovers.ready_date,
                                                                    move_out possession event (only if a move_in was recorded), initial walk
                              src/maintenance/unit_triage_service.js confirmTriage → deriveReadiness; PROTECT_MOVE_IN via readNextCommittedMoveIn
                              src/maintenance/unit_turn_scope_service.js · work_acceptance_service.js · readiness_gate.js
                              src/maintenance/readiness_service.js  recordWalk → certification → closeActiveTurnoversForReadiness
        ↓
AVAILABILITY                  src/surfaces/availability_read.js   overlays turnover (expected date), triage, certification, signed-applicant hold
                                                                  on datedPropertyPositions; marketingState · availableFrom · readinessAxis
        ↓
LEASING / APPLICATION         src/applications/application_target_authority.js  resolveApplicationTarget: availabilityRead (today) +
                                                                  intervalPropertyPositions (requested dates) → offerable | refusal code
                              src/leasing/leasing_inventory.js   matchProspectHomes → application_target_read → the same authority
        ↓
FUTURE LEASE / COMMITMENT     src/tenancy/tenancy_anchor_service.js  confirmTerm: leases(pending) + move_in_scheduled + move_in_delivery
                              (locked = executed_lease_records verified AND move-in charges paid — position_classifier.isNativelyProven)
        ↓
TURN PRIORITY                 src/maintenance/turn_priority.js   rankTurnPriority reads availabilityRead.future_commitment per space
                              src/maintenance/unit_move_in_read.js readNextCommittedMoveIn reads datedPropertyPositions
        ↓
WORK + READINESS              (as above) → certification closes turnovers → availability recomputes on the next read
        ↓
MOVE-IN / CURRENT TENANCY     src/tenancy/economic_tenancy_service.js attemptEconomicTenancyActivation: pending → active
                              src/tenancy/movein.js keys-handed-over → recordEffectivePossession
```

One dated read (`datedPropertyPositions`) feeds the rent roll, availability,
the application authority, turn priority and maintenance's own move-in reader.
That part is genuinely one spine. Nothing on the leasing side keeps its own
ready date; nothing on the maintenance side keeps its own lease.

---

## The six seams

| # | Seam | Verdict | Evidence (fixture step) |
|---|---|---|---|
| 1 | Rent Roll → Availability | **Holds for rights; breaks for evidence** | S0/S1: availability consumes the dated position and refuses a position whose possession was never returned. But the rent roll called a position **occupied** on a stale opening claim after its lease had ended and its resident had moved out through the turnover door (S1: `rr=occupied` while availability says `turnover_required`). |
| 2 | Maintenance → Availability | **Holds, one writer short** | S1: the turn's expected date is the only governed future date and availability relays it. S5: certification closes the turn and the readiness axis reads `ready/certification`. But `turnovers.ready_date` has **no update path between open and close** (grep: `turnover_service.js:134`, `turnovers.js:203`, `readiness_service.js:64` are the only writers), and a second writer (`POST /turnovers/:id/ready`, shared operator key) closes a turn with zero certifications (S5b). |
| 3 | Availability → Leasing | **Holds** | S2: offerable for a move-in after the expected date; refused before it (`application_move_in_before_expected_ready`); Control B refused inside a committed interval (`application_term_not_free`, interval `term_blocked`). |
| 4 | Leasing → Maintenance | **Holds** | S3: the locked future lease appears in Turn Priority as `committed_start` with the deadline, and in `readNextCommittedMoveIn`, with no write on the maintenance side. S4: a severe triage on that unit raises `protect_next_move_in` for a manager automatically. |
| 5 | Maintenance → Leasing | **Breaks** | S4/S4b: after a severe, long-lead finding the expected date stays `2026-10-03/expected` and a prospect can still be promised the old date (Control C). No obligation fires unless a *committed* move-in already exists. The slip is invisible to leasing. |
| 6 | Move-in → Rent Roll | **Holds for the commitment; breaks for the vacated position** | S6: the locked lease reads `activation_pending` at its start date and `contractually_occupied` after the real activation writer runs; no reclassification. But the position the *previous* resident vacated never becomes offerable: with an occupied opening claim it reads **Occupied** forever (S5b, unit 102); with a lease-only basis it reads **occupancy unknown** forever (S5c, unit 105). |

Negative controls asked for:

| Control | Result |
|---|---|
| move-in requested before governed ready date | **refused** (`application_move_in_before_expected_ready`) |
| future lease already occupies the requested interval | **refused** (`application_term_not_free`; interval read `term_blocked`) |
| turn slips past promised readiness → leasing sees it | **not seen** — same date, same confidence, still offerable |
| physically ready but contractually unavailable | **refused** (`successor_locked` → `not_offerable`) |
| contractually free but physical readiness unresolved | **not called ready** — but for the wrong reason: a stale opening claim (103) or no basis (104), never "readiness unresolved" |

---

## The three breaks, ranked

### 1. A governed move-out leaves no vacancy fact, so the position dead-ends

`positionBasis` (`dated_positions.js:173`) can establish vacancy from exactly one
thing: an accepted opening claim of `vacant`. `evidenceState` (`:646`) treats an
`occupied` claim with no lease as `uncorroborated` regardless of what happened
after the claim's date — the only later-fact branch is for a *vacant* claim
followed by a lease. Neither reads `last_possession_end`, and the dated
projection does not even carry it forward (`:984` region carries
`current_possession`, not the end).

So after the turnover door has recorded the move-out and the turn has closed:

```
opening claim occupied  →  basis opening_claim_occupied, evidence uncorroborated  →  "Occupied"           (102)
no opening claim        →  basis not_established (unit cache is context only)     →  "occupancy unknown"  (105)
```

The Greenery establishment in the owned copy has **95 active leases, 0
possession events, 0 turnovers**. Its first real move-out through Spine will
write no possession end (the door only ends a possession it recorded:
`turnover_service.js` "no possession-end event because this lease had no live
move-in"), and once the turn closes the bed reads Occupied from the opening rent
roll. Every bed that turns on Greenery lands in state 102. The fixture proofs
that exist (`slice9_inventory_fixture`, `tour_application_lease`, the readiness
axis proof) all establish their vacancies with `vacant` opening claims, which is
why this was never seen.

**Smallest change (reads only, `dated_positions.js`, no schema):** a turnover
with an `outgoing_lease_id` that names this position's lease, opened after the
opening claim's as-of date, is a governed later fact. Let `positionBasis` return
`established / turnover_recorded_move_out` for it, and let `evidenceState`
return `governed_by_later_fact` for an occupied claim whose named lease has
since been moved out through the door. `loadSpaceRows` already selects
`turn_status`; it needs `outgoing_lease_id` and `created_at` beside it. The
dated projection should also carry `last_possession_end`. Vacancy stays
evaluated last; a lease merely *expiring* still establishes nothing.

### 2. A turn can slip and leasing never learns

The expected ready date is typed once at move-out and has no writer until the
turn closes. Triage, scope, work acceptance and reopening all record what they
found and none of them touches the date or its confidence. Availability
therefore says `expected` on a date nobody believes any more, and the
application authority offers against it.

**Smallest change:** not a scheduler and not a duration model. Two reads and one
existing writer. (a) `availableFrom` in `availability_read.js` already has the
triage overlay on the row; when triage reports `not_ready` with a severe
condition or any long-lead finding, downgrade `availability_confidence` from
`expected` to `incomplete` with `blocking_fact: "turn_scope_exceeds_plan"`. The
application authority already refuses anything that is not `expected|confirmed`
(`evaluateOfferability`), so the promise stops without a new rule. (b) Give the
existing operator move-out door a governed way to **re-state** the expected
date on an open turn (one `update turnovers set ready_date` behind the same
management session, with an event), so a manager can restore `expected` once
the vendor date is known. That also retires the dual meaning of `ready_date`
by convention: expected while `in_progress`, actual once closed.

### 3. Three readiness truths, two of them not fed by the certification

- `turnovers.status` — closed by certification **or** by the legacy
  `POST /turnovers/:id/ready` behind the shared operator key (`server.js:479`,
  `turnovers.js:155–221`), which needs only move-out photos and deposit review.
  S5b closed a turn with zero certifications over real HTTP.
- `unit_readiness_certifications` — the one path `readiness_service.js` calls
  "the ONLY module permitted to make a unit physically ready."
- the move-in `readiness` obligation in `movein.js` (`OPERATIONAL_GATES`:
  checklist, appliances, photos) whose approval is what feeds `unit_ready` into
  the lease's delivery and therefore gates the key handoff. Certification does
  not feed it; nothing in `readiness_service.js` calls the delivery helper.

**Smallest change:** (a) make the legacy `ready` route refuse when the unit
carries no live certification (it already refuses on outstanding move-out
proof; this is one more guard, same shape), and record its retirement
condition. (b) In `finishReady`, after `closeActiveTurnoversForReadiness`, call
`deliveryHelper.satisfyDeliveryInput({ input_key: "unit_ready" })` for the next
committed lease it already resolved (`nextMoveIn.lease_id`) — the certification
becomes the proof the delivery obligation wants, and the parallel move-in
checklist stops being a second inspection.

---

## Smaller things seen, recorded not fixed

- While a turn is in progress the classifier sets `availability_state =
  vacant_turning` before it looks at a future lease
  (`position_classifier.js:208–211`), so `marketing_state` reads
  `turnover_required` on a position that is already committed. The row still
  carries `future_commitment: locked`, the interval read still refuses the
  dates, and turn priority still ranks it — the refusal held (Control B). It is
  a labelling gap, not a loop break.
- `management_read.js:379` relays the classifier's `physical_readiness`
  default, where `ready` means "no turn open", not that anyone looked. Ask
  Spine's standing read does not relay it. Row 65 already records the ruling
  owed.
- `units.occupancy_status` is written by the turnover door as a compatibility
  cache and is context-only for basis (correct). The legacy
  `availableUnits(discovery_mode="legacy_units")` still filters on it, but every
  live caller passes `exact_spaces`; the default is dead weight, not a live
  second derivation.
- `resolveApplicationTarget` reads availability **as of today** and the
  interval read for the requested dates. Physical readiness for a future date
  is therefore "today's turn plan says", which is honest as long as break 2 is
  closed.
- Turnovers are unit-grained; `unit_triage_required_work` now carries
  `space_id`. Turn priority states its unit→space aggregation explicitly. Not a
  break for a whole-unit building; re-measure before a bed-level claim.

---

## What this proof is not

- The future lease in S3 was written directly in the shape `confirmTerm` writes
  (pending lease with `application_id`, verified executed record, paid move-in
  charge), not through `confirmTermService`, which needs the whole application
  chain that `tests/e2e/tour_application_lease.e2e.js` already exercises.
- The clock was moved for S6 by setting the lease start to today, because the
  activation writer reads `current_date`. Stated in the output.
- One property shape (whole-unit apartments). Nothing here is Skyline-specific,
  and nothing here was run against Skyline or Greenery.
- No browser rung. Every seam here is a service or HTTP seam.

---

## The closure

Same fixture, same audit script, re-run on the tree after rows 151–153
(`loop_audit_after_151_153.out`): **29 hold, 2 break**, and the two that
remain are the labelling notes recorded above, not loop breaks — a turning
position with a locked future lease is labelled `turnover_required` while
still refusing every competing prospect, and a lease that merely expires
with no move-out stays on its opening claim, by design.

| Break | Closed by | What changed |
|---|---|---|
| 1 · vacated position dead-ends | row 151, `34c47a17` | the move-out door is a governed later fact for basis, tenancy, evidence and terms; vacancy still evaluated last |
| 2 · turn slip invisible to leasing | row 152, `31e6bb32` | plan confidence follows the walk (`turn_scope_exceeds_plan`); the date can be re-stated with a reason through `POST /operator/units/:unitId/turn-target` |
| 3 · three readiness truths | row 153, `e2d4e295` | legacy ready refuses without a certification; certification feeds `unit_ready` into the delivery gate |

**One defect the closure itself introduced, found by this re-run and fixed
before this receipt was written:** `movedOutByDoor` governed the evidence
axis even when a stronger fact (a commenced pending lease, recorded
possession, an unclassifiable spanning lease, a contest) had already
answered the basis, so a vacated bed whose incoming lease had commenced
crashed `rentRollExplain` on a current lease that was not there. The
predicate now yields to those facts in every reader, the explanation no
longer assumes a lease in its later-fact branch, and the case is pinned in
`tests/proofs/vacated_position_basis.db.js` (21/21). CI runs 711–713 were
green without it because no registered proof covered door + commenced
lease; that gap is what the new case closes.

Unregistered `tests/proofs/readiness_certification_proof.js` had stale
relative requires from the test reorganisation; the paths are fixed, and it
now runs to 119/127 — the 8 failures assert a certified unit becomes
`marketable_now`, which the row-61 occupancy-basis guard deliberately
stopped. It is superseded by `availability_readiness_axis.db.js` and stays
unregistered.

## Addendum, 2026-09-19 — the app pin converged (row 154)

The three app rungs parked by row 139 are live in `verify_all.sh` again.
One app commit carries both lineages (`claude/app-convergence-20260919`
@ `475b3e1`: pin `2e8199a` merged with the convergence line `2bbdb63`, six
`index.html` hunks resolved by hand, app suite 77 harnesses · 2626 · 0 red),
and `tests/e2e/app_pin.txt` now names it.

The browser rung earned its place: on the merged app the signed-in desk
showed the server's contractually-occupied **94** (not 95), but the pin's
count cell had dropped the §19 sub-line naming the **1** position whose
terms are not established. The number had converged; the disclosure had
not. Fixed in the panel's canonical branch, from the same canonical read;
the proof reads either label, falsified 13/14 → 14/14.

Re-proofs on the merged app, owned runtime: coupled rent-roll 14/14 + 6/6,
`retained_inquiry_dom`, `person_identity_ingress` 40/40,
`forward_semantics_are_the_servers` 34/34, `forward_occupancy_unresolved`
24/24, `operating_truth_pill` 24/24, `person_identity_signed_in` 14/14,
`forward_convergence_signed_in` 14/14.

Recorded, not fixed: `canonical_onboarding_review.browser.js`'s `zero`
phase (unregistered) expects `Current occupancy` with a percent on the
signed-in desk; the pin lineage has rendered `Occupied in rent roll` as a
count since app `44e0e42`. Pre-existing at the pin; not this merge's.

## Addendum, 2026-09-19 — break 2's two app follow-ups (row 155)

Availability now says the server's confidence word (`incomplete · turn
scope exceeds plan`, not `expected`), and management can re-state the
ready date with a reason from the row through the row-152 door. Browser
verified on the owned runtime with its own fixture, 19/19; the browser
caught a broken `onclick` attribute the HTML harness had passed. Pin moved
to app `494ff1a`.

