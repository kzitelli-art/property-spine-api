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
API verified against    61f99bf     2026-08-22  (integration branch, deployed commit)
PRODUCTION DEPLOYED     61f99bf     2026-08-22  ← independently verified at /health
APP verified/deployed   d45344d     2026-08-21
Production ledger       ceiling 189 (schema)
Migrations on deployed branch 189  → matches production
Migrations on github main     187  → production is ahead; see defect #29
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
                        · 2026-08-22 (staff SMS post-tour capture and exact-bed
                        application send converged on the canonical services)
                        · 2026-08-22 (541-305-8509 atomically transferred from
                        Demo ORG to OneFive Management; old history preserved)
                        · 2026-08-22 (authenticated production Asset Management
                        + Ask Spine read audit; duplicate Solo identity found)

SKYLINE PRICING         PUBLISHED IN PRODUCTION  2026-08-20
                        2BR $850 · 3BR-1BA $750 · 3BR-1.5BA $775, per bed,
                        12-month term only, effective 2026-08-20.
                        Verified through quotablePricing — the adapter the
                        agent calls — not the publisher's own report.

SKYLINE CONVERSATION    INTEGRATION BRANCH DEPLOYED DIRECTLY, NOT MERGED
                        codex/skyline-conversation-integration-20260820
                        Production runtime: 61f99bf, 2026-08-22.
                        Based on claude/property-spine-orientation-cso2ao;
                        adds the one-reader Ask Spine obligation fix and a
                        canonical published-economics read for Ask Spine.
                        Clear staff SMS reads defer to the same Ask Spine answer;
                        post-tour and application actions defer to the existing
                        tour, target, conversion, and dispatch services.
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
| 7 | **REOPENED, 2026-08-22.** The 2026-08-20 repair did put production back on `main`, but production has diverged again. `/health` identifies `61f99bf` on `codex/skyline-conversation-integration-20260820`; `origin/main` is `b7720b2`, 43 commits behind that runtime, and contains migrations only through 187 while the production ledger is at 189. The deployed branch includes `main`, so this is forward drift rather than a conflicting lineage, but `main` cannot reproduce the production release today. | `/health` observed 2026-08-22; `git rev-list --count origin/main..61f99bf` → 43; Neon `schema_migrations` ceiling → 189; `origin/main` migration ceiling → 187 |
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

