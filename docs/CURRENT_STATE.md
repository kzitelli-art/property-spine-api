# CURRENT STATE — what exists, and at what proof level

> # ⛔ BEFORE YOU BUILD ANYTHING, SEARCH THIS FILE.
>
> This file exists for one reason: **threads keep rebuilding things that already
> exist.** Renewals, turnovers, an obligations queue, a follow-up ladder and a
> person-correction path were each built, then later described as missing.
>
> **Search this file for the thing you are about to build.** If it appears here,
> your job is almost certainly to *extend or connect* it — not to write it again.
>
> ```bash
> grep -in "renewal\|turnover\|notice" docs/CURRENT_STATE.md
> ```

**THIS DOCUMENT DESCRIBES CURRENTLY OBSERVED CAPABILITY, NOT PRODUCT INTENT.**

| File | Answers |
|---|---|
| **`CURRENT_STATE.md`** (this) | **What exists now, and at what proof level** |
| `PHILOSOPHY.md` | What the product should mean · how to decide if a feature belongs |
| `THREAD_HANDOFF.md` | **History.** What happened, and why. Not current-state authority. |

Resolution order for any present-tense question:

```text
CURRENT SOURCE / RUNTIME  →  CURRENT_STATE.md  →  PHILOSOPHY  →  THREAD_HANDOFF
   (always wins)              (this file)         (meaning)      (history only)
```

> ### ⚠ ABSENCE FROM THIS MAP IS NOT ABSENCE FROM THE PRODUCT
> **The survey is complete as of 2026-08-20** — three waves plus four completeness
> critics covered every `src/` directory, all 176 migrations, all 292 test files, CI,
> the app repo, `server.js`'s inline routes, and `tools/`. That means gaps here are now
> *depth*, not *breadth*: ~350 capabilities are recorded, but only the decision-changing
> ones are promoted into the index below. Full detail lives in
> `docs/current-state-build/03_`, `05_` and `06_WAVE3_RESULTS.md`.
>
> **Still: if something is not listed, its state has not been established here — that is
> not evidence it does not exist.** Search the source before concluding anything is
> missing, and add what you find. Four waves each found things the previous ones missed,
> including a full CI pipeline nobody had recorded.

---

## STATE SNAPSHOT

```text
API verified against    bcd3089     2026-08-20  (github main, deployed commit)
PRODUCTION DEPLOYED     bcd3089     2026-08-20  ← confirmed by owner, RESOLVED #7
APP verified against    c6769ba     2026-08-18
Production ledger       ceiling 187 (schema)
Migrations on main      187         → matches production, resolved by PR #128
Surveyed / verified     2026-08-19 (wave 1) · 2026-08-20 (Codex PR review, AM
                        domains) · 2026-08-20 (wave 2, 148 capabilities:
                        teams/access, management door, onboarding intake,
                        money/pricing, app repo, server.js inline, tools/)
                        · 2026-08-20 (pricing fix deployed, PR #128, live)
                        · 2026-08-20 (wave 3 FINAL: migrations 001-119,
                        src/shared + governance, all 292 tests, CI reality —
                        58 findings, survey now complete)
```

✔ **RESOLVED 2026-08-20: production now runs `main`'s lineage.** Was: the
deployed commit lived only on a separate branch, 39+ commits ahead, carrying
migrations `main` lacked. PR #128 landed that branch on `main`; the owner then
deployed `main`'s head (`bcd3089`) manually from the Render dashboard and
confirmed it live directly. See defect #1 for what shipped in that deploy, and
defect #7's row for the full resolution history — kept as a record, not deleted.

**Staleness check — run this, do not trust the SHA above.** Naming a SHA in a file
is self-defeating: committing the file changes the SHA. So the guarantee is stated
as something checkable instead:

```bash
git diff --name-only 77f93f5..HEAD -- src/ migrations/ server.js
```

**Empty → every row below is current.** Non-empty → rows touching those paths are
*navigation only* until reverified. Reverify the row, then update it here.

---

## THE VOCABULARY — say the rung, never "done"

| Rung | Means | How it is earned |
|---|---|---|
| `REPORTED` | A document claims it; no code evidence found | — |
| `LOCALLY_EXERCISED` | Logic tested, **no real database** | a `.test.js` with no `pg` |
| `BUILT_BUT_DORMANT` | Code exists, **nothing calls it** | grep finds no `src/` or `server.js` caller |
| `HTTP_PROVEN` | **One** test: real Postgres **and** real router | `require("pg")` + `listen()` in the same file |
| `BROWSER_VERIFIED` | Real Chromium drives the real surface | a `*.browser.js` — *check it isn't a fake pool* |
| `DEPLOYED` | Confirmed present in the deployed build | `git merge-base --is-ancestor <sha> <deployed>` |
| `PRODUCTION_PROVEN` | **Observed working in production** | a recorded live run |

Never write *done*, *built*, *working*, *live*, *mostly done*. Those blend intent
with evidence — which is the failure this file exists to end.

**Three traps this repo has actually hit:**
- A file named `*.db.js` proves nothing. **Open it.** **Ten** files pass a hand-built
  fake pool to a real router — not the three previously named. See defect #19.
