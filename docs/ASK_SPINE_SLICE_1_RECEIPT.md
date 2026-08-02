# Ask Spine Slice 1 — proof receipt

**Status: Built and locally exercised. Awaiting real Postgres, canonical
session, authenticated real HTTP, and end-to-end browser proof.**

Base SHAs the branches were cut from:

| Repo | Base | Branch |
|---|---|---|
| `property-spine-api` | `faec54b7e08f57e647402c1685c6fd0517807698` | `claude/ask-spine-slice-1` |
| `property-spine-app` | `30e550b6c8f9b0e88beac426cbac5b6f35a0c37a` | `claude/ask-spine-slice-1` |

---

## Proof ceiling — exact labels

| Evidence | Label | Not claimed |
|---|---|---|
| Service contract, stubbed db (31 assertions, floor 24) | **Locally exercised** | — |
| Express + real router + real socket, stubbed pool (27, floor 26) | **Real HTTP transport exercised** | *not* authenticated live HTTP |
| Chromium + real shipped loader + intercepted network (27, both viewports) | **Browser UI path exercised** | *not* end-to-end browser verified |
| Real Postgres, real session resolution, real SQL rows | **Not yet exercised** | — |

**The slice is NOT Proven.** Per §33 that requires real Postgres, real HTTP and
actual browser observation against a running API.

---

## Property-input receipt

Verifying that no unauthorized property or entitlement input exists anywhere in
the new route or service. Run against
`src/agent/ask_spine.js` and `src/agent/ask_spine_service.js`:

| Check | Result |
|---|---|
| Request-body `property_id` used as scope | **NONE** |
| Query-string `property_id` used as scope | **NONE** |
| Fallback property | **NONE** |
| Default property constant | **NONE** |
| Hardcoded property UUID (`a50fbdd0`, `9e2bb96e`, `971c51ab`) | **NONE** |
| `allowed_modules` assigned/overwritten anywhere | **NONE** |
| `process.env` read | **NONE** |

`req.query.property_id` and `req.body.property_id` **do** appear — on exactly
one line, `ask_spine.js:42`, inside `refuseClientProperty`. That line reads the
claimed value **solely to reject it** with a 403. It is never passed onward and
never becomes scope.

The only values that reach the service:

```text
ask_spine.js:60   property_id:     req.operator.property_id
ask_spine.js:61   allowed_modules: req.operator.allowed_modules
ask_spine.js:65   property_id:     req.operator.property_id   (echoed in the response)
```

Both are asserted at the source rung (2b, 2c) and over real HTTP (G3–G6, H2, H7).

---

## Qualification and ranking contract

The exact behaviour of `GET /operator/ask-spine/attention`. This is the contract
the UI's scope disclosure refers to.

### Qualification — a row is eligible if and only if ALL hold

| Predicate | Source |
|---|---|
| `property_id = <session property>` | `req.operator.property_id`. Never from the request. |
| `status = 'open'` | closed / resolved obligations never appear |
| `module = ANY(<session allowed_modules>)` | module entitlement is server-derived authority (§21) |

**A missing due date does not disqualify.** An obligation with `due_at IS NULL`
is still eligible and lands in tier 4.

**Zero entitled modules yields an honest empty**, not an error and not
everything: `items: []`, `total_open: 0`, `scope_note: "no_module_entitlement"`.

### Two derived facts, computed read-time

```text
is_overdue     due_at IS NOT NULL AND due_at < now()
is_unassigned  assigned_user_id IS NULL
```

Both are read-time. There is no job, no stored flag, and no clock to drift.

### Ranking — four tiers, then a deterministic tiebreak

```text
tier 1   is_overdue AND is_unassigned      reason: overdue_unassigned
tier 2   is_overdue                        reason: overdue
tier 3   is_unassigned                     reason: unassigned
tier 4   everything else                   reason: due_soonest

then     due_at ASC NULLS LAST
then     id ASC
```

**`id ASC` is a deterministic stability tiebreak, applied only after every
meaningful priority fact has tied. It is not business priority and carries no
product meaning** — a lower id does not mean more important. Its sole purpose is
to prevent planner-order randomness: without it, rows tied on tier and `due_at`
would return in whatever order the planner produced, which is the defect
recorded as 4B in `DB_CONNECTION_INVENTORY.md`. Every ordering here terminates
in a unique column.

**No score exists.** Each `reason` names the recorded fact that placed the item,
so an operator can be told *why* it ranked without a number that means nothing.

### Module entitlement — proven, not merely asserted

Property scope alone is not sufficient. A leasing-only operator must not receive
management, financial, resident-sensitive or maintenance work merely because it
belongs to the same property.

