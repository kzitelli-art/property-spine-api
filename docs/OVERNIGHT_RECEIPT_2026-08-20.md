# Overnight receipt — 20 August 2026

```text
INTENT   one canonical governed path to Skyline pricing authority, proven
         off-production, then drive the real pricing path to its first red.
```

## Existing mechanism (found, not built)

| fact | owner | state before |
|---|---|---|
| `person_contexts` staff scope | `src/identity/staffbridge.js` — sole writer | reachable, mounted, audited — but **no path to a second property** |
| `assignments` authority role | `src/identity/authority_resolution.js` | governed, 7 preconditions, receipt — **dormant, no HTTP route** |
| `assignments` authority role | `src/surfaces/orgchart.js` | **reachable**, OPERATOR_KEY only, **no actor recorded** |
| governed unit types | `tools/apply_unit_type_mapping.js` | governed CLI, owner-approved mapping, dry-run, idempotent |

## Observed reds

1. **Authority bypass.** On a disposable DB, a person `resolveAuthority`
   refused (`person_is_classified_staff`, `person_entitled_to_property`,
   `person_is_not_a_counterparty`) got `may_publish_pricing = true` the
   instant an `assignments` row appeared. `pricingAuthority` reads
   `assignments` and never consults `person_contexts` — the row *is* the
   grant, and orgchart wrote it behind a shared key with no actor.
2. **No second-property entitlement.** `createStaffPerson` writes a scoped
   context only while creating a NEW person; `linkBridge` refuses an
   already-linked one. An established staff person could never become
   entitled elsewhere.
3. **Withdrawn contexts still counted — found by falsification.**
   `authority_resolution` read `person_contexts` with no `active_to`
   filter, so a *closed* staff context still satisfied both staffness and
   entitlement. Revoking entitlement did not revoke it for granting
   authority. The chain proof withdrew a context it had just granted and
   required a refusal; the gate did not notice.
4. **Replica shape wrong at first build.** 72 units produced 232 spaces:
   `trg_unit_space` auto-inserts a `(whole unit)` placeholder per unit.
   Caught by the replica's own shape assertion before anything downstream
   was believed.
5. **First red on the pricing path** — see below.

## Fixes made, each in the existing owner

- **`staffbridge.grantStaffContext`** + `POST /operator/admin/bridge/staff-context`.
  Idempotent (replay reported, not duplicated), attributed via the same
  `created_by_user_id` column `createStaffPerson` uses, session-authorized
  behind `requireBridgeAdmin` with the admin server-derived, and refuses a
  person holding no active staff context — widening entitlement must never
  be what first makes someone staff. Creates no person, touches no
  `users.person_id`, confers no authority.
- **`orgchart` fails closed** for `owner`/`asset_manager`, importing
  `FULL_AUTHORITY_ROLES` rather than re-listing it. Guards both the
  requested role *and the existing row's* role — otherwise a deactivated
  `asset_manager` could be handed its authority back with
  `{"is_active": true}` and no role in the body at all.
- **`authority_resolution`** now filters `active_to is null`.

`roomowners.js` also writes assignments; its `ROOM_TO_ROLE` map contains no
authority-bearing role, so it was left alone.

## Canonical owners preserved

No new authority writer, no second governed implementation, no operator UI.
The consequential write still belongs to `resolveAuthority`; entitlement
still belongs to `staffbridge`; unit types still belong to
`apply_unit_type_mapping.js`.

## Hostile proofs — `tests/e2e/authority_chain.e2e.js`, 16/16, wired into CI

```text
✓ no authority before anything is granted
✓ grantor refuses without an entitling context
✓ context granted, and it records the acting admin
✓ replay reported, exactly one active row
✓ person with no staff context refused
✓ grantor applies; provenance names the real actor and reason
✓ prepare / review / publish all true, basis assignment:asset_manager
✓ wrong property still refused
✓ orgchart refuses asset_manager, and confers nothing
✓ an existing authority row cannot be re-activated from the org chart
✓ FALSIFIED: withdraw the context → the grantor refuses again
```

## The pricing drive — `tests/e2e/skyline_pricing_drive.e2e.js`

Replica reproduces production's canonical shape exactly: `leasing_basis
bed`, **72 units / 160 rentable positions / 0 governed unit types**,
confirmed by `datedPropertyPositions`. Authority established through the
newly-proven rail. Then:

```text
✗ effectivePropertyPricing        returns ZERO types to price
✓ previewPublication              refuses
✓ resolveSpaceEconomics           refuses — unit_type_not_established
```

```text
FIRST OBSERVED RED
  The pricing worksheet has no unit types to price.
  Three independent surfaces agree, and each refuses honestly.
