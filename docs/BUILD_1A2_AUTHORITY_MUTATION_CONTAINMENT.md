# Build 1A-2 — Authority mutation containment, and the browser rung

**2026-08-10. API branch `claude/property-spine-registration-365eys`.**
Follows `BUILD_1A1_PROPERTY_CREATION_COLLAPSE.md`. **No legal-entity schema** —
that is 1A-3, and it now lands on a hierarchy where creation, reassignment and
access grants each have one governed meaning.

---

## 1. The three containments

1A-1 gave *creation* one meaning. These are the other three ways hierarchy and
authority changed, all of which were ungoverned.

| | Before | After |
|---|---|---|
| **Client ownership** | a bare `UPDATE`, no check, no record | adoption only, recorded; reparenting refused in the service **and** the database |
| **Access grants** | `invited_by_user_id` **from the request body**, defaulting to NULL | derived from the session; the actor must hold authority *at that property* |
| **Fuzzy resolution** | substring match, `order by created_at limit 1`, silent | resolves on identity; **proposes** on recognition; refuses on ambiguity and names every candidate |

### Reparenting is refused, not managed

```
null  →  org      ADOPTION      allowed, recorded
orgA  →  orgB     REPARENTING   refused
org   →  null     ORPHANING     refused
```

A client transfer needs consent, an effective date, and a decision about what the
previous client may still see in historical reporting. None of that exists, and
half-built transfer machinery would look like the feature while getting exactly
those parts wrong. So the answer is a refusal that says why, in words a human can
act on — in `property_hierarchy_service.js` *and* in migration 151's trigger, so
it binds writers that never come through the service.

**Adoption is not silent either.** The one legal transition writes
`property_organization_events` — both actor identities, the authority exercised,
immutable by trigger. Containment that leaves the surviving path unattributable
has moved the problem, not solved it.

**Removal condition** for the refusal: a governed property-transfer service. That
migration is where consent, effective dating and the reporting boundary get
written down. Do not weaken the trigger without them.

### The granting actor

`POST /properties/:id/team-invites` grants module-level access. It took the
property from the URL with only an existence check, and recorded *who granted
access* from `req.body.invited_by_user_id` — defaulting to nobody. §21 exactly
inverted: the browser was deciding.

Now the session is the actor, and the actor must hold authority **at that
property**, by one of three server-read bases: `super_admin`, `org_admin` of the
owning organization, or an active assignment there with `can_manage_roles`.

A body-supplied `invited_by_user_id` is now **ignored rather than rejected** — a
caller sending the right value alongside a valid session should not be punished,
and one sending the wrong value must not be believed. Either way the session wins.

### Recognition proposes; ambiguity does not choose

Two copies of the same fuzzy resolver existed (`snapshot_loader`,
`seed_snapshot`), both `lower(name) like '%x%' … order by created_at limit 1`.
Whatever they returned received an entire rent roll — units, spaces, leases,
persons, dated ledger evidence. The oldest match won, silently.

`property_resolution_service.js` is now the one resolver:

| input | result |
|---|---|
| canonical key | **resolved** |
| registry alias (`confidence='resolved'`) | **resolved** |
| exact name, one row | **resolved** |
| exact name, several | **ambiguous**, all named |
| one text match | **proposed — not resolved** |
| several text matches | **ambiguous**, all named |
| nothing | **unresolved** |

A single text match is deliberately *not* resolved. "Only one match" is a fact
about today's row count, not about identity: the 4125/4233 collision reads as one
match right up until the second building is onboarded, and then it silently starts
meaning the other one.

**Nothing that worked before starts failing:** every live caller
(`seed_endpoint`, `import_rent_roll_truth`, and the two operator routes) already
passes an explicit `targetPropertyId`. The fuzzy path was only ever reached by
`seedOne`.

---

## 2. Found while doing this: an unauthenticated `/admin/` route

**`POST /admin/seed-snapshot/:key?` had no authentication at all**, and it writes
durable leases, persons, units and spaces — to a property chosen by substring
match.

`seed_endpoint.js`'s own header recorded the false belief that caused it:

> *"Admin routes remain available behind the operator-key middleware"*

