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
API verified against    77f93f5     2026-08-18
APP verified against    c6769ba     2026-08-18
Production ledger       ceiling 176 (deployed sha e5497a4)
Migrations on main      181         → 177,178,179,180,181 UNRELEASED
Surveyed / verified     2026-08-19
```

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
| 1 | **The leasing agent quotes `units.market_rent` directly to prospects.** Two adapters exist to prevent exactly this; both are `DARK BY CONSTRUCTION` and wired only to an internal endpoint + a preview tool, never the prospect path. Prior incident: *"disagreed with the sheet on unit 530 by $237 and went to nine real phones."* | `src/agent/agent.js:374`, `src/agent/pricing_adapter.js:10` |
| 2 | **`docs/deployment.md` instructs incorrectly about the one mechanism protecting production.** Says startup *"runs any unapplied migrations."* It does not — it verifies and **refuses to start**. | `docs/deployment.md:51` vs `migrations/migrate.js` |
| 3 | **An operator screen calls routes that 404.** A whole activation flow written, never mounted. | `src/identity/activation.js`; `grep -c "identity/activation" server.js` = **0** |
| 4 | **A test defaults to hitting PRODUCTION**, with no run receipt anywhere. | `tests/full_lifecycle_arc.js:47` |
| 5 | **Ask Spine has two obligation readers** (§7 violation). Its own header: *"Its QUERY LOGIC is sound and is re-expressed here."* | `src/agent/ask_spine_service.js` |
| 6 | **The §40.11 gate scans 2 of ~15 domain dirs** — `["src/asset","src/tenancy"]`. Leasing, applications, maintenance, technician, comms, obligations, money, onboarding cannot fail it. | `tests/gate_ask_spine_readers.js:100` |

---

## PRODUCTION-PROVEN — the whole list

| Capability | Evidence |
|---|---|
| **Work-order completion guard** | `activation_id d93b08dd-c682-46d2-acf9-78ab6b960827` · `2026-08-12T01:49:57.866Z` · 16/16 on live instance `kbtb6` · irreversible |
| **Migration release gate** | Runs on every boot via `prestart`; deployed sha enforces `EXPECTED_SHA` and refuses on mismatch |

Everything else in this document is **at best deployed, not observed.**

---

# THE INDEX

Grouped by where the code lives — a fact, not a taxonomy. Taxonomy is deliberately
unsettled; do not invent one while adding rows.

## Asset Management — `src/asset/`

| Capability | Rung | Ask Spine | Files / note |
|---|---|---|---|
| Compliance | `HTTP_PROVEN` + `BROWSER_VERIFIED` | registered | `compliance_*.js`. **The model to copy** — real request + real DB + real browser |
| Utilities | `LOCALLY_EXERCISED` ⚠ | registered | `utility_*.js`. Registered but **never proven end-to-end** — HTTP test uses a fake pool; DB test skips the router |
| Contracted Services | `LOCALLY_EXERCISED` ⚠ | registered | Same fake-pool pattern. Docs: *"not a production canonical write"* |
| Insurance | `HTTP_PROVEN` + `BROWSER_VERIFIED` | **none** | `insurance_*.js`. *"NEVER seen on a production page by an entitled account"* |
| Tax (Philadelphia) | `HTTP_PROVEN` + `BROWSER_VERIFIED` | **none** | `tax_*.js`, `philadelphia_tax_rules.js`. Clocks only, never amounts |
| Debt | `HTTP_PROVEN` | registered | `debt_instrument_service.js`, `debt_position_read.js`. Migration 173 released |
| Equity (Preferred + Common) | `HTTP_PROVEN` | registered | `equity_position_*.js`. Migration 174 released; **zero production rows, correctly** |
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
| Meeting Evidence (Read AI webhook ingress) | `BUILT_BUT_DORMANT` | Migrations 175/176 **released**. Waits on `READ_AI_WEBHOOK_SIGNING_KEY` set in Render. *"No meeting record, interpretation or receipt has been created."* |
| Meeting Receipt v0 pipeline | `BUILT_BUT_DORMANT` | Same gate |
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

## NOT YET SURVEYED — do not read absence as absence

| Area | Why it matters |
|---|---|
| **Teams / access / invites / roles** | **Highest-value gap.** An internal note records that no staff member other than the account owner has ever completed sign-in, and the exclusion path was *"only tested from inside."* |
| Management door (`surfaces/management*.js`) | One of the four operating doors |
| Onboarding & rent-roll intake internals | Parsing, field mapping, import batches |
| Money / pricing at real grain | ~26 files currently one row |
| **The entire app repo** | Every browser proof lives there; several use `fakePool()` |
| `server.js` inline routes | 3,000+ lines; a `src/`-only search misses it — this is exactly how a prior build miscounted its own doors |
| `tools/` | Which have ever actually been *run* |
| Cron · webhooks · env flags | Two flags already found switching off real capability |

Re-runnable research: `docs/current-state-build/wave2_coverage_gaps.js`

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
