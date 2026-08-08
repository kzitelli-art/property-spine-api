# Property Spine — Thread Handoff

**Current as of API `main` @ `a9f51da`+ · APP `main` @ `6220ca5` · 2026-08-05 (late).**

> **The API SHA above is ALWAYS one commit stale, by construction.** Editing
> this file changes API `main`, so the number it records is the commit
> *before* the one that recorded it. The `+` is that gap, and it is not a
> mistake to correct — chasing it is an infinite loop. **For the API,
> `origin/main` and Render Events are the authority; this file is not.**
> The APP SHA carries no such problem: this file does not live in that repo,
> so `6220ca5` is exact.
Read the top section first — it wins over everything below it. Each dated
section supersedes the ones under it; nothing is deleted, because the reasoning
in the older sections is still the clearest account of how each trap was found.

This file went 33 commits stale once and was read by every new session as
current truth. Re-date it whenever `main` moves materially.

---

## ══════════════════════════════════════════════════════════════════
##  ⏸ OPEN DEBT — SMS VERIFICATION OWED. 2026-08-08 (latest).
## ══════════════════════════════════════════════════════════════════

**One deployed fix is PROVEN but NOT SMS-verified. Close this the next time
the text line is confirmed alive. Do not let it become "done" by age.**

### What is deployed

