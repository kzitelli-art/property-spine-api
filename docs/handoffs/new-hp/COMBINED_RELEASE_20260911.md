# Combined Property Spine release — September 11, 2026

HP QB completed the owner-authorized release combining HP knowledge/matching work with the desktop fixes. Desktop is parked; HP owns integration and continuation.

## Exact live pair

| Component | Commit | Render deployment |
|---|---|---|
| API | 24f4482140bed554185fe4fdcbb7c2366a5d3c07 | https://dashboard.render.com/web/srv-d8i36kmq1p3s73e9pfq0/deploys/dep-dai3kgm743jc73dogic0 |
| Staff app | b00cf4993e4f699cd174a7ef5c8a27ca4b5507c4 | https://dashboard.render.com/static/srv-d8qhf84m0tmc73aakrn0/deploys/dep-dai3m98jo6nc73db4d4g |

Both commits are pushed on codex/hp-release-integration-20260911. API deployment triggered at 13:28:34 EDT; app at 13:32:21 EDT. Both Render pages report Deploy succeeded / Live with the exact commits above. Deploys used specific-commit selection.

## Verification

- Full configured API GitHub verify run 34627440787 independently read completed/success at exact API 24f4482: https://github.com/kzitelli-art/property-spine-api/actions/runs/34627440787 . No app Actions run returned; app proof is local plus deployed assets/browser.
- Local source, real owned DB/HTTP, paired browser and 151-assertion tour-to-tenancy proof recorded in docs/handoffs/new-hp/COMBINED_INTEGRATION_20260911.md. Its upload-blocked/no-deploy section is historical and superseded by this receipt.
- Fresh public API health at 2026-09-11T17:31:52.058Z: ok=true; commit_short=24f4482; resolved_from=render_env; started_at=2026-09-11T17:29:04.441Z.
- Preflight read-only production Neon ledger: ceiling 194, 182 entries. Render startup at 13:29:02 EDT independently verified all 182 migrations in both directions at ceiling 194. Prestart was verify-only. No migrations applied in this release.
- At 2026-09-11T17:33:00Z, all 23 first-party app files (index.html plus 22 scripts) returned HTTP 200 and matched git blobs at b00cf49 byte-for-byte. Full hashes: COMBINED_RELEASE_ASSETS_20260911.json. Index SHA256: 228be93d553e9099e944dc3f3bc437a76fca94ff567521c2edc0b1c4c2199d4f.
- Fresh public staff browser opened https://property-spine-app.onrender.com/ and displayed mobile-number sign-in. No OTP sent and no signed-in production conversation or lease action executed.

## Behavior released and limits

Staff-maintained descriptive leasing knowledge, coverage/expiry/history and Leasing-desk entry now accompany the desktop maintenance/possession fixes. App, entitled Ask Spine/staff SMS and prospect context share the canonical knowledge reader. Representative floor plans, photos, dimensions, layouts and Matterports explicitly do not establish exact-home association. Informational matching uses governed exact-space published prices.

This proves deployment, runtime/schema health and served source. Local journey proof is not full production acceptance for Mike. Exact-space durable selection, expected-ready planning, designated knowledge review ownership/reminders and approved Temple content remain unfinished. Mike's transcript remains pending. No production content load or property-identity repair was performed.

## Configuration and recovery

No Render settings changed this release. API pre-deploy command is empty; normal prestart verifies schema. App allowlist retains application-offer-review.js. Both auto-deploys remain disabled. Tracked branches remain older API codex/skyline-rc1-intake-twilio-retirement-option-20260829 and app main. Pin reviewed commits; do not Deploy latest commit.

Previous September 10 pair API 7629b63ecc7b347d62d2b95e2e9a84b206489537 / app bf86a7760ea5908a18fcf309ec4ef605c114a1c5 carries the same migration chain and remains a code-only recovery candidate if a regression warrants rollback. Do not roll back to pre-194 source or alter the ledger. No rollback performed.

Render npm install reported five existing API dependency findings (three moderate, two high); no dependency updates were included. This release does not attest dependency remediation. App build-info.js has a stale historical stamp; provider SHA and served bytes establish release identity.

Marketing propertyspine.com on Netlify was not changed. Original candidate worktrees, untracked research and complete-history bundles remain preserved.
