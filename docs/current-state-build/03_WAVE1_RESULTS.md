# WAVE 1 RESULTS — the six domains that landed mid-session

Ran via `wave1_new_domains.js` against fresh worktrees at `api 77f93f5` / `app c6769ba`.
**44 capabilities found, each independently adversarially verified** (a second agent
tried to REFUTE the claim, defaulting to refuted when uncertain). **40 of 44 had a
claim refuted** — mostly downgraded one rung, not thrown out. Full raw JSON (5.4M
tokens of research) lived at
`/tmp/claude-0/-home-user/35ef8d61-d4f6-594f-9fd5-4adbc648960d/tasks/wgcjkpeyj.output`
— **that path is ephemeral and is gone on container reset.** This file is what
survives. Re-run the script if the raw detail is needed again (cache will replay
unchanged calls).

## ⚠ CORRECTION TO 00_RESUME_HERE.md's stated migration gap

`00_RESUME_HERE.md` says *"SEVEN UNRELEASED: 175,176,177,178,179,180,181."* That is
now wrong. `docs/THREAD_HANDOFF.md:122` (verified, current tree): **`PRODUCTION
deployed sha e5497a4 · ledger ceiling 176`** — verified `git merge-base
--is-ancestor 2de23cd e5497a4` = YES. **175 and 176 ARE released and deployed.**
**Five remain unreleased: 177, 178, 179, 180, 181.** Update any downstream claim
built on the "seven" number.

## THE FOUR FINDINGS THAT MATTER MOST

### 1. A second production-proven capability — the release gate itself
Claimed `DEPLOYED`. Verifier upgraded it to **`PRODUCTION_PROVEN`**. `migrate.js`
runs on every Render boot via `prestart`; the deployed sha (`e5497a4`) already
carries `EXPECTED_SHA` enforcement and refuses to start on schema mismatch — this
is live, working, gatekeeping machinery, not a promise.

**But:** *"the shipped documentation still contradicts the shipped executable."*
`docs/deployment.md:51` says *"prestart: node migrations/migrate.js (runs any
unapplied migrations)"* — **that is false.** It verifies and refuses; it does not
apply. This is the exact trap `CLAUDE.md` names as having *"cost time twice"* —
except now it's not tribal memory, it's a doc actively asserting the wrong
behavior. **Fix the doc.**

### 2. The one claimed PRODUCTION_PROVEN fact does not survive verification
"Current Rent Roll — four-bucket classification" was staged as *"THE ONLY
PRODUCTION OBSERVATION FOUND IN EITHER REPO"* — a Render-shell recompute recorded
in `RENT_ROLL_CORRECTION_RELEASE_PACKET.md`. Verifier killed it, three ways:
- The claim is **single-source**: the script that produced the number is
  committed nowhere; the "corroborating" commit changes only that same markdown
  file, same author, same moment.
- The API's **own current banner contradicts the numbers**: *"MIGRATION 180 IS
  WRITTEN AND NOT RELEASED"* and *"EVERY CANONICAL TENANCY READ OF IT RETURNS 391
  POSITIONS AGAINST 160 REAL BEDS."*
- The packet's own §4 proof table says it plainly: *"Deployed runtime · HTTP ·
  session · browser | **NOT PROVEN**"* and *"Status: RELEASE READY. Held at the
  production deployment boundary for approval… Nothing deployed."*

Downgraded to `LOCALLY_EXERCISED`. **The document was staged as proof of
something it explicitly says, in its own text, has not happened yet.**

