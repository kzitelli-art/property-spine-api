# RESUME HERE — building `docs/CURRENT_STATE.md`

> ## ▶ TO RESTART, PASTE THIS
> ```
> Read docs/current-state-build/00_RESUME_HERE.md on branch
> claude/philosophy-doctrine-essence-ae6xni and continue that work.
> ```
> That is the whole restart. Everything needed is in this folder. Do not ask the
> owner to re-explain the plan — it is written down below and was agreed already.
>
> **First three moves, in order:** (1) re-fetch both repos and re-stamp the SHAs in
> "State stamp" below, assuming drift; (2) re-run `wave1_new_domains.js` and
> `wave2_coverage_gaps.js` against fresh worktrees at current main; (3) bring the
> owner the consolidated row set and settle taxonomy **with them**, before writing
> anything.
>
> ### ⚠ TOKEN BUDGET — the owner watches this
> The two research waves are the expensive part (wave 2 alone spawns ten agents).
> **Run ONE wave, report, then ask before running the second.** Do not launch both
> at once. If the owner says they are near a limit, stop all background tasks
> immediately (`TaskStop`) rather than only saving files — a paused conversation
> does not pause a running workflow.


**Paused 2026-08-19 mid-inventory. Nothing has been written to the product yet.**
This folder is working material for ONE deliverable: a `docs/CURRENT_STATE.md` that
answers *"what is true now?"* so a new thread stops having to reconstruct it.

Read in order: `01_DESIGN_SPEC.md` (the locked rules) → `02_INVENTORY_DRAFT.md`
(evidence gathered so far) → this file's "next actions".

---

## WHY THIS EXISTS

Threads kept losing track of what was built. The root cause, diagnosed and agreed:
**a historical narrative was being asked to answer a current-state question.**

