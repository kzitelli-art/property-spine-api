# Asset Management Operating Door — Source & App Read

**2026-08-11. Read-only. No code, no schema, no build.**
**API `main` @ `d726188` · APP `main` @ `60a489c`.**

## The sequencing this belongs to

```text
ONBOARDING
    ↓  opening truth
LEASING · MANAGEMENT · MAINTENANCE · ASSET MANAGEMENT
    ↓  living property truth
REPORTING
    ↓  period truth and owner output
```

**Build the operating middle deeply enough to know what truth it actually
needs. Then make onboarding populate that truth. Then make reporting read it.**

Do not finish economic onboarding or reporting before the Asset Management
operating model is understood. We are establishing the room before we furnish it.

## Scope of this read

**Looked at:** the whole API tree (`src/`, `server.js`, all 158 migrations) and
the whole app tree (`index.html`, all door modules, `policy.js`,
`property-spine-data.js`).

**Not looked at:** production, anything over HTTP, any harness as a run rather
than as a file.

---

## ⚠ BLOCKING — the name is already spent three ways

`Asset Management` is not free, and this repo has already burned a day on this
exact word.

```text
CLAUDE.md          "Asset Management  RESERVED — the owner surface.
                    Operating truth → economic consequence → owner judgment
                    → reporting"

index.html:4461    "NOT Asset Management. That name is reserved for the owner
                    surface… It shipped under the wrong name for a day; renaming
                    only the visible text would have reserved nothing, since the
                    next person reads ids and routes. So the routes, the module
                    and the identifiers moved too."

index.html:16934   asset_management is a live PERMISSION ROLE string
index.html:16947   ranked 5, alongside asset_manager

deal_setup.js:131  /asset/* is a live ⏳ Class 4 route alias → /deal-setup/*
                   logging `deal_setup_legacy_alias` on every use
```

The new definition — *another operating door, parallel to Leasing, Management and
Maintenance; explicitly NOT the owner-compression dashboard* — **contradicts the
reservation as written**, which assigns the name to the owner surface. §38
defines that surface as a compressed causal model, which is not an operating
door.

### Three ways out — an explicit ruling is required before any identifier is written

1. **Re-rule the reservation.** Asset Management becomes the operating door; the
   owner surface takes its own name. Closest to the stated intent, and cleanest.
2. **Keep the reservation** and name the door something else.
3. **Declare them one room at two altitudes** — the operating door now, owner
   compression as a later layer over the same room. Defensible, and it makes the
   reservation prophetic rather than wrong.

### Route prefix warning

If the door takes `/asset/*` it collides with the Class 4 alias whose removal
condition is *"a deploy with no `deal_setup_legacy_alias` line in the logs."*
Sharing the namespace makes that condition **unobservable forever**.
**Pick a different prefix, or retire the alias first.**

Whatever is chosen: routes, module, DOM ids and function prefix move together, or
nothing is reserved.

---

## 1. What already exists

### API

**`src/surfaces/desks.js` — the load-bearing precedent.** Three of the four doors
already have a dashboard endpoint:

```text
GET /properties/:id/operator-home           three desk cards, one call
GET /properties/:id/leasing-dashboard
GET /properties/:id/management-dashboard
GET /properties/:id/maintenance-dashboard
                                            ← no asset-management-dashboard
```

It also states the rule the new door should inherit verbatim:

> *"the BACKEND owns the headline math — the front end renders labels, it never
> calculates NOI, collection loss, occupancy, or exposure."*

**`src/money/` — 42 modules**, graded by what they are actually about:

| what it is | roughly |
|---|---|
| Leasing economics — pricing, concessions, fees, deposits, charge classes, publication | ~28 modules |
| Migration / cutover instruments — `economic_decision_room`, four `*_cutover`, `fact_migration_preview`, `economic_shadow`, `pricing_rehearsal`, `shadow_quote_simulator` | ~8 modules |
| Property-level money — `moneyboard`, `exposure`, `reporting`, `compare`, `explain`, `bankbridge`, `payments`, `plaid` | ~6 modules |

**`src/surfaces/owner.js` is not the owner surface.** It is `/owner/properties`
and `/owner/attention` — onboarding-era property cards and an attention queue
built from ingest runs. A fourth collision on the word.

