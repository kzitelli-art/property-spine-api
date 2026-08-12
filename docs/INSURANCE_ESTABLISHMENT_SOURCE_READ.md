# Add Current Insurance — source read and proposed slice

**Status: PROPOSAL. No code written.** This is the pre-build read for the first
human establishment path into Insurance. Read it before writing anything.

Everything below was measured in the tree at API `30e1c1a` (ledger ceiling 161,
released and live). File:line references are real. Where I did not look, I say so.

---

## 1 · What already exists

The economic architecture is built and released. **Do not redesign it.**

```text
migrations/161_insurance_economic_truth.sql        released, ceiling 161
  insurance_programs                 term + currency (not null, NO default)
  insurance_coverages                own period, carrier, broker, premium
                                     + taxes + fees + broker_fee
                                     total_cents GENERATED — parts cannot drift
  insurance_coverage_identifiers     policy numbers as EVIDENCE, not identity
  insurance_property_allocations     dated slices, stated vs derived,
                                     provenance, supersession chain
```

### The canonical writers — already correct, already guarded

`src/asset/insurance_program_service.js` (172 lines)

```text
establishProgram(client, {program_name, term_start, term_end,
                         currency_code, user_id})
  · refuses CURRENCY_NOT_ESTABLISHED by name — there is no governed property
    or deal currency anywhere in this repo to fall back on (:63)
establishCoverage(client, {program_id, coverage_type, carrier_name,
                          broker_name, coverage_period_start/end,
                          premium_cents, taxes_cents, fees_cents,
                          broker_fee_cents, user_id})
recordIdentifier(client, {coverage_id, identifier_value, issued_by,
                          observed_in_artifact_id, observed_as_of, user_id})
```

`src/asset/insurance_allocation_service.js` (258 lines)

```text
openSlice(client, {coverage_id, property_id, allocated_amount_cents,
                   allocation_class, allocation_basis, basis_detail,
                   effective_from, effective_to,
                   source_artifact_id, provenance_note, user_id})
  · closes the prior live slice for the scope before opening the next (:151)
  · OVER_ALLOCATED refusal at the instant the slice begins (:163)
  · STATED_NEEDS_EXTERNAL_BASIS — a computed basis cannot be recorded
    as `stated`, so an internal estimate can never reach a lender wearing
    a carrier's authority
  · stamps deal_membership_id CURRENT AT ORIGIN, never derived later (:172)
correctSlice(client, {allocation_id, …, revision_reason})
  · a correction restates a claim and moves prior periods
  · openSlice is the verb when the WORLD changed — it moves only the future
```

`src/asset/insurance_position_read.js` (267 lines) — `readPosition`,
`readCompleteness`, `readHistory`, `termMonths`, `periodBounds`.
Accrual is `Math.round(annual / termMonths)`; coverage period governs, cash
timing is irrelevant.

### The surface

```text
src/surfaces/asset_management.js
  GET /operator/asset-management/overview     :320
  GET /operator/asset-management/insurance    :559
  gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule]
```

App side: `asset-management-door.js` renders the Insurance compartment —
COVERAGE STACK · ECONOMIC POSITION · CASH & FINANCING · RENEWALS & HISTORY,
plus the five metrics. Verified on production 2026-08-11: it opens and reports
every panel `NOT ESTABLISHED`, correctly, because nothing has been established.

---

## 2 · Five findings that shape the build

### F1 · The writers have ZERO HTTP callers. That is the whole seam.

```text
grep -rn "insurance_program_service|insurance_allocation_service" src/ server.js
  → only insurance_allocation_service.js requiring insuranceError
     and asset_management.js requiring insurance_position_read
```

Both writers are reachable **only** from tests. The read is wired; the write is
not. The missing seam is a route pair and nothing else. **Do not create a second
writer** — there is no gap in the write layer to fill.

### F2 · ⚠ BOTH READS ARE ALLOCATION-GATED. This is the finding that decides the design.

`readPosition` selects **from** `insurance_property_allocations` and joins
coverages onto it (:86). `readCompleteness` does the same — it inner-joins
`insurance_property_allocations mine … property_id = $1` (:194).

**Consequence:** a program and a coverage established for a policy that does not
state this property's share are **invisible to this property**. `readPosition`
returns `established: false`, `readCompleteness` returns `[]`, and the dashboard
looks exactly as it did before the operator uploaded anything.

The brief says: *"If the document does not establish the property's share,
establish what is known and surface the missing allocation honestly."*
**Today there is no way to express that.** Honest partial work is
indistinguishable from no work — which is the honest-blank principle failing in
the direction nobody checks.

