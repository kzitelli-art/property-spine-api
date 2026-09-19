# `gate_person_ingress` goes green for real — receipt

**2026-09-19 · gate 10/10 (was 8/10) · `tests/e2e/person_create_retired.e2e.js`
21/21 through the real server · parent witness 6/6 · registered in
`verify_all.sh`**

CURRENT_STATE row **162**. Base: `claude/rentroll-grain-refusal-20260918`
@ `6586c5ce`, verified against origin before starting.

---

## The finding: both gate failures were ONE event

The gate reported two things:

```text
FAIL  NO UNDECLARED PATH MINTS A HUMAN     src/baseline/baseline_routes.js
FAIL  the register is still accurate       server.js
```

They are the same write, twice.

```text
BEFORE #141 (c97523d5)
  server.js:484   app.post("/persons", …)
  server.js:545     insert into persons …          ← DECLARED as "server.js"

#141 "server.js organ pattern" extracted server.js lines 291-926 VERBATIM
  → src/baseline/baseline_routes.js

AFTER
  server.js                  no longer writes  → the entry went STALE
  baseline_routes.js         now writes        → and went UNDECLARED
```

The register did not follow the move. And its stated reason for the
`server.js` entry — *"the public intake door's inline resolver, predating the
module split"* — **never described that route at all**. The leasing intake
resolver is `resolveOrCreatePerson` in `leasing_leads.js`, which carries its
own entry and always did. The `server.js` entry was covering
`POST /persons`, a Release-0 baseline primitive, under someone else's name.

---

## What the route actually did

```js
if (!name && !email && !phone) {
  return res.status(400).json({ error: "a person needs at least one of: name, email, phone" });
}
```

**A name alone was the entire bar.** Everything else about it compounded that:

| | |
|---|---|
| auth | shared `OPERATOR_KEY` only — no staff session |
| scope | `property_id` taken from the **body** as authority (§21) |
| identity | its own second implementation of phone normalisation and dedup |
| rule | the direct contradiction of row 156 — no continuity handle, no Person |

---

## The witness — the defect observed, not described

A retirement proof passes trivially against a route that never worked. So the
proof carries a **witness mode** (`PROOF_EXPECT_PERSON_CREATE_OPEN=1`) that
inverts the expectations and runs the same calls against the pre-retirement
handler. Modelled on `PROOF_EXPECT_LEGACY_OPEN` in
`legacy_ingestion_retired.e2e.js`.

```text
PASS PARENT: the open door answers 201
PASS PARENT: a NAME ALONE is accepted
PASS PARENT: it minted a DURABLE PERSON with no continuity handle —
             no phone, no email, no normalised key
PASS PARENT: the tables moved — the retirement proof is not asserting
             a route that never worked
```

The row it minted, read straight back out of the database:

```json
{ "name": "WitnessNameOnly-…", "phone": null, "email": null,
  "primary_phone_e164": null, "lifecycle_status": "lead" }
```

Full output: [`witness_parent.txt`](witness_parent.txt).

---

## Fix 1 — the route is retired, not rewritten

**Zero callers**, measured before closing:

- the path `/persons` appears **nowhere in `property-spine-app`, on any
  remote branch, in any tracked file**
- and nowhere in this repo's `src/`, `server.js`, `tests/`, `tools/`,
  `seeds/`, `docs/` or `.github/` outside the route's own definition

⚠ **Source can prove a consumer exists; it cannot prove one does not.** The
shared operator key is held outside this repo — which is exactly why the path
answers a refusal that **names the replacement** rather than a 404 an external
caller would have to guess at.

It now answers **410**, in the repo's existing tombstone shape
(`src/onboarding/legacy_ingestion_retired.js`):

```json
{
  "code": "person_create_retired",
  "receipt": "Creating a person through this route has been retired. Send an inquiry to POST /leasing/intake, or link a resident who is already on a lease with POST /operator/leases/:leaseId/link-resident. Either way Spine needs a phone or an email — a name on its own does not establish a person. Nothing was changed.",
  "next_action": "use_leasing_intake_or_link_resident"
}
```