| # | Defect | Evidence |
|---|---|---|
| 17 | **159 phantom unit rows at Skyline, shaped like beds.** Alongside `1417-116` production carries separate `units` rows named `116 - A`, `116 - B`, `116 - C` — null bed, no source code, not reachable from any import row. They are why `count(*)` reports 231 units for a 72-unit property, and why the mapping tool reports 159 positions "Not configured" after a correct run. **Not a blocker and deliberately untouched**: the canonical loader sees 160, the mapping's exact-match override cannot reach them, and the e2e now carries six of them as decoys asserting exactly that. Cleaning them is a production delete with unknown FK reach — investigation first, then a decision, not a sweep. | `tools/apply_unit_type_mapping.js` production run 2026-08-20; decoys in `tests/e2e/skyline_unit_type_mapping.e2e.js` |
| 18 | **RESOLVED AND DEPLOYED FROM THE INTEGRATION BRANCH, 2026-08-21 — not yet observed through the production Ask Spine staff surface.** `economic_picture.js` preserves each term's economics. One published term can produce a flat quote; two or more return a term menu, set `lease_term_not_selected`, and withhold a combined monthly total until a term is chosen. Ask Spine consumes this same composition for published asking rent, governed charges, deposit requirements, and advertised concessions; it does not own a second pricing reader. Source contract 11/11; real session + real Express + real HTTP + real migrated Postgres 16/16; prospect price wall 22/22. | `src/money/economic_picture.js`; `src/agent/ask_spine_answer.js`; deployed commit `4f555c1` |
| 19 | **RESOLVED AND DEPLOYED FROM THE INTEGRATION BRANCH, 2026-08-22 — not yet observed through a production staff SMS turn.** The operations SMS line routes clear reads through the existing Ask Spine service and explicit post-tour/application actions through the canonical leasing services. Technician actions, attachments, field findings, and conversations about one work order remain on the technician path. Identity, property scope, module access, people, and application targets remain server-derived; questions never become writes. No new conversational pipe. Pure routing 35/35; leasing action contract 53/53; real webhook-to-exact-bed-lease journey 36/36. | `src/conversation/staff_sms_router.js`; `src/comms/staff_governed_read.js`; `src/leasing/staff_sms_action.js`; `src/comms/staff_thread.js`; `src/comms/tenantlink.js`; deployed API `61f99bf` |
| 20 | **`PRODUCTION_PROVEN`, 2026-08-21 — property identity is scoped to the active conversation.** The first controlled Skyline price turn exposed that the shared prompt still identified every property as SOLO at 4233 Chestnut; the live draft told the Skyline prospect they had the wrong building. The legacy SOLO profile is now included only for an explicitly SOLO/4233 property. A post-deploy Skyline turn returned the Skyline unit's governed price with no SOLO, Chestnut, or University City content. | Failed draft `28b0781f-6fc5-4a88-8191-2b9a2affe979`; passing draft `a0059ea8-aacd-4a5c-892a-6728afcb00bb`; `tests/agent_property_identity_proof.js` |
| 21 | **RESOLVED AND DEPLOYED, 2026-08-21 — authority grants require real two-party review.** Precondition 9 now resolves the reviewer through the canonical actor reader and requires a distinct linked `human_staff` person, active staff context covering the property, and `may_manage_concession_authority`; the reviewer person and authority basis are written to provenance. Self-review is refused even after the recipient gains property entitlement. **Not yet exercised by a production authority grant.** Pure hostile proof passed; disposable-Neon authority chain 17/17; publication 14/14; pricing wall 22/22; Economics Ask real HTTP 16/16. | `src/identity/authority_resolution.js`; `tests/e2e/authority_chain.e2e.js`; deployed commit `556c443` (also in `4f555c1`) |
| 22 | **DEPLOYED, ACTIVATION WAITING ON INVITEE VERIFICATION, 2026-08-21.** A controlled Skyline prospect asked to tour unit `1417-102`; the agent offered no slot and instead asked for move-in/move-out dates. No SMS was sent. **Owner ruling:** Property Spine's native scheduler is the authority; Acuity or another bolt-on scheduler is not the target. One canonical service now owns the weekly policy, explicit slot publication/list/block/reopen, two-hour notice, 45-day horizon, federal-holiday closures, default host, property timezone conversion, host/unit walls, exact-slot dedupe, day-level callout close/reassign, and attributable receipts. Booked tours remain visible and are reported for coverage rather than silently changed. The prospect agent and public booking page share one offerable-slot reader and one booking transaction. The staff app and staff SMS Ask Spine both read the same schedule standing; neither expands weekly hours into availability. **Owner-confirmed Skyline policy:** Monday-Friday 9-5, Saturday 10-3, Sunday/federal holidays closed, 60-minute blocks, Mike Grivna default host. **Proof:** exact slots 23/23, weekly policy/callouts 25/25, real session + HTTP 20/20, canonical booking 33/33, cross-turn agent offer/confirm 12/12, Ask Spine schedule 8/8, existing Skyline-shaped lead-to-lease real-HTTP walk 21/21, all 47 source-governance gates, and all 1,467 app assertions pass. API `61f99bf` and app `d45344d` are live; production ledger 189 and all three native scheduler tables are verified; Skyline's audited timezone is `America/New_York`. A canonical Mike Grivna Leasing invite is now active, linked to the existing person, and provider-accepted; it superseded both stale invites. Mike has not accepted it yet, so no linked user, staff context, Skyline assignment, or eligible default host exists yet. No policy or slot row was published and Skyline is not in the agent-booking allowlist. Next: Mike verifies; re-read all four identity records; publish the policy; enable Skyline booking; repeat the controlled prospect turn. | Production draft `7a00aff5-3ec2-48de-b6e0-8dfefb1680f1`; invite `47ff00c7-8847-4ef8-8b3c-bbc3334183e8`; current API `61f99bf`; deployed app `d45344d`; timezone receipt `289f0937-e1d5-4d67-81d0-cf44ec1f588c`; migrations 188-189; native tour and unified-onboarding proof suites |
| 23 | **RESOLVED IN DEPLOYED CODE; SKYLINE ACTIVATION PENDING, 2026-08-22.** The post-tour sender previously stopped at a multi-space Skyline unit, the live conversation screen used a separate prepare/copy/manual-attestation writer, and Application Review could read `company_execute_lease` without offering the action. Both staff doors now select the same server-authored exact target and call one composite send command; `space_id` survives the invitation, tenant application, lease packet, company execution, tenancy and Person Card. The tenant sees `Unit 3B · Bed B`, while a whole-unit property keeps the simple unit label. **Observed proof:** a real server and fresh disposable production-shaped Neon branch completed native 60-minute Mike slot → booking → real operations webhook → honest standing clarification → explicit post-tour capture → Mike's personal Ask Spine answer → exact Bed B application fake-SMS → tenant submission → resident signature → company signature → exact Bed B tenancy, 36/36. No carrier was reached. App suite: 38 harnesses, 1,467 assertions; the Staff Texting organization control was visually checked against production at 390px with zero page or card overflow. Production serves app `d45344d` and API `/health` identifies `61f99bf`. **Not activated:** Mike's invite remains unaccepted, Skyline is absent from the application-intent and executed-lease property perimeters, and no live application text or live tenant execution was attempted. | `application_send_command.js`; `application_target_read.js`; `applicationSubmission.js`; `staff_sms_action.js`; `operator.js`; app `followups-door.js` / `index.html`; `tests/e2e/tour_application_lease.e2e.js` |
| 24 | **PRODUCTION-EXERCISED THROUGH DELIVERY; ACCEPTANCE PENDING, RE-READ 2026-08-22.** One canonical staff invitation establishes the phone login, explicit user-to-person bridge, property-scoped staff context, person-keyed work assignment, and property-team access in the same acceptance transaction. Exact phone matches are candidates only: the manager confirmed Mike Grivna's existing person before the system wrote or sent anything. Production created one linked Leasing invite, superseded both stale rows, and the live response recorded `sms_sent`. The invite remains active and unaccepted, so the downstream identity and access records correctly do not exist. Disposable production-clone proof 50/50; identity bridge regression 44/44; staff SMS delivery 11/11. | Invite `47ff00c7-8847-4ef8-8b3c-bbc3334183e8`; migration 189; `src/identity/teamaccess.js`; `src/identity/staffbridge.js`; API `61f99bf`; app `d45344d` |
| 25 | **`PRODUCTION_PROVEN`, 2026-08-22 — 541-305-8509 IS THE ONEFIVE OPERATIONS LINE.** Staff SMS deliberately enters through one organization-level `operations` line with `staff` audience and `reply_only` outbound policy; Skyline's active property line remains correctly limited to residents and prospects. Production has one active `OneFive Management` organization and Skyline was adopted into it through the governed super-admin path, with immutable receipt `ec4cd2b5-468b-4b8f-9156-f0fd1681e563`. The deployed transfer command rechecks the live super-admin, target organization, property ownership, source line, and number uniqueness, then retires the source and activates the target in one transaction. On the owner's ruling, `+15413058509` moved from Demo ORG to OneFive: source line `be0d860b-95f5-4477-a723-a5562f2d7797` is retired with all 26 historic events preserved, and OneFive line `9b98408b-c1b3-4046-9179-c96f62842f92` is active. The production resolver returns exactly that OneFive line; Demo ORG returns `not_connected`. The attributable actor was KZ (`78375274-922a-44c5-8b61-0c285d1b9911`). Tom/Solo no longer resolve through this number. No live SMS was sent. Proof: real disposable Postgres 40/40, transfer contract 5/5, line model 61/61, reply policy 32/32, 47 source-governance gates, app 38 harnesses/1,467 assertions, and post-transfer production resolver audit. Next: Mike accepts his invite, then send the first controlled OneFive Ask Spine text. | `src/comms/communication_lines.js`; `src/identity/super_admin.js`; `tests/operations_line_transfer.test.js`; `tests/operations_line_activation.db.js`; API `61f99bf`; app `d45344d`; production re-read 2026-08-22 |
| 26 | **RESOLVED AND DEPLOYED, 2026-08-22 — live two-surface observation waits on Mike's invite acceptance.** “What should I do today?” and its pinned natural variants now use one deterministic person-scoped obligations read whether asked in the dashboard or through staff SMS. The read admits only direct `assigned_user_id`, explicit `escalates_to_user_id`, and unassigned work in the signed-in assignment's `primary_for_modules`; property and module authority remain server-derived, and role/title inference is absent. It does not call a model to reinterpret the queue. A specific work-order question and every action remain in the technician conversation. Leasing conversion birth, explicit handoff, and reopen now project their recorded owner into the same canonical obligation instead of maintaining a parallel owner field that the personal reader cannot see. Source convergence 28/28, router 35/35, disposable production-shaped Postgres personal scope 13/13, conversion rail 15/15, release/reopen 23/23, full Skyline-shaped journey 36/36, and all 47 source-governance gates passed from the exact clean runtime commit. Production `/health` identifies `61f99bf`. OneFive's operations line is active; the real dashboard/SMS comparison can occur after Mike accepts the invite and receives his server-derived OneFive/Skyline staff context. | `src/obligations/operator_obligations_service.js`; `src/agent/ask_spine_answer.js`; `src/conversation/staff_sms_router.js`; `src/leasing/leasingconversion.js`; `src/leasing/conversion_obligation_closure.js`; `tests/personal_attention_convergence.test.js`; `tests/personal_attention_convergence.db.js`; deployed API `61f99bf` |
| 27 | **RESOLVED AND DEPLOYED, 2026-08-22 — release observed in a disposable production-shaped database, not through live Skyline traffic.** The leasing conversion rail no longer keeps post-tour responsibility in a private owner field. Eligible owner selection stamps `obligations.assigned_user_id` at birth; explicit conversation handoff moves both records in one transaction; reopen restores or clears both records from the same eligibility decision. This is the concrete convergence between the tenant journey and the staff Ask Spine queue: post-tour capture records one accountable follow-up, and the signed-in staff member's existing Ask Spine answer can see it without a leasing-specific reader. Proof: conversion rail 15/15, release/reopen 23/23, full native scheduler → booking → staff SMS post-tour capture → personal Ask Spine → exact-bed application → resident/company lease → tenancy journey 36/36, all 47 clean source-governance gates. No real SMS was sent. | `src/leasing/leasingconversion.js`; `src/leasing/conversion_obligation_closure.js`; `tests/test_conversion_rail.db.js`; `tests/test_release3.db.js`; `tests/e2e/tour_application_lease.e2e.js`; deployed API `61f99bf` |
| 28 | **RESOLVED AND DEPLOYED, 2026-08-22 — production staff-SMS observation waits on Mike's invite acceptance.** Mike's post-tour text now enters the same leasing conversion plumbing as the dashboard. “Went well” records nothing and asks for one of the four canonical standings; an explicit standing delegates to `completeTour`; the exact unit/bed menu comes from the same application-target reader as the dashboard; and the exact reply delegates to the existing composite application-send command. Questions remain reads, maintenance language remains technician work, multi-person or multi-space ambiguity asks instead of choosing, and receipts distinguish a committed record from carrier acceptance. Pure contract 53/53, clean source governance 47/47, and fresh disposable real-webhook lead-to-exact-bed-tenancy proof 36/36. Production `/health` identifies `61f99bf`; OneFive's operations line is active, but Mike's invite remains unaccepted, so no live staff or application SMS is claimed. | `src/leasing/staff_sms_intent.js`; `src/leasing/staff_sms_action.js`; `src/applications/application_target_read.js`; `src/conversation/receipt.js`; `tests/staff_sms_leasing_action.test.js`; `tests/e2e/tour_application_lease.e2e.js` |
| 29 | **RESOLVED IN CODE; SKYLINE LEASE SOURCE LIVE; CONTROLLED PATH ACTIVATION PENDING, 2026-08-22.** The exact-bed rail now carries a governed intended move-in date through the staff SMS/dashboard target, invitation, public submission, application, proposed terms, and lease package. A future target is offerable only when an active turnover plan records its expected-ready date and the intended move-in is on or after it; Application Review displays the server-computed vacancy window rather than recomputing it in the browser. The mobile tenant application is versioned and validates identity, residence, income, household, move-in, pets, guarantor, certification, and delivery consent without placing SSNs in the broad application record; stale or unversioned public forms fail closed. A governing packet now retains the exact lease-template bytes and source hash, combines them with a deterministic deal-terms schedule, and binds resident signature, company signature, and the executed-lease record to one package hash; the database refuses a mismatched execution hash. This proves the implemented chain, not independent legal sufficiency. Guarantor-required official packets remain fail-closed until a guarantor signer rail exists. Proof: real webhook-to-tenancy 36/36; future-target Postgres 6/6; governing package 15/15; execution 25/25; tenant/application render 30/30; app target/setup 37/37; all 48 source-governance gates. The exact 56,074-byte Skyline DOCX is retained in production with matching source/content/configuration SHA-256 `6efa35f8b1a6412bbb54579c11a36f2c4e8bd36c00a53dcb1f6c091dde36a635`; KZ is the active configured company signer, and the generation and execution configuration gates are ready. No real application SMS or lease execution occurred. | migrations 190-191; `applicationSubmission.js`; `application_target_authority.js`; `application_target_read.js`; `leasepackets.js`; `spine_lease_execution.js`; `source_artifact_service.js`; app `index.html` / `followups-door.js`; `tests/e2e/tour_application_lease.e2e.js` |
| 30 | **“Solo on Chestnut” is serving governed Asset Management data from a demo property identity.** The populated production row is `a50fbdd0-…`, whose canonical name/address are `Property Spine Demo Building` / `1 Demo Way` but whose display name is `Solo on Chestnut`; it owns 10 compliance and 5 contracted-service records. Canonical `4233 Chestnut` (`9e2bb96e-…`) owns only one compliance record, while two additional `Solo on Chestnut` rows own none. Until the identity is adjudicated, the populated Solo Asset Management record set must not be described as canonical 4233 truth. | Authenticated production browser audit plus read-only Neon counts, 2026-08-22 |
| 31 | **The production Contracted Services Ask Spine read is semantically reachable but brittle.** “What contracted services need attention?” answered “One item” while the Asset Management screen reported six attention items and the answer itself discussed multiple engagements. “Who services the elevator and what governs the agreement?” was not classified; the domain-specific phrase “What governs the contracted service for elevator maintenance?” succeeded. | Authenticated production Ask Spine audit on the displayed Solo property, 2026-08-22 |
| 32 | **Production is ahead of GitHub `main` again.** This is the current continuation of defect #7, separated here so the live state is not buried inside its resolution history. Production API `61f99bf` is 43 commits ahead of `origin/main`; production carries migrations 188–189 that `main` lacks. | `/health` and read-only Neon ledger observed 2026-08-22; `git rev-list origin/main..61f99bf` |
| 33 | **THE LEDGER IS NOW THREE-TIERED, AND REACHING A DEPLOYABLE STATE IS NO LONGER A FAST-FORWARD.** `origin/main` **187** · production `61f99bf` **189** · the reconciled head (`027cd51` + `9746f12`) **191**. `9746f12` carries `190_application_move_in_lineage.sql` and `191_lease_instrument_source.sql`; `61f99bf` and `027cd51` are both at 189. So the reconciled head is at **191 in files against a 189 ledger**, which `prestart` refuses **in both directions** — a deploy of it fails to boot and names the pending file, and Render keeps the previous instance live so the API looks fine while the new schema is simply absent. **Reaching deployable therefore needs a deliberate release of two migrations, not a merge.** The STATE SNAPSHOT above still reads *"Migrations on deployed branch 189 → matches production"*, which is true of production and false of any branch carrying the Skyline lease work — read it as production-only until a release happens. Found while reconciling for Q5; reported, deliberately not acted on, because releasing schema is a human act with its own ceremony. | `git diff --name-only 61f99bf 9746f12 -- migrations/`; `migrations/migrate.js` verify-only mode; `docs/RELEASE_182_187_CEREMONY.md` for the shape a release takes |

