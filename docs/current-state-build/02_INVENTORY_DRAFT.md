# CONSOLIDATED CAPABILITY INVENTORY — working draft, not the artifact

**Not `CURRENT_STATE.md`.** This is the raw evidence-grain row set, grouped by where
the code lives (a fact, not a taxonomy). Normalization comes after the owner reviews it.

## ⚠ PROVENANCE OF THIS DRAFT — read before trusting any row

Four researchers inventoried the API repo at **`14a79d2`**, which is **70 commits behind
`origin/main` (`77f93f5`)**. A fifth pass (running) covers the six domains that landed in
that gap, against fresh worktrees at current main.

Known deltas between the tree that was read and current main:

| What | Tree that was read (`14a79d2`) | Current main (`77f93f5`) |
|---|---|---|
| Ask Spine REGISTRY | 7 keys, `debt: pending` | 8 keys, `debt: registered`, `tenancy: registered` |
| `asset_management.js` contracted services | missing `derived:` — compartment always renders "No governed service contracts yet" | fixed |
| Migrations | ceiling 174 | ceiling 181 (175–181 added) |
| Domains | — | +Meeting Evidence, +Person ingress, +Forward Leasing, +Inventory retirement/rent-roll grain, +Tenancy Ask Spine, +release rail rework |

Only the Asset Management researcher diffed its findings against main. **Every row below
carries `VERIFY@MAIN` if it has not been re-checked against `77f93f5`.**

Repos: `api` = property-spine-api, `app` = property-spine-app (app main `c6769ba`).

---

## THE PROOF-RUNG DISTRIBUTION (the headline finding)

Counting distinct capabilities across all four inventories:

```text
PRODUCTION_PROVEN      1    Release 0 completion guard (measured on live instance kbtb6)
BROWSER_VERIFIED       ~8   and 3 of those use a FAKE database behind the browser
HTTP_PROVEN            ~15  real Postgres + real router in ONE test
LOCALLY_EXERCISED      ~30  the large majority — incl. nearly all of Leasing
BUILT_BUT_DORMANT      ~10  written, nothing calls it
REPORTED / dead        ~3
```

**One capability in the entire platform has been observed working in production.**

---

## A. ASSET MANAGEMENT (`api/src/asset/`) — diffed against main ✔

| Capability | Proof rung | Ask Spine | Production | Critical evidence |
|---|---|---|---|---|
| **Compliance** | **HTTP_PROVEN + BROWSER_VERIFIED** (real PG both) | `registered` | unknown | `tests/proofs/compliance_http.db.js` (real PG + `app.listen`, 64 assertions); `app/compliance_browser_proof.browser.js` (real Chromium + real PG, 39). **No THREAD_HANDOFF section exists for it at all** — best-proven domain, entirely undocumented |
| **Utilities** | **LOCALLY_EXERCISED** ⚠ | `registered` (+`governed_detail`) | unknown | `tests/unit/utility_http.test.js` = real HTTP but **hand-built fake pool**; `utility_persistence.db.js` = real PG but **no router**. The two never combine. `app/utilities_door.browser.js` uses `fakePool()`. **Registered and shipped-looking; never proven end-to-end** |
| **Contracted Services** | **LOCALLY_EXERCISED** ⚠ | `registered` (+`governed_detail`) | no | Same fake-pool pattern as Utilities. Doc: *"evidence-backed population rehearsal, not a production canonical write"* |
| **Insurance** | HTTP_PROVEN + BROWSER_VERIFIED | **`pending`** | **explicitly NO** | `insurance_establishment.db.js` 141 assertions. Doc: *"Insurance rendering real truth — NEVER seen on a production page by an entitled account… Do not describe Insurance as production-verified"* |
| **Tax** | HTTP_PROVEN + BROWSER_VERIFIED | **`pending`** | **contradicted** | `philadelphia_tax_http.db.js` 106 assertions. THREAD_HANDOFF says *"APPLIED… ceiling 167"* AND *"release 162–167 nothing is in production"* — same section |
| **Debt** | HTTP_PROVEN | `registered` (main) | no | VERIFY@MAIN — was `pending` on read tree, registered by PR #113 |
| **Equity** | HTTP_PROVEN | `registered` | no | migration 174 released; zero rows in production, correctly |

