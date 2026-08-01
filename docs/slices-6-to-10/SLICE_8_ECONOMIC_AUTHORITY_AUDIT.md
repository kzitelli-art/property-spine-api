# Slice 8 — Economic-Authority Audit (first deliverable)

**Date:** 2026-08-01
**Scope:** Every surface that authors or presents a rent or concession figure,
before any Slice 8 build. Per `08_GOVERNED_RENTS_AND_CONCESSIONS.md`, the audit
is the first deliverable and no economics are built until it is accepted.

**Evidence basis:** source and schema verified against `origin/main` at
`afd1ef1`. Live database state is carried forward from the Slice 7 audit
(Demo Building, 2026-07-31) — this session has no production credentials, so
nothing here claims a fresh live query.

---

## Headline finding

**The governed economics spine Slice 8 was scoped to create already exists.**
Migration 062 built a versioned pricing authority with structured concessions,
fail-closed grants, and an immutable publish trail. Migration 063 built offer
economics with snapshot and lineage.

**It is dark.** No route publishes a pricing version, and the AI does not read
it. What Slice 8 must actually do is far less "design the model" and far more
**close three specific gaps and retire one legacy column**.

This changes the shape of the slice. It is smaller than written, and more
dangerous than written — because the legacy path it replaces is live and has
already misquoted real prospects.

---

## The competing-truth inventory

Seven distinct stores can answer "what is the rent." Only one is governed.

| # | Store | Column | Layer | Governed? |
|---|---|---|---|---|
| 1 | `pricing_terms` | `base_rent`, `renewal_rent`, `immediate_move_in_rent` | **Approved** | ✅ **canonical** |
| 2 | `units` | `market_rent` | Observed (imported) | ❌ **competing — live to prospects** |
| 3 | `ingest_candidates` | `market_rent` | Observed (staging) | ❌ pre-import staging |
| 4 | `lease_applications` | `rent` | Proposed | ⚠️ no lineage |
| 5 | `application_proposed_terms_confirmations` | `rent` | Proposed → confirmed | ⚠️ no lineage |
| 6 | `executed_lease_records` | `rent` | Contracted | ⚠️ no lineage |
| 7 | `leases` | `rent` | Contracted (tenancy anchor) | ⚠️ no lineage |

`lease_offers` (063) is the **only** downstream table carrying
`source_pricing_version_id`. Lineage exists at the offer and dies there.

### The competing truth that matters

`src/agent/pricing_adapter.js` documents the incident in its own header:

> "Today the agent quotes `units.market_rent` directly at `agent.js:294` — a
> legacy per-unit column that **disagreed with the sheet on unit 530 by $237
> and went to nine real phones.**"

Verified still true at `afd1ef1`:

- `agent.js:373` selects `market_rent` from `units`.
- `agent.js:478` renders it into prospect-facing language:
  `` `, rent $${unit.market_rent}` `` — with the honest fallback
  `", rent not on the unit record"` when null.
- `units.market_rent` is written **only by import** (`snapshot_loader.js`,
  `activation.js`) — a spreadsheet column, with no approval, no effective date,
  no version, and no actor.

So the number a prospect hears today comes from an imported spreadsheet cell,
while the governed sheet sits unpublished beside it. That is the exact
"competing truth" Slice 8 exists to end.

---

## Surface-by-surface audit

Required fields: source, authoring workflow, effective date, approval
authority, property scope, unit/space scope, versioning, audit trail,
downstream consumers, conflict behavior.

### 1. Unit asking rent — **competing, ungoverned, live**

| Field | Finding |
|---|---|
| Source | `units.market_rent` (migration 001) |
| Authoring | Import only — `snapshot_loader.js` (bulk), `activation.js` (onboarding) |
| Effective date | **none** — a bare column, no validity window |
| Approval authority | **none** — importer role only (`IMPORT_ROLES`) |
| Property scope | via `units.property_id` |
| Unit/space scope | unit-level; **no space-level rent exists anywhere** |
| Versioning | **none** — `coalesce($4, market_rent)` overwrites in place |
| Audit trail | partial — `import_batch_id`, `source_type`, `source_as_of_date`, `confidence` |
| Downstream | **25 files**, incl. `agent.js` (prospect-facing), rent roll, desks, management reads |
| Conflict behavior | **silent** — no comparison against governed pricing |

### 2. Space asking rent — **does not exist**

No rent or price column on `spaces` in any migration. Confirmed by column sweep.

