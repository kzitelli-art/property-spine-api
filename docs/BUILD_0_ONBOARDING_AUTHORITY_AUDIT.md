# Build 0 — Existing Onboarding Authority Audit

**Read-only audit. 2026-08-10. API branch `claude/property-spine-registration-365eys`, base `aac806b`.**

This is the gate in front of Property Activation: *no new activation code begins
until the current client/property creation architecture is understood.* It
answers one question and classifies every component that bears on it.

Nothing in this audit changes product behaviour. The only executable artifact is
`tests/gate_property_creation_paths.js`, which pins the measured state so Build 1
has to change it deliberately rather than accidentally.

---

> ## ⚠ FRAMING CORRECTED 2026-08-10 — read this first
>
> **Spine onboards a DEAL, not a property.** This audit asked *"what is the one
> canonical path by which a client, entity and property become durable Spine
> truth?"* — and that question named the wrong container.
>
> The **measurements below are unchanged and still correct**: four creation doors,
> disagreeing on identity, hierarchy and authority. What changes is what layer they
> describe. This is the **physical-asset layer**, not the top of the model.
>
> ```text
> DEAL      the onboarding container (a deal may hold one property or several)
> PROPERTY  the durable physical asset  ← everything in this audit
> ADDRESS   the anchor that fixes the asset and its jurisdiction
> ```
>
> The audit also under-read what already exists: `deal_intakes`, `deal_name`,
> `deal_intake_files` and `activations.deal_id` are all present. See
> `BUILD_1A_CLOSEOUT.md` §2 — including the one thing that is genuinely missing,
> which is any durable statement that a deal *contains* a property.

## 1. The question, and the measured answer

> **What is the one canonical path by which a client, entity and property become
> durable Spine truth?**

**There is no such path.** The measured answer, per level:

| Level | Doors that create it | Canonical path exists? |
|---|---|---|
| Client (`organizations`) | **1** | Yes — `POST /admin/organizations` |
| **Legal entity** | **0** | **The concept does not exist in the schema.** |
| Property (`properties`) | **4 routes + 1 non-route script** | **No.** |

The four property doors do not agree on identity, hierarchy, or authority. Three
of the four create a property that belongs to no client. Two of the four set no
address-anchored identity at all. Only one of the four requires an authenticated
human; the other three accept a shared static bearer secret.

This is the finding that orders Build 1. **Build 1A cannot hang entity and client
scope off a hierarchy whose top level is NULL for three of its four creation
doors.** Collapsing the doors is not deferred cleanup — it is the precondition.

---

## 2. The four property-creation doors

Measured from source. Line numbers are on the audited base.

### A · `POST /admin/organizations/:id/properties/new` — `src/identity/super_admin.js:249`

| | |
|---|---|
| **Authority** | Staff session → `users.platform_role = 'super_admin'`. Server-derived. |
| **Hierarchy** | **Sets `organization_id`.** 404s if the org does not exist. |
| **Identity** | No `canonical_key`. No alias taught. |
| **Columns** | `name, display_name, address, city, state, zip, property_type, planned_unit_count, organization_id` |
| **Class** | **KEEP.** The only door that establishes hierarchy, and the only one behind a real actor. |

The nearest thing to a canonical path. Its authority model is right and its
hierarchy handling is right; its identity handling is the weakest of the four.

### B · `POST /bank/onboard-property` — `src/money/bankintake.js:95`

| | |
|---|---|
| **Authority** | `x-operator-key` — a **shared static secret**, not an actor. |
| **Hierarchy** | None. `organization_id` is NULL. |
| **Identity** | Requires `canonical_key`; `on conflict (canonical_key) do update` — idempotent upsert. |
| **Columns** | `name, address, canonical_key` |
| **Class** | **ADAPT.** Its address-anchored identity discipline is the behaviour Build 1 wants; its authority model and orphan hierarchy are not. |

### C · `POST /owner/properties/create-from-upload` — `src/surfaces/owner.js:732`

