# Budget & Forecast North Star

**Owner ruling recorded 2026-08-26. Design doctrine only.**

This document preserves the planning consequence of the Money architecture. It
does not open a Budget or Forecast implementation lane. Planning remains after
Skyline is operating and after Money Build 4.

The governing Money sequence remains:

```text
occurrence → obligation → economic decision → cash → recognition →
certification → issuance
```

Planning consumes the dated consequences of that sequence. It does not collapse
or silently prove any layer within it.

Read this beside:

- [MONEY_THESIS.md](MONEY_THESIS.md) — why institutional financial outputs are
  derived from governed operating truth;
- [STANDING_ECONOMIC_OBLIGATIONS_SOURCE_READ.md](STANDING_ECONOMIC_OBLIGATIONS_SOURCE_READ.md)
  — which dated economic terms exist today and which do not;
- [FUTURE_OPERATING_READINESS_TRACE.md](FUTURE_OPERATING_READINESS_TRACE.md)
  — the distinction between a governed future expectation and an invented
  forecast;
- [GOVERNED_ECONOMIC_TERMS.md](GOVERNED_ECONOMIC_TERMS.md) — the current
  governed-term vocabulary.

## North Star

> **Property Spine continuously computes the expected economic future of the
> property from governed terms, operating facts and explicit assumptions. An
> approved budget freezes one accepted version of that future; the live forecast
> continues to change, actuals accumulate separately, and unresolved inputs
> remain visible rather than disappearing inside the number.**

Budget and Forecasting are not being built now. The Money layer is being built
so that, when the planning lane opens, Spine can construct most of the Operating
Plan by reading the property rather than asking someone to rebuild it in a
spreadsheet.

## Product ownership

Budget and Forecasting belong in **Asset Management** as a cross-domain
planning workspace.

They do not belong inside Property Expenses, and they do not become a fifth
Asset Management room. The exported `ROOMS` constant in
[`src/surfaces/asset_management.js`](../src/surfaces/asset_management.js) is the
canonical four-room contract:

```text
Capital Stack
Property Expenses
Projects & CapEx
Compliance
```

The eventual **Budget & Forecast** workspace belongs above those four rooms. It
composes economic truth from all four plus revenue facts owned by Leasing and
Management. It does not take ownership of those source facts.

The stale top-of-file header in `asset_management.js` still describes the
superseded Revenue / Capital / Property Obligations / Operating Costs hierarchy.
That comment should later be corrected to point to the exported `ROOMS` constant
instead of restating a room list in prose. This documentation slice does not
change source.

## The eventual Operating Plan

The canonical planning object is the **Operating Plan**.

> **The Operating Plan is authored and governed in Asset Management. Reporting
> and the Owner / Investor surface consume its canonical reads. Neither owns a
> second planning writer.**

An owner may eventually approve or reject an Operating Plan, but that action
must invoke the same canonical Asset Management service. The owner surface does
not receive its own budget table or planning writer.

The eventual planning read has four source columns:

```text
APPROVED BUDGET
frozen, authorized baseline

CURRENT FORECAST
living composition read from current governed facts and assumptions

ACTUAL
recognized economic history

UNQUANTIFIED
material inputs, assumptions or obligations whose amount is not yet established
```

Variance is derived:

```text
actual vs budget
forecast vs budget
actual vs forecast
```

Variance is not a fourth source column. `UNQUANTIFIED` is a source column because
a clean forecast number with unresolved material inputs is a false blank.

A future Asset Management read should be capable of saying:

```text
Forecast NOI             $1.84M
Quantified Exposure      $72K
Unquantified inputs      3
Completeness             PARTIAL
```

## Mutability and versioning

```text
approved budget     immutable version
current forecast    continuously recomputed
actual              accumulates from recognized facts
reforecast          new approved version that supersedes, never erases
```

The forecast inherits the Asset Management rule: **derived state is computed
from current canonical facts and is not stored as permanent truth.**

Do not persist a “current forecast” merely because it is convenient. A technical
cache may eventually exist, but it must remain disposable and reproducible. Only
an authorized planning act creates a retained version, such as an approved
annual budget or approved reforecast.

