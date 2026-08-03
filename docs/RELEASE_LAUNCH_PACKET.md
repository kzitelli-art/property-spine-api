# RELEASE LAUNCH PACKET — obligation authority boundary

**One page. The operator should need nothing else — not Git history, not a chat
thread.** Print it or keep it open beside the dashboards.

## What is shipping and why the order matters

Five obligation routes were protected by a **portfolio-wide shared operator key
held in browser `localStorage`**, with **no server-derived property, module or
actor authority**. They are retired and replaced by two authenticated doors.

**The app must merge FIRST.** The deployed app sends only `x-operator-key` on
obligation calls — verified: `x-staff-session` appears on **0** obligation lines
in the app's `main`. So there is no secured bridge, and one side must move
first. API-first would make the old app's swallowed 404 render obligation
queues as **confidently empty**. App-first renders an **honest unavailable**.
That is the whole reason for the order.

## Links and frozen SHAs

| | |
|---|---|
| App PR | **#26** — `https://github.com/kzitelli-art/property-spine-app/pull/26` |
| App SHA | **`b35ed66`** (PR base `30e550b` = deployed) |
| API PR | **#32** — `https://github.com/kzitelli-art/property-spine-api/pull/32` |
| API SHA | **`f6ab9f6`** (PR base `f85f70b` = deployed) |
| Merge order | **app #26 → then API #32, immediately** |
| Full record | `docs/SECURITY_OBLIGATIONS_ROUTE.md` (API repo) |

## Roles — every role needs a name; one person may hold several

```text
Presses merge on app PR #26 ....................... Kameron Zitelli
Confirms the new app SHA is live .................. Kameron Zitelli
Presses merge on API PR #32 ....................... Kameron Zitelli
Watches the Render API build ...................... Kameron Zitelli
Runs the deployed smoke ........................... Kameron Zitelli
Runs the browser acceptance ....................... Kameron Zitelli
Authority to call rollback ........................ Kameron Zitelli
Records the final receipt ......................... Kameron Zitelli
FINAL GO/NO-GO CALL ............................... Kameron Zitelli
```

## Production facts — OWNER-VERIFIED 2026-08-02. Do not re-ask for any of these.

```text
Operator, and final GO/NO-GO ...... Kameron Zitelli

API                                        APP
service ...... property-spine-api          service ...... property-spine-app
type ......... Web Service                 type ......... Static Site
branch ....... main                        branch ....... main
auto-deploy .. On Commit                   auto-deploy .. On Commit
deployed SHA . f85f70b                     deployed SHA . 30e550b
deploy running No                          deploy running No
rollback ..... Available                   rollback ..... Available
/health ...... Green                       health ....... n/a (static site)
database ..... Responding
```

`/health` at 15:01:32Z returned `{"ok":true,"db_time":"2026-08-02T15:01:32.006Z"}`.

**Production is running exactly `main` on both services** — `f85f70b` is the API
PR's base, `30e550b` is the app PR's base. There is no gap between what is
deployed and what these PRs merge into. That is the cleanest possible
precondition, and it is verified, not assumed.

## Timing — X is an OWNER-APPROVED CONSERVATIVE VALUE, not a measurement

Render displayed the last API deploy starting and going live within the same
minute. Seconds were not available, so **X was not measured**. Kameron approved
a conservative operating value:

```text
X ............................ 5 minutes   ← owner-approved conservative
Escalation point ............. app-merge + 10 min   → start diagnosing
ROLLBACK DECISION POINT ...... app-merge + 15 min   → roll the app back
```

**Write the two absolute clock times down before merging the app.** "Still
building" is not permission to pass the decision point.

Two traps: the app's `__PS_BUILD.code_sha` is **one commit behind by
construction** — the deployed head is its *stamp child*. And the Render Shell
has **no `.git`**; use `echo $RENDER_GIT_COMMIT`, not `git rev-parse`.

## Health

```text
GET https://property-spine-api.onrender.com/health   → { ok, db_time }
```