**Wall enforced:** `gate_funding_boundary.js` — tax/insurance funding cannot cross into economics.

---

## B. LEASING LIFECYCLE (`api/src/{applications,leasing,tenancy,onboarding}/`) — VERIFY@MAIN

**Governing finding: NOT ONE leasing capability is in the Ask Spine registry.**
`gate_ask_spine_readers.js` sets `STANDING_READ_DIRS = ["src/asset"]` — it structurally
cannot see this entire lifecycle. Not `pending`, not `waived`. Invisible.

| Capability | Proof rung | Evidence / note |
|---|---|---|
| **Deal Setup / Opening Tenancy Position** | **HTTP_PROVEN + BROWSER_VERIFIED** | `deal_setup_http.db.js` **spawns real `server.js` as a child process**, real socket, 20 checks incl. restart persistence. The one capability with the full ladder honestly proven. Production human pass explicitly unconfirmed |
| Lead intake | LOCALLY_EXERCISED (real DB) | `leasingleads.js`; no HTTP proof |
| Tours / appointment attribution | LOCALLY_EXERCISED (real DB) | `appointment_attribution.js`, `appointment_journey.js` |
| `tour_chips` · `capture_chase` · `capture_receipt` | **BUILT_BUT_DORMANT** | no `src/` or `server.js` caller — only tests reference them |
| Post-tour conversion rail | LOCALLY_EXERCISED; one seam HTTP_PROVEN | `slice9_inbound_decision_http_proof.js` real `listen` + `fetch`. **BLOCKING ruling open**: *"Status: BLOCKING for conversion-rail activation. Requires a ruling"* |
| AI Leasing Strategy | LOCALLY_EXERCISED | **CONFLICT UNRESOLVED**: docs say *"dormant"*; code shows it wired into the live first-response path (`leasingleads.js:614`). Both recorded |
| Leasing Desk (`/operator/leasing/desk`) | LOCALLY_EXERCISED (real DB) | Handoff claims *"real Postgres + authenticated HTTP"* — **direct file inspection contradicts the HTTP half** |
| Application submission / lifecycle | LOCALLY_EXERCISED (real DB) | `application_lifecycle.js`. Migration **125 does not exist** (124 → 126); source calls it "staged" |
| Application target authority (unit/bed) | LOCALLY_EXERCISED (real DB) | 49 assertions; unit with >1 space → controlled 409 refusal |
| Proposed terms | LOCALLY_EXERCISED + manual HTTP smoke | `smoke_proposed_terms_route.js` is a manual Render-shell script |
| **Lease packet / e-sign** | LOCALLY_EXERCISED | **NO E-SIGNATURE CAPABILITY EXISTS.** *"does NOT capture a legally-binding signature — those wait on the real lease template and a legal answer on e-sign"* |
| **Executed lease intake** | LOCALLY_EXERCISED | **FUNCTIONALLY OFF** — 503 unless `EXECUTED_LEASE_INTAKE_ENABLED=true` AND property allowlisted. No evidence set in production |
| Tenancy anchor (countersign/confirm-term) | LOCALLY_EXERCISED (real DB) | Fails closed 409 `executed_lease_required` while execution evidence is null |
| Move-in / economic tenancy activation | LOCALLY_EXERCISED | **pending ≠ active tenancy is real and enforced**: *"A pending lease is never promoted into current rent-roll truth merely because its start date arrived"* |
| Lease void | LOCALLY_EXERCISED (real DB) | **No HTTP route** — ops-tool only. Origin: six stuck leases needed raw SQL + owner approval |
| Notice to vacate | **REPORTED** | No dedicated test. Doc: *"built and never used… Live count across the whole database: 0"* |
| Dated / space position | LOCALLY_EXERCISED by indirection | Most depended-on primitive in leasing; no dedicated proof file |
| Renewals | LOCALLY_EXERCISED (real DB) | HTTP proof is opt-in (`API_BASE`) and skipped by default. Handoff claims browser proof; **no renewals `.browser.js` exists** |
| `followup_ladder` / `followup_runner` | **BUILT_BUT_DORMANT** | self-declared: *"DORMANT. Nothing calls this yet. It decides; it cannot send"* |

⚠ `tests/arcs/full_lifecycle_arc.js` **defaults to `https://property-spine-api.onrender.com`** —
walks the entire chain against PRODUCTION. No receipt anywhere shows it was ever run.