`524cf90` — the `appendProgress` savepoint fix (PR #51). One function,
`src/technician/lifecycle_service.js`. No migration; the ledger did not move.

It repairs a **live** failure: `appendProgress` caught PostgreSQL `23505` — a
duplicate idempotency key, which is what a carrier redelivery looks like — and
then issued a recovery `SELECT`. PostgreSQL aborts the whole transaction on a
failed statement, so with no savepoint between them that `SELECT` raised
`25P02`, *current transaction is aborted*. **The handler written to make a
redelivery harmless was itself the thing that threw.**

It was silent rather than loud because `tenantlink`'s inbound wrapper
special-cases `23505` as an already-answered duplicate. The pre-fix error was
`25P02`, so it fell to the generic branch: log, send no reply. The technician
got nothing back.

Full write-up: `docs/PROGRESS_REPLAY_SAVEPOINT_FIX.md`.

### Proof state — PROVEN, not done (§33)

```text
proven      tools/savepoint/prove_progress_replay.js — 22/22, twice from clean
            baselines, against real PostgreSQL at ledger 136. The falsification
            recompiles the PRE-FIX source in memory and reproduces the abort,
            the 25P02 code, and the turn recording nothing.
NOT proven  live SMS. No HTTP path, no Twilio, no production population.
```

### ⚠ TRAP — the verification I first wrote was impossible, twice over

Recorded because the reasoning is the useful part:

**1. Its success signal was a reply arriving at the handset.** But
`RELEASE_0_EVIDENCE_INGRESS_RECEIPT.md` — written the same day — records
`handset delivery NOT CLAIMED — no delivery receipt`. The check was built on
the one thing that receipt says cannot be confirmed. *Read your own receipts
before designing a check against them.*

**2. Two "done" texts cannot exercise this fix at all.** They are two provider
messages with two different `MessageSid`s, therefore two different idempotency
keys, therefore no `23505` and no savepoint branch. A true carrier redelivery
happens only when the webhook times out or 5xx's — **it cannot be summoned, and
must not be induced in production.**

**3. It would also have closed work order 1006.** Gate 8 stored a durable photo
on it, and `main`'s `preservedEvidenceFor` accepts any `storage_state='stored'`
attachment. A "done" text there satisfies the gate and completes the work order
through the LEGACY writer, with no proof evaluation, since 137 has not run.

### The check that is actually owed

When the text line is confirmed alive, from the technician handset (a `users`
row, role maintenance, active `property_team_assignments` at the property owning
WO 1006 — the same phone used for Gate 8):

```text
text        a plain field fact — "on my way"
expect      the normal reply, ONE new work_order_progress row, ONE new event
proves      the savepoint and release statements run on EVERY progress write,
            happy path included. If they broke the transaction assumptions,
            this is what breaks — over real HTTP, real Twilio, real Neon.
stop        silence → revert 524cf90. One function, no schema to undo.
```

Do **not** substitute a "done" text. See trap 3.

### ⚠ POSSIBLY UNRELATED AND MORE URGENT — is the text line even up?

Real-handset evidence ingress **passed** on 2026-08-08 (Gate 8). The Twilio auth
token was then rotated, because it had been exposed in a screenshot. **If
Render's `TWILIO_AUTH_TOKEN` never received the new value, inbound signature
validation fails and the text line is down** — nothing to do with the savepoint.

Not measured. Stated as the first thing to check, not as a finding.

### Boundary — this did NOT advance Release 0

```text
migration 137            still PR #50, not applied
the canonical writer     still PR #50, not deployed
proof evaluations        none written; the table does not exist in production
the four-state reader    untouched
the legacy closeout      untouched
```

PR #50 (Steps 2–3) stays frozen. It rebases onto `main` — which now carries the
savepoint commit — before Step 2 proceeds under the quiet-write + `lock_timeout`
discipline recorded there.

---

## ══════════════════════════════════════════════════════════════════
##  ⛔ THE DEPLOYED APP IS BROKEN. 2026-08-06.
## ══════════════════════════════════════════════════════════════════

**This supersedes the APP SHA in the header above and every deployment claim
below it.** APP `main` moved to `8cbfd1a` (step 1), and **that build has a
runtime defect on the work-order detail surface.**

```text
APP main          8cbfd1a   DEPLOYED · BROKEN
code-bearing      b79f192   SUPERSEDED — do not deploy
REPAIRED          44379d5   deploy this
APP rollback      6220ca5   still valid
API main          unchanged. No API deploy, no migration, no schema change.
```

**The defect.** Step 1 landed `proofOf` and `proofSentence` *inside*
`stateLine`'s body in `work-lifecycle-door.js`. Both hoisted into that one
function's scope, so `detailHtml` — a sibling — could not see them. Every
work-order **detail** render throws `ReferenceError: proofSentence is not
defined`. It propagates out of `render()` and rejects unhandled.

**Why nobody saw it.** `stateLine` is the one caller that could still reach
them, so the **list renders normally and hides the break**. Clicking a work
order does nothing at all — no error, no blank, no unavailable. A silent dead
click.

**The trap worth carrying forward.** Step 1's production pass recorded three
honest PASSes over this defect, because the operator's property had no work
orders and there was no row to click. **An empty-state pass is a true statement
about the wrong subject.** It is why that receipt refused to call itself
progress, and refusing was correct.

**Found by** `property-spine-app/proof_presentation_contract.browser.js` on its
first run — real Chromium against the real deployed file. Not by review, and
not by any amount of reading.

Full record: `property-spine-app/docs/RELEASE_0_STEP_1_PACKET.md` §9.8–§9.12.
Step 1 acceptance is now **eleven checks in one pass**, with the legacy
completion controls split out into a named owed item
(`property-spine-app/docs/LEGACY_COMPLETION_CONTROL_REGRESSION.md`).

**Also recorded there, for step 2:** `readPropertyWorkOrderStatuses` narrows
the list projection to three proof fields. Harmless today. The moment the
canonical writer emits four states, `legacy_indeterminate` and
`missing_evaluation_defect` arrive as illegal old-shape payloads and every such
row renders unavailable in the list while the detail renders it correctly.
Proven, not predicted — §9.10.2.

---

## ══════════════════════════════════════════════════════════════════
##  RELEASE 0 — DESIGN FROZEN, NOT IMPLEMENTED. 2026-08-06.
## ══════════════════════════════════════════════════════════════════

**Nothing below this section's deployment claims has changed.** No product
code, no migration, no schema change, no deploy. The section beneath still
governs what is live.

```text
Release 0 architecture   FROZEN at 4f25f73408d90376f45ea0cf501ddebc7bbff131
PR                       #43, open, BLOCKED from merge
gate 1 design            CLOSED — architecture frozen, do not revise further
                         unless implementation reveals a factual contradiction
gate 2 rotate credential OPEN   ← the only thing in front of implementation
gate 3 prove old dead    OPEN   ←
gate 4 phone-verify SMS  OPEN — release-step gate at deployment step 4.
                         Does NOT block steps 1–3. Step 5 and everything
                         after it may not proceed until a real handset, a
                         real inbound image, a preserved attachment, canonical
                         completion, and operator readback are all proven.
```

A read-only production audit ran under charter Open Ruling 4 and its receipt is
preserved. Governing documents: `RELEASE_0_IMPLEMENTATION_PLAN.md` (rev 3),
`RELEASE_0_APP_CLOSEOUT_AUDIT.md`, `RELEASE_0_COMPLETION_WRITER_MATRIX.md`,
`ASK_SPINE_BUILD_CONTRACT.md` §19c, `release-0-audit/RECEIPT.md`,
`CREDENTIAL_ROTATION_RUNBOOK.md`.

**Scope fence.** Release 0 is proof correction and completion consolidation.
No Ask Spine Build 1. No other maintenance scope. No compliance, vendor,
attention, authority-map, backlog or payment expansion inside it.

### ⚠ TRAP — the agent container was reclaimed mid-session

Partway through 2026-08-06 the working container was reclaimed. The local clone
came back rolled to `f9914ce`, **five commits behind**, with the newer files
simply absent from disk.

Nothing was lost, and the reason is the whole lesson:

```text
the remote branch was the recovery authority
no PUSHED work was lost
no UNPUSHED work should ever be considered durable
local workspace state is never the governing record
```

Recovery was `git fetch origin <branch>` then `git reset --hard origin/<branch>`.
Total cost: one command, because every unit of work had been pushed as it
completed.

**This is an operational lesson, not a product task.** It generalises the rule
this file already carries in another form — repo absence is not deployed
absence, and now: *disk presence is not repository truth.* Push at every
coherent step; treat anything that exists only on the container as already gone.

---

## ══════════════════════════════════════════════════════════════════
##  DEPLOYED AND VERIFIED — 2026-08-05 (late). THIS SECTION WINS.
## ══════════════════════════════════════════════════════════════════

```text
API   main   a9f51dac521c54958f0b3bcb2959a5df14c3db91   docs-only; auto-deploys (see note above)
API   verified deployed at 62db770313c851783172a0c401ab235be532467a  live 17:53 · healthy
APP   main   6220ca5907137aa9036adaee23e8fee78a88a3f0   DEPLOYED · confirmed in browser
ledger ceiling 136 · granted property "Solo on Chestnut" a50fbdd0-3642-431e-b532-0dcd6ab8a4fe
```

Every API commit after `62db770` has been **documentation only**. No product
code, no migration, no schema change. If Render shows a later SHA it is one
of those; if it shows `62db770` the auto-deploy of a docs commit has not
landed yet. Neither case affects behaviour.

## ▶ RESUME HERE — work is PAUSED, not blocked

Stopped 2026-08-05 evening at the owner's call: real-phone acceptance needs
two handsets and an uninterrupted hour, and there was no bandwidth for it.
**Nothing is mid-flight.** No pending migration, no half-applied change, no
unmerged branch, no exposure. Both services are deployed, live, and agree
with their repositories. This is a resting state.

**The single next action** is Part B of
`ACTIVATION_SMS_WORK_ORDER_HANDOFF.md` — steps 14–18, real-phone acceptance
on Solo on Chestnut. Its preflight is three read-only SQL queries; if any
returns empty, the missing fixture is created as ordinary data, never as a
migration and never from `tests/`.

Do **not** restart from the top of this file. Everything above the "Open,
ranked" list is finished and verified.

**Both services are deployed, live, and agree with their repositories.** The
deploy questions that were open since the release are closed. Two items
previously listed as unproven are now proven, and one assumption in the
section below is DISPROVEN.

The release is **deployed and browser-verified. It is NOT phone-verified** —
that is the only product proof outstanding, and it is Part B of
`ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`. Nothing is mid-flight: no pending
migration, no half-applied change, no unmerged branch. This is a coherent
resting state, not a paused one.

### The ledger ceiling is established, not carried

`136` is not a number copied forward from the last release. The build's
highest migration is `136_one_resident_update_per_cause.sql`, and the
`62db770` deploy **went live** — which only happens if the verify gate
passed, and that gate refuses to boot when a migration is in the build and
not in the ledger (see the 2026-08-03 section). A live deploy therefore
proves applied == build == 136.

### How to read the deployed APP SHA — do this instead of guessing

`build-info.js` is a **manual stamp** and was six days stale (`code_sha`
`9422d45`, stamped 2026-07-30). It cannot identify the running build and
must not be used for it. The Render Events page works but needs dashboard
access.

The reliable probe costs one line in the browser console and reads the
**running code**:

```js
String(renderMaintenance).includes('oblFailed')   // true ⇒ 6220ca5 or later
```

Pick any string that exists only in the build you are looking for. This
beats every indirect signal, including Events, because it interrogates what
is actually executing.

**The same trick does NOT work on the API, and nothing else does either.**
`/health` returns only `{ok, db_time}`. There is no `/version`, no commit,
no build, and no migration-status route anywhere in `server.js`. **The
Render Events page is the only way to read the deployed API SHA**, and the
applied ledger ceiling is not readable over HTTP at all — it must be
inferred from a successful boot (above) or read from Neon.

If this question is tiresome by the next release, a `/version` returning
`RENDER_GIT_COMMIT` and the applied ceiling is roughly ten lines and would
retire it permanently.

### ⚠ NEW TRAP, AND THE WORST ONE IN THIS FILE
### Deleting a file from git does NOT remove it from the Render static site

On 2026-08-05, with the deployed SHA **confirmed** as `6220ca5`, all nine
datasets deleted on 2026-08-03 still returned **HTTP 200 with their real
payloads** — 40KB to 881KB, `content-type` not HTML:

```text
/1438_seed.json      /1439_seed.json         /berks_1850_seed.json
/emergency_calls.json /greenery_seed.json    /skyline_1417_seed.json
/solo_4233_seed.json /temple_nest_seed.json  /solo-rent-roll-data.js
```

They are absent from the tree at `6220ca5`. Nothing references them.
**The commit is correct and the files are still served.** The artifact is
not in the repository — it is on Render's published directory, which is not
purged between deploys. **Redeploying the same commit changes nothing.**
The publish root must be purged, or the static site deleted and recreated.

Three rules follow, and each one cost time to learn:

1. **Repo absence is not deployed absence.** Every check before this one
   confirmed the files were gone from git. They were. That measured the
   wrong thing. The check must go over HTTP against the production origin.
2. **A status code is not a payload.** Static hosts commonly rewrite
   `/*` → `/index.html` with status 200, which makes every path "exist."
   Always fetch a path that has NEVER existed as a control. If the control
   returns 404, the server really does 404 and your 200s are real files.
   If the control returns 200, your 200s mean nothing. Then read the body.
3. **The `deskObligationsUnavailable` lesson generalises:** a surface can be
   correct in the repository, correct in the commit, correct in the build,
   and still wrong in production. Only production answers for production.

### The Aug-3 "security" datasets are SYNTHETIC — do not re-escalate

Ruled by the owner, 2026-08-05: the seed and rent-roll files are **fixtures,
not resident data.** One `resident_name` in `solo_4233_seed.json` is
literally `eggw3rhn, fgagevx`.

This matters because the artifacts lie about themselves.
`solo-rent-roll-data.js` opens with *"This file contains resident names and
property financial information… Do not publish this file in a public
repository,"* and the removal commits (`005a9b2`, `9c3386e`) are titled
"security: remove private datasets". **The labels say private; the contents
are generated.** A future session reading only the headers and the commit
messages will conclude there is a live breach. There is not.

**Check the contents before calling anything a breach.** The serving bug
above is real and worth fixing on its own merits — the next thing left in
that directory may not be synthetic.

### Work Orders no longer depends on the obligations desk

APP `6220ca5` (fix `208d403`). A failed `/operator/obligations` read used to
make the **live work-order door unreachable**: `renderMaintenance` called
`deskObligationsUnavailable()` and returned, which cleared `#intelStrip` —
the element carrying the four door tiles — and returned *before*
`lastMaintenance` was assigned, so even a surviving tile would have hit
`openMaintenanceModule()`'s `if(!st)` guard and toasted "Open Maintenance
first." Wiring the tile back alone would have fixed nothing.

The other four composed desks keep the whole-desk treatment on purpose:
obligations are folded into their payloads. Maintenance is the one desk
where that is not true.

**Two defects the proof found that review did not:**

- `body.maintenance-v6-mode .lanes{display:none!important}` — **the lanes are
  hidden on the Maintenance desk.** The first version of the fix rendered the
  honest unavailable state into those lanes, passed every lane assertion, and
  left the operator looking at a desk that appeared perfectly healthy.
  **Presence is not visibility.** The assertion that catches this measures
  `getComputedStyle().display` and a bounding box, not `querySelector`.
- `renderRows()` never cleared the `data-ps-state` marker
  `renderObligationsUnavailable()` stamps, so a recovered lane kept
  announcing an outage that had ended — the confident-wrong pointed the
  other way.

```text
APP  work_orders_reachable_when_obligations_fail.browser.js   30 passed · 0 failed
APP  run_harnesses.sh (18 × *.test.js)                        779 passed · 0 failed
APP  re-entry cycle at 6220ca5 (desk→door→job→desk→door)         7 passed · 0 failed
```

The obligations failure in that harness is a **real HTTP 503** through the
app's own frozen `__psLive` loader — no page function is patched. The stub
implements only the API's *server* contract (`maintenance.js:651`,
`operator.js:235`) and is never the thing that unwraps the `{data, meta}`
envelope; the real loader does that. Navigation is real clicks. Falsified
against a copied tree with the fix reverted: red, exit 1, naming the
unreachable door. Receipts: `docs/work-orders-obligations-failure/`.