**Consequence:** a by-bed property cannot express per-bed asking rent. Governed
pricing resolves per `unit_type_id` only. For student/by-bed inventory this is a
real modelling gap, not a display gap — flagged for ruling below.

### 3. Leaseable-unit quote — **built, dark, and pinned dark**

| Field | Finding |
|---|---|
| Source | `src/agent/pricing_adapter.js` → `quotablePricing()` |
| Signature | `{ property_id, space_id, unit_type_id, lease_term_months, intent: 'new_lease' \| 'renewal' }` |
| Status | **dark by construction** — its own header says "Nothing calls this yet" |
| Refusal | returns `HANDOFF` with honest operator language rather than guessing |
| Callers | `shadow_quote_simulator`, `pricing_publication_preview`, `economic_adapter` — all simulation/preview |
| Live agent | **does not call it** |

Two tests actively **pin it dark**:

- `tests/pricing_governance_proof.js:432` — *"no live agent path reads the governed adapter yet"*
- `tests/demo_authority_ruling_proof.js:184` — *"no live AI path reads the governed adapter"*

**This is important.** Flipping the AI onto governed pricing requires
deliberately inverting two guard assertions. That is a governance decision with
a paper trail, and it should be made by ruling — not quietly edited.

The adapter's context signature already matches the Slice 8 spec's required
effective-pricing inputs almost exactly. The design work is done.

### 4. Application proposed terms — **operator-authored, no lineage**

| Field | Finding |
|---|---|
| Source | `lease_applications.rent` (migration 033) |
| Authoring | operator entry |
| Versioning | none on the column itself |
| Lineage | **no `pricing_version_id`** |
| Conflict | none detected against governed pricing |

### 5. Confirmed application terms — **strong record, no pricing lineage**

`application_proposed_terms_confirmations` (085) is well built: `event_id`,
`actor_user_id`, `authority_basis` (`owner` / `role_authority` /
`managed_role_override`), `idempotency_key`, `payload_hash`,
`supersedes_confirmation_id`, plus composite keys enforcing successor lineage
as a DB fact.

**But** `source` is constrained to `'operator_proposed_terms'` and there is
**no foreign key to `property_pricing_versions`**. A confirmed rent cannot
prove which governed sheet it came from — because it did not come from one.

`concession_status` is constrained to `'none'` in this schema generation;
structured concessions are explicitly deferred to a later migration.

### 6. Lease packet / executed terms — **strong record, no pricing lineage**

`executed_lease_records` (088) carries `space_id` NOT NULL by ruling,
`payload_hash`, `normalization_version`, and `concession_schedule_id` pointing
at `lease_economic_schedules` when a concession is non-none. Also **no**
`pricing_version_id`.

`leases.rent` (001) is the tenancy anchor and likewise ungoverned.

### 7. Renewal proposed rent — **honestly null, wiring point named**

`renewal_lifecycle.js:87` states it outright:

> "Slice 6 does NOT author a renewal price. It only reports whether GOVERNED
> economics exist for this renewal. `proposed_rent` stays null until Slice 8's
> governed economics produce one."

`renewals_read.js:313–314` hardcodes `governed_proposed_rent: null`,
`economics_source: null`. Slice 6's live proof confirmed null on all 35 rows.

This is the cleanest hand-off in the codebase — the socket is cut and labelled.
`pricing_terms.renewal_rent` already exists to fill it.

### 8. Concessions — **governed model exists, unpublished**

`concession_policies` (062) is already structured, not free text:
`scope` (property / unit_type / unit / bed_type), `scope_ref`, `lease_type`
(new / renewal), `required_term_months`, `concession_type`
(free_rent / fixed_rent_credit / fee_waiver), `value`, `fee_category`,
`timing_profile`, `qualifying_action`, `qualifying_window_hours`,
`valid_from`, `valid_until`, `active`.

Authority: `concession_authority_grants` implements doctrine **D11** —
a configurable dial (`guardrail_mode` soft/hard, `escalation_threshold`,
`max_discretionary_value`) attached to an assignment, **fail-closed: no grant
means no discretionary authority at all**.

Live state (Slice 7 audit, Demo): **0 policies, 0 grants.**
No operator read endpoint exists; concessions surface only inside pricing/offer
context.

### 9. Manual overrides — **none exist**

No override table or column for rent, price, concession, or economics.
One fewer competing truth. Worth preserving.

### 10. Imported rent-roll values — **the origin of #1**