---

## C. OPERATIONS (`api/src/{maintenance,technician,comms,obligations}/`) — VERIFY@MAIN

**Scope correction:** the obligation engine is NOT in `src/obligations/` — it is
`src/shared/obligation_engine.js`. `src/obligations/` is only the authenticated HTTP door.

| Capability | Proof rung | Note |
|---|---|---|
| **Release 0 completion guard** | **PRODUCTION_PROVEN** | `activation_id d93b08dd-c682-46d2-acf9-78ab6b960827`, `2026-08-12T01:49:57.866Z`, **16/16 on live instance kbtb6, exit 0**, irreversible. **Found independently by two researchers.** DB-trigger level |
| Work order creation / lifecycle | HTTP_PROVEN | `work_order_operator_seams.db.js` — *"the REAL server.js over real HTTP. Nothing is stubbed"*, 42 |
| Technician SMS operations loop | HTTP_PROVEN + BROWSER_VERIFIED | `technician_route_proof.db.js` 46, `technician_lifecycle_proof.db.js` 51; `app/work_lifecycle_browser_proof.browser.js` 144 + 5 screenshots |
| Operator work-order actions | HTTP_PROVEN | 4 canonical writes; "Review" deliberately excluded — *"a read that writes is the thing this file exists to prevent"* |
| Obligations door (read + self-claim) | HTTP_PROVEN + BROWSER_VERIFIED | `operator_obligations_security_proof.db.js` 20; two real browser proofs |
| Turnover / move-out | HTTP_PROVEN | `turnover_service_proof.js` + `operator_turnover_bridge.test.js` |
| Unit triage · turn scope · work acceptance · readiness | real-DB service layer, **no HTTP harness** | 96 / 113 / 84 / 104 assertions respectively |
| Communications boundary | HTTP_PROVEN (line layer) | **SMS RAIL FROZEN**: *"there is no `operations` line row at all, and `provider_config` is null on the only line that exists"* |
| Move-in delivery correlation | **LOCALLY_EXERCISED** | `movein_runtime_behavior.test.js` uses a **hand-mocked `client.query`** |
| Prospect fact capture | LOCALLY_EXERCISED | no dedicated proof for the extraction pipeline |
| Not-done / stall routing | not located | *"landed while the guard was dormant, so they have never felt it"* |

**OPEN, verbatim:** *"a canonical completion through `claimCompletion`, with real proof, end
to end — needs a real technician SMS completion."* The guard is proven; the writer producing
a valid completion through it is not.

**§7 VIOLATION:** Ask Spine reads obligations through `src/agent/ask_spine_service.js`, a
**third independent reimplementation** — its own header: *"Its QUERY LOGIC is sound and is
re-expressed here."* Two canonical readers for one truth.

---

## D. PLATFORM / CORE (`api/src/{money,entity,identity,evidence,conversation,agent,release0,surfaces}/`) — VERIFY@MAIN

| Capability | Proof rung | Note |
|---|---|---|
| Legal entity primitive | HTTP_PROVEN + BROWSER_VERIFIED | 28 assertions; real form fill in `asset_management_shell.browser.js` |
| Staff session / server-derived authority | HTTP_PROVEN | *"The caller never supplies role, modules, TTL, or entitlement"* |
| Property creation | HTTP_PROVEN + BROWSER_VERIFIED | *"Nothing is intercepted and nothing is stubbed"*; single-path enforced by gate |
| Ask Spine (slices 1–2) | HTTP_PROVEN + claimed **browser-verified in production** | ⚠ same section: *"`references[]` IS NOT IN PRODUCTION. It is written, tested and pushed, and `origin/main` does not contain it"* |
| Asset Management shell | HTTP_PROVEN + BROWSER_VERIFIED | `asset_management_shell.browser.js` 260/260. Property Expenses **capped** — *"can NEVER read `established`"* |
| Money events / accounting engine | HTTP_PROVEN | lifecycle-arc harnesses only; no per-module `.db.js` |
| Slice 9 market evidence | HTTP_PROVEN + BROWSER_VERIFIED | *"ZERO live evidence requests without a session"* |
| Governed pricing & charges (~26 files) | mixed | *"Everything else economic is **unpublished**"* (dated, flagged 33-commits-stale). `$99 administration fee` **BLOCKED on one ruling** |
| `concession_schedule_compiler` | **BUILT_BUT_DORMANT** | *"ACTIVATES NOTHING"*; `free_rent_period` *"SPECIFIED BUT NOT IMPLEMENTED"* |
| `economic_adapter` · `pricing_adapter` | **BUILT_BUT_DORMANT** | *"DARK BY CONSTRUCTION. Nothing calls this yet"* |
| **`src/identity/activation.js`** | **DEAD CODE — user-visible** | *"the whole activation flow, **never mounted**… with an app screen calling routes that 404."* Confirmed: no `require` in `server.js` |
| `identity_reconciliation` · `identity_graph_audit` | BUILT_BUT_DORMANT | read-only audit tools, no caller found |
| Conversational seams (5 pure files) | LOCALLY_EXERCISED | pure by design; HTTP coverage inherited, not direct |
| A2P legal pages | HTTP_PROVEN | header records a real production incident: *"BOTH campaign-required URLs returned 404 in production"* |

