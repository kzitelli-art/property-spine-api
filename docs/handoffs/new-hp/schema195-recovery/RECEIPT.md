# Schema 195 owned artifact recovery receipt

Date: 2026-09-13 (America/New_York)

This is a bounded, local HTTP proof that the already tested two-step leasing
API can restart on the schema-195 state and continue a retained packet after
an owned server outage. It is an owned artifact recovery proof; it does not
validate production rollback, deployment rollback, provider delivery, or a
real property journey.

The authoritative result is the fresh corrected run below. The earlier run is
retained later as superseded failure evidence and is not used for the recovery
claim.

## Fresh corrected proof (authoritative)

The exact detached product checkout was clean at API
`7cb245ead0ad02e35e29b7adebde05b2c10d1e25` before the run. A fresh owned
database was migrated from ledger 000 through migration 195 by a bounded
owned setup helper executing the exact candidate migration files in order
(including the required 087 and 110 fixture preconditions). The exact
candidate `migrations/migrate.js` was then run verify-only with
`EXPECTED_SHA=7cb245ead0ad02e35e29b7adebde05b2c10d1e25`; it reported
`SCHEMA VERIFIED — 183 migrations, all applied. Ledger ceiling 195.` The
applied final file was `195_two_step_leasing_authored_offer_basis.sql`.

The setup command was:

`node tmp/apply_fresh195.js "two-step-review-20260913/api-fable-review-20260907"`

with `DATABASE_URL` pointed at the manifest database and `NODE_PATH` pointed
at the workspace dependency `node_modules`; it is fixture setup only and is
not a product migration path. The candidate verifier command was:

`Remove-Item Env:MIGRATION_RELEASE; $env:EXPECTED_SHA="7cb245ead0ad02e35e29b7adebde05b2c10d1e25"; node migrations/migrate.js`

Runtime manifest: `tmp/schema195-fresh-manifest.json`; nonce
`7f20677e9fac4734867f1b61941d545e`; owned database
`spine_proof_7e9c4a2b6d1f0e8a3c5b7d9f` on PostgreSQL 55454; owned API HTTP
3354. The fixture run used the current
`node tests/e2e/two_step_leasing.e2e.js` exactly once with all executed-intake
flags set from startup and completed **508 passed, 0 failed, 4 observations**.
It left J4 at `resident_executed` and wrote the handoff before any outage.

Before the first stop, the following proof phase ran against the live server:

`node tests/e2e/schema195_recovery_fresh.js --snapshot`

It persisted the application, packet, offer, exact-bed, terms hash, instrument
package hash, both signer rows, all tenant/guarantor signature fields, and
zero-decision audit history in
`tmp/schema195-fresh-evidence/schema195_recovery_fresh_state.json`. The
server process was PID 14508, its cwd was the detached exact checkout, `git
HEAD` was the exact 7cb SHA, `git status --short` was empty, and `/health`
returned `ok: true` before the first stop. The snapshot identified application
`92c90486-5d83-449e-ae15-0fa50e115bda`, packet
`643cffd9-a82c-47bf-926c-bda7396317da`, offer
`7862179f-207c-4807-a2ed-ed21b47660b5`, exact bed
`e392c8b7-1ade-408e-9194-963e6f147a92`, terms hash
`bd7fccf37b0b4bc8bb45866f72c6414a44d58235f446a0ad8edad24eb762e1b6`, and
instrument package hash
`43e51b54f58c2e19614fd9b16a0040fac4a4962a4a539b4c492c708b88868b22`.

Only PID 14508 was stopped, simulating deployment unavailability after
195 was committed and before Execute. Verify-only migration was run again
with migration apply disabled. Exact 7cb was restarted as PID 23424 with the
same owned manifest and all flags, and `/health` returned `ok: true`.
Then:

`node tests/e2e/schema195_recovery_fresh.js --execute-after-restart`

returned HTTP 201 for Execute and HTTP 200 for its same-key replay. It created
exactly two decisions and one pending lease
`04dad58b-09ae-442c-9ae8-8dd0dde99cae`, then reread Application Review, the
Leasing desk, and Person Card. The pre-stop signer/field snapshot and all
immutable packet identity fields were compared before this action.

PID 23424 was then stopped. Verify-only migration was run a third time with
apply disabled. Exact 7cb restarted as PID 31700; its cwd was the detached
checkout, `git HEAD` was exact 7cb, `git status --short` was empty, and
`/health` returned `ok: true`. Then:

`node tests/e2e/schema195_recovery_fresh.js --replay-after-second-restart`

returned HTTP 200 for the original and a different idempotency key, preserved
lease `04dad58b-09ae-442c-9ae8-8dd0dde99cae`, reread all three canonical
surfaces, and preserved the one pending tenancy. The post-restart checks
compared saved tenant/guarantor/company fields, offer/hash/package, offer
author, exact lease, and the complete two-decision audit event. Audit count
remained 16; fake SMS and model log sizes were unchanged during continuation
and replay. No outbound provider was contacted.