**`/health/migrations` DOES NOT EXIST.** `docs/deployment.md:137–142` documents
it, but `server.js` defines only `GET /health` at `:246`; a repo-wide search
finds the path in documentation and nowhere else. Do not send anyone to curl it.

Read migration state instead in the **Neon SQL editor** — read-only, no
credential leaves the browser, nothing deployed, no environment change:

```sql
select version from schema_migrations order by version;
```

Compare with the candidate's own files:

```bash
ls migrations/*.sql | sed -E 's#.*/([0-9]+).*#\1#' | sort
```

Anything in the repository and absent from that list **runs during `prestart`
on the next deploy**. That comparison is the preflight answer.

**Migration 121 is already half-resolved from source:** there is no
`121_*.sql` in `migrations/`, on this candidate or on `main` — the sequence
runs 120 → 122. `migrate.js` iterates files that exist, so **nothing named 121
can execute during this deploy.** What remains is only whether production's
ledger carries a stale `121` row; the query above settles it.

Never paste an operator key into a chat, a screenshot, or a shared channel.

## Smoke — Step 6. Execution path OWNER-VERIFIED in the Render Web Shell

```text
Service ............ property-spine-api
Shell available .... Yes
Running commit ..... f85f70bafea172c1cd3d7ca09179f25df4b58177
DATABASE_URL ....... present        OPERATOR_KEY ....... present
Secrets printed .... No
```

Run from the directory the shell opens in — currently `~/project/src`.
**Do not `cd /app`.** That path tells us something useful: Render is running a
**native Node environment, not the `Dockerfile`** (Docker would place the app at
`/app`). Either way the checkout carries `tests/`, so the harness is present in
the deployed artifact.

```bash
node tests/smoke_release3.deployed.js
echo $?
```

No environment variable needs setting. The harness reads `DATABASE_URL` and
`OPERATOR_KEY` from the service, and `API_BASE` defaults to the production URL —
leave it unset so the run exercises real routing. Nothing is typed or echoed;
secrets never leave Render.

### ⚠ This run WRITES to production — authorize it deliberately

It builds an isolated world and, per the append-only teardown doctrine,
**permanently retains** a property named
`R3 SMOKE <timestamp> — QA (not an operating property)` plus its people,
conversion, tasks and event history. Only staff sessions and team-access rows
are removed. That is the ledger doctrine working, stated in the run's own
receipt — **but it is a permanent production write and needs Kameron's explicit
authorization before Step 6, not after.**

### Required evidence

```text
BOUNDARY: 10/10 behaviours executed + 1 execution-floor assertion
B1 through B10 all printed
0 failed
exit code 0
```

Boundary rung — **10 named behaviours + 1 execution-floor assertion**:

```text
B1   GET   /obligations                          → 404
B2   GET   /obligations/:id                      → 404
B3   PATCH /obligations/:id/claim                → 404
B4   PATCH /obligations/:id/satisfy              → 404
B5   PATCH /obligations/:id/complete             → 404
B6   GET   /operator/obligations   (session)     → 200 with items[]
B7   …the response echoes SERVER-DERIVED scope
B8   GET   /operator/obligations?property_id=…   → 403  (client scope refused)
B9   POST  /operator/obligations/<other>/claim   → 404  (concealed, not 403)
B10  GET   /operator/obligations   (key only)    → 401
FLOOR  all 10 executed — evaluated in `finally`, so it fires even if the
       rung was never reached
```

**Read the BOUNDARY line, not the aggregate.** The run prints:

```text
═══ BOUNDARY: 10/10 behaviours executed + 1 execution-floor assertion ═══
═══ RESULT: N passed · 0 failed ═══
```

**`BOUNDARY: 10/10` is the evidence.** A green aggregate alone is not — this
rung already produced one false green by being defined, exported and never
invoked, and a pass count cannot detect an absent check. Four fail-closed
properties are proven, not assumed: deleting the invocation → `0/10` and exit 1;
a missing staff session → B6–B9 FAIL, never skip; a wrong `OPERATOR_KEY` → B1
FAILs and says why; the rung runs in `finally`, so an unrelated crash upstream
cannot suppress it.