---

## E. THE SIX NEW DOMAINS (main only) — workflow in flight

Meeting Evidence (175/176/181) · Person ingress (177) · Forward Leasing (178) ·
Inventory retirement + rent-roll grain (179/180) · Tenancy Ask Spine · Release rail rework.

Candidate second production observation: app commit `72c7a8e` *"Release packet: production
accepted the corrected reader"* + `docs/RENT_ROLL_CORRECTION_RELEASE_PACKET.md`.

---

## F. RELEASE STATE — the fact with the shortest fuse

```text
Production DB ledger ceiling   174   (owner-reported, observed on Neon)
Migrations present on main     181
Unreleased                     175, 176, 177, 178, 179, 180, 181   ← SEVEN
```

`prestart` runs `migrate.js` in **verify-only** mode: any migration not in the ledger and the
service **refuses to start**. Render keeps the old instance live, so the API looks fine while
the new schema is simply absent.

---

## G. CROSS-CUTTING DEFECTS THE LEDGER SURFACES BY EXISTING

1. **The §40.11 gate scans two folders of ~15.** ✔VERIFIED@MAIN `77f93f5`:
   `STANDING_READ_DIRS = ["src/asset", "src/tenancy"]` (`gate_ask_spine_readers.js:100`).
   *(Correction to the stale-tree finding, which said `["src/asset"]` only — Tenancy was
   added.)* Still structurally undiscoverable: `src/leasing`, `src/applications`,
   `src/maintenance`, `src/technician`, `src/comms`, `src/obligations`, `src/money`,
   `src/onboarding`, `src/evidence`. *"A gate that scans less than it asserts is worse than
   no gate, because it launders the gap into evidence."*
2. **Ask Spine has two obligation readers.** §7 violation, self-documented.
3. **A live screen calls routes that 404** (`identity/activation.js`). ✔VERIFIED@MAIN —
   `grep -c "identity/activation" server.js` returns **0** at `77f93f5`. Still dead.

### ✔ VERIFIED AT CURRENT MAIN (`77f93f5`) — these four are not stale

| Claim | Verified fact |
|---|---|
| Ask Spine gathered domains | `attention, work_orders, compliance, utility, contracted_service, equity, tenancy, debt` — **insurance and tax absent**, confirming both `pending` with no gather branch |
| `identity/activation.js` dead | 0 references in `server.js` |
| `full_lifecycle_arc.js` points at production | `const API = (process.env.ARC_BASE \|\| "https://property-spine-api.onrender.com")` — line 47 |
| Executed-lease intake off | `process.env.EXECUTED_LEASE_INTAKE_ENABLED === "true"` + property allowlist — `executed_lease_service.js:52-53` |
| No e-signature | `applications.js:5` *"does NOT capture a legally-binding signature"*; `leasepackets.js:30` *"audit evidence, NOT a legally-binding signature on the final lease"* |
4. **`THREAD_HANDOFF.md` contradicts itself on tax release** — same section, both present tense.
5. **The best-proven domain (Compliance) has no handoff entry at all.**
6. **Three browser proofs run against a fake database** (Utilities, Contracted Services, + the
   `fakePool()` pattern) — browser-verified in name, not against real truth.
7. **A production-pointing test script exists with no run receipt** (`full_lifecycle_arc.js`).