| | |
|---|---|
| **Authority** | `x-operator-key` — shared static secret. |
| **Hierarchy** | None. `organization_id` is NULL. |
| **Identity** | Derives `canonical_key` from the address (conservative, may be NULL). Catches `23505` and returns `409 exists_maybe` with a link-existing path instead of duplicating. |
| **Alias behaviour** | **Refuses to hijack** a string already resolved to a different property — checks inside the transaction and rolls the whole create back with `409 alias_conflict`. |
| **Class** | **ADAPT.** The alias-hijack refusal is the best identity behaviour of the four and must survive the collapse. |

### D · `POST /deal-intakes/:id/create-property` — `src/onboarding/dealintake.js:535`

| | |
|---|---|
| **Authority** | `x-operator-key` — shared static secret. |
| **Hierarchy** | None. `organization_id` is NULL. |
| **Identity** | **No `canonical_key`** — despite refusing to proceed without an address ("address is identity"). |
| **Alias behaviour** | Teaches every observed `identity_label` from the deal's files as a `resolved` alias, then re-resolves the files. |
| **Class** | **ADAPT.** The teach-on-creation behaviour is exactly what Build 2's Share → Recognize → Confirm loop needs. Its identity gap is the sharpest contradiction in the set: it demands an address *because* address is identity, then stores no canonical key derived from it. |

### E · `src/shared/no076_failclosed_check.js:40` — not a route

A standalone migration-matrix proof script that lives in the product tree and can
insert a real `properties` row against whatever `DATABASE_URL` names. Confined to
a `__CB_NO076__` prefix, and already registered as an unguarded write-capable
consumer by `gate_harness_isolation.js`. Nothing in the product imports it.

**Class: RETIRE from `src/`.** Removal condition: relocate under `tests/` with the
other migration-matrix proofs. It is a harness misfiled into the product tree, not
a fifth authority path — but it is registered rather than ignored, because an
unregistered exception is indistinguishable from an oversight.

### The divergences, stated plainly

