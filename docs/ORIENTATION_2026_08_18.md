# Property Spine — Orientation

**A map, not a status report.** Where things live, what is load-bearing, and
which traps are still in the tree. Read `THREAD_HANDOFF.md` for what is
*deployed*; read `PHILOSOPHY.md` for what the product *is*. This is for
finding your way around between those two.

Measured 2026-08-18 against `property-spine-api@3efffb6` /
`property-spine-app@c6769ba`. Every count below came from the repo, not from
another document.

---

## 1. Two repositories, very different shapes

```text
property-spine-api    Node/Express. 711 js files, ~119k loc under src/,
                      server.js 3,595 loc AT THE ROOT and it defines routes.
                      562 distinct route paths. 170 migrations. 291 tests.
property-spine-app    ONE file. index.html is 32,768 lines / 2.3 MB,
                      plus 24 sidecar .js modules and ~50 test files at
                      the repo root (not in tests/).
```

**`server.js` is why repo-wide search matters.** A `src/`-only grep misses
3,595 lines of route definitions. This is the exact mistake that produced
"four property-creation doors" when there were five.

### ⚠ There is a stale copy of the frontend inside the API repo

```text
property-spine-api/property-spine-app     a FILE, 7,777 lines, last touched
                                          in PR #80. Not a directory.
property-spine-app/index.html             the real app, 32,768 lines
```

`CLAUDE.md` says *"Grep the app (`property-spine-app/index.html`) for callers
first."* From inside the API repo that path does not exist — but the bare name
`property-spine-app` resolves to this blob, which is 24% of the app and months
old. It contains **zero** occurrences of `_egAuthScope`, `selectProperty`,
`crumbPropertyName` or `psRruStatus`: it predates the entire property-authority
and Rent Roll work.

Grep it while checking "does anything call this route?" and you get a clean,
confident, wrong "no". That is the precise failure the rule it sits under
exists to prevent. **Search `/home/user/property-spine-app/index.html`.**

## 2. Where truth lives

```text
src/tenancy/       leases, occupancy, dated positions, inventory retirement
src/leasing/       forward leasing, cycles, pricing, prospects   (42 files)
src/asset/         the fourth door's domains — tax, insurance, debt,
                   equity, utility, contracted services, compliance (49)
src/money/         charges, payments, bank, exposure, reporting   (41)
src/maintenance/   work orders, turnovers, triage                 (25)
src/identity/      sessions, property authority, teams, admin     (31)
src/surfaces/      PROJECTIONS of domains, never domains. A surface
                   composes canonical reads for one screen and owns no
                   truth — the Ask Spine gate excludes this directory
                   by declaration for exactly that reason.
src/agent/         Ask Spine — the conversational reader
src/shared/        obligation engine, snapshot loader, transitions
```

**The one to internalise:** `src/surfaces/` owns nothing. If you are looking
for where a fact is decided, it is not there.

## 3. The eight governed domains, and who can read them

The Ask Spine gate discovers domains from filename suffixes
(`*_position_read.js`, `*_establishment.js`, `*_read.js`) rather than from a
list, so a domain that lands without registering goes red on its own.

```text
DOMAIN               CANONICAL STANDING READ                   ASK SPINE
compliance           src/asset/compliance_read.js              registered
contracted_service   src/asset/contracted_service_position_read.js  registered
debt                 src/asset/debt_position_read.js           registered
equity               src/asset/equity_position_read.js         registered
tenancy              src/tenancy/tenancy_position_read.js      registered
utility              src/asset/utility_position_read.js        registered
insurance            src/asset/insurance_position_read.js      PENDING
tax                  src/asset/tax_position_read.js            PENDING

  8 domains · 6 registered · 2 pending · 0 waived
```

Both pending entries name an owner and the condition that clears them — the
gate asserts that they do. `_document_read.js` and `_funding_read.js` are
deliberately NOT standing reads; that is how the tax/insurance funding
boundary stays out of the economic chain.

## 4. The authority chain, in one screen

Everything property-scoped resolves the same way. There is no second path.

```text
POST /operator/properties/select { property_id }      the REQUEST
   the ONE place a body property_id is legitimate
   issueStaffSession re-reads property_team_assignments FOR SHARE
      ↓ grants, or refuses 403
a NEW staff_sessions row bound to ONE property             the GRANT
   the prior session is revoked — mint-then-revoke, one txn
      ↓ session_token returned ONCE, in the body
every scoped read: resolveStaffSession(x-staff-session)
      → req.operator.property_id
```