The filter exists in the query (`module = ANY($2::text[])`) and `$2` is
`req.operator.allowed_modules` — never a request value. **Proven over real HTTP**
(`tests/ask_spine_http_proof.js`, assertions M1–M8):

| Scenario | Proven behaviour |
|---|---|
| Session property A + **leasing** entitlement | query bound to `["leasing"]` only; no `management`, `maintenance`, `accounting` or `controls` reaches it |
| Session property A + **broader** entitlement | query widens to exactly the session's modules |
| Client sends `?module=` / `?modules=` / `?allowed_modules=` | **ignored** — entitlement stays the session's; the client cannot add `management` to itself |
| **Zero** entitlement | 200 honest empty, `scope_note: "no_module_entitlement"`, and **no database query is issued at all** |

Row-level filtering against real rows still needs the Postgres rung; what is
proven here is that the correct, session-derived module list reaches the query
and that no client input can alter it.

### Cap

Five, enforced **twice** — `LIMIT 5` in SQL and a `slice(0, MAX_ITEMS)` in the
service. The cap is a contract of the function, so it does not depend on the
query staying correct.

`total_open` counts **the qualification predicate**, not the capped page, so
"3 of 23" is truthful.

### Navigation metadata

First match wins; anything else returns `null`:

| Order | Condition | Emitted |
|---|---|---|
| 1 | `person_id` present | `{kind:"person", id:person_id}` |
| 2 | `related_type = 'application'` and `related_id` present | `{kind:"application", id:related_id}` |
| 3 | `module` maps exactly to a desk — `leasing`, `maintenance`, `management` | `{kind:"desk", id:<desk>}` |
| — | anything else, including `accounting` and `controls` | `null` |

**`unit_id` is returned as context and is never navigation.** No unit opener
exists in the app, and a link that goes nowhere is worse than no link.

### Deliberately not part of the contract

Money impact · missing proof · operational blockage · "someone waiting" · any
inferred urgency. No recorded fact supports them today, so asserting them would
be confident-wrong (§5). They are absent from the query, the response and the UI.

### What a valid empty result means

**"No open obligation currently qualifies as needing attention."**

That is a statement about *this dataset under this contract* — nothing matched
the predicates above. **It is not a statement that the property is healthy**, and
the UI is asserted not to imply one. Work that is not recorded as an open
obligation in an entitled module is outside what Ask Spine can see.

---

## Commands

Each runs independently and exits non-zero on failure.

```bash
# 1. Service contract — 31 assertions, floor 24
cd property-spine-api && npm install
node tests/ask_spine_contract_proof.js

# 2. Real HTTP transport — 19 assertions, floor 18
node tests/ask_spine_http_proof.js

# 3. Browser UI path — 16 assertions
mkdir -p /tmp/pw && cd /tmp/pw && npm install playwright
cd /path/to/property-spine-app
SP=/tmp/pw node ask_spine_browser_proof.browser.js            # desktop
SP=/tmp/pw VP=phone node ask_spine_browser_proof.browser.js  # phone

# 4. Existing app suite — must stay green (17 harnesses, 749 passed)
cd /path/to/property-spine-app
bash run_harnesses.sh > /tmp/suite.txt 2>&1; echo "exit=$?"
#    Redirect, never pipe — the runner warns that a pipeline's exit status is
#    the LAST command's and would hide a red suite.
```

---

## Still required before this can be called Proven

```text
real isolated Postgres
→ real obligations rows across at least two properties
→ real staff session scoped to Property A
→ authenticated Ask Spine HTTP request
→ only Property A obligations returned
→ valid empty tested separately
→ real failure tested separately
→ real browser calls the actual API   (not network interception)
→ underlying supported record opens
```

The database proof must cover, as distinct rows:

1. overdue **assigned** obligation
2. overdue **unassigned** obligation
3. **future** obligation
4. **closed** obligation
5. obligation for **another property**
6. **more than five** eligible obligations
7. **empty** property
8. **revoked or unauthorized** session

---

## Explicit exclusions — none of this is in the branch

The unauthenticated cross-property `GET /obligations` (separate security lane) ·
Slice 9 · S2 login · migrations · global assertion infrastructure · the
preserved dead harness · any `tryJSON` caller · migration 090 · fixture
phone-number cleanup · the staged migration · money prioritisation · writes,
proposals or confirmations · general AI search.

---

## Known dependencies

- **Real session verification.** The session resolver is stubbed in every rung
  run so far. Nothing here proves `resolveStaffSession`'s live assignment join.
- **Real database verification.** No Postgres server exists in the build
  environment (`psql` client only), so the SQL has never executed.
- **Defect 4B.** Which property the session carries is the subject of 4B in
  `DB_CONNECTION_INVENTORY.md`. Ask Spine inherits that scope and does not work
  around it.
