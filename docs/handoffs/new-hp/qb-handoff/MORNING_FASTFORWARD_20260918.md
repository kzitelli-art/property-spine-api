# The one fast-forward — 18 September 2026

Everything below is on `claude/main-integration-20260918`. Nothing was pushed
to `main` and nothing was deployed.

## The command

```bash
git fetch origin claude/main-integration-20260918
git checkout main
git merge --ff-only origin/claude/main-integration-20260918
git push origin main
```

`--ff-only` is deliberate: if it refuses, something landed on `main` after this
was prepared and the refusal is the signal to re-read rather than force.

Head: `31342910` · **CI run 670 green** on `f81b8278`, which carries every
product change below; `5c22b604` and `31342910` on top of it are documentation
only.

## Why this fast-forward matters more than the usual one

**`main` has never carried production.** Verified by ancestry, not assumed:
`ecfc9af4` — the commit `/health` reports — is an ancestor of this branch and is
**not** an ancestor of `origin/main` (`ed66d65a`). The deployed line was released
to Render without ever being merged. This fast-forward is what finally makes
`main` a superset of what is live.

`ed66d65a` is also an ancestor of this branch, so nothing on `main` is lost.

## What is on it

| | |
|---|---|
| deployed line | `claude/leasing-context-resolver-20260916` @ `628ca1f5`, including migrations 199 and 200 |
| ledger-ceiling fix | `claude/ci-ledger-200-20260918` @ `31caeede` |
| app pin | moved forward to `2e8199a`, the deployed app |
| docs lanes | `codex/property-identity-cleanup-20260916`, `claude-opus/deal-reconciliation-20260915` |
| new state rows | 118 (stripper), 119 (committed symlink), 120 (`/deals` authority) |

Gates on the final tree, run bare with exit codes read: current-state 8/8
(120 rows, 1..120, no gaps), ask-spine readers 161/161, source governance
59/59, migration release gate 33/33.

## Two things found by doing this, not by planning it

**A merge produced a failure that was on neither parent.** CI 668 went red
claiming the web and SMS paths use different application actions. They do not —
the wiring line is byte-identical on both lineages and the merge. A harness
comment-stripper ran its block-comment pass first, so the `/*` inside
`/operator/*` in server.js's own routing prose opened a comment that closed 569
lines later, deleting the line being asserted. The deployed lineage has no
`*/` in server.js at all, so the fake opener never closed there and the bug was
invisible; the integration line supplied the closer. Fixed in the eight harness
files that scan server.js; 35 further sites share the pattern and are recorded,
not chased. Row 118.

**A branch tracks `node_modules` as a symlink, past .gitignore.** Git refused
to begin that merge, which is the hazard demonstrating itself. Dropped from the
merge result; still present on the source branch, where it is a one-line
`git rm --cached` for its owner. Row 119.

## Decision taken, so it is not silently pending: migrations 199 and 200 are NOT pinned

`tools/release/migration_194_198_predeploy.js` pins 195-198 to their git blobs
and nothing above. **Not retrofitted, on purpose.** Those hashes mean *a human
reviewed this migration before releasing it*, and that tool is scoped to a
release that has already happened. Adding 199 and 200 to it would put a
reviewed-by-a-releaser claim on two migrations no releaser reviewed through it —
and 200 in particular was applied as SQL in the Neon console, not through the
runner.

Nothing is red and nothing is blocked by this. What it leaves open is the next
release: 201 and above have no pinning path, because the only one that exists
is named for, and bounded to, 194-198. That is a decision for you — retire the
wrapper with a stated condition, or generalise it — and it should be made
before the next migration ships rather than during it.

## Still yours — four items this session could not or should not close

1. **Confirm the app service serves `2e8199a`.** Not verifiable from here, and
   not only for want of permission: a static site exposes no build identity, so
   there is nothing to read. The Render dashboard's deployed commit is the
   answer. The app repo's served-asset check at `595e8653` would settle it
   byte-for-byte if the host were reachable; the proxy refuses it.
2. **The Skyline carrier test.** Needs the Twilio console. Delivery remains the
   untested edge — a configured line is no evidence of provider control,
   registration, consent or arrival.
3. **`/deals` authority (row 120).** Verified in source, not fixed. It is 401
   without the shared operator key, so not unauthenticated; the defect is that
   the key carries no per-user identity and no property scope, and the handler
   takes `_req`, so it could not read a session if one were sent. Every sibling
   in `deal_setup.js` carries `requireHuman`. Fixing it is app-first
   (Open Ruling 2) and the lane itself records which picker the app lands on as
   unsettled.
4. **App commit `3607b3d`, "Preserve platform role when adding property
   access."** Unmerged and unreviewed, ahead of both the pin and the deployed
   app. It reads as a fix and could equally be a widening — preserve and grant
   are one edit apart in an access path — so it does not land on the strength of
   its subject line.

## One observation, recorded rather than acted on

The codex identity-cleanup lane commits production receipts containing 16
property identifiers. No emails, phones, tokens or resident data; the Greenery
screenshot was opened and shows the leasing shell with nothing personal on it.
A property id is not a credential, since authority is server-derived (§21), so
these were merged as authored. The standing rule is to scrub identifiers from
committed evidence, and rewriting another lane's receipts would invalidate the
claims they make about themselves — so the observation goes here instead.