### CORS IS PROVEN — this supersedes "must not be claimed" below

Observed in a real browser against production on 2026-08-05. A signed-in
operator opened the Maintenance desk and saw four tiles and **no**
obligations-unavailable banner. `loadObligations` is an authenticated
`x-staff-session` GET from the app origin to
`https://property-spine-api.onrender.com/operator/obligations`. The policy
at `server.js:101` **fails closed** — a mismatched `OPERATOR_APP_ORIGIN`
would have thrown and painted the banner. It did not. **The healthy desk is
the CORS receipt.**

### Open, ranked — carried forward

1. **Purge the Render static-site publish root** (or delete and recreate the
   service) so it matches the commit. Then re-verify the nine paths return
   404 *and* that a never-existing control path also returns 404.
2. **Real-phone acceptance, which IS the real-row production proof.**
   `ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`; its stop conditions are binding.

   Earlier drafts of this list carried "open a property that has work orders"
   as a separate item. **That item was impossible and should never have been
   written.** §21 means the operator's property is server-derived from the
   session grant, and `renderProperties`/`refreshPropSwitcher` hard-scope the
   picker to *only* the granted property — every other option is removed
   (`index.html:10655`). A signed-in operator cannot switch to a property
   with existing work orders; there is no such control, by design.

   The only way to get real rows in front of the operator is to **create**
   them in the property the session already grants. The activation script
   does exactly that, so acceptance and the real-row proof are one task.
3. **Two back controls on the Work Orders route**, and **seven orphaned nav
   keys**. Cosmetic, deliberately deferred until after acceptance.
4. **A write returning 200 with an unparseable body reports "Done."**
   Pre-existing, low likelihood, still a confident-wrong if it fires.

**CLOSED 2026-08-05 (late), do not re-open:** the deployed APP SHA, the
deployed API SHA, the applied ledger ceiling, cross-origin, and "find a
property that has work orders" (which was never possible — see 2 above).

### Not proven, and must not be claimed

- Everything under "Open, ranked" above.
- **Real-phone acceptance.** Both services are deployed and browser-verified.
  Neither is phone-verified. "Deployed" and "accepted" are different rungs of
  the §33 ladder and must not be reported as one.

---

## ══════════════════════════════════════════════════════════════════
##  RELEASED — 2026-08-05 (evening). THIS SECTION WINS over everything below.
## ══════════════════════════════════════════════════════════════════

Both repositories are merged, pushed, and released. Migration 129 was
activated, 130–136 applied, and the ledger reconciled. **The 2026-08-03
"`main` cannot boot" section below is RESOLVED — do not act on it.**

```text
API   main   d0627ce3945e14f01ba47033372a0f454b0af860   live · ledger ceiling 136
APP   main   17823a1100f2b431e1559b935c1f978b67c60402   see "what is actually deployed"
```

**Resident SMS → canonical work order → technician lifecycle → operator
action** is live. The technician holds an ordinary text conversation; every
fact they report is written canonically; the operator sees one queue where
every control performs a governed write and returns a receipt.

### ⚠ THE LESSON THAT COST THIS RELEASE A DAY

The feature was **built, proven, and deployed while being completely
unreachable.** `index.html` referenced `window.__psWorkOrders` **zero times**.
`Maintenance → Work Orders` opened a fixture dashboard reading
`window.__WO_FLOW_LIBRARY` — a static per-property array with invented
`(215) 555-01xx` resident numbers and no network call at all. A signed-in
operator saw sample residents where live work belongs (§19–20 violation).

It passed 99 browser assertions because the proof called
`window.__psWorkOrders.open()` **directly**. That proved the door worked. It
never proved anything *opened* it.

> **RULE, from the owner, 2026-08-05:** a surface is not shipped until the
> proof enters it the way the operator enters it. "The component works" and
> "the component is reachable" are two facts and need two assertions.

That was break **one**. Behind it sat two more, each independently fatal —
wiring the route alone would have fixed nothing:

- **THE LIVE SEAM WAS NEVER REGISTERED.** The door calls seven `__psLive`
  methods. None were in `PRODUCTION_LIVE_RESOURCES` / `WRITE_ACTIONS`. Even
  a correctly wired route would have thrown on the first read and rendered
  unavailable forever.
- **THE DOOR READ THE ENVELOPE AS THE PAYLOAD.** `__psLive` returns
  `{ data, meta }` from every read *and every write*. The door used the
  envelope directly — invisible against a harness stub returning bare JSON,
  an empty queue against the real loader. **The stub was modelling a
  contract production never produces.** That is what let it through.

A fourth, found only once navigation was real: `render()` prefers
`state.detail` whenever set and `open()` left it standing, so leaving for the
Maintenance desk and re-entering Work Orders dropped the operator on the last
job they had opened instead of the queue. Fixed in `17823a1`.

### What is actually deployed — READ THIS BEFORE DEBUGGING

**APP auto-deploy is OFF.** Every deploy is manual. On 2026-08-05 the live
door was confirmed in the browser by screenshot — correct header, `0 NEED
ACTION`, honest empty, no fixture names. **The exact deployed SHA was not
read from the Render Events page.** It is `badd5ea` or `17823a1`; both carry
the route replace, only `17823a1` carries the re-entry fix. **Confirm in
Render Events before assuming.**

API deploys on merge to `main`. Last verified live and healthy at `d0627ce`
with ledger ceiling 136 earlier on 2026-08-05.

### Proof state at release

```text
API   database + HTTP suites                       399 assertions green
APP   run_harnesses.sh (18 × *.test.js)            779 passed · 0 failed · 0 red
APP   work_lifecycle_browser_proof.browser.js      144 passed · 0 failed
```

The browser proof now has **two** entry proofs and keeps both. Section 9c
drives the deployed `index.html` and every script it loads, a session
rehydrated the way a reload does it, and a real click on the real
`Maintenance → Work orders` tile — with the pinned production origin routed
to the harness API at the transport layer, so the app's own **frozen**
`__psLive` loader builds every path, header and body. Nothing in the page is
patched to make it pass. All four operator writes cross that real loader.

Run it:

```bash
HARNESS_DATABASE_URL="postgresql://<user>:<pw>@127.0.0.1:5432/postgres" \
  node work_lifecycle_browser_proof.browser.js      # in property-spine-app
```

### Traps this release created or exposed

1. **A harness that silenced its own death.** `work_lifecycle_browser_proof`
   intercepts `console.error` to keep expected route noise out of the log —
   and silenced `receipt.died()` with it. A harness that died printed
   *nothing* and read like a clean stop. It cost a full debug cycle. Now
   restored before reporting. **If you add a console.error sentinel to any
   harness, never let it swallow the receipt.**
2. **`window.__OFFLINE_MODE = true` is assigned unconditionally**
   (`index.html:4593`) and is never set false anywhere in the repo.
   `getJSON()` checks it *first*, so **every** `getJSON` read in `index.html`
   is answered from the baked snapshot and every write throws
   `405 read-only snapshot`. This is by design: `index.html` is a historical
   snapshot shell, and live operator work happens in the door modules through
   `__psLive`. **Do not "fix" `__OFFLINE_MODE`. Do route new live work
   through `__psLive`.**
3. **`__psLive` is frozen, non-writable, non-configurable, and pinned to the
   production origin.** You cannot override it from a test. Redirect the
   origin at the transport layer instead (Playwright `page.route`), and
   rehydrate a real session through `sessionStorage.__ps_staff_session__` —
   the loader's own reload path.
4. **A feature stylesheet was appended inside the shared `.wrap` frame's
   `<style>` block**, putting dozens of ordinary `padding:` shorthands into
   the slice `shared_frame_proof` reads. It was red on `main` from the
   moment the Work Orders release merged. Feature CSS gets its own `<style>`
   tag. Document order — and so the cascade — is unaffected.

### Known-and-accepted, NOT defects to re-litigate

- **The Coordinate entry control is absent once the resident has been asked.**
  That is the §7.1 ruling (migration 136), not a regression. Do not restore it.
- **`137` is the next free migration number.** Re-read the ledger and scan all
  branches before authoring it.
