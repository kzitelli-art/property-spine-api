# Security lane — the obligation authority boundary

**Release gate. This must close before Ask Spine is deployed to production.**

**Scope discipline:** this lane is the fix. It is **not** to be folded into Ask
Spine, and Ask Spine neither depends on these routes nor remediates them. Ask
Spine built a new gated route precisely so the two stay separate.

> **Document status.** This file states the finding **once, in its corrected
> form**. Superseded framings from earlier in the investigation were **removed,
> not annotated**: Git history is the right place for how an investigation
> evolved, and a governing document must never carry a superseded account
> beside the true one.

---

## The defect, stated once and correctly

> **Five obligation routes were protected by a portfolio-wide shared operator
> key, held in browser `localStorage`, but had no server-derived property,
> module, or actor authority.**

Every element of that sentence is load-bearing:

- **Protected, not open.** A global gate (`server.js:147–162`) applies to
  everything not explicitly allowlisted. `/obligations` was not allowlisted, so
  it was gated, and gated **fail-closed**:

  ```text
  OPERATOR_KEY unset in the environment  → 503  (locked, never silently open)
  missing or wrong x-operator-key        → 401
  valid shared OPERATOR_KEY              → the route runs
  ```

  `/operator/*` skips this gate deliberately (`isOperatorPath`) because those
  routes enforce staff sessions internally. Matching is exact-boundary, so
  `/operatorial` does not bypass it.

- **Portfolio-wide.** One key, the whole estate. The data behind it is
  **property-scoped**. That mismatch is the defect: authentication existed;
  **authority did not**.

- **Held in the browser.** Established without printing or exposing any value:

  ```text
  index.html:9787   $('opKey').value = localStorage.getItem('ps_operator_key')
  index.html:6339   const key = () => $('opKey').value.trim()
  index.html:6341   const headers = (extra={}) =>
                      Object.assign(key() ? {'x-operator-key': key()} : {}, extra)
  index.html:9791   persisted back to localStorage on change
  index.html:9966   removed on sign-out
  ```

  **This contradicts the server's own stated policy.** `server.js:144` says
  *"we never put the raw OPERATOR_KEY in a browser."* That holds for
  `/operator/*` — which is exactly why those routes skip the key gate — but the
  legacy non-`/operator/` surface still required the key, and the app supplied
  it from `localStorage` to satisfy that requirement.

- **No server-derived property.** `property_id` came from `req.query` and was
  used directly. **Omit it and the `where` clause is empty** — `select * from
  obligations` across every property. The four sibling routes act on an
  obligation **by ID alone**, with no property predicate at all.

- **No module entitlement.** Nothing consulted the caller's allowed modules.

- **No server-derived actor.** `PATCH /obligations/:id/claim` took the claiming
  `user_id` **from the request body**, sourced from a browser text field
  persisted in `localStorage.ps_user_id`.

- **No projection.** `select *` returned every column, including any future
  sensitive field.

**Severity: material isolation defect.** Anyone who obtained the key — a
departing employee, a shared workstation, an XSS on the page — could read
obligations across **every** property, and could claim, satisfy or complete work
on a property they had no authority over, **as any user**.

## Five routes, one defect — not one route

| Route | Credential | Property derived? | Module derived? | Cross-property act by ID? | Callers found |
|---|---|---|---|---|---|
| `GET /obligations` (`server.js:733`) | shared key | **no** — `req.query` | **no** | **yes** — by omitting `property_id` | `loadObligations()` |
| `GET /obligations/:id` (`:761`) | shared key | **no** — `where id=$1` | **no** | **yes** | none |
| `PATCH /obligations/:id/claim` (`:792`) | shared key | **no** | **no** | **yes — MUTATION** | `claimObligation()` |
| `PATCH /obligations/:id/satisfy` (`:884`) | shared key | **no** | **no** | **yes — MUTATION** | none |
| `PATCH /obligations/:id/complete` (`:913`) | shared key | **no** | **no** | **yes — MUTATION** | deployed smoke only |

**None of the five called `resolveStaffSession`. None filtered by property.**
The three `PATCH` routes are cross-property **writes** — a strictly more severe
class than the read this lane was opened for. That escalation was found by the
Phase 0 sibling check below, was ruled on, and **all five routes are in scope
and all five are retired** by this lane.

## The consumer defect that travels with it

`loadObligations()` wrapped its call in `tryJSON(path, [], …)`, so a denial or
failure rendered as **"nothing to do."** Locking the routes without fixing that
caller would turn a 401 into a silent empty — the exact honest-blank violation
§5 forbids. **The caller had to be migrated, not merely re-pointed.**

## Required proof

```text
no staff session                    → denied
authenticated Property A session    → only Property A rows
client-supplied Property B id       → cannot widen access
unauthorised module                 → excluded
zero permitted scope                → no data, and no unrestricted query
client-supplied user_id             → refused, not ignored
all five legacy routes              → unrouted, not merely unused
```

Each against **real Postgres with rows on at least two properties**. A source
assertion that the gate exists is not sufficient; the cross-property case must
be proven by **absence in a real response**.

## Sequencing

```text
land this fix
→ rebase the Ask Spine API branch onto the new main
→ rerun the Ask Spine contract, HTTP, Postgres and browser proofs
→ then merge and deploy Ask Spine
```

**Ask Spine must not ship beside a known cross-property exposure**, even though
it does not use these routes.

## Provenance

Found during the Ask Spine source audit (`docs/ASK_SPINE_SOURCE_AUDIT.md`,
Phase 2 Read 2) while establishing why Ask Spine could not reuse the existing
obligations read. Registered as a standalone finding at that time and
deliberately left unremediated in that lane.

---

