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
| Express + real router + real socket, stubbed pool (19, floor 18) | **Real HTTP transport exercised** | *not* authenticated live HTTP |
| Chromium + real shipped loader + intercepted network (16) | **Browser UI path exercised** | *not* end-to-end browser verified |
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
SP=/tmp/pw node ask_spine_browser_proof.browser.js

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