- **The full schema still cannot be rebuilt from empty** —
  `012_bank_intake.sql:44`, `column "yardi_code" does not exist`. Predates
  all of this and bounds every proof to the scoped schema.

### Open, ranked — carried into the next thread

1. **Confirm the deployed APP SHA in Render Events**, and redeploy `17823a1`
   if it is anything older.
2. **Verify rows render in production.** The 2026-08-05 confirmation was on
   Property Spine Demo Building, which has no work orders — an honest empty
   proves the read succeeds, not that it reads *right*. Open a property that
   has work orders.
3. **Confirm the private datasets 404.** Rent-roll and seed JSON were
   publicly served from 2026-08-03 because the security commits merged but
   were never deployed. Deploying the app should have closed it. **Unverified.**
4. **Real-phone acceptance** — `ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`, the
   script at the end. Stop conditions are listed there and are binding.
5. **A failed `/operator/obligations` read makes Work Orders unreachable.**
   `renderMaintenance` (`index.html:11534`) bails to a desk-wide unavailable
   banner with **no tiles at all**. The live door has no dependency on
   obligations; the *route* to it does. Real coupling, deliberately left
   outside the hotfix scope.
6. **Two back controls on the Work Orders route** — the app bar's
   `‹ BACK MAINTENANCE` and the door's own `‹ MAINTENANCE`. The Unit Turn
   route solved this with a header slot; this one has not. Cosmetic.
7. **Seven orphaned nav keys.** `work_inprogress`, `work_done`,
   `work_closed`, `proof`, `work_emergency`, `work_new`, `work_open` are now
   reachable only from the retired dashboard's own markup. Dead, not broken.
8. **A write returning 200 with an unparseable body reports "Done."**
   `writeAction` yields `data: null`; the door falls back to `{}`. Pre-existing
   shape, low likelihood, but it is a confident-wrong if it ever fires.

### Not proven, and must not be claimed

- **CORS is not exercised by the browser proof.** Playwright's `route.fulfill`
  bypasses it entirely. It is covered *by construction* — `server.js:101`
  applies `operatorCors` to every `/operator/*` path with `x-staff-session`
  on GET/POST, and the app already signs in through that same middleware —
  but it **fails closed** if `OPERATOR_APP_ORIGIN` does not exactly match the
  app origin.
- Everything under "Open, ranked" above.

---

## ══════════════════════════════════════════════════════════════════
##  BRANCH STATE — 2026-08-05 (earlier). SUPERSEDED by the release section above.
## ══════════════════════════════════════════════════════════════════

`main` has NOT moved. It is still `8330aec` and it still cannot boot, for the
reason the 2026-08-03 section below explains: migration `129` is in the build
and in no ledger. Everything in that section is still true.

What is new is a complete, proven, **unmerged** feature branch.

```text
API   claude/conversational-seams-and-technician-loop   contains origin/main 8330aec
APP   claude/sms-work-order-handoff-qo3s8i    11193f4   origin/main 357fb15 MERGED IN
migrations added                                        130 – 136
```

**Resident SMS → canonical work order → technician lifecycle → operator
action.** The technician holds an ordinary text conversation; every fact they
report is written canonically; the operator sees one queue where all five
controls perform governed writes and return receipts.

**399 database-and-browser assertions green, re-run 2026-08-05**, including
`work_lifecycle_browser_proof.browser.js` at **99/99** — real Chromium, real
HTTP, real Postgres, every control clicked.

### Read these two documents before touching any of it

- [`RELEASE_SMS_WORK_ORDER_HANDOFF.md`](RELEASE_SMS_WORK_ORDER_HANDOFF.md) —
  what ships, what proves it, component classification, and **§7: the ruling
  that closed the duplicate-message defect, and the one limit that bounds what
  may be claimed.**
- [`ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`](ACTIVATION_SMS_WORK_ORDER_HANDOFF.md) —
  the 19-step operator packet and the real-phone acceptance script.
  Self-contained; no thread can run any of it.

### One ruling landed, one limit remains

1. **RULED AND CLOSED — never ask the resident the same thing twice.**
   Reporting no access already texts the resident the coordinate-entry
   sentence; the operator control sent byte-identical text and its guard could
   not see the first message. Migration **136** makes
   `comm_events.derived_from_progress_id` unique, so both writers now resolve
   against the same canonical cause and the database refuses the second
   message. The surface reports *"Asked resident at 10:04 AM · waiting for
   reply"* and the control only exists where nobody has asked. The index is
   SCOPED — outbound / sms / work_order_update / resident — so a field fact can
   still be referenced by other message types; widening it would block
   legitimate references. Full ruling and its proof: release package §7.1.

   **Do not "restore" the Coordinate entry button on a work order whose
   resident has been asked.** Its absence is the ruling, not a regression.
2. **The full schema still cannot be rebuilt from empty.** Re-verified
   2026-08-05: `012_bank_intake.sql:44` — `column "yardi_code" does not exist`.
   This bounds every proof to the scoped schema, and predates this work.

### Activation order is a gate, not a preference

`129` first (`UNBLOCK_1_MIGRATION_129_ACTIVATION.md`), **then** `130`–`136`.
Releasing onto a `128` ledger would sweep `129` in without its own receipt.

Reconcile with `main` by **merge**. Never rebase, never force-push — both
branches already carry merges from `main`.

---

## ══════════════════════════════════════════════════════════════════
##  STATE — 2026-08-03 (late). SUPERSEDED — `main` boots; 129 is released.
## ══════════════════════════════════════════════════════════════════

### ⚠ `main` CANNOT BOOT RIGHT NOW. That is deliberate.

Migration **129 is in the build and in no ledger**, so the verify gate refuses
to start and Render keeps serving the previous build. **Production looks healthy
while running older code.** This is expected, not a regression — the fix is to
release 129, not to revert.

```text
source  main        4983e5d      repository migration ceiling 130 (on the Slice A branch)
production          d3698d3      APPLIED ledger ceiling 128
divergence          deliberate, pending the 129 activation receipt
```

Merging anything to `main` does not make this worse; the red is caused solely by
129 already being there.

### The migration state, exactly

```text
applied:                       120, 121, 122, 123, 124, 126, 127, 128
unused historical gap:         125   (never applied anywhere; staged outside the runner)
claimed, unreleased:           129 (property-line uniqueness, on main)
                               130 (communication lines, on the Slice A branch only)
next free number:              131 — RE-READ THE LEDGER AND SCAN ALL BRANCHES FIRST
```

**Do not reuse 125.** Authoring a new one behind live 126–128 backfills the
sequence and creates a second misleading migration story.

### There is now a required validation path — USE IT

```bash
npm run verify        # source-governance gates; DB-free; no credentials needed
```

Before this existed, the repository had **three gates and nothing invoked any of
them** — no CI, no `npm test`. `gate_closure_boundary.js` was blind since a
directory move and nothing noticed, because nothing ran it. `deploy.sh` now
invokes `verify` before triggering a deploy, under `set -e`.

### ⚠ THE HARNESS-ISOLATION FINDING — measured, contained, NOT repaired

An audit **by connection rather than by filename** found:

```text
87  scripts across tests/ and tools/ build a connection from DATABASE_URL
    with no guard  —  67 of them WRITE-CAPABLE
 5  more require HARNESS_DATABASE_URL but never perform its same-target refusal
 8  covered by the historical *.db.js convention
17  genuinely guarded harnesses
```

**On Render, `DATABASE_URL` is production.** These are unsafe **capabilities** —
not evidence any has run against production. `tools/` is the dangerous half: it
holds `retire_hollow_leases`, `repair_invalid_task_owners`,
`remove_duplicate_walkins`, `seed_*`.

`tests/gate_harness_isolation.js` freezes the inventory as a **debt register**
(path · measured write-class · provisional use · reason · removal condition) and
**fails on growth**. It does NOT make the existing inventory safe.

**Operational rule, effective now:** do not run any test, proof, seed or repair
script directly from a production Render shell unless it is explicitly
classified as structurally read-only. **`.db.js`, `_proof.js`, `smoke` and
`test` are names, not evidence of safety.**

Remediation is its own governed slice **after** Slice A. Do not mass-replace
`DATABASE_URL` across 87 files — that would create 87 unexecuted safety claims.

### Slice A — built and proven, NOT merged

The canonical communication-line model (migration 130) lives on
`claude/sms-work-order-handoff-qo3s8i`, proven **61/61** against isolated real
PostgreSQL 16.13 and real HTTP at SHA `95f13c7`.

**It is not on `main` and not in production.** Merge is blocked on: the 129
activation receipt; re-reconciliation with current `main`; repair of two unsafe
harnesses in its own proof set (`work_order_authority_proof.js`,
`work_order_canonical_path_proof.js`); and the five full-schema harnesses running
at the merge-candidate SHA. Full sequence: `docs/SLICE_A_MERGE_CHECKLIST.md`.

