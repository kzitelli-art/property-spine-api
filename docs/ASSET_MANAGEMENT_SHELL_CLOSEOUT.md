# Asset Management — Shell Closeout

> ⚠ **THE HIERARCHY IN THIS DOCUMENT IS SUPERSEDED (2026-08-12).** Asset
> Management was reorganised into four rooms — **Capital Stack · Property
> Expenses · Projects & CapEx · Compliance**. Revenue, Property Obligations
> and Operating Costs are no longer rooms. In particular the ruling below
> that *"Compliance sits inside Property Obligations, not beside it"* is
> **reversed**: Compliance is now its own room, and licences, inspections and
> certificates live there rather than beside Taxes and Insurance. The current
> structure is in `CLAUDE.md` → "Four operating doors". Everything else here
> — naming, routes, entitlement, the proof record — stands as the dated
> record of that build.

**2026-08-11. Branch `claude/property-spine-thread-handoff-i7hj0u`, both repos.**

```text
API  c88ee3798a15ef3f6f4ad958c90f4792e8b9ac47
APP  b6bb64191beb16597154025f13cea5998ff386a3
next free migration number: 161
```

**Nothing here is in production.** Migration 160 is unreleased, so the module
entitlement cannot be granted and the desk card stays correctly hidden. That is
the single gate between this and a real operator clicking it.

---

## 1. THE PRODUCT RULING THIS WORK ENCODES

The central operator product has **four operating doors**:

```text
LEASING      MANAGEMENT      MAINTENANCE      ASSET MANAGEMENT
```

**Asset Management is a staff/operator-side OPERATING door**, parallel to the
other three. The asset manager is still operating the deal — economically.

**It is NOT the Owner / Investor surface.** That is a later, different audience,
potentially a different login, and it is now its own reserved name.

```text
Property Management / Operations → Asset Management → Owner / Investment Team
```

Progressive economic context and compression — **not one screen with different
permissions.**

### The sequence

```text
ONBOARDING                            establishes opening truth
    ↓
LEASING · MANAGEMENT · MAINTENANCE    operate and continuously update
· ASSET MANAGEMENT                    living property truth
    ↓
REPORTING                             reads and closes/compresses it
    ↓
OWNER / INVESTOR SURFACE              later, different audience
```

**Build the operating middle deeply enough to know what truth it requires. Then
make onboarding populate it. Then make reporting read it.**

### The hierarchy

```text
REVENUE               Rent · Vacancy · Concessions · Other Income
CAPITAL               Senior Debt · Mezzanine Debt · Preferred Equity ·
                      Reserves / Escrows
PROPERTY OBLIGATIONS  Taxes · Insurance · Licenses & Registrations ·
                      Compliance · Other fixed / recurring
OPERATING COSTS       Payroll · Management Fees · Utilities · Contracts ·
                      Repairs / other operating expense
```

**Compliance sits inside Property Obligations, not beside it.** A lapsed rental
licence and an unpaid tax bill are the same kind of fact from the asset's point
of view: a standing obligation of ownership with a date and a consequence.
Splitting them would make the operator look in two places for one answer.

### Naming, routes, entitlement — frozen

```text
canonical name          Asset Management
canonical route         /operator/asset-management/*
canonical entitlement   asset_management  (a MODULE, in allowed_modules)
```

**`/asset/*` is NOT reused.** It stays Deal Setup's ⏳ Class 4 legacy alias with
its original retirement condition (a deploy with no `deal_setup_legacy_alias`
log line). Sharing the prefix would have made that condition permanently
unobservable.

**Module entitlement and job title are different facts.** Access is gated on
`allowed_modules` containing `asset_management`, exactly like the leasing gate —
never on the `asset_manager` role name. The future Owner / Investor surface must
NOT reuse this entitlement merely because it consumes Asset Management truth.

---

## 2. THE RESERVED-NAME CORRECTION

`Asset Management` was previously **reserved for the owner surface** in five
places. All five were corrected in place, none deleted:

| file | what changed |
|---|---|
| `CLAUDE.md` | reserved-name block; gained the four doors, the sequence, the hierarchy, progressive compression, standing-vs-operating |
| `docs/PHILOSOPHY.md` §36 | diagram's bottom box read `ASSET MANAGEMENT / OWNER COMPRESSION` — now `OWNER / INVESTOR SURFACE`, with a dated correction note |
| `docs/PHILOSOPHY.md` §38 | now opens by stating it is *not* Asset Management |
| `docs/THREAD_HANDOFF.md` | new top section carrying the direction + the stale-scaffolding inventory |
| `server.js` + `index.html` | Deal Setup mount comments rewritten |

