# Coupled browser acceptance — API `e808199` × app `1a5f257` (run 2026-09-13/14)

Bounded validation taken over while Astra was unavailable. Reviewed pins: API
`e80819911414b9c16eea3a530ae55af4c670558f` (`codex/launch-api-integration-20260913`),
app `1a5f257b703919c4e4caf23dee2fe38002b69591`
(`codex/combined-current-rent-roll-app-20260913`). The app's pinned proof
`current_rent_roll_reconciliation.browser.js` was run **unedited**; only the
harness transport was rebuilt. No product code changed in either repo.
Production stayed API `d15c968` / app `336c82f`, schema 182/194.

## Result

**14 passed, 0 failed** on a fresh nonce-owned database migrated from the API
pin (ledger 198) with a fenced owned API server and headless Chromium.
Receipts and screenshots are in `coupled-browser-acceptance/`.

| covered | evidence |
|---|---|
| visible property selection | `00-choose-a-property.png`; runner receipt `property_selection` (found, not covered by `elementFromPoint`, layer closed after the click) |
| Deal Setup entry | `00b-property-opened.png`, `01-identity-review.png` |
| source upload through the real transport | runner receipt `uploads`: one `POST …/source`, `multipart/form-data`, 303 bytes, file part present |
| existing-room picker · explicit mapping | B2–B6, `02`/`03` screenshots (in the runtime directory) |
| resident recognition | B10–B11, `05-candidate-offered.png`, `06-already-represented.png` |
| blank rows remain unresolved | B7, B12 |
| no duplicate homes or leases | B4, B9, B11; database after the run: 2 units, 4 spaces, 1 lease, one person per name |
| final browser errors | B14 (none) |

## Harness transport (the only thing rebuilt)

`coupled-browser-runner.cjs` is a `--require` preload in front of the pinned
proof. The app's sealed live loader (session verify, property list, property
choice) calls the production origin; every such request is re-addressed to
the existing streaming TLS front (`tools/browser_stack.js` `serveTls`) with
`route.continue({url})`, which forwards the browser's own request untouched.
Loopback requests continue unchanged. Everything else is aborted — the
receipt lists the three aborted hosts (Google Fonts, jsdelivr, Plaid). No
request is rebuilt in Node; the earlier `route.fetch` approach was what kept
JSON and dropped the multipart file. The API's CORS and authentication are
untouched; the TLS front's permissive CORS exists only at the harness layer,
as in the other `serveTls` proofs.

The runner also performs the visible property selection the combined app now
requires before Deal Setup (the layer sits at z-index 3900 above the panel):
it waits for the layer, asks the document that the choice is visible, clicks
the choice the server marked as the session's current property, and waits
for the layer to close. That is a precondition, not a 15th assertion.

## First red

One, in the runner and not the product: after the click the runner waited
for the closed layer with Playwright's default "visible" state, but a closed
layer is `display:none`. `first-red-coupled-run1.log` and
`first-red-coupled-runner.receipt.json` show 0/0 assertions and 17 requests
already carried through the TLS front. Fixed by waiting on the class change.

## Command

`command.sh` (paths scrubbed). The API server is owned by the harness driver
on the nonce database; the proof child receives the IPv4 shim and the runner
through `NODE_OPTIONS`.

## Cleanup

Owned database dropped with `proof_boundary.js cleanup` (only `spine_proofs`
remained), no API, Chromium or TLS-front process left, ports 3111 and 8443
free, both pinned worktrees removed.

## Not done here

The workstation files named in the brief (AGENTS.md, WORKSTATION_STATUS.md,
QB_OPERATING_BOARD.md, the original `tmp/…/coupled-browser-runner.cjs`) are
not in either repository and were not available; the runner was rebuilt from
the existing harness. Release operations, production migration 195–198,
Skyline source acceptance and Greenery adoption remain owner decisions.