## PRODUCTION-PROVEN — the whole list

| Capability | Evidence |
|---|---|
| **Work-order completion guard** | `activation_id d93b08dd-c682-46d2-acf9-78ab6b960827` · `2026-08-12T01:49:57.866Z` · 16/16 on live instance `kbtb6` · irreversible |
| **Migration release gate** | Runs on every boot via `prestart`; deployed sha enforces `EXPECTED_SHA` and refuses on mismatch |
| **Meeting Evidence webhook ingress** (narrow) | Real delivery `c5cb8d0d-…` authenticated + retained byte-for-byte for a real provider meeting. Proves ingestion, not the pipeline downstream of it |
| **Meeting Evidence binding + finality + rejection lineage** (narrow) | A real meeting bound to a real property, qualified final; three model rejections durably retained with no receipt |
| **Meeting Receipt extraction advancement** (narrow, ×2) | Two real specimen runs each cleared one more validation gate post-deploy — proves the gate moved, not that a receipt was produced |
| **Asset Management authenticated read surfaces** (narrow) | Production browser opened the overview and domain rooms for 4125 Chestnut, 4233 Chestnut and the displayed Solo property. Debt returned populated governed standing; Compliance, Utilities, Contracted Services, Insurance, Tax and Equity returned populated or explicit empty standing. No writer was exercised |
| **Ask Spine Asset Management reads** (narrow) | Production questions returned governed Debt, Equity, Utility, Compliance and explicitly phrased Contracted Services standing. Insurance remained unregistered, cross-domain composition omitted Equity, and natural elevator phrasing failed classification |

