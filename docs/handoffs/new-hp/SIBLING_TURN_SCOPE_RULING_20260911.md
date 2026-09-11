# Shared-apartment turn scope: evidence and launch path

Inspected candidate `932c9afafccd31f75385b1a7fc17c41deda48b32` and actual independent Fable harness/receipt at `96c0af106670810bb85e16a1f2e920f1d15d4caa`. No product behavior changed in this lane.

The two L07 assertions are reproducible but their expected behavior is disputed. Fable creates an active unit turnover with an outgoing Bed A lease, but records no inspection or physical work coverage. Candidate correctly withholds Bed A's expected date and provenance from Bed B. The unit-level physical turn still blocks B. That does not prove B is physically clear: an outgoing lease identifies the resident/home leaving, not the extent of paint, shared-kitchen work, access restrictions or uninspected conditions.

Fresh run of the actual Fable harness against candidate source: **126 passed, 3 failed**, exit 1. Two failures are its expectations that B is marketable and selectable during the otherwise unscoped turn. Third is the separately owned named-bed send substitution. No claim these expectations were made green. Runtime: owned PostgreSQL17, migration chain194/182 rows, actual server3342, fake provider preloads. An earlier fixture attempt stopped because the fresh Skyline E2E property lacked operating_timezone; supplying that synthetic fixture value enabled the full run. This was not a product correction.

## Why required-work location cannot supply the missing authority

Migration194 scopes individual `unit_triage_required_work` items as `rentable_space`, `unit_wide` or `unspecified`. It does not scope the active turnover, the inspection coverage, findings, keys/access, paint/cleaning/appliance condition, or certification. `unit_turn_scope_service.readTurnFlow` correctly reads all work for the unit. `complete_turn_scope` still describes the unit; an empty work list is explicitly not readiness (`readiness_gate.js`). No safe current rule permits treating an outgoing lease or the location of one work item as proof that all other physical impacts are absent.

Do not fix these assertions by filtering `space_position.turn_status` on outgoing lease alone. Retain conservative blocking for unresolved physical scope. A future bed-only exception requires an attributed statement of exact turn/inspection coverage, shared-area/access effects and unresolved conditions, plus correction/revocation rules. It must compose with existing physical readiness and possession owners rather than creating a second planner.

## Existing staff path for the initial launch

`tests/proofs/shared_unit_readiness.db.js` exercised the current actual HTTP path:

1. Establish an occupied Bed A and returned Bed B in the owned fixture; preserve their separate possession identities.
2. `POST /operator/units/:id/triage/confirm` records that somebody remains in the apartment. No false vacant-unit claim.
3. Before a complete scope, `GET /operator/units/:id/readiness` refuses the final walk.
4. `POST /operator/units/:id/turn-scope/confirm` records a complete whole-apartment inspection. In this positive synthetic scenario no physical work is required; real work must be completed with required proof first.
5. An entitled Property Manager calls `POST /operator/units/:id/readiness/walk`, explicitly affirming the required physical acceptance areas. This creates the certification and closes the active unit turnover through `closeActiveTurnoversForReadiness`.
6. Bed A remains occupied with identical possession. Bed B reads physically ready from the certification. Without an established vacancy basis it still reads `occupancy_unknown`; with the independent confirmed-vacancy fixture it becomes marketable. Certification never grants vacancy or lease rights.

This test passed through real staff sessions, HTTP and the owned database. Scope and walk confirmations are real canonical writes; initial tenancy/opening evidence and the active turn are synthetic fixtures. No browser, provider, live-property or production acceptance claim. No source changed and no new migration. This existing whole-apartment acceptance path can support staff-managed initial leasing where staff can truthfully inspect/accept the apartment. It is not permission to affirm unknown or inaccessible areas merely to remove a blocker.

Prospective bed-only planning is a later bounded contract, not a prerequisite to accepting leads and arranging staff follow-up. For launch, unknown readiness should remain visible to staff until the current verification path can truthfully clear it.
