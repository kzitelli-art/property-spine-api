# New HP laptop handoff — Property Spine

Prepared 2026-09-09 for local continuation on a new Windows/HP laptop. This is a
resume guide for the two named review checkouts. It contains no credentials,
private source files, database URLs, tenant data, or provider identifiers.

## What was inspected

The governing documents were read from the API candidate at inspection (the
working `CURRENT_STATE.md` is dirty and is not represented by its last commit),
alongside the complete
`docs/PHILOSOPHY.md`, workspace `AGENTS.md`, `QB_OPERATING_BOARD.md`, and
`docs/handoffs/desktop-qb-20260906/tenant-journey/PHONE_TERMS.md`. The paired app
candidate was also inspected.

At inspection, the named branches and their checked-out commit heads were:

| Worktree | Branch | HEAD | Remote-tracking head at inspection | State |
|---|---|---|---|---|
| API | `codex/claim-relay-20260907` | `9f2acff97af311e6ebdcd5e2219f8cf873894748` | same | dirty; root-owned application-target/reader and current documentation/test work is present |
| App | `codex/claim-relay-ui-20260907` | `c05ae68f6f8bc49ca4b5bd752adc928e1f4e0d88` | same | dirty; root-owned rendering/application UI work is present |

These are named branches, not detached worktrees. Do not infer acceptance from
either inspected HEAD: the dirty working files are part of the current review.
Root created the handoff branches `codex/new-hp-handoff-20260909` in
both repositories. Final product hashes are in `CHECKPOINT.md`; do
not copy the inspected heads into that role. Do not clean, reset, stash, rebase,
merge, or overwrite the current dirty work.

## Resume on HP

Install Git, Node.js (an active LTS release), Chrome/Chromium, and PostgreSQL
17.11. Clone into these exact sibling directory names because existing tests
reference them:

```powershell
git clone https://github.com/kzitelli-art/property-spine-api.git api-fable-review-20260907
git clone https://github.com/kzitelli-art/property-spine-app.git app-fable-review-20260907
Set-Location api-fable-review-20260907
git switch codex/new-hp-handoff-20260909
npm ci
Set-Location ..\app-fable-review-20260907
git switch codex/new-hp-handoff-20260909
npm ci
```

The API uses `npm ci`; its scripts are `npm run verify` (source-governance
gates), `npm test` (the pretest source gate plus a deliberately separate DB-proof
notice), `npm start` (schema verification before server start), and
`npm run verify:all` (the broader shell harness). The app is static proof
infrastructure with Playwright 1.62.1; inspect its `README.md` and `run_harness.sh`
before choosing a harness. The app has no deployable npm application bundle.

For a safe first check, run only read/local checks after the candidate changes
have been reconciled by root:

```powershell
Set-Location ..\api-fable-review-20260907
npm run verify
node tests/unit/staff_application_terms.test.js
node tests/unit/staff_sms_confirmation_refusal.test.js
node tests/unit/application_offer_terms.test.js
node tests/unit/application_terms_ask.test.js
Set-Location ..\app-fable-review-20260907
node inline_js_syntax.test.js
```

Database-backed proofs may use a newly created disposable local Postgres 17.11
cluster under the existing owned harnesses. Production databases, migrations
against production, provider/SMS/model calls, deployment, and real-user actions
remain unauthorized. Never copy `.env` or secrets into GitHub.

Portability gaps to resolve on the HP include the absolute workspace roots
`C:\Users\kamer\OneDrive\Desktop\Property Spine\api-fable-review-20260907` and
`C:\Users\kamer\OneDrive\Desktop\Property Spine\app-fable-review-20260907`, the installed Postgres bin directory (the
existing examples use `C:\Program Files\PostgreSQL\17\bin`), and the Chrome
executable path. The new browser test supports a `CHROME` environment override;
set it to the HP's executable when needed. Do not assume every older browser
harness honors `CHROME`.

## Current product position

The latest recorded local evidence is the combined phone-origin journey: owned
run `57230e9d` passed 159 assertions from phone-authored terms and confirmation
through the existing application, approval/signing, exact-bed tenancy, and
reads. The phone terms receipt records the earlier 47-assertion terms slice, the
separate 151-assertion full path, 54 source-governance gates, cleanup, and the
known limits. This is local owned HTTP/database evidence; browser/provider,
deployment, broad language, structured fees/concessions, phone revisions,
concurrent partial updates, hostile multi-application short confirmations, and
production readiness remain unproved.

The exclusion repair is newer than that receipt: root repaired the existing
`application_target_read` handling for excluded targets and app
rendering. Preserve the existing canonical reader and authorization boundaries;
do not add a parallel matcher, exclusion store, or browser-only truth. Reproduce
the current first red before editing, then run the successor and adjacent
regressions. The source review concern about the first-room overlay remains a
separate risk until freshly reproduced.

## Matching versus exclusion

These are related but different decisions and must stay separate in evidence and
UI explanations. Matching asks whether an authorized prospect's stated needs can
be compared with a specific home's governed price, availability, and turn timing
to produce a defensible recommendation. Exclusion asks why a candidate is not
eligible for the requested operation (for example occupied, contested, retired,
unknown readiness, wrong property scope, or an unavailable read). An exclusion
reason alone does not complete the owner's requested matching or ranking
outcome, and a match label must not erase an exclusion or turn unknown evidence
into a rejection that looks final. Preserve the canonical reason, provenance,
time, actor, exact unit/space identity, and the next human action.

Prospective turn planning is also distinct from present occupancy and exclusion:
future claims must not inflate current availability, and an early expected-ready
estimate cannot override an active contractual interval. Read `TURN_SELECTION.md`
and the current board before extending this seam. Automatic recommendation,
NOI optimization, turn creation, and production action are not established by
the current receipts. Broad floor data and a governed floor matching policy also
remain unproven; do not infer them from names or free text.

## Evidence and finish line

For each changed seam, keep the first-red command/result, successor result,
source-governance result, custody (commit and file hashes where applicable), and
cleanup result. A unit or source check is not DB/HTTP proof; DB/HTTP proof is not
browser proof; browser proof is not deployment acceptance. Keep failed,
timed-out, unavailable, not-established, and quiet states distinct. Preserve
literal zero and unknown values. Ask Spine must read the same canonical truth as
operating and reporting surfaces.

Before calling the work complete, root should verify the final API and app heads,
worktree cleanliness, CI against those exact commits, and the relevant browser
and owned disposable proof receipts. Update `CURRENT_STATE.md` and the board only
with evidence actually rerun. This document is a handoff aid; it does not claim
that GitHub has been updated, a deployment occurred, or any external action is
complete.
# Latest continuation: phone terms and readiness

The continuation after API19c8416 fixes phone-authored terms ignoring the prospect's dates when checking a future turn. The existing dated authority is reused; focused HTTP50 and full phone-origin journey162 pass, with54 source gates and owned cleanup verified. See ../desktop-qb-20260906/tenant-journey/PHONE_TERMS_DATES.md and the branch tip's CURRENT_STATE. Exact-space governed-price matching and Claude's prospective-turn investigation remain open. Earlier checkpoint hashes below are history; this is not a deployment.
