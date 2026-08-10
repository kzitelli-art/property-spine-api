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

## Non-negotiables (see PHILOSOPHY.md for full text)

- **Honest blank beats confident wrong** (§5). Never fake a number, status, owner, dispatch, proof, or healthy state. Show missing as missing; `UNASSIGNED` when no owner.
- **Live-first operator surfaces** (§19–20). Never fixture-fallback, mint a demo session, or show sample data in a signed-in operator workflow. Seeds are QA/demo, never the live truth path.
- **One canonical architecture** (§17). Identical product meaning across prod / Solo / Demo Building / QA. "Demo data may exist. Demo paths may not."
- **Solo-first, never Solo-special** (§22). No `if property is Solo` business branches.
- **Server-derived identity & authority** (§21). The browser requests; the server decides. A client-provided property ID is never authority.
- **Capture once, read everywhere** (§7). One canonical service write updates board, Person Card, and reporting projections.
- **Classify every component 1–4** (§18) with an exact removal condition for anything temporary.

## Before any feature — the Eight Questions (§31)

1. What real-world fact is recorded? 2. What canonical service records it? 3. Who is the authenticated actor, and what property can they operate? 4. What durable object changes? 5. What immutable history remains? 6. What other surfaces read it automatically? 7. What happens when ownership/proof/live data is missing? 8. What class is every new component, and what removes any temporary part?

## Definition of Done (§33)

Proof ladder: Reported → Locally exercised → Built-but-dormant → **Proven** (real DB + real HTTP) → **Browser verified**. For operator workflows, browser verification is part of "done." Do not call something live/deployed/enforced without the matching evidence.

## Build discipline (§30)

One narrow, real, vertically complete slice at a time: inspect current source → confirm live schema/runtime → classify components → implement one canonical slice → prove against real Postgres → prove through real HTTP → verify in the browser → preserve a receipt/screenshot.

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
