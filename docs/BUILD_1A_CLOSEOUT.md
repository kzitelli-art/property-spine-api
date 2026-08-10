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

### C3 · Deploy — app first, then API, and **release the schema deliberately**

> **Correction, 2026-08-10, after the first attempt failed in production.** This
> section originally said *"prestart applies migrations 150 then 151"* and, after the
> fifth door, *"same deploy, nothing extra to run."* **Both were false**, and the
> deploy failed exactly as the design intends. `prestart` runs `migrate.js` in
> **verify-only** mode: it applies nothing, and it *refuses to start* while any
> migration in the build is missing from the ledger. This is `docs/THREAD_HANDOFF.md`
> §3 — *"A deploy no longer migrates production — do not undo this"* — which this
> document contradicted by accident.
>
> The failure is quiet from the outside: Render keeps the previous instance live when
> a deploy fails, so the API keeps answering on the **old code and old schema**. The
> only visible symptom was `column "canonical_key_absent_reason" does not exist`.

```text
1. APP   8345684   sends x-staff-session alongside the operator key.
                   Backward compatible: safe against TODAY'S API, on its own.
2. API   merge to main.  The deploy will FAIL at prestart, naming 150, 151, 152
                   as pending. That failure is the gate, not a bug.
3.       RELEASE the schema (below), which applies them and lets the API boot.
```

Reversed (API before app), "invite a teammate" returns 401 for the window between the
two deploys. **The app commit can ship independently and immediately** — it is additive
to a header builder and changes no behaviour against the current API.

#### The release itself

Read the ledger first — the gate exists so a release cannot be run by someone who has
not looked:

```sql
with build as (
  select lpad(g::text, 3, '0') as version from generate_series(1, 137) g where g <> 125
  union all select unnest(array['150','151','152'])
)
select
  (select max(version) from schema_migrations) as ledger_ceiling,
  (select string_agg(b.version, ', ' order by b.version) from build b
     where not exists (select 1 from schema_migrations m where m.version = b.version))
    as pending,
  (select string_agg(m.version, ', ' order by m.version) from schema_migrations m
     where m.version <> '000'                    -- the ledger's own table; untracked
       and not exists (select 1 from build b where b.version = m.version))
    as in_ledger_but_not_in_build;
```

`pending` must read exactly `150, 151, 152`. **If it names anything else, stop** — a
release applies *everything* pending, not just this build's three, and that is a
different blast radius than this document has proven.

Then release, asserting what you just read:

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<the ledger_ceiling you just read> \
EXPECTED_SHA=<the commit Render is deploying> \
  node migrations/migrate.js --apply
```

`EXPECTED_SHA` is required whenever `RENDER_GIT_COMMIT` is set (i.e. on the instance)
and refused if it disagrees. Off-instance it is not required, because there is no
running build to pin.

On Render the same three can be set as service environment variables for one deploy —
`prestart` reads `MIGRATION_RELEASE` from the environment, so the deploy that would
have refused instead performs the release and boots. **Remove `MIGRATION_RELEASE`
immediately afterwards.** Left set, every future deploy silently migrates, which is
the exact property the verify gate exists to prevent.

### C4 · Configure the demo/QA environment — with the API deploy

```bash
SYNTHETIC_SEED_ENABLED=true                     # or DEMO_MODE=true
SYNTHETIC_SEED_PROPERTY_IDS=<demo property uuid>[,<uuid>…]
```

On the demo/QA deployment only. Fail-closed by design: until these are set, fixture
seeding refuses and names which limb failed. **Production should have neither.**

### Browser verification — **CLOSED, 2026-08-10, on the deployed build**

One pass through the super-admin wizard at `property-spine-app.onrender.com`,
signed in as a real super admin, against production. Not a harness — a person
clicking the product.

```text
step 2 · PROPERTIES

  "ZZ TEST 0810"    name only, every other field left blank   → accepted
  "ZZ TEST 0810 B"  + 900 Market St, Philadelphia, PA 19107   → accepted
```

Both landed in the wizard's list without an error, and — the part that matters —
**neither one asked about identity, keys, uniqueness or organizations.** The form
requests a property name and offers an address. Nothing else surfaced.

What the database recorded:

| name | `canonical_key` | `canonical_key_absent_reason` |
|---|---|---|
| `ZZ TEST 0810` | *(null)* | `no_address_supplied_at_creation` |
| `ZZ TEST 0810 B` | `900-MARKET` | *(null)* |

That table is the acceptance criterion satisfied end to end. The user gave only
what they naturally had; where an address was present Spine derived the identity
itself and said nothing; where one was absent it **carried the absence forward as
a stated fact** rather than blocking on schema or inventing a key. §5's honest
blank, in the one place it is visible to a customer.

Local browser proof (`property-spine-app/property_creation_experience.browser.js`,
20/20) covers the same behaviour under Chromium. This closes the deployed rung —
the top of the §33 ladder.

**Test rows left in production**, named `ZZ TEST 0810*` under organization
`ZZ TEST 0810`. Deleting the properties is safe; the matching
`property_creation_events` rows are deliberately no-cascade and will survive, which
is the point of an immutable creation record.

---

## 5. What is closed, and where this stops

**The fifth door is closed.** `POST /properties` in `server.js` — the door Build 0
never saw — is now a caller of the canonical service like the other four. Collapsed
rather than retired: nothing in this repo calls it, but the shared operator key is
held outside the repository and source cannot prove a consumer does not exist. Both
choices break an unknown caller; this one breaks it with a 401 that names what is
missing instead of a dead end. Migration 152 extends the creation-source CHECK, so
source and schema moved together.

Proven over real HTTP against the real `server.js`: the operator key alone is now
refused, a super-admin session with no organization named is refused, a session
plus an organization creates `1100 Vine Street` → `1100-VINE` with both actor
identities and `legacy_properties_route` recorded — and neither refusal left a row
behind.

**Closed:** one canonical property-creation path; reparenting refused in service and
database; adoption restricted to platform repair with a retirement condition; the
granting actor derived from the session; fuzzy resolution retired from authority paths;
synthetic data confined to configured demo targets. 100 assertions, 0 failures, across
real Postgres, real HTTP and real Chromium.

**Live in production, 2026-08-10.** Migrations 150, 151, 152 released; ledger ceiling
`137 → 152`; verify-only mode restored afterwards and confirmed by the next deploy
(`✓ SCHEMA VERIFIED — 139 migrations, all applied`). The CHECK constraint
`ck_properties_identity_or_reason` is present, which is its own proof that the backfill
reached every row — Postgres will not add a constraint existing rows violate. Browser
verified on the deployed build (above). **§33 rung: browser verified.**

One standing query, worth keeping:

```sql
select count(*) from properties
where canonical_key_absent_reason = 'identity_not_stated_at_insert';
```

It must always be `0`. That reason is stamped only by the database trigger, repairing a
bare `INSERT` that went around the canonical service. Non-zero means a sixth door.

**Not started, deliberately:** legal entities, capital structure, deal→property
membership, any second import path.

**The next conversation** is the first-run activation flow — deal name, addresses, rent
roll per property, and how the existing importer plugs into it. Not the next adjacent
backend file.
