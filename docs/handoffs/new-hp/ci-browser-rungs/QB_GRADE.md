# QB grade — claude-opus/ci-browser-rungs-20260914 (2026-09-14, Fable)

Return packet graded against the repo and the CI log, not the packet.

| claim | grade | how verified |
|---|---|---|
| CI run 537 at `c94a6c3` green; four rung lines PASS naming app `595e865`; no SKIPPED / NOT RUN; cleanup verified | CONFIRMED | job log 103958839283 pulled and searched by me |
| First red (a): run 533 printed two SKIPPED lines and still said all required assertions passed | CONFIRMED | verify_all.sh at 89b2d50 had no FAILED on those branches |
| First red (c): the inventory rung failed on "Choose a property" the first time it ever ran | CONFIRMED | run 536 failure text matches the class we hit twice this week; the correction block is the same visible step as two_step_execute.browser.js |
| No product code touched | CONFIRMED | `git diff --stat -- src server.js migrations tools` is empty |
| A tracked FILE named `property-spine-app` (745 KB HTML, commit 0f4aadc) sits at the repo root and would have been clobbered by the natural checkout path | CONFIRMED | `git ls-tree`; CLAUDE.md's "property-spine-app/index.html" reference is therefore a stale path |
| Both repos public; no secret needed | CONFIRMED | run 537 checked the app out with the default token |
| Skip now sets FAILED on all three app rungs | CONFIRMED | verify_all.sh lines 398, 446, 460 |
| Runner's allowed-hosts check vacuous | CONFIRMED and CLOSED | app `b0be9f46b5dc0240a1b6c2cb898ecca4fc85a09c` records `allowed_hosts`; pin moved below |

Nothing REJECTED. The discarded watcher subagent and the log-reader limits were reported rather than papered over, which is the behaviour the template asks for.

## Decisions taken by QB

1. **A skipped app rung fails the run — kept.** Not proven is not passed. The skip line names the exact remedy (`E2E_APP_ROOT` at the pinned checkout), and CI always has the checkout now. Local full-verify without the app is a red that says why.
2. **QB moves the pin, as part of each coupled acceptance.** Done here: `tests/e2e/app_pin.txt` moves from `595e865` to `b0be9f46b5dc0240a1b6c2cb898ecca4fc85a09c` (the runner fix). The diff of that file is the record of every app version the API has claimed.

## Integrated

Merged into `claude/board-20260914` at `4e68dfd`; pin move and this grade follow. Row 75 stands as written by the lane.