## Browser acceptance — the product, not just status codes

In the **real deployed app**, signed in as a real staff user:

1. the collection renders — the person sees **only the work they are
   responsible for**;
2. self-claim succeeds, and the queue changes **immediately and coherently**;
3. the claimed item leaves the open queue **because `open → in_progress` and the
   queue filters `status=open`** — assert the reason, not the disappearance;
4. the unfiltered view shows the **session user** as owner — the browser chose
   neither the property nor the actor;
5. unavailable stays **visibly different from empty**;
6. preview and demo stay local — no request escapes to the API;
7. DevTools → Network, filter `obligations`: every request carries
   **`x-staff-session`** and **no `x-operator-key`**.

Record **present/absent only** — never a header value. Screenshots and the
network capture go to `docs/obligation-security/`.

The test: the surface should feel **simpler** afterwards, not merely safer. No
operator should have to understand any of the machinery above.

## HARD GO — all ten, no judgement language

```text
[ ] both branches still 0 behind their main
[ ] both PRs mergeable
[ ] no deploy already running on either service
[ ] expected deployed SHAs recorded
[ ] /health green
[ ] deployed migration ledger read and compared
[x] migration 121 explicitly classified — CLEARED (below)
[ ] rollback path verified — not assumed
[ ] named operator present for every role
[ ] smoke and browser tools staged
```

## HARD STOP — any one, stop immediately

```text
migration state ambiguous
a different commit is already deploying
configured branch differs from expectation
rollback cannot be established
health degraded before the window
main moved and proofs were not rerun
the operator cannot verify the deployed SHA
```

**"Probably fine" is not a state.** Migration 121 resolves to exactly one of:
`already recorded and healthy` · `pending and understood` (named, read,
accepted) · `STOP`.

## The mismatch window has a hard ceiling

App-first means obligations read **unavailable** until the API is healthy. That
is honest, but it is not open-ended.

```text
X = 5 min  (owner-approved conservative — Render showed minute precision only)
Escalation point ......... app-merge + 10 min
ROLLBACK DECISION POINT .. app-merge + 15 min   fixed clock time: __________
```

Write the clock time down **before** merging the app. If the API is not healthy
at that time, **roll back the app** and restore the prior stable state. "Still
progressing" is not a reason to wait past it.

**X is approved, not measured.** Label it that way wherever it is repeated.

## Rollback

| Situation | Action |
|---|---|
| App merged, API deploy not started | Revert the app PR. Old API untouched. Clean exit. |
| API build fails before healthy | Roll back the API → verify the **old** API healthy → revert the app. **Never leave the new app permanently unavailable.** |
| API healthy, acceptance fails | Identify the defective artifact first. **App defect** → revert the app; the secured API may safely remain. **API defect** → roll back the API, then revert the app. |

**Never restore an unsecured compatibility route as an emergency patch.** That
reintroduces the defect at the moment attention is lowest.

Every API deploy runs migrations; a code rollback does **not** un-apply schema.
This lane adds no migration, so rollback inside this window is schema-neutral —
that guarantee does not extend to anything else riding along.

## Fifteen-minute tabletop, before touching production

Answer out loud, with names:

```text
App merged            → how do we prove the EXACT artifact is live?
API merged            → where exactly do we watch migration output?
Health fails          → who rolls back what, in what order?
Smoke fails, health OK→ how do we tell an app defect from an API defect?
121 is pending        → what evidence makes it "understood" rather than STOP?
```

## Pre-stage — the window is for execution, not preparation

```text
[ ] both PRs open in tabs          [ ] two-property proof data identified
[ ] both Render dashboards open    [ ] screenshots directory ready
[ ] health URLs ready              [ ] Network filter set to `obligations`
[ ] smoke command copied           [ ] rollback actions written down
[ ] test staff session available   [ ] maintenance / success / failure messages drafted
```

## Three drafted messages