> **"Previously green before the resolver changed" is not evidence for the
> changed resolver.** Slice A changed `resolveInboundSmsContext`, which is the
> exact function `resident_sms_route_proof.js` exercises.

### Read these before building anything new

| Document | Why |
|---|---|
| `docs/PHILOSOPHY.md` | the specification, not preamble |
| `docs/MONEY_THESIS.md` | operations-first, accounting-derived; **cash vs accrual is an OUTPUT choice** — never force a basis at capture |
| `docs/AGENT_CAPABILITY_SEAMS.md` | the SMS path is the agent's first bounded capability; three of six seams are transport-co-located, with an exact extraction trigger |
| `docs/COMMUNICATION_LINE_MODEL_DESIGN.md` | approved design; org context is NOT property context |
| `docs/DB_HARNESS_ISOLATION.md` | the finding above, in full |

### The order

```text
129 activation receipt
→ reconcile Slice A with current main
→ repair and prove its two unsafe harnesses
→ full proof set at the merge-candidate SHA
→ merge and activate Slice A
→ Slice B: retire properties.sms_number
→ repository-wide harness-isolation remediation
→ operations-number activation and technician loop
```

### Open cleanup, oldest first

- **Production synthetic rows** — inventoried in `DB_HARNESS_ISOLATION.md`,
  **never deleted**. Under derived reporting these are not stray rows; they are
  fabricated operating events that become numbers. Needs an ID-based,
  dependency-ordered dry run and owner approval.
- **ITEM 2** — `conversation_owner_user_id` conflates attribution with
  ownership. Now in the money path: attribution is what makes a derived number
  auditable.
- **Migration 125** — staged outside the runner, never applied, unresolved.
- **`src/shared/no076_failclosed_check.js`** — dead, classified, not removed.
- **Stale paths from the reorg** — three found, "assume more". Nobody has swept.

---

## ══════════════════════════════════════════════════════════════════
##  HANDOFF — 2026-08-03 (earlier). Superseded in part by the section above.
## ══════════════════════════════════════════════════════════════════

Where this conflicts with anything further down this file, **this section wins.**
Everything below the marked history line describes an earlier state.

---

### 0. The doctrine is not preamble. It is the specification.

`docs/PHILOSOPHY.md` is not style guidance you skim before writing code. It is
the thing the code is judged against, and on this project it has repeatedly been
the *fastest* route to the right answer — not a tax on it.

Every significant decision recorded below was **derived** from a numbered
principle, not decorated with one afterwards. §6 in this handoff shows the
derivations in full, because the pattern matters more than any individual
outcome: **when we reasoned from doctrine we got it right the first time, and
every time we skipped that step we had to come back.**

The five that governed this session:

| | Principle | What it actually forces |
|---|---|---|
| **§5** | Honest Blank Beats Confident Wrong | A missing owner reads `UNASSIGNED`. A test that proves nothing reports `RUN INVALID`. A harness that cannot verify its own safety **refuses to run**. Silence is never evidence. |
| **§17** | One Canonical Architecture | One meaning per fact, one implementation per rule. Two copies of one engine is a defect even while they agree, because agreement is not a mechanism. |
| **§18** | Classify Every Component | Anything temporary carries an explicit class and an exact removal condition. `properties.sms_number` is a temporary adapter — say so, in writing, with what retires it. |
| **§21** | Server-Derived Identity and Authority | The browser requests; the server decides. A caller may never supply the fact that authorises it. This is why `recognizeObligationMissed` derives its own threshold. |
| **§33** | Definition of Done | Reported → Locally exercised → Built-but-dormant → **Proven** (real DB + real HTTP) → **Browser verified**. Naming your rung honestly is the whole discipline. |

And §32's stop-signs are live tripwires, not a list to nod at. *"We'll wire it to
the real path later"* and *"we can clean up the history after"* both appeared in
this session's work and both turned out to name a real defect.

---

### 1. The mission

```
resident texts the property line in their own words
  → Spine records the claim ONCE as a canonical work order
  → it routes to one accountable human, or stays honestly UNASSIGNED
  → the technician executes and proves it, by text
  → verified status returns to the resident
```

The resident never learns the system. The technician never opens an app. The
truth is captured at the moment of work and every surface reads the same record
(§7, §35).

**Roughly 60% complete.** The resident-facing half is live and proven. The staff
execution loop does not exist yet.

---

### 2. What is LIVE on `main` and honestly proven

`main` is at `a08c1da`.

**The migration state, exactly.** Read from the production ledger 2026-08-03,
not inferred from `ls migrations/`:

```text
applied:                       120, 121, 122, 123, 124, 126, 127, 128
unused historical gap:         125
repository migration ceiling:  129
applied migration ceiling:     128  (until 129 is released)
```

**125 never ran.** It is absent from the production ledger *and* from
`migrations/` — it is staged at `docs/slices-6-to-10/deployment_b/`, outside the
runner. The sequence is NOT contiguous and nothing should be written as though
it were. An earlier version of this file said "120–128 unbroken"; that was
wrong, and it was wrong in the direction that matters — it implied a number had
been used when it had not.

**129 is CLAIMED** (`129_property_line_uniqueness.sql`, merged in `a08c1da`) and
**not yet released**. The next free number is **130**. Because 129 is in the
build and not in the ledger, a deploy of current `main` will correctly REFUSE TO
START until it is released — see `docs/PROPERTY_LINE_ACTIVATION.md`.

| Capability | Proof | §33 rung |
|---|---|---|
| Resident SMS → canonical work order | `resident_sms_work_order_proof.js` **78/0**, `resident_sms_route_proof.js` **31/0**, real Postgres + real HTTP, isolated DB | **Proven** |
| One obligation engine (`src/shared/obligation_engine.js`) | one-implementation **14/14**, import smoke **8/8** | **Proven** |
| Durable missed recognition (`src/shared/obligation_missed.js`, migration 126) | conversion rail **15/15**, production smoke **23/23** | **Proven**, live in production |
| Migration release gate (ITEM 5) | gate test **11/11** + real-Postgres verify, exit 0 | **Proven** |

**None of it is Browser verified.** Per §33 that matters and must not be blurred:
for operator workflows, browser verification is part of done. Say "proven at the
service layer" and stop there.

The two SMS harnesses are worth studying as a model. The work-order proof states
in its own output: *"17/22 exercised here; 5 require an HTTP-level harness (cases
5, 9, 10, 11, 14). Those five are NOT proven by this run and must not be reported
as such."* The route proof then proves exactly those five. **A harness that
polices its own claim is doing §5 in the only place it counts** — where nobody is
watching.

---

### 3. Traps, each with the principle it violates

**A deploy no longer migrates production — do not undo this.** `prestart` runs
`migrations/migrate.js` in VERIFY mode. Every migration file must already be in
the ledger, or the service **refuses to start** and names the pending file.

It does **not** skip and boot. Skipping would trade a silent schema *change* for
a silent schema *mismatch* — new code against an older database, which is §5's
confident-wrong wearing a hard hat. Releasing is deliberate:

```
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<what you just read> \
  EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply
```

`EXPECTED_LEDGER_CEILING` exists so **a release cannot be run by someone who has
not read the ledger.** That is §21 applied to deployment: the operator asserts
what they believe, and the system refuses if reality disagrees.

**No harness may target production.** Every `.db.js` requires
`HARNESS_DATABASE_URL`, with no fallback, and refuses when it resolves to the
same host/port/database as `DATABASE_URL`. The sole exception is
`tests/prod_smoke_missed_readonly.js`, which runs inside `BEGIN TRANSACTION READ
ONLY` and **proves** it cannot write before reading anything.

**`now()` inside a transaction is the transaction's start time.** This produced a
false green that survived review. Ordering by it is meaningless within one
transaction.

**Absence of red is not green.** `test_conversion_rail.db.js` threw at
construction and ran **zero assertions for 204 commits** while reading as
passing. Every critical harness now prints `ASSERTIONS STARTED`, an expected
count, a completed count and an exit code, and reports `RUN INVALID` when it runs
fewer than expected (§5).

**`$?` after a pipeline is the pipe's status, not the program's.** This misled
this session three times. Never pipe a harness whose exit code you intend to
read.

**The reorg left stale paths.** Three found so far — `test_release3.db.js` (two
`readFileSync` paths), `gate_closure_boundary.js` (a regex that made the gate
**blind** since the move), `seeds/seed_demo_slots.js` (still failing softly at
boot). Assume more. A gate that cannot see is worse than no gate, because it
reports safety it is not providing.