**`CLAUDE.md` also gained a disambiguation it badly needed.** There are now
**two different fours** — four operating **doors** and four **compressions**
(Staff · Management · Accounting · Owner) — and "Management" appears in both
meaning different things. A door is where work is done; a compression is how
truth is said.

**Deal Setup's own rename is left standing** with its reasoning intact. It was
still correct — Deal Setup is onboarding, Asset Management is operating. What
changed is *why*, not *whether*.

---

## 3. WHAT WAS MEASURED AND MUST NOT DICTATE THE NEW SURFACE

Measured, not assumed:

```text
index.html money/capital/reporting region   SNAPSHOT-ONLY. __OFFLINE_MODE is
                                            assigned true unconditionally and
                                            never set false; getJSON() checks it
                                            FIRST, so every read is the baked
                                            snapshot and every write throws 405.

index.html:24376  CAPITAL_DEMO              FIXTURE FALLBACK — renders demo rows
                                            when real rows are empty. §19–20
                                            violation shape. Not carried forward.

src/money/*_cutover.js, economic_shadow.js  Class 3/4 MIGRATION INSTRUMENTS for a
fact_migration_preview.js,                  legacy pricing problem. Not product
economic_decision_room.js, pricing_rehearsal architecture.

src/money/economic_picture.js,              LEASING economics — what a LEASE
effective_pricing.js, governed_charges.js   CHARGES. Not what the PROPERTY OWES.

src/surfaces/owner.js                       Despite the name: onboarding property
                                            cards + attention queue from ingest
                                            runs. NOT the owner surface.

ORG_MODULES / KNOWN_DESKS containing        The four-door model consolidates
'money', 'capital', 'reporting'             these. Left live; not the direction.
```

**Nothing was deleted.** Proving a caller absent requires more than a grep here,
and every one of those paths is still called.

---

## 4. WHAT SHIPPED

### API — `src/surfaces/asset_management.js`

```text
GET /operator/asset-management/overview     the four rooms
GET /operator/asset-management/insurance    the first compartment surface
```

One router, **one auth gate definition** — never two.

**Authority (§21).** Property comes from the resolved staff session, never the
request. A client-supplied `property_id` is **refused**, not ignored. Access is
gated on the module entitlement.

**Establishment is DERIVED per request, never stored.** Nothing is written and
no state column exists. If a later migration establishes debt, this door starts
saying so with no backfill, because it was never remembering an answer.

| room | V1 state | why the server can defend it |
|---|---|---|
| Revenue | `partially_established` | leases carry rent + term; escalations and recurring charges do not exist |
| Capital | `not_established` | zero debt / equity / reserve tables |
| Property Obligations | `not_established` | zero tax / insurance tables |
| Operating Costs | `not_established` | zero payroll / contract / utility tables |

Revenue is **never** `established` — a complete revenue position needs
escalations and recurring charges, and `economic_classes.js` grades the second
itself (`recurring_charge_model_not_built`).

### Compartments — the permanent skeleton

Every room returns the sub-doors it will always have, **each with its own
establishment**, because they fill **one at a time**. Rent is already partially
established from real leases while Vacancy is not; a room averaging those into
one state would lie in both directions.

```text
Revenue              Rent · Vacancy · Concessions · Other Income
Capital              Senior Debt · Mezzanine · Preferred Equity · Reserves
Property Obligations Taxes · Insurance · Licenses & Registrations · Compliance
Operating Costs      Payroll · Management Fees · Utilities · Contracts · Repairs
```

A room is not an empty-state page waiting to be replaced. The operator already
sees where Insurance and Taxes are going to live, and the first real compartment
fills a slot that already exists instead of forcing a redesign.

### Migration 160 — the entitlement

Adds `asset_management` to the two role **presets** that already carry economic
modules (`owner`, `property_admin`).

**It touches no existing `property_team_assignments` row.** Widening live access
for everyone already assigned would be granting authority nobody asked for,
silently, to real people at real properties. Any existing human who should hold
this module is granted it explicitly, through the normal team-access path.

The real blocker was not schema: `teamaccess.js` carried a hardcoded four-value
module vocabulary that would have rejected the string outright.

### APP — `asset-management-door.js`

**It is a desk, not a mini-app.** Mounts into `#intelStrip` inside the normal
operator frame — property identity, ‹ Home, active module, Team. No masthead, no
badge pill, no BACK TO APP. Moving from Leasing to Asset Management feels like
walking through another door in the same building.