**Maintenance —**
> Obligation work views and the claim action may be briefly unavailable while a
> security fix deploys. If a queue shows "unavailable," that is correct and
> intentional — it is not showing you an empty list you could mistake for
> "nothing to do." Expected duration: ~___ minutes.

**Success —**
> Complete. Obligation work views are back. Behind the scenes, the app no longer
> decides which property's work you can see or whose identity you act as — the
> server does. Nothing about how you work changes.

**Rollback —**
> We rolled back the obligation security deploy at ___ and restored the previous
> stable version. Obligation views are working normally. No data was affected.
> The specific defect is recorded and the release will be rescheduled.

## Closing the release — deployed evidence only

```text
[ ] deployed smoke marked PROVEN (not Built)
[ ] merged SHAs + deployed SHAs recorded
[ ] deploy duration recorded
[ ] /health and /health/migrations results recorded
[ ] migration 121 outcome recorded
[ ] smoke result recorded
[ ] browser result + screenshots + network evidence attached
[ ] PRs #26 and #32 marked complete
[ ] SECURITY GATE DECLARED CLOSED
→ begin the Ask Spine rebase and proof rerun immediately
```

**No "deployed but still checking."** Either it passes and closes, or it rolls
back and returns with a specific named defect.


---

## MIGRATION 121 — CLEARED, LIVE SCHEMA DRIFT UNDERSTOOD

**Production ledger:** `121 ai_leasing_operating_context` · `122 governed_economics_lineage`.

The AI-leasing migration from commit `5d2b2ad` reached production while its file
stayed parked on `claude/getting-up-to-speed-nyf4ww` and never entered `main`.
**A branch was deployed to the production service and `prestart` migrated it.**
`THREAD_HANDOFF.md:49–52` claims that file "has never been applied to a
database" — **production disproves it**; line 95–96 was the accurate account.

### Verified in production, read-only

| Object | State |
|---|---|
| `ai_leasing_operating_rules` | exists · **0 rows** |
| `trg_ai_leasing_operating_rule_history` / `_lineage` | present, `enabled=O` |
| `agent_runs.ai_operating_context_snapshot_json` | `nullable=NO default='[]'::jsonb` |
| `agent_runs.ai_operating_context_hash` | `nullable=YES default=NONE` |
| `..._snapshot_array` / `..._hash_format` / `..._snapshot_json_not_null` | all `validated=true` |
| indexes | `pkey`, `id_property_id_key`, `idx_…_active`, `uq_ai_leasing_operating_rule_active` |

### Why this does not block the security release

1. **Bounded to one file.** `121_ai_leasing_operating_context.sql` is the only
   migration on that branch absent from `main`. Nothing else could have run.
2. **Zero release-source references.** No `.js` or `.sql` on the candidate or on
   `main` names any of these objects.
3. **The triggers cannot fire.** Both sit on `ai_leasing_operating_rules`, which
   no release code reads or writes.
4. **The constraints are satisfied by their own defaults.** `agent_runs` is
   written at `src/agent/agent.js:1036` and `:2272` with explicit column lists
   naming neither drifted column, so the `'[]'::jsonb` default satisfies the
   array check and a NULL hash satisfies the format check.
5. **0 rows.** Nothing has ever written to the drifted table — the schema is
   inert, not load-bearing. Had it been non-zero, AI-leasing *application* code
   would also have been deployed, and this would still be STOP.
6. **This lane adds no migration.** Nothing executes on deploy.

### Classification

```text
SAFE-BUT-AHEAD-OF-SOURCE — inert structure, no runtime dependency
Release impact: NONE. The obligation-security release may proceed.
Reconciliation: required, but as its own lane. NOT here.
```

**Not done, deliberately:** no ledger edit, no dropped object, no replacement
121, no AI-leasing merge to normalise the schema.

---

# WINDOW 1 — ABORTED AT THE FIRST GATE. What happened and what changed.

**2026-08-02, 2:00–3:00 PM ET. Operator: Kameron Zitelli.**