### F3 · The property↔insurance relationship IS the allocation

`insurance_programs` has no `property_id`. `insurance_coverages` has no
`property_id`. The only link from a policy to a property is an allocation row
carrying an **amount** (`allocated_amount_cents bigint check (> 0)`, not null).

So the schema currently conflates two different facts the workbook keeps apart:

```text
"this property is named on this policy"        participation — a fact from
                                               the schedule of locations
"this property's share of it is $X"            allocation — an amount
```

Loosening `allocated_amount_cents` to nullable is the wrong fix: it would
corrupt the over-allocation guard, the sum math and the meaning of every
existing row.

### F4 · Extraction precedent: the SERVER does not parse the document

`src/onboarding/deal_setup.js:346` → `activation.ingestRentRoll(pool, {… rows:
(req.body||{}).rows, source_artifact_id: (req.body||{}).source_artifact_id …})`.

The client sends **structured rows**; the API stores the artifact separately for
provenance and binds the confirmed facts to it. The upload route is
`deal_setup.js:259` using `upload.single("file")` →
`src/onboarding/source_artifact_service.js` `store()`, which validates
extension/mime/magic bytes and enforces `MAX_BYTES`.

The full Deal Setup ladder is richer than this slice needs:

```text
POST …/source          upload artifact
POST …/activation      open activation
POST …/read-source     extract → proposed_records (migration 040)
GET  …/activations/:id read proposals
POST /proposals/:id/confirm | /dismiss
POST …/establish       write canonical truth
GET  …/opening-position
```

### F5 · The parsing capability exists; the artifact kinds are already widened

`package.json` dependencies include **`pdf-parse`**, **`xlsx`**, **`mammoth`**
and **`@anthropic-ai/sdk`** (already used in `server.js` and
`src/leasing/leasingintel.js`). Migration 161 already widened
`source_artifacts.artifact_kind` to accept `insurance_policy`,
`insurance_binder`, `insurance_invoice`, `insurance_allocation_schedule`.

Nothing needs to be installed or migrated to accept an insurance document.

---

## 3 · The one decision to make before writing code

F2 and F3 leave exactly two honest options. **They are not equivalent, and the
brief points at B.**

### A · No new schema. Refuse when the share is not established.

`POST …/insurance/establish` requires an allocation. If the document does not
state this property's share, the whole confirm is refused with a named,
sayable refusal — nothing is written.

```text
+ zero schema, smallest possible slice
+ everything written is immediately visible
− contradicts "establish what is known and surface the missing allocation"
− a shared policy cannot be recorded at all until someone produces the
  allocation schedule — the operator's real evidence is rejected wholesale
```

### B · One narrow table: participation, distinct from allocation. ← recommended

```sql
-- migration 162, Insurance-specific. NOT a generalized standing-obligation table.
create table insurance_coverage_properties (
  id uuid primary key default gen_random_uuid(),
  coverage_id uuid not null references insurance_coverages(id),
  property_id uuid not null references properties(id),
  observed_in_artifact_id uuid references source_artifacts(id),
  observed_as_of date,
  recorded_by_user_id uuid not null references users(id),
  recorded_at timestamptz not null default now(),
  unique (coverage_id, property_id)
);
```

"This property is named on this policy." No amount. The economics stay entirely
in `insurance_property_allocations`, untouched.

```text
+ makes "covered, share not yet established" expressible — the exact state
  the brief asks for
+ mirrors the workbook, which lists the property on the policy in one place
  and its allocated share in another
+ readPosition stays allocation-driven and needs NO change: economics still
  require an allocation, so no fabricated cost can appear
+ COVERAGE STACK can populate while ECONOMIC POSITION honestly reads
  "allocation not established" — two panels, two truths
− one migration, and one new read
```

**Recommendation: B.** It is not premature generalization — it is
Insurance-specific and it is the minimum needed to make the brief's own stated
requirement expressible. A is a smaller slice that ships a worse product and
would have to be undone.

**This decision is the next thread's first act. Do not start coding before it
is made.**

---

## 4 · The proposed slice

### Routes — two writes, on the existing surface, behind the existing gate

```text
POST /operator/asset-management/insurance/evidence
     multipart, upload.single("file") → source_artifact_service.store()
     artifact_kind ∈ insurance_policy | insurance_binder
     returns { artifact_id, proposed: {...}, unknown: [...] }

POST /operator/asset-management/insurance/establish
     body = the HUMAN-CONFIRMED facts + artifact_id
     one transaction → establishProgram → establishCoverage
                     → recordIdentifier → participation
                     → openSlice ONLY when a share is established
     returns the freshly-read position, so the dashboard shows the result
     of the write rather than a hopeful client-side guess
```