# Consumer inventory — complete (2026-08-02)

**Bounded current-source audit across both repositories**, taken before any
route change. This inventory was the input to the architecture choice.

## Consumers of `GET /obligations`

| # | Repo · file | Kind | Supplies `property_id`? | Auth context | Migratable? | Breaks if locked? |
|---|---|---|---|---|---|---|
| 1 | app · `index.html:11076` `loadObligations()` | **browser** | **yes**, from `prop()` (a DOM read, server-pinned under a live session) | `headers()` — operator key / staff session as configured | **Yes** | **Yes** — this is the only real break |
| 2 | app · `index.html:5820` | **offline/preview interceptor** | parses it from the path | none — never reaches the network | n/a | no |
| 3 | app · `index.html:10177` | **demo interceptor** | ignores it; returns `DEMO_DB.obligations` | none — never reaches the network | n/a | no |

**Consumers 2 and 3 never issue a network request.** They short-circuit the path
inside the browser, so the live route is only reached in the signed-in path.
`docs/MAINTENANCE_UNIT_STATUS_SOURCE_COMPARISON.md:716` documents consumer 3 —
that is a record of the app's demo interceptor, **not** an API contract.

### Confirmed absent

- **No server-side or internal consumer.** Nothing in `src/`, `tools/`, or any
  shell script calls the collection route.
- **No proof or smoke-test consumer.** `smoke_release2/3.deployed.js` use
  `PATCH /obligations/:id/complete` — a different route.
- **No `curl` of it anywhere** in either repository.
- **No documented API contract** naming it as a public interface.

### Fan-out of the one real consumer

`loadObligations()` is called from **eight** sites in `index.html` — `:10855`
(the persona work queue), `:11168`, `:21565`, `:22596`, `:23251`, `:23787`,
`:23921`, `:24875`. They all go through that **single function**, so the
migration surface is one function body, not eight call sites.

**It is also wrapped in `tryJSON(path, [], …)`**, so today a denial or failure
renders as "nothing to do". Locking the route without fixing that caller would
turn a 401 into a silent empty — the exact honest-blank violation this codebase
forbids. **The caller must be migrated, not merely re-pointed.**

---

# Recommended architecture

## Preferred option is available: retire the shared-key route

The inventory shows **no non-operator consumer exists**. The acceptable-fallback
case — a genuine machine consumer needing its own authority boundary — **does
not apply here**. So:

1. **Add** an authenticated, server-scoped operator read for the same data.
2. **Migrate** `loadObligations()` to it, replacing `tryJSON(…, [])` with the
   `liveRequired` loader so a denial cannot render as empty.
3. **Remove** `GET /obligations`.

**Not acceptable, and explicitly rejected:** merely requiring a token while
continuing to trust a browser-supplied `property_id`. Authentication without
server-derived scope leaves the cross-property defect intact.

## Proposed files

| File | Change |
|---|---|
| `src/obligations/operator_obligations.js` | **new** — `GET /operator/obligations`, gated exactly like `ask_spine.js`: `resolveStaffSession` → `req.operator.property_id`, refuse a mismatched client `property_id` with 403, module entitlement from the session |
| `server.js` | **route registration only**, plus removal of `app.get("/obligations", …)` at `:733` |
| `tests/operator_obligations_security_proof.db.js` | **new** — real Postgres + authenticated HTTP, explicit assertion floor |
| app · `index.html` | migrate `loadObligations()` to the new route via `loadResource`; **one appended `LIVE_RESOURCES` entry** |

**Ask Spine is not touched, and the new route does not depend on the old one.**
Ask Spine keeps its own purpose-built endpoint; this lane serves the app's
general obligations read. The only thing they share is the authority seam, which
is copied rather than imported so neither door depends on the other.

## Collision check against active branches

Checked against every branch ahead of `main` in both repositories:

| Surface | Contention |
|---|---|
| `server.js` | Ask Spine PR #31 adds a **registration block** near `:3148`; this lane edits **`:733`** and registers separately. Same file, **different anchored regions** — merges cleanly. |
| `src/obligations/` | **new directory** — no branch touches it |
| `index.html` `loadObligations` | **no active branch modifies it** (verified by content across all app branches ahead of `main`) |
| `index.html` `LIVE_RESOURCES` | **contended** — Ask Spine appends one entry; three app branches edit `createLiveLoader`. Keep this lane's addition to **one appended entry** for a one-line resolution. |
| Slice 9 | **zero shared files** — it writes obligations, it does not read them this way |

**No genuine semantic conflict.** The one real ordering constraint is that both
this lane and Ask Spine append to `LIVE_RESOURCES`; whichever lands second
resolves one line.

---

# Approval gate — satisfied

This inventory was reviewed and the architecture approved before any security
code was written. The proof requirements (real Postgres, authenticated HTTP,
explicit assertion floor, no global test-infrastructure expansion) were recorded
above and were met — see **Proof counts** in the final receipt.

---

# Sibling-route authority check — escalated, ruled, and resolved

**Recorded as found.** The bounded sibling check showed the obligation boundary
was wider than the collection read and **included mutation**. That exceeded the
scope this lane was opened for, so implementation paused and a ruling was
requested. **The ruling brought all five routes into this lane, and all five are
retired.** Classified from the source as it then stood:

| Route | Credential | Derives property? | Derives module? | Cross-property act by ID? | Callers |
|---|---|---|---|---|---|
| `GET /obligations` `:733` | shared key | **no** — from `req.query` | **no** | **yes, by omitting `property_id`** | `loadObligations()` |
| `GET /obligations/:id` `:761` | shared key | **NO** — `select * from obligations where id=$1` | **no** | **YES — any obligation, any property, by ID** | none found in-repo |
| `PATCH /obligations/:id/claim` `:792` | shared key | **NO** — same shape | **no** | **YES — MUTATION** | app `index.html:14028` `claimObligation()` |
| `PATCH /obligations/:id/satisfy` `:884` | shared key | **NO** | **no** | **YES — MUTATION** | none found in-repo |
| `PATCH /obligations/:id/complete` `:913` | shared key | **NO** | **no** | **YES — MUTATION** | `smoke_release2/3.deployed.js` |

**None of the four siblings calls `resolveStaffSession`. None filters by
property. All act on an obligation by ID alone.**

## Why this is escalated rather than absorbed

The collection route is a **cross-property read**. The three `PATCH` routes are
**cross-property writes** — a holder of the shared key who knows or guesses an
obligation ID can claim, satisfy or complete work belonging to a property they
have no authority over. That is a strictly more severe class than the finding
this lane was opened for.

**This lane therefore could not claim the obligation boundary was closed by
fixing the collection route alone**, which is why implementation stopped here
and asked.

> **Ruling given.** All five routes belong to one program and are remediated
> together — Phase A the reads, Phase B the actions. No route is deferred with
> an accepted-risk note, and no shared-key route survives the lane.

---

# Offline and demo interceptors — must be preserved deliberately

Migrating `loadObligations()` to `/operator/obligations` will stop both
client-side interceptors from matching, because both match on the literal
`/obligations` path:

| Site | Kind | Match | Returns |
|---|---|---|---|
| `index.html:5820` | offline / persona-preview | `clean==='/obligations'` or `/^\/obligations(\?\|$)/` | live local store via `obligationsForProperty(pid)` — explicitly *"Never DEMO_DB"* |
| `index.html:10177` | demo | `clean==='/obligations'` or `/\/obligations(\?\|$)/` | `DEMO_DB.obligations` |

**Neither reaches the network today.** If their matching is not updated, preview
and demo would fall through to a live authenticated call — which is precisely
the live-first violation §19–20 forbids in the opposite direction.

Required regression proof:

```text
live signed-in path   → uses authenticated /operator/obligations
preview path          → stays local and deterministic
demo path             → stays local and deterministic
no live session       → NO live obligations request is issued at all
```

---

# Approved architecture — unchanged, recorded for implementation

`GET /operator/obligations`, with:

canonical staff-session authentication · property derived **only** from the
resolved session · module entitlement derived **only** from the resolved
session · **no authoritative `property_id` request parameter** · client property
or module parameters rejected or ignored, never trusted · zero entitlement
performs **no unrestricted query** · **explicit field projection — no
`select *`** · honest unavailable in the app · the old collection route removed
after the consumer migrates.

**Only the filters `loadObligations()` actually needs.** It sends
`property_id` (which becomes server-derived) and `status=open`. Legacy filters
`assigned_role`, `assigned_user_id`, `unclaimed` have **no in-repo caller** and
will not be carried forward.

## Structure

```text
src/obligations/operator_obligations.js          route: session, validation, HTTP mapping
src/obligations/operator_obligations_service.js  service: scoped query, filters, projection, ordering
```

Neither duplicates Ask Spine's service, and neither endpoint depends on the
other. The canonical session resolver is reused; only the thin mounting pattern
is copied.

## Response envelope

```json
{ "items": [], "total": 0,
  "scope": { "property_id": "server-derived", "modules": ["session-derived"] } }
```

Unavailable stays distinct from a valid empty array. The browser adapts `items`
for its existing call sites.

## Proof requirements (real Postgres, explicit floor, no global test changes)

1. no staff session → denied by the replacement perimeter
2. valid staff session for Property A → only Property A rows
3. Property B request parameter → cannot widen
4. unauthorized module rows excluded
5. zero entitlement → no database query
6. preview and demo remain local
7. live failure does not become empty
8. all five legacy routes no longer exist after migration
9. explicit projection prevents unrelated columns leaking
10. a client-supplied `user_id` is refused, not ignored

---

# Phase 0 — sibling consumer and semantics inventory (complete)

**One defect, five routes:** a browser-held portfolio-wide key can read or mutate
obligations without server-derived property, module, or actor authority.

## Route-by-route

### `GET /obligations/:id` — `server.js:761`

| | |
|---|---|
| **Callers** | **NONE.** No browser, proof, smoke, shell or internal caller in either repository. |
| Request / response | no body; returns the **entire row** (`select *`) plus `is_overdue` and the joined `source_event` |
| Canonical service? | **No — inline SQL** |
| Property authority | **none** — `where id=$1` |
| Actor recorded | none |
| Migration files | route only; **no consumer to migrate** |

**Retirable with zero consumer migration.** The `source_event` join is the only
behaviour worth carrying forward.

### `PATCH /obligations/:id/claim` — `server.js:792`

| | |
|---|---|
| **Callers** | **ONE:** app `index.html:14028` `claimObligation(id)`, from the obligation drawer (`:14026`) |
| Request | `{ user_id }` — **from `userId()` = `$('userId').value`, a browser-entered field persisted in `localStorage.ps_user_id`** |
| Response | the updated obligation row |
| Canonical service? | **No — inline SQL `update obligations set assigned_user_id …`** |
| Property authority | **none** |
| Actor recorded | `assigned_user_id` — **taken verbatim from the request body** |
| Existing guards | obligation must exist · user must exist · 409 if already claimed by someone else |
| Migration files | `server.js`, app `index.html` (`claimObligation` + its drawer button) |

**This is the sharpest actor defect.** The acting identity is a browser-entered
UUID. A key holder can claim work **as any user**, on **any property**.

### `PATCH /obligations/:id/satisfy` — `server.js:884`