---

### 4. Open rulings — do not decide these alone

**ITEM 2 — `conversation_owner_user_id` conflates attribution with ownership.**
Written from a host claim without eligibility resolution, read by operating logic
at `leasingconversion.js:385`, and labelled **"owned by"** on two desk surfaces
next to a separate "toured by" field. The column is `NOT NULL`, so §5's honest
blank is *unrepresentable by construction*. Property Spine deliberately keeps
attribution, eligible assignment, task ownership and authenticated authority
separate (§10, §21); this column straddles all four. Full audit in
`BLOCKING_DESIGN_ITEMS.md`. **Blocks conversion-rail activation, not the SMS
loop.**

**Production fixture cleanup.** Earlier harness runs committed synthetic
properties, users, persons, prospects and obligations into production.
Inventoried read-only in `DB_HARNESS_ISOLATION.md`; **nothing has been deleted.**
The conversion-rail rows carry *no marker at all* — ordinary human names, no
email, and a property literally named `Solo on Chestnut`. **Never infer that a
row is synthetic from its name.** Cleanup needs an ID-based, dependency-ordered
dry run and explicit owner approval. Note `069` sets `ON DELETE RESTRICT`
deliberately: history is not cascade-deletable, and that is a feature.

**The missed-recognition human path is unexercised.** Migration 126 is live and
the primitive is proven, but no operator UI ever sends `result: 'missed'` — the
route accepts it, nothing calls it. Five eligible Demo Building candidates exist.
Do not manufacture one by backdating a `due_at` (§32: *"we can clean up the
history after"*).

**`RESOLUTION_BASES` has no vocabulary for "the window elapsed."** It offers
`coverage | manager_intervention | completed_together | no_longer_needed |
unassigned_pickup` — all written for *someone closing work*. A missed window is
not that. Recorded, not papered over.

---

### 5. The next slice: duplicate property-line hardening

Fully designed in `COMMUNICATION_LINE_ARCHITECTURE.md`, with the rulings already
made. Build exactly this and no more (§30 — one narrow, vertically complete
slice):

1. read-only duplicate-number preflight;
2. database uniqueness for active, non-null property-facing numbers;
3. an inbound resolver that treats **zero, one and multiple** matches explicitly;
4. multiple matches **fail closed with zero operating writes**;
5. tests proving a message can never bind arbitrarily to one property.

**Why this is next and not the technician loop.** `properties.sms_number` has no
unique index, and inbound does `where sms_number = $1 limit 1` with no `order
by`. Two properties sharing a number silently binds a resident's message to the
wrong property's ledger — §5's confident-wrong at the property boundary, which is
the one wall the system must never leak through (§12). Unknown lines already fail
honestly; ambiguous ones do not. It is latent today because one guarded route is
the only writer — one row of defence with no database backstop.

**The Eight Questions (§31), pre-answered where they already have answers:**

1. *Real-world fact?* Which physical phone line received this message.
2. *Canonical service?* The inbound resolver in `communications_boundary.js`.
3. *Authenticated actor and property?* Neither — resolution happens **before**
   identity, because the receiving line is the property wall (§21).
4. *Durable object?* None new. A uniqueness constraint on existing config.
5. *Immutable history?* Unchanged; the refusal path writes nothing by design.
6. *What reads it automatically?* Every inbound message, and every outbound
   `from`.
7. *When it is missing?* **Answer for ambiguity, not just absence** — that is the
   entire slice.
8. *Class and removal condition?* `properties.sms_number` is a **temporary
   adapter** (§18): current role, one property-facing line per property;
   limitation, cannot express an organisation-owned operations line; retired when
   a canonical communication-line model resolves both inbound and outbound.

**Migration number: query the ledger, never assume.** Applied ceiling is 128;
**129 is claimed and merged**, so the next free number is **130**. Other threads
hold unmerged numbers — scan every branch, not `ls migrations/`.

Do not reuse **125**. It is an unused historical gap, and authoring a new 125
after 126–128 are live would backfill the sequence behind applied migrations and
create a second misleading migration story. Resolve the staged
`docs/slices-6-to-10/deployment_b/125_*.sql` artifact separately.

---

### 6. How the doctrine actually earned its keep today

Read this part. It is the reason for the rest.

**§17 caught a live defect.** `tests/_engine.js` was a hand-maintained copy of
the obligation engine kept in sync "by discipline." It had drifted in three
places, **all permissive** — a missing `dedupe_key`, a missing reserved-input
guard, a missing conversion-rail guard. Every harness importing it asserted
against an engine *more permissive than production*. Doctrine said two
implementations of one rule is a defect **even while they agree**; the drift
proved why.

**§5 turned a dead test into a finding.** `test_conversion_rail.db.js` had run
zero assertions for 204 commits. Applying "absence is not evidence" surfaced a
product defect the silence had been hiding: `obligations.status='missed'` was
**unwritable** against `ck_obl_status`, so a crossed follow-up window recorded
*nothing at all*. Zero missed rows existed in production, and the path had never
once succeeded.

**Doctrine overruled my own analysis, correctly.** I concluded the fix was to
widen `ck_obl_status` to admit `missed` and called it the only honest option.
**That was wrong.** Lifecycle status is mutually exclusive; missedness is
orthogonal — an obligation can be open *and* missed, escalated *because* it was
missed, complete *having been* missed. Widening the enum erases all four truths
and creates another overloaded field — precisely the defect ITEM 2 documents one
section away. The two-axis model came from doctrine, not from me:

```
lifecycle status        open | in_progress | complete | escalated
timeliness / recovery   on_time | due | overdue | missed
```

**And it caught a second-order version of the same error.** My first projection
read `missed` from the durable fact *with the clock as fallback*. That quietly
reintroduced the conflation: with no sweeper, an obligation would become "missed"
**because someone opened a page after the deadline.** `overdue` is a clock-derived
operating condition; `missed` is a durable institutional fact with a recorded time
and actor. **`missed` is never derived from the clock.**

**§18 killed speculative schema.** A recovery-queue index was drafted for
migration 126 and removed: no query in the slice used that shape. Every read was
`where id = $1`. An index for a capability the slice explicitly excluded is
schema built for a query that does not exist.

**The recurring failure was mine, three times: shipping a safety check that had
never run.** A production smoke whose read-only probe aborted its own
transaction. A closure gate blind since the reorg. A probe testing DDL permission
when the property that mattered was write permission. All three *read* as
protection. **A guard you have not executed is a claim, not a control** — which
is §33's whole point, applied to the tools rather than the product.

**The largest finding came from connecting two things already written down.**
`prestart` ran migrations against the service's own `DATABASE_URL`, so deploying a
branch to test it and migrating production were the *same operation*. The
evidence had been sitting in this very file as "the migration GAP at 121" — a
migration applied in production whose file existed only on a branch. It was
recorded as a curiosity for weeks. Every guard built this session protected
against a *harness* writing to production; **none protected against a deploy
migrating it**, because that path went through no harness. The protection was one
layer short of the risk, and the proof of it was already in the handoff.

---

### 7. What "done" means for the technician loop

Not "the code exists." Not "the harness passes." **§33, in full**, and for
operator workflows that includes the browser.

The loop is done when a real resident texts a real property line, a real
technician replies `accept` / `on my way` / `no access` / findings / proof /
`complete` from a real phone, the work order and its obligation carry durable
history at every step, one accountable human owns it or it reads honestly
`UNASSIGNED`, verified status returns to the resident, and an operator sees the
same truth on the board — **from one canonical record, with no demo path, no
fixture fallback, no invented ownership, and no second meaning of truth** (§35).

Anything less, name by its actual rung and say what is missing.

---

## ══════════════════════════════════════════════════════════════════
##  EVERYTHING BELOW THIS LINE IS HISTORY (pre-2026-08-03)
##  Kept because the reasoning is still the clearest account of how each
##  trap was found. Where it conflicts with the handoff above, it is stale.
## ══════════════════════════════════════════════════════════════════


## What is LIVE on `main`

| Slice | Landed | Proof level |
|---|---|---|
| S4 unified leasing work · S5 application records | #17, #18 | real Postgres + authenticated HTTP |
| Unit turn (migrations 112–118) | #16 | see `UNIT_TURN_RELEASE_CANDIDATE.md` — built-but-dormant at the time |
| Slice 6 renewals operating rail (119) | #20/#21 | real DB + HTTP + browser |
| Slice 7 Market & Pricing workspace | #22 | see `slices-6-to-10/SLICE_7_CLOSURE.md` |
| AI leasing strategy foundation (120) | #23 | dormant runtime — activation gated on a replay corpus that has never run |
| AI leasing visible status | #24 | — |
| Slice 8 governed economics lineage (122) | #25 | see the Slice 8 branch's own proof |
| **Resident SMS → canonical work order** | **#27** | **real Postgres + real HTTP · `docs/SLICE_SMS_CLOSURE.md`** |

### What the SMS slice changed (read this before touching inbound messaging)

- `runInbound` is **two transactions**. T1 commits the inbound claim already
  flagged `needs_human=true`; T2 does all processing atomically and clears the
  flag only on commit. A failed T2 preserves the claim, flagged, and sends no
  reply.
- The two **raw `work_orders` inserts are gone**. Tenant work orders flow
  through `createWorkOrder`, so every one produces an event and a routing
  obligation. The raw inserts produced neither.
- `appendClarification` was repaired in the **shared canonical service**, so the
  browser door (`POST /tenant/messages`) got the same fix.
- **`src/shared/obligation_transitions.js`** is the canonical obligation retype.
  Two whitelisted transitions only; requires expected type + status so stale
  state fails closed. **Use it — do not hand-roll an obligation `UPDATE`.**
- Clarification association keys on the **outbound question we sent**, never
  `obligations.person_id` (that column holds the *affected* person, not the
  person we texted — they differ whenever a neighbour reports).

---

## MIGRATION LEDGER — the GAP at 121 (CLOSED 2026-08-03; kept for history)

```text
repo on main:  … 118, 119, 120, [121 MISSING], 122
```

**121 is not lost.** `121_ai_leasing_operating_context.sql` is parked on
`claude/getting-up-to-speed-nyf4ww` and was deliberately kept off `main`
because it has never been applied to a database or exercised over HTTP.
When it eventually merges it will apply **after** 122. They touch unrelated
tables, so that is harmless — but it must not be a surprise.

**Before claiming any migration number, scan every branch — not `ls migrations/`,
which only shows what is merged. That is how duplicate numbers get created.**

```bash
git fetch --all -q && for b in $(git branch -r | grep -v HEAD); do \
  git ls-tree -r --name-only $b migrations/; done \
  | grep -oE '^migrations/[0-9]{3}' | sort -u | tail -5
```

Claimed at time of writing: **123, 124** (Slice 9) · **125** (Slice 9, staged
*outside* `migrations/` at `docs/slices-6-to-10/deployment_b/`, so a scan of
`migrations/` will NOT see it). **126 is the next free number.**

Verify the *deployed* ledger separately — the repo is not the database:

```bash
node -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query('select version,name from schema_migrations order by version desc limit 5').then(r=>{console.table(r.rows);p.end()})"
```

---

## What is PARKED (real work, unmerged)

- **`claude/getting-up-to-speed-nyf4ww`** — Governed Operating Context: migration
  121, `ai_leasing_operating_context.js`, operator ai-rules/ai-settings routes,
  agent.js + leasingleads.js wiring. **Never applied to a database, never called
  over HTTP.** Its companion UI is on the app repo's branch of the same name and
  is explicitly not approved design. Needs its own real-DB + HTTP proof.
- **`claude/slice-9-demand-evidence`** — migrations 123/124 (+125 staged), the
  evidence rail, and a timezone cutover that makes `withinSendWindow` and
  `localHourAtProperty` **async**.

---

## Traps that cost time

### A BRANCH DEPLOY MIGRATES PRODUCTION — see BLOCKING_DESIGN_ITEMS.md ITEM 5

`prestart` runs `migrate.js` against the service's own `DATABASE_URL`. Deploying
a branch to the production Render service to test it and applying that branch's
migrations to production are THE SAME OPERATION. That is how `121` reached
production while `main` still lacks the file — the very "GAP at 121" documented
below. **Until an isolated preview service or an explicit migration gate exists,
do not deploy a feature branch to the production service.**


### NEVER reset, rebase or force-push a shared branch without diffing origin first

2026-08-01: a design doc was committed onto `claude/getting-up-to-speed-nyf4ww`
after resetting it to `origin/main`. The push was rejected as non-fast-forward.
That branch held **19 unmerged commits** — the entire resident-SMS slice. A
`--force` would have destroyed them. The rejection was luck, not process.

Before touching any branch that is not exclusively yours:

```
git fetch origin <branch>
git log --oneline origin/main..origin/<branch>     # exactly what would be lost
```

Unrelated work gets its own branch. Two threads have been running in parallel all
week; assume every shared branch name is occupied until you have checked.


**New, learned the hard way on 2026-08-01:**

- **The Render Shell has no `.git`.** `git rev-parse HEAD`, `git fetch`, and
  `git worktree` all fail there with *"not a git repository"*. Use
  `echo $RENDER_GIT_COMMIT` to see what is deployed. To run a harness from an
  unmerged branch, point the service's **Settings → Branch** at it, Manual
  Deploy, run, then switch back.
- **`users.role` is a Postgres enum (`role_name`)**, not free text. Valid:
  `owner, asset_manager, property_manager, leasing_agent, maintenance,
  accountant, ai, system`. There is no `staff`.
- **`now()` is TRANSACTION time.** Any harness that wraps a run in one
  transaction gives every row an identical `occurred_at`, so
  `order by occurred_at desc limit 1` returns an arbitrary row. Key assertions
  by **identity**, never by timestamp. This produced a false green that passed
  while reading a different test case's row.
- **Outbound SMS requires `contact_preferences.consent_state='opted_in'`.**
  Without it every send is refused and stamped `sms_status='refused'` — which
  the clarification gate then correctly treats as *never asked*. A fixture that
  omits consent silently exercises the wrong branch.
- **The inbound-SMS route acks Twilio BEFORE it awaits the send** (so a slow
  carrier never causes a retry). An HTTP response returning does **not** mean the
  message was sent.
- **Both exception-queue readers filter `direction='inbound'`**
  (`surfaces/desks.js`, `surfaces/board.js`). Flagging an *outbound* row with
  `needs_human` surfaces to nobody.

**Still true from before:**

- **Migration numbers collide across contributors.** Two `106` files broke every
  API deploy until renumbered.
- The ledger keys on **version**; the runner refuses a different file reusing a
  recorded version.
- `POST /operator/session` body field is **`proof`**, not `token`.
- `DATABASE_URL` in `api/.env` is dead — pull it from the Render env per session.

**Corrected — the prior handoff was wrong about these:**

- `window.__psLive.beginOperatorSession(...)` **no longer exists.** The
  `__psLive` surface today exposes turn/triage/readiness/agent methods; verify
  against `property-spine-app/index.html` before relying on any of them.
- The app repo branch is **not** `r1/renewals-live-read`. Check `git branch -r`.
- The Solo property id **does** appear in source (four files:
  `identity/operator.js`, `leasing/demo_preflight.js`, `surfaces/owner.js`,
  `onboarding/deal_registry.js`) — all reads or delete-guards. The rule that it
  is never *written* still holds, but "appears in no code" was false and must not
  be used as a search heuristic.

---

## Known debt

- **`tests/_engine.js` is a hand-maintained verbatim copy** of
  `spawnObligationFromEvent` / `satisfyObligation` from `server.js`. Its own
  header says *"server.js is the SOURCE OF TRUTH… update this copy to match"* —
  a rule kept in sync by discipline, which is the shape of the documented
  `deriveCategories` incident. `transitionObligation` was deliberately **not**
  added to it; it lives in `src/shared/obligation_transitions.js` and is imported
  by both server and harness. Extracting the two older functions is the right fix.
- **A failed resident notification has visibility but no accountable owner.**
  It re-flags the inbound row; PHILOSOPHY §11 wants an obligation. Needs an
  obligation type and an owning role — an owner ruling, not an implementation
  choice.
- The AI leasing strategy replay corpus (migration 120) has still never run
  against real model output.

---

## Key documents

`docs/SLICE_SMS_CLOSURE.md` · `docs/RESIDENT_SMS_WORK_ORDER_CONTRACT.md` ·
`docs/slices-6-to-10/` (00_GOVERNING_HANDOFF, SLICE_6/7_CLOSURE,
ACCEPTANCE_CHECKLIST) · `docs/PHILOSOPHY.md` · `docs/PRICING_GOVERNANCE.md` ·
`docs/IDENTITY_AND_AUTHORITY.md`

---
---

# ⚠ EVERYTHING BELOW IS THE PRIOR HANDOFF, AS WRITTEN 2026-07-27

It is preserved because it is the only written record of the pricing,
governed-charge and administration-fee rulings, and deleting it would lose
them. **It has NOT been re-verified since, and it is 33 commits stale.**
Slice 8 (migration 122) has since changed governed economics, so treat the
economic sections in particular as historical rather than current. Where it
conflicts with anything above, the section above wins.


**Closing state: 2026-07-28** · api `eaa1bd9` (live) · app `ae7abe3` (live)
**Independently audited 2026-07-28** — see *Audit corrections* at the foot.
Start here. Nothing in this file requires reconstructing the prior conversation.

---

## What is LIVE

**One governed economic term.**

```
fee.application   $50   one-time · required · per applicant · NEW-LEASE APPLICATION ONLY
                        record_state=active  quote_state=live
                        renewal: false   transfer: false
Assistant says:   "The application fee is $50 — Per applicant on a new-lease application."
Source:           property_governed_charges   (NOT prose)
```

Everything else economic is **unpublished**: no pricing version, no recurring
charge, no deposit requirement, no active concession.

## What remains DRAFT

```
fee.administration  $99  record_state=draft  quote_state=inactive
                         BLOCKED on one ruling (below)
```

Its legacy fact `pricing_admin_fee` is **still the only live source**.

## Legacy source retired

`agent_facts.pricing_application_fee` → `status='retired'`, row retained and
historically visible. It is the **only** fact ever retired. 12 money-bearing
facts remain live.

## Exactly one live economic owner

```
governed_active 1 · legacy_active 0 · quotable_sources 1
verdict: one_canonical_truth
```

Enforced by `uq_gc_active_code` (one ACTIVE row per code) combined with
`ck_gc_live_requires_active_amount` (live implies active), plus an
inside-transaction owner recount in `cutOver()` that refuses to commit on two
owners *or* zero.

`uq_gc_one_live_owner` also exists but is **provably unreachable** — a second
live row is blocked by `uq_gc_active_code` first. It is defence in depth, not
the enforcer. An earlier draft of this document credited it wrongly.

## Demo authority

```
Kameron Zitelli — Staff  (person c1dedf39, login 78375274 kz8434@gmail.com)
asset_manager on Demo Building ONLY
may_prepare · may_review · may_publish · may_manage_concession_authority
```

**1 of 28 properties** has any pricing authority. The invalid `owner`
assignment on a demo-lead person is deactivated with its history intact.

---

## Browser-proofed UI states

| State | Proof |
|---|---|
| **live** ($50) | chip *"LIVE — ONE GOVERNED SOURCE"*, before/after reads *"said before / says now"*, legacy labelled retired, **0 buttons**, *"Changing it means superseding it with a new decision"* |
| **draft** ($99) | chip *"DRAFT — NOT IN USE"*, open question + 3 rulings, **0 buttons**, blocked on the ruling not on authority |
| **unauthorized** | 0 buttons, amount still visible, plain-English denial naming the *account-setup* step |
| **unavailable** | no amount shown; states a read failure is not the absence of a fee |
| audit disclosure | collapsed in every state; **no internal codes** in operator copy |
| approved / published-not-live / cutover-ready / rejected | **code-proven only** — cannot be produced without another publication |

## The reusable decision-card contract

`psEconomicDecisionCard(elId, resourceName)` renders any server read of this
shape. **Adding a governed term needs a server read, not new UI.**

```
truth        state chip · question · amount · 3 facts
decision     open_question { question, why_it_matters, rulings[], preselected: null }
consequence  today {label, source, the_ai_says} → after_cutover {label, source, the_ai_will_say}
next action  actions { may_approve/modify/reject, denied_reason, labels }
collapsed    audit { ids, digests, record_state, quote_state, provenance, authority }
```

Rules: the **server** decides state and labels; the browser renders. No
internal code appears in operator copy. `may_approve` is false when the
blocker is a *question*, not authority.

---

## The unresolved administration-fee ruling

> **Is the $99 administration fee charged only for a new lease, or again when
> an existing resident renews?**

| Ruling | Consequence |
|---|---|
| New lease only | Renewal quotes exclude it. |
| New lease **and** renewal | Renewal economics carry another one-time $99. |
| Conditional | The renewal condition must be governed before it can be quoted at all. |

### Evidence audit — reported, not weighed

**Supporting renewal (2 independently authored prose sources):**
- `agent_facts.pricing_admin_fee` *(active)*: "A $99 admin fee applies per
  unit, once at move-in and at renewal."
- `agent_facts.fee_policy` *(retired)*: "a $99 admin fee per unit (at move-in
  and renewal)" — written separately, same claim.