The owned API and PostgreSQL processes were stopped after the final replay.
`Get-NetTCPConnection -LocalPort 55454,3354` returned no rows. The disposable
data directory and manifest remain as evidence; no owned runtime remains.

Supplemental verification after review used the retained fresh database and
packet only; the 508-check fixture was not rerun and no pre-stop state was
recreated. After a verify-only start (PID 22396, exact detached 7cb checkout,
listener confirmed),
`node tests/e2e/schema195_recovery_fresh_assert.js` ran two further replay
requests and saved raw output at
`tmp/schema195-fresh-evidence/schema195_recovery_fresh_replay_raw.json`.
It asserted original-before snapshot offer/hash/package, signatures and
fields, exact lease identity, sole two-decision audit event, and canonical
Review/desk/Card lease IDs; it then took a final after-replay snapshot and
asserted one pending lease, unchanged audit count 16, unchanged signatures and
decision history, and zero fake-provider log delta. This supplemental process
was stopped and the owned runtime was cleaned again.

## Superseded failed first attempt (retained for audit)

The first attempt below used the same owned boundary but started its initial
fixture server without the executed-intake flags. It is retained to explain
the justified rerun and is not evidence for recovery.

### Fixed identities and boundary

- API checkout: `recovery-proof-20260913/api-fable-review-20260907`
- API commit: `7cb245ead0ad02e35e29b7adebde05b2c10d1e25`
- branch: `codex/schema195-recovery-proof-20260913`
- app sibling considered: `two-step-review-20260913/app-fable-review-20260907`
  at `e8fe8e9c9db9df7edcf50b935cd1fb81e173eed1` (no browser/app run was
  needed for this HTTP continuation proof)
- PostgreSQL: owned loopback cluster `tmp/schema195-recovery-pg-20260913`,
  port `55454`
- database: `spine_proof_10f732ca6f2c7feca176a675`
- HTTP: `127.0.0.1:3354`
- proof manifest: `tmp/schema195-recovery-manifest.json`
- manifest nonce: `08e6e171e4072309162ca0198849f093`
- migration 195 SHA-256:
  `E5C8F9BDB382B3A36E56E9B514DB25734639500BE9579171762D37C7E28B02BB`

The owned cluster was migrated through 194 and then with the exact candidate
runner using `MIGRATION_RELEASE=1`, `EXPECTED_LEDGER_CEILING=194`, and
`EXPECTED_SHA=7cb245ead0ad02e35e29b7adebde05b2c10d1e25`. The migration applied
was `195_two_step_leasing_authored_offer_basis.sql`. Before each recovery
start, verify-only `node migrations/migrate.js` returned:

`SCHEMA VERIFIED — 183 migrations, all applied. Ledger ceiling 195.`

The repeatable command forms were:

```powershell
$env:DATABASE_URL = "postgresql://postgres@127.0.0.1:55454/spine_proof_10f732ca6f2c7feca176a675"
$env:EXPECTED_SHA = "7cb245ead0ad02e35e29b7adebde05b2c10d1e25"
Remove-Item Env:MIGRATION_RELEASE -ErrorAction SilentlyContinue
node migrations/migrate.js
node tests/e2e/schema195_recovery_continuation.js --before-stop
node tests/e2e/schema195_recovery_continuation.js --after-restart
```

The owned API process was started with `PORT=3354`, the manifest above,
`E2E_DISPOSABLE_POSTGRES=1`, `E2E_API_BASE=http://127.0.0.1:3354`,
`EXECUTED_LEASE_INTAKE_ENABLED=true`,
`EXECUTED_LEASE_PROPERTY_IDS=0439a8fe-880c-4c93-bb8f-c378e32940e3`,
`APPLICATION_INTENT_PREPARE_ENABLED=true`, the matching application and
activation property IDs, `OPERATOR_KEY=e2e-key`, and the fake SMS/model
preloads, followed by:

```powershell
node --require ./tests/e2e/proof_fence_preload.js `
  --require ./tests/e2e/fake_sms_preload.js `
  --require ./tests/e2e/fake_anthropic_preload.js server.js
```

Before binding each owned process, `Get-NetTCPConnection -LocalPort 55454,3354`
was checked; both ports were free at setup and only the owned processes bound
them. The runtime manifest records the URL, admin URL, nonce, and HTTP port.

Process chronology and identity evidence:

| stage | API process PID | identity/evidence |
|---|---:|---|
| fixture server with missing flags | not recorded | J4 handoff only; stopped before recovery server A |
| recovery server A | 25988 | exact candidate source SHA `7cb245e`; verify-only 183/195; `Property Spine API listening on 3354`; ran `--before-stop` continuation phase |
| recovery server B | 34292 | exact candidate source SHA `7cb245e`; verify-only 183/195; `Property Spine API listening on 3354`; ran `--after-restart` replay phase |
| supplemental final health start | 9204 | exact candidate product source SHA `7cb245e` plus proof-doc tip; verify-only 183/195; `/health` returned `{"ok":true,"db_time":"2026-09-13T13:13:49.259Z","build":{"build_identified":false,"commit_short":null,"resolved_from":"unidentified"}}` |

