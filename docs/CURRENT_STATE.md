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
> Roughly 60% of the codebase is surveyed. If something is not listed, its state
> has **not yet been established here** — that is not evidence it does not exist.
> **Search the source before concluding anything is missing**, and add what you find.

---

## STATE SNAPSHOT

```text
API verified against    60839ac     2026-08-22  (integration branch, deployed commit)
PRODUCTION DEPLOYED     60839ac     2026-08-22  ← independently verified at /health
APP verified/deployed   d45344d     2026-08-21
Production ledger       ceiling 189 (schema)
Migrations on deployed branch 189  → matches production
Surveyed / verified     2026-08-19 (wave 1) · 2026-08-20 (Codex PR review, AM
                        domains) · 2026-08-20 (wave 2, 148 capabilities:
                        teams/access, management door, onboarding intake,
                        money/pricing, app repo, server.js inline, tools/)
                        · 2026-08-20 (pricing fix deployed, PR #128, live)
                        · 2026-08-21 (live Skyline pricing + tour walk;
                        authority-review precondition; native scheduler ruling)
                        · 2026-08-21 (native scheduler + session-only Team
                        onboarding deployed; ledger 189)
                        · 2026-08-21 (post-tour → exact-bed application →
                        resident/company lease execution HTTP-proven; code
                        deployed inactive for Skyline)
                        · 2026-08-21 (OneFive staff-line activation door
                        deployed inactive; Super Admin mobile layout proven)
                        · 2026-08-21 (dashboard/staff-SMS personal-attention
                        question converged on one recorded-accountability read)
                        · 2026-08-22 (post-tour conversion ownership projected
                        into that same canonical personal-attention read)

SKYLINE PRICING         PUBLISHED IN PRODUCTION  2026-08-20
                        2BR $850 · 3BR-1BA $750 · 3BR-1.5BA $775, per bed,
                        12-month term only, effective 2026-08-20.
                        Verified through quotablePricing — the adapter the
                        agent calls — not the publisher's own report.

SKYLINE CONVERSATION    INTEGRATION BRANCH DEPLOYED DIRECTLY, NOT MERGED
                        codex/skyline-conversation-integration-20260820
                        Production runtime: 60839ac, 2026-08-22.
                        Based on claude/property-spine-orientation-cso2ao;
                        adds the one-reader Ask Spine obligation fix and a
                        canonical published-economics read for Ask Spine.
                        On 2026-08-21 it also connected clear staff SMS read
                        questions to that same Ask Spine answer service.
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

**Two traps this repo has actually hit:**
- A file named `*.db.js` proves nothing. **Open it.** Several pass a hand-built fake
  pool to a real router (`utility_http.test.js`, `contracted_service_http.test.js`).
- A browser proof can run against a simulated database. **Check for `fakePool()`.**

---

## ⛔ KNOWN LIVE DEFECTS

| # | Defect | Evidence |
|---|---|---|
| 1 | **`PRODUCTION_PROVEN`, 2026-08-21.** ~~The leasing agent quotes `units.market_rent` directly to prospects~~. A controlled live Skyline turn against unit `1417-102` returned exactly **"Unit 1417-102 is $850/month on a 12-month lease."** from the published 2BR term. The run recorded `pricing_direct_quote`, prompt revision `stage-a-v10`, no provider request, and no dispatched outbound event. This second deploy followed a failed live proof in which the governed price reached the prompt but the model skipped the answer; clear linked-unit rent questions now defer directly to the canonical pricing adapter rather than asking the model to restate it. | Production draft `a0059ea8-aacd-4a5c-892a-6728afcb00bb`; deployed commit `4f555c1`; `tests/agent_property_identity_proof.js` |
| 2 | **`docs/deployment.md` instructs incorrectly about the one mechanism protecting production.** Says startup *"runs any unapplied migrations."* It does not — it verifies and **refuses to start**. | `docs/deployment.md:51` vs `migrations/migrate.js` |
| 3 | **An operator screen calls routes that 404.** A whole activation flow written, never mounted. | `src/identity/activation.js`; `grep -c "identity/activation" server.js` = **0** |
| 4 | **A test defaults to hitting PRODUCTION**, with no run receipt anywhere. | `tests/full_lifecycle_arc.js:47` |
| 5 | **RESOLVED AND DEPLOYED, 2026-08-21 — Ask Spine no longer owns a second obligation reader.** `ask_spine_service.js` consumes `operator_obligations_service.attention()` and owns only the conversational projection. The canonical service owns property/module scope, overdue meaning, open-state filtering, ranking, count, and cap for both surfaces. Source contract: 35/35; Ask Spine authenticated real HTTP + real migrated Postgres: 23/23; operator obligations authenticated real HTTP + real migrated Postgres: 21/21. | `src/obligations/operator_obligations_service.js`; `tests/ask_spine_contract_proof.js`; `tests/ask_spine_db_proof.db.js`; `tests/operator_obligations_security_proof.db.js`; deployed API `7bbb23e` |
| 6 | **The §40.11 gate scans 2 of ~15 domain dirs** — `["src/asset","src/tenancy"]`. Leasing, applications, maintenance, technician, comms, obligations, money, onboarding, **and now `src/meeting_evidence/`** cannot fail it. | `tests/gate_ask_spine_readers.js:100` |
| 7 | **RESOLVED, 2026-08-20 (PR #128).** ~~Production does not run `main`~~ — the branch production was deployed from (`30cb992`) is now confirmed an ancestor of `main`, and `main`'s migration files run through 187, matching what's reportedly released to production. `main` should now boot cleanly against the live database. **Not yet re-verified end to end after this merge** — the next real deploy is the actual test of this, not a git check. | `git merge-base --is-ancestor 30cb992 origin/main` → **YES** (was NO as of 2026-08-19/20 morning) |
| 8 | **RESOLVED, DEPLOYED, AND PRODUCTION-OBSERVED, 2026-08-21.** ~~A signed-in operator's Invite button silently fakes success.~~ The first deployed repair still passed Team through the page-wide historical-snapshot interceptor, so a valid live session rendered `Team roster unavailable. Not part of this historical snapshot.` Team roster and invite creation now use named sealed live resources on the existing staff-session client; neither can enter the snapshot path. Production rendered the live Skyline roster, accepted one canonical Leasing invite for Mike Grivna, and returned `sms_sent`. A signed-in failure remains a failure and creates no local row. | Fix first shipped in app `567d15f`, present in deployed `d45344d`; `team_access_live_boundary.test.js`; current full app suite 1,467/1,467; production Team receipt 2026-08-21 |
| 9 | **RESOLVED AND DEPLOYED, 2026-08-21.** ~~The team roster read has no property-scope check.~~ Team roster, invite, current-access and assignment-edit URLs now share the operator CORS boundary but derive identity and property from `x-staff-session`. No session is 401; a session for another property is 403; the browser operator key is not an alternate authority path. | API `7bbb23e`; `tests/team_access_session_boundary.test.js`; real HTTP/Postgres authority proof 50/50; production no-session roster read 401 |
| 10 | **Two inbound Twilio SMS webhooks, two different security postures.** `/communications/inbound-sms` documents itself as fail-closed on signature verification. `/intake/twilio` (a second, separate webhook) is gated only by a phone-number allowlist (`INTAKE_ALLOWED_NUMBERS`) — no signature check found. | `src/onboarding/intake.js:220` vs `src/comms/communications_boundary.js` |
| 11 | **`CLAUDE.md`'s own deploy description doesn't match reality.** States *"Deploys to Render on merge to main,"* which reads as automatic push-to-deploy. The actual mechanism is `deploy.sh` — a manual script calling Render's API directly, run by a human. If it's meant to be automatic, it currently isn't. | `deploy.sh` vs `CLAUDE.md`'s "Repo orientation" section |
| 12 | **A real hole in published-pricing immutability.** `pricing_terms` correctly refuses direct deletion once published (*"the terms of a published pricing version are immutable"*) — but `delete from properties` **cascades straight through the freeze** with no refusal. Found while fixing defect #1; deliberately not fixed — it's a schema-level ruling, not a pricing-adapter change, and is the owner's call. | Documented, not exploited, in `tests/e2e/agent_pricing_wall.e2e.js`'s own teardown comments, branch `claude/property-spine-orientation-cso2ao` |
| 13 | **CLAIMED, NOT STARTED — open for either party.** Four falsification tests are pinned to a hardcoded demo UUID and nothing runs them. Verified red before AND after the pricing fix, identically, by stashing. `claude/property-spine-orientation-cso2ao` claimed this then spent the time on deploy support instead. Say who's taking it before starting, to avoid duplicate work. | `tests/` — unnamed in the report, flagged for follow-up rather than fixed |
| 14 | **RESOLVED AND DEPLOYED, 2026-08-21.** ~~`terms[0]` picks the shortest — and dearest — published term when a prospect names none~~. The adapter now agrees with `effective_pricing.js:399`: one published term is quoted and stated; two or more return the published menu and ask the prospect to choose. Clear linked-unit rent questions consume that adapter response directly, so the model cannot replace either the quote or the menu. **Proof:** real-DB `tests/e2e/agent_pricing_wall.e2e.js` 22/22; controlled live Skyline one-term quote recorded under defect #1. | `src/agent/pricing_adapter.js`; `src/agent/agent.js`; deployed commit `4f555c1` |
| 14b | **RESOLVED WITH #14 — this row identified the option that was built.** Found by the closeout thread while verifying the deploy: `effective_pricing.js:399` does not merely refuse when no term is supplied, it returns `published_terms`, the sorted list of every term on the sheet, *"specifically so a caller can present the choice instead of guessing."* That was the third option — present the menu, reuse data that already exists, no schema change — and it is what shipped. Kept rather than folded into #14 because the finding was not mine and the record should say where it came from. | `src/money/effective_pricing.js:399` · implemented in `src/agent/pricing_adapter.js` |
| 15 | **RESOLVED, 2026-08-20 — a real privilege-escalation path is now closed.** `orgchart.js` could previously create `owner`/`asset_manager` roles — pricing authority (see #14) among them — through a route gated only by the shared `x-operator-key`, with **no person-level check and no actor recorded**. Landed in the same deploy as defect #1's fix (45 commits, 9 runtime files, zero migrations). Measured on a disposable DB by the reporting thread; not yet independently re-verified against production by me. Kept as a record, not deleted, per this file's own rule. | `src/surfaces/orgchart.js`, `src/identity/authority_resolution.js` — `ASSIGNABLE_ROLES = new Set(["owner", "asset_manager"])` confirmed on `main` |
| 16 | **RESOLVED AND INDEPENDENTLY VERIFIED, 2026-08-21.** The Render database credential was stale again: `/health` returned `password authentication failed for user 'neondb_owner'`. The current Neon production connection was installed in Render, commit `bcd3089` was redeployed for the repair, and `/health` returned 200 with a live database timestamp. Later deploys `556c443` and `4f555c1` also booted green against that connection. | Render deploys `dep-da43sck9v7es7395k8a0`, `dep-da448inqj5pc73b95alg`, `dep-da44cn3m8hqs73doah40`; `/health` observed directly |

**Correction history, not a new defect.** `tests/phase_zero_property_boundary.db.js`
genuinely proves, with real Postgres and real HTTP, that a second real user
without a property assignment is refused by the property-switcher
(`GET/POST /operator/properties[/select]`). The roster did lack that wall when
this correction was written; defect #9 now records its later resolution.

---

| 17 | **159 phantom unit rows at Skyline, shaped like beds.** Alongside `1417-116` production carries separate `units` rows named `116 - A`, `116 - B`, `116 - C` — null bed, no source code, not reachable from any import row. They are why `count(*)` reports 231 units for a 72-unit property, and why the mapping tool reports 159 positions "Not configured" after a correct run. **Not a blocker and deliberately untouched**: the canonical loader sees 160, the mapping's exact-match override cannot reach them, and the e2e now carries six of them as decoys asserting exactly that. Cleaning them is a production delete with unknown FK reach — investigation first, then a decision, not a sweep. | `tools/apply_unit_type_mapping.js` production run 2026-08-20; decoys in `tests/e2e/skyline_unit_type_mapping.e2e.js` |
| 18 | **RESOLVED AND DEPLOYED FROM THE INTEGRATION BRANCH, 2026-08-21 — not yet observed through the production Ask Spine staff surface.** `economic_picture.js` preserves each term's economics. One published term can produce a flat quote; two or more return a term menu, set `lease_term_not_selected`, and withhold a combined monthly total until a term is chosen. Ask Spine consumes this same composition for published asking rent, governed charges, deposit requirements, and advertised concessions; it does not own a second pricing reader. Source contract 11/11; real session + real Express + real HTTP + real migrated Postgres 16/16; prospect price wall 22/22. | `src/money/economic_picture.js`; `src/agent/ask_spine_answer.js`; deployed commit `4f555c1` |
| 19 | **RESOLVED AND DEPLOYED FROM THE INTEGRATION BRANCH, 2026-08-21 — not yet observed through a production staff SMS turn.** The operations SMS line can answer clear, supported read questions through the existing Ask Spine service. Technician actions, attachments, field findings, and conversations about one work order remain on the technician path. A person-scoped work question now defers to the same Ask Spine answer used by the dashboard; identity and property scope remain server-derived. Tour-schedule questions use that same path. No new conversational pipe. Pure routing 35/35; real Express webhook + real PostgreSQL 77/77. | `src/conversation/staff_sms_router.js`; `src/comms/staff_governed_read.js`; `src/comms/staff_thread.js`; `src/comms/tenantlink.js`; deployed API `60839ac` |
| 20 | **`PRODUCTION_PROVEN`, 2026-08-21 — property identity is scoped to the active conversation.** The first controlled Skyline price turn exposed that the shared prompt still identified every property as SOLO at 4233 Chestnut; the live draft told the Skyline prospect they had the wrong building. The legacy SOLO profile is now included only for an explicitly SOLO/4233 property. A post-deploy Skyline turn returned the Skyline unit's governed price with no SOLO, Chestnut, or University City content. | Failed draft `28b0781f-6fc5-4a88-8191-2b9a2affe979`; passing draft `a0059ea8-aacd-4a5c-892a-6728afcb00bb`; `tests/agent_property_identity_proof.js` |
| 21 | **RESOLVED AND DEPLOYED, 2026-08-21 — authority grants require real two-party review.** Precondition 9 now resolves the reviewer through the canonical actor reader and requires a distinct linked `human_staff` person, active staff context covering the property, and `may_manage_concession_authority`; the reviewer person and authority basis are written to provenance. Self-review is refused even after the recipient gains property entitlement. **Not yet exercised by a production authority grant.** Pure hostile proof passed; disposable-Neon authority chain 17/17; publication 14/14; pricing wall 22/22; Economics Ask real HTTP 16/16. | `src/identity/authority_resolution.js`; `tests/e2e/authority_chain.e2e.js`; deployed commit `556c443` (also in `4f555c1`) |
| 22 | **DEPLOYED, ACTIVATION WAITING ON INVITEE VERIFICATION, 2026-08-21.** A controlled Skyline prospect asked to tour unit `1417-102`; the agent offered no slot and instead asked for move-in/move-out dates. No SMS was sent. **Owner ruling:** Property Spine's native scheduler is the authority; Acuity or another bolt-on scheduler is not the target. One canonical service now owns the weekly policy, explicit slot publication/list/block/reopen, two-hour notice, 45-day horizon, federal-holiday closures, default host, property timezone conversion, host/unit walls, exact-slot dedupe, day-level callout close/reassign, and attributable receipts. Booked tours remain visible and are reported for coverage rather than silently changed. The prospect agent and public booking page share one offerable-slot reader and one booking transaction. The staff app and staff SMS Ask Spine both read the same schedule standing; neither expands weekly hours into availability. **Owner-confirmed Skyline policy:** Monday-Friday 9-5, Saturday 10-3, Sunday/federal holidays closed, 60-minute blocks, Mike Grivna default host. **Proof:** exact slots 23/23, weekly policy/callouts 25/25, real session + HTTP 20/20, canonical booking 33/33, cross-turn agent offer/confirm 12/12, Ask Spine schedule 8/8, existing Skyline-shaped lead-to-lease real-HTTP walk 21/21, all 45 source-governance gates, and all 1,467 app assertions pass. API `60839ac` and app `d45344d` are live; production ledger 189 and all three native scheduler tables are verified; Skyline's audited timezone is `America/New_York`. A canonical Mike Grivna Leasing invite is now active, linked to the existing person, and provider-accepted; it superseded both stale invites. Mike has not accepted it yet, so no linked user, staff context, Skyline assignment, or eligible default host exists yet. No policy or slot row was published and Skyline is not in the agent-booking allowlist. Next: Mike verifies; re-read all four identity records; publish the policy; enable Skyline booking; repeat the controlled prospect turn. | Production draft `7a00aff5-3ec2-48de-b6e0-8dfefb1680f1`; invite `47ff00c7-8847-4ef8-8b3c-bbc3334183e8`; deployed API `60839ac`; deployed app `d45344d`; timezone receipt `289f0937-e1d5-4d67-81d0-cf44ec1f588c`; migrations 188-189; native tour and unified-onboarding proof suites |
| 23 | **RESOLVED IN DEPLOYED CODE; SKYLINE ACTIVATION PENDING, 2026-08-22.** The post-tour sender previously stopped at a multi-space Skyline unit, the live conversation screen used a separate prepare/copy/manual-attestation writer, and Application Review could read `company_execute_lease` without offering the action. Both staff doors now select the same server-authored exact target and call one composite send command; `space_id` survives the invitation, tenant application, lease packet, company execution, tenancy and Person Card. The tenant sees `Unit 3B · Bed B`, while a whole-unit property keeps the simple unit label. **Observed proof:** a real server and disposable production-shaped Neon branch completed native 60-minute Mike slot → booking → post-tour capture → Mike's personal Ask Spine answer showing the recorded follow-up → exact Bed B application fake-SMS → tenant submission → resident signature → company signature → exact Bed B tenancy, 29/29. No carrier was reached. App suite: 38 harnesses, 1,467 assertions; the Staff Texting organization control was visually checked against production at 390px with zero page or card overflow. Production serves app `d45344d` and API `/health` identifies `60839ac`. **Not activated:** Skyline is absent from the application-intent and executed-lease property perimeters; no live application text or live tenant execution was attempted. | `application_send_command.js`; `applicationSubmission.js`; `operator.js`; app `followups-door.js` / `index.html`; `tests/e2e/tour_application_lease.e2e.js` |
| 24 | **PRODUCTION-EXERCISED THROUGH DELIVERY; ACCEPTANCE PENDING, 2026-08-21.** One canonical staff invitation establishes the phone login, explicit user-to-person bridge, property-scoped staff context, person-keyed work assignment, and property-team access in the same acceptance transaction. Exact phone matches are candidates only: the manager confirmed Mike Grivna's existing person before the system wrote or sent anything. Production created one linked Leasing invite, superseded both stale rows, and the live response recorded `sms_sent`. Mike has not verified yet, so the downstream identity and access records correctly do not exist. Disposable production-clone proof 50/50; identity bridge regression 44/44; staff SMS delivery 11/11. | Invite `47ff00c7-8847-4ef8-8b3c-bbc3334183e8`; migration 189; `src/identity/teamaccess.js`; `src/identity/staffbridge.js`; API `60839ac`; app `d45344d` |
| 25 | **MANAGEMENT-COMPANY LAYER AND ACTIVATION DOOR LIVE; STAFF NUMBER STILL NEEDED, 2026-08-21.** The unified router is deployed, but a real Skyline staff text cannot reach it until its management company owns an operations line. Staff SMS deliberately enters through one organization-level `operations` line with `staff` audience and `reply_only` outbound policy; Skyline's active property line remains correctly limited to residents and prospects. Production has one active `OneFive Management` organization and Skyline was adopted into it through the governed super-admin path, with immutable receipt `ec4cd2b5-468b-4b8f-9156-f0fd1681e563`. Team Admin now shows the canonical line standing and exposes one first-activation command. That command rechecks the live super-admin actor, requires an active organization with a property, fixes the safe posture, is idempotent, refuses collision or replacement, and leaves transfer/retirement as separate governed events. The display, inbound router, outbound resolver, and activation command share `communication_lines.js`; the screen owns no second line reader. **Production remains intentionally inactive:** OneFive has zero operations lines. The existing operations line remains with `Demo ORG` because that organization still has active assigned users and historic real provider traffic. Proof: real disposable Postgres 26/26, line model 61/61, reply policy 32/32, 45 source-governance gates, app 38 harnesses/1,467 assertions, and production mobile visual proof at 390px. Next: connect a dedicated OneFive number through Team Admin, then observe Mike's first Ask Spine text after he verifies his invite. | `src/comms/communication_lines.js`; `src/identity/super_admin.js`; app `index.html`; API `60839ac`; app `d45344d`; production re-read 2026-08-21 |
| 26 | **RESOLVED AND DEPLOYED, 2026-08-22 — live two-surface observation still blocked by activation.** “What should I do today?” and its pinned natural variants now use one deterministic person-scoped obligations read whether asked in the dashboard or through staff SMS. The read admits only direct `assigned_user_id`, explicit `escalates_to_user_id`, and unassigned work in the signed-in assignment's `primary_for_modules`; property and module authority remain server-derived, and role/title inference is absent. It does not call a model to reinterpret the queue. A specific work-order question and every action remain in the technician conversation. Leasing conversion birth, explicit handoff, and reopen now project their recorded owner into the same canonical obligation instead of maintaining a parallel owner field that the personal reader cannot see. Source convergence 28/28, router 35/35, disposable production-shaped Postgres personal scope 13/13, conversion rail 15/15, release/reopen 23/23, full Skyline-shaped journey 29/29, and all 45 source-governance gates passed from the exact clean runtime commit. Production `/health` identifies `60839ac`. A real comparison between Mike's dashboard and SMS answer cannot occur until he accepts the invite and OneFive activates a dedicated operations number. | `src/obligations/operator_obligations_service.js`; `src/agent/ask_spine_answer.js`; `src/conversation/staff_sms_router.js`; `src/leasing/leasingconversion.js`; `src/leasing/conversion_obligation_closure.js`; `tests/personal_attention_convergence.test.js`; `tests/personal_attention_convergence.db.js`; deployed API `60839ac` |
| 27 | **RESOLVED AND DEPLOYED, 2026-08-22 — release observed in a disposable production-shaped database, not through live Skyline traffic.** The leasing conversion rail no longer keeps post-tour responsibility in a private owner field. Eligible owner selection stamps `obligations.assigned_user_id` at birth; explicit conversation handoff moves both records in one transaction; reopen restores or clears both records from the same eligibility decision. This is the concrete convergence between the tenant journey and the staff Ask Spine queue: post-tour capture records one accountable follow-up, and the signed-in staff member's existing Ask Spine answer can see it without a leasing-specific reader. Proof: conversion rail 15/15, release/reopen 23/23, full native scheduler → booking → post-tour → personal Ask Spine → exact-bed application → resident/company lease → tenancy journey 29/29, all 45 clean source-governance gates. No real SMS was sent. | `src/leasing/leasingconversion.js`; `src/leasing/conversion_obligation_closure.js`; `tests/test_conversion_rail.db.js`; `tests/test_release3.db.js`; `tests/e2e/tour_application_lease.e2e.js`; deployed API `60839ac` |

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
| Funding boundary wall | enforced | — | `tests/gate_funding_boundary.js` — tax/insurance funding cannot cross into economics |

## Leasing lifecycle — `src/{leasing,applications,tenancy,onboarding}/`

**None of this is registered with Ask Spine** — the gate cannot see these directories.

| Capability | Rung | Files / note |
|---|---|---|
| **Deal Setup / Opening Tenancy** | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `deal_setup_http.db.js` **spawns real `server.js`**, real socket, restart persistence. **Best-proven capability in the repo** |
| Lead intake | `LOCALLY_EXERCISED` | `leasingleads.js` |
| Tours / appointment attribution | `LOCALLY_EXERCISED` | `appointment_attribution.js`, `appointment_journey.js`, `tour_outcome.js` |
| `tour_chips` · `capture_chase` · `capture_receipt` | `BUILT_BUT_DORMANT` | **no caller in `src/` or `server.js`** |
| Post-tour conversion rail | `HTTP_PROVEN` | Real server + PostgreSQL flow records the tour outcome and returns the conversion consumed by the one application-send command. The separate `conversation_owner_user_id` ruling remains outside this proof. |
| AI Leasing Strategy | `LOCALLY_EXERCISED` | ⚠ docs say *dormant*; code is wired into the live first-response path (`leasingleads.js:614`). **Unresolved** |
| Leasing Desk | `LOCALLY_EXERCISED` | `leasing_desk.js`, `leasing_desk_loader.js`. Handoff claims HTTP proof; file inspection contradicts it |
| Application submission / lifecycle | `HTTP_PROVEN` | Real public token read and submission persisted exact Bed B and retained the post-tour conversion. **Migration 125 still does not exist** (124→126). |
| Application target authority (unit/bed) | `HTTP_PROVEN` | The canonical availability read returns one exact target per offerable space. Unit + `space_id` are revalidated by the write authority and persist through tenancy; multi-space is no longer a 409 when a bed is deliberately selected. |
| Proposed terms | `HTTP_PROVEN` | Confirmed terms generated the governing lease packet in the same full-path proof. |
| **Lease packet / resident + company execution** | `HTTP_PROVEN` | The resident completed every required packet field including signature; the server then exposed `company_execute_lease`, and company signing created the exact-space tenancy. This proves the implemented execution path, not independent legal sufficiency. |
| **Executed lease intake** | `LOCALLY_EXERCISED` | **SWITCHED OFF** — 503 unless `EXECUTED_LEASE_INTAKE_ENABLED=true` **and** property allowlisted |
| Tenancy anchor | `HTTP_PROVEN` | Governing-packet resident execution followed by company execution created the lease and reread as complete from Application Review and Person Card. The outside-document confirm-term path still fails closed without executed-lease evidence. |
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
| Technician SMS operations loop | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `technician/conversation.js`, `lifecycle_service.js` + screenshots. On 2026-08-21 the current proof-evaluation schema was added to the disposable harness and the plain-language technician day passed 63/63 through the real inbound webhook and PostgreSQL; carrier and media fetch remain doubled. |
| Staff SMS governed reads | `DEPLOYED` + `HTTP_PROVEN` | Real inbound webhook + real PostgreSQL 77/77; Ask response and transport are doubled in this connection proof. Uses the existing Ask Spine service; canonical Economics Ask is separately real-HTTP proven 16/16. Deployed in API `7bbb23e`, but no production staff SMS turn has been observed. |
| Operator work-order actions | `HTTP_PROVEN` | `operator_actions.js` — 4 canonical writes; "Review" deliberately excluded |
| **Obligations queue + self-claim** | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `GET /operator/obligations`, `POST .../claim`. **Exists — do not rebuild** |
| **Turnovers / move-out** | `HTTP_PROVEN` | `turnover_service.js`, `operator_turnover.js`. **Exists — do not rebuild** |
| Unit triage · turn scope · work acceptance · readiness | real-DB service layer, **no HTTP harness** | `unit_triage_service.js`, `unit_turn_scope_service.js`, `work_acceptance_service.js`, `readiness_service.js` |
| Communications boundary | `HTTP_PROVEN` (line layer) | **SMS RAIL FROZEN** — *"no `operations` line row at all"* |
| Tenant link (resident SMS) | `HTTP_PROVEN` | `tenantlink.js`. Real inbound webhook + fully migrated disposable PostgreSQL passed 61/61 on 2026-08-21; classifier and carrier remain doubled. |
| Move-in delivery correlation | `LOCALLY_EXERCISED` | `delivery.js` — test uses a **hand-mocked** `client.query` |
| Prospect fact capture | `LOCALLY_EXERCISED` | `prospect_capture.js` |

**OPEN:** Resident work-order creation and technician proof-gated completion are
independently HTTP-proven, but no single scenario yet carries the same resident-created
work order through assignment, technician conversation, completion, and resident reply.
No controlled live-carrier proof has run.

## Platform / core — `src/{identity,entity,money,evidence,agent,release0,surfaces}/`

| Capability | Rung | Files / note |
|---|---|---|
| Staff session / server-derived authority | `HTTP_PROVEN` | `staff_session_service.js`. *"The caller never supplies role, modules, TTL, or entitlement"* |
| Property creation | `HTTP_PROVEN` + `BROWSER_VERIFIED` | Single-path enforced by `gate_property_creation_paths.js` |
| Legal entity primitive | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `legal_entity_service.js` |
| Ask Spine (slices 1–2) | `HTTP_PROVEN` | Gathers: `attention, work_orders, compliance, utility, contracted_service, equity, tenancy, debt`; integration branch also gathers canonical `economics` (real HTTP 16/16). ⚠ *"`references[]` IS NOT IN PRODUCTION"*; economics is also not deployed. |
| Asset Management shell | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `asset_management.js` 260/260. Property Expenses **capped** — can never read `established` |
| Money events / accounting | `HTTP_PROVEN` | `money.js`, `bankbridge.js`, `plaid.js` — lifecycle-arc harnesses only |
| Governed pricing & charges (~26 files) | mixed | Skyline pricing is published. Integration branch fixes multi-term composition and exposes current published economics to Ask Spine without a second source. Other economic classes retain their own publication state; `$99` admin fee remains **BLOCKED on one ruling**. |
| `concession_schedule_compiler` | `BUILT_BUT_DORMANT` | *"ACTIVATES NOTHING"*; `free_rent_period` *"SPECIFIED BUT NOT IMPLEMENTED"* |
| `economic_adapter` · `pricing_adapter` | `BUILT_BUT_DORMANT` | *"DARK BY CONSTRUCTION."* **See defect #1** |
| `src/identity/activation.js` | **DEAD** | Never mounted; app screen 404s. **See defect #3** |
| Slice 9 market evidence | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `evidence_projection.js`. Rent Survey / Listings permanently `not_connected` |
| Conversational seams (6 pure files) | `LOCALLY_EXERCISED` | `intent.js`, `clarification.js`, `receipt.js`, `staff_sms_router.js`, `technician_intent.js`, `work_reference.js` |
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
| Staff invite creation — `POST /properties/:id/team-invites` | `HTTP_PROVEN` | Session-only human authority; property scope and granting actor are server-derived. Canonical jobs map access and work ownership together. Existing phone match requires explicit person confirmation before write/send. |
| Team invite UI — live session path | `DEPLOYED` | Defect #8 resolved. Signed-in failures stay failures; no local fake invite. Job + name + phone is the complete form. |
| OTP send — `POST /auth/sms/start` | `LOCALLY_EXERCISED` | One route, two branches (invite-accept / re-login). Honest 503 if SMS transport doesn't confirm send — tested only against a fake pool |
| OTP verify → session mint — `POST /auth/sms/verify` | `HTTP_PROVEN` | Real HTTP/Postgres proof accepts a canonical invite and atomically establishes session, bridge, context, work assignment, and property access. |
| Team roster read — `GET /properties/:id/team` | `HTTP_PROVEN` | Defect #9 resolved. Session required; cross-property session refused. Production no-session probe returns 401. |
| Current-access read — `GET /properties/:id/my-access` | `BUILT_BUT_DORMANT` | Fully implemented, has the property wall its sibling routes lack, **the app never calls it** |
| Assignment edit — `PATCH /property-team-assignments/:id` | `BUILT_BUT_DORMANT` | Implemented and session/property/manager gated; the app still never calls it. |
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
| **Outlook/Acuity Microsoft Graph sync** | A complete external integration exists in source but is unmounted. **Owner ruling 2026-08-21: do not make this Skyline's scheduler.** Property Spine's native availability and `leasing_tours` path is the target; this external path is legacy/migration territory, not an activation dependency. |
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