## Completeness vocabulary

Completeness is a governed contract, not a free adjective:

```text
COMPLETE
All required readers succeeded and all material inputs are established and
quantified.

PARTIAL
All required readers succeeded, but one or more material inputs remain
unresolved or unquantified.

NOT_ESTABLISHED
All required readers succeeded, but no governed forecast basis exists.

UNAVAILABLE
At least one required reader failed or timed out, so completeness cannot be
determined.
```

Reader health is a separate axis. `READ_FAILED` and `READ_TIMED_OUT` must never
be disguised as `PARTIAL`.

**Unknown amount is never zero.**

## What every Money primitive must preserve

Budget and Forecasting are downstream consumers of the Money architecture. A
Money primitive preserves, where applicable:

```text
effective period
recognition period or recognition basis
cadence and term
liable legal entity
amount, or explicitly unknown amount
causal hook to the operating source
authority and immutable authority basis
correction / supersession relationship
whether the fact governs future periods
source evidence and provenance
```

This does not require every Money object to carry every field. It forbids the
architecture from destroying the information needed to produce a dated future
series later.

Ramp remains an actuator. It may supply execution and cash evidence. It does not
author planning assumptions or the budget.

## One dated economic inventory

Planning and Recognition share one source inventory. Do not create separate
catalogs that drift.

The future read-only artifact is named:

### Dated Economic Series Inventory

For every canonical economic source, answer both directions:

```text
EXPECTED FORWARD
What future economic series can this source produce?

RECOGNIZED BACKWARD
How does the same obligation belong across accounting periods?
```

For each source, inventory:

```text
domain owner
canonical service and read
effective start and end
cadence
amount or governing driver
liable entity
authority
deterministic vs judgmental treatment
material unresolved determinants
current completeness
whether it can support a monthly series today
```

The inventory includes leases, signed future leases, debt schedules, taxes,
insurance, utilities, contracted services, management fees, payroll allocations,
capital projects and variable operating decisions.

This is one dated series viewed forward for Planning and backward for
Recognition.

## `property_noi_goals` disposition

The existing `property_noi_goals` path is:

```text
CLASS 2 — TEMPORARY ADAPTER
```

It records a legitimate top-line onboarding target. It is not a budget,
forecast, actual NOI, expense model or planning domain.

Removal condition:

```text
When the canonical Operating Plan supports an approved opening plan containing
target NOI and the supporting revenue and expense assumptions:

1. disable POST /properties/:propertyId/onboarding/noi-goal
2. migrate or explicitly preserve every existing property_noi_goals row
3. make onboarding read the latest approved Operating Plan
4. remove all runtime callers of the legacy writer
5. add a gate proving no new property_noi_goals writes are possible
```

Do not expand `property_noi_goals` into the budget one field at a time.

## Sequence and current stop

```text
NOW
Gate Zero
deploy control
RC1
Mike at Skyline
Money Build 0.5 closure of migration-059 mutation capability

NOW · READ-ONLY ONLY
record the stale Asset Management header correction
run the Dated Economic Series Inventory
continue the Teams economic-decision inventory
rule unresolved Planning / Recognition questions where necessary

AFTER SKYLINE
Money Builds 0.75 → 1 → 2 → 3 → 4

LATER
Recognition
Cash
Certification
Issuance
Planning / Operating Plan
Actuator
```

Planning implementation remains after Money Build 4 and after Skyline is
operating.

Until that gate opens, do not add:

```text
no budget tables
no forecast writer
no Budget & Forecast API
no dead Budget card in the app
no fifth Asset Management room
no new planning lane
```

The future position above the four Asset Management rooms may be reserved
conceptually, but no control renders until a governed forecast read and a real
destination exist.

## Planning consequence in Money receipts

Every Money build receipt must include:

```text
PLANNING CONSEQUENCE

Does this build preserve, improve or block the future expected-series,
Operating Plan, Budget / Forecast / Actual / Unquantified read?

What dated term, authority, uncertainty or causal relationship is available to
Planning after this build that was not available before?
```

This keeps Planning present without turning it into an active build lane.
