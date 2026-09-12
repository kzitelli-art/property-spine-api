# Released staff tour booking: actual browser acceptance

Released source pair: API `992a8db4750722cb64ef116a8e6ba47c19872351`, app `2c57e7192e2efb3526547e31d45a8cf71de15ef4`. Isolated sibling worktrees under `tour-browser-20260912`, branch `codex/tour-browser-acceptance-20260912`. Only proof and receipt added; product files unchanged.

## Actual path and result

`tests/e2e/staff_conversation_tour.browser.js`: **13/13 passed** using actual Chrome, unchanged app files, full API server and real migrated PostgreSQL. The proof creates a synthetic authenticated website inquiry and issues a staff session through the canonical issuer with a real property/leasing assignment. Browser actions are Leasing → Lead conversations → named Person Card → Communication → Take over → Schedule a tour → explicitly select one native slot → Book tour.

The first booking request reaches the actual API and commits with HTTP200. The harness deliberately aborts its response before the app receives it, modeling response loss. The visible retry button sends the same slot and idempotency key; the actual API returns the same tour with `idempotent:true`. Database assertions establish exactly one tour at the selected slot, its eligible host, a scheduled event whose actor is the authenticated staff user, and a separate prospect subject. No confirmation transport call occurs.

The visible success receipt says “Tour booked. No confirmation message was sent.” The actual installed Overview still shows the canonical `Respond to prospect inquiry` work and conversation owner. A separate authenticated **HTTP Ask Spine reader** check confirms that same person-linked work remains routed to the staff member. This is not a claim that the Ask browser composer was exercised. No browser page errors occurred.

Initial harness selectors were corrected to target the actual person button, the fresh inquiry's `Take over` control and the visible panel rather than a hidden duplicate. An optional broader reload navigation check encountered a hidden Home desk control because the app restored its selected desk; it was removed from the bounded proof. No product failure was established and no product fix was made. This receipt does not establish every future-tour/calendar display or tour-completion UI.

## Transport and fixture boundary

The app's sealed production API origin is intercepted **before external transmission** in Playwright and forwarded to the owned API with the original path, method, headers and body. Its response is real HTTP; no API response fixture is substituted. Redirect following is disabled for forwarded requests. Other browser egress is blocked. Actual app bytes remain unchanged. API carrier/model/egress fencing uses the existing proof preloads. Synthetic staff session continuity is initialized through the documented sessionStorage path; no demo data path or fabricated live response is enabled.

PostgreSQL17 loopback55441; database `spine_proof_d0cd95254118c23010b67e30`, nonce `2e62866b854f51a6c1e1741338dc717b`; real migration chain194 /182 entries. Standard psql fixtures run after sequential migration/precondition SQL. Windows launcher mirrors the existing owned boot environment. API3341 and transient static app5173. Chrome executable was supplied by `CHROMIUM`; the script otherwise uses Playwright's configured browser. `E2E_APP_ROOT` selects the actual app checkout, defaulting to the sibling app folder.

Run the proof only after provisioning the canonical owned runtime, with `E2E_PROOF_MANIFEST`, `E2E_DATABASE_URL` and `E2E_API_BASE` agreeing with that runtime; `E2E_SMS_LOG` must be the server fake transport log. `E2E_ARTIFACT_DIR` optionally selects a local evidence folder. Then run `node tests/e2e/staff_conversation_tour.browser.js`. This proof is portable but not newly registered in CI here; no remote CI or Linux full-parent execution claim.

## Evidence and cleanup

- Workspace `tmp/tour-browser-acceptance.log`: final13/13.
- `tmp/tour-browser-proof/response-lost.png`: actual retry state after committed response loss.
- `tmp/tour-browser-proof/booked-overview.png`: visible no-message receipt and retained named next work, visually inspected.
- `tmp/tour-browser-proof/receipt.json`: request identities, real response receipts, durable IDs, Overview and Ask evidence; no staff token.
- Harness isolation gate8/8 and diff check passed.
- Cleanup verified after final run: nonce-matched API PID23496 stopped; canonical boundary deleted only the owned database; own PostgreSQL stopped; browser/static server closed by harness. No listeners on3341/5173/55441. `tmp/tour-browser-cleanup.log` and `tmp/tour-browser-manifest.completed.json` retained. Logs/screenshots/source fixtures and cluster directory preserved.

No production database writes, customer messages, provider actions or deployments occurred. This closes the selected-slot booking browser-to-real-HTTP proof gap for the named released pair, not website ingress or production operator acceptance.
