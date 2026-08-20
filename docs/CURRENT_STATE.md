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
API verified against    77f93f5     2026-08-18  (github main)
PRODUCTION DEPLOYED     30cb992     2026-08-19  ← 39 commits AHEAD of main
APP verified against    c6769ba     2026-08-18
Production ledger       ceiling 187 (schema), 175 (ledger entries) — see note
Migrations on main      181         → main is BEHIND production by 6 migrations
Surveyed / verified     2026-08-19 (wave 1) · 2026-08-20 (Codex PR review, AM
                        domains) · 2026-08-20 (wave 2, 148 capabilities:
                        teams/access, management door, onboarding intake,
                        money/pricing, app repo, server.js inline, tools/)
```

⚠ **Production does not run `main`.** The deployed commit `30cb992` lives only on
`claude/property-spine-orientation-cso2ao` and carries migrations 182–187, which
`main` does not have. Any deploy of `main` as it stands should safely refuse to
start (schema/ledger mismatch) rather than silently regress — confirm this before
assuming `main` is deployable. Rows below citing "ledger ceiling 176" reflect the
survey commit, not the current production reality; reconcile once that branch
reaches `main`.

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
| 1 | **FIXED ON BRANCH, NOT CONFIRMED IN PRODUCTION.** ~~The leasing agent quotes `units.market_rent` directly to prospects~~ — commit `5e42338` on `claude/property-spine-orientation-cso2ao` rewires both leaks (the system-prompt read at the old line 374, **and a second path the original finding missed**: `offeredUnits` carried `market_rent` into a tool-result *list*, multiplying the exposure by however many units matched a search) through `quotablePricing()`. Verified: `market_rent` no longer appears as a live read anywhere in `agent.js` — only in comments explaining the old defect. Proof: `tests/e2e/agent_pricing_wall.e2e.js`, real Postgres via `E2E_DATABASE_URL`, a sentinel value planted on `market_rent` that must appear in neither the no-pricing-published nor the pricing-published case — **CI green, run 28**. Rung: real-DB proof, not HTTP/browser — the test calls the adapter directly, doesn't drive a real router. **Not merged to `main`. Deployment status unconfirmed** — this is the same branch production has been deploying from, so this fix may already be live, or may not be; nobody has said which. | `git show 5e42338:src/agent/agent.js` |
| 2 | **`docs/deployment.md` instructs incorrectly about the one mechanism protecting production.** Says startup *"runs any unapplied migrations."* It does not — it verifies and **refuses to start**. | `docs/deployment.md:51` vs `migrations/migrate.js` |
| 3 | **An operator screen calls routes that 404.** A whole activation flow written, never mounted. | `src/identity/activation.js`; `grep -c "identity/activation" server.js` = **0** |
| 4 | **A test defaults to hitting PRODUCTION**, with no run receipt anywhere. | `tests/full_lifecycle_arc.js:47` |
| 5 | **Ask Spine has two obligation readers** (§7 violation). Its own header: *"Its QUERY LOGIC is sound and is re-expressed here."* | `src/agent/ask_spine_service.js` |
| 6 | **The §40.11 gate scans 2 of ~15 domain dirs** — `["src/asset","src/tenancy"]`. Leasing, applications, maintenance, technician, comms, obligations, money, onboarding, **and now `src/meeting_evidence/`** cannot fail it. | `tests/gate_ask_spine_readers.js:100` |
| 7 | **Production does not run `main`.** Deployed `30cb992` lives only on `claude/property-spine-orientation-cso2ao`, and that branch keeps moving — 39+ commits ahead as of 2026-08-19, now `0ba81df`, 2026-08-20, including the defect #1 pricing fix. **Still not confirmed which tip is actually deployed**, only that the gap from `main` hasn't closed and is growing. A deploy of `main` today should refuse to start on schema mismatch — confirm before assuming `main` is deployable, and land that branch before the gap widens further. | `git merge-base --is-ancestor 30cb992 origin/main` → **NO** |
| 8 | **A signed-in operator's Invite button silently fakes success.** The app only calls the real invite route `if(key())` — a hidden, `aria-hidden` field populated *only* from an internal-only key in `localStorage` that the real SMS sign-in flow never sets. Without it, the button pushes a fake row and shows: *"Demo invite pending locally. Add an operator key to create a live invite."* This is the exact mechanism behind "no staff member other than the account owner has ever completed a real invite," and it's a direct violation of CLAUDE.md's own non-negotiable — *"Never fixture-fallback... in a signed-in operator workflow."* | `main-app/index.html:12152-12178` (`inviteTeamMember`), `:5953` (`#opKey`), `:8024` (`key()`) |
| 9 | **The team roster read has no property-scope check — unlike every sibling route in the same file.** `GET /properties/:id/team` sits behind the shared `x-operator-key` gate (not public), but performs *no* staff-session resolution and *no* check that the key-holder has any relationship to the `:id` in the URL. Any operator-key holder can read any property's full roster — names, phones, emails — by changing the URL. | `src/identity/teamaccess.js` — roster handler, compare to `my-access`'s enforced *"BRICK ONE property wall"* two routes below it |
| 10 | **Two inbound Twilio SMS webhooks, two different security postures.** `/communications/inbound-sms` documents itself as fail-closed on signature verification. `/intake/twilio` (a second, separate webhook) is gated only by a phone-number allowlist (`INTAKE_ALLOWED_NUMBERS`) — no signature check found. | `src/onboarding/intake.js:220` vs `src/comms/communications_boundary.js` |
| 11 | **`CLAUDE.md`'s own deploy description doesn't match reality.** States *"Deploys to Render on merge to main,"* which reads as automatic push-to-deploy. The actual mechanism is `deploy.sh` — a manual script calling Render's API directly, run by a human. If it's meant to be automatic, it currently isn't. | `deploy.sh` vs `CLAUDE.md`'s "Repo orientation" section |
| 12 | **A real hole in published-pricing immutability.** `pricing_terms` correctly refuses direct deletion once published (*"the terms of a published pricing version are immutable"*) — but `delete from properties` **cascades straight through the freeze** with no refusal. Found while fixing defect #1; deliberately not fixed — it's a schema-level ruling, not a pricing-adapter change, and is the owner's call. | Documented, not exploited, in `tests/e2e/agent_pricing_wall.e2e.js`'s own teardown comments, branch `claude/property-spine-orientation-cso2ao` |
| 13 | **Four falsification tests are pinned to a hardcoded demo UUID and nothing runs them.** Verified red before AND after the pricing fix, identically, by stashing — they were never testing what they claim to test. Deliberately left alone; decoupling them from that UUID is separate work, not a pricing fix. | `tests/` — unnamed in the report, flagged for follow-up rather than fixed |