Wired as a real desk: a fourth entry in `PS_MODULE_IDENTITY`,
`asset-management-mode` in `setDeskCopy`, a `renderDesk` branch, `goHome`
cleanup, and a fourth desk card on Home revealed by the module entitlement.

**It reuses Leasing's card system rather than cloning it.**
`.maint-primary-grid.le-doors`, `.maint-command-card`, `h3`, `p` and
`.maint-card-open` are the SHARED rules. A parallel `am-*` system would drift the
first time anyone touched Leasing's spacing and the two desks would stop looking
like one product with nobody noticing.

---

## 5. THE INSURANCE COMPARTMENT

The first compartment with its own surface, and the pattern the other sixteen
will follow.

**Insurance is property-centric on the surface even though the underlying
insurance is not.** Portfolio and shared programs, property-specific policies,
Property / GL / Umbrella / Excess layers, multiple carriers, mid-term
endorsements and additions, allocations, premium plus taxes and fees, lender
escrow, premium financing with down payments and installments — all real
underneath. The asset manager reconstructs none of it.

### Four truths that must never collapse into one mutable record

```text
coverage   what applies, for what period
economic   what cost belongs to THIS property and THIS period
cash       what is paid, when, through which escrow or financing path
history    what changed, when, and why
```

Each section **declares its truth in the payload** (`truth:` and
`data-am-truth`), not merely in a comment — so the separation is legible to a
reader who never saw the design conversation, and so a later change wanting to
merge two sections would have to delete a declared boundary to do it.

### Two doctrines, carried in the API

```text
Coverage period determines when the expense economically belongs.
Cash payment timing does not.

A renewal is a new governed term and an endorsement is a dated change.
The prior term stays historically true.
```

The first is §39 arriving at its first real domain: a $120k premium paid in
January belongs ~$10k to each month it covers. The second is the same shape as
the claim-scoped supersession ruling — history accumulates, it does not advance.
A reported period must stay explainable after the policy that produced it is
replaced.

**Cash & Financing is separate from Economic Position permanently**, so the
surface can later say *economic expense this month = X* and *cash payment this
month = Y* and treat **neither** as the error. Collapsing them is how a financed
premium reads as twelve months of expense in the month the down payment cleared.

### What the surface shows

```text
INSURANCE

COVERAGE | ANNUAL COST | MONTHLY ACCRUAL | NEXT RENEWAL | PAYMENT
   each: NOT ESTABLISHED

COVERAGE STACK              ECONOMIC POSITION
one sentence                one sentence
NOT ESTABLISHED             NOT ESTABLISHED

CASH & FINANCING            RENEWALS & HISTORY
one sentence                one sentence
NOT ESTABLISHED             NOT ESTABLISHED
```

**Three things per card, then stop.** The API still carries `reserved`,
`layers`, `doctrine` and `awaiting` — that is the specification, and it belongs
in the response, the proofs and the docs. **No surface prints it**, and a
browser assertion enforces that it never reappears.

Headline cells render `value: null` as a stated *"Not established"* — **never a
dash and never a zero**. A dash in a money slot reads as a real zero to anyone
scanning.

**No database read**, and that is honest rather than lazy: there is no insurance
table anywhere in the schema, so a query would be theatre. When governed
insurance truth exists this handler resolves it the way `revenueEstablishment`
already resolves leases, and the shape does not change.

**Nothing is wired to the portfolio workbook and none of its formulas are
encoded.** Shape validated against real operating evidence, not data.

---

## 6. EVIDENCE

```text
tests/asset_management_shell.db.js    46/46   real Postgres + real HTTP
asset_management_shell.browser.js     75/75   real Chromium
npm run verify                        12/12   all source-governance gates
APP run_harnesses.sh                  1041/0  23 harnesses, 0 red
```

The assertions that matter most are the ones about **lying**:

- A role named `asset_manager` **without** the module is refused; a
  `property_manager` **with** it is admitted. A door reading the title would get
  both backwards.
- The response **and separately the rendered panel text** must contain no
  currency-shaped token while the test database holds a real `1850.00` lease —
  proving the absence is by construction, not by there being nothing to leak.
- The HOME must **not** render "What would establish it", "Deal Setup" or
  UNASSIGNED; the ROOM must not either. The specification must be **absent** from
  the Insurance surface while still present in the API.
- All four desk cards must render an **identical border at rest**.

---

## 7. WHAT THE PROOFS CAUGHT THAT REVIEW DID NOT

Five real findings, and in four cases the correct repair was to move the code
rather than relax the assertion.

