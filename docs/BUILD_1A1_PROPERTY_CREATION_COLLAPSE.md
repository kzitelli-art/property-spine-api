# Build 1A-1 — Canonical property-creation collapse & authority containment

**2026-08-10. API branch `claude/property-spine-registration-365eys`.**
Follows `docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md`, which measured the state
this slice changes. **No legal-entity schema** — that is Build 1A-2.

---

## 1. What changed, in one paragraph

Four routes created a property and disagreed on identity, hierarchy and
authority. They are now four **callers** of one **writer**. The writer requires a
session-resolved human, requires an organization, derives address-anchored
identity or records why it could not, keeps the best behaviour of each door, and
writes an immutable creation record. The shared `OPERATOR_KEY` is no longer
creation authority anywhere.

```
BEFORE   4 routes → 4 different inserts → orphan properties, bearer-key authority
AFTER    4 routes → resolve an actor → src/identity/property_creation_service.js
```

---

## 2. The authority rule, stated exactly

| Actor | May create? | In which organization? |
|---|---|---|
| no session | **no** | — |
| inactive login | **no** | — |
| `member` | **no** | — |
| `org_admin` | yes | **their own only** — taken from the login, never the body |
| `super_admin` | yes | any, but must **name** one |

It **narrows and never widens**. Before this slice, anyone holding the shared key
could create a property in no organization at all. Every actor who could
legitimately create one through a live surface still can: the deployed app's only
creation caller is the super-admin wizard, measured across `index.html` and every
app module.

Two refusals deserve naming because they did not exist before:

- **`organization_scope_violation`** — an `org_admin` naming a sibling
  organization is refused, not silently redirected. Escape-sideways has to be
  visible when it is *attempted*, or nobody learns it was tried.
- **`identity_belongs_to_another_organization`** — bank intake's canonical-key
  upsert would previously have handed back another client's property row because
  the address matched. The caller would just have received a property id.

---

## 3. What each door contributed, and where it went

The merged path had to keep the **best behaviour of each door, not the average**.

| Door | Contributed | Now |
|---|---|---|
| `owner.js` | alias-hijack refusal; address→key derivation | in the service; protects all four doors |
| `bankintake.js` | canonical-key idempotency | in the service, plus a cross-org refusal |
| `dealintake.js` | teach-on-creation (observed labels → resolved aliases) | in the service; serves all four |
| `super_admin.js` | the organization-bearing hierarchy | now required of every door |

Two duplicate implementations the audit flagged are gone: `deriveCanonicalKey`
lived only in `owner.js`, and the alias normalization beside it was a second copy
of the registry's `norm()`. One implementation each, in the service.

`dealintake` also gained the identity its own rule implied. It refused to proceed
without an address *because* "address is identity", then stored no key derived
from it — the sharpest contradiction Build 0 found. It derives one now.

---

## 4. Migration 150

Numbered 150, not 138: 138/139/140 are Release 0's (unapplied, on
`claude/release-0-rc`) and 142 is claim-accept. A number inside either block
produces two files sharing a number the moment the branches meet — exactly what
`migrate.js`'s duplicate-number guard exists to catch.

**`properties.canonical_key_absent_reason`** — the migration-105 shape reused
rather than reinvented: an identity, or an explained absence, never both and never
neither.

The invariant **repairs on insert and refuses on contradiction**, and that split
is deliberate:

| Case | Behaviour | Why |
|---|---|---|
| neither key nor reason stated | trigger records `identity_not_stated_at_insert` | ~20 harnesses and tools do a bare `insert into properties (name)`. A CHECK alone would turn every one of them red — *a constraint that breaks the proofs is worse than the gap it closes.* The recorded reason is literally true. |
| **both** stated | refused by `ck_properties_identity_or_reason` | a contradiction no default can resolve |

The trigger fires on INSERT only, so an UPDATE introducing the contradiction still
hits the CHECK — which is what makes the rule provable by attacking the row
directly rather than through the service (assertion C3).

Identity is **not** mandatory. The live wizard treats address as optional and
breaking that surface to win a constraint would be the wrong trade. What changed
is that the gap stops being silent: **Build 1B's activation object can read
`canonical_key_absent_reason` as a Missing item instead of inferring it from a
NULL.**

**`property_creation_events`** — immutable history. Both actor identities
(`user_id` is the credential, `person_id` is the human), the authority actually
exercised, which door, and the identity as it stood at creation. No cascade on the
property FK: if a property is ever deleted, the record that it was created must
outlive it. Immutability is a trigger, not a convention — a creation event that
can be edited is a mutable claim wearing the word "event".

---

## 5. Proof

Real Postgres 16.13, real HTTP, real constraints. **42 assertions, 0 failures**,
both harnesses re-runnable against the same database.

```
tests/property_creation_canonical.db.js    25 run · 25 passed · 0 failed
tests/property_creation_http.db.js         17 run · 17 passed · 0 failed
tests/gate_property_creation_paths.js      17 run · 17 passed · 0 failed
```

**The DB harness (the service).** Authority containment A1–A6 including the
sibling-organization refusal and organization-from-login; hierarchy B1–B3
including *no property created through the service has a null organization*;
identity C1–C8 including the database-level contradiction refusal, the
cross-organization idempotency refusal, and that a refused create **leaves nothing
behind**; history D1–D5 including that the event cannot be updated or deleted and
that an idempotent no-op writes no second event.

