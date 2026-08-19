# Leasing end-to-end harness

Drives the real leasing path against **real `server.js`, real Postgres and real
HTTP** — no stubs, no mocks, no in-process shortcuts. It exists because reading
this code does not tell you whether it runs: every defect these harnesses found
was invisible in source and obvious the moment the path was driven.

## What each file is

| file | what it proves |
|---|---|
| `leasing_path.e2e.js` | the clean path: lead → tour + outcome → application at an exact bed → governed price → instrument → resident signs → company signs → executed lease → tenancy → five downstream reads |
| `leasing_hostile.e2e.js` | ten deliberate falsifications; every one must be REFUSED |
| `leasing_reconciliation.e2e.js` | **the drift gate** — five lifecycle states × four surfaces × nine governed concepts; every surface that answers a concept must give the same answer |
| `leasing_standing_probe.e2e.js` | Review vs the standing read, next-action code/state/blocker |
| `leasing_ask_spine.e2e.js` | Ask Spine routing, entitlement, addressing, the four silences |
| `resident_signing.browser.js` | real Chromium at a phone viewport on the real tenant page; the resident executes the instrument and it lands in Postgres |
| `leasing_e2e_lib.js` | shared harness (session, fixtures, path to a sent packet) |
| `apply_migrations.sh` | builds the schema from the real migration chain; idempotent, resumes from the ledger |
| `property_fixture.sql` | the Skyline-SHAPED test property: a unit let by the bed, its operator, and a lease configuration |
| `preconditions/` | the rows a few data-dependent migrations need before they will apply |
| `release_reconcile.js` | 177–187 against a REAL ledger; refuses to guess what is live |
| `release_rehearsal.sh` | build to a live ceiling, apply only the release set, then run these same proofs |

## Fixtures are fixtures

`fixtures.sql` and `instrument_fixture.js` supply a published pricing version, a
property lease configuration, and a stand-in governing lease body whose sha256 is
a real hash of its own bytes.

**None of it is Skyline truth, production readiness, or legal sufficiency.** The
governing lease body is not a lease and has no legal effect. These exist only so
the mechanism can be exercised where a business fact is unavailable.

## Running it

```sh
export E2E_DATABASE_URL=postgres://postgres:PASS@127.0.0.1:5432/spine_e2e
# `createdb spine_e2e` prompts for a password wherever auth is required; use
# the connection string, which is the same credential the rest of these use.
psql "${E2E_DATABASE_URL%/*}/postgres" -c "create database spine_e2e"
./tests/e2e/apply_migrations.sh                    # builds from the REAL chain
psql "$E2E_DATABASE_URL" -f tests/e2e/fixtures.sql
node tests/e2e/instrument_fixture.js
./tests/e2e/boot.sh &                              # real server.js on :3000
node tests/e2e/leasing_path.e2e.js
node tests/e2e/leasing_hostile.e2e.js
node tests/e2e/resident_signing.browser.js         # needs Playwright + Chromium
```

Deliberately NOT named `*.test.js`: `run_harnesses.sh` globs that pattern and
reads exit codes, and these need a live server, a seeded database and (for the
browser rung) Chromium. Including them there would turn the suite red on any
machine without all three. Same reasoning as the existing `*.browser.js` files.

## The reconciliation gate

`leasing_reconciliation.e2e.js` is the one to keep green. It does not compare
prose — it asks each surface what it believes about a CONCEPT (the exact
space, whether the resident signed, what is blocking) and fails when two
surfaces answer differently.

**Abstention is not disagreement.** A surface that does not carry a concept
returns undefined and is skipped for it. Application Review abstains on
`position` and `owner` because relationship stage and obligation ownership
belong to other owners and Review has never claimed them. That distinction is
the design: forcing every surface to answer everything would push business
meaning into surfaces, which is the failure this gate exists to catch.

**A disagreement is never fixed by adding logic to a surface.** It means one
surface bypassed the owner of that concept. The fix is to make it read the
owner. Both fixes made while building this gate were exactly that: Review was
given the exact space from `spaces` and the execution timestamps from the
packet it already loaded.

It has been FALSIFIED TWICE and went red both times, naming the surface that
lied: Review reporting the unit where the bed belongs, and the standing read
hiding a resident signature. A gate that has never been seen to fail is not
known to be measuring anything.

## What it does not prove

The operator shell. Its live loader is pinned to `PRODUCTION_ORIGIN` by
deliberate design — *"NO test mode, NO override controls, NO token injector.
Frozen."* Pointing it at a local API would mean editing the session-confirmation
path. Not done, on purpose.


## Landing: reconcile, then rehearse

Two tools for getting this branch into production without losing what it proved.

**`release_reconcile.js`** answers the eight release questions per migration —
what fact, dependencies, already released, still required, superseded,
collides, additive, which proof depends on it. Three of those are facts about
production and it **refuses to guess them**, printing `UNKNOWN — needs ledger`
and exiting non-zero. Give it the real ledger and it becomes a decision:

```sh
node tests/e2e/release_reconcile.js --ledger-file live_ledger.txt
node tests/e2e/release_reconcile.js --db "$PROD_READONLY_URL"
```

It also emits a **preflight query per migration** for the only three things
that can refuse a migration against real rows: a UNIQUE index over existing
duplicates, a NOT NULL added to a populated table, a CHECK over rows that
already violate it. Those must be run against production before release. All
25 generated queries were executed to prove they parse — a preflight check
nobody can run is one that gets skipped rather than fixed.

**`release_rehearsal.sh`** builds a schema to a stated live ceiling, applies
only the proposed release set, and leaves it ready for these proofs:

```sh
./tests/e2e/release_rehearsal.sh 181 182,183,184,185,186,187
psql "$E2E_DATABASE_URL" -f tests/e2e/property_fixture.sql
psql "$E2E_DATABASE_URL" -f tests/e2e/fixtures.sql
node tests/e2e/instrument_fixture.js
E2E_DATABASE_URL=... ./tests/e2e/boot.sh &
# then every proof above
```

This matters because the e2e schema is built from empty straight to the top,
so a migration is never applied onto a schema that stopped somewhere else
first. Production HAS stopped somewhere else.

**What the rehearsal still does not prove:** its schema is empty of production
data, so it cannot exercise the three data preconditions above. A green
rehearsal plus unrun preflight queries is not a release decision.
