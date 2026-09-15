# An explicitly named home cannot silently become another home

Baseline `932c9afafccd31f75385b1a7fc17c41deda48b32`; isolated branch `codex/exact-target-refusal-20260911`. This correction changes only the existing staff leasing target selector and its unit controls. No app, schema, readiness, publication, or provider change.

## Intention and existing owner

The staff member names the home for an application. Spine must preserve that exact intent, or clarify/refuse. It cannot replace an occupied named bed with the one free sibling, even when a later confirmation displays the substitute.

`staff_sms_action.chooseTarget` resolves the target before the existing application proposal and confirmation service. `application_target_authority` owns current property/space identity and offerability; its `SPACE_NOT_IN_UNIT` rule explicitly says not to redirect to a bed the caller did not name. The canonical authority also requires a bed choice in multi-space units, even when only one bed is marketable. A genuinely sole physical space still resolves server-side.

The defect was narrower than a missing selection system: `chooseTarget` searched only eligible targets, then on zero matches used `only_exact_target` from the recorded unit hint. An explicit occupied Bed A therefore became free Bed B. It also counted eligible targets rather than physical grain for fallback. `targetMatches` could ignore an explicit mismatching bed label when the physical count was one.

Preserved: exact `lease_offers`, prepared invitation, terms snapshot, staff authority, confirmation tokens, dated target authority and server-derived property menus. Forbidden second path: no new target/selection store or availability algorithm.

## First red and correction

Read Fable's actual test-only commit `96c0af106670810bb85e16a1f2e920f1d15d4caa` on `origin/claude/lead-to-lease-challenge-20260911`; did not rely on the old unrecoverable expected-ready harness.

Replayed its exact `tests/proofs/lead_to_lease_challenge.db.js` against owned HTTP on the baseline. `Send <prospect> the application for Unit C7-913c11a4, Bed A` produced `application_send_proposed` for `Unit C7-913c11a4, Bed B`. Overall 126 passed / 3 failed: this defect plus two sibling-readiness assertions outside this slice.

Correction:

- Explicit unit/space requests with no matching candidate cannot fall back to a hinted target.
- An explicit mismatching space label cannot be ignored by a sole-space match.
- Multiple distinct named units/beds clarify, even when only one named choice is offerable.
- Unnamed contextual fallback requires one physical rentable space, not merely one eligible bed. Whole-unit/sole-space behavior is retained.

Same HTTP challenge after restart: 127 passed / 2 failed. The named occupied-bed case now returns `leasing_clarification`, with no proposed target. The two readiness assertions remain red and are **not** claimed fixed. The exact free-bed send, wrong-property refusals, negotiated-price/changed-offer checks, public application and exact-bed lease execution continue through the same harness.

## Local proof and custody

- Existing `staff_sms_leasing_action.test.js`: eight newly demonstrated first-red controls; successor 68/68 including nine added cases, explicit free-bed positive, whole-unit positives, unit-only/multi-bed, multiple names, wrong/unavailable unit, and mismatching sole-space bed.
- All 56 configured source-governance gates pass, parent exit0; `git diff --check` passes.
- Fable harness source imported unchanged for local execution only; QB owns importing/registering that independent challenge. The modified unit suite is already part of configured source verification.
- PostgreSQL 17, literal loopback 55441; uniquely owned database `spine_proof_dbaa96b91cff47fc723e9182`, nonce `7987fb24474df4b832f88a40d42922b4`; migration ceiling 194 / 182 entries. Real migration SQL/preconditions, standard property/operating/instrument fixtures. Initial harness attempt stopped at missing operating timezone; set only the owned synthetic Skyline fixture's `operating_timezone` to `America/New_York`, matching the existing full-journey fixture, then reran the unchanged challenge.
- Owned HTTP server port3341, `proof_boundary` environment, fake SMS transport and Anthropic sentinel. No real provider/live-user request. No browser rung.
- Cleanup verified: nonce checked before stopping the owned HTTP listener; `proof_boundary` dropped the owned database; the lane's PostgreSQL cluster stopped.
- Logs outside Git: workspace `tmp/exact-target-unit-first-red.log`, `exact-target-unit-successor.log`, `exact-target-fable-first-red.log`, `exact-target-fable-successor.log`, `exact-target-gates.log`.

This is an HTTP-proven correction to staff target preservation, not a claim that prospect exact-home selection, expected-readiness planning, or launch acceptance is complete. No push/deployment.

Suggested CURRENT_STATE entry for QB: independently reproduced Fable's occupied-bed red on932c9af through owned HTTP. Existing staff target selector now refuses explicit unmatched bed/unit instead of falling back to a sibling; physical grain governs contextual fallback. Staff action68 controls pass; unchanged challenge moves126/3 to127/2, with the two readiness assertions outside scope. No schema/app/deployment change.