`ingest_candidates.market_rent` (001) stages imports; `snapshot_loader.js`
promotes into `units.market_rent` with `import_batch_id`, `source_type`,
`source_as_of_date`, `confidence`. Provenance on the import is good. The defect
is that the promoted value then acts as **asking-rent authority** with none of
that provenance consulted at quote time.

### 11. Marketing / listing rent — **does not exist**

No listing table, service, or route. `market_evidence_contract.js` is a
**seam only** — it defines the shape future evidence must satisfy and proves
the pricing service can *display* an observation while being structurally
unable to *consume* it. Direction is enforced:
`market evidence → management judgment → published pricing`. Slice 9.

---

## Authority and lifecycle: what exists vs what is mounted

| Capability | Built | Routed | Note |
|---|---|---|---|
| Save draft version | ✅ `saveDraft` | ✅ `POST /operator/pricing/draft` | |
| Submit for review | ✅ `submitReview` | ✅ `POST /operator/pricing/review` | |
| Publication preview | ✅ | ✅ `POST /operator/pricing/publication-preview` | dry run, writes nothing |
| Shadow quote | ✅ | ✅ `POST /operator/pricing/shadow-quote` | |
| Effective read | ✅ `effectivePropertyPricing` | ✅ `GET /operator/pricing/effective` | |
| History | ✅ `versionHistory` | ✅ `GET /operator/pricing/history` | |
| **Publish a version** | ✅ `publishVersion` | ❌ **NOT MOUNTED** | only reachable from `pricing_rehearsal.js` |
| Concession read | ❌ | ❌ | no operator endpoint |
| Concession approve | ❌ | ❌ | Slice 8 |

`publishVersion` (`pricing_lifecycle.js:206`) is complete — it retires the prior
version and publishes the new one in one transaction, honoring
`uq_ppv_one_published`. **It has no HTTP route.** That single unmounted function
is the reason every property reads `published_version: null`.

One narrow publish path *was* deliberately mounted:
`POST /operator/economics/application-fee/approve` — commented
*"Mounted on ownership approval 2026-07-27. Publishes ONLY fee.application and
leaves the assistant on the legacy source."* Precedent for how to mount the
rest: narrow, dated, explicitly scoped.

---

## Spec contract vs existing model

Slice 8 says *"Use an existing canonical model if it already covers these meanings."*
It largely does.

| Spec field | Exists as | Gap |
|---|---|---|
| `pricing_record_id` | `pricing_terms.id` | — |
| `property_id` | `property_pricing_versions.property_id` | — |
| `unit_id` / `space_id` | — | per-`unit_type_id` only — **accepted by ruling 1**, not a Slice 8 gap |
| `unit_type` | `pricing_terms.unit_type_id` → `property_unit_types` | — |
| `base_asking_rent` | `pricing_terms.base_rent` | — |
| `effective_rent` | computed in `effective_pricing.js` | not stored |
| `term_months` | `pricing_terms.lease_term_months` | — |
| `available_from` | — | **missing** |
| `effective_from` / `effective_through` | `property_pricing_versions.effective_from` / `effective_until` | version-level, not row-level |
| `status` | `property_pricing_versions.status` | draft/published/retired |
| `source_type` / `source_reference` | `authority_basis` (jsonb) | partial |
| `proposed_by_user_id` | draft actor | person-typed, not user-typed |
| `approved_by_user_id` / `approved_at` | `published_by_person_id` / `published_at` | **person, not user** |
| `reason_code` / `reason_note` | `note` (free text) | **no structured reason code** |
| `supersedes_pricing_record_id` | `supersedes_version_id` | version-level |

Concession contract maps almost fully; gaps are `stacking_rule`,
`reason_code` / `reason_note`, and `supersedes_concession_id`.

---

## What Slice 8 must actually build

1. **Mount publish.** Route `publishVersion` behind server-enforced authority.
   Completion gate #3 and #5 hinge on this one wiring job.
2. **Add structured reason + approver identity.** `reason_code`, `reason_note`,
   and reconcile person-typed vs user-typed approver.
3. **Add downstream lineage.** `pricing_version_id` on the confirmed-terms and
   executed-lease snapshots, so a contracted rent can prove its source.
   Additive; existing contracts untouched.
4. **Build the concession read + approval**, reusing `concession_policies` and
   the existing fail-closed grant dial. Add `stacking_rule` — the spec forbids
   silent stacking and no column expresses it today.