**Class 3 (retired-in-place). Removal condition: one full release with zero
calls to this path in the access logs**, then the handler and its block
comment are deleted.

## Fix 2 — the register is narrowed, never widened

- `server.js` entry **removed** — it genuinely no longer writes a person.
- `baseline_routes.js` **not added** — it no longer writes one either.
- **DECLARED 9 → 8 entries. Writers 10 → 9.**

The gate diff is exactly one removed entry plus a comment recording the
history above, so the next reader does not re-add it. **No check was
weakened and the scan scope is unchanged at 680 files.**

---

## Proof — through the real server, not a bare express app

`tests/e2e/person_create_retired.e2e.js`, registered in `verify_all.sh` beside
*legacy ingestion retired*, **inside the real-server block** — so it runs
through the actual `OPERATOR_KEY` gate. *Mounting is not reachability*: a
route can be mounted and still answer "Missing or wrong x-operator-key", and
this repo has been bitten by exactly that.

**21 assertions.** The ones that carry weight:

| assertion | why it is there |
|---|---|
| the runtime sha matches `/operator/build` | a 410 from a stale server on the port proves nothing |
| **410, and specifically not 404** | a 404 leaves an identical digest and means nothing; the distinction *is* the product |
| the receipt names both doors, states the rule, says nothing changed, speaks no machinery | a refusal a caller can act on |
| **five request shapes that used to get 400 / 201 / 404 / 400 / 400 now get the SAME 410** | this is what proves the route stopped parsing and resolving input — a tombstone that still validates is still a door |
| whole-row **md5 digests** of `persons` and `events` unchanged | a count survives an overwrite and a delete-plus-insert; a digest does not |
| keyless → the server's gate refuses **first** | the tombstone is not a new public door |
| `GET /persons` still 200 | the **writer** is retired, not the surface |

Full output: [`run.txt`](run.txt). The sha it names (`7670c685`) is this
commit before the run log was added to it — the source tree is identical;
only this directory's evidence files differ.

### Gate, mutation-confirmed

| mutation | check that went red |
|---|---|
| re-add an `insert into persons` to `baseline_routes.js` | NO UNDECLARED PATH MINTS A HUMAN |
| re-declare `server.js` in DECLARED | the register is still accurate |

---

## Regression, on the owned runtime

Owned proof database at ceiling **200** — 189 migration files, 187 applied, 2
data migrations that legitimately refuse on an empty database
(`087_internal_qa_leasing_coverage`, `110_governed_charge_assessed_per`).
Server booted from this tree on `127.0.0.1:3055`.

```text
person_continuity_handle.db.js        20/20
link_resident.db.js                   42/42
identity_loop_closes.db.js            40/40
extracted_route_bindings.e2e.js       24/24
operator_build_gate.e2e.js              6/6
authority_chain.e2e.js                17/17
gate_person_ingress                   10/10
gate_property_creation_paths          green
gate_current_state                    green (162 rows, no gaps)
```

---

## Found and not fixed

**`GET /persons`, `GET /persons/:id` and `PATCH /persons/:id` have zero
callers too**, by the identical search. They mint nobody — two reads and a
lifecycle edit — so they are outside this gate's question and were left alone.

`PATCH /persons/:id` does move `lifecycle_status` forward with only the shared
key and no property scope: **the same authority shape as the route just
retired**. Retiring it needs a named replacement that does not exist yet, and
a refusal that names no next step is worse product than the route. Someone
should rule on it.

**Not reached:** no browser rung — nothing renders.

## Rules honoured

- **No production data touched** (§46) — every fixture is on an owned,
  disposable proof database.
- **No name matching.** No new identity table.
- **`person_ingress`'s staging rule is untouched** — this slice removes a
  writer, it does not change how ingress resolves.
- **DECLARED was never widened to make the gate pass.**
- The app was not changed, so its suite was not run.