**Correction, not a new defect — the exclusion wall is better than earlier feared, for one route.** `tests/phase_zero_property_boundary.db.js` genuinely proves, with real Postgres and real HTTP, that a second real user without a property assignment is refused by the property-switcher (`GET/POST /operator/properties[/select]`). The earlier "only tested from inside" concern was wrong for *that* route — but confirmed true, and worse than described, for the roster route above (defect #9): not "only tested from inside," not tested at all, and structurally missing the check its own sibling routes have.

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
| Funding boundary wall | enforced | — | `tests/gate_funding_boundary.js` — tax/insurance funding cannot cross into economics |

## Leasing lifecycle — `src/{leasing,applications,tenancy,onboarding}/`

**None of this is registered with Ask Spine** — the gate cannot see these directories.

| Capability | Rung | Files / note |
|---|---|---|
| **Deal Setup / Opening Tenancy** | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `deal_setup_http.db.js` **spawns real `server.js`**, real socket, restart persistence. **Best-proven capability in the repo** |
| Lead intake | `LOCALLY_EXERCISED` | `leasingleads.js` |
| Tours / appointment attribution | `LOCALLY_EXERCISED` | `appointment_attribution.js`, `appointment_journey.js`, `tour_outcome.js` |
| `tour_chips` · `capture_chase` · `capture_receipt` | `BUILT_BUT_DORMANT` | **no caller in `src/` or `server.js`** |
| Post-tour conversion rail | `LOCALLY_EXERCISED`; one seam `HTTP_PROVEN` | `leasingconversion.js`. **BLOCKING ruling open** on `conversation_owner_user_id` |
| AI Leasing Strategy | `LOCALLY_EXERCISED` | ⚠ docs say *dormant*; code is wired into the live first-response path (`leasingleads.js:614`). **Unresolved** |
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
| Tenant link (resident SMS) | `HTTP_PROVEN` | `tenantlink.js` |
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
| Money events / accounting | `HTTP_PROVEN` | `money.js`, `bankbridge.js`, `plaid.js` — lifecycle-arc harnesses only |
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