```text
T0 (app PR #26 merged) ......... 2:01:43 PM ET   app 9e25382 Deploy live 2:01 PM
Mismatch honesty check ......... FAILED ~2:06 PM
App rolled back ................ 30e550b live 2:05 PM
API PR #32 ..................... NEVER MERGED. Production stayed f85f70b, green.
Deployed smoke ................. NEVER RAN.
Production QA records .......... NONE created.
Repo state corrected ........... PR #27 merged → app main f662550,
                                 tree byte-identical to 30e550b
```

**Total exposure: four minutes, one surface, no writes.** The app-first ordering
did exactly the job it was chosen for — it put the defect in front of a human
before the API moved, when rollback was one button and cost nothing.

## What the gate caught

The check asks one question: does the new app tell the truth while the old API
lacks the route? The screen showed an honest `HTTP 404` banner **and**
"Nothing needs you right now." at the same time.

The loader migration was correct — `loadObligations` throws. **Two callers
caught the throw and substituted `[]`**, so the valid-empty branch rendered on a
*failed* read. The swallow moved from the loader into its consumers.

## The eight-consumer audit — one trust failure, three shapes

| Shape | Sites | Behaviour on a failed read |
|---|---|---|
| Fabricated empty | `renderMyWork`, `pvRenderMyWork` | `catch → obs=[]` → "Nothing needs you right now." |
| Silent no-op | `openManagementDoor` | `.then()` with no `.catch` → unhandled rejection, prior content left standing |
| Stale content | 5 desk renderers | threw to a toast; the toast fades, the half-rendered desk does not |

All eight now route through one treatment. `loadObligations` still **throws** —
the honesty stays in the loader. Legitimate empty (a successful zero-row read)
is untouched and has its own assertion.

## Two pre-existing defects found — neither introduced by this lane

1. **The false empty is older than the migration.** Both `catch(e){ obs=[] }`
   blocks are on `main` today. They were only ever harmless because the old
   `tryJSON(path, [], …)` never threw — it already returned `[]`. **Production
   has always rendered "Nothing needs you right now." on a failed obligations
   read.** The migration made the loader honest; the callers re-created the
   swallow one layer up.
2. **`renderMyWork` could never render a row.** It called `items.map(row)` while
   its row-builder is named `obRow`, so the moment My Work had anything to show
   it threw `ReferenceError: row is not defined` — swallowed by
   `try{ renderMyWork(); }catch(e){}`. On `main` today at `:10705`. The main My
   Work surface has only ever been able to show the empty line or nothing.
   Fixed: one word, one site. `pvRenderMyWork` defines `row` locally and was
   always fine.

## Proof after the repair

| Harness | Result |
|---|---|
| `obligations_failure_state_proof.browser.js` | **61 passed · 0 failed** — 8/8 surfaces + execution floor |
| `obligations_security_browser_proof.browser.js` | **25 passed · 0 failed** — floor 22 |
| App suite | **749 passed · 0 failed** — 17 harnesses, 0 red |

Every case: render real obligation content → force the read to fail → prove the
prior content is gone → prove a visible unavailable state → prove no
confident-empty wording. **The seeding step is the proof** — a clean page would
not show whether stale data survives.

## Candidates for window 2

```text
App PR #28  head 07b4880   base main f662550   (replaces #26)
API PR #32  head f6ab9f6   UNCHANGED
Proposed:   today 4:00–5:00 PM ET, app first, API immediately after
Escalation: actual T0 + 10 min      Rollback decision: actual T0 + 15 min
```

**X remains an owner-approved conservative 5 minutes.** Window 1 produced no
measurement — the API never deployed. The first real API deploy duration gets
recorded in window 2 and replaces the estimate.

---

# WINDOW 2 — DEPLOYED. Obligation security gate CLOSED.

**2026-08-02, 3:30 PM ET. Operator: Kameron Zitelli.**

