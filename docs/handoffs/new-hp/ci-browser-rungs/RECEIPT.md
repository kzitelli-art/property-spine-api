# CI executes the combined-app browser rungs — receipt

Lane `claude-opus/ci-browser-rungs-20260914` (API only; the app repository was
read at a pinned commit and **not edited**).

Baseline: API `89b2d50a2c3abd6b8b5798b6d22869fef703f101` on `claude/board-20260914`
· app `595e86538eae1ea1ee76409a564bb5664393c15b` on
`claude/coupled-browser-acceptance-20260914` (pinned there because the two
harness tools — `tools/coupled_browser_runner.cjs`, `tools/verify_served_assets.js`
— exist at that commit; `1a5f257` does not carry the runner).

No product code. No migration. No deployment. No production read or write.

## The first red

**(a) The SKIPPED line, in the baseline's own CI log.** Run 533
(`34835519670`, head `f61d2c21`, the same workflow file as the baseline),
job `103948326783`:

```
2026-09-14T10:57:54.7913195Z  ── browser: inventory correction      SKIPPED (needs Chromium and E2E_APP_ROOT=<operator app checkout>)
2026-09-14T10:57:54.9599793Z  ── browser: two-step execute          SKIPPED (needs Chromium and E2E_APP_ROOT=<operator app checkout>)
2026-09-14T10:57:56.6534023Z    ALL REQUIRED ASSERTIONS PASSED — cleanup must also succeed
```

Two rungs skipped and the run still reported all required assertions passed —
because neither skip set `FAILED`, and neither was named in `SKIPPED` either,
so the `⚠ NOT RUN` line never printed. A rung that is always skipped is a rung
nobody has.

The coupled rent-roll rung does not appear at all: it had never been part of
`verify_all.sh` in any form, only ever run by hand
(`current-rent-roll-reconciliation/COUPLED_BROWSER_ACCEPTANCE_20260914.md`).

**(b) Why the coupled proof cannot be run here without the runner — stated
precisely rather than demonstrated.** Two independent reasons, both evidenced:

1. **It would dial production.** `index.html:10737` at the pinned app commit
   hardcodes `var PRODUCTION_ORIGIN = 'https://property-spine-api.onrender.com';`
   and the proof loads that exact file (`current_rent_roll_reconciliation.browser.js:77`
   → `page.goto('http://127.0.0.1:${APP_PORT}/index.html')`). Without the
   runner there is no `ctx.route` interception, so the sealed live loader —
   sign-in, session verify, property list — really reaches Render. That is a
   production read, which this lane is forbidden. **The un-transported run was
   therefore not attempted.** This is not an incidental obstacle: it is the
   entire reason the runner exists, so "it fails without the runner" is a
   property of the design, not a discovery.
2. **This container cannot host the owned server the rung needs anyway.**
   `tests/e2e/proof_boundary.js` `portFree()` binds
   `listen({ port, host: "::", ipv6Only: false, exclusive: true })`; this
   container has no IPv6, so `create` refuses with
   `PROOF BOUNDARY REFUSED: listen EAFNOSUPPORT: address family not supported :::<port>`.
   Measured four ways — every explicit `host: "::"` bind fails EAFNOSUPPORT
   while the implicit default (which falls back to `0.0.0.0`) succeeds. This is
   a limitation of this container, **not** of the runner or of GitHub's
   `ubuntu-latest`, where `proof_boundary.js create` demonstrably works in every
   green run. No harness file was edited to work around it.

So CI is where this rung gets its first execution, and the delivered run is
both the proof and the first observation.

**(c) And the first execution found a real one.** CI run 536
(`34838241888`, `50c49a92`) turned every SKIPPED line into a real run, and the
inventory-correction rung — which had **never** run in CI — failed:

```
2026-09-14T11:29:16.7456358Z ── browser: coupled rent-roll (app 595e865) PASS
2026-09-14T11:29:16.7692152Z ── coupled transport receipt (app 595e865) PASS
2026-09-14T11:29:44.9116210Z ── inventory correction hardening     PASS
2026-09-14T11:30:16.6073712Z ── browser: inventory correction (app 595e865) FAIL
      locator.click: Timeout 30000ms exceeded.
      Call log:
        - waiting for locator('.crumb-back')
          - locator resolved to <button type="button" aria-label="Back" class="crumb-back" onclick="goBack()">…</button>
        - attempting click action
          60 × waiting for element to be visible, enabled and stable
            - element is not visible
          at openRecords (…/tests/e2e/inventory_correction.browser.js:65:91)
```

