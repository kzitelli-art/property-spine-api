# Explicit work target: independent first red

Inspected API `17a3944b7e5cbc3a3e75528dadf7096cb4c954f5`, paired app `f2eda58544b1650f123735f4105c750a47eba081`, September 10, 2026. Read CURRENT_STATE and PHILOSOPHY; philosophy SHA256 `977B30A4C41B0F8C1511DA3521D030E031AB13B9D1897EEA5970F011F487FC28` unchanged. No product files changed by this proof.

An operator must be able to record which rentable bed needs work without ending its sibling's occupancy or claiming the home is ready. The existing triage confirmation is the canonical writer; required work already has durable confirmation, finding, property and unit relationships. Extend that owner, not a second task table or interpreter. History `e239ecb` introduced the triage/scope/acceptance/readiness chain; `f54bb91` connected canonical turnover. Current source does not retain explicit work-space identity.

## What actually ran

New Class 3 harness: `tests/proofs/triage_work_scope.db.js`. The existing owned wrapper applied the real migration chain and started the real API. Synthetic property, two spaces and maintenance assignment are fixture setup; the staff session is issued by the canonical session service. The confirmation goes through `POST /operator/units/:id/triage/confirm` with that session and a supplied exact `space_id` and `scope_kind: rentable_space` on the required-work item.

The last green is HTTP201, `recorded:true`, exactly one work item, and a durable work row with the correct unit and server-derived property. The first red is:

`confirmed exact bed survives HTTP capture into the canonical work row`

Actual `work.space_id` is undefined. The route forwards the required-work objects unchanged; the service's existing INSERT discards the identity because its work schema and insert do not carry it. Do not misdiagnose this as route filtering. This is independent HTTP/DB evidence of the gap, not acceptance of Claude's unavailable 79-assertion harness.

The first harness attempt failed earlier because it guessed `issued.token`; the actual service returns `session_token`. That is a harness defect, not a product first red. The vacancy vocabulary was also corrected to the actual `occupied_or_someone_remains` before the second run. Both owned databases and cluster data were removed by the wrapper. Private runtime output remains in the local temporary proof directories, outside Git.

Run with `PROOF_FOCUSED_NAME=triage_work_scope`, `ONBOARDING_SPACE_PROOF_ONLY=1` and `tests/e2e/onboarding_review_local.ps1`, using the same private workbook, PostgreSQL and browser arguments as the sibling-cache proof. Expected current result: exit1 at the named identity assertion. The candidate remains unchanged. This intentionally red harness is not registered in CI or pushed as a passing milestone.

## Next vertical slice

Use WORK_SCOPE_IDENTITY_PREBUILD.md with the root corrections: `unspecified` for absent scope in both old and new records, explicit `unit_wide`, or explicit `rentable_space`. Validate through `spaces.unit_id` and the owning unit's property; do not assume a `spaces.property_id` column. Preserve history and existing conservative unit readiness gates. A work deadline never becomes expected readiness by itself.

The service/read path already returns work rows through `readWorkState` and `readUnitFlow`; Unit Turn's compressed work object must explicitly retain the new scope. The existing app triage door currently sends work text and origin only, so its selection and the dependent work displays must be included before calling the operating slice complete. Ask reader coverage also requires executable verification; the worker's proposed registration path was source navigation, not a proven existing registration.

Successor proof must cover exact target, unspecified prose, explicit unit-wide scope, cross-unit/property refusal with no partial write, correction history, reader reconciliation, unchanged possession and readiness, then the actual browser path. The current fixture uses an occupied unit label but does not establish sibling possession; its post-identity assertions must not be described as a canonical sibling-possession proof. The existing seven-scenario sibling proof remains the independent possession control.