| | |
|---|---|
| **Callers** | **NONE** in either repository |
| Request | `{ input, proof }` |
| Canonical service? | **Yes — `satisfyObligation`** (`server.js:188`, the shared core service) |
| Property authority | **none** at the route |
| Actor recorded | **none** — the service is not told who acted |
| Domain errors preserved | `NOT_FOUND` 404 · `NOT_OUTSTANDING` 409 · `BAD_INPUT` 400 |

### `PATCH /obligations/:id/complete` — `server.js:913`

| | |
|---|---|
| **Callers** | `tests/smoke_release2.deployed.js:70,93` · `tests/smoke_release3.deployed.js:89,109` — **deployed smoke tests**, calling with the shared key and `body: {}` |
| Request | `{ completed_by? }` — **spoofable actor** |
| Canonical service? | **Yes — `completeObligation`** |
| Property authority | **none** at the route |
| Domain errors preserved | `NOT_FOUND` · `ALREADY_COMPLETE` · **`CONVERSION_RAIL_REQUIRED`** (honest 409, wrong-door) · **`INPUTS_OUTSTANDING`** (409 naming what is owed) |

**These domain errors are business invariants and must survive hardening
untouched.**

## Interceptor trace — all affected routes

| Site | Matches | Covers the siblings? |
|---|---|---|
| `index.html:5820` | `clean==='/obligations'` or `/^\/obligations(\?\|$)/` | **No** — anchored, so `/obligations/<id>/claim` does **not** match |
| `index.html:10177` | `clean==='/obligations'` or `/\/obligations(\?\|$)/` | **No** — same |

**Neither interceptor covers the sibling routes.** So `claimObligation` in
preview/demo already reaches the network today — or fails. Only the **collection
read** is intercepted, and only that one needs its matcher updated when the
caller moves. The sibling migration does not risk breaking preview/demo, because
preview/demo never intercepted them.

## The two pause-conditions — both checked, neither triggered

| Condition | Result |
|---|---|
| **Would a canonical workflow break?** | **No.** Only one live browser workflow exists (claim). `satisfy` and `GET /:id` have no callers at all; `complete` has only deployed smoke tests, which authenticate with the shared key server-to-server and are unaffected by browser-side changes. |
| **Does Slice 9 edit the same business service?** | **No.** `git diff origin/main...origin/claude/slice-9-demand-evidence` touches neither `server.js` nor any `obligation*` file. Zero overlap. |

**Proceeding to implementation without a further approval pause, as directed.**

## Migration surface, exact

| File | Phase |
|---|---|
| `src/obligations/operator_obligations.js` | **new** — A |
| `src/obligations/operator_obligations_service.js` | **new** — A |
| `src/obligations/operator_obligation_actions.js` | **new** — B |
| `server.js` | registration; retire `:733`, `:761` (A) and `:792`, `:884`, `:913` (B) |
| app `index.html` — `loadObligations()` + interceptor matcher | A |
| app `index.html` — `claimObligation()` + drawer button | B |
| `tests/*.db.js` | read proof (A), mutation proof (B) |

**Ask Spine files: none.** Slice 9 files: none. Migrations: none.

## Actor-identity note for Phase B

Neither `satisfyObligation` nor `completeObligation` currently receives an
acting user; `completeObligation` takes only an optional `completed_by` from the
body. Recording the server-derived actor therefore requires either a service
signature change or a route-level audit write. **That choice will be made and
stated when Phase B is built — it must not silently keep the spoofable field.**

---

# Final receipt — the obligation authority boundary

## The permanent boundary, stated plainly

### Supported HTTP surface
- **`GET /operator/obligations`** — authenticated, property- and module-scoped collection read
- **`POST /operator/obligations/:id/claim`** — authenticated **self-claim**

### Deliberately service-only
- **`satisfyObligation`** — canonical service, no HTTP door
- **`completeObligation`** — canonical service, no HTTP door

Both remain fully enforced (required inputs, conversion rail) and are now
proven **directly** rather than through an exposed route kept alive for a test
to call.

### Removed
- **All five shared-key legacy obligation routes** — `GET /obligations`,
  `GET /obligations/:id`, `PATCH /obligations/:id/{claim,satisfy,complete}`
- **Browser-selected claimant identity** — `localStorage.ps_user_id` is off the
  authority path
- **Client-selected property scope** — refused, not ignored

### Deferred by design — not forgotten
- **Manager assignment / delegation** — no server-side work-assignment
  capability exists today (`can_manage_roles` is role administration;
  `reassignObligation` reassigns by *role*, internally). Rebuilding "send any
  user id" behind a new URL would recreate the defect with better manners.
- **Authenticated satisfy workflow** — no product caller exists.
- **Authenticated completion workflow** — no product caller exists. When one
  does, it must pass the actor into the canonical service **in the same
  transaction**, not via a side audit write.

---

## Exact changes

### Routes removed (API)

| Route | Replacement |
|---|---|
| `GET /obligations` | `GET /operator/obligations` |
| `GET /obligations/:id` | **none** — no caller existed |
| `PATCH /obligations/:id/claim` | `POST /operator/obligations/:id/claim` (self-claim) |
| `PATCH /obligations/:id/satisfy` | **none** — service-only |
| `PATCH /obligations/:id/complete` | **none** — service-only |

### Files