1. **Hierarchy is optional at creation.** 1 of 4 doors attaches a client. Three
   mint an orphan. `properties.organization_id` is nullable by design (migration
   093: *"nullable — existing properties get org assigned after provisioning, not
   force-broken now"*), and three doors have been taking that exit ever since.
2. **Identity protection is per-door, not per-object.** `uq_properties_canonical_key`
   (migration 011) is a plain `UNIQUE`, so NULLs never collide. The two doors that
   leave the key NULL get **no duplicate protection from it at all** — two
   properties at the same address created through A or D collide with nothing.
3. **Authority is a bearer secret on 3 of 4 doors.** `OPERATOR_KEY` identifies no
   human, belongs to no organization, and produces no attributable actor. The
   creation of durable Spine truth is currently attributable to a header value.
4. **None of the four is exercised anywhere.** Zero harnesses, zero tools, zero
   browser proofs. On the §33 proof ladder the highest-authority write in the
   product does not reach *"locally exercised."*

---

## 3. The client level — `organizations`

One creation door (`POST /admin/organizations`, super-admin only) and one
assignment door. **KEEP both;** the client level is already singular.

But the assignment door has a governance gap Build 1A must close:

**`POST /admin/organizations/:id/properties` — `src/identity/super_admin.js:209`**

```sql
update properties set organization_id = $1, updated_at = now() where id = $2
```

It does not check whether the property already belongs to a **different**
organization, and it writes **no history**. Moving a building from one client to
another is a silent in-place overwrite with no record that it happened.

The discipline for exactly this already exists elsewhere in the codebase —
`authority_resolution.js` check 6, `no_silent_overwrite`: *"Changing it is a
separate, explicit decision — it is not folded into this one."* It was never
applied to org membership.

### The user doors, for completeness

Three doors create logins: `super_admin.js` and `org_admin.js` (both set
`organization_id`), and `teamaccess.js` invite-accept (**does not**). The
teamaccess branch fires when no `users` row exists for the invited phone, and
produces a login with `organization_id = NULL` and no `platform_role` — which
`org_admin.js` then correctly refuses (*"Your account is not linked to an
organization"*). Honest refusal, but the orphan login is still created.

**`POST /properties/:id/team-invites` — `src/identity/teamaccess.js:95` — ADAPT, urgently.**
This grants module-level access to a property, and:

- authority is the shared `OPERATOR_KEY`;
- the property comes from the URL and is checked only for **existence**;
- `allowed_modules` and `can_manage_roles` come straight from the request body;
- **`invited_by_user_id` comes from the request body** — `b.invited_by_user_id || null`.

That last one is a direct §21 inversion: the record of *who granted access* is
supplied by the caller and defaults to nobody. Build 1A's authority work should
treat this route as in scope, not adjacent to it.

---

## 4. There is no legal entity

Searched: `entities`, `legal_entities`, `ownership`, `borrower`, `landlord`,
`vesting`, `portfolio`, `companies`. **No table models a legal entity.** The
hierarchy today is two levels:

```
organizations  (the customer)
      └── properties  (organization_id, NULLABLE)
```

Every standing financial fact in the codebase hangs off `property_id`, usually
`not null` with `on delete cascade`.

This is the schema half of Build 1A, and it is genuinely additive — there is no
existing entity model to migrate, reconcile, or collapse. The handoff's examples
map onto the gap directly: a mortgage needs a borrower entity plus a collateral
property; a bank account needs an owning entity plus a property relationship;
neither can be said today without lying about the scope.

**Scope discipline for Build 1A:** build the hierarchy the named facts need — tax
(property), mortgage (entity + property), bank account (entity + property
relationship), insurance (entity/property/portfolio), management agreement (org +
properties). Do not model general corporate structure.

---

## 5. The authority seam Build 1A must extend

This is the load-bearing runtime seam. It is disciplined, and it is
**exclusively property-scoped.**

### `resolveActorContext(pool, { user_id, property_id })` — `src/identity/actor_context.js`

Described in its own header as "THE canonical path" for resolving the acting
human. It is genuinely good: fails closed on every error path, separates
credential (`users`) from human (`persons`), never matches on display name, and
loads cross-property authority **not at all** rather than filtering it out
afterwards ("there is no object in memory that could leak into a decision").

It has **no organization concept**. `property_id` is required; absent, it returns
`deny("no_property_context")`. Every capability it resolves is property-scoped.

### `resolveStaffSession(db, token)` — `src/identity/staff_session_service.js`

The one live authority read. Its resolver SQL **joins `property_team_assignments`**,
so a staff session is bound to exactly one property and cannot exist without an
active assignment at that property. Entitlement is re-verified on every request.

**Consequence, documented in the code itself:** *"Super admin sessions are
property-scoped like all staff sessions (the session resolver requires a property
assignment), so super admins still need a property assignment for their session
token."* There is no such thing as an organization-level session today.

### Where org authority actually lives

`users.organization_id` and `users.platform_role` — **two plain columns on the
login row**. `org_admin.js` reads them, then scopes every query by `req.orgId`.
It does re-check ownership on writes (`where property_id = $1 and organization_id = $2`),
which is correct.

But the authority itself has none of the discipline the property level has:

| | Property authority | Org authority |
|---|---|---|
| Stored as | `assignments` / `property_team_assignments` rows | a column on `users` |
| Effective dating | yes (grants) | none |
| Provenance / reviewer / reason | yes (`authority_resolution.js`) | none |
| Supersession history | yes | none |
| Re-verified per request | yes | re-read per request, but ungoverned |

**Two parallel authority tables already exist** and must not become three:
`property_team_assignments` (session/module authority, keyed to `user_id`) and
`assignments` (person/pricing-verb authority, keyed to `person_id`).

### What Build 1A's proof obligations map onto

The handoff requires proving that "property-only authorization cannot escape
upward or sideways." Today the sideways wall is strong: `resolveActorContext`
never loads another property's rows, and `org_admin.js` re-checks org ownership
per property. The **upward** direction is the soft one — org reach is a column on
the login, not a governed grant, so there is no record of who conferred it, when
it took effect, or what it superseded.

---

## 6. Identity — two resolvers, contradictory doctrine

**`src/identity/registry.js` — KEEP. The canonical resolver.**
Its doctrine is explicit: *"Name is not identity… It NEVER guesses — an unmapped
string returns unresolved, not a best-match."* Written against real collisions
("SOLO on Chestnut" means both 4125 and 4233). `identify.js` (KEEP) is its
read-only front door: identify never mutates, confirm writes.

**`src/shared/snapshot_loader.js` `resolveProperty()` — ADAPT.**

```sql
select id from properties
 where lower(name) like '%'||$1||'%' or lower(coalesce(address,'')) like '%'||$1||'%'
 order by created_at limit 1
```

Substring match on name **or** address, then silently take the oldest row. It
tries `canonical_key` first and only falls through on a miss — but the fallback is
precisely the guess `registry.js` exists to refuse, and it selects the import
target for a whole rent roll. Build 1 should route it through the registry.

**`src/onboarding/deal_registry.js` — RETIRE (conditionally).**
A hardcoded JS array of six deals with hardcoded property UUIDs, declaring
*"Leasing model is STORED here, never inferred."* But `properties.leasing_basis`
is a real column (migration 026, default `'unknown'`) that door D writes. So the
leasing model has two homes, one of them a source file. Read by
`src/leasing/leasing_detail.js` and `src/surfaces/property_surface.js`.

Removal condition: once every deal's `canonical_key` and `leasing_basis` are on
the `properties` row, delete the constant and read the column. Note that four of
the six entries carry `property_id: null` — including **Greenery / `1325-N-15`**,
the property named in the handoff's own UX example, and one of the three Build 4
sample properties.

---

## 7. What already exists that Build 1B should ADAPT, not reinvent

The three most valuable findings in this audit. Building parallel machinery for
any of these would violate §17 (one canonical architecture) and §7 (capture once,
read everywhere).

### 7.1 The standing-truth envelope is already implemented — `property_governed_charges` (105–111)

The Build 1B envelope is *source → claim → proof state → confirmation → effective
date → recorded date → current governed read → supersession history*. Migration
105 already carries almost all of it:

| Envelope element | Existing column |
|---|---|
| effective date | `effective_from` / `effective_until` |
| recorded date | `created_at` |
| source | `source_provenance` (`not null`) |
| human confirmation | `published_by_person_id` + `published_at` |
| current governed read | `record_state` (`draft`/`active`/`superseded`/`retired`) |
| supersession | `supersedes_charge_id` |
| authority exercised | `authority_basis` jsonb, and `governed_charge_rulings.authority_exercised` |
| **honest blank** | `amount` **XOR** `amount_unresolved_reason`, enforced by CHECK |

That last constraint is the handoff's doctrine already compiled into the database:
*"An amount is a number OR an explained absence. Never both, never neither."*

**What it lacks for Build 1B — exactly two things:**

1. **An explicit proof state.** `source_provenance` is free text. There is no
   column that distinguishes *declared* from *proven*, and no pointer to the
   governing instrument that would make it proven. This is the whole PNC ••••4812
   example: declared purpose and governed restriction must never collapse.
2. **Scope above the property.** `property_id uuid not null … on delete cascade`.
   The envelope cannot currently say "this fact belongs to the borrower entity."

**Recommendation:** Build 1B generalizes this envelope — add proof state and
governed-source reference, widen scope to (client, entity, property) — rather than
authoring a second one beside it.

### 7.2 The claim layer already exists — `proposed_records` (040)

`activation.js` states the doctrine: *"`proposed_records` IS the claim layer (no
generic claims table exists)."* It already carries `payload_json`,
`normalized_json`, `evidence_refs` (lineage), `confidence`, and a claim lifecycle
of `staged / needs_review / blocked / confirmed / promoted / rejected /
conflicted`. `module` is already generalized beyond leasing
(`leasing/maintenance/reporting/management/capital`); `target_type` is `'lease'`
in V1.

**Build 2's Share → Recognize → Confirm loop for Taxes and Bank Accounts is a new
`target_type` on this table, not a new table.** The `needs_review`/`blocked`
states are already the "honest blank" the handoff asks for.

### 7.3 "Exposure" is already a defined, owned word — `src/money/exposure.js`

*"THE SECOND SCOREBOARD."* It aggregates gross-unproven exposure across proof
rungs (deposits 009, ledgers 010, bank intake 012) and its header says it is
"built to absorb future rungs… as new sources." Its locked board rule —
*"headline = GROSS, never net. Offsetting errors must not read clean"* — is the
same rule Activation Exposure needs.

**Activation Exposure should be a new source rung inside this module, not a second
scoreboard.** Two independently-computed "exposure" headlines on one property is
the confident-wrong failure the doctrine forbids.

Note the handoff's pricing rule is genuinely new and must be added here: *price
Exposure from the **highest credible available basis** and name the basis used* —
including surfacing disagreement between credible sources rather than choosing the
cleaner number.

---

## 8. Name collisions to resolve before writing Build 1B code

Three words are already taken, with different meanings. Each is a silent-defect
risk, not a style question.

| Word | Existing meaning | Build 1B meaning |
|---|---|---|
| `activations` (table, 040) | one **import run** — `deal_id`, `source_label`, `open`/`activated`/`abandoned` | the property's **standing lifecycle** — `SETTING UP` / `OPERATING — OPEN SETUP` / `FULLY ACTIVATED` |
| "activated property" (`activation_perimeter.js`) | membership of the `ACTIVATION_PROPERTY_IDS` **env-var allowlist** | `FULLY ACTIVATED` per the frozen gate |
| "exposure" (`exposure.js`) | gross unproven **money** exposure | unresolved **setup** economic significance |

The second one is not a collision so much as a scheduled hand-off, and the code
already says so:

```js
// Class-2 CONFIG source: explicit comma-separated allowlist of activated
// property UUIDs. Absent/empty/malformed = NO property activated (fail closed).
//  the config source changes when durable property-activation lands.
```

**`activation_perimeter.js` is Class 2 with its removal condition already written,
and the Property Activation Object is what satisfies it.** Build 1B should retire
the env var in the same slice that lands the durable record — otherwise there are
two answers to "is this property activated," which is §17's exact failure mode.

The Property Activation Object needs a distinct name from `activations`.

---

## 9. Full classification

| Component | Class | Note / removal condition |
|---|---|---|
| `identity/super_admin.js` (org + property create) | **KEEP** | The canonical path Build 1A extends. |
| `identity/org_admin.js` | **KEEP** | Scoping is correct; the authority it reads is not governed. |
| `identity/actor_context.js` | **KEEP / EXTEND** | Extend to entity + client scope. Do not fork. |
| `identity/staff_session_service.js` | **KEEP / EXTEND** | Property-bound by construction. Build 1A must decide whether an org-scoped session exists at all. |
| `identity/authority_resolution.js` | **KEEP** | The nine-check discipline is the model for org/entity grants. |
| `identity/registry.js` · `identify.js` | **KEEP** | The canonical identity anchor. Everything else should route through it. |
| `identity/activation_perimeter.js` | **DORMANT (Class 2)** | Env-var allowlist. Removal condition already written in-file: retire when durable property-activation lands. |
| `identity/teamaccess.js` `POST /properties/:id/team-invites` | **ADAPT** | Body-supplied `invited_by_user_id`; OPERATOR_KEY authority. §21 inversion. |
| `money/bankintake.js` `POST /bank/onboard-property` | **ADAPT** | Keep the canonical-key upsert; move behind a real actor + org. |
| `surfaces/owner.js` `POST /owner/properties/create-from-upload` | **ADAPT** | Keep the alias-hijack refusal verbatim. |
| `onboarding/dealintake.js` `POST /deal-intakes/:id/create-property` | **ADAPT** | Keep alias-teaching; add canonical key + org. |
| `onboarding/deal_registry.js` | **RETIRE** | Hardcoded six-deal constant. Remove once `canonical_key` + `leasing_basis` are on the rows. |
| `shared/snapshot_loader.js` `resolveProperty()` | **ADAPT** | Replace the `LIKE`/`limit 1` fallback with the registry. |
| `shared/no076_failclosed_check.js` | **RETIRE from `src/`** | Harness misfiled into the product tree; relocate under `tests/`. |
| `money/exposure.js` | **KEEP / EXTEND** | Activation Exposure is a new rung here, not a second scoreboard. |
| `proposed_records` + `activation.js` | **KEEP / EXTEND** | The claim layer. Build 2 adds `target_type`s. |
| `property_governed_charges` (105–111) | **KEEP / GENERALIZE** | The envelope. Add proof state + scope. |
| `onboarding/onboarding.js` (deposit reconciliation) | **KEEP** | Prepare → prove → approve. Unrelated to creation authority. |
| `onboarding/onboarding_funnel.js` | **KEEP** | Read-only six-step projection. Renders all, populates earned. |
| `onboarding/intake.js` · `public_review.js` | **KEEP** | Field capture / public review. Create no properties. |

---

## 10. What Build 1 must collapse — the mandate

In priority order, derived from the measurements above:

1. **One property-creation service.** All four routes become callers of a single
   canonical write that requires: an authenticated actor, an organization (or an
   explicit governed reason there is none), and an address-anchored identity.
   The gate's register is the checklist; it turns red when a door disappears,
   which is the signal to record the collapse here.
2. **Preserve the best behaviour of each door, not the average.** Specifically:
   owner.js's alias-hijack refusal, bankintake's canonical-key upsert, and
   dealintake's teach-on-creation. A merged path that loses any of these is a
   regression even though it removes doors.
3. **Retire `OPERATOR_KEY` as creation authority.** A shared secret cannot be an
   actor, and §21 requires the server to decide.
4. **Make org membership governed** — no silent reassignment, and a history row.
5. **Then, and only then, add the entity level** and extend `actor_context` /
   `staff_session_service` to resolve at three scopes.

---

## 11. Proof state of this audit

Honest about its own ladder position (§33).

**What is proven:** every claim about *source* — the four doors, their column
lists, their authority checks, the absence of an entity table, the absence of test
coverage, the two identity resolvers, the envelope columns. All read from the
files on the audited base and pinned by a gate that was falsified twice (an
unregistered `insert into properties` turns S2 red; a register entry that
misdescribes its own source turns D3 red).

**What is NOT proven, and must not be asserted:**

- **No database was read.** This session holds no production credentials, and the
  handoff's standing instruction is that they are not to be requested. So: how
  many production properties actually carry `organization_id`, whether any door
  besides A has ever been used, and whether duplicate properties already exist are
  **open questions**. They are answerable read-only when someone with credentials
  runs the check, and Build 1A should answer them before migrating anything.
- **No HTTP, no browser.** Nothing here reached "Proven" or "Browser verified."
  This is an audit; the ladder applies to the builds that follow it.

**Pre-existing red, unrelated to this work:** `npm run verify` currently fails at
its *first* gate, `gate_harness_isolation.js` — three Step 4 tools merged in PR #68
(`tools/release0/where_are_we.js`, `tools/step4/preflight.js`,
`tools/step4/prove_completion.js`) consume `DATABASE_URL` directly without a
register entry. The runner preserves the first non-zero exit and reports the
remaining gates as NOT RUN, so **`gate_property_creation_paths.js` will not run on
the standard path until that is resolved.** It passes 11/11 when invoked directly:

```
node tests/gate_property_creation_paths.js     → 11 run · 11 passed · 0 failed
```

Resolving the isolation debt is a Release 0 decision about those three tools'
production-facing status, not a Build 0 one, so this audit records it rather than
fixing it.

---

## 12. The gate

`tests/gate_property_creation_paths.js` · DB-free · on the standard path in
`tests/verify_source_governance.js`.

| | |
|---|---|
| **S1** | the scan found creation sites at all (a broken scan would pass anything) |
| **S2** | no unregistered property-creation path exists in `src/` |
| **S2b** | the non-route creator stays confined to its `__CB_NO076__` prefix |
| **S3** | no unregistered organization-creation path exists in `src/` |
| **S4** | the register names no file that has stopped creating |
| **D1** | exactly ONE path attaches an organization |
| **D2** | exactly TWO paths set `canonical_key` |
| **D3** | the register describes each path the way the source actually behaves |
| **D4** | reassigning a property to another org writes no history |
| **C1** | zero creation routes are exercised by any harness or tool |

D1–D4 and C1 are **pins, not endorsements.** They record what Build 0 found. Each
turns red the moment it stops being true — which is exactly when a human should be
reading this document instead of trusting a green suite. **Fixing a divergence is
supposed to break the gate;** the fix is to update the register and this audit in
the same commit, deliberately.