**Corroborating pattern (about a different fee):** `pricing_amenity_fee` —
"$300 ($250 upon renewal)". Shows the property charges *some* fees at renewal.
Says nothing about this one.

**Contradicting renewal:** none.

**Transactional evidence: NONE — and this is not evidence against.** Only 2
scheduled charges of *any* kind exist on the property, so nothing has been
posted for any fee. Zero ledger entries mention admin. No lease-document table
carries fee terms.

**Conclusion:** the prose is consistent but ambiguous — *"once at move-in and
at renewal"* reads either as one charge covering both events or one at each.
**This needs a human ruling, not a reading.**

---

## Remaining product primitives

| Primitive | State |
|---|---|
| Recurring-charge model | **not built** — blocks parking, pet rent, wifi, insurance |
| Approved projection assumptions | **not built** — blocks all Future Rent Roll revenue |
| Deposit-held ↔ deposit-required separation | contract only; underwriting owner unnamed |
| Market evidence / Rent Survey | interface contract only, no store |
| Six-section economic inventory surface | **not built** (decision cards deliberately prioritised) |
| Separate reviewer permission | not built — `asset_manager` approves *and* publishes |
| Concession activation UI | not built; compiler complete, nothing activated |
| Eight version-one rents | **undecided** — no pricing version can publish |
| 11 blocked money facts | each with a named missing determinant |