`inventory_correction.browser.js` opened the app, found `.desk-card-management`
not visible, fell back to `.crumb-back` — and that was not visible either,
because the combined app puts "Choose a property" above the shell at z-index
3900 and **no desk is reachable until a property is chosen**. The file contained
zero references to `livePropertyLayer`, while `two_step_execute.browser.js`
already handled it.

This is precisely the class the assignment names: a defect that was invisible
while the rung was skipped, and obvious the first time it ran.

**Correction:** the same visible step `two_step_execute.browser.js` already
performs, added to `inventory_correction.browser.js` as one isolated block
before the desk lookup — choose the property the server marked as this
session's, once, only when the layer is shown. The document is asked with
`elementFromPoint` whether the choice is actually reachable before it is
clicked, because rendered is not visible. Nothing in the app is patched, and
no other assertion in that proof changed.

## What changed

| file | class | what |
|---|---|---|
| `tests/e2e/app_pin.txt` | 1 | NEW. The one declared app commit: `sha`, `branch`, `repo`. Removal condition: only if the two repositories merge, at which point the pin is the checkout. |
| `tests/e2e/verify_all.sh` | 1 | Reads the pin; compares it to `E2E_APP_ROOT`'s HEAD; `app_rung_ready` / `app_rung_skip_reason` replace three copies of the same ad-hoc condition; new coupled rung; every app rung label carries the app sha; the closing banner states the pin state. |
| `.github/workflows/verify.yml` | 1 | Reads the same file, checks the app out at that exact sha into `operator-app-pinned/`, exports `E2E_APP_ROOT`, uploads the coupled evidence artifact. |
| `tests/e2e/coupled_runner_receipt.js` | 3 | NEW. Asserts the transport receipt the app's runner writes. Removal condition: delete when the two repositories merge and the transport runner is no longer a cross-repository seam. |
| `.gitignore` | 1 | One entry for the CI-only app checkout. |

### Drift is a failure, not a warning

`app_pin.txt` is worth nothing if a rung can run against some other app commit
and still report green. Four states, all exercised locally against the real
block lifted out of `verify_all.sh`:

```
checkout AT the pin       ── operator app pin   595e865 (claude/coupled-browser-acceptance-20260914) — checkout agrees        exit 0
no checkout (a laptop)    ── operator app pin   595e865 declared; no checkout on this runner (app rungs will skip by name)   exit 0
checkout at 1a5f257       ── operator app pin   FAIL … declared: 595e865… / checked out: 1a5f257… / Move the pin deliberately  exit 1
checkout with no git HEAD ── operator app pin   FAIL … could not be confirmed. Not proven is not passed.                      exit 1
```

The `unreadable` case is deliberate: a checkout whose HEAD cannot be read has
not matched the pin, and "I could not tell" is not "it matched".

### The collision this caught before CI did

The obvious checkout path, `property-spine-app/`, is **already a tracked file**
at this repository's root — a 7,777-line HTML copy of the app shell committed in
`0f4aadc`. Checking out into that path turned it into a directory; `git status`
showed `T property-spine-app` and a 7,778-line deletion. Every CI run would have
deleted a tracked file. The path is now `operator-app-pinned/`, and the reason is
recorded in the workflow beside the `path:` key so the next person does not
rediscover it.

## What each green claims, and what it would miss

- **All 56 source-governance gates, `PARENT EXIT 0`** — re-run with the app
  checked out inside the workspace, because several gates walk the filesystem
  rather than `git ls-files` and an in-workspace checkout could have changed
  what they scan. It did not. This gate reads source shape only: it proves
  nothing about the database, any route, or the browser.
- **The four pin states above** — exercised against the real block, not a
  paraphrase of it. They prove the comparison and the messages. They do **not**
  prove the rungs that follow the comparison; only CI does that.
- **The delivered CI run** — proves the rungs execute and pass at the pinned
  app commit on a GitHub runner. It would miss anything outside the two proofs'
  own assertions, and it says nothing about the app at any other commit.

## Limits

Component-plus-HTTP browser evidence through the app's transport, on an owned
disposable database. Not the full signed-in app shell, not visual-design
acceptance, not production, not a deployment. `coupled_runner_receipt.js`
checks the transport receipt the pinned runner writes today; see FOUND, NOT
FIXED in the return packet for the one field it cannot yet check.