**Data that exists:** `bank_accounts`, `bank_transactions`, `money_events`,
`payments`, `ledger_entries`, `scheduled_charges`, `governed_charges`,
`property_noi_goals`, `variance_explanations`, `report_imports`.

**Data that does not exist:** every liability-side table — debt, taxes,
insurance, management fees, payroll, contracts, utilities. Confirmed zero in the
standing-obligations read.

### App

**The door module pattern is established and healthy** — `work-lifecycle-door.js`,
`unit-triage-door.js`, `turn-scope-door.js`, `readiness-door.js`,
`work-acceptance-door.js`, `followups-door.js`, `moveins-door.js`,
`staff-agent-door.js`. IIFE with a re-entry guard, `__psLive` only, **no fixture
path by construction**, renders UNAVAILABLE and *removes* stale content on a
failed read.

**Three desk modes exist:** `leasing-v6-mode`, `maintenance-v6-mode`,
`management-doors-mode`. **No asset-management mode** — three of four, matching
the API exactly.

**But the module vocabulary is six, not four:**

```js
ORG_MODULES = ['management','leasing','maintenance','money','reporting','capital']
KNOWN_DESKS = ['management','leasing','maintenance','reporting','money','capital','activation']
```

`renderMoney()` (index.html:23819) is a fairly complete money desk — splits,
buckets, approvals, Plaid linking. A capital surface exists with investor
relations and capital calls.

---

## 2. What can be preserved

- **The door module pattern, verbatim.** Proven, live-only, already encodes
  honest-unavailable behaviour.
- **`desks.js` as the shape** — a fourth dashboard endpoint alongside the three,
  with the backend owning headline math.
- **`__psLive` registration discipline**, and the recorded lessons that an
  unregistered seam throws forever and that the door must not read the
  `{data, meta}` envelope as the payload.
- **The reverse-funnel doctrine** — headline → the one thing needing attention →
  detail on click (`moneyboard.js`, `desks.js`).
- **`exposure.js`'s gross-never-net rule** — *"offsetting errors must not read
  clean."*
- **The Exposure contract's six questions** as the vocabulary for a room that has
  nothing in it yet.
- **`scheduled_charges.period` vs `due_date`** — the accrual grain, already built,
  for when Revenue fills.
- `property_noi_goals` and `variance_explanations` — right shape, later.

---

## 3. What must NOT dictate the new surface

**The entire `index.html` money / capital / reporting region is snapshot-only.**
`window.__OFFLINE_MODE = true` is assigned unconditionally and is never set false
anywhere in the repo; `getJSON()` checks it first. **Every read there is answered
from the baked snapshot and every write throws `405 read-only snapshot`.**
`renderMoney` and its neighbours are all `getJSON`. It is a historical shell, not
a starting point.

**It also contains a live fixture-fallback:**

```js
const source = rows.length ? rows : CAPITAL_DEMO.money;   // index.html:24376
```

Real rows empty → render demo data. That is the §19–20 shape this repo has
already been burned by once (`__WO_FLOW_LIBRARY`). **Do not carry it forward, and
do not model the new door on the surface that has it.**

**Also excluded:**

- **Migration / cutover tooling** — `economic_decision_room.js`, the four
  `*_cutover.js`, `fact_migration_preview.js`, `economic_shadow.js`,
  `pricing_rehearsal.js`. Class 3/4 instruments for a legacy pricing problem.
  Not product architecture.
- **The leasing-economics stack** — `economic_picture.js`, `effective_pricing.js`,
  `governed_charges.js`, and the fee/concession/deposit modules. Real and good,
  but they answer *what a lease charges*, not *what the property owes*. Letting
  their vocabulary into Asset Management is how the door quietly becomes a second
  pricing surface.
- **`src/surfaces/owner.js`** — onboarding property cards wearing the word.
- **`money` / `capital` / `reporting` as sibling desks.** The four-door model
  consolidates them. Do not preserve the six-module vocabulary just because it is
  in an array.

---

## 4. Proposed navigation hierarchy

Labels and sub-items are **not frozen product copy**. The decision being proposed
is the four-part hierarchy.

