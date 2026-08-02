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