Every refusal is asserted by its **stable reason key**, never by message text — a
proof that matches on prose passes when the prose is right and the behaviour is
wrong. Every hierarchy assertion **reads the row back**; a returned object can be
right while the write was wrong.

**The HTTP harness (the routes).** The three key-only doors refuse with 401 and
create nothing; a member's real session is refused 403; the live wizard's contract
is unchanged field-for-field and now carries a derived key; each door still
returns its own response shape — owner.js's owner-facing card, bank intake's
idempotency flags, dealintake's alias/file counts.

It builds the **real gate chain** transcribed from `server.js` — the same
allowlist, the same exact-boundary operator-path match, the same fail-closed 503 —
because `THREAD_HANDOFF`'s standing trap is that a harness mounting a bare express
app models a server production does not have. That is how the legal-pages
incident happened. **Honest limit:** it does not boot `server.js` itself, which
opens Twilio, Anthropic and Plaid clients and binds a port. It reproduces the gate
ordering and asserts it rather than assuming it.

**The gate was falsified twice.** An unregistered `insert into properties` in
another `src/` module turns W2 red. Replacing the alias-hijack refusal with a
*comment mentioning it* turns B1 red — the gate strips comments before scanning,
which is this repo's own hard-won lesson ("a mention is not a guard", the
isolation-gate incident) applied to both the writer scan and the behaviour pins.

**No regression on existing harnesses**, measured rather than asserted: a control
database with the identical migration chain **minus 150** scores
`test_identity_bridge.db.js` at 44 run · 43 passed · 1 failed — **identical** to
the database with 150 applied. That one failure is an artifact of the local
bootstrap bypassing the `schema_migrations` ledger, present in both.

Every source-governance gate passes except `gate_harness_isolation.js`, whose
single failure is the same pre-existing Release 0 debt Build 0 recorded (three
Step 4 tools from PR #68 consuming `DATABASE_URL` unregistered). My two harnesses
use `harnessConnectionString()` and do not appear in it.

### What is NOT proven

- **No production database was read or written.** This session holds no production
  credentials and the standing instruction is not to request them.
- **The proof database is not full-schema.** The migration chain cannot rebuild
  from empty — `012_bank_intake.sql` fails on `column "yardi_code" does not
  exist`, a known owned defect (`docs/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md`).
  119 of 137 migrations applied; the 18 that did not are all in the
  bank-transaction, agent and leasing-lead branches, none of which this slice
  touches. Every table and column it *does* touch was verified present with the
  right shape.
- **Not browser verified.** §33 requires browser verification for operator
  workflows. The live wizard's HTTP contract is proven field-for-field, which is
  strong evidence the surface is unaffected — but it is not the same claim.
  **This slice is `Proven`, not `Browser verified`.** The remaining check is one
  pass through the super-admin wizard against a deployed build.
- **Backfill volume is unknown.** How many production rows migration 150 will
  stamp `predates_canonical_identity_requirement` cannot be counted from here. It
  is a single `UPDATE ... WHERE canonical_key IS NULL` with no lock escalation
  beyond the table write, but the row count should be read before the deploy.

---

## 6. What this slice deliberately did not do

- **No legal-entity schema.** Out of scope by instruction; Build 1A-2.
- **`no076_failclosed_check.js` was not moved out of `src/`.** The audit classified
  it RETIRE-from-`src/` and that stands, but `gate_harness_isolation.js` registers
  it **by path** and is currently red for unrelated Release 0 reasons. Moving it
  now would tangle this slice's evidence with that one's. It stays registered in
  the creation gate, confined to its `__CB_NO076__` prefix (assertion W4).
- **Org membership reassignment is still an in-place overwrite with no history**
  (`POST /admin/organizations/:id/properties`). Build 0 named it; it is a
  *reassignment* path, not a *creation* path, and this slice was scoped to
  creation. It is the first thing Build 1A-2 should close, because
  `property_creation_events.organization_id` now records the organization at
  creation — so a later silent reassignment is at least detectable.
- **`POST /properties/:id/team-invites` still takes `invited_by_user_id` from the
  request body.** Same reasoning: an access-granting path, not a creation path.
  It remains the sharpest §21 inversion in the tree.
- **`snapshot_loader.resolveProperty`'s `LIKE`/`limit 1` fallback is untouched.**
  It is a *resolution* path, not a creation path.

---

## 7. Deploy notes

**Correction (2026-08-10): a deploy does not apply this.** An earlier version of this
line said `prestart` applies 150. It does not — `prestart` runs `migrate.js` in
verify-only mode and *refuses to start* while 150 is pending. Schema release is a
separate, deliberate act; the procedure is `docs/BUILD_1A_CLOSEOUT.md` §C3.

- **Additive.** One new nullable column, one new table, two triggers, one CHECK.
- **One data write:** the backfill explaining pre-existing NULL canonical keys.
  Read the row count first.
- **Idempotent** — applied three times against the proof database with no error.
- **Order matters inside the file** and is already correct: backfill runs *before*
  the CHECK is added, or the constraint would fail on existing rows.
- **Reversibility.** Dropping the CHECK, the triggers and the column returns the
  old shape. What does not come back is the reason text on rows created after the
  deploy — the same "revertible code, not revertible meaning" distinction the
  Release 0 runbook draws per boundary.
- **Watch for:** any *unknown* caller of the three now-session-gated routes. None
  exists in the app or in `tests/`/`tools/`, but Build 0 measured those routes at
  zero coverage, so absence of a caller in this repo is not proof of absence
  everywhere. The failure mode is a loud 401 naming what is missing, not a silent
  wrong answer.