| File | Change |
|---|---|
| `src/obligations/operator_obligations_service.js` | **new** — scoped query, explicit projection, whitelisted status, deterministic ordering |
| `src/obligations/operator_obligations.js` | **new** — thin route: session, authority refusal, HTTP mapping |
| `src/obligations/operator_obligation_actions.js` | **new** — self-claim |
| `server.js` | register two routers; **retire all five legacy routes** |
| `tests/operator_obligations_security_proof.db.js` | **new** — 21 assertions, floor 20 |
| `tests/obligation_completion_canonical_proof.db.js` | **new** — 12 assertions, floor 12 |
| `tests/smoke_release2.deployed.js`, `smoke_release3.deployed.js` | legacy calls retargeted; boundary smoke added |
| app `index.html` | `loadObligations()` migrated; `claimObligation()` migrated; **both interceptors extended**; one appended manifest entry; one named write action |

### Consumers migrated

| Consumer | From | To |
|---|---|---|
| `loadObligations()` (8 call sites, one function body) | `tryJSON('/obligations?property_id=…', [])` | `loadResource('operatorObligations')` |
| `claimObligation()` | `PATCH /obligations/:id/claim` with `{user_id}` | named write action, **empty body** |
| deployed smoke completion cases | `PATCH /obligations/:id/complete` | canonical-service proof + boundary smoke |

### Preview and demo preserved

Both client-side interceptors now match `/operator/obligations` as well as the
legacy path, so preview keeps resolving from its local store and demo keeps
returning `DEMO_DB`. **Without that they would have stopped matching and fallen
through to a live authenticated call** — the live-first violation in the
opposite direction. `loadObligations()` also issues **no request at all**
without a live session.

### Typed response contract

```json
{ "items": [], "total": 0,
  "scope": { "property_id": "server-derived", "modules": ["session-derived"] } }
```

Adapted in the **one central loader**, so the eight call sites never see two
response shapes. Unavailable stays distinct from a valid empty array.

---

## Proof counts

| Harness | Assertions | Floor | Nature |
|---|---|---|---|
| `operator_obligations_security_proof.db.js` | **21** | 20 | real Postgres · real sessions · authenticated HTTP |
| `obligation_completion_canonical_proof.db.js` | **12** | 12 | real Postgres · canonical services |
| app suite (`run_harnesses.sh`) | 749 | — | 17 harnesses, 0 red |

**Legacy doors proven unrouted (404) — not merely unused.**

## Collision status

| Lane | Status |
|---|---|
| **Ask Spine** | **No shared files.** Ask Spine keeps its own purpose-built endpoint and does not depend on these routes; the authority seam is copied, not imported. `server.js` registrations sit in the same block, adjacent lines — trivially mergeable. |
| **Slice 9** | **Zero overlap.** Touches neither `server.js` nor any `obligation*` file. |

## Release blockers

**None inside this lane.** Remaining sequence: merge and deploy this security
lane → prove the legacy browser key can no longer reach obligation routes on
the deployed API → rebase Ask Spine → rerun its ladder → merge and deploy Ask
Spine.

**One honest caveat:** the deployed boundary smoke is written and parses, but
**has not been executed against a deployed API** — there is no deployment to
run it against from here. It is *Built*, not *Proven*, and must be run as part
of the deploy step.

---

# Browser rung — focused real-browser acceptance (2026-08-02)

Real Chromium, real authenticated API, real Postgres. **25 assertions, floor
22, 0 red.** Harness: app repo `obligations_security_browser_proof.browser.js`.
Screenshots and the header capture: app repo `docs/obligation-security/`.

| Proved in the browser | Result |
|---|---|
| Live collection renders from `GET /operator/obligations` | pass |
| Every obligation request carries `x-staff-session` and **no** `x-operator-key` | pass — `network-evidence.json` |
| Self-claim succeeds through the named write action, empty body | pass |
| Another property's work is not reachable from the UI | pass |
| Unauthorised module never appears | pass |
| No session → **zero requests issued**, honest unavailable state | pass — `03-unavailable.png` |
| API failure renders unavailable, **not** an empty queue | pass |
| Preview and demo still resolve locally (both interceptors) | pass |

## Three defects the browser rung found — all real, all fixed

1. **`writeAction` requires a declared key.** The claim action was registered
   without one, so the write seam rejected it before any request left the page.
   Fixed by declaring `key: 'obligationId'`. *Source review had not caught this;
   only driving the real seam did.*
2. **The app read `d.receipt` off the envelope.** `writeAction` returns
   `{data, meta}`; the receipt lives at `out.data.receipt`. The success path
   was reading `undefined`. Fixed.
3. **Two of my own assertions were wrong.** I had asserted a claimed item
   leaves the open queue. It does not — claiming advances `open →
   in_progress`, and the queue is filtered by `status=open`, so it leaves for
   that reason and not the one I asserted. **The assertions were corrected to
   the actual behaviour rather than the behaviour reworded to match them.**

---

# Deployment topology and rollout (2026-08-02)

Everything below is **established from repository source and committed
documentation only**. This environment holds **no** Render credentials
(`RENDER_API_KEY` absent, `RENDER_SERVICE_ID` absent, `.env` absent) and no
production database credential (`DATABASE_URL` absent). Rows that a dashboard
would answer but source cannot are marked **not source-establishable** rather
than guessed.