They were not. `server.js`'s gate **skips** `/admin/*` — *"enforces its own
super-admin session auth"* — which was true when only `super_admin.js` mounted
`/admin/` routes. `seed_endpoint.js` later mounted two there and inherited the
skip while supplying no auth of its own. It was the only file in the tree with
unauthenticated `/admin/` routes; both are now behind a real super-admin session,
and every `/admin/` route in `src/` is guarded (15/15 and 2/2).

This is `THREAD_HANDOFF`'s **"mounting is not reachability"** trap in the opposite
direction. That incident was a route wrongly *closed* by this gate; this was a
route wrongly *open* by it. Same gate, same cause: path allowlisting decided
somewhere other than the route.

Fixing it was in scope — it is the same defect class as pieces 1 and 3, in the
same blast radius, and containing the resolver while leaving an unauthenticated
durable-write route open would have been fixing the smaller half.

---

## 3. The browser rung — and the false pass it started with

**This is the part worth reading.**

The first version of this browser proof **passed 13/13 while the browser was
showing the sign-in screen.**

It read `#saMain.innerText`. When an element is not rendered, `innerText` falls
back to `textContent` — so it cheerfully returned the wizard's markup out of a
hidden container. Every assertion was true about the DOM and false about the user.
**P3 — "no machinery is visible" — was the worst of them: it passed by reading an
element nobody could see.**

That is this repo's own recorded trap in a new costume: *"An empty-state pass is a
true statement about the wrong subject."* It was caught by looking at the
screenshot, which is the entire reason screenshots are part of the ladder.

The harness now makes that failure structurally impossible:

- **G1 refuses to continue** if the sign-in door is showing, and exits 1.
- every text assertion reads `document.body.innerText`, which **is** layout-aware.
- every control is checked with `isVisible()` before it is used.

**Why the app had not entered:** `verifySession()` calls `/operator/me`, an
operator path, and `operatorCors` fails closed unless the page's Origin equals
`OPERATOR_APP_ORIGIN`. From `file://` the Origin is `null`.

**Why the app is not modified:** the live loader is sealed to `PRODUCTION_ORIGIN`
— *"built ONCE with fixed production deps. NO test mode, NO override controls, NO
token injector. Frozen."* That is a security property worth keeping, so
`index.html` stays byte-identical and the **transport** is redirected: the app's
requests to the production origin are rewritten to a local TLS front that adds
`https://` and nothing else. The frozen loader, the session confirm, the wizard,
the fetch and the render are all real, unmodified code paths — and unlike
`ask_spine_browser_proof.browser.js`, what answers them is a real API process over
real Postgres rather than fixture JSON.

### The acceptance criterion, as assertions

| Clause | Assertion | Result |
|---|---|---|
| knows immediately what they are doing | the step names itself: **"2 · Properties"**, field **"Property name \*"** | P1a–c |
| provides only what they naturally have | **name alone** was accepted; no address demanded | P2a–b |
| never exposed to identity/authority machinery | no term from the machinery list, and no raw identifier, on screen | P3a–c |
| Spine infers what it safely can | `1325 N 15th Street` → `1325-15TH`, nothing asked | P4a–b |
| missing is carried, not blocking | the name-only property exists, carrying `no_address_supplied_at_creation` | P5a |

**20 assertions, 0 failures.** Screenshots preserved at
`property-spine-app/docs/screenshots_property_creation/`.

### What the browser found that no other rung could

The duplicate-address refusal said:

> **"A property with this identity may already exist."**

Correct behaviour, unsayable sentence. *Identity* is our word for our machinery,
and someone who has just typed an address has no idea what it means — with no next
step offered. The HTTP harness saw `409 property_identity_exists` and called it a
pass, because from JSON it **was** a pass.

It now reads:

> **"There is already a property at that address. Choose the existing one rather
> than adding it twice."**

And the wording is guarded permanently: **P6** deliberately creates a duplicate and
asserts the refusal is plain, carries no machinery term, and names a next step. My
own machinery list had missed it — it contained `canonical_key` but not the bare
word *identity*. **The leak is the word, not the format**; the list now says so.

---

## 4. Proof

Real Postgres 16.13, real HTTP, real Chromium. **89 assertions, 0 failures.**