**Rows above say "narrow" on purpose.** Each is a real, specific, falsifiable
production observation — not a green test suite. None means the entire feature
works end to end. The Meeting Receipt pipeline specifically has **zero accepted
extractions and zero receipts produced**, despite three Meeting rows touching
production. Say precisely what was observed; do not round up.

Anything not explicitly marked `PRODUCTION_PROVEN` is **at best deployed, not
observed.**

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
| Compliance | `PRODUCTION_PROVEN` (read path, narrow) | registered | `compliance_*.js`. `compliance_http.db.js` was reopened and its real-DB/real-router structure confirmed before this upgrade; it was not rerun. Production rendered one record for canonical 4233, 10 for the displayed Solo property, and an honest zero through Ask Spine at 4125. The Solo identity is disputed; see defect #30 |
| Utilities | `PRODUCTION_PROVEN` (empty read path only) | registered | `utility_*.js`. Production UI and Ask Spine both returned the governed unestablished standing at 4125. Automated end-to-end gap remains: `utility_http.test.js` uses a fake pool and its DB test skips the router |
| Contracted Services — canonical domain | `PRODUCTION_PROVEN` (read path, narrow) | registered | Production rendered five populated engagements for the displayed Solo property and Ask Spine returned their evidence/standing when explicitly classified. No writer was exercised; identity and answer-count defects remain (#30–31). `contracted_service_http.test.js` still uses a fake pool |
| Contracted Services — overview integration | `PRODUCTION_PROVEN` (read path, narrow) | registered | Production Asset Management overview reported five service engagements and the detailed room rendered them. No automated real-DB/real-router proof was added |
| Insurance | `PRODUCTION_PROVEN` (empty read path only) | **none** (`pending`) | Production page opened under an entitled 4125 account and honestly reported no coverage/policy. Ask Spine still does not gather Insurance |
| Tax (Philadelphia) | `PRODUCTION_PROVEN` (empty read path only) | **none** (`pending`) | Production Philadelphia Tax page opened and reported applicability unconfirmed for Real Estate Tax, BIRT, NPT and U&O. Ask Spine still does not gather Tax; clocks only, never amounts |
| Debt — canonical truth | `PRODUCTION_PROVEN` (read path, narrow) | registered (PR #113) | Production 4125 read returned observed principal `$27,745,265.77` as of 2025-08-01 separately from projected principal `$27,131,874.12` as of 2026-08-01, with rate and maturity. No write route or causal/comparison claim was exercised |
| Debt — Ask Spine reader | `PRODUCTION_PROVEN` (narrow) | registered | Production “What is the current loan balance?” preserved observed vs projected basis, date/staleness and no-payoff caveat. The older unit test is fake-service only, but this production observation moves the read path itself |
| Equity — canonical domain | `PRODUCTION_PROVEN` (empty read path only) | registered | Production 4125 page returned zero positions and ownership reconciliation not established. No populated equity position was observed |
| Equity — Ask Spine reader | `PRODUCTION_PROVEN` (empty read path only) | registered | Production “Who holds the equity in this property?” returned an explicit coverage gap rather than “nobody owns it.” No populated equity answer was observed |
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
| Application submission / lifecycle | `HTTP_PROVEN` | Real public token read and versioned V3 submission persisted exact Bed B, intended move-in, and the post-tour conversion. The public write rejects stale or unversioned captured forms; protected SSN capture remains outside this broad record. **Migration 125 still does not exist** (124→126). |
| Application target authority (unit/bed/date) | `HTTP_PROVEN` | The canonical availability read returns one exact offerable space or a governed future target backed by an active turnover expected-ready date. Unit, `space_id`, and intended move-in are revalidated by the write authority and persist through the application-to-tenancy rail. |
| Proposed terms | `HTTP_PROVEN` | Confirmed terms generated the governing lease packet in the same full-path proof. |
| **Lease packet / resident + company execution** | `HTTP_PROVEN` | The packet retains the exact lease-template bytes and source hash, combines them with deterministic deal terms, and binds both signatures and the executed-lease record to one package hash. Company signing created the exact-space tenancy. This proves the implemented execution path, not independent legal sufficiency; guarantor-required official packets remain fail-closed. |
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
| Ask Spine (slices 1–2) | `PRODUCTION_PROVEN` (selected read paths) | Real migrated-Postgres + real-router proof confirmed in `ask_spine_db_proof.db.js`. Production browser observation returned Debt, Equity, Utility, Compliance and explicitly phrased Contracted Services answers. Insurance remains pending; natural elevator wording failed; cross-domain Debt + Equity returned Debt only. `references[]` remains absent |
| Asset Management shell | `PRODUCTION_PROVEN` (authenticated read path) | `asset_management_shell.db.js` was reopened: real Postgres + real AM router + real socket. Production browser opened the door for 4125, 4233 and displayed Solo; Skyline's door was hidden by its current module assignment. Property Expenses remains capped; no writer was exercised |
| Monthly Reporting surface | `DEPLOYED` (front-end shell only) | Production rendered the reporting room, but the surface says: *"Monthly reporting endpoint pending. Front end shell is live; backend read model can plug into /monthly-reporting-dashboard."* Final PDF was blocked and operating statement, cash flow, balance sheet, trial balance, bank reconciliation and debt confirmation remained backend-pending. App `index.html` at `d45344d` |
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

## Property identity — the evidence base — `tools/identity/`

Added 2026-08-22 (CC_BUILD1, slices 1-4). Read-only. **§18 class: 3** — inventory /
evidence infrastructure, outside the operator workflow. **Removal condition: none,
deliberately** (not Class 4): the ruling is one-time and this is the record of how it was
made. Full deliverable:
`docs/PROPERTY_IDENTITY_INVENTORY.md`, ending in a three-option ruling brief with
**no recommendation** — the direction is an owner ruling.

| Capability | Rung | Files / note |
|---|---|---|
| Property dependency graph (delete + rebind), from migration source | `LOCALLY_EXERCISED` | `tools/identity/property_dependency_graph.js`. No `pg`, no `DATABASE_URL`. **It is a catalog and cannot see rows** (H-1 in `IDENTITY_HYGIENE_REGISTER.md`) |
| Its falsification suite | `LOCALLY_EXERCISED` | `property_dependency_graph_falsify.js` — 24 cases. **Six deliberate breaks each went red on the correct case**, then were reverted |
| Property census SQL | `LOCALLY_EXERCISED` | `tools/identity/property_census.sql` (generated by `generate_property_census.js`). **Not run against production, deliberately.** Executed on a disposable local Postgres built from the real chain to 189, exit 0. `--capture` refuses any non-localhost `PGURL` |

**Numbers, and one correction to a figure in circulation.** 154 FKs reference
`properties`: **75 live CASCADE** (77 *declared* — two are on `scheduled_charges`,
dropped by 059), 42 RESTRICT, 29 with no `ON DELETE` clause (default NO ACTION, confirmed
to behave as RESTRICT; none deferrable), 6 SET NULL. **71 block a delete.**

**Defect #12 is proven and is one instance of a general pattern.** Deleting a property
bypasses the published-pricing freeze — but so does deleting the *pricing version*
directly, which is the discriminating test: the guard fires and reads its already-deleted
parent, so `status` is NULL and the check passes. Of 57 `BEFORE DELETE` guards, **53 raise
unconditionally and 4 read another row**. Two consequences not previously recorded:
`concession_policies` is an **unnamed sibling of #12** (same trigger function), and
**`work_order_proof_attachments` — Release 0 proof evidence — is silently destroyed by a
property delete**, proven on a disposable database.

**Two walls the FK graph cannot see.** `ai_leasing_operating_rules` and
`governed_charge_rulings` each carry an *unconditional* delete-refusal trigger **and** a
CASCADE FK. One row in either makes `delete from properties` raise rather than cascade —
proven. An FK-only reading calls these "would be destroyed"; they are the opposite.

**Rebind surface.** 78 unique constraints involve `property_id`: 37 `unique(id,
property_id)` anchors that cannot collide, 37 collidable on a shared key, and **4 that
permit one row per property, where a merge collides with certainty** —
`communication_lines`, `property_pricing_versions`, `opening_tenancy_positions`,
`deal_intake_properties`.

**`source_artifacts` is invisible to all of the above.** It has no `property_id` column
and no FK to properties (polymorphic scope pair, migration 153), so it appears in no edge
of the graph. Its binding is immutable: **no rebinding path exists** and the database
refuses to change `scope_id`. Nothing anywhere validates a document's *contents* against
the property it is filed under.

**Name resolution — the fix already exists and five callers bypass it.**
`src/identity/property_resolution_service.js` returns `ambiguous` with every candidate on
a multi-row exact-name match — *"One row resolves; more than one is ambiguous rather than
'the oldest'"* — and is live in the import/seed path (`snapshot_loader.js`,
`seed_endpoint.js`, `seed_snapshot.js`). Five sites do what it forbids:
`operator.js:195`, `demo_reset.js:80`, `leasingleads.js:900`, `leasingleads.js:1051`
(**no limit at all** — a booking authorization wall taking `rows[0]`), and
`demo_preflight.js:106`. Three rows share the name, so "oldest wins" is a coin flip.
Per §41 the missing piece is routing, not new code. Caveat: the export is named
`resolvePropertyForImport` and one new caller is an authorization wall, so the name is
scoped narrower than the callers — rename or extract a sibling. **Not fixed here.**

**Counts, stated exactly:** 154 FK references are *declared*; **152 are live** (two are on
`scheduled_charges`, dropped by 059). Live: 75 CASCADE + 71 BLOCKS + 6 SET NULL = 152.
An independent grep and the parser were **re-run after** the rename fix and agree on
154/77/42/6.

**Correction, recorded because it was published before it was checked:** an earlier
revision raised the urgency of the bypassable delete guards on the reasoning that
`tools/scale/seed_b_qa_identity.sql` carries the production property UUID and so *is* a
delete path. **It is not.** `activation_proof.js:36` reads `SCALE_DATABASE_URL` with no
`DATABASE_URL` fallback, `setup_baseline.sh:60` overwrites `DATABASE_URL` with localhost,
and `assert_isolated_environment.sql` refuses unless `current_database() = 'r0scale'`.
The inserts are `on conflict do nothing` and the harness deletes only its own fixture
tables. The §2b guard defect stands on its own; the urgency framing does not.

**Not established, and not guessed at:** every row count. No production database was
contacted. The census answers those, and a human runs it.

---

## Property identity resolution — one contract, five callers — `src/shared/`

Appended 2026-08-22 (Q5). Product code changed; no migration, no database write.

| Capability | Rung | Files / note |
|---|---|---|
| One demo-property identity module | `LOCALLY_EXERCISED` | `src/shared/demo_property_identity.js`. **Class 2.** Replacement condition: `properties.canonical_key` populated for the demo row. Noticed by `via` in its result, asserted by the gate |
| Five name lookups deleted | `LOCALLY_EXERCISED` | `operator.js`, `demo_reset.js`, `demo_preflight.js`, `leasingleads.js` ×2. All five `from properties where name` statements are gone; the gate fails if any returns |
| Booking scope wall refuses on ambiguity | `LOCALLY_EXERCISED` | `leasingleads.js`. Was `select … where name=$1` with **no limit**, taking `rows[0]`. Now refuses, logs candidates, and compares identity as a separate refusal. Mutation-tested |
| `resolvePropertyForImport` → `resolvePropertyIdentity` | `LOCALLY_EXERCISED` | Renamed in a commit of its own with no behaviour change. `resolveProperty` was unavailable — `snapshot_loader.js` and `seed_snapshot.js` define local wrappers by that name |
| Scale seeds self-guard | `LOCALLY_EXERCISED` | `tools/scale/seed_b_qa_identity.sql`, `seed_c_governed_charges.sql`. Both carry the production Demo Building UUID; all prior guards lived in the runner, so `psql -f` bypassed them. Verified in three directions |

**What was deleted, measured as decisions rather than lines:** 8 declarations of
the demo property name → **1**; 5 SQL statements resolving a property by name →
**0**; 5 call sites able to silently pick one of three same-named rows → **0**.

**Net line count is POSITIVE (+163 in `src/`), and the contract asked to be told
if so.** Counted as code with comments stripped, the five callers are **+5** —
flat. The addition is the one module (122 lines, ~65 of them the header stating
the defect, the class and the removal condition), two 35-line SQL self-guards
that are pure addition, and Slice 4 splitting one silent comparison into two
explicit refusals plus candidate logging. The duplication is gone; the volume is
not. Recorded rather than argued away.

**Not established:** whether the demo row has a `canonical_key`. That needs a
production read, which this build did not do. Until it is known, resolution falls
to the exact-name branch — which **refuses** on ambiguity rather than taking the
oldest. That improvement holds either way.

---

## Standing projections — one shape, eight domains — `src/shared/`

Appended 2026-08-22 (Build 2). Product code changed; no migration, no database write.

| Capability | Rung | Files / note |
|---|---|---|
| The §40.6 standing-projection contract | `LOCALLY_EXERCISED` | `src/shared/standing_projection.js`. **Class 1.** `read_state` (about Spine) and `truth_state` (about the property) are separate axes; `validate()` refuses conflating them. QUIET is not a field — `compositeSilence()` is the only place it is decided (§40.7) |
| Eight domains mapped into it | `LOCALLY_EXERCISED` | `src/shared/domain_standing_projections.js`. **Class 1.** Authors no truth; restates each read's own output |
| Its gates | `LOCALLY_EXERCISED` | `tests/gate_standing_projection_contract.js` (shape, discovery-driven) · `tests/gate_standing_projection_cost.js` (cost, **measured against real Postgres**) |

**The build framing said "normalise against `equity_position_read.js`". There was no
reference to normalise against.** Two domains had a `standingProjection()` and they
disagree: debt carries §40.6's triple (`current_position` · `important_unknowns` ·
`next_milestone` · `as_of`); equity carries counts and `next_milestone` and neither
`as_of` nor unknowns. **Debt is the closer match to doctrine, not equity.** The other six
had none. Eight vocabularies existed for the same three ideas — `as_of`/`period`/`term`,
and `next_milestone`/`next`/`next_due`/`next_due_statement`/`next_renewal`.