## Confirmed unchanged

No other economic value published or activated · no concession · no offer or
lease economic line · no projection · no other property received authority ·
no person merged or deleted · no `agent_facts` retired beyond the one ·
`units.market_rent` never an authority · retired client pricing store never
restored.

---

## Operational notes for the next thread

- **Migration numbers collide across contributors.** Two `106` files broke
  every API deploy until renumbered. Check `ls migrations/` before adding one.
- The migration ledger keys on **version**; the runner correctly refuses a
  different file reusing a recorded version.
- `POST /operator/session` body field is **`proof`**, not `token`.
- In the browser use `window.__psLive.beginOperatorSession(<invite>)`; setting
  `sessionStorage` directly does **not** sign you in.
- App repo local branch is `r1/renewals-live-read`; push with
  `git push origin HEAD:main`.
- `DATABASE_URL` in `api/.env` is dead; pull it from Render env per session.
- Harnesses: `governed_economics_proof`, `demo_authority_ruling_proof`,
  `authority_resolution_proof`, `identity_authority_proof`,
  `pricing_governance_proof`, `pricing_foundation_proof`,
  `pricing_decision_packet_proof` — **584 assertions**, run separately.

## Key documents

`PRICING_GOVERNANCE.md` · `IDENTITY_AND_AUTHORITY.md` ·
`GOVERNED_ECONOMIC_TERMS.md` · `ECONOMIC_CONVERGENCE.md` ·
`ECONOMIC_DECISION_ROOM.md` · `AUTHORITY_RULING_EXECUTION.md`

---

## Audit corrections (2026-07-28)

An independent verification pass re-proved the deployed state from scratch,
assuming this document was wrong. It was, in three places.

1. **The one-live-owner enforcer was misattributed.** `uq_gc_one_live_owner`
   cannot fire: `ck_gc_live_requires_active_amount` forces live ⇒ active, and
   `uq_gc_active_code` already forbids two active rows per code. The probe
   confirmed the duplicate is rejected by `uq_gc_active_code`. The invariant
   holds and is enforced — the mechanism named was wrong. Corrected above.
2. **The commit reference was stale by one.** It named the commit before the
   handoff commit itself. Now `eaa1bd9`, which is what Render serves.
3. **A harness assertion had been weakened.** `contradictions.length === 11`
   was relaxed to `11 || 10` during the cutover so it would keep passing. An
   assertion that accepts two answers is not an assertion. It is now pinned to
   the exact eleven fact keys **by name** — strictly stronger than the
   original count. The real value never moved.

### Code-proven, not data-proven

- **Cross-property composite FK** on `property_governed_charges` is
  structurally present but **cannot be violated in a test today** — only Demo
  Building has governed unit types, so there is no foreign type to reference.
- **`move_in_requirements` still mentions "application fee"** in prose (no
  amount) and is still live. It is not a competing *value*, so the
  one-quotable-owner invariant holds for the $50 — but the phrase survives and
  is known cleanup.
- **UI states approved / published-not-live / cutover-ready / rejected** cannot
  be produced without another publication. Code-proven only.
- **The live assistant was not asked live questions.** Doing so sends real SMS.
  What it *would* resolve was proven by reading its exact fact-resolution query
  against the live database instead.