### 3. "Pending tenancy" does not exist as a concept in the code
Claimed `BROWSER_VERIFIED` ("creation of an activation_pending lease from a
confirmed rent-roll row"). Verifier: **`NOT_FOUND`.**
- The phrase *"pending tenancy"* appears **nowhere in either repo.**
- `activation_service.js:696-703` — the only lease INSERT on the confirm path —
  **hard-codes `lease_status = 'active'`** in the literal VALUES list. Three
  independent pieces of evidence confirm it, including the deployed sha's copy of
  the same file.
- `position_classifier.js` then classifies that lease as **current**, not
  pending, because `'active'` is in `CURRENT_ECONOMIC_STATUSES`.

**Confirming a rent-roll row does not create a pending state. It creates an
active one, directly.** This directly contradicts what earlier design discussion
assumed. Load-bearing for `CURRENT_STATE.md` — this needs its own explicit row,
worded exactly this way, not folded into a generic "tenancy" line.

### 4. Active/current resident tenancy is real, and it's the one clean win here
Claimed `DEPLOYED`. Verifier: **confirmed, `DEPLOYED`**, evidence upgraded rather
than weakened. `POST /operator/leasing/leases/:leaseId/activate-tenancy` — real
route, real transaction, re-scopes the lease to the operator's property `FOR
UPDATE`, refuses with 400 absent `activated_by_user_id`, confirmed present at the
deployed sha byte-for-byte (`git diff --stat e5497a4 HEAD` on the two files =
empty). Not behind any dormancy gate. **This is the pending→active transition
working, for real, in deployed code** — it's the *creation* of the pending state
(finding #3) that's missing, not the transition off of it.

## FULL TABLE — claimed rung vs. what survived adversarial verification

| Cluster | Capability | Claimed | Verified | Prod |
|---|---|---|---|---|
| meeting_evidence | Meeting Evidence (provider ingress) | DEPLOYED | BUILT_BUT_DORMANT | no |
| meeting_evidence | Meeting Receipt v0 pipeline | DEPLOYED | BUILT_BUT_DORMANT | no |
| meeting_evidence | Binding finality / non-forking / extraction | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| person_ingress | Person ingress boundary (resolve/propose/refuse) | HTTP_PROVEN | LOCALLY_EXERCISED | no |
| person_ingress | Person-creation authority containment | LOCALLY_EXERCISED | LOCALLY_EXERCISED | no |
| person_ingress | resolution_kind | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| person_ingress | Person correction (anti-merge supersession) | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| person_ingress | External resident identity (crosswalk) | REPORTED | REPORTED | no |
| person_ingress | Resident-ID evidence study | REPORTED | REPORTED | no |
| person_ingress | Person-spine import audit | HTTP_PROVEN | BUILT_BUT_DORMANT | no |
| forward_leasing | Forward Leasing Ledger | BROWSER_VERIFIED | BROWSER_VERIFIED | no |
| forward_leasing | Interval tenancy read | BROWSER_VERIFIED | BROWSER_VERIFIED | no |
| forward_leasing | Named leasing cycle configuration | BROWSER_VERIFIED | BROWSER_VERIFIED | no |
| forward_leasing | Forward Rent | BROWSER_VERIFIED | BROWSER_VERIFIED | no |
| forward_leasing | Leasing tracker intake | BROWSER_VERIFIED | BUILT_BUT_DORMANT | no |
| forward_leasing | Leasing basis discovery | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| forward_leasing | Ask Spine reader (forward leasing) | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| forward_leasing | Leasing pace vs. prior cycle | NOT_FOUND | NOT_FOUND | no |
| rent_roll_grain | Current Rent Roll (operator unit-first) | BROWSER_VERIFIED | HTTP_PROVEN | no |
| rent_roll_grain | Current Rent Roll (four-bucket) | **PRODUCTION_PROVEN** | **LOCALLY_EXERCISED** | unknown |
| rent_roll_grain | Current Rent Roll (canonical read + CSV) | HTTP_PROVEN | LOCALLY_EXERCISED | no |
| rent_roll_grain | Future Rent Roll | HTTP_PROVEN | HTTP_PROVEN | no |
| rent_roll_grain | Forward Leasing ledger (Slice 2) | BROWSER_VERIFIED | BROWSER_VERIFIED | no |
| rent_roll_grain | Leasing tracker intake (as governed claim) | BROWSER_VERIFIED | HTTP_PROVEN | no |
| rent_roll_grain | Inventory grain materialization | BROWSER_VERIFIED | BUILT_BUT_DORMANT | no |
| rent_roll_grain | Inventory retirement | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| rent_roll_grain | Surplus placeholder repair | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| rent_roll_grain | Rent-roll refresh grain reconciliation | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| rent_roll_grain | Bed-grain activation | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| rent_roll_grain | Tenancy standing projection (Ask Spine) | HTTP_PROVEN | HTTP_PROVEN | no |
| tenancy | Tenancy standing projection (Ask Spine reader) | HTTP_PROVEN | LOCALLY_EXERCISED | no |
| tenancy | Dated rentable position / four-bucket | BROWSER_VERIFIED | LOCALLY_EXERCISED | no |
| tenancy | **Pending tenancy (activation_pending creation)** | BROWSER_VERIFIED | **NOT_FOUND** | no |
| tenancy | **Active / current resident tenancy** | DEPLOYED | **DEPLOYED** | no |
| tenancy | One-space-one-tenancy wall | LOCALLY_EXERCISED | LOCALLY_EXERCISED | no |
| tenancy | Term / interval standing projection | BUILT_BUT_DORMANT | BUILT_BUT_DORMANT | no |
| tenancy | Resident identity (source/PMS → Person) | NOT_FOUND | LOCALLY_EXERCISED | no |
| tenancy | Inventory retirement (superseded bed-as-unit) | LOCALLY_EXERCISED | LOCALLY_EXERCISED | no |
| release_rail | **Migration release gate** | DEPLOYED | **PRODUCTION_PROVEN** | **yes** |
| release_rail | EXPECTED_SHA build-identity pin | LOCALLY_EXERCISED | LOCALLY_EXERCISED | no |
| release_rail | Pre-release ledger read | REPORTED | REPORTED | no |
| release_rail | Render deploy trigger (deploy.sh) | DEPLOYED | BUILT_BUT_DORMANT | no |
| release_rail | Production ledger ceiling of record | REPORTED | REPORTED | no |
| release_rail | From-scratch database rebuild | REPORTED | REPORTED | no |

## PATTERN ACROSS ALL 44

Forward Leasing's browser proofs (4 of them) survived verification untouched —
that cluster is genuinely as solid as claimed. Everything else skews one notch
down, mostly `BROWSER_VERIFIED`/`HTTP_PROVEN` claims that turn out to be
`BUILT_BUT_DORMANT` or `LOCALLY_EXERCISED` on closer reading. **Zero of the 44 are
production-observed** except the two called out above (rent roll's claim did not
survive; release gate's did).
