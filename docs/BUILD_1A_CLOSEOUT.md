# Build 1A — closeout, and a framing correction

**2026-08-10. API `claude/property-spine-registration-365eys` @ `3a66b60` · APP @ `8345684`.**

Closes the authority-containment work. **No new code in this document** — it records a
product framing that changes how the foundation is described, names what the schema
already has, and turns the four outstanding items into an executable run card.

---

## 1. The framing correction

> **Spine onboards a DEAL, not a property.**
>
> Deal name → property address(es) → rent roll for each property → Spine fills in the
> physical/property facts it can. The address is the initial anchor: it establishes the
> physical asset and jurisdiction so taxes, licensing, compliance and local rules can
> eventually attach correctly. **A deal may have one property or several.**

Nothing built in 1A contradicts this, and nothing needs rewriting. What changes is the
**description of the foundation**, in one specific way:

```text
WRONG (how Build 0 framed it)     organization → property, and property is where
                                  onboarding starts and economics hang

RIGHT                             DEAL is the onboarding container
                                  PROPERTY is the durable physical asset
                                  ADDRESS is the anchor that fixes asset + jurisdiction
```

Build 0 asked *"what is the one canonical path by which a client, entity and property
become durable Spine truth?"* That question named the wrong container. The answer it
produced — one governed creation path, one governed reassignment, one governed grant —
is still correct and still needed. It is the **physical-asset layer**, and it should be
described that way rather than as the top of the model.

### What this explicitly does not mean

- **Property does not stop being durable.** It remains the physical asset, and the
  identity, authority and history work in 1A-1/1A-2 stands unchanged.
- **Legal entities and capital structure stay out.** They belong to the *next*
  onboarding stage — org charts, loan documents, operating agreements — where Spine
  reads ownership and debt structure from the documents themselves.
- **No second rent-roll path.** The existing session-scoped importer is the one to
  audit and adapt. See §3.

---

## 2. What the schema already has — and the one thing it does not

Build 0 classified `dealintake.js` as one of four property-creation doors and moved on.
Re-read under the correct framing, **the deal concept is already partly built**, and
that materially changes the starting point for the next conversation.

| Already exists | Where |
|---|---|
| `deal_intakes` — a deal, with `onboarding_type` (`new_acquisition` / `existing_asset` / `management_takeover`) | migration 015 |
| `deal_intakes.deal_name` | migration 024 |
| `deal_intake_files` — documents belonging to a deal, each carrying an observed `identity_label`, a `registry_status`, and a resolved `registry_property_id` | migration 015 |
| A door already described in its own header as *"the onboarding front door… Upload what you have. One door."* | `src/onboarding/dealintake.js` |
| `activations.deal_id` — the activation object already anticipated deal scope | migration 040 |

### The gap, stated precisely

**There is no durable statement that a deal contains a property.**

A deal's properties are *inferred* from which of its files happened to resolve —
`deal_intake_files.registry_property_id`. There is no membership table, and
`property_creation_events` (added in 1A-1) records which organisation a property was
created into but **not which deal it came from**. Migration 040 made `deal_id` nullable
with the comment *"V1 may activate a bare property"*, which is the moment the model
quietly settled for property scope.

So: creating a property from a deal today teaches the deal's document identities and
re-resolves its files — but if every file were removed, nothing would still say the
property belonged to that deal.

**This is a finding, not a task.** Building deal→property membership is the next design
conversation's first question, not a loose end to close here. It is recorded so that
conversation starts from what exists rather than re-deriving it.

---

## 3. The rent-roll machinery — audit, do not rebuild

Carried forward from 1A-2 §3a because it is the load-bearing constraint on what comes
next:

| Component | Class |
|---|---|
| `POST /operator/rent-roll/import` + `readLatestSnapshot` | **KEEP / ADAPT — the activation primitive.** Property scope from the staff session, **no client-supplied property id**, dated ledger evidence, and it *"deliberately does not manufacture durable people or canonical leases from names in a report."* |
| `POST /admin/seed-snapshot`, `POST /snapshot/:property/{upload,load}` | Class 3 demo/QA fixture loaders, behind the synthetic-data perimeter |
| fuzzy `LIKE … limit 1` resolution | retired wherever authority or durable identity depended on it |

When a customer's rent roll is the first substantial thing they give us, the activation
flow **adapts the first row**. A second import path would recreate exactly what Build 0
existed to prevent.

---

## 4. Run card for the four outstanding items

**All four require credentials or environment access this session does not have.** They
are operator actions, written to be mechanical rather than closed here.

### C1 · Read the keyless-property population — BEFORE any deploy

```bash
DATABASE_URL="<production>" node tools/identity/count_keyless_properties.js
```

Structurally read-only: it issues `set session characteristics as transaction read only`
before any query, so the server refuses a write regardless of the file's contents. It
reports the count **and what those rows are** — how many have addresses, belong to a
client, carry units or staff (i.e. are real operating properties rather than abandoned
test rows), and whether any already share an address.

**Stop condition:** if the report shows operating properties in that set, decide whether
you want that list surfaced by activation before the backfill stamps them, not after.

### C2 · Re-prove against a production-shaped schema — if one is available

The proofs ran against 121 of 139 migrations (the chain cannot rebuild from empty — a
known, previously documented defect). If a disposable branch of production can be
provisioned:

```bash
HARNESS_DATABASE_URL="<disposable branch>" node tests/property_creation_canonical.db.js
HARNESS_DATABASE_URL="<disposable branch>" node tests/property_creation_http.db.js
HARNESS_DATABASE_URL="<disposable branch>" node tests/authority_mutation_containment.db.js
```

Expect 25 / 17 / 38. If no branch is available, the residual risk is that migrations 150
and 151 add constraints to a table production has been mutating for months; both are
additive, and 150's only data write is the backfill C1 measures.

### C3 · Deploy — app first, then API

```text
1. APP   8345684   sends x-staff-session alongside the operator key.
                   Backward compatible: safe against TODAY'S API, on its own.
2. API   3a66b60   begins requiring it. prestart applies migrations 150 then 151.
```

Reversed, "invite a teammate" returns 401 for the window between the two deploys.

**The app commit can ship independently and immediately** — it is additive to a header
builder and changes no behaviour against the current API. Shipping it now and the API
later removes the coupling entirely, rather than relying on sequencing on the day.

### C4 · Configure the demo/QA environment — with the API deploy

```bash
SYNTHETIC_SEED_ENABLED=true                     # or DEMO_MODE=true
SYNTHETIC_SEED_PROPERTY_IDS=<demo property uuid>[,<uuid>…]
```

On the demo/QA deployment only. Fail-closed by design: until these are set, fixture
seeding refuses and names which limb failed. **Production should have neither.**

### Browser verification — after the API deploy

One pass through the super-admin property wizard on the deployed build: create a
property from a **name alone**, then one with an address, and confirm the address
produces the identity key without asking. Local browser proof
(`property-spine-app/property_creation_experience.browser.js`, 20/20) covers the
behaviour; this closes the deployed rung.

---

## 5. What is closed, and where this stops

**Closed:** one canonical property-creation path; reparenting refused in service and
database; adoption restricted to platform repair with a retirement condition; the
granting actor derived from the session; fuzzy resolution retired from authority paths;
synthetic data confined to configured demo targets. 100 assertions, 0 failures, across
real Postgres, real HTTP and real Chromium.

**Not started, deliberately:** legal entities, capital structure, deal→property
membership, any second import path.

**The next conversation** is the first-run activation flow — deal name, addresses, rent
roll per property, and how the existing importer plugs into it. Not the next adjacent
backend file.