| | **API — `property-spine-api`** | **App — `property-spine-app`** |
|---|---|---|
| **Hosting service** | Render **Web Service** (`docs/deployment.md:7`) | Render **Static Site** (`preview_build.js:3`, which documents the sibling preview static site and its publish dir) |
| **Repo / deployed branch** | `main` (`docs/deployment.md:7`). The branch is a Render **Settings → Branch** field and **has been repointed before** to run a harness off an unmerged branch (`docs/THREAD_HANDOFF.md:123–125`) — so `main` is a *setting*, not a guarantee | `main`. Established, not assumed: the stamped `code_sha` in `build-info.js` (`9422d45`) **is an ancestor of `origin/main`**, and its stamp child `0438574` sits on `main` |
| **Build step** | Docker — `node:22-alpine`, `CMD ["npm","start"]`; `prestart` runs `migrations/migrate.js` | **None.** "served as committed static files with no build step" (`build-info.js:3`). The *preview* site alone has a build command (`node preview_build.js`, publish `dist`) |
| **Auto-deploys on push** | **Yes**, on push to `main` (`docs/deployment.md:7`) | **Yes** by strong implication — the whole stamp-child convention and post-deploy probe in `build-info.js` presuppose deploy-on-commit. Not stated in words anywhere in the repo. **Treat as yes; confirm in the dashboard before the window opens.** |
| **Can auto-deploy be disabled?** | **Not source-establishable.** Render exposes it as a service setting; no repo evidence and no credentials here | **Not source-establishable** (same) |
| **Manual deploy of a chosen commit** | **Partially.** `deploy.sh` POSTs `/v1/services/{id}/deploys` with `{"clearCache":"do_not_clear"}` and **no commit reference** — it redeploys the *tip of the configured branch*. Deploying a specific commit means repointing Settings → Branch first (`THREAD_HANDOFF.md:123–125`) | **No mechanism in the repo.** Dashboard only |
| **Build / deploy duration** | **Not source-establishable.** Docker image build + `npm ci` + migration pass — minutes, magnitude unknown | **Near-instant** — no build step; the published artifact *is* the committed file |
| **Health / identity endpoint** | `GET /health` → `{ok, db_time}` (`server.js:246`). **`GET /health/migrations` DOES NOT EXIST** — see the correction below | **None.** Identity probe is `window.__PS_BUILD.code_sha`, which is **one commit behind by construction** (`build-info.js:3–8`) |
| **Rollback mechanism** | **No source-established mechanism.** The only rollback this repo can perform is `git revert` + push, which triggers a *new forward deploy* and **re-runs `prestart` migrations**. Render's dashboard rollback exists as a product feature but is unverified here — and it rolls back **code only, never schema** | `git revert` + push. With no build step this is a true artifact rollback |
| **Previous deployment retained** | **Not source-establishable** | **Not source-establishable** |

## The API deploy is never code-only by default