```
tests/authority_mutation_containment.db.js     27 run · 27 passed · 0 failed
tests/property_creation_canonical.db.js        25 run · 25 passed · 0 failed   (1A-1, re-run)
tests/property_creation_http.db.js             17 run · 17 passed · 0 failed   (1A-1, re-run)
property-spine-app/property_creation_experience.browser.js
                                               20 run · 20 passed · 0 failed
```

The containment harness proves reparenting refused **by the service and
independently by the database** (attacked with a bare `UPDATE`, the way a script
or a psql session would), that a forged `invited_by_user_id` is ignored, that all
three grant bases work and a plain assignment does not, that one text match is
proposed rather than resolved, that the loader **refuses rather than importing on
a guess**, and that the seed route is no longer reachable unauthenticated.

Every source-governance gate passes except `gate_harness_isolation.js`, whose
single failure is still the same pre-existing Release 0 debt.

### What is NOT proven

- **No production database was read or written.** No credentials in this session.
- **Not deployed.** The browser proof ran against a **local** API and a local
  Postgres, not the Render deployment. That is a real step up from HTTP-contract
  proof and it is *not* the same as verifying the deployed build. The remaining
  check is one pass through the wizard on the deployed stack after this merges.
- **Partial schema**, as in 1A-1: 121/139 migrations; the 18 that fail are in the
  bank-transaction, agent and leasing-lead branches, none of which this touches.
- **The browser proof is not on the standard path** — it needs Playwright and
  Chromium, which the repo does not depend on. Same convention as the existing
  `*.browser.js` harnesses. Run it explicitly; the command is in its header.

---

## 5. Named, not fixed

Each of these is real, and each is deliberately outside this slice.

**`gate_harness_isolation.js` detects far less than it reports.** Its `CONNECTS`
regex only matches `connectionString: process.env.DATABASE_URL` or the env var
inside a `new Pool/Client({...})` literal. A file that assigns
`const url = process.env.DATABASE_URL` first is invisible to it. **37 files
currently evade it**, including `tools/ledger_reconcile.js` and
`tools/property_line_preflight.js` — which are in its own `PRODUCTION_APPROVED`
list, meaning those entries never classify anything. Not touched here: widening
detection while the gate is red for Release 0 reasons would tangle two slices'
evidence. `tools/identity/count_keyless_properties.js` is registered anyway, so it
is already correct when the gate is fixed.

**Four demo-building lookups still take the oldest exact-name match**
(`operator.js:186`, `leasing/demo_reset.js:80`, `leasing/leasingleads.js:898`,
`leasing/demo_preflight.js:106`). Exact name on a fixed constant is much stronger
than substring, and these are demo/QA paths — but two of them mutate demo data. A
five-call-site sweep across leasing and operator surfaces is its own slice.

**The wizard offers no link-to-existing path.** The refusal now tells the user
what to do; it does not let them do it. `owner.js`'s door was praised in the audit
precisely because it hands back the link-existing path, and the wizard has no
equivalent. That is app UX work, and it is the natural companion to Build 1B's
"Property identity needs confirmation".

**`no076_failclosed_check.js` is still in `src/`** — unchanged from 1A-1, same
reason.

---

## 6. Deploy notes

Migrations **150 and 151**, in that order. Both additive; `prestart` applies them.

- **Read the keyless population first.** `tools/identity/count_keyless_properties.js`
  against production, before the deploy. It is structurally read-only — it issues
  `set session characteristics as transaction read only` before any query, so the
  server refuses a write regardless of the file's contents. It reports the count
  **and what those rows are**: how many have addresses, how many belong to a
  client, how many carry units or staff (i.e. are real operating properties), and
  whether any already share an address. Do not run the backfill until that has
  been read.
- 151 is pure DDL — no data changes.
- Both idempotent; 150 was applied three times against the proof database.
- **The reparenting trigger is the one behaviour change with a blast radius.** Any
  existing script that moves a property between organizations will now fail loudly.
  Nothing in `src/` does, after this change.
- **Watch for** unknown callers of `POST /admin/seed-snapshot` — it now requires a
  super-admin session. Nothing in the app or the repo calls it, but it was
  unauthenticated, so absence of a caller here is not proof of absence everywhere.
  The failure mode is a 401 naming what is missing.