5. **Flip the AI onto governed pricing**, retiring the `units.market_rent`
   quote path — and invert the two dark-pins by ruling, not by edit.
   ⚠️ **This is the only step that edits `agent.js`, which is owned by the
   separate AI-leasing thread (owner decision, 2026-08-01).** Steps 1–4 do not
   touch it and can proceed independently. Sequence step 5 against that thread,
   rebase, and re-run the full agent regression set before flipping. See
   `STATUS.md` → "Owned by a DIFFERENT thread".
6. **Fill the renewal socket** so `proposed_rent` resolves from
   `pricing_terms.renewal_rent`.

---

## Rulings

### 1. By-bed pricing — **RULED 2026-08-01: deferred, out of Slice 8 scope**

Governed pricing resolves per `unit_type_id`; no space-level rent column exists
anywhere in the schema. Extending the pricing model to the space/bed level
changes the shape of the canonical contract and touches every consumer.

**Owner ruling:** by-bed pricing needs its own expanded thinking and becomes the
**next focus after Slices 8–10 wrap**. It is not built, not stubbed, and not
half-modelled inside Slice 8.

**Consequence to hold:** Slice 8 governs **unit-type pricing only**. By-bed
inventory stays type-priced. Slice 8 must not add a space-level rent column
"for later" — a dormant space rent is a competing truth waiting to be read.
When a by-bed property cannot be priced at the bed level, the surface says so
honestly rather than implying the type price is a bed price.

### 2. `units.market_rent` — **RULED 2026-08-01: observed evidence only, never fallback**

Keep the column as **observed / imported evidence**. It may support historical,
imported, or comparison surfaces **only when clearly labelled with provenance
and as-of date**.

It must not remain, in any form:

- AI quote authority;
- governed-pricing fallback;
- application-term fallback;
- renewal-price fallback.

**No published pricing sheet means no governed quote.** Falling back to
`units.market_rent` would recreate the exact competing truth this slice exists
to eliminate.

### 3. AI cutover posture — **RULED 2026-08-01: refuse to quote, confirmed**

```text
no published governed pricing → AI does not quote rent → honest handoff
```

The visible behaviour change is **intentional**. Property Spine refuses to
quote rather than speak an imported or stale number as approved economics.

The cutover still waits for the `agent.js` thread to finish, and lands in a
**separate rebased PR with the full agent regression set**.

### 4. Approver identity — **RULED 2026-08-01: person is canonical**

Keep `published_by_person_id` as the canonical business actor. **Do not** add a
competing `approved_by_user_id` merely to mirror the written spec.

```text
person identity = canonical operating actor
user identity   = authentication provenance
```

The publication receipt may expose the authenticated user id as session
provenance where useful. Two independently authoritative fields are forbidden.

### 5. Effective rent — **RULED 2026-08-01: computed, snapshotted only on commitment**

Do not store `effective_rent` as another mutable pricing value. Continue
computing it through the canonical server service. Persist an **immutable
snapshot only** when economics become **quoted, offered, confirmed, or
contracted** — preserving one governed source while letting contractual and
reporting records retain what was actually communicated or signed.

### Superseded note

2. **Legacy column retirement.** When the AI moves to governed pricing, does
   `units.market_rent` get (a) retired outright, (b) kept as observed-only
   evidence clearly labelled as imported, or (c) kept as fallback? **I recommend
   (b) and explicitly not (c)** — a fallback reintroduces the exact competing
   truth that misquoted nine prospects.

3. **Cutover posture.** Until a property publishes a pricing version, the
   governed adapter refuses and hands off. On the day the AI flips, any property
   without a published sheet stops quoting rent. That is doctrinally correct
   ("honest blank beats confident wrong") but it is a **visible behavior change**
   for every property — including Demo, which has zero published versions today.
   Confirm this is intended before the flip.

4. **Approver identity.** Governed pricing records `published_by_person_id`;
   the spec asks for `approved_by_user_id`. Reconcile to one, or record both
   deliberately.

5. **Slice boundary.** `effective_rent` is computed but never stored. Storing it
   would give reporting a stable number; not storing it keeps one source of
   truth. Recommend **not** storing it in Slice 8 and revisiting at Slice 10.

---

## Recommendation

**All five rulings are settled as of 2026-08-01.** Steps 1–4 are built and
proven; step 5 (the AI cutover) is held for the `agent.js` thread and lands in
its own rebased PR with the full agent regression set, under ruling 3.

Build order that keeps every step independently provable: **mount publish →
lineage columns → concession read/approve → renewal socket → AI cutover last**,
so the governed sheet is real and populated before anything starts speaking
from it.