The fixture server was stopped before recovery server A. Recovery server A was
stopped after the first Execute/replay phase; recovery server B was stopped
after the post-restart replay phase. The supplemental health process was
stopped after the final replay checks.
The direct `server.js` health response cannot self-identify a commit, so the
candidate SHA above is established by the checkout's `git rev-parse HEAD` and
the migration verifier's `EXPECTED_SHA`; no build identity was inferred from
the health payload. Health was captured for the supplemental start; the two
historical recovery starts have their listener and verify-only evidence but
not a separately recorded health response.

## Journey and outage sequence

The current fixture journey was run once with
`node tests/e2e/two_step_leasing.e2e.js` against the owned database after the
195 commit. It left the J4 packet at `resident_executed` and wrote
`tmp/schema195-recovery-evidence/two_step_handoff.json`. The run recorded
400 checks passed and 8 checks failed. These were setup/run defects, not
expected behavior: J1's concurrent Execute check returned three HTTP 503
`executed_lease_intake_disabled` responses and then its section-aborted check;
J2 had the same three 503 responses and section-aborted check; the `both
leases stand` check failed because `leases: []`; J5's Execute check aborted on
HTTP 503 `executed_lease_intake_disabled`; and completion failed because
`leases: []`. The cause was the first server process being started without the
executed-intake feature flags. J4 completed through resident signatures and
wrote the handoff before those later independent sections; its persisted
application, packet, tenant/guarantor signatures, offer/hash and exact-bed
state were checked by the recovery script before its first Execute. No older
staff-assisted or no-consent workflow was used.

The proof-only phase command was:

`node tests/e2e/schema195_recovery_continuation.js --before-stop`

With the corrected executed-intake flags, this used the canonical
`POST /operator/leasing/lease-packets/:id/execute` door. It returned HTTP 201,
two decisions (`application_approved`, `company_signed`), one pending tenancy,
then verified same-key and different-key HTTP 200 replays and reread
Application Review, Leasing desk, and Person Card. The packet had application
`6860764e-d27e-4e00-bc16-61e35f3f6987`, packet
`759bcedf-453e-4280-b833-30a7e7a8ff4a`, offer
`8fbd595c-9179-466b-9d69-5f59fbc5f8fe`, exact bed
`45116a72-fcd9-4e21-adb6-b1c0e020c822`, terms hash
`4e1cc61f08f63a942ee816fb0cbef71c26086ac93e2b32c5fa742afc8576817a`, offer
author KZ `b5f18f5c-f949-4c3a-b15f-cc7442163bba`, and lease
`ebec865d-ff98-468c-98fd-59c7f6626e5f` at rent 1005.

The continuation script persisted a pre-Execute snapshot in
`tmp/schema195-recovery-evidence/schema195_recovery_state.json`: application
and packet identity fields, offer author/hash, instrument package hash, both
signer rows, every tenant/guarantor/company packet field, and the zero-decision
audit history. Its final phase compares those saved signer/field rows and
immutable values to the post-restart rows, then compares the exact post-
Execute decision event and lease identity saved by the first phase.

Only the owned API server was stopped after the signed packet was prepared;
the first stop occurred after migration 195 was committed and before the
first Execute action. The exact candidate was restarted directly with
`server.js`, with migration apply disabled, after the verify-only result above.
No SQL repair was performed between business actions. Staff session issuance
used the existing identity service; all packet, tenancy, and replay work used
After that first restart and continuation, the server was stopped again with
the owned packet already executed. A second verify-only startup of the exact
candidate then preceded this command:

`node tests/e2e/schema195_recovery_continuation.js --after-restart`

The second restart returned HTTP 200 for the original idempotency key and a different key,
preserved the same lease ID, reread all three canonical surfaces, and kept the
single lease `pending` with `economic_tenancy_activated_at = NULL`. The
`lease_packet_audit_events` count stayed 16 and the one decision audit retained
both decisions. The application, packet, exact bed, offer ID, terms hash,
offer attribution, instrument package hash, signing history, and guarantor
and tenant signatures remained unchanged.

Fake SMS and model logs were fenced. Execute and replay emitted no SMS and no
provider call; the model sentinel refused a diagnostic Ask call from the
earlier fixture run, with no external request. No outbound provider, carrier,
production database, shared database, real message, deployment, merge, or
push was used.

Cleanup: the owned API process, PostgreSQL cluster on 55454, and HTTP listener
on 3354 were stopped after the proof. A final port check returned no rows for
either port. The disposable data directory and manifest are retained as
portable evidence paths; the cluster is stopped and no shared or production
runtime remains active.

## Limits

This receipt establishes local real-PostgreSQL and local real-HTTP recovery of
one exact candidate artifact at schema 195, including continuation of a
resident-executed packet and replay of an executed packet across restart. It
does not establish a production rollback, a deployment orchestrator behavior,
the release worker's migration refusal/timeout matrix, app/browser behavior,
provider behavior, or acceptance of Skyline, Greenery, or any real tenancy.
The missing historical `/health` captures and the initial fixture-suite setup
reds remain explicit evidence limits; they do not change the independent J4
continuation result.
