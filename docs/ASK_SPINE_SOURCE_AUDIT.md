# Ask Spine — source audit (Phase 1, read-only)

**No feature code. No redesign. Nothing implemented.** Source reading only,
across both repositories.

## Commit SHAs read

| Repo | Branch | SHA |
|---|---|---|
| `property-spine-api` | `main` | `4a048556ae50eed56e996e3f1f7d59872ab09fcc` |
| `property-spine-app` | `main` | `30e550b6c8f9b0e88beac426cbac5b6f35a0c37a` |

*(Report filed in the API repo's `docs/` because every governing document lives
there — `PHILOSOPHY.md`, `THREAD_HANDOFF.md`, `COMMUNICATION_LINE_ARCHITECTURE.md`.
The app repo has no `docs/`. Move it if that's wrong.)*

**Completeness:** §1, §2 and §4 are complete and source-verified. §3 and §5 are
**partial** — bounded explicitly in each section and summarised at the end. They
are not padded to look finished.

---

## 1. Property Home insertion point

### Rendering path

The app is a single **2 MB `index.html`** plus sibling `.js` modules loaded
alongside it. There is no build step or framework — Property Home is server-
agnostic static markup mutated by inline functions.

**Property Home is `<main id="home" class="home">`, `index.html:4279–4300`.** In
document order:

| Order | Element | Role |
|---|---|---|
| 1 | `.home-hero` → `#frontTitle`, `#frontSub` | "Property" / "Choose a desk." |
| 2 | **`<section id="myWorkMount">`** | **empty in markup**; filled at `index.html:10668` |
| 3 | `<section id="deskGrid" class="desk-grid">` | the desk cards |
| 4 | `<button id="reportingOutputBar">` | **Monthly Report panel** (`:4292–4295`) |
| 5 | **`<section id="frontDashboard">`** | **empty in markup**; filled at `index.html:9605` |
| 6 | `<section id="onboardingStrip">` | "Finish setup" strip |

### Correction: there are four desk cards, not three

The brief says three. Source shows **four**, all `<button class="desk-card">`
calling `openDesk(...)`:

| Card | `openDesk` arg | Owner span | Next span |
|---|---|---|---|
| Management | `'management'` | `#own-management` | `#next-management` |
| Leasing | `'leasing'` | `#own-leasing` | `#next-leasing` |
| Maintenance | `'maintenance'` | `#own-maintenance` | `#next-maintenance` |
| **Investor Relations** | `'capital'` | `#own-capital` | `#next-capital` |

The fourth is labelled *Investor Relations* but keyed `capital`. The Monthly
Report bar is a **fifth** target (`openDesk('reporting')`). Flagging because
"do not redesign the page" requires the audit to describe the page that exists.

Each card's owner span defaults to the literal text `unassigned` — consistent
with §5 (*honest blank*, `UNASSIGNED` when no owner).

### Styles and handlers

- Desk-card and hero styles are inline in the same file. The Monthly Report bar
  uses `.reporting-output-bar` with `.rob-*` children, styled at
  `index.html:685–686` and **overridden again at `:2165–2166`** with
  `!important`. Any new component near it should not assume one style origin.
- All handlers are inline `onclick` attributes calling global functions
  (`openDesk`, `refreshDesk`, `openOnboardingGap`, `egSignOut`).

### Safest anchored insertion point

**`#myWorkMount` and `#frontDashboard` are the only two empty, id-addressed
mount sections on the page**, and both are already populated by JS rather than
markup. That is the established pattern for adding to this page without
touching hero, grid or report markup.

**Recommendation: mount the Ask Spine composer at `#myWorkMount`** —
above the desk grid, below the hero. Reasons:

1. It is empty in markup and filled by a single function, so the insertion is
   one call site, not a markup edit.
2. It is above the desks, matching "ask, then be taken to the right desk."
3. It leaves the Monthly Report bar and its doubled styling untouched.

`#frontDashboard` sits *below* the Monthly Report bar, which would put the
composer beneath the output panel — the wrong reading order for an entry point.

**Not established:** what `#myWorkMount` currently renders when populated
(`:10668`), and therefore whether Ask Spine would share or displace it. That must
be read before the first line of code.

---

## 2. Existing app plumbing

**This section is the strongest finding in the audit: the plumbing Ask Spine
needs already exists and is well-built.**

### Session storage and transmission

- Token and metadata are held in a **closure-private** pair
  (`index.html:6349`), explicitly *"Never exposed, never returned."*
- Persisted to **`sessionStorage` under `__ps_staff_session__`** as
  `{t: token, m: meta}` (`:6356`). Per-tab; closing the tab ends it.
- Sent as the **`x-staff-session`** header.
- The in-file comment states the discipline plainly: *"The SERVER stays the
  authority — the resolver validates token + live assignment on every call; a
  revoked or expired token just lands back at the gate."* That matches
  `resolveStaffSession`'s per-request assignment join on the API side.
- `sessionMeta()` exposes only `{user_id, property_id}` (`:6376`).

**The browser therefore already reads property scope from the session rather
than choosing it.** Ask Spine must do the same and must not accept a property
from the composer.

> **Cross-lane note, not this lane's work:** which property that session carries
> is the subject of defect 4B in `DB_CONNECTION_INVENTORY.md`. Ask Spine inherits
> whatever scope the session holds. It does not make 4B worse and must not try to
> work around it.

### The authenticated fetch pattern

`createLiveLoader` (`index.html:6335+`) exposes **`loadResource(name, params)`**,
a manifest-driven GET helper:

- **GET-only** — `BAD_METHOD` otherwise (`:6653`).
- **Manifest is the authority** — an unregistered name throws `UNKNOWN_RESOURCE`;
  the comment is explicit: *"the manifest is the authority"* (`:6651`).
- **`policy: 'liveRequired'`** — anything else is refused (`:6652`).
- **No fixture fallback.** A network failure throws `NETWORK` with
  *"(No fixture fallback — live-required resource.)"* (`:6664`).
- `credentials:'omit'`, `redirect:'error'`, `cache:'no-store'` (`:6662`).
- Carries a **request id** and returns `{data, meta:{source:'live', request_id,
  resource, status, origin}}`.

**Typed failure vocabulary already exists** — `ORIGIN_MISSING`,
`ORIGIN_MALFORMED`, `UNKNOWN_RESOURCE`, `BAD_POLICY`, `BAD_METHOD`, `NETWORK`,
`HTTP_<status>`, `MALFORMED`. Ask Spine should reuse it rather than invent
states.

**Consequence: Ask Spine needs no new fetch layer.** It registers a resource in
the manifest and calls `loadResource`. That also means an Ask Spine read is
structurally incapable of fixture fallback, satisfying §19–20 by construction.

### Property context

`authoritative-property-context.js` (app root) owns scope display: `applyScope`,
`applyUnavailable`, `publishScope`, `refreshFromServer`, plus
`ensureAuthoritativeOption` which rewrites the hidden `#propPick` select. The
markup comment at `index.html:4273` is explicit: the hardcoded property options
are **"FALLBACK ONLY — replaced from server on load."**

**`applyUnavailable()` is the existing honest-blank path for scope** and is what
Ask Spine's unavailable state should follow rather than duplicate.

### Loading / empty / unavailable / retry

**Partially established.** The typed error vocabulary above exists and
`applyUnavailable()` exists. **What was not traced:** whether a shared spinner or
retry affordance exists, or whether each surface renders its own. That must be
read before designing the composer's states, and is listed in the gaps.

### How a record is opened today

`openDesk(<key>)` is the one global entry point visible from Property Home, with
keys `management | leasing | maintenance | capital | reporting`. Deeper
navigation (person, unit, task) lives in the door modules —
`person-card-information.js`, `unit-turn-page.js`, `followups-door.js`,
`conversations-board.js`, `turn-scope-door.js`, `unit-triage-door.js`,
`work-acceptance-door.js`, `readiness-door.js`, `moveins-door.js`,
`staff-agent-door.js`.

**Not established:** the exact function signature for "open person X" / "open
unit Y" in each door. **This is the single most important gap for §5**, because
"and can open the underlying item" depends on it entirely.

---

## 3. Existing live data Ask Spine can use — **PARTIAL**

### The significant discovery

**A staff agent surface already exists**, on both sides:

- App: `/operator/staff-agent/message` (`index.html:6845`), plus
  `/operator/staff-agent/proposals/<id>/confirm` (`:6855`) and `/cancel` (`:6860`),
  and an app module `staff-agent-door.js`.
- API: `src/agent/staff_agent.js` — *"THE STAFF AGENT DOOR (BUILD 5) … Same
  authority seam as every maintenance door. **Property is server-derived and
  never accepted from a message body.** Four routes: read the thread, send a
  message (**proposes only**), confirm a proposal (**the ONLY path that reaches a
  canonical service**), cancel one."*

**This materially changes the Ask Spine question.** There is already a
conversational operator surface with the correct authority seam and a
propose-then-confirm discipline. Ask Spine is plausibly a **read-only sibling of
this door, or an extension of it**, rather than a new mechanism.

**The most important open question for the design ruling:** should Ask Spine
extend `staff_agent`, or be a separate read-only surface? Extending inherits a
proven authority seam and an existing intent vocabulary
(`src/agent/staff_agent_intent.js`, `INTENT_PLAIN`); staying separate keeps a
pure read path away from a door whose purpose is proposing writes. **I do not
have enough source read to recommend one, and will not guess.**

### Per-request status

| Request | Established | Not established |
|---|---|---|
| "What needs attention?" | The **facts** exist — see §4. | Whether any route already aggregates them property-scoped. |
| Find/open a person | `person-card-information.js` exists; obligations carry `person_id`. | Whether a person **search** route exists. |
| Find/open a unit | `unit-turn-page.js`, triage/turn-scope/readiness doors exist; obligations carry `unit_id`. | Whether a unit **search** route exists. |
| Find/open a task or obligation | Obligation schema is rich (§4); engine at `src/shared/obligation_engine.js`. | Whether a property-scoped obligation **list** route is exposed to operators. |
| Open the correct desk | `openDesk(key)` with five known keys. | Mapping from an obligation's `module` to a desk key — likely trivial, unverified. |

**Not completed:** a full route inventory of `src/`, and the live-vs-fixture
determination per route. The app's `LIVE_RESOURCES` manifest is the right place
to enumerate what is already live-callable — I read its shape and a sample, not
its full contents.

---

## 4. Priority truth — what a truthful ranking can be built from today

**No AI score is needed, and none should be proposed.** The `obligations` table
(`migrations/001_baseline.sql:~330`) already carries the structured facts:

| Column | Supports |
|---|---|
| `property_id` | **property scoping** — the whole ranking is scoped by this |
| `due_at` *(indexed, `idx_obl_due`)* | **deadlines and overdue** — `due_at < now()` |
| `status` *(indexed, `idx_obl_status`)* | open vs closed |
| `assigned_user_id` **nullable** | **unassigned work** — `is null` is literally the fact |
| `assigned_role` | routing when no user is named |
| `escalates_to_role` / `escalates_to_user_id` | escalation path |
| `module` | `leasing \| maintenance \| accounting \| controls` → desk mapping |
| `type`, `label` | plain description without invention |
| `person_id`, `unit_id` | **the "open the underlying item" link** |
| `related_id` / `related_type` | `work_order \| turnover \| lease \| property_control \| …` |

### The smallest truthful ranking available now

Ordered, each tier derived from a recorded fact with no inference:

```text
1. overdue AND unassigned   due_at < now()  AND assigned_user_id IS NULL
2. overdue                  due_at < now()
3. unassigned               assigned_user_id IS NULL
4. due soonest              ORDER BY due_at ASC (nulls last)
```

Each item can state *why* it ranked using only recorded columns — "overdue since
<date>", "no owner" — which satisfies §5 without a score.

**Deliberately excluded, because source does not yet support them honestly:**

- **Money at risk** — no monetary column on `obligations`. `src/money/` exists;
  the join was not traced. Do not assert a dollar figure without it.
- **Leasing/occupancy blockage** — plausibly derivable via `module='leasing'`
  plus `related_type`, but "blockage" is a judgement not recorded as a fact.
- **Missing proof** — the schema block is headed `STATE + PROOF`; the proof
  columns were **not read**. Likely supportable; unverified.
- **Someone waiting on the property team** — no recorded "waiting" fact was
  found. This would be invention today.

**The honest position: tiers 1–4 are defensible now. Everything else needs
either a traced join or a new recorded fact, and should not appear in a first
slice.**

---

## 5. First build slice — **PARTIAL, pending two answers**

The proposed target — *operator opens Property Home, asks "What needs
attention?", gets a short property-scoped answer from live records, and can open
the item* — is **plausible and probably correct**, and §4 shows a truthful answer
can be produced. **But I cannot responsibly specify it yet**, for two reasons:

1. **The staff-agent question is unresolved** (§3). Whether this is a new
   surface or an extension of an existing, already-authorised conversational
   door changes the files, the request shape and the review.
2. **"Open the underlying item" is unverified** (§2). No door's open-a-record
   signature was traced. That clause is half the value of the slice.

What can be stated now, and should hold regardless:

- **Mount:** `#myWorkMount` (§1), one JS call site, no markup surgery.
- **Transport:** a new `liveRequired` GET entry in `LIVE_RESOURCES` called via
  `loadResource` — no new fetch layer, and fixture fallback structurally
  impossible.
- **Scope:** server-derived from the session; the composer sends **no**
  property id. The API route derives property exactly as `staff_agent.js` does.
- **Honest empty:** "Nothing needs attention right now" only when the query ran
  and returned zero — never as a fallback for a failed call. Failure uses the
  existing typed vocabulary and says the read failed.
- **Deferred:** money-at-risk, blockage, waiting-on-team (§4); any write path;
  any free-text question beyond the one fixed request.

**Recommended next step before implementation:** a bounded follow-up reading
(a) `index.html:10668` — what `#myWorkMount` renders today; (b) the full
`LIVE_RESOURCES` manifest; (c) `staff_agent.js`'s four routes end-to-end; and
(d) one door's open-a-record signature. That closes every gap above and is
perhaps an hour of reading.

---

## What this report does not establish

- Full route inventory of `src/`, and live-vs-fixture per route (§3).
- The complete `LIVE_RESOURCES` manifest contents (§3).
- Any door's open-a-record function signature (§2, §5).
- What `#myWorkMount` renders today (§1, §5).
- Whether shared loading/retry affordances exist (§2).
- Whether obligation proof columns support a "missing proof" tier (§4).
- Whether `src/money/` can be joined for money-at-risk (§4).

**Proof level: Locally exercised** — source inspection of both repositories at
the SHAs above. Nothing was executed, no database contacted, no browser opened.

---

# Phase 2 — the four reads, and the completed §3 and §5

Read at the same SHAs. **This section supersedes §1's mount recommendation and
completes §3 and §5.** Still report-only; nothing implemented.

---

## Read 1 — Staff agent: can it answer read questions today?

### Can it answer grounded read questions? **No.**

`src/agent/staff_agent.js` exposes four routes:

| Route | Method | Purpose |
|---|---|---|
| `/operator/staff-agent/thread` | GET | read the message thread |
| `/operator/staff-agent/message` | POST | capture a message — **proposes only** |
| `/operator/staff-agent/proposals/:id/confirm` | POST | the **only** path reaching a canonical service |
| `/operator/staff-agent/proposals/:id/cancel` | POST | cancel |

**The intent vocabulary is entirely write-shaped.** `staff_agent_intent.js:48`
defines `INTENT`, of which `CONFIRMABLE_INTENTS` are exactly
`initial_triage`, `turn_scope`, `work_completion` — all write proposals mapped to
services (`INTENT_SERVICE:59–64`). The only two non-write intents are:

- **`redirect`** — *"none — this is a redirect to a structured action, not a
  proposal"*
- **`unclear`** — *"none — no service may be called"*

**There is no query, lookup, or read intent.** A question like "what needs
attention?" would classify as `unclear`, and the operator would get *"Spine needs
one more detail."*

### Response types it already returns

From `staff_agent.js:86–133`, `POST /message` returns one of two shapes:

```text
proposal shape   { message, proposal, unit, unit_basis, agent_reply,
                   would_call, nothing_recorded, needs_clarification,
                   clarification_label }
redirect shape   { message, proposal: null, redirect, unit, unit_basis,
                   agent_reply, would_call, nothing_recorded,
                   needs_clarification: false }   ← HTTP 201
```

`agent_reply` is composed **server-side** in plain operating language —
*"the operator never sees a raw intent name"* (`:123–125`).

### Does it return navigation targets? **Partially, and not record links.**

`redirect` carries a `to` field, with exactly four values in source
(`staff_agent_intent.js:279, 297, 319, 423`):

```text
final_readiness · work_item · recorded_item
```

**These name structured actions, not records.** There is no `person_id`,
`unit_id`, `obligation_id` or route in the redirect contract, and no approved way
to return a list of record links. `unit` / `unit_basis` are returned alongside,
but as the message's resolved subject — not as a navigation payload.

### Would Ask Spine reads extend it cleanly? **No — it would overload it.**

Three structural reasons, all from source:

1. **Method mismatch.** Every answer path is `POST` and returns `201 Created`,
   because every message is *recorded*. An Ask Spine read is a `GET` that records
   nothing. Routing a read through `POST /message` would write a message row per
   question.
2. **Intent mismatch.** Adding a read intent means adding to a frozen vocabulary
   whose entire structure is intent → confirmable → service. A read intent is
   never confirmable and calls no service — it would be the first member that
   breaks the type's invariant.
3. **Contract mismatch.** The reply is a single `agent_reply` string plus at most
   one proposal or redirect. Ask Spine returns *a ranked list of records with
   links*. That is a different response type, not a variant of this one.

**Recommendation: read-only sibling.** See §3 below.

---

## Read 2 — The attention read

### The route exists, and Ask Spine must not use it

**`GET /obligations` — `server.js:733–757`.** It is called by the app today
(`index.html:10896`).

What it already does right:

- computes **`is_overdue` at read time** — *"the clock is read-time logic, no
  jobs"* (`:748–752`), a real recorded fact, not a score;
- orders **`due_at asc nulls last, created_at desc`**;
- supports `unclaimed=true` → `assigned_user_id is null and status = 'open'`;
- filters on `status`, `assigned_role`, `assigned_user_id`, `property_id`.

**Why it is disqualified as Ask Spine's source — two defects, both §21:**

1. **It is unauthenticated.** `app.get("/obligations", …)` is a bare route with
   **no `requireOperator`, no session gate, no perimeter**. Every other operator
   route in this audit passes through a gate; this one does not.
2. **Scope is client-supplied.** `property_id` is taken from `req.query` and
   used directly. **Omit it and the route returns obligations across every
   property in the database.**

The app's own call is `/obligations?property_id=${prop()}&status=open`, where
`prop()` is `$('propPick').value` (`index.html:6308`) — **a DOM read**. The
AUTHORITY LOCK (`loadProperties`) does pin that select to
`_egAuthScope.property_id` under a live session and strips other options, so in
practice the value is server-derived. **But the server does not know that** — it
trusts whatever arrives.

### And the app's caller silently fabricates empty

`loadObligations` uses `tryJSON(path, [], …)`, and `tryJSON` is:

```js
async function tryJSON(path, fallback, opts={}, report){
  try{ ... }catch(e){ if(report) report(e); return fallback }
}
```

**A failed obligations call returns `[]` and renders as "nothing to do."** That
is not an honest blank — it is a confident wrong, and it is exactly the failure
mode §5 forbids. Ask Spine must use `loadResource` (`liveRequired`, throws, no
fallback), never `tryJSON`.

### Facts confirmed reliable now

| Fact | Reliable? | Source |
|---|---|---|
| **overdue** | **Yes** | `is_overdue` computed read-time from `due_at` |
| **unassigned** | **Yes** | `assigned_user_id is null`; `unclaimed=true` already implements it |
| **due date** | **Yes** | `due_at`, indexed, already the sort key |
| **status** | **Yes** | `status`, indexed |
| **person** | **Yes, as an id** | `person_id` — resolving to a name is a further read |
| **unit** | **Yes, as an id** | `unit_id` — same caveat |

### Honest-empty and unavailable

- **Server:** no distinction today — an error returns `500 {error}`, and an empty
  result and a filtered-to-nothing result are both `[]`.
- **Client:** `tryJSON` collapses failure into empty (above). `loadResource`
  does not, and `applyUnavailable()` in `authoritative-property-context.js` is the
  existing unavailable path for scope.

**A new endpoint must distinguish "ran and found nothing" from "could not
run."**

### Verdict: **a new endpoint is required.**

Not because the data is missing — it is all there — but because the existing
route is unauthenticated and client-scoped. Ask Spine can **reuse the query
logic** (the `is_overdue` computation, the `unclaimed` predicate, the ordering)
behind an operator-gated, server-scoped route. It cannot reuse the route.

---

## Read 3 — Open-record behavior

**The app already has a canonical contract for persons. Do not invent one.**

| Target | Function | Signature | Identifier |
|---|---|---|---|
| **Person** | `openPersonCard(opts)` (`index.html:16532`) | `opts` object **or** a bare string, normalised to `{person_id, context:'lead', source:'tour'}` | `person_id` |
| **Desk** | `openDesk(name)` (`:10766`) | `async`, hides `#home`, shows `#workspace`, `renderDesk(name,true)`, `syncCrumbLabels()` | `'management' \| 'leasing' \| 'maintenance' \| 'capital' \| 'reporting'` |
| **Obligation → application** | `openApprovalDecision(related_id, label)` | used from the work queue | `related_id` where `related_type==='application'` |
| **Obligation → lease** | `openCountersign(related_id)` | same | `related_id` |
| **Turnover** | `openTurnoverDetail(turnId)` (`:11840`) | | `turnId` |

**`openPersonCard` is the model to follow.** It gates on session and routes live
traffic to one renderer:

```js
if(window.__psLive && window.__psLive.hasSession && window.__psLive.hasSession()){
  return pcOpenLiveRail(opts);
}
// PREVIEW ONLY: … not reachable from the authenticated product path.
```

**Not found:** a general "open unit" entry point. Unit navigation appears to go
through door-specific pages (`unit-turn-page.js`, `turn-scope-door.js`,
`unit-triage-door.js`) rather than one `openUnit(unitId)`. **Recorded as a real
gap** — a first slice should not promise unit navigation it cannot deliver.

**Conclusion: obligations are opened by `related_type` → a specific handler,
keyed on `related_id`.** There is no generic `openRecord(type, id)`, and this
audit does not propose one.

---

## Read 4 — Property Home mounts: **both are occupied**

**This corrects §1.**

| Mount | Renderer | What it holds |
|---|---|---|
| `#myWorkMount` | `renderMyWork()` (`:10666`) | **A persona-preview work queue.** Gated on `previewEmployee()`; when there is no persona it sets `mount.innerHTML=''`, which is why it looks empty in markup. Uses `previewAssignmentsHere()`, `policyFor()`, `previewCanAccess()`. |
| `#frontDashboard` | `renderFrontDashboard(home)` (`:9605`) | **Occupied.** Sets `#frontTitle`/`#frontSub`, renders setup blockers, assigned-role count, and accountability counts. |

**Neither is free.** `#myWorkMount` in particular is not an empty slot — it is
the persona-preview queue, and it already renders overdue/blocked partitioning
and tap-to-open rows. Mounting Ask Spine there would collide with it.

Worth flagging beyond this lane: `renderMyWork` is **persona/preview-driven**
(`previewEmployee`, `previewCanAccess`) yet sits on the signed-in Property Home,
and it reads obligations through the `tryJSON` path above. Whether that
constitutes a §19–20 live-first concern is **not this lane's call** and is
recorded, not asserted.

### The mount Ask Spine should use

**A new sibling section inserted between `.home-hero` and `#myWorkMount`**, with
its own id, populated by its own render function.

- It does not touch the four desk cards or `#deskGrid`.
- It does not touch `#reportingOutputBar` or its doubled `!important` styling
  (`:685–686`, `:2165–2166`).
- It sits above the persona queue and below the hero — the correct reading order
  for an entry point, and the position §1 wanted before establishing the mounts
  were taken.
- It is one `<section>` in markup plus one render call, matching the established
  pattern.

**Confirmed: the first rendering can be inserted without disrupting the four
desks or the Monthly Report.**

---

## §3 completed — firm recommendation

### **Build a read-only sibling. Do not extend the staff agent.**

Grounds, all from source (Read 1):

1. Every staff-agent answer path is `POST`/`201` because it **records a message**;
   Ask Spine is a `GET` that records nothing.
2. `CONFIRMABLE_INTENTS` and `INTENT_SERVICE` make the type
   intent → confirmable → canonical service. A read intent is never confirmable
   and calls no service — it breaks the invariant rather than extending it.
3. The response contract is one `agent_reply` plus at most one proposal or
   redirect. Ask Spine returns a **ranked list of records with open targets** — a
   different type.

**What to copy from it rather than share:** the authority seam. `staff_agent.js`
derives `property_id` from `req.operator` and *"never accept[s] it from a message
body."* The new route must do exactly that. Copy the gate; do not copy the door.

---

## §5 completed — the smallest browser slice

**Confirmed from source, with one deliberate reduction.**

> From Property Home, ask "What needs attention?" → receive **up to five** live,
> property-scoped obligation items → **open the underlying record where an
> existing opener exists.**

The reduction: Read 3 found **no general unit opener**. Promising "open any
underlying record" would over-claim. The slice opens what the app can already
open — person, and the two obligation handlers keyed by `related_type` — and
shows the rest as text without a dead link.

### Exact files

| Repo | File | Change |
|---|---|---|
| api | `server.js` **or** a new `src/agent/ask_spine.js` | register one gated GET route |
| api | new `src/agent/ask_spine_service.js` | the ranked query |
| app | `index.html` | one `<section id="askSpineMount">` after `.home-hero`; one `LIVE_RESOURCES` entry; one `renderAskSpine()`; composer markup + styles |

### Request / response

```text
GET /operator/ask-spine/attention          (x-staff-session; NO property in the request)

200 {
  property_id,                    ← echoed from the session, server-derived
  asked_at,
  items: [ {                      ← max 5
    obligation_id, label, module,
    due_at, is_overdue,
    assigned_user_id,             ← null means unassigned
    reason: "overdue_unassigned" | "overdue" | "unassigned" | "due_soonest",
    person_id, unit_id,
    related_type, related_id,
    open: { kind: "person"|"application"|"lease"|"none", id } | null
  } ],
  total_open                      ← so "5 of 23" is truthful
}
```

**Ranking** — the four tiers from §4, each a recorded fact, no score.

### Existing services reused

- **`GET /obligations`'s query logic** — the read-time `is_overdue`, the
  `unclaimed` predicate, the `due_at asc nulls last` ordering. **The logic, not
  the route.**
- **`staff_agent.js`'s authority gate** — `req.operator.property_id`, never from
  the request.
- **App: `loadResource`** — `liveRequired`, no fixture fallback, request id,
  typed errors. **Not `tryJSON`.**
- **App: `openPersonCard(opts)`**, `openApprovalDecision`, `openCountersign`,
  `openDesk(name)`.

### Honest-empty and failure

| Condition | Behavior |
|---|---|
| Query ran, zero open obligations | *"Nothing is overdue or unassigned right now."* — **only** after a successful read |
| Read failed | *"Could not read the work queue."* + the typed code. **Never rendered as empty.** |
| No live session | existing gate; no Ask Spine call attempted |
| Property scope unavailable | existing `applyUnavailable()` |
| Item has no opener | render the row, no link. **No dead affordance.** |

### Acceptance steps (browser)

1. Sign in; Property Home renders with four desks and the Monthly Report bar
   **unchanged**.
2. Composer appears above the persona queue, below the hero.
3. Ask "What needs attention?" → up to five items, each stating **why** it
   ranked.
4. Every item's property matches the session's property.
5. Click a person-backed item → the canonical Person Card opens via
   `openPersonCard`.
6. Force a failure (offline) → failure message, **not** "nothing needs
   attention."
7. On a property with no open obligations → the honest-empty line.

### Deliberately deferred

Writes of any kind · general free-text AI search (this answers **one** fixed
question) · money prioritisation (§4 — no monetary column traced) · occupancy
blockage, missing proof, waiting-on-team (§4) · unit navigation (Read 3 — no
opener exists) · fixing `GET /obligations`'s missing gate (**real, out of lane —
belongs to a §21 pass**) · anything touching `renderMyWork`.

---

**Proof level: Locally exercised.** Source inspection of both repositories at the
recorded SHAs. Nothing executed, no database contacted, no browser opened.