`docs/THREAD_HANDOFF.md`, measured 2026-08-19: **3,992 lines · 50 banner sections ·
34 instances of supersession language** ("SUPERSEDES", "THIS SECTION WINS", "THAT
SENTENCE IS NOW FALSE"). Banners claim *partial* authority, so answering "is X live?"
means running a precedence algorithm across 50 dated banners. Its top banner says
**"EQUITY IS LIVE"**; Equity is merged and NOT production-verified. Debt's banner 200
lines below states the honest standard. One file, two meanings of "live."

**Resolution order once `CURRENT_STATE.md` exists:**
```
CURRENT SOURCE / RUNTIME → CURRENT_STATE.md → PHILOSOPHY (meaning) → THREAD_HANDOFF (history)
```

---

## STATE STAMP AT PAUSE

```text
API origin/main   77f93f5   2026-08-18
APP origin/main   c6769ba   2026-08-18
Working branch    claude/philosophy-doctrine-essence-ae6xni
Production DB     ledger ceiling 176 (deployed sha e5497a4 — corrected by wave 1)
Migrations on main    181  →  FIVE UNRELEASED: 177,178,179,180,181
```
⚠ Corrected by `03_WAVE1_RESULTS.md`: 175/176 (Meeting Evidence, Meeting Receipt)
ARE released. The "seven unreleased" figure originally in this file was itself
wrong — re-verify before quoting either number again.

⚠ **Both repos moved during the paused session.** API gained 124 files / 32,208
insertions after this thread's first look. Re-fetch and re-stamp before trusting any
row. Four of five inventory passes read a tree **70 commits behind main** — rows from
those passes are marked `VERIFY@MAIN` in `02_INVENTORY_DRAFT.md`.

---

## WHAT IS DONE

- Three rules locked with the owner (see `01_DESIGN_SPEC.md`): present-tense only;
  every row carries its own evidence + freshness; THREAD_HANDOFF becomes history,
  not authority.
- Row schema locked. Staleness-trigger design locked, using the **checkable-invariant**
  pattern found in app commit `db501a1` (*"Naming a SHA here is self-defeating…"*) —
  state the SHA **and** the command that proves whether anything non-doc landed since.
- Acceptance test locked: a new thread asks *"Is Equity live?"*, *"Can Leasing execute
  a lease?"*, *"Can Ask Spine read Utilities?"* and gets one answer with a proof rung
  and evidence, **without reading a historical banner**.
- Five inventory passes complete (~70 capabilities) — Asset Management, Leasing
  lifecycle, Operations, Platform/core, plus spot-verification at current main.

## WHAT WAS RUNNING WHEN PAUSED — RE-RUN THESE

Two background workflows were **in flight and their results were lost** to the pause.
Both scripts are saved here and are re-runnable as-is:

| Script | Covers |
|---|---|
| `wave1_new_domains.js` | Meeting Evidence · Person ingress · Forward Leasing · rent-roll grain / inventory retirement · Tenancy · release rail. Includes an adversarial pass that tries to **refute** each proof rung. |
| `wave2_coverage_gaps.js` | Teams/access/invites · Management door · onboarding & rent-roll intake · money/pricing at real grain · the whole app repo · `server.js` inline routes · `tools/` — plus three completeness critics (unlisted files · tables with no owning capability · cron/webhooks/integrations/env flags). |

**Both hardcode worktree paths that no longer exist.** Recreate first:
```bash
git worktree add <scratch>/main-api origin/main     # in property-spine-api
git worktree add <scratch>/main-app origin/main     # in property-spine-app
```
then update the `API` / `APP` constants at the top of each script and re-invoke.

---

## NEXT ACTIONS, IN ORDER

1. **Re-fetch both repos, re-stamp** the SHAs above. Assume drift.
2. **Re-run `wave1` and `wave2`** against fresh worktrees at current main.
3. **Re-verify every `VERIFY@MAIN` row** in `02_INVENTORY_DRAFT.md`.
4. **Show the owner the consolidated row set** and settle taxonomy — *taxonomy is
   settled AFTER the evidence is in, never during.* The owner's standing instruction:
   > *"Do not improve the taxonomy while inventorying the product. First describe what
   > exists at the grain the evidence supports. Premature normalization is another way
   > intent sneaks into current-state reporting."*
   Known open shape question: evidence grain yields ~90 rows; the acceptance test wants
   something scannable. Likely two tiers (index + detail). **Do not decide alone.**
5. **Then, and only then**, write `docs/CURRENT_STATE.md`.
6. Land in the SAME change: re-scope `CLAUDE.md` (it currently calls THREAD_HANDOFF
   *"the current deployed state"* — that job moves, or the two drift apart) and add the
   header to THREAD_HANDOFF: *"Historical sections below may contain stale present-tense
   claims. Do not use them as current-state authority."*
7. **Write the gate.** A hand-maintained ledger decays — `docs/CODEBASE_STATE.md`
   (5 Aug, stamped `8330aec`) proves it. Enforce coverage mechanically.

---

## FINDINGS THAT MUST NOT BE LOST

Verified at current main `77f93f5` unless noted.

| Finding | Evidence |
|---|---|
| **Exactly ONE capability is production-proven** — the Release 0 completion guard. Found independently by two researchers. | `activation_id d93b08dd-c682-46d2-acf9-78ab6b960827`, `2026-08-12T01:49:57.866Z`, 16/16 on live instance `kbtb6`, irreversible |
| **There is no e-signature capability.** | `applications.js:5` *"does NOT capture a legally-binding signature"*; `leasepackets.js:30` |
| **Executed-lease intake is switched OFF.** | `executed_lease_service.js:52-53` — env flag + property allowlist |
| **A live app screen calls routes that 404.** | `src/identity/activation.js` never mounted; `grep -c "identity/activation" server.js` = **0** |
| **A test defaults to hitting PRODUCTION**, with no run receipt anywhere. | `tests/full_lifecycle_arc.js:47` |
| **The §40.11 gate scans 2 of ~15 domain dirs.** | `STANDING_READ_DIRS = ["src/asset","src/tenancy"]` — leasing, applications, maintenance, technician, comms, obligations, money, onboarding invisible |
| **Utilities & Contracted Services are NOT end-to-end proven** despite being `registered`. | `utility_http.test.js` = real HTTP + **fake pool**; `utility_persistence.db.js` = real PG + **no router**. Browser proofs use `fakePool()` |
| **Insurance & Tax: no Ask Spine reader at all** (`pending`), and explicitly not production-verified. | *"Insurance rendering real truth — NEVER seen on a production page by an entitled account"* |
| **Ask Spine has TWO obligation readers** — a §7 violation. | `src/agent/ask_spine_service.js` — *"Its QUERY LOGIC is sound and is re-expressed here"* |
| **THREAD_HANDOFF contradicts itself on tax release**, same section, both present tense. | *"APPLIED… ceiling 167"* vs *"release 162–167 nothing is in production"* |
| **Compliance — the best-proven Asset Mgmt domain — has NO handoff entry at all.** | grep of THREAD_HANDOFF returns only incidental mentions |
| **Nearly all of Leasing tops out at LOCALLY_EXERCISED.** Deal Setup is the exception and the model to copy. | `deal_setup_http.db.js` spawns real `server.js`, real socket, 20 checks incl. restart persistence |
| **Notice to vacate: zero rows.** | *"built and never used… Live count across the whole database: 0"* |
| Dormant, self-declared | `tour_chips`, `capture_chase`, `capture_receipt`, `followup_ladder`, `concession_schedule_compiler` (*"ACTIVATES NOTHING"*), `economic_adapter`/`pricing_adapter` (*"DARK BY CONSTRUCTION"*), `lease_void` (no route) |
| Ask Spine gathers, at main | `attention, work_orders, compliance, utility, contracted_service, equity, tenancy, debt` — insurance and tax absent |

### Proof-rung distribution (~70 capabilities, pre-wave-1/2)
```text
PRODUCTION_PROVEN     1     BROWSER_VERIFIED  ~8  (3 behind a fake DB)
HTTP_PROVEN          ~15    LOCALLY_EXERCISED ~30
BUILT_BUT_DORMANT    ~10    DEAD / REPORTED    ~3
```

---

## STANDING CONSTRAINTS

- **No product code changes.** Equity is frozen by owner instruction; this work is
  documentation only.
- **No taxonomy improvement during inventory.** Evidence grain first.
- **Never upgrade a row because someone believes the product works that way.** Only an
  observed proof rung upgrades a row.
- **`NOT_FOUND` over a plausible guess**, always.