`staff_sessions.property_id` is a single column, so **switching is minting**.
There is no active-property preference that can drift from the session.
Sessions store `sha256(token)` in `token_digest` and, since migration 070, no
raw token at all.

Full trace, including what this rules out and what it does not:
`docs/PROPERTY_IDENTITY_AUTHORITY_TRACE.md`.

**In the app**, two Class 1 modules sit over this and you need both in your
head: the sealed live loader inside `index.html` (holds the token, owns
`loadResource`, 48 registered live resources) and
`authoritative-property-context.js` (overwrites every property label from a
MutationObserver). The second one is what puts the property name on the glass
in a signed-in session — not `crumbPropertyName()`.

## 5. Running it here — two environment traps that cost real time

The container arrives unable to run the gates, and both failures look like
product defects:

```text
git fetch --unshallow      conversation_intent_extraction.test.js needs
                           HEAD~1 to prove an extraction is verbatim. In a
                           shallow clone it reports NOT PROVEN and exits 3,
                           which HALTS the runner — 21 gates never run.
npm install                node_modules is empty. meeting_evidence_ingress
                           dies on 'Cannot find module express', exit 1,
                           and again the runner stops.
```

With both done: **`npm run verify` → 35/35 source-governance gates pass.**

That is a claim about *source governance* — grep-level rules over the source
tree. It is not a claim that the database is right, that HTTP behaves, or that
anything renders. Those are separate rungs (`docs/DB_HARNESS_ISOLATION.md`).

```text
DATABASE_URL        absent here — no real-Postgres proof
ANTHROPIC_API_KEY   absent here — no Ask Spine browser proof
Chromium/Playwright PRESENT — browser proofs DO run
                    /opt/pw-browsers/chromium-1194/chrome-linux/chrome
                    playwright resolves from property-spine-api/node_modules
```

A local Postgres for falsifying a DB tool, without touching anything real:

```bash
mkdir -p /var/tmp/pgtest && chown postgres /var/tmp/pgtest && chmod 700 /var/tmp/pgtest
su postgres -s /bin/bash -c "PATH=/usr/lib/postgresql/16/bin:\$PATH \
  initdb -D /var/tmp/pgtest/data -U postgres"
su postgres -s /bin/bash -c "PATH=/usr/lib/postgresql/16/bin:\$PATH \
  pg_ctl -D /var/tmp/pgtest/data -o '-p 55432 -k /var/tmp/pgtest' -l /var/tmp/pgtest/pg.log start"
```

## 6. What is parked, and it is a lot

```text
123 remote branches on the API repo
 13 open PRs, nine of them titled "⛔ … DO NOT MERGE", from 2026-08-04..09
```

Those drafts carry **frozen decisions**, which is why `CLAUDE.md` says to
search them before deciding something they already decided. PR #38 is the one
that froze *body actor fields are rejected, not ignored* — it is still open.

`docs/` holds 134 markdown files. Recency is the only cheap signal of which
are current:

```bash
for f in docs/*.md; do echo "$(git log -1 --format=%ad --date=short -- "$f") $f"; done | sort -r | head -20
```

## 7. The diagnostics added today

Both are Class 3 and both are falsified in both directions — they report the
finding when it is present and refuse to call its absence an answer.

```text
property-spine-app/tools/property_identity_truth_table.console.js
    paste into the console of an affected signed-in page. Read-only.
    Prints property + sha256 digest fingerprint + freshness per source,
    and a COMPUTED verdict. Proven by
    property_identity_truth_table.browser.js — six scenarios, 38
    assertions, real Chromium, real HTTP.

property-spine-api/tools/property_authority_preflight.js
    DATABASE_URL="…" node tools/property_authority_preflight.js --user-like mike
    Read-only, PROVEN read-only before its first read, so it is safe in
    the Render Shell. Prints properties, assignments (flagging INACTIVE),
    live sessions per user, and whether a named operator can be
    credentialed at all.
```

They share one join key. `digest_fp` is the first 12 hex of
`sha256(token)` on both sides, so the browser table and the database table
name the **same session row** without either ever holding a token.