**Also: seven is right only across both directories** — six in `src/asset` plus
`tenancy_position_read.js`. The gate discovers **eight** domains; compliance arrives via
`compliance_read.js`.

**COST, MEASURED — this is the finding.** On an **empty** property, so it is a floor:

```text
42 queries to gather all eight domains ONCE
8 of 8 issue at least one unbounded read
```

§40.6 requires the projection be answerable *"without walking its full payment,
amendment or event history"*, and says why: so many domains can be gathered per question,
*"which is what lets Ask Spine answer cross-domain questions WITHOUT a classifier or an
intent router."* `ask_spine_answer.js` **has** that router — `questionSubject()`, a regex
bank, with 16 `if (subject === …)` guards gating every gather. **Build 4's "delete the
regex router" is blocked on this cost.** Build 2 measures the tension; it does not
resolve it, and resolving it needs schema (§40.6: *"This constrains schema, not just
reads"*), which the frozen ledger forbids.

**Where the mapping lives, and why it is not in the reads.** It was in the reads first.
`tests/gate_funding_boundary.js` refused it and was right: equity, insurance, tax and
debt's derivation reads must **import nothing** — that is how the Tax/Insurance funding
boundary is guaranteed structurally rather than by review. A boundary gate is not
weakened to fit a refactor, so the shaping moved out and the reads stayed import-free.

**Not established:** whether these projections are cheap enough in production — no
production read was made. And the ESTABLISHED branch is proven on representative
readings, not on a populated database; the real-database run took the NOT_ESTABLISHED
branch for all eight because the measurement property is empty.

**Adjacent, recorded not fixed:** `READ_TIMED_OUT` is distinguished for only 3 of 8
domains; the other five collapse a timeout into `READ_FAILED`, which §40.7 forbids.
Compliance is worse — its failure path leaves `facts.compliance` undefined with no
`read_state` at all. That is Build 3.

---

## The four silences — `src/agent/ask_spine_answer.js`

Appended 2026-08-22 (Build 3). Product code changed; no migration, no database write.

| Capability | Rung | Files / note |
|---|---|---|
| One silence shape for every gathered domain | `LOCALLY_EXERCISED` | `silenceFor()` / `failedRead()` in `ask_spine_answer.js`. A failed read carries `read_state` and `standing: null` — never a count, never a truth_state |
| Composite silence **computed, not prompted** | `LOCALLY_EXERCISED` | `facts.composite_silence` = `BLIND` \| `ATTENTION` \| `QUIET`, decided in code from what the readers did |
| Its gate | `LOCALLY_EXERCISED` | `tests/gate_four_silences.js` — injects real failures into the real `gatherFacts` and inspects real output. Four deliberate breaks each go red |

**What was measured before the fix**, by injecting failures rather than reading source:

```text
2 of 8   fact key VANISHED on failure   compliance, tour_schedule
5 of 8   timeout reported as READ_FAILED  compliance, debt, equity,
                                          economics, tour_schedule
0 of 8   asserted a truth_state on a failed read   ← already correct
none     computed a composite verdict
```

**The real finding was the fourth.** §40.7 says composite silence *"may only mean
'nothing needs attention' when every required reader successfully returned — computed
from reader outcomes in code, **never prompted**."* It was prompted: `reads_that_failed`
was a list handed to the model, and the prompt asked it not to confuse a failed read with
"nothing to report", then told it *"nothing being open is a real, good answer."* The
verdict is now decided in code and the model is handed it as a fact.

**A latent assumption surfaced when the silence became visible.** `grounded_on` guarded
with `facts.compliance ? facts.compliance.items.length : null` — testing that the *key*
exists. A failed read used to delete the key, so the absent key **was** the guard. Making
failure visible made that throw. Both array dereferences now guard the array. This is the
cost of the change, found by the existing suite, not by inspection.

**Two existing tests changed, and it is worth knowing why.** `C14` and `F2` asserted that
a failed read **deletes its fact key** — a proxy for their own titles, and a weak one,
since an absent key is indistinguishable from a domain nobody asked about. They now
assert the titles directly: `read_state` names the silence, `standing` is null, no count
field exists, and the computed verdict is `BLIND`. Verified to go red when a failed read
is given `total_open: 0`, which is the danger `F2`'s own comment names.

**Not established:** no production observation. Whether an operator sees the BLIND wording
is unproven — no browser run.

**Adjacent, recorded not fixed:** utility's and contracted_service's catch blocks call
`detailRequest()` on the same reader that just threw — an error handler depending on the
failed collaborator.

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
