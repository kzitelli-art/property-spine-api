# Four-deal cleanup — the plan

2026-09-15, over board `2aab0db5`. **No production read. No product code
changed. Nothing here executes.**

The target, as the owner stated it. These are intended identities, **not a
verified mapping to production ids** — establishing that mapping from existing
records is step 2, and nothing below assumes it.

| Deal | Property | Address |
|---|---|---|
| Skyline | Skyline Apartments | 1417 North 15th Street |
| Greenery | Greenery Apartments | 1325 North 15th Street |
| Uno | Uno on Chestnut | 4125 Chestnut Street |
| Solo | Solo on Chestnut — **real property** | 4233 Chestnut Street |

Skyline and Greenery are the first production onboarding priorities. Solo and
Uno stay reachable with their work preserved; **visibility is not leasing-ready
and does not enable outbound activity.**

**Which picker the owner sees is now answered** (PICKER_TRACE.md): the
signed-in one, reading per-person access rows. Owner-reported, corroborated by
source, not browser-proven. C1 below therefore acts directly on the surface the
owner actually looks at, and the hardcoded registry is not what is putting
extra properties in that view.

---

## 1 · Retirement is not deletion, and the mechanism already exists

`properties` has **no lifecycle column**. Every column added to it —
`accountable_assignment_id`, `canonical_key`, `canonical_key_absent_reason`,
`display_name`, `operating_timezone`, `planned_unit_count` — retires nothing.
`migrations/180_inventory_retirement.sql` retires **units**, not properties.

The existing mechanism is **`property_team_assignments.active`**.
`authorized_properties.js` reads `where a.user_id = $1 and a.active = true`, so
deactivating an assignment removes that property from that person's chooser
while every row survives.

It has the three properties this cleanup needs:

- **Reversible** — set `active = true` and it returns.
- **Per person** — which is what preserves staff-specific access. Cleaning one
  portfolio does not touch anyone else's.
- **Non-destructive** — no history moves, nothing is deleted.

**Consequence for the audit:** a non-zero dependency count is not a blocker to
retiring a record from ordinary operation. It is a blocker to *deleting* one,
which is neither authorized nor proposed. v1 of the map implied otherwise and
has been corrected.

---

## 2 · Classification, with four things kept distinct

Every property is classified into exactly one of three states:

| State | Meaning | Action |
|---|---|---|
| **Keep active** | one of the four deals' properties | leave assignments active; fix naming only if a human sees the internal key |
| **Retain outside ordinary operations** | real, but not in the four | deactivate the assignments that surface it; change nothing else |
| **Identity unresolved** | cannot yet be told apart from another row | **no action at all** until a human decides |

**Do not classify everything outside the four as fake.** Four different things
sit outside it and they are not interchangeable:

- an **old acquisition target** — real, historical, worth keeping readable;
- a **real off-scope property** — someone else's, or not this portfolio's;
- a **synthetic fixture** — demo or QA, safe to retire from operations;
- a **duplicate-looking identity** — the dangerous one, because it is not a
  duplicate until a human says so.

`Temple Nest` and `1850` sit in the registry and outside the four. Migration
025 exists *because* the Greenery deal was two properties — *"The Greenery 1325
N 15th + 1850 N 18th"* — so `1850` may be a Greenery property rather than a
separate deal. That is an **identity unresolved** until section 2 of the map
says which.

---

## 3 · The change set, smallest first

Nothing here is executed by this lane. Each item names what it changes and
whether it needs code.

### Configuration and data — no code, reversible, through existing doors

| # | Change | Mechanism | Reversible by |
|---|---|---|---|
| C1 | Remove out-of-scope properties from the owner's ordinary view | `PATCH /property-team-assignments/:id` with `active: false` | the same call with `active: true` |
| C2 | Record any missing deal→property membership | the existing Deal Setup door over `deal_intake_properties` | removing the membership row; the property is untouched |
| C3 | Set `display_name` where a human currently sees the internal key | property update through its governed path | restoring the prior value |

