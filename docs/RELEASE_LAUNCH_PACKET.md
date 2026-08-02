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
| App SHA | **`b35ed66`** |
| API PR | **#32** — `https://github.com/kzitelli-art/property-spine-api/pull/32` |
| API SHA | **`3024478`** |
| Merge order | **app #26 → then API #32, immediately** |
| Full record | `docs/SECURITY_OBLIGATIONS_ROUTE.md` (API repo) |

## Roles — every role needs a name; one person may hold several

```text
Presses merge on app PR #26 ....................... ____________________
Confirms the new app SHA is live .................. ____________________
Presses merge on API PR #32 ....................... ____________________
Watches the Render API build ...................... ____________________
Runs the deployed smoke ........................... ____________________
Runs the browser acceptance ....................... ____________________
Authority to call rollback ........................ ____________________
Records the final receipt ......................... ____________________
FINAL GO/NO-GO CALL ............................... ____________________
```

## Dashboard fields to verify before anything moves

```text
API service name ......... ______   App service name ......... ______
API configured branch .... ______   App configured branch .... ______
API auto-deploy .......... ______   App auto-deploy .......... ______
API deployed SHA ......... ______   App deployed SHA ......... ______
API last deploy duration . ___ min  App rollback available ... ______
API rollback available ... ______   App deploy in progress ... ______
API deploy in progress ... ______
```

Two traps: the app's `__PS_BUILD.code_sha` is **one commit behind by
construction** — the deployed head is its *stamp child*. And the Render Shell
has **no `.git`**; use `echo $RENDER_GIT_COMMIT`, not `git rev-parse`.

## Health

```text
GET https://property-spine-api.onrender.com/health              → { ok, db_time }
GET https://property-spine-api.onrender.com/health/migrations   → needs x-operator-key
```

Never paste the key into a shared channel or a screenshot.

## Smoke — run in the Render Shell after the API is healthy

```bash
node tests/smoke_release3.deployed.js
```

It builds its own isolated `R3 SMOKE <ts>` QA property and its own staff
session, then runs the obligation boundary rung inside the same run. **A
missing session is a FAIL, not a skip.**

Boundary rung, nine checks:

```text
GET   /obligations                     → 404
GET   /obligations/:id                 → 404
PATCH /obligations/:id/claim           → 404
PATCH /obligations/:id/satisfy         → 404
PATCH /obligations/:id/complete        → 404
GET   /operator/obligations   (session)      → 200, server-derived scope echoed
GET   /operator/obligations?property_id=…    → 403  (client scope refused)
POST  /operator/obligations/<other>/claim    → 404  (concealed, not 403)
GET   /operator/obligations   (shared key only) → 401
```

**Exit code 0 with a non-zero `failed` count is impossible** — the harness exits
1 on any failure. Read the `RESULT:` line, not the absence of red text.

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
[ ] /health/migrations green
[ ] migration 121 explicitly classified
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
Recent API deploy duration ...... X = ______ min   (from the deploys list)
Escalation threshold ............ X + 5 min        — start diagnosing
ROLLBACK DECISION POINT ......... 2X + 5 min       — fixed clock time: ______
```

Write the clock time down **before** merging the app. If the API is not healthy
at that time, **roll back the app** and restore the prior stable state. "Still
progressing" is not a reason to wait past it.

**If X is unknown, the window does not open.** An unbounded ceiling is a STOP
condition, not a detail.

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
