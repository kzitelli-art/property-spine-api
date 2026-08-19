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
| `resident_signing.browser.js` | real Chromium at a phone viewport on the real tenant page; the resident executes the instrument and it lands in Postgres |
| `leasing_e2e_lib.js` | shared harness (session, fixtures, path to a sent packet) |

## Fixtures are fixtures

`fixtures.sql` and `instrument_fixture.js` supply a published pricing version, a
property lease configuration, and a stand-in governing lease body whose sha256 is
a real hash of its own bytes.

**None of it is Skyline truth, production readiness, or legal sufficiency.** The
governing lease body is not a lease and has no legal effect. These exist only so
the mechanism can be exercised where a business fact is unavailable.

## Running it

```sh
createdb spine_e2e && ./apply_migrations.sh        # a schema built from the real chain
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

## What it does not prove

The operator shell. Its live loader is pinned to `PRODUCTION_ORIGIN` by
deliberate design — *"NO test mode, NO override controls, NO token injector.
Frozen."* Pointing it at a local API would mean editing the session-confirmation
path. Not done, on purpose.