```

## Exact next blocker — a business ruling, not code

`apply_unit_type_mapping.js` maps a **source code** to a governed type via
`import_source_rows.produced_space_id`, from an **owner-approved** list. The
list in the file today is an apartment floorplan vocabulary (`S.1UN_02`,
`1.1DN_02`, …) approved 2026-07-27 for a different property. Skyline is
bed-based, and nobody can approve a Skyline mapping without seeing Skyline's
actual codes.

So `tools/release/unit_type_source_codes.js` (read-only, decides nothing)
reports the codes that are really there — with row/unit/position counts,
coverage, and which raw keys exist at all if `unit_type` is absent.

**The morning question:** for each code it returns, what is the human label
and the use type (`residential | commercial | non_revenue | other`)?

## Deliberately NOT touched

The 160 unclassified positions and the six unresolved 31-July baseline rows
did **not** appear in the first red. `resolveSpaceEconomics` stops at
`unit_type_not_established`, which is upstream of both. They stay logged and
unrepaired until something actually blocks on them.

## Production actions waiting for approval

```text
1. KZ Skyline staff context       POST /operator/admin/bridge/staff-context
                                  (or the service from the Render shell)
2. KZ asset_manager assignment    resolveAuthority, apply=true
3. Skyline unit-type mapping      needs the ruling above first
```

No production writes were made. No entitlement granted. No pricing
published. No Mike activation. No identity or property cleanup.


---

# Second overnight pass — the rail runs end to end

```text
AUTHORITY
existing mechanism:  staffbridge (person_contexts) · resolveAuthority (assignments)
                     orgchart was a PARALLEL writer of the same authority row
first red:           a person resolveAuthority refused got may_publish_pricing=true
                     the instant an assignments row appeared — pricingAuthority
                     reads assignments and never consults person_contexts
fix:                 staffbridge.grantStaffContext (+ one route) for an
                     already-linked person; orgchart fails closed for owner and
                     asset_manager, guarding the EXISTING row's role too;
                     authority_resolution now filters active_to is null
hostile proof:       authority_chain.e2e.js — 16/16, in CI
status:              CLOSED. One governed path, falsified.

UNIT TYPES
source evidence:     three codes reconcile exactly to production's canonical
                     shape — STU00016 56u/112p, STU00015 12u/36p, STU00017 4u/12p
                     = 72 units / 160 positions, zero unmapped
STU00016:            2 Bedroom · residential
STU00015:            3 Bedroom / 1 Bath · residential
STU00017:            3 Bedroom / 1.5 Bath · residential
unresolved:          THE BATH DISTINCTION IS AN OWNER STATEMENT, NOT YET
                     CORROBORATED AGAINST THE SOURCE. Encoded under the receipt
                     `skyline_owner_statement_2026-08-20_pending_source_corroboration`.
                     tools/release/unit_type_evidence.js is built and pushed to
                     check it against the July rows AND the April batch's own
                     independent `type` values. NOT YET RUN — production read.
mapping proof:       skyline_unit_type_mapping.e2e.js — 12/12, in CI.
                     Dry run wrote nothing; apply covered 72/160 with 0 unmapped,
                     exactly 3 types, distribution identical to production,
                     idempotent, no retired inventory reintroduced.

PRICING
canonical mechanism: pricing_lifecycle — saveDraft → submitReview → publishVersion,
                     gated by pricing_publication_contract
how far it ran:      ALL THE WAY. Draft saved, review approved, version PUBLISHED,
                     3 terms written, and resolveSpaceEconomics then quoted
                     new_lease_rent=1100 citing the governed pricing_term and its
                     published version — not the 999999 legacy market_rent sentinel
                     deliberately planted on every unit.
first observed red:  none left in the mechanism. The reds found were:
                       · reviewer must ALSO hold governed authority (correct;
                         satisfied by the one-asset-manager ruling, since
                         self-review is permitted only on an `assignment:` basis)
                       · `receipt_reviewed` is a caller-supplied proposal flag the
                         preview takes on trust — the real gate is inside
                         publishVersion, which re-reads the receipt, requires
                         decision='approved', and compares proposalDigest
                       · published ≠ effective: a version dated ahead correctly
                         refuses to quote until its effective_from
smallest missing:    real Skyline numbers. The rents used are mechanism-proving
                     placeholders on a disposable database and are not fit to be
                     copied anywhere.