Gate is `...gate` unchanged. **Property is server-derived** — a body
`property_id` is REFUSED, not ignored (`refuseClientAuthority`, §21, and the
rule frozen in PR #38: body actor fields are rejected).

### Extraction

Follow F4: the artifact is stored for provenance; the facts come back confirmed
by a human. Server-side extraction from the stored PDF (`pdf-parse` → text →
`@anthropic-ai/sdk` → proposed fields) is available and is the natural
implementation of "Spine proposes," but **every proposed field is a suggestion,
never a write.** Nothing reaches the database without the confirm call.

**Unknown stays unknown.** A field the document does not support is returned in
`unknown: []` and rendered blank. No inferred dates, no inferred amounts, no
inferred coverage type, no derived allocation presented as `stated` — the
service already refuses that last one and the route must not work around it.

The API key must never reach the browser or a harness log.

### The confirm writes, in one transaction

```text
establishProgram      term + currency  ← currency is REQUIRED and has no
                                          default anywhere; the UI must ask
establishCoverage     per coverage on the document
recordIdentifier      policy number as observed, verbatim, per rendering
participation         this property is named on this policy
openSlice             ONLY when the document establishes this property's share
                      allocation_class must be `stated` only with an external
                      basis; a computed split is `derived` and names its model
```

### Renewal — read-only, deterministic, no workflow

`insurance_coverages.coverage_period_end` already carries expiration and
`readPosition` already returns `next_renewal`. A derivation of
`days_to_renewal` and a band (`90 / 60 / 45 / 30`) is a pure function of that
date and today. **Nothing scheduled, nothing stateful, no notifications.** If
it does not fit in a few lines of the read, it is the wrong slice.

### Out of scope — do not build

```text
premium financing · IPFS · down payments · installments · finance charges
escrow · payment matching · bank linkage
email monitoring · broker chasing · bid management · owner agent
generalized standing-obligation schema · licenses · inspections · taxes
portfolio/owner dashboard · TEAM redesign · document management
```

**Cash & Financing must still read NOT ESTABLISHED after a successful insurance
establishment.** That is the wall holding. `tests/gate_insurance_economic_independence.js`
already fails the build on financing vocabulary in the migration or the
services — **extend its scan to any new route file**, or the gate will assert
less than the claim it is making.

---

## 5 · Proof standard

```text
schema           migration 162 applied in a scoped harness schema
                 (the full chain cannot rebuild from empty — 012_bank_intake /
                 yardi_code. Use the scoped-schema pattern from
                 tests/insurance_truth.db.js)
services         the confirm path writes ONLY through the existing writers
HTTP             real authenticated request, real Postgres
refusals         currency missing · over-allocation · stated-without-external
                 basis · body property_id · unentitled operator (403, not empty)
browser          upload → proposal → confirm → the EXISTING dashboard populates
                 assert the COMPUTED result and ask the DOCUMENT for
                 visibility (elementFromPoint), never classList
                 assert the shared-policy case shows coverage established AND
                 allocation missing — the state that does not exist today
```

Add the new assertions to `asset_management_shell.browser.js` (105/105 today)
rather than starting a new proof, and **confirm each new assertion fails on the
unbuilt behaviour before trusting it.**

---

## 6 · Traps carried forward

- **`window.__OFFLINE_MODE = true`** is unconditional (`index.html:4901`) and
  writes throw a clean 404 (`:11033`). The Asset Management door works because
  it uses the live-required loader (`window.__psLive`) that bypasses the
  snapshot. **Any new insurance write must go through `__psLive`, not
  `getJSON`,** or it will 404 in production and look like a server fault.
- **Resolve properties by ID, never by name.** Three distinct properties are
  named "Solo on Chestnut". The operating one is
  `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe`.
- **TEAM cannot make live permission changes** (offline/snapshot). Granting a
  module today goes through `PATCH /property-team-assignments/:id` with the
  operator key. Parked, not this slice.
- **A deploy does NOT migrate.** Merging 162 without a deliberate release boot
  gives a failed deploy while the old instance keeps serving. See §3 of
  `THREAD_HANDOFF.md` and the Path A sequence.
- **`build-info.js` is structurally stale** — writing the SHA changes the SHA.
  Verify deploys from Render's record.

---

## 7 · Definition of done

> A real operator opens a property with no established Insurance truth, clicks
> **ADD CURRENT INSURANCE**, supplies the current insurance evidence, confirms
> what Spine extracted, and the existing Insurance dashboard populates from
> canonical governed truth — with anything the document did not establish
> visibly missing rather than quietly invented.
