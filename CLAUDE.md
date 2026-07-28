# Property Spine — API

**Before doing anything, read [`docs/THREAD_HANDOFF.md`](docs/THREAD_HANDOFF.md).** It is the current deployed state — what is live, what is draft, what is blocked, and the traps that cost time. Do not reconstruct it from git history.

**Before modifying any product behavior, read the governing doctrine: [`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md).** It defines what the product is and how to decide whether a feature belongs. It is doctrine, not style.

## North Star

Record the truth at the moment of work, so reporting becomes a read, not a reconstruction. The final deliverable is the monthly investor & lender **reporting package** (see `docs/PHILOSOPHY.md` §16), generated only after a human reviews and presses GENERATE.

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

## Repo orientation

Node/Express API. `npm start` runs migrations (`prestart`) then `server.js` (port 3000). DB is Neon Postgres (`DATABASE_URL`). Deploys to Render on merge to `main`. See `README.md` for module layout and `docs/` for architecture, auth, data-model, domains, and deployment.