```text
T0 (app PR #28 merged) ......... 3:30:49 PM ET
App deployed ................... 89a968c  Deploy live 3:31 PM
Mismatch honesty check ......... PASSED — "Work items are unavailable. HTTP 404
                                 This is not an empty queue — the work could not be read."
                                 "Nothing needs you right now." ABSENT.
API PR #32 merged .............. 3:33 PM
API deployed ................... 10c43b3  Deploy live 3:33 PM — SHA matches the merge commit
Mismatch window ................ ~2 minutes   (escalation 3:40 and rollback 3:45 never approached)
MEASURED API deploy duration ... <= 1 minute  (started 3:33, live 3:33; minute precision only)
                                 — replaces the owner-approved conservative X = 5 min
/health ........................ {"ok":true,"db_time":"2026-08-02T19:34:21.005Z"}
prestart migrations ............ none applied — this lane ships none
```

## Deployed boundary smoke — the rung that mattered

```text
PASS  B1-B5   all five legacy shared-key doors GONE (404)
PASS  B6      authenticated GET /operator/obligations reachable
PASS  B7      response carries SERVER-DERIVED scope
PASS  B8      client property_id REFUSED (403)
PASS  B9      out-of-scope claim CONCEALED (404, not 403)
PASS  B10     shared operator key ALONE cannot read obligations (401)
PASS  FLOOR   all 10 obligation-boundary behaviours executed
BOUNDARY: 10/10 behaviours executed + 1 execution-floor assertion
```

Authorized production QA record created and retained:
`R3 SMOKE 1785699397666 — QA (not an operating property)`.

**Aggregate smoke: RED — 30 passed / 1 failed / SMOKE_EXIT=1.** Not green. See
the open defect below.

## Deployed browser acceptance

| Check | Result | Evidence |
|---|---|---|
| Authorized obligations render | PASS | 23 rows, real, property-scoped |
| Request path carries no property_id | PASS | `:path /operator/obligations?status=open` |
| `x-staff-session` present | PASS | request headers |
| `x-operator-key` absent | PASS | request headers |
| Self-claim succeeds | PASS | 3 real claims, `receipt: "Claimed."` |
| Session user becomes owner | PASS | `assignee` === `claimed_by` === session user |
| Claimed item leaves the open queue | PASS | `still_in_open_queue: false`, count 23 → 22 |
| …for the right REASON | PASS | `status: "in_progress"`; queue filters `status=open` |
| Claim body carries no `user_id` | PASS | DevTools Payload: `{}` — *No properties* |
| Unavailable distinct from empty | PASS | 404 → unavailable banner; 200 + 0 qualifying rows → quiet line |
| Preview/demo remain local | **Not re-verified on production** | proven in the browser harness (25/0) against this exact artifact; both interceptors are client-side path matching with no origin dependence |

**One assertion I withdrew mid-acceptance.** A `window.fetch` interceptor
returned `wire: null` — `__psLive` is frozen and holds its own fetch reference,
so it never fired, and `body_has_user_id: false` was **vacuous**. It was
discarded, not counted. The DevTools Payload capture replaced it.

## Open defects — neither introduced by this release

### 5b — leasing-task reassignment

```text
POST /operator/leasing/tasks/:id/reassign
Expected: eligible task reassignment succeeds without moving conversation ownership
Actual:   HTTP 400, convOwner=true
Production reproduction: yes
Local reproduction:      yes
First production execution of this smoke: 2026-08-02
Relationship to this release: no changed reassignment code in the merged diff
                              (f85f70b..10c43b3 touches server.js, three new
                              src/obligations files, two harnesses, two smoke
                              files, one doc — nothing on that path)
Pre-existing status: strongly indicated, NOT conclusively proven — this smoke
                     had never been run against production before today
Rollback: DECLINED. It would restore the known cross-property shared-key
          exposure and is unlikely to repair 5b.
Owner: separate lane. Not diagnosed or repaired during the window.
```

### Cosmetic — the Claim button still gates on the retired User ID field

