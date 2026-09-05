# Legacy ingestion retirement — owner-authorized candidate

Kameron authorized retirement on 2026-09-05 after being told that no governed
source caller was found and external traffic remained unverified. This is an
intentional contract change, not a claim that production traffic was zero.
It succeeds the reviewed checkpoint `1283f40ed058d78ec271e2b05f077cc7fb618502`.
No deployment or change to operating data is authorized by this document.

The existing global operator-key gate remains first. Requests without its key
still receive 401 (or the existing 503 when the key is unconfigured). Requests
admitted by that gate receive 410, `code: legacy_ingestion_retired`, and a next
step to open Deal Setup under their signed-in property. No route-level record
lookup, upload processing, actor resolution, extraction or mutation occurs.
Ordinary global HTTP parsing/size limits still precede route handling.

The nine retired method/path pairs are:

- POST `/properties/:propertyId/ingest`
- POST `/properties/:propertyId/ingest-file`
- GET `/ingest/:runId`
- POST `/ingest/:runId/candidates/:candidateId/edit`
- GET `/ingest/:runId/bed-groups`
- POST `/ingest/:runId/group-bed-rows`
- POST `/ingest/:runId/promote`
- POST `/ingest/:runId/approve`
- POST `/deal-intakes/:id/run-rentroll`

Historical ingest runs, candidates and intake files remain in place; closing
their old HTTP readers does not delete their evidence. Shared `fileToText` and
`runIngestAuto` services remain unchanged. Canonical Deal Setup, other Deal
Intake operations and the independent leasing-basis setter remain available
under their existing contracts. Retirement does not approve pending historical
candidates or silently migrate them to canonical confirmed records.

The runner serves archived, unchanged 1283f40 in the owned disposable database.
`legacy_ingestion_retired.e2e.js` must observe key-only approval and promotion
returning 200, a persisted decision and an actual created unit without a staff
actor. Only that positive witness satisfies expected-open mode; setup failure,
timeout or a missing route fails. This is an owner-requested retirement of a
working legacy contract, so 1283f40 is the immediate before-state, not an earlier
revision that could crash from missing dependencies.

The same proof in successor mode requires nine authenticated 410 refusals and
nine anonymous 401 refusals, exact retained-row/canonical-table fingerprints
unchanged after each attempt, no model/SMS invocation, and a still-working
independent leasing-basis setter. It asserts the exact runtime SHA in both modes.
The existing authority proof additionally exercises same-property, wrong-property,
invalid-session and supplied-actor cases. Deal Setup's retained-file/restart,
review, confirmation and canonical Rent Roll proof continues to run; its old
legacy-promote assertion now requires retirement instead of actor validation.

Execution receipts belong to CI for the exact candidate SHA. Source presence
alone is not green proof, and synthetic Deal Setup receipts are not Greenery
workbook acceptance. Greenery remains local/disposable work only; no production
onboarding, invitation resend, migration, merge or provider change is included.
