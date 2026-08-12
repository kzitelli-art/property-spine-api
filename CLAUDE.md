# Property Spine — API

**Before doing anything, read [`docs/THREAD_HANDOFF.md`](docs/THREAD_HANDOFF.md).** It is the current deployed state — what is live, what is draft, what is blocked, and the traps that cost time. Do not reconstruct it from git history.

**Before modifying any product behavior, read the governing doctrine: [`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md).** It defines what the product is and how to decide whether a feature belongs. It is doctrine, not style.

## North Star

Record the truth at the moment of work, so reporting becomes a read, not a reconstruction. The final deliverable is the monthly investor & lender **reporting package** (see `docs/PHILOSOPHY.md` §16), generated only after a human reviews and presses GENERATE.

## What Spine onboards

**Spine onboards a DEAL, not a property.** First run is: deal name → property
address(es) → rent roll for each property → Spine fills in the physical facts it can.

```text
DEAL      the onboarding container. One deal may hold one property or several.
PROPERTY  the durable physical asset.
ADDRESS   the anchor. It fixes the asset and its jurisdiction, so taxes,
          licensing, compliance and local rules can attach correctly later.
```

Legal entities, ownership and debt structure are a **later** onboarding stage that
reads them from org charts, loan documents and operating agreements — not something
the first step asks for.

The deal container is **partly built already**: `deal_intakes`, `deal_name`,
`deal_intake_files`, `activations.deal_id`. What is missing is any durable statement
that a deal *contains* a property — today it is inferred from which files resolved.
See `docs/BUILD_1A_CLOSEOUT.md` before designing anything above the property.

**Do not make Property the top-level onboarding or economic container.** Build 0 did,
and had to be corrected.

## Four operating doors

The central operator product has **four** operating doors. They are the middle of
the system.

```text
LEASING      MANAGEMENT      MAINTENANCE      ASSET MANAGEMENT
```

**Asset Management is the fourth door, not a dashboard and not a report.** It is
staff/operator side, parallel to the other three. The asset manager is still
*operating* the deal — economically. Debt and capital structure, taxes,
insurance, payroll, management fees, utilities, contracts, capital work, and
later budgets and variances.

Inside it are **four rooms**:

```text
CAPITAL STACK       Debt · Equity · Reserves & Escrows
                    ↑ how this property is capitalised, and what it owes the
                      people who capitalised it
PROPERTY EXPENSES   Taxes · Insurance · Payroll & Staffing · Utilities ·
                    Contracted Services · Repairs & Maintenance ·
                    Management & Administration · Marketing & Leasing Costs ·
                    Other Operating Expenses
                    ↑ what this property costs to own and operate
PROJECTS & CAPEX    Projects · Unit Improvements · Building Systems ·
                    Equipment / FF&E · Capital Reserves & Draws
                    ↑ where capital is being invested in the physical
                      property, and what that work costs
COMPLIANCE          Licenses & Registrations · Inspections · Certificates ·
                    Violations & Cure · Recurring Requirements
                    ↑ whether this property is legally and regulatorily in
                      good standing
```

**The room is navigation. The module underneath owns the truth.** A room reads
its children's canonical reads and renders them; it does not author domain
truth, and it may not manufacture an establishment its children cannot
support. Property Expenses is capped at *partially established* for exactly
this reason — with two of nine modules live, saying `established` would tell
an operator that payroll, utilities and five more are accounted for.

Five rulings this structure carries:

- **Revenue is not an Asset Management room.** Rent, vacancy and concessions
  are recorded by Leasing and Management, where the work happens. Their
  economics flow into financial reporting from those canonical operating
  domains — Asset Management does not restate them as a room of its own.
- **Taxes and Insurance live under Property Expenses and keep their full
  independent domain depth.** Being reached through a room does not flatten
  them into expense lines; each remains its own domain with its own governed
  truth, evidence and clocks.
- **Licenses, registrations, inspections, certificates and regulatory
  standing live under Compliance.** The *fees* they generate may flow
  economically into Property Expenses; the operational and regulatory truth
  stays in Compliance. One domain owns the standing.
- **Maintenance owns work execution. Projects & CapEx owns the AM/economic
  view of capital work.** A work order is a Maintenance event. What that work
  costs, and whether it is capital, is the Asset Management reading of it.
  Do not put a work order in Projects & CapEx.
- **Capital Stack may read escrow and funding positions, but must never
  bypass the Tax and Insurance funding boundaries.** An escrow balance is
  readable there; it is authored on the funding side of those domains, and
  the economic chain may never import funding to get it.

### The system sequence

```text
ONBOARDING                                    establishes opening truth
        ↓
LEASING · MANAGEMENT · MAINTENANCE ·          operate and continuously update
ASSET MANAGEMENT                              living property truth
        ↓
REPORTING                                     reads and closes/compresses it
        ↓
OWNER / INVESTOR SURFACE                      later consumes the compressed
                                              story for a different audience
```

**Build the operating middle deeply enough to know what truth it requires. Then
make onboarding populate it. Then make reporting read it.** Do not pre-design all
financial onboarding or reporting before the middle exists.

### Progressive economic context — not one screen with permissions

```text
Property Management / Operations  →  Asset Management  →  Owner / Investment Team
```

Each step is more compression and more economic context, for a different audience.
The Owner / Investor experience is **a different audience and potentially a
different login**. Do not design it now; preserve the boundary. And do not let it
reuse the Asset Management entitlement merely because it consumes Asset Management
truth.

### Standing economics vs operating consequence

```text
STANDING ECONOMIC TRUTH      governed terms already known — leases, debt
                             documents, tax obligations, insurance policies,
                             contracts

OPERATING ECONOMIC           arises dynamically from operations — unexpected
CONSEQUENCE                  repair, turn delay, concession, vacancy loss
```

They meet in one story, and neither is the whole of it:

```text
normal governed expectation  +  unexpected operating consequence
    =  the actual economic story of the property
```

## Every domain has two readers — the UI and Ask Spine

**Ask Spine is not a feature and not an AI layer. It is a permanent interface
contract of Property Spine** — the conversational interface to the same canonical
truth and governed actions the application uses. Full doctrine: `PHILOSOPHY.md`
§40, where eleven rulings are frozen and numbered for citation.

This is the shape every governed domain is built into. It is the domain's own
structure, not an integration diagram:

```text
                 CANONICAL DOMAIN TRUTH
                          │
                 CANONICAL SERVICE
                          │
                 CANONICAL DOMAIN READ
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        OPERATOR UI               ASK SPINE
```

Same truth, two projections, neither derived from the other. **Ask Spine never
scrapes a screen, retrieves over rendered UI, or queries arbitrary tables hoping
to understand the schema.** A conversational layer that retrieves over the UI has
made the UI a source of truth, which §7 forbids.

**A domain is not done until Ask Spine can read it** (§33, §40.2). Not "the app
can display it" — a person can *ask* for it without knowing where it lives. The
build sequence, and the order is load-bearing:

```text
canonical truth → writer → canonical read → compact standing projection
                → operator UI → Ask Spine registration → browser proof
```

Registration is a rung, not a follow-up ticket. A domain browser-verified in the
UI but unreadable by Ask Spine is done as a *screen* and not done as a *domain*.
That cost is part of building the domain and stays in the estimate.

**One conversational architecture, every role.** Technician, leasing agent,
property manager, asset manager and owner get different authority, scope and
verbs over the *same* Spine truth. What varies is entitlement and compression
(§37) — never the source. Do not build a per-role assistant; that is "a nicer
module per user" in a new medium.

The rule that governs every implementation:

```text
THE MODEL GETS FLUENCY OVER WORDING. IT NEVER GETS AUTHORITY OVER
ATTRIBUTION, SOURCE AUTHORITY, CURRENT STATE, RELEVANCE, OR CONFLICT.
```

The rulings a builder trips over first:

- **Facts carry authority in their shape** (§40.4). An envelope, never a bag:
  `domain · concept · value|truth_state · source_authority · provenance · as_of ·
  entitled reference`. `governed_read` outranks `transcript_claim`, `email_claim`,
  `user_assertion`. Lower authority may **explain** canonical truth, never replace
  it — *"I think the taxes were paid"* does not move `city_payment =
  NOT_ESTABLISHED`.
- **Truth walls are executable contracts** (§40.5), declared as data with the
  domain's collapsing vocabulary — *paid, current, covered, filed, funded,
  complete, done*. `escrow funded ≠ City paid` · `filed ≠ paid` ·
  `financing established ≠ coverage established` · `assessment ≠ liability`. The
  test suite is generated from the declaration, which is what makes it survive the
  next domain.
- **Compact standing projection per domain** (§40.6) — current position, important
  unknowns, next milestone — cheap enough to gather routinely so cross-domain
  questions need no intent router. Detail is a second read. **This constrains
  schema**, not just reads.
- **Four silences never collapse** (§40.7) — `NOT_ESTABLISHED` (the property),
  `READ_FAILED`, `READ_TIMED_OUT` (Spine), `QUIET`. Composite silence is health
  **only if every required reader returned**, computed in code, never prompted.
- **Entitlements precede intelligence** (§40.8). Unentitled facts never enter model
  context; a prompt is not a security boundary. References are minted server-side
  from entitled facts — the model is never given a record id, because a model
  holding an id can compose a link Spine did not resolve.
- **Reads required, actions granted** (§40.9). When Ask Spine acts it is a new
  surface over an existing canonical writer, never a parallel path to the same
  durable object. The read door does not quietly become the write door.
- **Retrieval ≠ causal explanation** (§40.10). *"What is our debt service?"* may
  ship with a domain's first build; *"why did it increase?"* requires recorded
  causal linkage and must not be implicitly promised. Say which one shipped.

**Enforced by `tests/gate_ask_spine_readers.js`, not by memory** (§40.11). It
discovers domains from their canonical standing reads, so a domain that lands
without registering goes red on its own.

## Same truth, four compressions

> ⚠ **Three different fours. Do not merge them.** The section above lists four
> **operating doors** (Leasing · Management · Maintenance · Asset Management) —
> *surfaces in the staff product* — and, inside the fourth of those, four
> **rooms** (Capital Stack · Property Expenses · Projects & CapEx · Compliance)
> — *navigation within one door*. This section lists four **compressions**
> (Staff · Management · Accounting · Owner) — *altitudes of reading*. "Management"
> appears in more than one and means something different each time. A door is
> where work is done; a room is where you go inside a door; a compression is how
> truth is said. Asset Management is a door; Owner is a compression that will
> later get its own surface.

Staff, Management, Accounting and the Owner are doing four different jobs over
**one** governed system. They are not four datasets and not four dashboards.

```text
STAFF        operate the property; record what happened at the moment of work
MANAGEMENT   resolve the operation; coordinate obligations and exceptions
ACCOUNTING   prove the economics; recognition, reconciliation, close, support
OWNER        steer the Deal; understand the economic story, decide what needs
             their judgment
```

Precedent in this repo: `dated_positions.js` — *"One service. Four
interpretations."* Same move, one altitude up.

**The person closest to the fact records what happened. Spine carries that fact
upward; authority adds meaning, not transcription.** A technician says "needs
another flooring run, vendor quoted $1,840" — that is operating language, not
accounting. Economic authority confirms what it *means*. The authority never
retypes the number: **recognition over re-entry**, and the meaning walks back to
the statement, quote or photo it came from. Where the source carries no amount,
the amount stays unknown. No invented estimate.

**At owner altitude:** the owner surface may only assert a cause it can walk back
to a recorded fact. What it cannot support stays visible uncertainty; it is never
smoothed into a narrative. A convincing unsupported story is worse than a blank.

## Reserved names

Do not spend a broad name on a narrow thing.

```text
Deal Setup                  onboarding machinery: give Spine enough starting
                            truth about a Deal that it can begin operating one
Asset Management            an OPERATING DOOR — the fourth, beside Leasing,
                            Management and Maintenance. Staff/operator side.
                            Where the economic structure and economic
                            performance of the property become operable.
                            NOT the owner surface. See "Four operating doors".
Owner / Investor Surface    RESERVED — the later, different audience that
                            consumes the compressed economic story. Possibly a
                            different login. Do not spend it on a staff screen.
Opening Tenancy Position    lease and occupancy, from a rent roll, as of a date
                            (shown to people as "Lease & occupancy established")
Opening Operating Position  RESERVED — the composed opening state: tenancy +
                            bank + debt + taxes + insurance + contracts
Opening Accounting Truth    RESERVED — opening GL and subledger balances
```

**A name is reserved in the source or it is not reserved.** Renaming rendered
text while routes, modules and identifiers keep the old word reserves nothing —
the next person reads the code. When Build 1B shipped as "Asset Management" and
was corrected the next day, the routes, the module, the DOM ids and the function
prefix all moved with it.

## Exposure — a contract, not a table

Exposure is *a consequential thing Spine cannot yet stand behind*. It appears at
different altitudes and is **not** one storage primitive; do not build a
universal `exposure` column. Any domain participating in the owner compression
must be able to answer:

1. what is this about
2. what is the possible magnitude, **if known** — unknown is a valid Exposure,
   never zero
3. why can Spine not stand behind it
4. what would resolve it
5. as of when was this observed
6. who owns resolving it — or `UNASSIGNED`

Storage stays domain-specific. The owner layer consumes the contract.

## Non-negotiables (see PHILOSOPHY.md for full text)

- **Honest blank beats confident wrong** (§5). Never fake a number, status, owner, dispatch, proof, or healthy state. Show missing as missing; `UNASSIGNED` when no owner.
- **Live-first operator surfaces** (§19–20). Never fixture-fallback, mint a demo session, or show sample data in a signed-in operator workflow. Seeds are QA/demo, never the live truth path.
- **One canonical architecture** (§17). Identical product meaning across prod / Solo / Demo Building / QA. "Demo data may exist. Demo paths may not."
- **Solo-first, never Solo-special** (§22). No `if property is Solo` business branches.
- **Server-derived identity & authority** (§21). The browser requests; the server decides. A client-provided property ID is never authority.
- **Capture once, read everywhere** (§7). One canonical service write updates board, Person Card, and reporting projections.
- **Every domain has two readers — the UI and Ask Spine** (§40). Ask Spine is a permanent interface contract, not an AI layer: it reads the same canonical reads the screens do, never scrapes a screen or queries arbitrary tables. The model gets fluency over wording, never authority over attribution, source authority, current state, relevance, or conflict. A domain is not done until it is registered (§40.2).
- **Classify every component 1–4** (§18) with an exact removal condition for anything temporary.

## Before any feature — the Eight Questions (§31)

1. What real-world fact is recorded? 2. What canonical service records it? 3. Who is the authenticated actor, and what property can they operate? 4. What durable object changes? 5. What immutable history remains? 6. What other surfaces read it automatically, **including Ask Spine** — what is the compact standing projection? 7. What happens when ownership/proof/live data is missing? 8. What class is every new component, and what removes any temporary part?

Question 6 is where domains get forgotten. The concrete form, asked at the **first
schema conversation** and not after the UI ships: *"what must this domain expose so
an entitled person can text Spine from a meeting and get its current position, what
is unknown, and what needs their attention?"* If the schema cannot answer that
cheaply, the schema is not finished (§40.6).

## Definition of Done (§33)

Proof ladder: Reported → Locally exercised → Built-but-dormant → **Proven** (real DB + real HTTP) → **Browser verified**. For operator workflows, browser verification is part of "done." Do not call something live/deployed/enforced without the matching evidence.

**And a domain is not done until Ask Spine can read it** (§40.2) — its governed standing state available to entitled users, registered, and proven in the browser. This is a rung on the ladder, not a note beneath it: a domain browser-verified in the operator UI but unreadable by Ask Spine is done as a **screen** and not done as a **domain**. Say it that way in the receipt. Enforced by `tests/gate_ask_spine_readers.js` (§40.11).

## Build discipline (§30)

One narrow, real, vertically complete slice at a time: inspect current source → confirm live schema/runtime → classify components → implement one canonical slice → prove against real Postgres → prove through real HTTP → **register the Ask Spine standing read** → verify in the browser → preserve a receipt/screenshot.

"Vertically complete" includes the conversational reader (§40.2). A slice that stops at the screen is horizontally complete.

## How not to fool yourself

Every line here was earned by a real miss in this repo. They are about **method**;
the doctrine above is about product.

### Green is a claim about what was measured

A passing test asserts what it *looked at*, not what you meant. Before believing one,
say what it would have missed.

- A browser proof once passed **13/13 while the browser showed the sign-in screen** —
  it read `innerText` from an element that never rendered, and `innerText` silently
  falls back to `textContent`. **Assert the app actually loaded, and read only
  layout-aware text.** Look at the screenshot, not the output.
- Then it happened again in a form layout-awareness does not catch: Deal Setup
  shipped writing every message — success, failure, refusal — into `#receipt`,
  which lives in the app shell **underneath** a `position:fixed` full-screen
  overlay. Real element, real text, real box, `display:block`, and **invisible**.
  Two rent-roll uploads in a row looked like they did nothing. `innerText` read it
  perfectly.
  **Rendered is not visible.** Ask the DOCUMENT, not the element:
  `document.elementFromPoint` at the element's centre must return that element or
  something inside it. Anything else is covered, and covered is invisible whatever
  the styles say.
- A proof that reaches past the product to assert the product is testing its own
  reach. The first version of that visibility test called the app's toast function
  directly, found it was not on `window` (the surface is inside an IIFE), silently
  skipped, and reported the channel broken. **Provoke a real refusal through the
  real path.**
- In a full-screen-overlay app, an unscoped selector is a coin flip.
  `button:has-text('Review')` matched a button in the shell *underneath* the panel.
  Scope selectors to the surface under test.
- "Every source-governance gate passes" means *those gates*, not "the tree is clean."
  Say which.

### A count is a claim about a search, not about the code

Before writing "there are N of X":

1. **Search the whole repo, not a subfolder.** `server.js` is 3,000+ lines at the root
   and defines routes. A `src/`-only search silently misses it — that is exactly how
   Build 0 reported "four property-creation doors" when there were five.
2. **State where you looked and where you did not.** A bounded scope is fine; an
   unstated one is a false claim.
3. **A gate must scan the same scope as the claim it asserts.** A gate that scans less
   than it asserts is worse than no gate, because it launders the gap into evidence.
4. Strip comments before scanning. *A mention is not a guard* — prose can satisfy or
   alarm a naïve pattern.

### Before you change, gate or remove a route

1. **Grep the app (`property-spine-app/index.html`) for callers first.** "Nothing in
   `src/` calls it" is not "nothing calls it." Gating `team-invites` without this
   check broke the live invite flow.
2. **Source can prove a consumer exists; it cannot prove one does not.** The shared
   operator key is held outside this repo. Absence of a caller here is not absence.
3. **Any change requiring a new header or field is app-first**, with the app sending it
   alongside the old shape. The new API may require the compatibility app; never the
   reverse (Open Ruling 2).

### Check what has already been ruled

Parked branches and open PRs carry **frozen decisions**. Search them before deciding
something they already decided — `docs/`, `docs/build1/INTEGRITY_GAPS.md`, open PRs.
Example: the rule that *body actor fields are rejected, not ignored* was already frozen
in PR #38 and was contradicted by accident.

### Four rules this repo learned the hard way

- **Authentication answers WHO may call a tool. It does not answer WHERE its output may
  land.** A correctly authenticated caller may still have no business writing there.
  Synthetic/fixture writes need a data-context perimeter, not just a session.
- **A refusal a user can see is product copy.** "A property with this identity may
  already exist" is our vocabulary for our machinery, shown to someone who typed an
  address. A refusal must be sayable, and must name a next step. Only the browser rung
  catches this — JSON always looks fine.
- **Repair authority is narrower than management authority.** A path that exists to
  reconcile legacy data is platform repair, not a feature. Give it the narrower actor
  and a retirement condition tied to the data being reconciled.
- **A compatibility bridge is not a destination.** Say so in the receipt, name what
  removes it, or "it works now" quietly becomes the architecture.

### A rename is a contract change

A blunt identifier sweep during migration 159 renamed an API response key and
not the app that read it. Nothing threw. The deal page simply showed "Setup in
progress" for a property whose position **was** established, and only a browser
caught it — the HTTP proof was asserting the database, not the response shape.

**An API output key is a contract.** When you rename one, pin it with an
assertion that reads the key by name, or the next sweep breaks it silently too.

### When you find an adjacent defect

Real, in the blast radius, same defect class → fix it and say so. Otherwise **record it
and move on.** Three slices of authority work found an unauthenticated admin route, an
unnamed fixture door and a gate that under-detects by 37 files. Each was real; chasing
all of them turns a product build into a harness-inventory project.

## Repo orientation

Node/Express API. `npm start` runs `prestart` then `server.js` (port 3000). DB is Neon Postgres (`DATABASE_URL`). Deploys to Render on merge to `main`. See `README.md` for module layout and `docs/` for architecture, auth, data-model, domains, and deployment.

**A deploy does NOT migrate.** `prestart` runs `migrations/migrate.js` in **verify-only**
mode: every migration file must already be in the ledger, or the service **refuses to
start** and names the pending file. Ship a migration and hit deploy and you get a *failed
deploy* — Render keeps the previous instance live, so the API looks fine while the new
schema is simply absent. Releasing schema is a separate, deliberate act:

```
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<what you just read from the ledger> \
  EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply
```

`EXPECTED_LEDGER_CEILING` exists so a release cannot be run by someone who has not read
the ledger. See `docs/THREAD_HANDOFF.md` §3 — this trap has now cost time twice.