business ruling:     per unit type — the actual new-lease rent, the renewal rent,
                     offered vs not-offered, lease term(s), and the effective date.
                     Nine numbers and three decisions.

PRODUCTION
writes made:         NONE
```

## What the publication contract already refuses

Worth knowing before the numbers arrive — the contract is strict, and one of
its rules is the audit's §3.3 defect class guarded at the boundary:

```text
market_rent_promotion          a legacy units.market_rent value cannot be
                               promoted into published pricing
client_store_promotion         nor can the browser-side pricing store
legacy_text_as_key             legacy unit_type text is provenance, not a key
marketable_type_not_addressed  every marketable type must be priced or
                               explicitly marked unavailable
offered_without_new_lease_rent an offered type must state a rent
renewal_pricing_not_addressed  renewal must be explicit, never inherited
publisher_lacks_authority      read from assignments, never from the request
```

A term absent from a proposal is absent from the draft — nothing is carried
forward from a prior version, because a stale price outliving the decision
that made it is how the wrong number reaches a real phone.

## One vacuous assertion, caught

The first version of the §3.3 check compared `econ.rent` to the sentinel and
passed. `rent` is an OBJECT (`{new_lease_rent, renewal_rent, …}`), so it can
never equal a number — the assertion could not fail. It now reads
`rent.new_lease_rent`, proves it is finite, proves it differs from the
sentinel, and proves it equals the `pricing_terms.base_rent` of the term the
resolver itself names. Fourth instance this week of a green that had never
been made to fail.

## Still untouched, still deliberate

160 positions with no `classification_source`, six unresolved 31-July baseline
positions, duplicate KZ person rows, two empty Skyline property records. None
appeared in any red on this path. They stay logged.


---

# Corroboration run — the source is silent on the bath distinction

`unit_type_evidence.js` was run against production. Result:

```text
STU00015   12 units   36 positions   bedrooms NULL   bathrooms NULL   sqft 0
STU00016   56 units  112 positions   bedrooms NULL   bathrooms NULL   sqft 0
STU00017    4 units   12 positions   bedrooms NULL   bathrooms NULL   sqft 0
```

**What the source DOES establish** — and it is not nothing:

- **The room grain.** `STU00016` carries `Room1/Room2`; `STU00015` and
  `STU00017` carry `Room1/Room2/Room3`. That is why the bed counts
  reconcile to 112 / 36 / 12 exactly, independent of anyone's memory.
- **`is_commercial = false`** on every row, supporting `residential`.
- **April agrees** — but only by repeating the identical code. Its `type`
  column returns `STU00015`, `STU00016`, `STU00017`. Two rent rolls, one
  vocabulary, no expansion of it.

**What it does NOT establish:**

- `units.bedrooms` and `units.bathrooms` are **NULL for all 72 units**
- square footage is null/0 throughout
- the rent-roll column is literally **`Unit/Room Type`**, carrying the bare
  code with no legend, lookup or expansion anywhere in the file
- **nothing separates `STU00015` from `STU00017`.** Both three-room, both
  non-commercial, both showing `market_rent 875` in their sample rows

```text
DISTINGUISHER NOT ESTABLISHED
```

The ruling receipt was renamed from `…_pending_source_corroboration` to
**`skyline_owner_statement_2026-08-20_source_silent_on_bath_distinction`**,
because corroboration is no longer pending — it was run, and it came back
silent. The labels still carry the owner's statement, recorded as owner
knowledge rather than as a derivation, so no later reader can mistake one
for the other. If that distinction ever has to be defended from evidence,
the evidence is not in the rent roll.

## A related finding, logged not chased

Skyline's `units.bedrooms`, `units.bathrooms` and `square_feet` are empty
across all 72 units. Nothing on the pricing path needed them, so nothing was
done about it. It is recorded here because a leasing surface that wants to
say "3 bed, 1.5 bath" to a prospect currently has nowhere to read it from.

---

# Defect #1 closed: the price a prospect hears

The audit's highest-severity finding. `src/agent/agent.js` read
`units.market_rent` — a legacy per-unit column with no publish step, no
version and no review between it and someone's phone — and handed it to the
model. It had already been wrong in production: $237 off on unit 530, said
to nine real people.

`src/agent/pricing_adapter.js` was built to stop exactly this, and then sat
dormant. That is its own kind of failure and worth naming: the wall existed,
the defect kept running, and the source read as though the problem were
solved. This is the shape the directive warned about — *source existing is
not runtime truth.*

## What changed

There were **two** leaks, not one.

| Leak | Was | Now |
|---|---|---|
| linked-unit context (`resolveContext`) | selected `market_rent`, put it in the system prompt | selects `unit_type_id`, asks `quotablePricing` |
| inventory list (`offeredUnits`) | carried `market_rent` **per unit** into the tool result | governed rent, term, and an explicit `pricing_status` per unit |

The second was the worse one: the `units:` line strips only `id`, so a
*list* of ungoverned rents reached the model — the same defect multiplied by
however many units matched.

The refusal wording changed too. `", rent not on the unit record"` read as an
*inventory fact* and left the model free to fill the gap. When pricing is not
quotable the model is now told so explicitly and handed the exact sentence to
use.

## What proves it

`tests/e2e/agent_pricing_wall.e2e.js` — 11 assertions, wired into
`verify_all.sh`, therefore into CI. It proves the wall from **both**
directions, because proving one would be half a proof:

- with no published pricing → the agent quotes nothing and hands off
- with pricing published through the real workflow → it quotes the governed
  number, and states its basis
- a sentinel value sits on `units.market_rent` throughout and appears in
  neither

Falsified by removing the rewire: the sentinel reaches the quote.

## The teardown obeys the rule it just proved

Published terms are frozen by `trg_pricing_terms_frozen`, and there is
deliberately **no** governed operation that deletes a published version —
published pricing is a permanent record. The test retires its version first,
which is the one transition the immutability rule permits, rather than
routing around the freeze. Remove that line and the teardown refuses again;
that was checked, not assumed.

A second route exists and is deliberately unused: `delete from properties`
cascades through versions to terms without the frozen trigger refusing,
because the cascade removes the version row before the terms trigger reads
its status. **That is a hole in the immutability rule.** It is documented in
the test and left alone. Closing it is a schema question, not a pricing fix.

## Two tools were describing a live path that no longer exists

`shadow_quote_simulator.js` and `economic_shadow.js` model the legacy answer
so a proposed sheet can be judged against it. Both told an operator that
`agent.js` reads `units.market_rent` **today**. After the rewire that is
false, and it is the kind of false that changes decisions. Both now name
themselves a **pre-cutover baseline**; the shared sentence is defined once
instead of duplicated. Their `live_*` field names are unchanged — renaming an
operator-facing API shape does not get smuggled into a pricing fix.

## What is NOT proven

- **Not proven in production.** Local and CI only, against no Skyline data.
- **Four pinning proofs under `tests/` record the inversion but nothing runs
  them.** They are pinned to a hardcoded demo UUID
  (`a50fbdd0-…`) and fail on fixtures alone — identically before and after
  this change, which was verified by stashing. Their assertions are
  documented intent, not proof. Making them runnable means decoupling them
  from that UUID.

---

# The CI failure underneath it

CI had been **red for four consecutive runs** while the full suite passed on
every developer machine:

```text
FATAL: The server does not support SSL connections
```

`tools/apply_unit_type_mapping.js` hardcoded `ssl: { rejectUnauthorized:
false }`. Correct for Neon. Correct for a developer machine, whose Postgres
has `ssl = on`. Fatal against CI's `postgres:16` container, which does not
speak SSL at all. Two e2e proofs shell out to that tool, so both went red in
the one environment nobody can see from their own terminal.

`server.js` already knew the rule — it had learned it the same way, from CI —
and kept it as a private function where nothing else could reach it. **That
is the actual defect.** Not the tool's line: a rule that has to be remembered
per file.

- `src/shared/database_ssl.js` states it once
- `server.js` and the tool both take their answer from it; production
  behaviour is unchanged, since Neon is not a local host
- `tests/gate_ci_path_ssl.js` stops a third file, and **discovers** its
  subjects by reading what the e2e proofs actually shell out to rather than
  carrying a list that would go stale the same silent way

Extracting the rule surfaced a defect inside it: `URL.hostname` keeps the
brackets on an IPv6 literal — `"[::1]"`, not `"::1"` — so the `::1` entry
never matched and IPv6 loopback was still being told to use SSL. Found by
checking the rule's answers one at a time instead of trusting that a list
membership test did what it read like.

The gate was made to fail three ways before being trusted, and passes 12/12
restored.

**Not reproduced locally.** This machine's Postgres has `ssl = on` and the
sandbox refused both routes to a server without it. What is proven locally is
the decision function on seven URLs, the gate's three falsifications, and the
full suite green with loopback now resolving to `ssl: false`. CI is the
falsifier for the other half.