```text
Property Home
 └─ ASSET MANAGEMENT              (name pending ruling)
     ├─ REVENUE                   Rent · Vacancy · Concessions · Other Income
     ├─ CAPITAL                   Senior Debt · Mezzanine · Preferred Equity ·
     │                            Reserves / Escrows
     ├─ PROPERTY OBLIGATIONS      Taxes · Insurance · Other fixed / recurring
     └─ OPERATING COSTS           Payroll · Management Fees · Utilities ·
                                  Contracts · Repairs / other opex
```

### One structural observation that argues the split is right

The four groups differ in **where their truth comes from**:

```text
CAPITAL + PROPERTY OBLIGATIONS   instrument-backed standing terms
                                 → fill from ONBOARDING documents
                                   (loan docs, tax bills, policies, contracts)

REVENUE + OPERATING COSTS        largely flow
                                 → fill from OPERATIONS
                                   (leases, work orders, vendors, payroll)
```

That predicts the sequencing of every later slice, which means the hierarchy is
carrying real architectural information rather than being a tidy menu.

### It also front-loads an honest asymmetry

From the standing-obligations read, **base rent is the only standing obligation
generable today.** So Revenue is the one room that can show something real in V1,
and the other three are genuinely not-established.

That is the right first test: it exercises both the filled state and the
honest-empty state on day one, with nothing fabricated.

---

## 5. The smallest shell slice

**One API read. One door module. One nav entry. Zero numbers that are not real.**

### API — a fourth endpoint in the `desks.js` shape

```text
GET /operator/asset-management/overview
     property SERVER-DERIVED from the session grant (§21), never from the client
     returns the four rooms, each with an ESTABLISHMENT STATE — not a metric
```

### Establishment state is derived from real schema presence, never stored

| room | V1 state | why the server can defend it |
|---|---|---|
| Revenue | `partially_established` | leases carry rent + term; escalations and recurring charges do not exist |
| Capital | `not_established` | zero debt / equity / reserve tables |
| Property Obligations | `not_established` | zero tax / insurance tables |
| Operating Costs | `not_established` | zero payroll / contract / utility tables |

### App

`asset-management-door.js` (name pending the ruling), following the existing IIFE
+ `__psLive` pattern exactly. **No fixture path. No `getJSON`.** Registered in
`PRODUCTION_LIVE_RESOURCES` **before** it ships — an unregistered seam throws
forever.

### Each room renders four things and nothing else

```text
its name
its establishment state
what would establish it
who would own that  — or UNASSIGNED
```

No amounts. No charts. No placeholder tiles. No sparklines.

**The honest-empty copy answers the Exposure contract** — what this room is about,
why Spine cannot stand behind it yet, what would resolve it. That makes an empty
room *useful* rather than a stub, and the vocabulary stays correct when the room
fills.

### Deliberately excluded from this slice

Any amount · any schedule · any onboarding · any write path · any reporting read ·
any deep insurance, debt or accrual work.

### Proof, per §33

Browser-verified, with:

- `document.elementFromPoint` visibility assertions (the `#receipt` lesson —
  rendered is not visible)
- selectors scoped to the panel (the unscoped `button:has-text('Review')` lesson)
- **one assertion specific to this slice: that no room renders a currency-shaped
  token.** That is the gate that stops "make the screens look complete" creeping
  in later.

---

## Blocking on the owner

1. **The name ruling** — which of the three ways out.
2. **The route prefix** — given the `/asset/*` alias collision.

Everything else above is ready to build as specified. Nothing has been started.

---

## Parked, not discarded

Two earlier threads are frozen rather than abandoned. Read before restarting
either.

**Standing economic obligations** — `docs/STANDING_ECONOMIC_OBLIGATIONS_SOURCE_READ.md`.
One of twelve categories (base rent) is durably represented; Deal Setup onboards
files, not terms, for everything except the rent roll; and there is **no governed
currency context anywhere in the repo**.

**Operating Economic Consequence V1** — `work_order_progress` is a durable
observation hook; supersession must be scoped to a *claim* so correction and
later fact cannot become one mechanism; `events` was inspected as a cross-domain
causal hook and **rejected** (free-text `type`, no actor column, nullable
`property_id` with `ON DELETE CASCADE`, and standing facts have no event at all);
and the canonical actor for economic confirmation is **`users.id`**, reached to a
person only through the audited bridge via `staff_identity_resolver.js`.

Operating consequences sit **alongside** the governed baseline, not underneath it:

```text
normal governed expectation  +  unexpected operating consequence
    =  the actual economic story of the property
```
