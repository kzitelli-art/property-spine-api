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

## Smoke — run in the Render Shell after the API is healthy

```bash
node tests/smoke_release3.deployed.js
```

It builds its own isolated `R3 SMOKE <ts>` QA property and its own staff
session, then runs the obligation boundary rung inside the same run. **A
missing session is a FAIL, not a skip.**

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
