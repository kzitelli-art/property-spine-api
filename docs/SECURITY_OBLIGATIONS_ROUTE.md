# Security lane — unauthenticated cross-property `GET /obligations`

**Release gate. This must close before Ask Spine is deployed to production.**

**Scope discipline:** this lane is the fix. It is **not** to be folded into Ask
Spine, and Ask Spine neither depends on this route nor remediates it. Ask Spine
built a new gated route precisely so the two stay separate.

---

## The defect

`server.js:733` — `app.get("/obligations", …)`

```js
app.get("/obligations", async (req, res) => {
  const { assigned_role, status, assigned_user_id, property_id, unclaimed } = req.query;
  …
  if (property_id) { vals.push(property_id); where.push(`property_id = $${vals.length}`); }
  …
  const sql = "select * from obligations" + (where.length ? " where " + where.join(" and ") : "") + …
```

Two independent failures:

1. **No authentication.** A bare `app.get` with **no operator gate, no session
   check, no perimeter**. Every comparable operator route in this codebase
   passes through `resolveStaffSession`; this one does not.
2. **Client-supplied scope.** `property_id` comes from `req.query` and is used
   directly. **Omit it and `where` is empty — the route returns `select * from
   obligations` across every property in the database.**

`select *` also returns every column, including any future sensitive field, with
no projection.

**Severity: material isolation defect.** Unauthenticated cross-property read of
operational work records.

## Known consumer

`property-spine-app` `index.html` (`loadObligations`) calls
`/obligations?property_id=…&status=open`, wrapped in `tryJSON(path, [], …)`.
Two consequences worth carrying into the fix:

- the caller supplies the property, so it will need the authorized shape;
- `tryJSON`'s `[]` fallback means a failure renders as "nothing to do" — an
  **honest-blank violation** in its own right, and a second reason this consumer
  needs revisiting rather than merely re-pointing.

## Decision required

1. **Remove** the route, or
2. **Gate it** behind operator authentication with server-derived property
   scope (and module entitlement, per §21), or
3. **Migrate** the remaining legitimate consumers to an authorized route, then
   disable it.

Option 3 is the likely path given the live app consumer. Ask Spine's
`src/agent/ask_spine.js` is a working reference for the gate shape:
`resolveStaffSession` → `req.operator.property_id` → refuse a mismatched client
`property_id` with 403.

## Required proof

```text
unauthenticated request
→ denied

authenticated Property A session
→ only Property A rows

client-supplied Property B id
→ cannot widen access

zero permitted scope
→ no data
```

Each must be exercised against **real Postgres with rows on at least two
properties** — the same standard Ask Spine was held to. A source assertion that
the gate exists is not sufficient; the cross-property case must be proven by
absence in a real response.

## Sequencing

```text
land this fix
→ rebase the Ask Spine API branch onto the new main
→ rerun the Ask Spine contract, HTTP, Postgres and browser proofs
→ then merge and deploy Ask Spine
```

**Ask Spine must not ship beside a known cross-property exposure**, even though
it does not use the route.

## Provenance

Found during the Ask Spine source audit
(`docs/ASK_SPINE_SOURCE_AUDIT.md`, Phase 2 Read 2) while establishing why Ask
Spine could not reuse the existing obligations read. Registered as a standalone
finding at that time and deliberately left unremediated in that lane.

---

# Consumer inventory — complete (2026-08-02)

**Bounded current-source audit across both repositories.** No route change has
been made. This inventory is the input to the architecture choice.

## Scope note — one route, not a family

`/obligations` names **five** routes. Only the **collection read** is in scope:

| Route | In scope? |
|---|---|
| **`GET /obligations`** (`server.js:733`) | **YES — the defect** |
| `GET /obligations/:id` (`:761`) | no — single row by id; still worth its own review |
| `PATCH /obligations/:id/claim` (`:792`) | no |
| `PATCH /obligations/:id/satisfy` (`:884`) | no |
| `PATCH /obligations/:id/complete` (`:913`) | no |

Conflating them would overstate the blast radius. The `PATCH` routes are what
the deployed smoke tests exercise, not the collection read.

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

## Preferred option is available: retire the public route

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

# Awaiting approval before any code

Per the ruling, **no security code is written until this inventory is reviewed.**
The proof requirements (eight cases, real Postgres, authenticated HTTP, explicit
assertion floor, no global test-infrastructure expansion) are recorded above and
unchanged.