C1 is per assignment, per person. It is **not** an organization-wide
permissions change, and nothing here grants any employee access to a deal they
do not already hold.

### Requires code — not proposed until the map is in

| # | Change | Why it is code, and why it waits |
|---|---|---|
| K1 | Retire or keep `deal_registry.js` | two files read it — `src/leasing/leasing_detail.js` and `src/surfaces/property_surface.js`, three call sites (scope: `src/`, `server.js`, `tests/`; the app repo is outside this session and was not scanned). It is the second source for leasing basis and claims authority over property naming. A ruling, then a lane. |
| K2 | Single-property deal opens directly into its workspace | app-side behaviour at the pinned commit; app-first by the repo's own rule |
| K3 | Any `leasing_basis` correction | **only with evidence.** See §5. |

### Explicitly not authorized, and not proposed

Deletion of any record. Bulk reassignment. A new membership model —
`deal_intake_properties` already exists and is many-to-many. Any
organization-wide permissions rewrite. Renaming the demo Solo into the real
Solo. Merging by address. Recreating a property to obtain a clean card.

---

## 4 · Where the existing Solo and Uno work lives

The first version of the audit counted six operating classes — team, units,
leases, import batches, activations, opening positions — and would have
reported a property with asset-management setup as carrying nothing.

Section 4B of the map now reads the classes that actually hold that work:

`legal_entity_properties` · `capital_stack_positions` ·
`debt_instrument_properties` · `insurance_coverage_properties` ·
`tax_obligation_properties` · `compliance_items` · `documents` ·
`deal_intake_files` reached through deal membership.

`legal_entity_properties` is the entity relationship the deal's accounting
hangs from, and `capital_stack_positions` is the canonical Equity domain. A
property can read zero across all of section 4A and carry every one of these.

---

## 5 · Leasing basis is reported, never converted

The registry stores a leasing model and pins Solo and Uno by explicit
`property_id`. Section 5 of the map now exposes **identity** disagreement — a
pinned id resolving to a different row than the canonical key does — before it
reports model disagreement, because a mis-binding is the worse failure and no
amount of model agreement makes it safe.

**Reference count is not authority.** That `properties.leasing_basis` has more
references than the registry does not establish which is correct. What
establishes it is the writer, its protections, and which consumers still read
the registry — and that trace is owed before any ruling.

**For this cleanup, preserve verified operating grain.** Bed-versus-unit
decides how inventory counts. A disagreement is evidence for an explicit,
evidence-backed correction — never an incidental administrative update made to
get two sources to agree.

---

## 6 · What this lane cannot do, stated as one request

The map is a claim about live rows. This lane has no production access, so per
the direction it goes to the release coordinator as a single execution request
rather than back to the owner as more questions.

> **Execution request — read-only, production, one run.**
>
> Run `docs/handoffs/new-hp/deal-reconciliation/KEEP_RETIRE_MAP.sql` in full
> against the production branch and return the complete output of all eight
> sections.
>
> Every statement is a `SELECT`. Nothing writes. It has been run end to end
> against an owned schema at ledger 198, `psql` exit 0, every table and column
> resolving.
>
> Return output whole, not summarised — the plan is keyed on ids, and a summary
> loses them.

---

## 7 · Acceptance evidence

The cleanup is done when all five hold, each demonstrable rather than asserted:

1. **The owner sees the four intended deals** — and each resolves to a property
   id recorded in the map, not to a name match.
2. **The real Solo is distinguishable from its demo** — both rows still exist,
   and which is which is recorded by id.
3. **Existing Solo and Uno work still opens** — the section 4B counts are
   unchanged before and after.
4. **Staff permissions remain correct** — section 7 before and after shows
   changes only on the assignments the plan names, and only for the people it
   names.
5. **Retired records cannot contaminate ordinary views or automated work** —
   they are absent from `/operator/properties` for the affected user, and no
   scheduled or automated path reaches them.

Production changes go to the existing manual approval gate. Nothing in this
plan is executed by this lane.