- A browser proof can run against a simulated database. **Check for `fakePool()`.**
- **A rung earned once is not a rung held.** Most `HTTP_PROVEN` and `BROWSER_VERIFIED`
  rungs in this file rest on the 68 `.db.js` proofs and 94 `*_proof.js` files — **none
  of which any automation runs** (defect #17). They passed when a human ran them. Nothing
  re-runs them, so nothing would notice if they broke. Read every rung below as *"was
  demonstrated at least once,"* not *"is continuously verified."*

---

## STRUCTURE THREAD — 2026-08-27 (file renames, server.js decomposition, tests reorg)

A structure-only thread. **No route path changed, no mount order changed, no
behavior changed by intent.** Proof: route-registration inventory extracted from
`git show HEAD:server.js` vs the new structure is set-identical (36 moved
registrations, 1:1, only `app.*` → `router.*` prefixes differ), and
`./tests/e2e/verify_all.sh` ran **ALL PROOFS PASSED** against a real local
Postgres 16 (schema built from the real migration chain via
`tests/e2e/apply_migrations.sh`) — twice, before and after the test reorg.
Browser rung SKIPPED locally (no Chromium) — same honest skip CI reports.

What moved:

| Change | Detail |
|---|---|
| 20 `src/` files renamed | fused/camelCase → snake_case: `leasingleads.js` → `leasing_leads.js`, `teamaccess.js` → `team_access.js`, `leasingShadowImport.js` → `leasing_shadow_import.js`, etc. Full list in git history. Two **pinned git-history references** inside tests (`git show <sha>:src/comms/tenantlink.js` in the conversation gates) initially corrupted by the sweep — restored; pinned SHAs keep the pre-rename path on purpose |
| `server.js` 3,648 → 836 lines | Inline blocks extracted **verbatim** per the organ pattern (docs/architecture.md): Release-0 baseline routes → `src/baseline/baseline_routes.js` (NOT `src/release0/` — that dir is the dormant activation boundary, enforced by `gate_activation_dormant.js`); lease lifecycle → `src/tenancy/lease_lifecycle_routes.js`; AI ingest pipeline + routes → `src/agent/document_ingest.js` + `document_ingest_routes.js`; space-position read → `src/tenancy/space_position_routes.js`; sms-proof → `src/comms/sms_proof_route.js`. Each mount sits at the exact line position its inline block occupied |
| `tests/` reorganized | 290 flat files moved by their existing naming conventions: `gates/` (14) · `proofs/` (68 `*.db.js` + 89 `*_proof.js`) · `unit/` (90 `*.test.js`) · `arcs/` (4) · `scenarios/` (25) · `e2e/`, `fixtures/`, `support/`, `_engine.js`, `_run_receipt.js`, `verify_source_governance.js` unchanged. Runner resolves bare names from `gates/` and slash entries from `tests/` root. CI and `verify_all.sh` needed no changes (they reference only `e2e/` + the runner) |

Rung reality check, stated honestly: the 12 e2e proofs exercise the server and a
slice of the moved routes end-to-end; the other moved routes are proven by the
inventory-identity argument plus the 38 gates, not by individual HTTP proofs.
`gate_property_creation_paths.js` caught a real extraction miss (the baseline
block's `propertyCreation` dependency) — the gate discipline is load-bearing.

**Docs-cleanup follow-on (2026-08-27, on top of the structure work):** 128
dated receipts/close-outs/candidates moved to `docs/archive/` via `git mv`;
13 living docs + all subdirectories stay at `docs/` root; `docs/README.md`
added as the index (living vs historical, with the search-first rule).
Every citation to archived files was rewritten to `docs/archive/…` — cross-repo
citations (`property-spine-app/docs/…`) were checked and left intact. Defect
#2 closed: `migrations/README.md` no longer instructs hand-run production
migrations. No doc content was rewritten or deleted; receipts are kept.

---

## SOURCE AUDIT + SIX FIXES — 2026-09-04 (every `src/` domain read adversarially, then the no-ruling fixes)

A review thread. **No migration, no schema change, no route path changed, no mount
order changed.** All 21 `src/` directories (~124k lines) plus `server.js` and the
shared core were read adversarially — six parallel reviewers, source only, nothing
executed against production.

**38 candidate defects. 19 personally re-verified** against the source and, where a
column was cited, against the migration that defines it. **The other 19 are
reviewer-reported at stated confidence and are deliberately NOT promoted into the
defect table below** — absence of a row here means unverified, not absent.

Six defect classes fixed. Every one was a single line or a wrapper, needed no
product ruling, and touched no schema:

| Fix | Rung earned | Evidence |
|---|---|---|
| `staffSessions` never imported after the 2026-08-27 split — `POST /properties`, `POST /ingest/:runId/promote`, `POST /ingest/:runId/approve` | `HTTP_PROVEN` for the refusal path (real router, real socket, **stub pool** → `LOCALLY_EXERCISED` by defect #19's own rule) | `/properties` returned `500 {"error":"staffSessions is not defined"}`; now `401 no_authenticated_actor`. Both ingest routes threw `ReferenceError` **outside** their try — an unhandled rejection that killed the process under Node 22. Falsified: reverting crashes the harness at `document_ingest_routes.js:319` |
| Both ingest session resolutions moved **inside** their try | same | Same statement, same defect class: a database call with no handler |
| `fileToText({filename:…})` where the parser reads `originalname` — Tax + Utility evidence upload | source-level; **fix not exercised** | Verified both ways in source: `document_ingest.js` dispatches on `file.originalname`, so every PDF/XLSX/DOCX fell through to `buf.toString("utf8")` and `docRead.propose()` got bytes. `artifacts.store({filename:…})` beside it is a **different** function and correctly keeps its key |
| `human_approved_at` stamped `now()` on both ternary branches | source-level; **fix not exercised** | `leasing_interactions.js` — every outbound text recorded an approval instant with `human_approved_by_user_id` null, falsifying the drafted/approved split |
| Self-claim wrote an owner onto an already-complete obligation | **`HTTP_PROVEN`** — real `pg.Pool`, real router, real socket, schema built from the real migration chain (ceiling 187) | 5/5. Falsified: without the guard a complete obligation returns `200 "Claimed."` with `status:"complete"` and an `assigned_user_id`. `operator_obligations_security_proof.db.js` 21/21 still passes, so the happy path is intact |
| Two upload doors passed multer straight in (`snapshot_loader`, `leasing_intel`) — oversize threw past the handler | `LOCALLY_EXERCISED` | Now the 413 shape every sibling door returns. Proven with a 10-byte limit over real HTTP |

**Verification run:** all **38 source-governance gates exited 0** with these changes
applied (`tests/verify_source_governance.js`). `unit/conversation_intent_extraction.test.js`
needs `HEAD~1`, so it exits 3 on a shallow clone — identical on clean `HEAD`, and it
passes once the clone is unshallowed. `tests/proofs/forward_rent.db.js` stops at
`no property with enough inventory` (exit 2) **identically on clean `HEAD`** — a
seeding precondition, not a regression.

**What this thread did NOT do:** no browser rung, nothing deployed, nothing observed
in production, and the 19 reviewer-reported findings were not re-verified. The
`property-spine-app` repo is not in this checkout, so caller absence for any legacy
route below is unproven.

---

## ⛔ KNOWN LIVE DEFECTS

| # | Defect | Evidence |
|---|---|---|
| 44 | **The rest of the 2026-09-04 audit — 19 reviewer-reported findings NOT independently verified.** Recorded so they are not lost and not mistaken for confirmed: Plaid `/transactions/sync` ignores `modified`/`removed` (pending→posted double-counts); `commitment_ledger` reads `status='published' limit 1` with no effective-date filter (migration 103 dropped the one-published index); five `lease_lifecycle_routes` schedule routes write columns migration 036 removed; date-blind occupancy on `management`/`desks`/`board`/`property_surface`/`management_read` (no `start_date`/`end_date` predicate); `future_rent_roll_facts` counts pending leases as `open_or_uncovered`; `availability_read` reads `marketable_now` for uncorroborated/unreconciled/inconclusive evidence states; `activation_service` drops duplicate natural keys with `do nothing` and counts them anyway; `deal_intake` membership routes on key-only authority with a false 201 receipt; `movein` legacy schedule accepts a foreign `lease_id`; `leasing_scheduling` fingerprint fallback merges a prospect's second appointment into the first; consumed application invitation flips to `expired` on a public read; meeting-receipt owner labels persist unresolved without a transcript check; `facts.property_id` is serialized into Ask Spine's model context; `operating_window.currentMonthWindow` throws `RangeError` instead of a 400; `xlsx@^0.18.5` carries unpatched CVEs and parses synchronously. **Open each before acting on it.** | `docs/` — this thread's report; no row here is a verified claim |
| 43 | **`POST /properties/:id/sms-number` runs `begin`/`commit`/`rollback` on the POOL, not a client.** Each `pool.query` takes an arbitrary connection, so the retire-then-insert is not atomic AND the connection that ran `begin` returns to the pool idle-in-transaction — later unrelated writes landing on it are never committed. The only `pool.query("begin")` in `src/`. | `src/comms/tenant_link.js:421` |
| 42 | **Phone-only admin invites cannot succeed.** `on conflict (phone)` needs a unique index on the bare column; `users.phone` has only the partial **expression** index from migration 035 (`regexp_replace(phone,'\D','','g')`), which cannot arbitrate `(phone)`. Postgres raises 42P10 → 500 on every call without an email. | `src/identity/org_admin.js:174`, `src/identity/super_admin.js:333`; `migrations/035_phone_first_team.sql:62` |
| 41 | **Any meeting-evidence user can re-activate a REVOKED Read AI connection.** `ensureReadAiConnection` upserts `connection_status='active'` on conflict and overwrites `provider_account_metadata`, gated only by `hasMeetingEvidenceAccess` (any of leasing/management/asset_management, or `can_manage_roles`). `authorized_by_user_id` is not updated, so the audit still names the original authorizer. | `src/meeting_evidence/meeting_evidence_service.js:379` |
| 40 | **Ask Spine gathers work-order facts with no module entitlement.** Subject `work` calls `readPropertyWorkOrderStatuses` unconditionally; the UI door for the same read requires `maintenance`. Unit numbers, titles, accountable and assigned names reach model context for a leasing-only session. `attention()` beside it gates correctly. A symptom of the composition problem PHILOSOPHY §40.8 names as unsolved — patching this one hole is not solving it. | `src/agent/ask_spine_answer.js:410`; compare `src/maintenance/maintenance.js:167` |
| 39 | **Cancel / no-show / reschedule rewrite a SETTLED tour.** `completeTourService` treats the terminal states as write-once; these three routes load the tour and call `recordTourEvent`, which sets `status` unconditionally. Cancelling a completed tour re-opens its slot; no-show turns a real tour into a no-show in show-rate. | `src/leasing/leasing_leads.js:2483`, `:2414`, `:2512` vs `:1952` |
| 38 | **Tour outcome correction can never succeed.** `recordTourEvent` inserts `tour_events.event_type='outcome_corrected'` and writes the same word to `leasing_tours.status`. Neither CHECK constraint in migration 039 enumerates it and no later migration widens them → 23514, whole transaction rolled back, 500. `operator.js:2402` renders an event that cannot exist. **Needs a ruling first:** almost certainly an event type only, with the tour staying `completed`. | `src/leasing/leasing_leads.js:2374` → `:1444`; `migrations/039_tour_scheduling.sql:85,104` |
| 37 | **A notice is written without `space_id` and read only by `space_id`.** `POST /units/:id/notice` inserts `(unit_id, property_id, event_type, effective_date, payload, source, status)`; `loadSpaceRows` selects `where ue.space_id=s.id and ue.event_type='notice_given'`. Migration 081's backfill was one-time and nothing derives it on write, so a notice succeeds and is invisible everywhere. Distinct from the recorded "never used" row — even when used it cannot be read. **Multi-space units need the same ruling migration 081 hit.** | `src/tenancy/notice.js:179`; `src/tenancy/space_position.js:253`; `migrations/081_effective_possession_and_space_grain.sql:26` |
| 36 | **`work_order_status_read` queries two columns that exist in no migration.** `persons … where id=$1 and property_id=$2` (persons has no `property_id`) and `leases l … where l.property_id=$1 and l.unit_id=$2` (leases anchor to `space_id`). `GET /operator/work-orders/:id/status` fails for any work order with a unit or an affected person. `tests/proofs/work_order_resident_projection.db.js` inserts into the same phantom columns, so it cannot be passing on a migration-built database. | `src/surfaces/work_order_status_read.js:256,271`; `migrations/001_baseline.sql` |
| 35 | **The resident portal home is dead on any post-098 database.** `GET /tenant/me` selects `work_orders.person_id`, which `migrations/098` drops unconditionally; 098 replaced it with `reported_by_person_id` + `affected_person_id`. Every verified resident gets a 500 and `init()` clears the session. 098's header claim that every reference was updated is false for this line. **Needs a one-line product call:** which of the two columns the portal means (likely both). | `src/comms/tenant_link.js:772`; `migrations/098_work_order_operational_facts.sql:85,136` |
| 34 | **One bank deposit can cash-prove unlimited payments.** Only `(payment_id, bank_transaction_id)` uniqueness is enforced; `amount_matched` is stored unvalidated (any value, negative, larger than the transaction) and never summed against `txn.amount`. Ten $500 payments linked to one $500 deposit all read `cash_proven`, inflating `income-proof.proven_collected`. **Needs an accounting ruling** on the rule before a constraint can be written. | `src/money/payments.js:273` |
| 33 | **`publishVersion` can retire a property's live pricing and replace it with nothing, then report `published:true`.** The prior version's `effective_until` is closed first; the draft `update … where id=$1 and status='draft'` carries **no property predicate**, is never compared to `receipt.reviewed_version_id`, and its row count is never checked. A wrong or foreign `draft_version_id` commits. Route passes `b.draft_version_id` straight through. | `src/money/pricing_lifecycle.js:247-288`; `src/identity/operator.js:1862` |
| 32 | **A technician texting "done" closes the manager's billback decision.** `claimCompletion` marks EVERY obligation with `related_type='work_order' and related_id=$1` as `status='complete', resolution_code='satisfied'`. `billback_decision` and the routed not-done follow-ups carry that link, so a money decision is recorded as settled with no decision row and without passing `completeObligation`. | `src/technician/lifecycle_service.js:258`; `src/maintenance/work_order_service.js:393` |
| 31 | **`NODE_ENV` is set NOWHERE in this repository, and two guards fail OPEN when it is unset.** `/auth/sms/start` returns the OTP as `dev_code` in the response body whenever delivery was not confirmed and `isProd()` is false; `property_timezone.js` honours the `PROPERTY_OPERATING_TZ_JSON` override that must never outrank the governed column. Not in the Dockerfile, `docker-compose.yml`, `deploy.sh`, `render.yaml` or `docs/deployment.md` — only commented out in `.env.example`. Whether production is safe is a Render dashboard fact no source can answer. **The guards should require an explicit non-production opt-in rather than trusting an unset variable.** | `src/identity/team_access.js:67,425`; `src/shared/property_timezone.js:35,41`; `Dockerfile`; `.env.example:25` |
| 30 | **Cross-organization account takeover through the org-admin invite.** `POST /org/users/invite` upserts `on conflict (email) do update set … phone = excluded.phone, organization_id = excluded.organization_id, is_active = true, status = 'active'` with **no check that the existing user belongs to `req.orgId`**. An org admin submits another organization's user email with their own phone: the victim moves organizations, is reactivated, and their sign-in number is overwritten. `/auth/sms/start` then selects by `users.phone` and any active assignment, so the OTP arrives at the attacker and mints a session scoped to the victim's property. `super_admin.js:318` has the same shape at a trusted role. **Needs a ruling** on what a legitimately shared person across orgs should do. | `src/identity/org_admin.js:159`; `src/identity/team_access.js:298` |
| 29 | **LOCAL DEV, 2026-08-28 — docker-compose path validated end to end, app repo included (was broken; see #22/#28 for the API-side blockers).** The compose stack is now `db` + `migrate` (one-shot local schema release: reads the local ledger, releases with that ceiling, applies canonical precondition fixtures on data-dependent stops, guarded to local-dev connection shapes) + `api` (`OPERATOR_APP_ORIGIN` overridden to the app's local origin — `/operator/*` CORS allows exactly that, proven by preflight) + `app` — the sibling `property-spine-app` checkout served on :8080 by `tools/dev_static_server.js`, which rewrites the app's hardcoded production API origin to `http://localhost:3000` so a local browser lands on local data; the app repo itself is untouched, and its `localStorage.ps_api_base` override still wins if previously set. Dockerfile installs from the lockfile (`npm ci --omit=dev`) instead of resolving at build time. All proven against a real fresh volume: ledger ceiling 187, `/health` ok, app served with origin rewritten (4 occurrences), traversal guarded 403, second `up` idempotent. **Class-2 scaffolding** — removal conditions stated in the two `tools/dev_*.js` files. **Recorded, not chased:** the api repo root carries a git-tracked 745KB `property-spine-app` HTML snapshot (stale since 2026-07-07, purpose unexplained — already an open question in `docs/archive/MAINTENANCE_UNIT_STATUS_SOURCE_COMPARISON.md`); compose deliberately uses the real sibling repo, never that file. | `docker-compose.yml`; `tools/dev_migration_release.js`; `tools/dev_static_server.js`; `docs/deployment.md` (Docker Compose section rewritten to match reality) |
| 28 | ~~`migrations/migrate.js` hardcodes SSL, so `--apply` cannot build a schema on a local non-SSL Postgres.~~ The runner now takes its answer from `databaseSsl()` (the exact fix this row prescribed), and `database_ssl.js` also honors an explicit `sslmode=disable` in the URL — the compose service name `db` is not a loopback host, so the URL itself declares no-SSL; pinned by a new case in `gate_ci_path_ssl.js`. Production (Neon, `sslmode=require`) unchanged. Adjacent same-class fix made and said so: `src/onboarding/import_rent_roll_truth.js` had the identical hardcoded object and sits in the local-dev blast radius (rent-roll import). | `migrations/migrate.js` (client uses `databaseSsl(url)`); `src/shared/database_ssl.js` (`sslmode=disable` case); `tests/gates/gate_ci_path_ssl.js` (new case); `src/onboarding/import_rent_roll_truth.js` |
| 1 | **DEPLOYED, 2026-08-20 — NOT YET `PRODUCTION_PROVEN`.** ~~The leasing agent quotes `units.market_rent` directly to prospects~~ — fixed (PR #128), and now live in production at commit `bcd3089` (main's head at deploy time), deployed manually from the Render dashboard, confirmed live by the owner directly. **Deploying is not proving** — nobody has yet asked the live agent a price question and observed a governed answer or an honest handoff. That single observation is what moves this row to `PRODUCTION_PROVEN`; until then it stays at the rung the e2e proof earned. | `git show origin/main:src/agent/agent.js`; deploy confirmed by owner |
| 2 | **RESOLVED, 2026-08-27 — docs-cleanup thread.** The named falsehood (*"Safe to run as many times as you want"*) had already been fixed by an earlier thread at `migrations/README.md:39-44`. The second half — the **"How to run a migration"** section still instructing hand-run production migrations (`node migrate.js` against production) with a false *"it undoes that migration and stops"* rollback claim — is now rewritten to the real ceremony: verify-only on boot, and the release-gated `--apply` act. The migration-001-era planning prose below it is marked as history and explicitly not to be followed. `docs/deployment.md` remains correct (fixed earlier). | `migrations/README.md` — "How migrations actually run" section now matches the release gate; historical sections labeled |
| 3 | **An operator screen calls routes that 404.** A whole activation flow written, never mounted. | `src/identity/activation.js`; `grep -c "identity/activation" server.js` = **0** |
| 4 | **A test defaults to hitting PRODUCTION**, with no run receipt anywhere. | `tests/arcs/full_lifecycle_arc.js:47` |
| 5 | **Ask Spine has two obligation readers** (§7 violation). Its own header: *"Its QUERY LOGIC is sound and is re-expressed here."* | `src/agent/ask_spine_service.js` |
| 6 | **The §40.11 gate scans 2 of ~15 domain dirs** — `["src/asset","src/tenancy"]`. Leasing, applications, maintenance, technician, comms, obligations, money, onboarding, **and now `src/meeting_evidence/`** cannot fail it. | `tests/gates/gate_ask_spine_readers.js:100` |
| 7 | **RESOLVED, 2026-08-20 (PR #128).** ~~Production does not run `main`~~ — the branch production was deployed from (`30cb992`) is now confirmed an ancestor of `main`, and `main`'s migration files run through 187, matching what's reportedly released to production. `main` should now boot cleanly against the live database. **Not yet re-verified end to end after this merge** — the next real deploy is the actual test of this, not a git check. | `git merge-base --is-ancestor 30cb992 origin/main` → **YES** (was NO as of 2026-08-19/20 morning) |
| 8 | **A signed-in operator's Invite button silently fakes success.** The app only calls the real invite route `if(key())` — a hidden, `aria-hidden` field populated *only* from an internal-only key in `localStorage` that the real SMS sign-in flow never sets. Without it, the button pushes a fake row and shows: *"Demo invite pending locally. Add an operator key to create a live invite."* This is the exact mechanism behind "no staff member other than the account owner has ever completed a real invite," and it's a direct violation of CLAUDE.md's own non-negotiable — *"Never fixture-fallback... in a signed-in operator workflow."* | `main-app/index.html:12152-12178` (`inviteTeamMember`), `:5953` (`#opKey`), `:8024` (`key()`) |
| 9 | **The team roster read has no property-scope check — unlike every sibling route in the same file.** `GET /properties/:id/team` sits behind the shared `x-operator-key` gate (not public), but performs *no* staff-session resolution and *no* check that the key-holder has any relationship to the `:id` in the URL. Any operator-key holder can read any property's full roster — names, phones, emails — by changing the URL. | `src/identity/team_access.js` — roster handler, compare to `my-access`'s enforced *"BRICK ONE property wall"* two routes below it |
| 10 | **Two inbound Twilio SMS webhooks, two different security postures.** `/communications/inbound-sms` documents itself as fail-closed on signature verification. `/intake/twilio` (a second, separate webhook) is gated only by a phone-number allowlist (`INTAKE_ALLOWED_NUMBERS`) — no signature check found. | `src/onboarding/intake.js:220` vs `src/comms/communications_boundary.js` |
| 11 | **`CLAUDE.md`'s own deploy description doesn't match reality.** States *"Deploys to Render on merge to main,"* which reads as automatic push-to-deploy. The actual mechanism is `deploy.sh` — a manual script calling Render's API directly, run by a human. If it's meant to be automatic, it currently isn't. | `deploy.sh` vs `CLAUDE.md`'s "Repo orientation" section |
| 12 | **RULED 2026-08-20 — ACCEPTED AS INTENDED, WITH A REVISIT TRIGGER.** ~~A real hole in published-pricing immutability~~ — `delete from properties` cascades through the freeze that direct term deletion correctly refuses. Owner's ruling: **allow it for now.** Deleting a property should delete its pricing. **Revisit trigger, stated by the owner: "when we start dealing with more real properties."** Recorded rather than closed, because the day that trigger fires, this becomes a schema change nobody will remember was a deliberate choice. | `tests/e2e/agent_pricing_wall.e2e.js` teardown comments |
| 13 | **CLAIMED, NOT STARTED — open for either party.** Four falsification tests are pinned to a hardcoded demo UUID and nothing runs them. Verified red before AND after the pricing fix, identically, by stashing. `claude/property-spine-orientation-cso2ao` claimed this then spent the time on deploy support instead. Say who's taking it before starting, to avoid duplicate work. | `tests/` — unnamed in the report, flagged for follow-up rather than fixed |
| 14 | **RULED 2026-08-20 — READY TO BUILD, NOT YET BUILT.** Owner's ruling: **the base term is 12 months. Always start there.** So `quotablePricing()` must select the 12-month term when a prospect names none — not `terms[0]`, which sorts shortest-first and is therefore the *most expensive* on a sheet with short-term premium pricing (Skyline's fall ~5mo ≈ $900/bed vs. full-year 12mo = $750/bed). The chosen term is already disclosed downstream (`agent.js:515` states the month count with the rent), so quoting the 12-month rate and naming it is a complete answer. **Simpler than the options considered** — needs no "primary term" data-model change, since 12 months is a universal business rule the adapter can select directly. ⚠ **One sub-decision this ruling does not settle — see #27.** | `src/agent/pricing_adapter.js` ~line 101 |
| 14b | **A THIRD OPTION FOR #14, FOUND WHILE VERIFYING THE DEPLOY: the menu already exists.** `effective_pricing.js:399` — when no term is supplied it does not just refuse, it returns `published_terms`, the sorted list of every term actually on the sheet, specifically so a caller can present the choice instead of guessing. Its own comment: *"With no term supplied the answer is the published menu."* This means a third ruling option for #14 beyond "refuse" or "add a primary-term data field": **have the agent present the published menu and ask which term the prospect wants** — reusing data that already exists, no schema change. Still the owner's call, but the cheapest option to build. | `src/money/effective_pricing.js:399` |
| 27 | **⚠ OPEN SUB-DECISION from #14's ruling: what if a property publishes no 12-month term?** The ruling is "always start at 12 months," but nothing guarantees every published sheet contains one. The adapter needs a defined answer for that case. Two safe options: **fall back to presenting the published menu** (`effective_pricing.js:399` already returns it), or **refuse and hand off** (matching `effective_pricing.js`'s own `lease_term_not_selected` precedent). What it must NOT do is silently fall back to `terms[0]` — that reintroduces exactly the defect #14 exists to close. Cheap to decide, and whoever implements #14 will hit it immediately. | `src/money/effective_pricing.js:99,399` |
| 15 | **RESOLVED, 2026-08-20 — a real privilege-escalation path is now closed.** `orgchart.js` could previously create `owner`/`asset_manager` roles — pricing authority (see #14) among them — through a route gated only by the shared `x-operator-key`, with **no person-level check and no actor recorded**. Landed in the same deploy as defect #1's fix (45 commits, 9 runtime files, zero migrations). Measured on a disposable DB by the reporting thread; not yet independently re-verified against production by me. Kept as a record, not deleted, per this file's own rule. | `src/surfaces/orgchart.js`, `src/identity/authority_resolution.js` — `ASSIGNABLE_ROLES = new Set(["owner", "asset_manager"])` confirmed on `main` |
| 16 | **RESOLVED, 2026-08-20.** ~~A live production database credential was pasted into a chat session during this work~~ — rotated (Neon → Roles → `neondb_owner` → Reset) and `DATABASE_URL` updated in Render. Owner-confirmed directly; not independently verified — no thread working this file has Neon or Render dashboard access to check. If anything else in either repo still references the old credential (a cached env file, a CI secret, a local `.env`), it would now be stale rather than dangerous — worth a quick sweep if one hasn't happened, not urgent. | Reported and resolved directly by the owner, 2026-08-20 |
| 17 | **⚠ THE SINGLE MOST IMPORTANT ROW IN THIS FILE — what CI does and does not cover.** Stated in both directions, because two wave-3 agents contradicted each other and **both were partly right**. ✅ **A real CI pipeline exists and is genuinely strong**: `.github/workflows/verify.yml` runs on every push, provisions a real PostgreSQL 16 container, drops and rebuilds the database from the migration chain, boots the real `server.js`, installs real Chromium, and runs `tests/e2e/verify_all.sh` — 12 e2e proofs plus a browser rung plus 37 source-governance gates. It passed **17/17 on current `main`**. No survey wave before this one had recorded that it exists, which is its own finding. ❌ **But it covers a narrow slice**: it runs **48 of 313** test files. **All 68 `.db.js` real-Postgres proofs are never run** — they require `HARNESS_DATABASE_URL`, which `verify.yml` never sets, so they would refuse rather than run even if invoked. **All 94 `*_proof.js` files are never run.** Those two populations are the evidentiary basis for nearly every `HTTP_PROVEN` rung in this document. **255 of 292 top-level test files are invoked by nothing.** **RULED 2026-08-20: get them running automatically.** Owner's decision. Safe to do now precisely because #18 was ruled the other way — red informs, it cannot block. Expect a wave of failures on first run: some of these have never executed in CI, and two are already proven permanently dead (#21). That first red is the point — it is the backlog becoming visible. | `.github/workflows/verify.yml:108-109`; `tests/e2e/verify_all.sh:43-98`; `tests/verify_source_governance.js` GATES array (37 entries); `ls tests/*.db.js` = 68, zero referenced by any runner |
| 18 | **RULED 2026-08-20 — DELIBERATE, NOT AN OVERSIGHT.** `main` is not branch-protected, so a red CI does not block a merge. Owner's ruling: **not yet.** Recorded so nobody "fixes" it as a bug later without knowing it was a choice. ⚠ **This ruling makes #17 cheap and safe**: wiring the unrun tests into CI can only inform, never block a merge — so turning them on carries no delivery risk today. If branch protection is ever turned on, revisit #17's status first. | GitHub branches API — every branch sampled returns `"protected": false` |
| 19 | **The fake-pool population is 10 files, not 3.** Seven were previously unnamed. Definition: a real Express router on a real socket driven by real `fetch`, with a hand-built object passed as `pool` and no `require("pg")` in the file. All ten opened and confirmed individually. Includes `ask_spine_http_proof.js:61` (`const pool = { async query(...) }` mounted at `:99` against *"the REAL router"*). Any rung resting on one of these is `LOCALLY_EXERCISED`, not `HTTP_PROVEN`. | wave 3 census; `docs/current-state-build/06_WAVE3_RESULTS.md` |
| 20 | **47 test files are pinned to a hardcoded demo property UUID; 42 never create it, and no migration inserts it.** `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` ("Property Spine Demo Building"). The migration chain only references or `UPDATE`s it — never inserts. So 42 files must find a row that nothing in the repo guarantees exists. **This supersedes defect #13's "four dead tests"** — that was the visible tip; the real number is 47 pinned, 42 unguaranteed. | `src/surfaces/owner.js:171`; `src/leasing/demo_preflight.js:20`; migrations 073/087/123 reference-only |
| 21 | **PROVEN DEAD BY EXECUTION — two test files can never pass again.** `tests/proofs/pricing_guards_proof.js` asserts a guard is ABSENT at `git show HEAD:` — valid only while the fix sat uncommitted; the fix is now at HEAD, so four assertions are permanently false. `tests/proofs/operator_language_proof.js` bounds a diff against pinned SHA `62b25e8` and asserts *"exactly one migration file added"* — 61 have landed since. Both are database-free and were **re-executed verbatim at `b7720b2`** to confirm, not inferred. | `tests/proofs/pricing_guards_proof.js:33,47`; `tests/proofs/operator_language_proof.js:428,439-443` |
| 22 | **RESOLVED, 2026-08-28 — docker-local-dev thread.** ~~The documented from-scratch schema build does not work.~~ Two distinct blockers, both now closed by execution: (1) the self-recording migrations 083/084 collided with the runner's own ledger insert — the runner now defers to a row the file itself recorded (`on conflict do nothing`), which also makes a fresh build's ledger shape identical to production's (normalizer accepts both spellings); (2) the data-dependent migrations 087/110 stop by design on an empty database — the canonical precondition fixtures in `tests/e2e/preconditions/` are now applied by the compose local-dev release too, not just CI's `apply_migrations.sh`. **Proven:** fresh `docker compose` volume built from empty through the governed runner — 175 migrations, ledger ceiling 187, API verified and booted against it. | `migrations/migrate.js` (ledger insert defers to self-record); `tools/dev_migration_release.js` (resume loop); migrate logs: "local schema release complete — the volume now matches this build" |
| 23 | **The app repository has no CI at all.** No `.github` directory, no workflow files. Its **23 browser proofs and 34 test harnesses run only when a human runs them** — including every browser proof backing a `BROWSER_VERIFIED` rung in this file. | `main-app/` — no `.github`; `ls *.browser.js` = 23 |
| 24 | **`property_controls` — a complete compliance/licensing schema built in migration 001 that the Compliance domain built again in migration 168 never mentions.** Zero references in `src/` or `server.js`. Three sibling tables from `001_baseline.sql` are also fully orphaned: `bids`, `documents`, `inventory`. **This is the exact "rebuilt what already existed" failure this whole document was created to stop — found in the schema, 167 migrations apart.** | `migrations/001_baseline.sql` vs `migrations/168_compliance_canonical_truth.sql` |
| 25 | **51 of the 65 environment variables the code actually reads are documented nowhere.** `.env.example` documents 15. Several already known to change real behavior (`EXECUTED_LEASE_INTAKE_ENABLED`, `COMMITMENT_LEDGER_MODE`, `DEMO_MODE`). Which properties have which capability enabled is knowable only by reading the live Render dashboard against seven separate source files. | `grep -o "process\.env\.[A-Z_]*"` across `src/`, `server.js`, `migrations/` = 65 distinct; `.env.example` = 15 |
| 26 | **`DEMO_MODE` boot hook writes durable rent-roll data while bypassing the synthetic-data perimeter its own sibling routes enforce.** In `src/shared/`, beside a fixture-injection door wired to a button in the signed-in operator UI. Directly contradicts the non-negotiable *"Demo data may exist. Demo paths may not."* | `src/shared/` — see `06_WAVE3_RESULTS.md`; `src/shared/synthetic_data_perimeter.js` |

**Correction, not a new defect — the exclusion wall is better than earlier feared, for one route.** `tests/proofs/phase_zero_property_boundary.db.js` genuinely proves, with real Postgres and real HTTP, that a second real user without a property assignment is refused by the property-switcher (`GET/POST /operator/properties[/select]`). The earlier "only tested from inside" concern was wrong for *that* route — but confirmed true, and worse than described, for the roster route above (defect #9): not "only tested from inside," not tested at all, and structurally missing the check its own sibling routes have.

---

## PRODUCTION-PROVEN — the whole list

| Capability | Evidence |
|---|---|
| **Work-order completion guard** | `activation_id d93b08dd-c682-46d2-acf9-78ab6b960827` · `2026-08-12T01:49:57.866Z` · 16/16 on live instance `kbtb6` · irreversible |
| **Migration release gate** | Runs on every boot via `prestart`; deployed sha enforces `EXPECTED_SHA` and refuses on mismatch |
| **Meeting Evidence webhook ingress** (narrow) | Real delivery `c5cb8d0d-…` authenticated + retained byte-for-byte for a real provider meeting. Proves ingestion, not the pipeline downstream of it |
| **Meeting Evidence binding + finality + rejection lineage** (narrow) | A real meeting bound to a real property, qualified final; three model rejections durably retained with no receipt |
| **Meeting Receipt extraction advancement** (narrow, ×2) | Two real specimen runs each cleared one more validation gate post-deploy — proves the gate moved, not that a receipt was produced |

**Five rows above say "narrow" on purpose.** Each is a real, specific, falsifiable
production observation — not a green test suite. None of them means "the feature
works end to end." The Meeting Receipt pipeline specifically has **zero accepted
extractions and zero receipts produced**, despite three of its five entries here
touching production. Say precisely what was observed; do not round up.

Everything else in this document is **at best deployed, not observed.**

---

# THE INDEX

Grouped by where the code lives — a fact, not a taxonomy. Taxonomy is deliberately
unsettled; do not invent one while adding rows.

## Asset Management — `src/asset/`

**PR-level detail below courtesy of a direct review by the engineer who worked these
PRs (Codex), 2026-08-20 — spot-checked by me: schema tables, gate scan dirs, `debt`
registry state and the migration-181 header all confirmed exactly against the
deployed commit `30cb992`. One quoted phrase (*"does not send email"*) did not
resolve against any file I could reach — likely a runtime log or PR description
outside this tree, not treated as confirmed.**

| Capability | Rung | Ask Spine | Files / note |
|---|---|---|---|
| Compliance | `HTTP_PROVEN` + `BROWSER_VERIFIED` | registered | `compliance_*.js`. **The model to copy** — real request + real DB + real browser. Unchanged by recent AM PRs |
| Utilities | `LOCALLY_EXERCISED` ⚠ | registered | `utility_*.js`. Registered but **never proven end-to-end** — HTTP test uses a fake pool; DB test skips the router. Unchanged by recent AM PRs |
| Contracted Services — canonical domain | `LOCALLY_EXERCISED` ⚠ | registered | PRs #104/#105/#107. `contracted_service_http.test.js` uses `pool = { async connect() { return client; } }` — real Express, **fake pool**. Migrations 171/172 released, present in `30cb992`. Docs: *"evidence-backed population rehearsal, not a production canonical write"* |
| Contracted Services — overview integration | `LOCALLY_EXERCISED` | registered | PR #113. `asset_management.js` now consumes the standing projection; **PR supplied no real HTTP/DB proof for the integration itself**. Underlying end-to-end gap unchanged |
| Insurance | `HTTP_PROVEN` + `BROWSER_VERIFIED` | **none** (`pending`) | `insurance_*.js`. *"NEVER seen on a production page by an entitled account"* |
| Tax (Philadelphia) | `HTTP_PROVEN` + `BROWSER_VERIFIED` | **none** (`pending`) | `tax_*.js`, `philadelphia_tax_rules.js`. Clocks only, never amounts |
| Debt — canonical truth | `HTTP_PROVEN` | registered (PR #113) | PR #108. `debt_routes_http.db.js`: real `pg.Pool`, mounts the real AM surface, real `listen()`. Migration 173 released; production establishment recorded **21 source-backed rows**. No authenticated production-route receipt observed. *"THERE ARE NO WRITE ROUTES, AND THAT IS DELIBERATE."* Comparison/causal explanation unclaimed |
| Debt — Ask Spine reader | `LOCALLY_EXERCISED` | registered | PR #113. `debt_ask_spine.test.js` uses hand-built fake services/reader + fake model — **no real DB or HTTP route in this test**, despite the domain being registered |
| Equity — canonical domain | `HTTP_PROVEN` | registered | PR #114. `equity_routes_http.db.js`: real `pg.Pool`, real router, real socket, canonical writers, serialized reads. Migration 174 released; **zero production rows, correctly** |
| Equity — Ask Spine reader | `LOCALLY_EXERCISED` | registered | PR #114. Test *"FAKES THE SAME TWO FUNCTIONS THE CAPITAL STACK UI CALLS"* — no real Ask Spine HTTP/DB proof |
| Equity — ownership reconciliation | `LOCALLY_EXERCISED`/`HTTP_PROVEN` split | registered | PR #114. Real Postgres proves a 77.57% schedule stays `INCOMPLETE` (`equity_position_falsification.db.js`); the real-HTTP test only proves the `NOT_ESTABLISHED` case, not populated reconciliation. *"`accrued_preferred_return` is always `NOT_ESTABLISHED` for every preferred position, unconditionally, for Build 1."* Governing source clause pending |
| Funding boundary wall | enforced | — | `tests/gates/gate_funding_boundary.js` — tax/insurance funding cannot cross into economics |

## Leasing lifecycle — `src/{leasing,applications,tenancy,onboarding}/`

**None of this is registered with Ask Spine** — the gate cannot see these directories.

| Capability | Rung | Files / note |
|---|---|---|
| **Deal Setup / Opening Tenancy** | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `deal_setup_http.db.js` **spawns real `server.js`**, real socket, restart persistence. **Best-proven capability in the repo** |
| Lead intake | `LOCALLY_EXERCISED` | `leasing_leads.js` |
| Tours / appointment attribution | `LOCALLY_EXERCISED` | `appointment_attribution.js`, `appointment_journey.js`, `tour_outcome.js` |
| `tour_chips` · `capture_chase` · `capture_receipt` | `BUILT_BUT_DORMANT` | **no caller in `src/` or `server.js`** |
| Post-tour conversion rail | `LOCALLY_EXERCISED`; one seam `HTTP_PROVEN` | `leasing_conversion.js`. **BLOCKING ruling open** on `conversation_owner_user_id` |
| AI Leasing Strategy | `LOCALLY_EXERCISED` | ⚠ docs say *dormant*; code is wired into the live first-response path (`leasing_leads.js:614`). **Unresolved** |
| Leasing Desk | `LOCALLY_EXERCISED` | `leasing_desk.js`, `leasing_desk_loader.js`. Handoff claims HTTP proof; file inspection contradicts it |
| Application submission / lifecycle | `LOCALLY_EXERCISED` | `application_lifecycle.js`. **Migration 125 does not exist** (124→126) |
| Application target authority (unit/bed) | `LOCALLY_EXERCISED` | `application_target_authority.js`. Unit with >1 space → 409 refusal |
| Proposed terms | `LOCALLY_EXERCISED` | `proposed_terms_service.js` |
| **Lease packet / e-sign** | `LOCALLY_EXERCISED` | **NO E-SIGNATURE EXISTS.** *"does NOT capture a legally-binding signature"* |
| **Executed lease intake** | `LOCALLY_EXERCISED` | **SWITCHED OFF** — 503 unless `EXECUTED_LEASE_INTAKE_ENABLED=true` **and** property allowlisted |
| Tenancy anchor (countersign / confirm-term) | `LOCALLY_EXERCISED` | Fails closed 409 `executed_lease_required` |
| **Pending tenancy creation** | **DOES NOT EXIST** | Confirm hard-codes `lease_status='active'` (`activation_service.js:696`). The phrase appears nowhere in either repo |
| **Active tenancy activation** | `DEPLOYED` | `POST /operator/leasing/leases/:leaseId/activate-tenancy`. Real, works, byte-identical at deployed sha |
| Move-in gates / economic tenancy | `LOCALLY_EXERCISED` | `movein.js`, `economic_tenancy_service.js` |
| Lease void | `LOCALLY_EXERCISED` | **No HTTP route** — ops tool only. Six stuck leases once needed raw SQL |
| Notice to vacate | `REPORTED` | *"built and never used… Live count across the whole database: 0"* |
| Dated / space position | `LOCALLY_EXERCISED` | `dated_positions.js` — *one service, four interpretations*. Most depended-on primitive |
| Renewals | `LOCALLY_EXERCISED` | `renewals_read.js`, `renewal_lifecycle.js`. **No renewal writer.** No browser proof exists |
| `followup_ladder` / `followup_runner` | `BUILT_BUT_DORMANT` | *"DORMANT. Nothing calls this yet. It decides; it cannot send."* |

## Operations — `src/{maintenance,technician,comms,obligations}/`

⚠ The obligation **engine** is `src/shared/obligation_engine.js`, **not** `src/obligations/`
(which is only the authenticated HTTP door).

| Capability | Rung | Files / note |
|---|---|---|
| **Release 0 completion guard** | **`PRODUCTION_PROVEN`** | `proof_evaluation_service.js` + migration 137/140 |
| Work order creation / lifecycle | `HTTP_PROVEN` | `work_order_service.js`. *"the REAL server.js over real HTTP"* |
| Technician SMS operations loop | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `technician/conversation.js`, `lifecycle_service.js` + screenshots |
| Operator work-order actions | `HTTP_PROVEN` | `operator_actions.js` — 4 canonical writes; "Review" deliberately excluded |
| **Obligations queue + self-claim** | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `GET /operator/obligations`, `POST .../claim`. **Exists — do not rebuild** |
| **Turnovers / move-out** | `HTTP_PROVEN` | `turnover_service.js`, `operator_turnover.js`. **Exists — do not rebuild** |
| Unit triage · turn scope · work acceptance · readiness | real-DB service layer, **no HTTP harness** | `unit_triage_service.js`, `unit_turn_scope_service.js`, `work_acceptance_service.js`, `readiness_service.js` |
| Communications boundary | `HTTP_PROVEN` (line layer) | **SMS RAIL FROZEN** — *"no `operations` line row at all"* |
| Tenant link (resident SMS) | `HTTP_PROVEN` | `tenant_link.js` |
| Move-in delivery correlation | `LOCALLY_EXERCISED` | `delivery.js` — test uses a **hand-mocked** `client.query` |
| Prospect fact capture | `LOCALLY_EXERCISED` | `prospect_capture.js` |

**OPEN:** *"a canonical completion through `claimCompletion`, with real proof, end to
end — needs a real technician SMS completion."* The guard is proven; the writer
producing a valid completion through it is not.

## Platform / core — `src/{identity,entity,money,evidence,agent,release0,surfaces}/`

| Capability | Rung | Files / note |
|---|---|---|
| Staff session / server-derived authority | `HTTP_PROVEN` | `staff_session_service.js`. *"The caller never supplies role, modules, TTL, or entitlement"* |
| Property creation | `HTTP_PROVEN` + `BROWSER_VERIFIED` | Single-path enforced by `gate_property_creation_paths.js` |
| Legal entity primitive | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `legal_entity_service.js` |
| Ask Spine (slices 1–2) | `HTTP_PROVEN` | Gathers: `attention, work_orders, compliance, utility, contracted_service, equity, tenancy, debt`. ⚠ *"`references[]` IS NOT IN PRODUCTION"* |
| Asset Management shell | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `asset_management.js` 260/260. Property Expenses **capped** — can never read `established` |
| Money events / accounting | `HTTP_PROVEN` | `money.js`, `bank_bridge.js`, `plaid.js` — lifecycle-arc harnesses only |
| Governed pricing & charges (~26 files) | mixed | *"Everything else economic is **unpublished**."* `$99` admin fee **BLOCKED on one ruling** |
| `concession_schedule_compiler` | `BUILT_BUT_DORMANT` | *"ACTIVATES NOTHING"*; `free_rent_period` *"SPECIFIED BUT NOT IMPLEMENTED"* |
| `economic_adapter` · `pricing_adapter` | `BUILT_BUT_DORMANT` | *"DARK BY CONSTRUCTION."* **See defect #1** |
| `src/identity/activation.js` | **DEAD** | Never mounted; app screen 404s. **See defect #3** |
| Slice 9 market evidence | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `evidence_projection.js`. Rent Survey / Listings permanently `not_connected` |
| Conversational seams (5 pure files) | `LOCALLY_EXERCISED` | `intent.js`, `clarification.js`, `receipt.js`, `technician_intent.js`, `work_reference.js` |
| A2P legal pages | `HTTP_PROVEN` | Header records a real incident: *"BOTH campaign-required URLs returned 404 in production"* |
| Board / desks / management / portfolio reads | `HTTP_PROVEN` (mounted) | `desks.js`: *"NEVER a fake number"* |

## Recently landed — `src/{meeting_evidence,tenancy}/`, migrations 175–181

| Capability | Rung | Note |
|---|---|---|
| Meeting Evidence (Read AI webhook ingress) | **`PRODUCTION_PROVEN`** ↑ | Wave 1 found `BUILT_BUT_DORMANT`, waiting on a signing key. **Superseded** — per Codex PR #115 direct review, spot-checked against schema at `30cb992`: a real webhook delivery (`c5cb8d0d-c5ab-401b-9d38-67a75787b28c`) was authenticated and retained byte-for-byte for provider meeting `be96f9ac-5996-4271-84a2-7098801d4fc4`. Initially unbound, zero downstream writes — narrow proof, not "the feature works end to end." Migration header: *"It does NOT wire transcripts into Ask Spine."* Not registered |
| Meeting Evidence — binding, finality, rejection lineage | **`PRODUCTION_PROVEN`** (narrow) | PR #118, migration 181. The authentic meeting above was manually bound to a real property, qualified final, and three rejected model attempts were durably retained with no receipts/writes. Gate still does not scan `src/meeting_evidence/` — absent from Ask Spine by design, and the gate cannot detect that absence |
| Meeting Receipt v0 pipeline — successful generation | `DEPLOYED`, **not observed** | PR #115, migration 176. Code live in `30cb992`; three real extraction attempts entered the workflow, **all three rejected**. Extraction runs: 0 accepted. Receipts: 0. Local HTTP tests use a fake workflow/pool; DB proofs bypass HTTP entirely |
| Meeting Receipt — unresolved named owner handling | `PRODUCTION_PROVEN` (narrow) | PR #120. Post-deploy, `extractor_unresolved_label_forbidden` stopped blocking the real specimen; next attempt advanced to evidence-role validation. Does not raise the pipeline's overall rung — no person ID attaches without an exact property-person match |
| Meeting Receipt — prompt evidence invariants | `PRODUCTION_PROVEN` (narrow) | PR #122. Real prompt revision v1 advanced past prior temporal/claim-basis failures, stopped at `extractor_quote_speaker_mismatch`. Still zero accepted extractions, receipts, emails, Ask Spine access, or canonical writes |
| Meeting Receipt — server-owned evidence addressing | `LOCALLY_EXERCISED` | Active, **unmerged** branch. Runtime 80/80, extractor 69/69 per Codex — **not independently re-run by me**. Could not verify against real Postgres today (Docker unavailable to that reviewer). *"Invalid output is rejected by the server, not repaired."* Real Receipt 001 remains the missing proof |
| Person ingress boundary | `LOCALLY_EXERCISED` | Migration 177 **unreleased** |
| Person correction (anti-merge supersession) | `BUILT_BUT_DORMANT` | Retire + point, move nothing |
| External resident identity / crosswalk | `REPORTED` | **Blocks establishing opening truth** |
| **Forward Leasing ledger** | `BROWSER_VERIFIED` | **4 browser proofs survived adversarial review untouched.** Most rigorously proven area |
| Interval tenancy read · leasing cycles · Forward Rent | `BROWSER_VERIFIED` | Migration 178 unreleased |
| Current Rent Roll (operator unit-first) | `HTTP_PROVEN` | Claimed browser-verified; downgraded on review |
| Current Rent Roll (four-bucket classification) | `LOCALLY_EXERCISED` | ⚠ Claimed `PRODUCTION_PROVEN`; **refuted** — single-source, and the API's own banner contradicts the numbers |
| Inventory retirement · grain materialization · bed-grain activation | `BUILT_BUT_DORMANT` | Migrations 179/180 unreleased. *"391 positions against 160 real beds"* |
| Tenancy standing projection | `HTTP_PROVEN` | Registered with Ask Spine |

---

## Teams / Access / Roles — `src/identity/`

**The highest-value gap in the original survey, now covered.** 148 capabilities
surveyed across this and six other areas (wave 2, 2026-08-20) — full detail in
`docs/current-state-build/05_WAVE2_RESULTS.md`. Rows below are the ones that
change what you should believe about the system; everything else is in that file.

| Capability | Rung | Note |
|---|---|---|
| Staff invite creation — `POST /properties/:id/team-invites` | `LOCALLY_EXERCISED` | Double-gated (session + shared key). Correctly derives the granting actor server-side, refuses a client-supplied one (PR #38 rule). **See defect #8** — the app's own button mostly doesn't call this |
| **Team invite UI silently fakes success** | **REPORTED (dead-in-practice)** | **Defect #8.** The real reason invites don't work in practice |
| OTP send — `POST /auth/sms/start` | `LOCALLY_EXERCISED` | One route, two branches (invite-accept / re-login). Honest 503 if SMS transport doesn't confirm send — tested only against a fake pool |
| OTP verify → session mint — `POST /auth/sms/verify` | `REPORTED` | **Zero test files reference this route at all** — not even the fake-pool pattern. The actual moment a session is minted has no automated evidence |
| Team roster read — `GET /properties/:id/team` | `REPORTED` | **Defect #9** — no property-scope check |
| Current-access read — `GET /properties/:id/my-access` | `BUILT_BUT_DORMANT` | Fully implemented, has the property wall its sibling routes lack, **the app never calls it** |
| Assignment edit — `PATCH /property-team-assignments/:id` | `BUILT_BUT_DORMANT` | Implemented, correctly gated, **orphaned — app never calls it** |
| Staff session mint/resolve/revoke | `HTTP_PROVEN` | *"Class 1 permanent product primitive."* The actually solid part of this whole area |
| Property switcher — `GET/POST /operator/properties[/select]` | `HTTP_PROVEN` | **Genuinely proven**, real Postgres + real HTTP, a real second user without access is refused. See the correction above defects #9-10 |
| Super-admin surface — `super_admin.js` (`/admin/*`) | `REPORTED` | Extensively used by the app; **zero automated test evidence at any rung** |
| Org-scoped admin surface — `org_admin.js` (`/org/*`) | `BUILT_BUT_DORMANT` | Fully parallel to super-admin, **entirely unreachable from the app** — nothing calls it |
| Module vocabulary mismatch — `'capital'` vs `'asset_management'` | `REPORTED` | Different grant paths use different names for what's supposed to be the same module; one silently strips the other |
| Demo session bootstrap — `POST /demo/operator-session` | `HTTP_PROVEN` | Correctly fail-closed (403/503 without config). Site map's *"RETIRE-ON-ACTIVATION"* framing **not found anywhere in source** — no such trigger exists, map was wrong on this specific point |
| Team/assignment schema (4 tables) | `DEPLOYED` | `property_team_assignments` is the one authority row; a partial unique index was added defensively in migration 070 after a live-duplicate risk |

## Newly discovered — on nobody's map until this pass

Found by the completeness critics, not by searching for something already
suspected. Full detail in `05_WAVE2_RESULTS.md`.

| What | Note |
|---|---|
| **The Decision Rail** — `src/leasing/decisions.js` | A whole governed money-decision domain (migration 059, its own obligation routing, its own approval-cap authority) sitting in `src/leasing/` where nobody would look for it under "money" |
| **AI leasing operating rules** — `ai_leasing_operating_rules` table (migration 121) | Writes governance rules that constrain **live prospect-facing AI output**, real HTTP routes, actively read on every AI-generated lease response — zero prior visibility |
| **`source_artifacts`** — migration 153 | Cross-cutting primitive, heavily used across Utilities/Compliance/Debt/Equity/onboarding, real and tested — *"exists in the database and in nobody's map"* until now |
| **Outlook/Acuity Microsoft Graph sync** | A complete external integration (OAuth, migration, seven env vars) exists in source — **but its mount file is literally named `outlookAcuityMount.example.js`**, never required by `server.js`. Built, not live |
| **Seven independent property-scoped feature flags** | Each gates a different live capability by property-UUID allowlist. Nothing in either repo enumerates the current set — only readable by checking Render directly alongside seven separate source files |
| **`TWILIO_FROM_NUMBER`** | Documented in `docs/deployment.md` as a settable env var. **Does nothing in code** — *"a mention is not a guard,"* exactly the trap this repo's own doctrine warns about |
| **10 consecutive missing migration numbers** — 141 through 149 | Between `140_post_activation_completion_guard.sql` and `150_canonical_property_creation.sql`. Not previously documented anywhere |
| **No scheduler/cron infrastructure exists in either repo** | Several capabilities (`followup_runner.js` among them) are structurally built to need a periodic trigger. None exists — confirmed absence, not oversight |

---

## NOT YET SURVEYED — do not read absence as absence

Wave 2 (2026-08-20) closed every area listed here as of the prior version of
this file. What's left is depth, not breadth:

| Area | Status |
|---|---|
| Money / pricing (42 capabilities found) | Surveyed at headline grain; full 42-row detail in `05_WAVE2_RESULTS.md`, not yet promoted into this file's index |
| `server.js` inline routes (25 found, 23 flagged) | Confirmed CLAUDE.md's own warning — a `src/`-only search would have missed a legacy Persons CRUD, a "contained not deleted" bare lease writer, and an inline AI rent-roll pipeline. Full detail in `05_WAVE2_RESULTS.md` |
| `tools/` (16 found) | Which have been actually *run* vs. written — detail in `05_WAVE2_RESULTS.md` |
| App repo doors (25 found) | Detail in `05_WAVE2_RESULTS.md` |
| Onboarding/rent-roll intake (12 found) | Detail in `05_WAVE2_RESULTS.md` |
| Management door (11 found) | Detail in `05_WAVE2_RESULTS.md` |

Re-runnable research: `docs/current-state-build/wave1_new_domains.js`,
`docs/current-state-build/wave2_coverage_gaps.js`. Full wave 2 output:
`docs/current-state-build/05_WAVE2_RESULTS.md`.

---

## ⛔ CLOSING A THREAD — DO THIS BEFORE YOU STOP

**This file goes stale the moment a thread ships something and does not say so.**
`docs/CODEBASE_STATE.md` (5 Aug) proved it — stamped one commit, silently wrong
two weeks later. The only thing preventing a repeat is the step below.

Run this before ending any thread that touched `src/`, `migrations/` or `server.js`:

```text
1. WHAT CHANGED?      git diff --stat origin/main...HEAD -- src/ migrations/ server.js
2. FOR EACH ONE:      does a row exist here?
                        yes → update its rung, files and note
                        no  → add a row, at the grain the evidence supports
3. RUNG CHECK:        did the proof rung actually MOVE? Opening a test is the only
                      way to know. A rung is never upgraded because the code looks
                      finished — only because the next rung was OBSERVED.
4. DEFECTS:           did you fix one of the KNOWN LIVE DEFECTS? Remove it.
                      Did you find a new one? Add it.
5. SNAPSHOT:          update STATE SNAPSHOT if you verified against a newer SHA.
                      Leave it alone if you did not — a false stamp is worse
                      than an old one.
6. NOTHING CHANGED?   Say so in the commit. That is a valid outcome.
```

**Paste this at the end of a thread to run the ritual:**

```
Close out this thread: update docs/CURRENT_STATE.md for anything we built,
connected, proved or disproved. Open the tests before changing any proof rung.
If nothing changed, say so rather than editing.
```

**The rule that keeps this honest:** a thread updates rows for what it *did*.
It does not re-survey the whole repo, and it does not upgrade a row it did not
personally verify.

---

## HOW TO ADD A ROW

1. **Open the test.** Do not trust the filename.
2. **Pick the rung the evidence supports**, never the one you hoped for.
3. **Cite a file path**, and a verbatim quote for any blocker.
4. **Update the snapshot** if you verified against a newer SHA.
5. `NOT_FOUND` beats a plausible guess, always.

**No row is upgraded because someone believes the product works that way.
It is upgraded only when the next proof rung has been observed.**

---

*Supporting detail — full capability tables, per-claim adversarial verification
reasoning, and the re-runnable research scripts — is in `docs/current-state-build/`.*
