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
                        · 2026-08-20 (wave 3 FINAL: migrations 001-119,
                        src/shared + governance, all 292 tests, CI reality —
                        58 findings; full record retained in 06_WAVE3_RESULTS.md)

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

**Wave-3 audit findings retained as historical inputs, not silently discarded:**
the final survey measured the then-current CI coverage and branch-protection posture,
ten fake-pool HTTP harnesses, 47 demo-UUID-pinned tests, two dead historical proofs,
the from-scratch migration failure at 083, the app CI gap, four orphaned baseline
tables, environment-variable documentation gaps, and the DEMO_MODE boot writer.
The exact evidence and counts remain in
`docs/current-state-build/06_WAVE3_RESULTS.md`; later RC1 proof rows below supersede
only the findings they explicitly re-prove.

---

## ⛔ KNOWN LIVE DEFECTS

| # | Defect | Evidence |
|---|---|---|
| 52 | **RESOLVED IN SOURCE, 2026-09-05 — `GET /operator/economics/shadow` compared every operator's property against a production property id fixed in source.** The route (`src/identity/operator.js`) called `economicShadowReport` with `other_property_id: "9e2bb96e-…"` — the real Solo property, 4233 Chestnut (`src/onboarding/deal_registry.js`) — for whoever was signed in, on whatever property. That is a Solo-special branch in a route (§22) and a read of another property's governed pricing state (`another_property` scenario: whether it has a published version) without any entitlement to that property. Fix: the comparison property is named by the caller (`?other_property_id=`) and must be one the operator is seated on (`listAuthorizedProperties`), else 403 *The comparison property must be one you are seated on. Nothing was compared.* with `acting_on`; with none named, the report runs single-sided (the service already supported `null`). `economicShadowReport` itself is unchanged; `economic_decision_room.js` never passed a comparison property. **Remaining hard-coded Solo ids, recorded not changed:** `src/surfaces/owner.js` `NEVER_DELETE` (a deletion guard listing real properties — protective, by design), `src/leasing/demo_preflight.js` `REAL_SOLO_ID` (a preflight that checks demo traffic does not land on Solo — protective), `deal_registry.js` (the registry that names it). None selects a property for an operator. Proof: `tests/e2e/shadow_other_property_entitled.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — no property named → 200 with no `another_property` scenario; a property the operator is not seated on → 403 with `acting_on` and no comparisons; seated on it → 200 with the scenario. Falsified against the unmodified parent `827f81c`: 2/4 — the fixed comparison appeared unasked (`governed_state: no_published_pricing_version` for a property absent from the database) and a foreign property answered 200. No app caller at pinned app `4849545`. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/identity/operator.js`; `tests/e2e/shadow_other_property_entitled.e2e.js`; `tests/e2e/verify_all.sh` |
| 51 | **RESOLVED IN SOURCE, 2026-09-05 — a pricing term proposed without a lease term was stored as a silent 12-month decision.** `saveDraft` (`src/money/pricing_lifecycle.js`) inserted each proposed term with `lease_term_months || 12`. The publication contract already names a term without months as the blocker `invalid_lease_term`, but the draft was saved anyway with 12 in the column — a decision nobody made, shown in the draft as if proposed, and publishable as one; a fractional month (`12.5`) reached Postgres and came back as a raw 500 `22P02`. The ruling on this lineage is already taken: *12 months is not a silent default.* Fix: a term whose `lease_term_months` is not a whole number 1–36 is refused 400 `term_without_lease_term`, naming the type and what it named, *12 is not assumed. Nothing was saved* — the transaction rolls back, so no draft version exists. Terms that name their months save exactly as named. `POST /operator/pricing/draft` has no app caller at pinned app `4849545`. **Adjacent, recorded not fixed:** `pricingAuthority` (`src/money/pricing_authority.js`) still resolves a single grant by `order by effective_from desc limit 1` on its legacy `person_id`-supplied path — the same class row 50 fixed in `resolveActorContext`; every route reaches it through `user_id`, which delegates to row 50's path, so the legacy branch is reached only by a caller that supplies `person_id` directly. Proof: `tests/e2e/pricing_term_requires_months.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — no months → 400 with the receipt and zero versions; 12.5 → 400; 6 → 200 stored as 6. Falsified against the unmodified parent `92b3628`: 2/6 — 200 with a draft carrying a 12-month term, and 500 `22P02` for 12.5. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/money/pricing_lifecycle.js`; `tests/e2e/pricing_term_requires_months.e2e.js`; `tests/e2e/verify_all.sh` |
| 50 | **RESOLVED IN SOURCE, 2026-09-05 — two live concession-authority grants resolved to whichever row Postgres returned first.** `resolveActorContext` (`src/identity/actor_context.js`) — THE canonical path for who the acting human is — read a person's live `concession_authority_grants` for the property with no `order by` and then took `grants[0]`. A person holding two live grants (one `may_review_pricing`, one `may_publish_public_offers`) was granted whichever verb sat on the first row and denied the other; the decision changed with heap order, and the `authority_basis` written into privileged receipts named a grant that had not granted the verb. Fix: grants are read `order by effective_from, id`; each verb is granted when ANY live grant grants it (every live grant is a valid authorization — the comment already ruled that silently revoking given authority is its own defect), and the basis names the earliest such grant. `may_prepare_pricing` keeps honouring the older `may_edit_pricing` column. Role authority (`owner`, `asset_manager`) is unchanged and still short-circuits. Proof: `tests/e2e/authority_grants_union.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database, through `GET /operator/authority-view` — review granted with basis `grant:<review grant>`, publish granted with basis `grant:<publish grant>`, prepare and manage denied (manage granted only by an EXPIRED grant, which grants nothing), the view listing exactly the two live grants. Falsified against the unmodified parent `919c2c8`: 5/6 — `may_publish_pricing: false, basis: null` while the publish grant was live. Consumers reading `ctx.capabilities`/`ctx.basis` (`pricing_authority.js`, `authority_resolution.js`, fee decisions, `operator.js`) receive the same shape. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/identity/actor_context.js`; `tests/e2e/authority_grants_union.e2e.js`; `tests/e2e/verify_all.sh` |
| 49 | **RESOLVED IN SOURCE, 2026-09-05 — one bank deposit could cash-prove an unbounded total of payments.** `POST /payments/:id/link-bank` (`src/money/payments.js`) ties a payment to a bank deposit, and `recomputePayment` treats any link as cash proof for the whole payment. The route checked the deposit's existence, property and sign — never how much of it earlier links had already attributed, nor whether `amount_matched` fit the payment. A 1,500.00 deposit accepted a second full 1,000.00 payment (and would have accepted a fifth); `amount_matched: 2000` was accepted on a 1,000.00 payment. Fix, one invariant: a link attributes `amount_matched` when given, else the whole payment; the sum over the deposit's non-void links plus this attribution may not exceed the deposit → 409 naming the deposit, what it already proves, what was attempted and the two ways forward (split with `amount_matched`, or a different deposit), and nothing written; `amount_matched` above the payment → 409; not positive → 400. Accepted links and the response shape are unchanged. **Adjacent, recorded not fixed:** `recomputePayment` still counts a link with a partial `amount_matched` as full cash proof for the payment's status — a partially proven payment's `cash_proven` reads the same as a fully proven one; bounding status by attributed amount changes an existing figure and is a ruling. Proof: `tests/e2e/deposit_attribution_bound.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — first full link 200; second full link 409 with the receipt and `links=1`; split 500 → 200; one cent past the deposit 409; `amount_matched` 2,000 on a 1,000 payment 409; `amount_matched` 0 → 400; the untouched deposit has no links. Falsified against the unmodified parent `ff4b3a3`: 1/9 — both over-attributions answered 200 and were written. No app caller for `link-bank` at pinned app `4849545`. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/money/payments.js`; `tests/e2e/deposit_attribution_bound.e2e.js`; `tests/e2e/verify_all.sh` |
| 48 | **RESOLVED IN SOURCE, 2026-09-05 — `GET /demo/intake/health` was an anonymous diagnostic outside the demo.** The route (`src/leasing/leasing_leads.js`, marked *TEMP DIAGNOSTIC*) sits under the key-exempt `/demo/` prefix and answered anyone, on any deployment, with database reachability, the `lead_events` check-constraint definition state and the boot-time self-heal outcome — a string that can carry a raw database error message (`"FAILED: " + e.message`). Its sibling `POST /demo/intake` fails closed unless `DEMO_MODE=true`; the diagnostic did not. Fix: the same wall, first thing in the handler — outside the demo it answers 403 `The live demo is not enabled on this deployment.` and nothing else. **Class 4, still temporary:** its removal condition is the self-heal block above it (`_selfHealStatus`) being retired once every environment's ledger carries migration 055 — the diagnostic exists only to watch that heal. **Adjacent, recorded not fixed:** that self-heal block runs `alter table lead_events` from application code at boot — schema mutation outside the migration ledger, which `prestart` verify-only mode exists to forbid; retiring it is an owner ruling because it exists to rescue an un-migrated deployment. Proof: `tests/e2e/demo_intake_health_gate.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` (booted without `DEMO_MODE`) on a disposable loopback database — 403 with the receipt and none of `database`, `lead_events_check`, `self_heal`, `build`; `POST /demo/intake` pinned to the same wall. The `DEMO_MODE=true` side is **not measured** by this parent (one server, outside the demo). Falsified against the unmodified parent `a0ac76e`: 1/4 — 200 with `database: connected` and the self-heal status. No app caller at pinned app `4849545`. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/leasing/leasing_leads.js`; `tests/e2e/demo_intake_health_gate.e2e.js`; `tests/e2e/verify_all.sh` |
| 47 | **RESOLVED IN SOURCE, 2026-09-05 — a bodiless Read AI webhook delivery was a 500 with no security receipt.** `POST /integrations/read-ai/webhook` parses its own raw body (`express.raw`, mounted ahead of `express.json`). When a POST carries no body — no `Content-Length`, no `Transfer-Encoding`, or `Content-Length: 0` with no content type — `express.raw` hands the route `{}`, and `receiveReadWebhook` (`src/meeting_evidence/meeting_evidence_service.js`) did `Buffer.from({})`, which throws `ERR_INVALID_ARG_TYPE`. The route answered 500 `processing_failed` and wrote no `meeting_webhook_security_receipts` row, so the cheapest probe to send left no trace. Fix: a non-Buffer, non-string body is an empty body (`Buffer.alloc(0)`); the delivery then reaches the governed refusal chain unchanged — with the verification environment's configuration (connection id, no signing key) that is 503 `refused_unknown_connection`, receipted with `byte_length` 0 and the empty-body sha256. Signature verification and the payload path are untouched. Proof: `tests/e2e/read_ai_webhook_empty_body.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — writes the bodiless POST straight to the socket (fetch cannot omit `Content-Length`): not 500, a `refusal_status` the table's check admits, one new receipt row for the empty hash whose `refusal_status` matches the response; the `Content-Length: 0` form pinned beside it. Falsified against the unmodified parent `dbe8771`: 0/5 — 500 `processing_failed` on both forms, server log `TypeError [ERR_INVALID_ARG_TYPE] … Received an instance of Object`, no receipt. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/meeting_evidence/meeting_evidence_service.js`; `tests/e2e/read_ai_webhook_empty_body.e2e.js`; `tests/e2e/verify_all.sh` |
| 46 | **RESOLVED IN SOURCE, 2026-09-05 — `GET /operator/build` answered anyone, though documented as behind the operator gate.** The key gate in `server.js` exempts `/operator/*` on the stated premise that every route there resolves its own staff session. `/operator/build` (`src/baseline/baseline_routes.js`) resolved nothing and published the full build identity — untruncated commit, resolving variable, node version, process start — with no credentials at all. Fix: the route resolves `x-staff-session` through the `staffSessions` resolver injected in row 39; no session → 401 `No valid operator session. Sign in.` (the same refusal as the other `/operator/*` gates); the shared operator key alone is not a session. `/health` keeps its anonymous SHORT sha by design and is pinned so the two doors do not drift into each other. Proof: `tests/e2e/operator_build_gate.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — no credentials 401 with no build record; operator key alone 401; unresolvable token 401; staff session 200 with `build.commit` and `resolved_from`; `/health` 200 with `commit_short` and never `commit`. Falsified against the unmodified parent `7d56a8b`: 2/6 — 200 with the full record for all three unauthenticated calls. No app caller for `/operator/build` at pinned app `4849545`. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/baseline/baseline_routes.js`; `tests/e2e/operator_build_gate.e2e.js`; `tests/e2e/verify_all.sh` |
| 45 | **RESOLVED IN SOURCE, 2026-09-05 — an org admin's roster disclosed seats on other organizations' properties.** `GET /org/me` and `GET /org/users` (`src/identity/org_admin.js`) scope USERS to `req.orgId` but joined `property_team_assignments` without asking which organization the property belongs to. A user seated on a property in another organization showed that seat to this org's admin — `assignment_id`, `property_id`, `role_key`, `allowed_modules`, `can_manage_roles`, with only `property_name` blanked — and `/org/me` counted it in `property_count`. `DELETE /org/users/:userId` already confined deactivation to the org's properties; the reads did not match it. Fix: `/org/me` counts `distinct p.id` through `properties p … and p.organization_id = $1`; `/org/users` aggregates `filter (where p.id is not null)` instead of `a.id is not null`. Response shapes unchanged. Proof: `tests/e2e/org_roster_scope.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — two organizations, a staff member seated in both; `/org/me` `property_count` 1; `/org/users` lists only the org's own seat, the admin's own seat still listed, the other organization's user absent from both reads. Falsified against the unmodified parent `7b27a35`: 5/8 — `property_count` 2 and the foreign seat listed with `property_name: null`. No app caller for `/org/*` at pinned app `4849545` (`git show 4849545:index.html`). Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/identity/org_admin.js`; `tests/e2e/org_roster_scope.e2e.js`; `tests/e2e/verify_all.sh` |
| 44 | **RESOLVED IN SOURCE, 2026-09-05 — a move-in could be scheduled on one unit against a lease that lives on another.** `POST /units/:id/schedule-move-in` (`src/tenancy/movein.js`, legacy operations route) wrote whatever `lease_id` the body named into `unit_events.lease_id` without asking whether that lease's space (`leases.space_id → spaces.unit_id`) is on the unit. Two consequences on the untouched parent: readiness approval of the wrong unit fed `unit_ready` into the other lease's delivery (`approveReadiness` → `deliveryHelper.satisfyDeliveryInput`), and `uq_unit_events_one_movein_per_lease` (migration 074) then refused the lease's real unit with a raw 500 `MOVE_IN_FAILED`. Fix: when a lease is named, one query resolves the unit that holds its space — no lease → 404 `LEASE_NOT_FOUND`; another unit → 409 `LEASE_NOT_ON_UNIT` naming the unit and saying nothing was scheduled. The no-lease legacy shape is unchanged. Proof: `tests/e2e/movein_lease_on_unit.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — foreign lease 409 with no event written; unknown lease 404; the lease's own unit 201 with the single `move_in_scheduled` event on it; no-lease body 201. Falsified against the unmodified parent `d2fed71`: 0/7 — 201 for the foreign lease, then 500 `MOVE_IN_FAILED` for the lease's own unit. No app caller at `4849545`; `tests/arcs/movein_beat.js` calls it with the lease's own unit and is unaffected. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/tenancy/movein.js`; `tests/e2e/movein_lease_on_unit.e2e.js`; `tests/e2e/verify_all.sh` |
| 43 | **RESOLVED IN SOURCE, 2026-09-05 — a notice was written without `unit_events.space_id`, so the canonical space reader never saw it.** `POST /units/:id/notice` (`src/tenancy/notice.js`) resolves WHICH space the notice is on (a by-bed unit must name it) and then wrote the space only into the JSON payload. The canonical space reader (`src/tenancy/space_position.js`) finds a notice by the COLUMN `ue.space_id` (migration 081), so a notice succeeded — 201, receipt and all — and was invisible to availability, the future rent roll and every surface that reads `space_position`. Fix: the insert writes the resolved `t.space_id` into the column. Nothing else about the route changes. Proof: `tests/e2e/notice_space_column.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — 201 with the resolved tenancy; `unit_events.space_id` equals the resolved space; the space reader's own predicate (`ue.space_id = s.id and event_type='notice_given' and status='scheduled'`) finds the notice with its move-out date. Falsified against the unmodified parent `7170d5c`: 201 with `space_id` NULL and the predicate finding nothing. No app caller at `4849545`. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/tenancy/notice.js`; `tests/e2e/notice_space_column.e2e.js`; `tests/e2e/verify_all.sh` |
| 42 | **RESOLVED IN SOURCE, 2026-09-05 — a revoked Read AI connection was re-opened by any re-post.** `POST /operator/meeting-evidence/read-ai/connection` upserts the one provider connection (`integration_connections`); its `on conflict` set `connection_status='active'` unconditionally, so a connection an administrator had revoked to stop ingress came back to life the moment any meeting-evidence user (management, asset_management or leasing module) called the route again. Fix: the update is predicated on `connection_status <> 'revoked'`; a revoked row is refused 409 `read_ai_connection_revoked` and nothing is written. **Deliberately unchanged, and CLASSIFIED:** on a re-post the ORIGINAL `authorized_by_user_id` stays on the row — delivery-finality qualification (`meeting_evidence_service.js`, *only the user who authorized this Read connection may qualify*) is bound to that user, so rewriting it on every re-post would hand that authority to whoever posted last. The donor branch's version, which recorded the re-poster as the new authorizer, is rejected for that reason. Whether a different user may re-authorize at all, and how a revoked connection is deliberately re-authorized, are owner decisions. Proof: `tests/e2e/read_ai_connection_authority.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` (`boot.sh` now names `READ_AI_CONNECTION_ID`) on a disposable loopback database — first authorization 200; re-post against a revoked row 409 from another user and from the original authorizer, row still revoked with its metadata untouched; re-post on an active row by another user 200 with the original authorizer retained. Falsified against the unmodified parent `e35cef3`: the revoked connection answered 200 and was active again. No app caller at `4849545`. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/meeting_evidence/meeting_evidence_service.js`; `tests/e2e/read_ai_connection_authority.e2e.js`; `tests/e2e/boot.sh`; `tests/e2e/verify_all.sh` |
| 41 | **RESOLVED IN SOURCE, 2026-09-05 — four queries still read `work_orders.person_id`, a column migration 098 dropped.** 098 split it into `reported_by_person_id` and `affected_person_id` and dropped the old name. `GET /tenant/me` (`src/comms/tenant_link.js`) kept `where person_id = $1`, so EVERY resident's own view has answered 500 "Could not load your view." since 098. `src/surfaces/desks.js` kept `w.person_id` in three queries (tenant-waiting count, item list, tenant-waiting set), so the maintenance dashboard has answered "Maintenance board unreadable" with an `unavailable` headline (`column w.person_id does not exist`) and the operator-home maintenance card has shown its fallback text. Re-derived on this tree, ONE definition: the resident of a work order is the person its updates go to — `coalesce(affected_person_id, reported_by_person_id)`, the precedent `src/technician/conversation.js` already uses — so "tenant waiting" measures the person who would receive the reply; the resident's own view lists what they REPORTED or what AFFECTS their home (both of 098's relationships). Proof: `tests/e2e/work_order_person_columns.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — `/tenant/me` 200 listing exactly the reported and the affected orders (not the complete one, not a neighbour's); maintenance-dashboard 200 with an `ok` headline, `tenant_waiting` counting the tenant-sourced orders with no update sent, the resident's item carrying their name; operator-home's maintenance card carrying real facts. Falsified against the unmodified parent `1e66af6`: 500, `unavailable`, fallback text. The deployed app (`4849545`) calls the maintenance dashboard and operator-home; the resident portal calls `/tenant/me`. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/comms/tenant_link.js`; `src/surfaces/desks.js`; `tests/e2e/work_order_person_columns.e2e.js`; `tests/e2e/verify_all.sh` |
| 40 | **RESOLVED IN SOURCE for the presented-session case, 2026-09-05; the key-only legacy path is CLASSIFIED, not decided.** `POST /ingest/:runId/approve` and `/promote` resolved a staff session for attribution (#39) but never asked whether that session was seated on the run's property: a session seated on ANOTHER building approved and promoted this run's units and was recorded as reviewer and promoter. Fix: when a session resolves, its `property_id` must equal the run's, else 403 `property_scope_refused` before any write; the run-not-found 404 and the body-actor 400 come first, unchanged. Proof: `tests/e2e/ingest_property_authority.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — wrong-property approve and promote 403 with no candidate change and no unit created; same-property approve 200 / promote 200 with the seated user recorded; body actor 400 even from a wrongly seated session; unknown run 404 first. Falsified against the unmodified parent `5ffab561`: the wrong-property session approved (200, reviewer recorded) and promoted (200, unit created). **CLASSIFIED, awaiting an owner ruling:** with no session at all — or a presented token that does not resolve — every route in `document_ingest_routes.js` still runs on the shared operator key alone and records no actor. Eight routes: pasted-text and file ingest, run read, candidate edit, bed-group read and grouping, approve, promote. No caller in the pinned app (`4849545`); no governed consumer found in `tools/`, `docs/` or `tests/` (one proof, `deal_setup_http.db.js` H19, uses key-only only to prove the body-actor refusal). Requiring a session or retiring the door changes the route contract; that decision is the owner's, and this slice deliberately did not take it. The unresolvable-token case is asserted in the proof so it cannot drift silently into either meaning. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. | `src/agent/document_ingest_routes.js`; `tests/e2e/ingest_property_authority.e2e.js`; `tests/e2e/verify_all.sh` |
| 39 | **RESOLVED IN SOURCE, 2026-09-04 — three extracted routes referenced a session resolver they never received.** When `server.js` was decomposed on 2026-08-27, `POST /ingest/:runId/promote`, `POST /ingest/:runId/approve` (`src/agent/document_ingest_routes.js`) and `POST /properties` (`src/baseline/baseline_routes.js`) kept calling `staffSessions.resolveStaffSession(...)`, a module-level constant of `server.js` that neither factory was handed. In the two ingest routes the call ran BEFORE the handler's `try`, so the `ReferenceError` was an unhandled rejection and under Node 22 ONE call terminated the process; in `POST /properties` the `try` caught it and answered 500 where the route intends 401. Fix: `server.js` injects the one existing `staffSessions` into both factories; each factory asserts the dependency at construction (a missing binding now fails at boot, not at the first request); the two ingest resolutions moved inside their existing `try`. Every route path, status code, response shape, the global operator-key gate, the optional session and the body-actor refusal are unchanged. Proof: `tests/e2e/extracted_route_bindings.e2e.js`, invoked by `tests/e2e/verify_all.sh` against the real `server.js` on a disposable loopback database — key-no-session 401, session-no-key 401 with no mutation, key+same-property session approve 200/`approved_count` 1/`reviewed_by` recorded and promote 200/`promoted_count` 1/no skips/`promoted_by` recorded/unit linked/server healthy, an injected rejecting resolver → handled 500 on both with the process alive, construction without the binding throws. Falsified against untouched `d55dae9`: `POST /properties` answered 500 and the promote call ended the server process. **This proves actor ATTRIBUTION, not property AUTHORIZATION** — the legacy routes' property-scope policy is untouched and is a separate decision. Rung: `HTTP_PROVEN` locally through the verification parent; CI has not yet run this commit. The deployed app (`4849545`) does not call these three routes; any operator-key holder can. | `server.js`; `src/agent/document_ingest_routes.js`; `src/baseline/baseline_routes.js`; `tests/e2e/extracted_route_bindings.e2e.js`; `tests/e2e/verify_all.sh` |
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
| 12 | **RULED 2026-08-20 — ACCEPTED AS INTENDED, WITH A REVISIT TRIGGER.** ~~A real hole in published-pricing immutability~~ — `delete from properties` cascades through the freeze that direct term deletion correctly refuses. Owner's ruling: **allow it for now.** Deleting a property should delete its pricing. **Revisit trigger, stated by the owner: "when we start dealing with more real properties."** Recorded rather than closed, because the day that trigger fires, this becomes a schema change nobody will remember was a deliberate choice. | `tests/e2e/agent_pricing_wall.e2e.js` teardown comments |
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
| 34 | **RESOLVED IN CODE; GUARANTOR SIGNING RELEASE PENDING, 2026-08-22.** This supersedes row 29's remaining guarantor limitation. A guarantor-required governing packet now issues separate one-time resident and guarantor links into one retained lease package; each signer sees the complete package but can complete only their own controls. Either may sign first, while company execution remains blocked until every required resident-side signer has both signed and finally submitted. Application Records and the existing Ask Spine leasing standing read the same packet signer roster and progress. Guarantor identity remains packet-scoped rather than silently creating a durable Person; raw link secrets are never stored, and signer identity plus issued control structure freeze after issuance. Integrated proof: guarantor signing 40/40, governing execution 16/16, canonical lease execution 25/25, and all 48 source-governance gates. **Not deployed:** production remains at ledger 189, so migrations 190-192 require a deliberate release before this code can boot; no real signing link, SMS, or lease execution was attempted. | migration 192; `src/applications/leasepackets.js`; `src/applications/application_review.js`; `src/leasing/leasing_standing_read.js`; `tests/lease_guarantor_signing.db.js`; integrated commit `476730a` |
| 35 | **LIVE CORRECTION TO ROWS 32-34, 2026-08-22.** A later read supersedes their deployment identity and ledger counts: production `/health` identifies API `abcb28e`, and a transaction proven read-only before its first read found 179 ledger rows at ceiling **191**, with no orphan, name-conflict, or duplicate-number defect. Migrations 190-191 have therefore already been released and must not be run again. Against the guarantor branch, the only pending file is `192_lease_packet_signers.sql`; row 34's release scope is 192 alone. This correction records the newer observation and does not claim migration 192 or the guarantor code is deployed. | production `/health`; `tools/ledger_reconcile.js` against Render's current `DATABASE_URL`; observed 2026-08-22 |
| 36 | **DEPLOYED AND SCHEMA-PROVEN; REAL SIGNING JOURNEY NOT YET EXERCISED, 2026-08-22.** The reconciled Q5 lineage and row 34's guarantor signer rail are live at API `a5c0f66`; the separate resident/guarantor progress UI is live at app `83e2b67`. Migration 192 ran inside a SHA-pinned Render pre-deploy gate from an exact 191/179 start, and the temporary release command was removed immediately afterward. A fresh transaction proven read-only before its first read found ceiling 192 with 180 rows, no pending or orphan migration, all signer tables/indexes/triggers/guards present, and all four legacy tenant links backfilled with zero token or submission drift. The live app bundle contains the separate-link issue/progress controls and has no page overflow at 1280px or 390px. **Still unclaimed:** no real resident or guarantor link was issued, no SMS was sent, no lease was executed, and the authenticated Application Records presentation has not been observed with live signer data. | API deploy `dep-da4sp5740ujc739ubabg`; app deploy `dep-da4sq7rm8hqs73am3ei0`; `tools/ledger_reconcile.js`; production schema re-read 2026-08-22 |
| 37 | **CI-CONNECTED, `HTTP_PROVEN`, AND `BROWSER_VERIFIED`; PRODUCTION ACTIVATION UNCHANGED, 2026-08-22.** The full Skyline-shaped journey now begins at the canonical staff invite instead of hand-assembling an accepted identity. A real server and fresh migrated Postgres completed manager-confirmed Person -> fake invite SMS -> fake OTP -> atomic Mike identity/access/work assignment -> native tour -> operations webhook -> post-tour capture -> the exact same personal Ask Spine answer through dashboard and staff SMS -> exact-bed application -> V3 guarantor capture -> separate resident/guarantor links and submissions -> manager/company authority handoff -> company execution -> exact-bed tenancy, 50/50. Real Chromium separately completed the resident's official governing-package UI, including explicit full-name signature intent and final submission, 7/7. `verify_all.sh` now runs both and finished `ALL PROOFS PASSED`; its E2E launcher always preloads the fake SMS transport, even if the caller's shell contains carrier credentials. Two older lease proofs were aligned to the already-required signature-consent contract, and one duplicated OTP resend predicate was deleted with no behavior change. **Not claimed:** no real carrier was contacted, no live Mike/resident/guarantor action occurred, and this does not advance Skyline's production activation state. | `tests/e2e/tour_application_lease.e2e.js`; `tests/e2e/resident_signing.browser.js`; `tests/e2e/leasing_e2e_lib.js`; `tests/e2e/leasing_path.e2e.js`; `tests/e2e/boot.sh`; `tests/e2e/verify_all.sh`; `src/identity/teamaccess.js` |
| 38 | **`migrations/migrate.js` hardcodes SSL, so `--apply` cannot build a schema on a local non-SSL Postgres.** Found while building a local harness DB for the structure thread's real-Postgres proof. Production and CI SSL targets are unaffected, but a local disaster-recovery rehearsal fails before application proofs can begin. | `migrations/migrate.js:173`; `docs/current-state-build/06_WAVE3_RESULTS.md` |

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
| Funding boundary wall | enforced | — | `tests/gates/gate_funding_boundary.js` — tax/insurance funding cannot cross into economics |

## Leasing lifecycle — `src/{leasing,applications,tenancy,onboarding}/`

**None of this is registered with Ask Spine** — the gate cannot see these directories.

| Capability | Rung | Files / note |
|---|---|---|
| **Deal Setup / Opening Tenancy** | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `deal_setup_http.db.js` **spawns real `server.js`**, real socket, restart persistence. **Best-proven capability in the repo** |
| Lead intake | `LOCALLY_EXERCISED` | `leasing_leads.js` |
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

---

## Append-only runtime correction and lease-CI receipt — 2026-08-24

**`REPORTED` runtime correction — supersedes rows 35 and 36 for current-state
use.** The owner independently re-verified on 2026-08-24 that production is API
`61f99bf` with migration-ledger ceiling **189**. The later-looking 2026-08-22
claims in rows 35 and 36 that ceilings 191 and 192 were deployed are therefore
not current runtime truth. Those rows remain untouched as history under this
file's append-only rule. This laptop session did not contact Render or Neon and
does not claim an independent runtime observation. Treat migrations 190–192 and
the lease/guarantor working heads as unreleased until the owner performs the
deliberate reconciliation and release.

**`LOCALLY_EXERCISED` in disposable branch CI; no production rung moved.** Four
lease/guarantor proofs that existed but were invoked by no CI path are now
appended to the existing `tests/e2e/verify_all.sh` command: the pure Application
Review action contract before database setup, then the governing-instrument,
canonical-execution, and guarantor-signing database proofs after the real
migration chain and fixtures. The database proofs receive CI's disposable
`E2E_DATABASE_URL` only through their production-refusing
`HARNESS_DATABASE_URL` boundary. This is **Class 3 — test infrastructure**; it
adds no business-logic path and has no activation removal condition.

The connection was falsified, not inferred. A deliberate wrong application ID
made the Application Review proof fail while all three newly connected database
proofs still ran and passed; the parent runner printed `VERIFICATION FAILED`
and GitHub Actions recorded exit code 1 at commit `c16c34b` ([red run
124](https://github.com/kzitelli-art/property-spine-api/actions/runs/32723805211)).
The exact original test bytes were restored. At commit `b160287`, Application
Review and all three database proofs passed and the same parent printed
`ALL PROOFS PASSED` ([clean run
125](https://github.com/kzitelli-art/property-spine-api/actions/runs/32724076888)).
This continuously re-exercises existing local HTTP/browser/database evidence;
it does not establish a Render deploy, a Neon migration release, a live carrier
interaction, or a real resident/guarantor signing journey.

---

## Mike Grivna staff-invite link repair — 2026-08-24

**`REPORTED` production defect; source cause established.** Mike received the
real Skyline staff-invitation SMS, but its link answered `Missing or wrong
x-operator-key.` The invitation writer built `APP_BASE_URL + /join/{token}`.
The API had no route at that path and the global gate did not classify it as a
public door; no app branch consumed `/join/{token}` either. The existing
end-to-end proof extracted the token from the API response and posted it
directly to `/auth/sms/start` and `/auth/sms/verify`, so it proved the canonical
acceptance transaction while stepping around the link the human actually
received.

**`LOCALLY_EXERCISED` in disposable branch CI; not deployed.** Newly issued
staff invitations now name `/auth/join/{token}`, inside the already-public
`/auth/` boundary. That mobile page asks the invitee to request and enter the
six-digit code, then delegates to the existing start/verify endpoints; it owns
no OTP, identity, access, assignment, or session writer. The Skyline journey
also opens the literal returned URL over real HTTP before it may extract the
token. A dedicated real-Chromium proof starts from the exact invitation URL,
requests the fake-carrier OTP through the page, verifies through the page, and
rereads the accepted invite, person bridge, staff context, property-team
access, and leasing work assignment from disposable Postgres.

The new runner entry was falsified independently. An impossible browser
selector made only `browser: staff invite accepts` fail; the later
invite-to-guarantor journey still passed, the parent printed `VERIFICATION
FAILED`, and GitHub Actions preserved exit code 1 at `f93147b` ([red run
128](https://github.com/kzitelli-art/property-spine-api/actions/runs/32728182465)).
The exact browser-test bytes were restored at `50b6f08`, and the full parent
returned `ALL PROOFS PASSED` ([clean run
129](https://github.com/kzitelli-art/property-spine-api/actions/runs/32728457693)).

`src/identity/staff_invite_acceptance_page.js` is **Class 2 — temporary
adapter**. Removal condition: the canonical staff app has its own
browser-verified invite-token entry screen. Until this branch is deliberately
reconciled and deployed, Mike's production link remains broken; do not issue a
replacement invitation merely to send the same old URL again. After release,
create one new canonical invite because the prior link both points to the old
door and has a 72-hour expiry, then observe Mike's real acceptance and reread
the four production identity/access records before claiming activation.

### 24 Aug 2026 — staff-invite terminal-state hardening evidence stop

The canonical staff-invite start door could issue an OTP after an invitation
had become `superseded`. The verify door then refused that same invitation.
The human therefore received fresh-looking evidence from a lifecycle state
that could never complete. The same source review found inconsistent terminal
receipts between start and verify, no invitation-expiry check at verify, and a
fifth wrong code reported as retryable even though it had just locked the
invitation.

Current branch source now routes both `/auth/sms/start` and
`/auth/sms/verify` through one lifecycle classifier. Only `active` invitations
may reach OTP issuance or comparison. Accepted, revoked, superseded, expired,
locked, and unknown states stop with explicit receipts; the fifth wrong code
returns the locked receipt immediately. The existing browser proof was
extended to exercise every terminal state, preservation of the invite row,
absence of carrier sends and user provisioning, inert GET behavior, lockout,
successful acceptance, and accepted-invite replay. It remains invoked by the
existing end-to-end runner; the runner was not reordered or restructured.

**NO EXECUTION CLAIM RUNG EARNED IN THIS SESSION.** Node parsed the two changed
files and the static team-access session-boundary test passed. The local source
governance parent stopped before this proof because this laptop has no
installed `express` dependency; it printed parent exit 1 and marked the later
tests NOT RUN. Commits written through the GitHub connector did not dispatch a
branch-push Actions run, and the available browser controller stopped on an
environment error. No green execution was observed, so no deliberate red/green
falsification was attempted and no `LOCALLY_EXERCISED`, `HTTP_PROVEN`,
`BROWSER_VERIFIED`, `DEPLOYED`, or `PRODUCTION_PROVEN` claim is made. Neon,
Render, the SMS carrier, and production were not contacted.

The shared lifecycle classifier is **Class 1 — permanent primitive**. The
expanded proof is **Class 3 — test infrastructure**. The existing public
acceptance page remains **Class 2 — temporary adapter**, removable only when
the canonical staff app owns a browser-verified invite-token entry screen.
This slice does not claim to serialize concurrent invitation creation and
supersession; that transaction question needs its own observed stop and
contract before changing the writer. The forbidden second path remains a new
OTP store, status vocabulary, provisioning writer, app entry path, or
property-specific branch.

Next evidence step: dispatch the branch workflow through an authenticated
human Git push or manual Actions run; inspect the exact terminal-state browser
output; then deliberately break one lifecycle assertion, require parent exit
1, restore the exact bytes, and require a clean parent run. Append any earned
rung here afterward; do not rewrite this stopped receipt.

### 24 Aug 2026 — superseded lease-signing links fail closed

**`HTTP_PROVEN` in disposable branch CI; not deployed.** Packet versioning
already marked an issued lease package with `superseded_at` when staff created
a governed replacement, and the company-signing door already refused that old
package. The canonical public token resolver nevertheless selected resident
and guarantor links using only token hash, expiry, and non-void status. An old
link could therefore still disclose the obsolete package and accept signer
traffic after staff had replaced it.

Both the migration-192 signer-token query and its legacy resident-token
fallback now require `lease_packets.superseded_at is null`. The existing
hostile lease journey creates a real issued packet, supersedes it through the
governed new-version command, and requires the old public link to return 404
for both packet read and final submit. No token store, status, route, signing
service, migration, or runner path was added.

The evidence cycle was observed against exact GitHub SHAs. Run
[#152](https://github.com/kzitelli-art/property-spine-api/actions/runs/32755614094)
tested `426faa8`, reported the hostile proof PASS, parent exit 0, no NOT RUN,
and every later proof executed. The test stayed intact while only the current
signer query's non-superseded predicate was removed at `4877ce7`; run
[#153](https://github.com/kzitelli-art/property-spine-api/actions/runs/32757553306)
then captured `superseded resident read refused — accepted 200` and
`superseded resident submit refused — accepted 409`, reported hostile proofs
10 passed / 2 failed, and returned parent exit 1 while still executing every
later proof. The exact guarded source blob was restored at `bd747de`; run
[#154](https://github.com/kzitelli-art/property-spine-api/actions/runs/32757884687)
reported the hostile proof PASS, parent exit 0, no NOT RUN, and every later
proof executed. Passing assertion lines are suppressed by the parent runner
and are not claimed as observed output; the product-side red run establishes
that those assertions can turn the parent red.

This also corrects the preceding receipt's tooling inference that
connector-authored pushes did not dispatch Actions. GitHub's run history later
showed push runs on the exact commits; the available workflow lookup was blind
to those push events. Exact `05ef8ba` was independently repeated by manual run
[#149](https://github.com/kzitelli-art/property-spine-api/actions/runs/32754235727):
parent exit 0, all 23 steps PASS, no NOT RUN, real Postgres and Chromium, and
the staff-invite browser proof plus both later lease journeys executed. The
older missing-selector red proves that browser step reaches the parent, but it
does not by itself establish that each lifecycle assertion detects a product
regression; no broader rung is inferred from that selector break.

The canonical token resolver guard is **Class 1 — permanent primitive**. The
hostile journey extension is **Class 3 — test infrastructure**. At closeout,
the three ownership lanes remained separate: Codex changed only
`src/applications/leasepackets.js` and its hostile lease proof; CAMP remained
on standing-projection / Ask Spine files at last-reported `1eb6221`; CABIN
remained on tenancy standing/move-in reads and its named proofs at
last-reported `41c1aa6`. `tests/e2e/verify_all.sh` was not changed.

No main merge, PR, deployment, migration, app or `index.html` change, Neon or
Render contact, production read/write, or carrier action occurred. The next
bounded source question is the public V3 guarantor fact: validated captured
contact and top-level `guarantor_name` currently can disagree before packet
generation decides whether a guarantor signer is required.

Cross-branch coordination remained contained. CAMP's exact `1eb6221` full
parent baseline is red at run
[#32731669834](https://github.com/kzitelli-art/property-spine-api/actions/runs/32731669834):
the clean lease path, hostile lease proof, cross-surface reconciliation,
standing/review comparison, and resident browser signing stop on
`signature_intent_required`. CAMP correctly refused to edit or import the
Codex-owned application and lease helpers. This is recorded as integration
drift requiring an owner reconciliation ruling after the bounded branches
close, not as a source collision and not as authority to expand this slice.

### 24 Aug 2026 — public V3 guarantor identity has one submission authority

**`HTTP_PROVEN` in disposable branch CI; not deployed.** The V3 public
application validator already required a complete
`captured.guarantor_contact` when the applicant selected that a guarantor was
needed. The same request separately accepted top-level `guarantor_name`, and
the canonical application birth persisted that independent value. Packet
generation later decided whether a guarantor signer was required from
`!!lease_applications.guarantor_name`. A crafted request could therefore pass
the complete V3 capture contract while omitting or contradicting the value
that controlled the signer rail.

The public V3 door now derives the persisted guarantor name from the validated
captured contact. An omitted legacy duplicate is the normal V3 shape; a
non-empty duplicate that contradicts the captured name returns 400 before the
invitation is consumed or an application is born. V2 and internal/import
callers keep their existing contracts. No route, service, status, column,
migration, packet branch, or client-side authority was added.

The exact evidence cycle ran automatically on GitHub. Run
[#32763311993](https://github.com/kzitelli-art/property-spine-api/actions/runs/32763311993)
tested `5f5f212`, returned parent exit 0 with no NOT RUN, and the terminal
invite-to-guarantor journey plus every earlier proof passed. The test stayed
intact while only the product-side contradiction refusal was disabled at
`068b7a5`; run
[#32763661967](https://github.com/kzitelli-art/property-spine-api/actions/runs/32763661967)
stopped that journey at `a contradictory V3 guarantor name is refused before
application birth` and returned parent exit 1. Because that fail-closed
assertion stopped its journey, the subsequent omission/derivation assertions
did not execute on the red run; no broader red claim is inferred. The exact
product source blob was restored at `cf7fcade`; run
[#32763940585](https://github.com/kzitelli-art/property-spine-api/actions/runs/32763940585)
returned parent exit 0, no NOT RUN, every later proof through the terminal
guarantor journey, and `ALL PROOFS PASSED`. Successful individual assertion
lines are suppressed by the parent runner and are not quoted as observed.

The V3 public-submission authority guard is **Class 1 — permanent primitive**.
The extended real-HTTP/Postgres journey is **Class 3 — test infrastructure**.
`tests/e2e/verify_all.sh` was not changed. Separately, Codex aligned three
Codex-owned lease proof helpers on CAMP with the already-required intentional
signature contract; exact CAMP head `40f84f0` returned full-parent green in
run
[#32764307766](https://github.com/kzitelli-art/property-spine-api/actions/runs/32764307766)
with no NOT RUN. That compatibility repair was Class 3 only and changed no
CAMP product source.

No main merge, PR, deployment, migration, app or `index.html` change, Neon or
Render contact, production read/write, or carrier action occurred. Production
and Mike Grivna's real activation state are unchanged.

### 24 Aug 2026 — typed lease signature must match the named packet signer

**`HTTP_PROVEN` in disposable branch CI; not deployed.** The public lease
field writer already resolved the current packet signer from the token,
required explicit signature consent, and server-authored the resident or
packet-signer linkage. It nevertheless accepted any trimmed signature value
of two characters or more. A token holder could type a contradictory name and
Spine would mark the signature complete while attributing it to the packet's
named resident or guarantor.

Signature completion now normalizes Unicode compatibility form, surrounding
and repeated whitespace, and case for both the typed value and the signer's
frozen `display_name`. A missing signer name returns 409; a contradictory
typed name returns 400 before the field update. The normal e2e helper types the
signer name returned by the same public packet read. This is a consistency
guard, not identity verification: the packet signer name remains a claim, and
the change does not silently promote a guarantor into a durable Person.

Run
[#32764970080](https://github.com/kzitelli-art/property-spine-api/actions/runs/32764970080)
tested baseline head `4d451190`, returned parent exit 0, hostile
falsifications PASS, no NOT RUN, every later proof through the guarantor
journey, and `ALL PROOFS PASSED`. The hostile proof stayed intact while only
the product mismatch predicate was disabled at `393f9cb`; run
[#32765268066](https://github.com/kzitelli-art/property-spine-api/actions/runs/32765268066)
captured `contradictory typed signature refused — HTTP 200` and
`stored={"completed":true,"field_value":"Not Probe Tester ..."}`, reported
hostile proofs 12 passed / 1 failed, and returned parent exit 1. No NOT RUN was
reported and every later top-level proof still passed. The exact guarded
product blob was restored at `6a7754c`; run
[#32765554773](https://github.com/kzitelli-art/property-spine-api/actions/runs/32765554773)
returned parent exit 0, hostile falsifications PASS, no NOT RUN, every later
proof through the guarantor journey, and `ALL PROOFS PASSED`. Successful
individual hostile assertions are suppressed and are inferred only from the
containing fail-closed proof result; the product-side red supplies the direct
observed evidence that both the HTTP and database walls can turn the parent
red.

The signature-name consistency guard is **Class 1 — permanent primitive**.
The hostile refusal and normal helper alignment are **Class 3 — test
infrastructure**. No second signer store, identity path, route, status,
column, migration, or runner path was added.

No main merge, PR, deployment, migration, app or `index.html` change, Neon or
Render contact, production read/write, real signing action, or carrier action
occurred. Production and Mike Grivna's real activation state are unchanged.

### 24 Aug 2026 — completed lease-signer evidence is immutable and exact retries are idempotent

**`HTTP_PROVEN` in disposable branch CI; not deployed.** Migration 192 already
installed a database trigger that freezes completed lease-field evidence. The
public field-completion door nevertheless attempted the same update again when
a signer retried an already-completed field with the same value. The database
correctly rejected that write, but the human received HTTP 500 even though
nothing had changed. A client retry could therefore look like a failed signing
action after the signature had actually been retained.

The canonical field writer now recognizes an exact retry only after resolving
the current signer, requiring explicit signature intent, and applying the same
typed-name consistency check as the first submission. If the stored completed
value and normalized incoming value agree, it returns HTTP 200 with an
idempotent receipt without rewriting the field or adding a second audit event.
A conflicting repeat returns 409. The ordinary completion update remains
guarded by `completed = false`; the migration-192 trigger remains the final
database wall. No route, signer store, status, column, migration, alternate
writer, or runner path was added.

Run
[#32768335894](https://github.com/kzitelli-art/property-spine-api/actions/runs/32768335894)
tested baseline `26c98d2`, returned parent exit 0, hostile falsifications PASS,
no NOT RUN, every later proof through the guarantor journey, and `ALL PROOFS
PASSED`. The hostile assertion stayed intact while the product-side exact-retry
return was disabled at `8b8cbb7`; run
[#32768753533](https://github.com/kzitelli-art/property-spine-api/actions/runs/32768753533)
then returned parent exit 1. Its exact evidence was retry HTTP 500 with no
idempotent response while the database trigger preserved the completed row:
`completed_at`, `field_value`, and the original `session_id` were unchanged,
and the audit count stayed 1→1. This was a genuine HTTP-contract red; it was
**not** an observed evidence rewrite. No NOT RUN was reported and every later
top-level proof still passed.

The exact guarded source was restored at `b7c806f`; run
[#32769063555](https://github.com/kzitelli-art/property-spine-api/actions/runs/32769063555)
returned parent exit 0, hostile falsifications PASS, no NOT RUN, every later
proof through the terminal guarantor journey, and `ALL PROOFS PASSED`.
Successful inner retry/session/audit assertion text is suppressed by the parent
runner and is not quoted as observed.

The migration-192 completed-evidence trigger is **Class 1 — permanent evidence
primitive**. The source-level idempotency/refusal boundary is **Class 1 —
permanent primitive**. The hostile retry proof is **Class 3 — test
infrastructure**. This slice adds no temporary adapter or delete-on-activation
scaffolding.

No main merge, PR, deployment, migration, app or `index.html` change, Neon or
Render contact, production read/write, real signing action, or carrier action
occurred. Production remains API `61f99bf` at ledger 189 by the owner's last
verified runtime receipt; this branch and migrations 190–192 remain unreleased.
Mike Grivna's production activation state is unchanged.