`obligationActions` uses `canClaim = !o.assigned_user_id && userId()`. The
browser-entered user id has **no authority** — the server derives the actor and
refuses a client `user_id` with 403 — but it still controls whether the button
renders. **Logged, not fixed during acceptance.**

## Closing statement

```text
OBLIGATION SECURITY GATE CLOSED — DEPLOYED AND PROVEN

Boundary proof:            10/10 + execution floor
Browser acceptance:        passed
Aggregate release smoke:   30/31
Open unrelated defect:     leasing reassignment assertion 5b
```

---

# ASK SPINE SLICE 1 — DEPLOYED 2026-08-02

```text
API PR #31 merged .... efb8c71   9:25 PM ET   Deploy live confirmed
App PR #25 merged .... 5cbe948   9:28 PM ET   Deploy live confirmed
Order ................ API first (additive route, no caller until the app ships)
/health .............. {"ok":true,"db_time":"2026-08-03T01:24:44.668Z"}  9:24 PM ET
Migrations applied ... none
```

## Live acceptance — what was verified on production

Property home, Solo on Chestnut, signed in, real session:

- composer renders **above** the desk cards, `ASK SPINE` label + chip
- **"Here's what needs attention."** with five ranked items
- each item: reason chip (`OVERDUE · NO OWNER`), title, `Overdue · <date> · <module>`
- **"Showing 5 of 20 open items."**
- persistent scope line: *"Currently checks recorded open work for this property."*
- the word **"obligation" appears nowhere** in the interface
- **My Work simultaneously showed its legitimate empty line** — a *successful*
  read with nothing qualifying for the persona, rendered next to Ask Spine's
  populated list. Both honest states coexisting on one page is precisely what
  was broken this afternoon and is now correct.

**Cross-surface consistency, unplanned but meaningful:** the obligations read
reported 23 open earlier, three were claimed during the security acceptance,
and Ask Spine independently reports **20**. Two surfaces, one truth, no shared
client state.

## Not verified — stated, not glossed

```text
Ask Spine request headers on production ....... NOT CAPTURED
  (x-staff-session present / x-operator-key absent / no property_id)
Click-through from a result to the record ..... NOT EXERCISED
```

Both are proven in the harnesses against this exact artifact — the API-backed
browser rungs assert the header set and the navigation path — but **neither was
re-verified on the deployed surface.** The owner closed the window before those
two checks. Recorded as an evidence gap, not as a pass.

## Final proof state at deploy

| Rung | Result |
|---|---|
| Contract | 31 / 0 |
| Real Postgres | 23 / 0 |
| Real HTTP | 27 / 0 |
| Browser UI states | 27 / 0 |
| API-backed desktop | 11 / 0 |
| API-backed phone | 11 / 0 |
| Real outage | 8 / 0 |
| Visual repair | 24 / 0 |
| App suite | 749 / 0 |
| Obligation security regressions | 21 / 12 / 61 / 25, all 0 failed |

## What shipped, stated plainly

One authenticated endpoint answering one question from real recorded work,
property and permissions decided by the server, ranked by four tiers of
recorded fact, capped at five, with a failure state that admits failure instead
of inventing an empty answer.

**What is NOT built, and was never claimed:** no text input (the composer is a
single chip — the recognizer beneath it is unreachable from the UI), no
interpretation, no conversation or thread, no writes, one question and one
dataset.

## Open items carried out of this programme

| Item | Owner |
|---|---|
| Conversational composer — a real input, prose vs cards, thread, what it says when it doesn't know | **Slice 2 — new build, owner-directed** |
| Leasing-task reassignment smoke `5b` — 400, `convOwner=true` | separate lane |
| Obligations unavailable banner still shows developer language | UI follow-up |
| Claim button gates on the retired User ID field (no authority, visibility only) | UI follow-up |
| Migration 121 — branch-only migration live in production, inert | baseline lane, Appendix J |
| `docs/deployment.md` teaches the false-green migration pattern | baseline lane, Appendix I |
| Migration chain cannot rebuild from empty (`012`) | baseline lane, Appendix H |

**Both releases are deployed. The programme is closed.**
