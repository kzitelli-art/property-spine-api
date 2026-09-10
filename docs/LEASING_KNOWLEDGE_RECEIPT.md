# Leasing knowledge — local implementation receipt

2026-09-09. API branch `codex/temple-leasing-knowledge`, based on `48a85ab`; paired app branch `codex/temple-leasing-knowledge-ui`, based on `f2eda58`. These are successors to the September HP handoff candidates, not main and not a deployment.

## Intention and existing mechanism

Give Skyline and The Greenery reusable approved leasing answers, highlights, amenities, layouts, dimensions, photos, floor plans, Matterports, neighborhood guidance and moving-in information. Capture once; the editor, prospect context and Ask Spine use the same canonical owner.

Extended the existing property-scoped `agent_facts` writer and history. No migration, parallel store or property-specific business branches. `src/leasing/leasing_knowledge.js` owns the shared active/unexpired reader and topic vocabulary. The server derives property and approver from the session and requires existing leasing access. Replacement preserves prior records; stale replacement returns 409. The app uses its sealed live loader and clears the editor on scope/session change.

In-app Ask and the existing staff SMS governed-read route return approved text and HTTPS links from this reader. Missing topics are explicitly not established; read failure is unavailable. Work attachments, mutations and third-party send requests do not become knowledge reads. Rent, availability and financial records remain with existing domains. Follow-up rung two now reads property-approved virtual-tour wording instead of the embedded Solo tour map; no recorded tours means a general tour offer, and read failure prevents that follow-up.

## First reds and proof

Before implementation, “send me Skyline Matterport” routed to technician. Browser checks then found the gear entry hidden on desktop and a save action missing the sealed loader's `fact_key` identifier. All three were corrected and exercised again.

- Owned local PostgreSQL 17 database, full migration chain through 193, real `server.js`, existing ownership boundary, egress fence and fake SMS/model transports.
- `tests/e2e/leasing_knowledge.e2e.js`: HTTP create/read/replace/retire, stale refusal, approver identity, property separation, expired content, live access revocation, prospect context and durable staff SMS webhook/reply passed.
- `tests/unit/leasing_knowledge.test.js`: routing, access, missing/read-failure behavior, safe links and property-supplied follow-up wording passed; included in source-governance runner.
- Paired app `leasing_knowledge.browser.js`: actual app source and real local API, editor save, Ask clickable tour link, mobile editor and sign-out clearing passed. Only the pinned API origin is transformed for the local harness; no API responses are mocked. The mobile dialog scrolls to its actions.
- App team live boundary, live-first safety and 45 inline-script syntax checks passed.
- All 55 source-governance gates passed after the final production-source changes.

Local logs/screenshots are in workstation `tmp/knowledge-*`. They are evidence for this owned runtime only. Synthetic test records use recovered public tour links but do not establish the real properties' content or layout associations. No real customer SMS was sent.

## Reproduction

Read `docs/DB_HARNESS_ISOLATION.md`. Create a fresh owned database with the existing `proof_boundary.js create` workflow and explicit local administrator URL, fresh database name, localhost API port and `E2E_PROOF_MANIFEST`. Set `E2E_DATABASE_URL` to that manifest's owned URL. Never substitute a production database.

On Windows, provide `E2E_PSQL`, run `node tests/e2e/leasing_knowledge_windows_runner.js` for the migration/precondition chain, then run `node tests/e2e/leasing_knowledge_launch.js` in a separate terminal. Run `node tests/e2e/leasing_knowledge.e2e.js`. It writes an ephemeral browser session beside the ownership manifest. From the paired app, run `node leasing_knowledge.browser.js` with the same proof environment and installed Playwright Chromium. Stop the owned server and run `node tests/e2e/proof_boundary.js cleanup`; remove the ephemeral session file. The Windows launcher/migration adapter are proof helpers, not product startup paths.

## Remaining work and limits

- This is property-wide approved prose with labeled public links. It is not a structured media catalog, file upload system, per-layout geometry model or automated document ingestion pipeline. Private contracts continue through their existing authorized readers.
- Source type, approving user, confirmation/expiry and retired history persist. Document-level provenance must currently be included in the wording; this editor does not bind `source_record_id` or expose a document picker.
- Topic matching covers the tested phrasing, not every natural-language question. Existing SMS property resolution still governs identity; nickname/typo resolution has not been extended. “Skyline” in the owned fixture was an exact property name.
- Prospect context has a real DB proof; a complete model-generated prospect conversation has not been accepted here. Follow-up wording has a local unit proof, not a scheduled end-to-end delivery proof. No exact layout fit is claimed for representative tours.
- Actual Skyline/Greenery content remains in the workstation source-review and onboarding drafts. Verify conflicting policies, source freshness and canonical layout associations before publishing approved answers. No production records were seeded, migrations run remotely, branches merged, or site/API/app deployed by this change.