**`gate_harness_isolation` refused the new test, correctly.** It checked
`HARNESS_DATABASE_URL` against a *name* pattern, which passes for a disposable
branch on the production host. Now uses `harnessConnectionString()`, which
resolves host/port/database and exits rather than returning.

**CSS in the wrong style tag.** Putting the desk-frame rules in the feature
`<style>` tag re-declared `.lanes` **after** the print block and won the cascade
— lanes would have been visible on a printed page. `shared_frame_proof` and
`page_identity_proof` both went red and both were right. The frame rules now sit
with the other three module modes, before the print block.

**`elementFromPoint` below the fold.** The browser proof failed on the fourth
room; the screenshot showed the room was fine. `elementFromPoint` takes viewport
coordinates and returns null outside them. Weakening the check would have
discarded the one assertion that catches a real overlay defect, so it now
scrolls into view first and reports still-offscreen-after-scroll distinctly.

**The darker border on Operating Costs was the cursor.** There is exactly one
state rule on that card — `:hover`, shared with Leasing — and no focus or
selected rule anywhere. Playwright leaves the pointer where it clicked. It read
as a real defect on review, which made it a real defect in the *evidence*: the
proof now parks the mouse before the screenshot **and** measures computed border
across all four cards. A correct shared style was not changed to chase an
artifact.

**Product copy.** A screenshot caught *"1 active lease **carry** a rent
amount"*. Two card lines also outgrew the room explanation they were supposed to
summarise — a card line that outgrows the room is the card quietly becoming the
room again.

---

## 8. FROZEN

**The Asset Management home, the room grammar and the compartment navigation are
frozen.** The next change to this surface should come from putting real truth
inside it, not another round of empty-state polish.

---

## 9. CLASSIFIED, NOT LEFT TO ROT

Two sets of emitted-but-unrendered fields, both ⏳ **Class 4** with exact
conditions:

**Room-level `why` / `what_would_establish_it` / `owner`.** The room page stops
at its compartment skeleton; Property Obligations does not explain how all four
children get established. **Relocation condition:** when the first compartment
surface is built, this explanation moves DOWN to compartment level and the
room-level fields are deleted in the same commit.

**Insurance `reserved` / `layers` / `doctrine` / `awaiting`.** Spec, not
display. Retained for proofs and docs; a browser assertion enforces they never
reach the screen.

---

## 10. OPEN

1. **Migration 160 is not released.** A deploy does not migrate — `prestart`
   verifies and refuses to boot while anything is pending. Until the deliberate
   release runs, the module cannot be granted and the desk is unreachable.

   ```bash
   MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<read it> \
     EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply
   ```

   `docs/release/ledger_read_before_release.sql` is current — run it, do not
   retype it.

2. **⚠ Migration 159 is still unconfirmed** from the Deal Setup thread, as is the
   human production pass. Both predate this work and neither is resolved.

3. **`asset_management` is overloaded within the app.** It is the new module
   entitlement *and* a pre-existing permission-role string in `index.html`
   (16934/16947, rank 5). They never meet at runtime, but the word means two
   things in one file. Renaming touches live permission logic — recorded, not
   done.

4. **Older browser proofs `require("playwright")` bare**, depending on a manual
   install in a repo that tracks no `package.json` — the exact manual step
   `THREAD_HANDOFF` says release evidence must not depend on. The Asset
   Management proof resolves it from the API repo instead. Pre-existing across
   several files.

5. **No PRs opened.** Both branches are pushed and ready.

---

## 11. WHAT COMES NEXT, AND WHAT MUST NOT

**Next:** put real Insurance truth into the skeleton. Every category in the
Cowork research already has a reserved slot — TIV/allocation → Economic
Position; IPFS/AFCO/lender escrow → Cash & Financing; endorsements/renewals →
Renewals & History; shared-vs-individual programs → Coverage Stack.

**Not yet:** policy schema, allocation engine, accrual generator, financing
math, document extraction, Outlook/OneDrive ingestion, accounting recognition,
reporting, owner/investor view.

**Parked, not discarded** — read before restarting either:

- `docs/STANDING_ECONOMIC_OBLIGATIONS_SOURCE_READ.md` — one of twelve standing
  obligations (base rent) is durably represented; Deal Setup onboards files, not
  terms, for everything except the rent roll; and **there is no governed currency
  context anywhere in the repo**.
- Operating Economic Consequence V1 — `work_order_progress` is a durable
  observation hook; supersession must be scoped to a *claim*; `events` was
  inspected as a cross-domain causal hook and **rejected**; the canonical actor
  for economic confirmation is **`users.id`**.

```text
normal governed expectation  +  unexpected operating consequence
    =  the actual economic story of the property
```