`prestart` runs `migrate.js` against **the service's own `DATABASE_URL`**
(`THREAD_HANDOFF.md:91–98`: *"deploying a branch and applying that branch's
migrations to production are THE SAME OPERATION"*). **This lane adds no
migration**, so this deploy *should* be code-only — but `main` carries a known
ledger/repo divergence (the documented GAP at 121, and the `012` rebuild defect
filed in PR #33). **Mandatory pre-deploy check:** read
`GET /health/migrations` immediately before the window and confirm no
unapplied migration would ride along as a side effect of shipping this lane.

## The bridge is NOT permitted — the deciding evidence

The preferred three-stage bridge was conditional: *"if the currently deployed
app does not send a staff session to its legacy calls, this bridge is not
permitted."*

Checked against `origin/main` of the app — the currently deployed version:

```js
// origin/main index.html:6312
const headers = (extra={}) => Object.assign(key()?{'x-operator-key':key()}:{}, extra);

// origin/main index.html:10896
await tryJSON(`/obligations?property_id=${encodeURIComponent(prop())}&status=open`,
              [], {headers:headers()});
```

`x-staff-session` on obligation-request lines in `origin/main`: **0 matches.**

**The deployed app's legacy obligation calls carry `x-operator-key` and NOT
`x-staff-session`.** A bridge could therefore only work by keeping the legacy
routes alive **still accepting the portfolio-wide shared key** — i.e. retaining
the exact defect this lane exists to remove, purely for rollout convenience.
That is forbidden by standing instruction. **The bridge is ruled out on
evidence, not preference.**

## Selected rollout — coordinated maintenance deployment, app first

There is no ordering without a disagreement window. The order is chosen by
which failure mode the window produces.

| Order | What the window looks like |
|---|---|
| **API first** | The deployed old app calls `GET /obligations` → **404** → `tryJSON(path, [], …)` swallows it → **obligation queues render EMPTY with no error**. A confident wrong. Direct §5 violation |
| **App first** | The new app calls `GET /operator/obligations` on the old API → 404 → the loader is `liveRequired` with **no fixture fallback** → **honest "unavailable"**. Claim fails visibly |

**App first.** The window is one API build long instead of seconds, and that is
the correct trade: the extra minutes carry no *new* exposure — the legacy
routes have been reachable for their whole life — while API-first would put a
fabricated "nothing to do" in front of an operator. A non-negotiable
(§5) outranks a shorter window.

```text
1.  Establish the deployed migration ledger (see MIGRATION PREFLIGHT —
    NOT via /health/migrations, which does not exist).
2.  Merge the APP PR to main. No build step → live in seconds.
3.  Verify the app is serving the new file (window.__PS_BUILD / the
    obligations call now targeting /operator/obligations).
    ── window opens: obligations read UNAVAILABLE, honestly ──
4.  Merge the API PR to main. Render builds and deploys.
5.  Watch GET /health until the new build answers.
    ── window closes ──
6.  Run the deployed boundary smoke — the last unproven rung.
7.  Confirm in a real browser: collection loads, self-claim works,
    and the legacy paths return 404.
```

**Rollback of the window, both directions:** revert the app commit (instant,
restores the old file, which the old API still serves) or revert the API commit
(a forward deploy; safe here **only because this lane adds no migration**).

**Not done in this rollout, deliberately:** no compatibility alias, no
test-only endpoint, no secret URL, no shared-key window kept open "just for the
cutover."

## Exact commit boundaries

**No bridge commits exist, because there is no bridge.**

| Repo | Branch | Commits | State |
|---|---|---|---|
| API | `claude/security-obligations-route` | 9 | complete through `4a81c77` |
| App | `claude/security-obligations-route` | 3 | complete through `b35ed66` |

**One final commit, API only:** this section — deployment topology, the bridge
ruling, the browser rung. Documentation only; **no code, no test, no route
changes.** The app branch needs no further commit: its browser evidence
(`docs/obligation-security/`) is already committed.

## Incidental finding, filed not fixed

`docs/deployment.md:76` instructs future authors to write
`DO $$ BEGIN … EXCEPTION WHEN others THEN null; END $$;` and cites
`migrations/090_admin_users.sql` as **the pattern to follow**. That is the
exact construct recorded as false-green defect **A090-2** in
`docs/DB_CONNECTION_INVENTORY.md`. **The deployment guide is actively
recommending the anti-pattern the audit programme exists to remove.** Out of
scope for this lane; recorded here so it is not rediscovered a third time.


---

# OPERATOR DEPLOYMENT CARD — must be completed before merge

**These fields cannot be established from source.** They are dashboard and
runtime facts. **Do not guess any of them.** A blank field is a blocker, not a
formality: these determine what actually happens when the merge buttons are
pressed.

Whoever holds Render access fills this in and returns it. Record SHAs only —
**never a key, token, or connection string.**

```text
── API service ──────────────────────────────────────────────
Render service name:            ____________________
Configured branch:              ____________________   (expected: main)
Auto-deploy:                    on / off / ____________________
                                if off, exact trigger: ____________________
Currently deployed SHA:         ____________________   (Render Shell: echo $RENDER_GIT_COMMIT)
Last deploy duration:           _______ min           (from the deploys list)
Rollback available:             yes / no / ____________________
Any deploy in progress now:     yes / no

── App service ──────────────────────────────────────────────
Render service name:            ____________________
Configured branch:              ____________________   (expected: main)
Auto-deploy:                    on / off / ____________________
                                if off, exact trigger: ____________________
Currently deployed SHA:         ____________________   (or window.__PS_BUILD.code_sha
                                                        + 1 stamp commit — see below)
Rollback available:             yes / no / ____________________
Any deploy in progress now:     yes / no

── Health ───────────────────────────────────────────────────
GET /health:                    ____________________
Deployed migration ledger:      ____________________  (Neon SQL editor)

── Execution ────────────────────────────────────────────────
Operator executing the window:  ____________________
Window start (local + UTC):     ____________________
```

**Two traps when filling this in.**

1. **The app's `__PS_BUILD.code_sha` is one commit behind by construction**
   (`build-info.js:3–8`). It names the *code* commit; the deployed head is that
   commit's **stamp child**. Do not report `code_sha` as the deployed SHA
   without saying which you mean.
2. **The Render Shell has no `.git`** (`THREAD_HANDOFF.md:120–125`).
   `git rev-parse HEAD` fails there. Use `echo $RENDER_GIT_COMMIT`.

---

# MIGRATION PREFLIGHT — run immediately before the window

**Every API deploy runs `migrate.js` against the service's own `DATABASE_URL`
via `prestart`.** Deploying code and migrating production are the same
operation (`THREAD_HANDOFF.md:91–98`). **No unrelated migration may ride
silently with a security release.**

| # | Step | Result |
|---|---|---|
| 1 | Record the deployed API SHA | ______ |
| 2 | `git diff --name-only <deployed-sha>..<merge-candidate> -- migrations/` | ______ |
| 3 | `GET /health` | ______ |
| 4 | Read the deployed ledger — **Neon SQL editor**, read-only `select` (below) | ______ |
| 5 | Confirm this lane adds no migration | **established from source: it adds none** — see below |
| 6 | Identify any unrelated unapplied migration that would run during `prestart` | ______ |

**Step 5 is already answered and does not need a dashboard.** The security lane
touches `server.js`, three new files under `src/obligations/`, two new
harnesses, two smoke files, and documentation. `git diff --name-only
origin/main...claude/security-obligations-route -- migrations/` returns
**nothing**. This deploy is code-only *from this lane's side*.

## CORRECTION — `/health/migrations` does not exist

**Established from source, 2026-08-02.** `docs/deployment.md:137–142` documents:

```bash
curl -H "x-operator-key: $OPERATOR_KEY" \
  https://property-spine-api.onrender.com/health/migrations
```

**There is no such route.** `server.js` defines exactly one health endpoint,
`GET /health` at `:246`. A repository-wide search finds `/health/migrations`
only in documentation — never in a router, never in `src/`. An earlier revision
of this file repeated the documented command as if it were a topology fact; it
cited the doc instead of the source. **Withdrawn.**

Consequence for the window: **migration state cannot be read over HTTP.** Use a
**read-only query in the Neon SQL editor** — no credential leaves the browser,
no environment variable changes, no deploy, no new endpoint:

```sql
select version from schema_migrations order by version;
```

Compare against the candidate's own files:

```bash
ls migrations/*.sql | sed -E 's#.*/([0-9]+).*#\1#' | sort
```

Anything present in the repository and absent from the deployed ledger **will
run during `prestart` on the next deploy.** That list — not a green health
check — is the preflight answer.

## Migration 121 — the file does not exist

**Established from source.** There is **no `121_*.sql`** in `migrations/`, on
this candidate or on `origin/main`. The sequence goes `120_ai_leasing_strategy_
foundation.sql` → `122_governed_economics_lineage.sql`.

`migrate.js` iterates the files present in `migrations/`. **With no 121 file,
nothing named 121 can execute during `prestart`** — this deploy cannot apply it,
re-apply it, or roll it forward. That is established without any dashboard.

What remains open is a **ledger question, not a deploy risk**: whether
production's `schema_migrations` carries a `121` row for a file that reached it
by a branch deploy and never reached `main`. The read-only Neon query above
answers it. The disposition rule is unchanged — but note that the deploy-risk
half is already closed by source.

## The migration-121 divergence must be closed as a deployment fact

`THREAD_HANDOFF.md` records a GAP at 121 — a migration that reached production
by a branch deploy while `main` lacked the file. Before the window, that
divergence resolves to **exactly one** of:

```text
already recorded and healthy   — 121 is in schema_migrations on the target
                                 database, and no file in the merge candidate
                                 is unapplied.  → PROCEED

pending and understood         — an unapplied migration exists, it is named,
                                 its content is read, its effect is understood,
                                 and it is accepted deliberately.
                                 → PROCEED ONLY WITH THAT NAMED ACCEPTANCE

stop deployment                — an unapplied migration exists that is not
                                 understood, or the deployed ledger disagrees
                                 with the repository.  → DO NOT MERGE
```

**"Probably fine" is not one of the three outcomes.**

Related, and separately filed: `docs/DB_CONNECTION_INVENTORY.md` records that
the migration chain **cannot rebuild from an empty database** (`012` re-declares
`vendors` under `create table if not exists`, so the declaration is silently
skipped and the following index fails). That is evidence-only in PR #33 and is
**not** a blocker for this release — it affects a rebuild, not a forward
migration of an existing database — but the operator should know it exists
before reading any migration output.

---

# FINAL SOURCE FRESHNESS CHECK — immediately before deployment

```bash
git fetch origin main                       # both repositories
git log --oneline <recorded-main>..origin/main
git diff --stat origin/main...HEAD          # confirm no new overlapping change
```

If `main` has moved in either repository: **rebase that security branch, then
rerun the focused proofs.** A rebase invalidates every proof taken before it.

Required focused results, unchanged, after any rebase:

```text
API security         21/21   (floor 20)
canonical completion 12/12   (floor 12)
browser security     25/25   (floor 22)
app suite           749/0/0
```

Record and carry into the window:

```text
Final API head SHA:   ____________________
Final app head SHA:   ____________________
API PR #32 mergeable: ____________________
App PR #26 mergeable: ____________________
```

---

# COORDINATED MAINTENANCE RUNBOOK

Both PRs open, reviewed and ready **before** step A. Do not start the window
otherwise.

### Step A — announce the window

> Obligation work views and the claim action may be briefly unavailable. This is
> intentional. An honest "unavailable" is preferable to a false empty queue.

### Step B — merge app PR #26 (first)

Wait until the static site serves **the exact merged app SHA**. Then verify:

- the new artifact is live;
- obligation reads call `/operator/obligations`;
- requests carry `x-staff-session`;
- requests **do not** carry `x-operator-key`;
- against the still-old API, the surface shows an **honest unavailable** state;
- it does **not** show a valid-empty state;
- no preview or demo request escapes to the API.

**Do not linger here.** This is the open window.

### Step C — merge API PR #32 (immediately after)

Watch the Render build from start through healthy deploy. Verify:

- `prestart` migration pass completes;
- `GET /health` healthy;
- the deployed ledger still matches the preflight reading;
- the deployed API SHA **matches the merged security commit**.

### Step D — deployed boundary smoke

```text
GET   /obligations
GET   /obligations/:id
PATCH /obligations/:id/claim
PATCH /obligations/:id/satisfy
PATCH /obligations/:id/complete
→ all 404
```

then, on the replacement surface:

```text
authenticated GET /operator/obligations   → correct property and modules only
authenticated POST …/:id/claim            → the SESSION user becomes assignee
client-supplied property_id               → refused
client-supplied user_id                   → refused
cross-property known ID                   → 404 (not 403 — no existence probe)
revoked session                           → denied
```

**This is the last unproven rung.** Until it runs, the boundary is *Proven*
locally and *Built* in deployment — not deployed-proven.

### Step E — deployed browser acceptance

In the **real deployed app**:

- collection renders;
- self-claim succeeds;
- the claimed item leaves the open queue (because `open → in_progress`, and the
  queue filters `status=open` — assert the reason, not just the disappearance);
- the unfiltered state shows the **session user** as owner;
- unavailable remains distinct from empty;
- preview and demo remain local;
- **no obligation request sends the shared operator key.**

Record screenshots and network evidence into `docs/obligation-security/`.
Headers recorded **present/absent only** — never a value.

---

# ROLLBACK RULES

### App merged, API deploy not started
Revert the app PR. The old API is untouched and still serves the old surface.
Clean exit.

### API build fails before becoming healthy
1. revert or roll back the API;
2. verify the **old** API is healthy;
3. revert the app so it targets the old surface again;
4. **do not leave the new app sitting in a permanent unavailable state.**

### API healthy but deployed acceptance fails
Identify which artifact is defective first.

- **App defect** — revert the app; then judge whether the secured API can safely
  remain (it can, if nothing else calls the retired routes).
- **API defect** — roll back the API, then revert the app.

**Never restore an unsecured compatibility route as an emergency patch.** That
reintroduces the defect this lane exists to remove, at the moment attention is
lowest.

**Every API deploy runs migrations.** Confirm schema compatibility before any
dashboard rollback or Git revert — a code rollback does **not** un-apply
schema. This lane adds no migration, so a rollback within this window is
schema-neutral; that guarantee does not extend to any other change riding along.

---

# Standing at the gate

**Nothing has been merged and nothing has been deployed.** Both PRs remain open
and draft. Ask Spine remains frozen; Slice 9 remains untouched.

**Merge is blocked on the operator deployment card above being completed with
real dashboard values.**
