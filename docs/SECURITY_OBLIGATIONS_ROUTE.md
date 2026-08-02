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
